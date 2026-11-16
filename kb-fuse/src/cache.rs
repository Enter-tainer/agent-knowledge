use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, Notify, Semaphore};
use tracing::{debug, info, warn};

use crate::api::{ApiError, DocFetch, DocSummary, KbApiClient};
use crate::auth::{now_epoch_ms, AuthManager};
use crate::config::Config;
use crate::fsutil::{ensure_dir, write_atomic};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedTree {
    pub fetched_at_ms: i64,
    pub docs: Vec<DocSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedDocMeta {
    pub path: String,
    pub etag: String,
    pub fetched_at_ms: i64,
    #[serde(default)]
    pub doc_updated: String,
    #[serde(default)]
    pub size: u64,
}

#[derive(Debug, Clone)]
pub struct CachedDocData {
    pub body: Arc<Vec<u8>>,
    pub meta: CachedDocMeta,
}

#[derive(Debug, thiserror::Error)]
pub enum CacheError {
    #[error("NeedsLogin: {0}")]
    NeedsLogin(String),
    #[error("document not found: {0}")]
    NotFound(String),
    #[error("fetch failed without cached copy: {0}")]
    Unavailable(String),
}

pub struct SwrCache {
    config: Config,
    api: Arc<KbApiClient>,
    auth: Arc<AuthManager>,
    docs_dir: PathBuf,
    tree_file: PathBuf,
    fetch_sem: Arc<Semaphore>,
    tree_lock: Mutex<()>,
    reval_in_flight: Arc<Mutex<HashSet<String>>>,
    cold_in_flight: Mutex<HashMap<String, Arc<Notify>>>,
}

impl SwrCache {
    pub fn new(config: Config, api: Arc<KbApiClient>, auth: Arc<AuthManager>) -> anyhow::Result<Self> {
        let docs_dir = config.cache_dir.join("docs");
        ensure_dir(&config.cache_dir, true)?;
        ensure_dir(&docs_dir, true)?;
        let tree_file = config.cache_dir.join("tree.json");
        let fetch_sem = Arc::new(Semaphore::new(config.max_concurrent_fetch));

        Ok(Self {
            config,
            api,
            auth,
            docs_dir,
            tree_file,
            fetch_sem,
            tree_lock: Mutex::new(()),
            reval_in_flight: Arc::new(Mutex::new(HashSet::new())),
            cold_in_flight: Mutex::new(HashMap::new()),
        })
    }

    pub fn load_cached_tree(&self) -> Option<CachedTree> {
        let bytes = fs::read(&self.tree_file).ok()?;
        serde_json::from_slice::<CachedTree>(&bytes).ok()
    }

    pub fn is_tree_stale(&self, cached: &CachedTree) -> bool {
        let ttl_ms = self.config.tree_ttl.as_millis() as i64;
        now_epoch_ms().saturating_sub(cached.fetched_at_ms) >= ttl_ms
    }

    pub fn cached_doc_size(&self, doc_path: &str) -> Option<u64> {
        let (body_path, meta_path) = self.doc_cache_paths(doc_path);
        if !meta_path.exists() {
            return None;
        }
        fs::metadata(body_path).ok().map(|m| m.len())
    }

    pub fn load_cached_doc(&self, doc_path: &str) -> Option<CachedDocData> {
        let (body_path, meta_path) = self.doc_cache_paths(doc_path);
        let meta_bytes = fs::read(&meta_path).ok()?;
        let meta: CachedDocMeta = serde_json::from_slice(&meta_bytes).ok()?;
        let body = fs::read(&body_path).ok()?;
        Some(CachedDocData {
            body: Arc::new(body),
            meta,
        })
    }

    /// Reads a document using SWR semantics:
    /// - If cached on disk (even if expired): returns immediately and schedules async
    ///   `If-None-Match` revalidation if stale.
    /// - If cold (no local copy): blocks once on remote fetch, caches to disk, returns content.
    pub async fn get_doc_swr(
        self: &Arc<Self>,
        doc_path: &str,
        tree_hint: Option<(&str, u64)>,
    ) -> Result<CachedDocData, CacheError> {
        if let Some(cached) = self.load_cached_doc(doc_path) {
            let ttl_ms = self.config.doc_ttl.as_millis() as i64;
            let expired = now_epoch_ms().saturating_sub(cached.meta.fetched_at_ms) >= ttl_ms;
            let tree_changed = tree_hint
                .map(|(upd, sz)| upd != cached.meta.doc_updated || sz != cached.meta.size)
                .unwrap_or(false);

            if (expired || tree_changed) && !self.auth.is_needs_login() {
                self.spawn_revalidate_doc(doc_path.to_string(), cached.meta.clone());
            }
            return Ok(cached);
        }

        // Cold cache: single-flight fetch per doc_path.
        let notify = {
            let mut map = self.cold_in_flight.lock().await;
            if let Some(existing) = map.get(doc_path) {
                Some(existing.clone())
            } else {
                map.insert(doc_path.to_string(), Arc::new(Notify::new()));
                None
            }
        };

        if let Some(waiter) = notify {
            waiter.notified().await;
            if let Some(cached) = self.load_cached_doc(doc_path) {
                return Ok(cached);
            }
            return Err(CacheError::Unavailable(format!(
                "concurrent cold fetch for {doc_path} failed"
            )));
        }

        let res = self.fetch_and_store_cold(doc_path).await;
        let waiter = {
            let mut map = self.cold_in_flight.lock().await;
            map.remove(doc_path)
        };
        if let Some(w) = waiter {
            w.notify_waiters();
        }
        res
    }

    async fn fetch_and_store_cold(&self, doc_path: &str) -> Result<CachedDocData, CacheError> {
        let _permit = self
            .fetch_sem
            .acquire()
            .await
            .map_err(|_| CacheError::Unavailable("semaphore closed".to_string()))?;

        match self.api.fetch_doc(doc_path, None).await {
            Ok(DocFetch::Modified { doc, etag }) => {
                if doc.stale {
                    warn!(
                        "document '{}' index is stale on server; consider POST /api/admin/reindex",
                        doc.path
                    );
                }
                let data = self
                    .store_doc_to_disk(doc_path, &doc.raw, &etag, &doc.updated)
                    .map_err(|e| CacheError::Unavailable(format!("write cache failed: {e}")))?;
                Ok(data)
            }
            Ok(DocFetch::NotModified { .. }) => Err(CacheError::Unavailable(
                "unexpected 304 on cold fetch without If-None-Match".to_string(),
            )),
            Err(ApiError::NeedsLogin(msg)) => Err(CacheError::NeedsLogin(msg)),
            Err(ApiError::NotFound(msg)) => Err(CacheError::NotFound(msg)),
            Err(ApiError::Transient(msg)) => {
                warn!("cold fetch failed for '{}': {}", doc_path, msg);
                Err(CacheError::Unavailable(msg))
            }
        }
    }

    fn spawn_revalidate_doc(self: &Arc<Self>, doc_path: String, meta: CachedDocMeta) {
        let this = self.clone();
        tokio::spawn(async move {
            {
                let mut set = this.reval_in_flight.lock().await;
                if !set.insert(doc_path.clone()) {
                    return;
                }
            }
            this.revalidate_doc_inner(&doc_path, meta).await;
            let mut set = this.reval_in_flight.lock().await;
            set.remove(&doc_path);
        });
    }

    async fn revalidate_doc_inner(&self, doc_path: &str, mut meta: CachedDocMeta) {
        if self.auth.is_needs_login() {
            return;
        }
        let Ok(_permit) = self.fetch_sem.acquire().await else {
            return;
        };
        if self.auth.is_needs_login() {
            return;
        }

        match self.api.fetch_doc(doc_path, Some(&meta.etag)).await {
            Ok(DocFetch::NotModified { etag }) => {
                meta.fetched_at_ms = now_epoch_ms();
                if let Some(new_etag) = etag {
                    meta.etag = new_etag;
                }
                let (_, meta_path) = self.doc_cache_paths(doc_path);
                if let Ok(json) = serde_json::to_vec_pretty(&meta) {
                    if let Err(err) = write_atomic(&meta_path, &json, true) {
                        warn!("failed updating cache meta after 304 for '{}': {}", doc_path, err);
                    } else {
                        debug!("SWR 304 refreshed mtime for '{}'", doc_path);
                    }
                }
            }
            Ok(DocFetch::Modified { doc, etag }) => {
                if doc.stale {
                    warn!(
                        "document '{}' index is stale on server; consider POST /api/admin/reindex",
                        doc.path
                    );
                }
                if let Err(err) = self.store_doc_to_disk(doc_path, &doc.raw, &etag, &doc.updated) {
                    warn!("failed storing refreshed doc '{}': {}", doc_path, err);
                } else {
                    debug!("SWR 200 updated content & ETag for '{}'", doc_path);
                }
            }
            Err(ApiError::NotFound(_)) => {
                debug!("SWR revalidation saw 404 for '{}'; removing cached entry", doc_path);
                self.remove_cached_doc(doc_path);
            }
            Err(ApiError::NeedsLogin(msg)) => {
                warn!("SWR revalidation paused ({})", msg);
            }
            Err(ApiError::Transient(msg)) => {
                warn!("SWR background revalidation failed for '{}': {}", doc_path, msg);
            }
        }
    }

    /// Refreshes `/api/tree` and checks `/api/health`.
    /// Never exits or panics on errors; warns and returns `None` if refresh failed.
    pub async fn refresh_tree_and_health(&self) -> Option<Vec<DocSummary>> {
        if self.auth.is_needs_login() {
            return None;
        }
        let _guard = self.tree_lock.lock().await;
        if self.auth.is_needs_login() {
            return None;
        }

        let docs = match self.api.fetch_tree().await {
            Ok(d) => d,
            Err(ApiError::NeedsLogin(msg)) => {
                warn!("tree refresh paused ({})", msg);
                return None;
            }
            Err(ApiError::Transient(msg)) | Err(ApiError::NotFound(msg)) => {
                warn!("tree refresh failed (serving cached tree): {}", msg);
                return None;
            }
        };

        let cached = CachedTree {
            fetched_at_ms: now_epoch_ms(),
            docs: docs.clone(),
        };
        if let Ok(json) = serde_json::to_vec_pretty(&cached) {
            if let Err(err) = write_atomic(&self.tree_file, &json, true) {
                warn!("failed writing tree cache {}: {err}", self.tree_file.display());
            }
        }

        // Check /api/health and warn if `stale != 0`.
        match self.api.fetch_health().await {
            Ok(health) => {
                if health.stale > 0 {
                    warn!(
                        "remote search index has stale={} document(s) (total={}); run `POST /api/admin/reindex` to repair",
                        health.stale, health.docs
                    );
                } else {
                    debug!("health ok: docs={} stale={}", health.docs, health.stale);
                }
            }
            Err(ApiError::NeedsLogin(_)) => {}
            Err(err) => {
                warn!("health check failed: {err}");
            }
        }

        info!("refreshed tree cache ({} documents)", docs.len());
        Some(docs)
    }

    pub fn store_doc_to_disk(
        &self,
        doc_path: &str,
        raw: &str,
        etag: &str,
        doc_updated: &str,
    ) -> anyhow::Result<CachedDocData> {
        let (body_path, meta_path) = self.doc_cache_paths(doc_path);
        let raw_bytes = raw.as_bytes();
        let meta = CachedDocMeta {
            path: doc_path.to_string(),
            etag: etag.to_string(),
            fetched_at_ms: now_epoch_ms(),
            doc_updated: doc_updated.to_string(),
            size: raw_bytes.len() as u64,
        };
        write_atomic(&body_path, raw_bytes, true)?;
        let meta_json = serde_json::to_vec_pretty(&meta)?;
        write_atomic(&meta_path, &meta_json, true)?;

        Ok(CachedDocData {
            body: Arc::new(raw_bytes.to_vec()),
            meta,
        })
    }

    pub fn remove_cached_doc(&self, doc_path: &str) {
        let (body_path, meta_path) = self.doc_cache_paths(doc_path);
        let _ = fs::remove_file(body_path);
        let _ = fs::remove_file(meta_path);
    }

    fn doc_cache_paths(&self, doc_path: &str) -> (PathBuf, PathBuf) {
        let mut hasher = Sha256::new();
        hasher.update(doc_path.as_bytes());
        let key = hex_lower(&hasher.finalize());
        (
            self.docs_dir.join(format!("{key}.md")),
            self.docs_dir.join(format!("{key}.meta.json")),
        )
    }
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http_util::build_http_client;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn swr_cold_fetch_then_304_then_200_update() {
        let dir = std::env::temp_dir().join(format!("kb-fuse-swr-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let step = Arc::new(AtomicUsize::new(0));
        let step_srv = step.clone();

        let server = tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                let cur = step_srv.fetch_add(1, Ordering::SeqCst);
                let mut buf = vec![0u8; 4096];
                let n = sock.read(&mut buf).await.unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();

                let resp = if cur == 0 {
                    // Cold fetch -> 200
                    let body = serde_json::json!({
                        "path": "notes/hello",
                        "title": "Hello",
                        "tags": [],
                        "size": 7,
                        "updated": "2026-11-16T00:00:00Z",
                        "hash": "h1",
                        "revision": 1,
                        "raw": "# Hello",
                        "stale": false
                    })
                    .to_string();
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nETag: \"h1\"\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    )
                } else if cur == 1 {
                    // Background revalidation must send If-None-Match: "h1" -> 304
                    assert!(
                        req.to_ascii_lowercase().contains("if-none-match: \"h1\""),
                        "expected If-None-Match header, got:\n{req}"
                    );
                    "HTTP/1.1 304 Not Modified\r\nETag: \"h1\"\r\nConnection: close\r\n\r\n".to_string()
                } else {
                    // Second revalidation -> 200 updated content
                    let body = serde_json::json!({
                        "path": "notes/hello",
                        "title": "Hello2",
                        "tags": [],
                        "size": 9,
                        "updated": "2026-11-16T01:00:00Z",
                        "hash": "h2",
                        "revision": 2,
                        "raw": "# Updated",
                        "stale": false
                    })
                    .to_string();
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nETag: \"h2\"\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    )
                };
                let _ = sock.write_all(resp.as_bytes()).await;
            }
        });

        let mut config = Config::from_env_and_overrides(
            Some(format!("http://{addr}")),
            Some(dir.join("mnt")),
            Some(dir.join("cache")),
            Some(dir.join("oauth.json")),
        )
        .unwrap();
        config.doc_ttl = std::time::Duration::from_secs(0); // immediately stale for SWR test

        let client = build_http_client(&config).unwrap();
        let auth = Arc::new(AuthManager::new(config.clone(), client.clone()));
        let api = Arc::new(KbApiClient::new(config.clone(), client, auth.clone()));
        let cache = Arc::new(SwrCache::new(config, api, auth).unwrap());

        // 1. Cold fetch blocks and returns v1
        let d1 = cache.get_doc_swr("notes/hello", None).await.unwrap();
        assert_eq!(String::from_utf8_lossy(&d1.body), "# Hello");
        assert_eq!(d1.meta.etag, "\"h1\"");

        // 2. Stale read returns v1 immediately and triggers 304 in background
        let d2 = cache.get_doc_swr("notes/hello", None).await.unwrap();
        assert_eq!(String::from_utf8_lossy(&d2.body), "# Hello");
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;

        // 3. Another stale read triggers 200 update in background (still immediately returns v1)
        let d3 = cache.get_doc_swr("notes/hello", None).await.unwrap();
        assert_eq!(String::from_utf8_lossy(&d3.body), "# Hello");
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;

        // 4. Next read sees updated v2
        let d4 = cache.get_doc_swr("notes/hello", None).await.unwrap();
        assert_eq!(String::from_utf8_lossy(&d4.body), "# Updated");
        assert_eq!(d4.meta.etag, "\"h2\"");

        server.abort();
        let _ = fs::remove_dir_all(&dir);
    }
}
