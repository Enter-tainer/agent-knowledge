use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use chrono::{DateTime, NaiveDate};
use parking_lot_or_std::{Mutex, RwLock};
use tokio::runtime::Handle;
use tracing::{debug, warn};

use crate::api::DocSummary;
use crate::auth::{now_epoch_ms, AuthManager};
use crate::cache::{CacheError, SwrCache};

mod parking_lot_or_std {
    pub use std::sync::{Mutex, RwLock};
}

pub const ROOT_INO: u64 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EntryKind {
    Directory,
    RegularFile,
}

#[derive(Debug, Clone)]
pub struct NodeAttr {
    pub ino: u64,
    pub kind: EntryKind,
    pub size: u64,
    pub mtime: SystemTime,
    pub perm: u16,
    pub nlink: u32,
}

#[derive(Debug, Clone)]
pub struct DirEntryItem {
    pub ino: u64,
    pub offset: i64,
    pub kind: EntryKind,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum NodeKey {
    Dir(String),
    File(String),
}

#[derive(Debug, Clone)]
enum NodeData {
    Dir {
        parent_ino: u64,
        children: Vec<(String, u64)>,
        child_lookup: HashMap<String, u64>,
        mtime: SystemTime,
        nlink: u32,
    },
    File {
        doc_path: String,
        tree_size: u64,
        updated: String,
        mtime: SystemTime,
    },
}

#[derive(Debug, Clone)]
struct Node {
    ino: u64,
    data: NodeData,
}

struct TreeState {
    next_ino: u64,
    key_to_ino: HashMap<NodeKey, u64>,
    nodes: HashMap<u64, Node>,
    doc_count: usize,
}

impl TreeState {
    fn new_empty() -> Self {
        let mut nodes = HashMap::new();
        nodes.insert(
            ROOT_INO,
            Node {
                ino: ROOT_INO,
                data: NodeData::Dir {
                    parent_ino: ROOT_INO,
                    children: Vec::new(),
                    child_lookup: HashMap::new(),
                    mtime: SystemTime::now(),
                    nlink: 2,
                },
            },
        );
        let mut key_to_ino = HashMap::new();
        key_to_ino.insert(NodeKey::Dir(String::new()), ROOT_INO);
        Self {
            next_ino: ROOT_INO + 1,
            key_to_ino,
            nodes,
            doc_count: 0,
        }
    }

    fn alloc_ino(&mut self, key: NodeKey) -> u64 {
        if let Some(&ino) = self.key_to_ino.get(&key) {
            return ino;
        }
        let ino = self.next_ino;
        self.next_ino += 1;
        self.key_to_ino.insert(key, ino);
        ino
    }

    fn rebuild(&mut self, docs: &[DocSummary], tree_mtime: SystemTime) {
        let mut dir_children: HashMap<String, BTreeMap<String, u64>> = HashMap::new();
        let mut dir_parents: HashMap<String, String> = HashMap::new();
        let mut dir_sub_dirs: HashMap<String, usize> = HashMap::new();
        let mut new_nodes: HashMap<u64, Node> = HashMap::new();
        let mut active_keys: HashMap<NodeKey, u64> = HashMap::new();

        let root_key = NodeKey::Dir(String::new());
        active_keys.insert(root_key, ROOT_INO);
        dir_children.insert(String::new(), BTreeMap::new());
        dir_parents.insert(String::new(), String::new());

        for doc in docs {
            let parts: Vec<&str> = doc.path.split('/').filter(|s| !s.is_empty()).collect();
            if parts.is_empty() {
                continue;
            }
            let mut cur_dir = String::new();
            for dir_seg in &parts[..parts.len() - 1] {
                let next_dir = if cur_dir.is_empty() {
                    (*dir_seg).to_string()
                } else {
                    format!("{cur_dir}/{dir_seg}")
                };
                let dir_key = NodeKey::Dir(next_dir.clone());
                let dir_ino = self.alloc_ino(dir_key.clone());
                active_keys.insert(dir_key, dir_ino);

                let inserted = dir_children
                    .entry(cur_dir.clone())
                    .or_default()
                    .insert((*dir_seg).to_string(), dir_ino)
                    .is_none();
                if inserted {
                    *dir_sub_dirs.entry(cur_dir.clone()).or_insert(0) += 1;
                }
                dir_children.entry(next_dir.clone()).or_default();
                dir_parents.entry(next_dir.clone()).or_insert_with(|| cur_dir.clone());
                cur_dir = next_dir;
            }

            let file_seg = parts[parts.len() - 1];
            let file_name = format!("{file_seg}.md");
            let vfs_file_path = if cur_dir.is_empty() {
                file_name.clone()
            } else {
                format!("{cur_dir}/{file_name}")
            };
            let file_key = NodeKey::File(vfs_file_path);
            let file_ino = self.alloc_ino(file_key.clone());
            active_keys.insert(file_key, file_ino);

            dir_children
                .entry(cur_dir)
                .or_default()
                .insert(file_name, file_ino);

            new_nodes.insert(
                file_ino,
                Node {
                    ino: file_ino,
                    data: NodeData::File {
                        doc_path: doc.path.clone(),
                        tree_size: doc.size,
                        updated: doc.updated.clone(),
                        mtime: parse_updated_time(&doc.updated, tree_mtime),
                    },
                },
            );
        }

        for (dir_path, children_map) in dir_children {
            let dir_ino = *active_keys
                .get(&NodeKey::Dir(dir_path.clone()))
                .unwrap_or(&ROOT_INO);
            let parent_path = dir_parents.get(&dir_path).cloned().unwrap_or_default();
            let parent_ino = *active_keys
                .get(&NodeKey::Dir(parent_path))
                .unwrap_or(&ROOT_INO);

            let children: Vec<(String, u64)> = children_map.into_iter().collect();
            let child_lookup: HashMap<String, u64> = children.iter().cloned().collect();
            let sub_count = dir_sub_dirs.get(&dir_path).copied().unwrap_or(0) as u32;

            new_nodes.insert(
                dir_ino,
                Node {
                    ino: dir_ino,
                    data: NodeData::Dir {
                        parent_ino,
                        children,
                        child_lookup,
                        mtime: tree_mtime,
                        nlink: 2 + sub_count,
                    },
                },
            );
        }

        self.nodes = new_nodes;
        self.key_to_ino = active_keys;
        self.doc_count = docs.len();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VfsError {
    NotFound,
    NotDir,
    IsDir,
    ReadOnly,
    BadFd,
    NeedsLogin,
    Io,
}

pub struct VfsCore {
    cache: Arc<SwrCache>,
    auth: Arc<AuthManager>,
    rt: Handle,
    tree_ttl_ms: i64,
    tree_fetched_at_ms: AtomicI64,
    tree: RwLock<TreeState>,
    next_fh: AtomicU64,
    open_handles: RwLock<HashMap<u64, Arc<Vec<u8>>>>,
    bg_tree_refresh_running: Mutex<bool>,
}

impl VfsCore {
    pub fn new(cache: Arc<SwrCache>, auth: Arc<AuthManager>, rt: Handle, tree_ttl: Duration) -> Self {
        Self {
            cache,
            auth,
            rt,
            tree_ttl_ms: tree_ttl.as_millis() as i64,
            tree_fetched_at_ms: AtomicI64::new(0),
            tree: RwLock::new(TreeState::new_empty()),
            next_fh: AtomicU64::new(1),
            open_handles: RwLock::new(HashMap::new()),
            bg_tree_refresh_running: Mutex::new(false),
        }
    }

    /// Initializes the VFS tree from disk cache if present, or performs one initial remote
    /// fetch if cold. Never fails fatally on `NeedsLogin` or transient network failures.
    pub async fn init_tree(self: &Arc<Self>) {
        if let Some(cached) = self.cache.load_cached_tree() {
            let mtime = epoch_ms_to_system_time(cached.fetched_at_ms);
            self.apply_tree(&cached.docs, cached.fetched_at_ms, mtime);
            debug!("loaded {} documents from disk tree cache", cached.docs.len());
            if self.cache.is_tree_stale(&cached) && !self.auth.is_needs_login() {
                self.spawn_tree_refresh_bg();
            }
            return;
        }

        // Cold start: try one blocking fetch (if offline/NeedsLogin, stays mounted empty and retries later).
        if let Some(docs) = self.cache.refresh_tree_and_health().await {
            self.apply_tree(&docs, now_epoch_ms(), SystemTime::now());
        } else {
            warn!("starting with empty tree cache (will populate once network/auth recovers)");
        }
    }

    pub fn apply_tree(&self, docs: &[DocSummary], fetched_at_ms: i64, mtime: SystemTime) {
        let mut tree = self.tree.write().expect("tree rwlock poisoned");
        tree.rebuild(docs, mtime);
        self.tree_fetched_at_ms.store(fetched_at_ms, Ordering::Release);
    }

    pub fn doc_count(&self) -> usize {
        self.tree.read().expect("tree rwlock poisoned").doc_count
    }

    pub fn spawn_tree_refresh_bg(self: &Arc<Self>) {
        if self.auth.is_needs_login() {
            return;
        }
        {
            let mut running = self.bg_tree_refresh_running.lock().expect("mutex poisoned");
            if *running {
                return;
            }
            *running = true;
        }
        let this = self.clone();
        self.rt.spawn(async move {
            if let Some(docs) = this.cache.refresh_tree_and_health().await {
                this.apply_tree(&docs, now_epoch_ms(), SystemTime::now());
            }
            let mut running = this.bg_tree_refresh_running.lock().expect("mutex poisoned");
            *running = false;
        });
    }

    fn maybe_refresh_tree_bg(self: &Arc<Self>) {
        let fetched_at = self.tree_fetched_at_ms.load(Ordering::Acquire);
        if now_epoch_ms().saturating_sub(fetched_at) >= self.tree_ttl_ms {
            self.spawn_tree_refresh_bg();
        }
    }

    pub fn lookup(self: &Arc<Self>, parent: u64, name: &str) -> Result<NodeAttr, VfsError> {
        self.maybe_refresh_tree_bg();
        let tree = self.tree.read().expect("tree rwlock poisoned");
        let parent_node = tree.nodes.get(&parent).ok_or(VfsError::NotFound)?;
        let child_ino = match &parent_node.data {
            NodeData::Dir { child_lookup, .. } => {
                *child_lookup.get(name).ok_or(VfsError::NotFound)?
            }
            NodeData::File { .. } => return Err(VfsError::NotDir),
        };
        let child = tree.nodes.get(&child_ino).ok_or(VfsError::NotFound)?;
        Ok(self.node_to_attr(child))
    }

    pub fn getattr(&self, ino: u64) -> Result<NodeAttr, VfsError> {
        let tree = self.tree.read().expect("tree rwlock poisoned");
        let node = tree.nodes.get(&ino).ok_or(VfsError::NotFound)?;
        Ok(self.node_to_attr(node))
    }

    pub fn readdir(self: &Arc<Self>, ino: u64, offset: i64) -> Result<Vec<DirEntryItem>, VfsError> {
        self.maybe_refresh_tree_bg();
        let tree = self.tree.read().expect("tree rwlock poisoned");
        let node = tree.nodes.get(&ino).ok_or(VfsError::NotFound)?;
        let (parent_ino, children) = match &node.data {
            NodeData::Dir {
                parent_ino,
                children,
                ..
            } => (*parent_ino, children),
            NodeData::File { .. } => return Err(VfsError::NotDir),
        };

        let mut out = Vec::new();
        let start = offset.max(0) as usize;

        if start == 0 {
            out.push(DirEntryItem {
                ino,
                offset: 1,
                kind: EntryKind::Directory,
                name: ".".to_string(),
            });
        }
        if start <= 1 {
            out.push(DirEntryItem {
                ino: parent_ino,
                offset: 2,
                kind: EntryKind::Directory,
                name: "..".to_string(),
            });
        }

        for (idx, (name, child_ino)) in children.iter().enumerate() {
            let entry_idx = idx + 2;
            if entry_idx < start {
                continue;
            }
            if let Some(child) = tree.nodes.get(child_ino) {
                let kind = match child.data {
                    NodeData::Dir { .. } => EntryKind::Directory,
                    NodeData::File { .. } => EntryKind::RegularFile,
                };
                out.push(DirEntryItem {
                    ino: *child_ino,
                    offset: (entry_idx + 1) as i64,
                    kind,
                    name: name.clone(),
                });
            }
        }
        Ok(out)
    }

    pub fn open(&self, ino: u64, is_write: bool) -> Result<u64, VfsError> {
        if is_write {
            return Err(VfsError::ReadOnly);
        }
        let (doc_path, updated, tree_size) = {
            let tree = self.tree.read().expect("tree rwlock poisoned");
            let node = tree.nodes.get(&ino).ok_or(VfsError::NotFound)?;
            match &node.data {
                NodeData::File {
                    doc_path,
                    updated,
                    tree_size,
                    ..
                } => (doc_path.clone(), updated.clone(), *tree_size),
                NodeData::Dir { .. } => return Err(VfsError::IsDir),
            }
        };

        let data = self
            .rt
            .block_on(self.cache.get_doc_swr(&doc_path, Some((&updated, tree_size))))
            .map_err(|err| match err {
                CacheError::NeedsLogin(_) => VfsError::NeedsLogin,
                CacheError::NotFound(_) => VfsError::NotFound,
                CacheError::Unavailable(_) => VfsError::Io,
            })?;

        let fh = self.next_fh.fetch_add(1, Ordering::Relaxed);
        let mut handles = self.open_handles.write().expect("handles rwlock poisoned");
        handles.insert(fh, data.body);
        Ok(fh)
    }

    pub fn read(&self, fh: u64, offset: i64, size: u32) -> Result<Vec<u8>, VfsError> {
        if offset < 0 {
            return Err(VfsError::Io);
        }
        let body = {
            let handles = self.open_handles.read().expect("handles rwlock poisoned");
            handles.get(&fh).cloned().ok_or(VfsError::BadFd)?
        };
        let off = offset as usize;
        if off >= body.len() {
            return Ok(Vec::new());
        }
        let end = off.saturating_add(size as usize).min(body.len());
        Ok(body[off..end].to_vec())
    }

    pub fn release(&self, fh: u64) {
        let mut handles = self.open_handles.write().expect("handles rwlock poisoned");
        handles.remove(&fh);
    }

    fn node_to_attr(&self, node: &Node) -> NodeAttr {
        match &node.data {
            NodeData::Dir { mtime, nlink, .. } => NodeAttr {
                ino: node.ino,
                kind: EntryKind::Directory,
                size: 4096,
                mtime: *mtime,
                perm: 0o555,
                nlink: *nlink,
            },
            NodeData::File {
                doc_path,
                tree_size,
                mtime,
                ..
            } => {
                // Keep getattr size exact when cached locally so read() matches stat().st_size.
                let size = self.cache.cached_doc_size(doc_path).unwrap_or(*tree_size);
                NodeAttr {
                    ino: node.ino,
                    kind: EntryKind::RegularFile,
                    size,
                    mtime: *mtime,
                    perm: 0o444,
                    nlink: 1,
                }
            }
        }
    }
}

fn parse_updated_time(s: &str, fallback: SystemTime) -> SystemTime {
    if let Ok(dt) = DateTime::parse_from_rfc3339(s.trim()) {
        return dt.into();
    }
    if let Ok(d) = NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d") {
        if let Some(dt) = d.and_hms_opt(0, 0, 0) {
            return DateTime::<chrono::Utc>::from_naive_utc_and_offset(dt, chrono::Utc).into();
        }
    }
    fallback
}

fn epoch_ms_to_system_time(ms: i64) -> SystemTime {
    if ms <= 0 {
        return UNIX_EPOCH;
    }
    UNIX_EPOCH + Duration::from_millis(ms as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::KbApiClient;
    use crate::config::Config;
    use crate::http_util::build_http_client;
    use std::fs;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn handles_same_name_doc_and_dir_and_preserves_inodes() {
        let dir = std::env::temp_dir().join(format!("kb-fuse-vfs-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);

        let config = Config::from_env_and_overrides(
            Some("http://127.0.0.1:1".to_string()),
            Some(dir.join("mnt")),
            Some(dir.join("cache")),
            Some(dir.join("oauth.json")),
        )
        .unwrap();
        let client = build_http_client(&config).unwrap();
        let auth = Arc::new(AuthManager::new(config.clone(), client.clone()));
        let api = Arc::new(KbApiClient::new(config.clone(), client, auth.clone()));
        let cache = Arc::new(SwrCache::new(config.clone(), api, auth.clone()).unwrap());
        cache
            .store_doc_to_disk("foo", "# Root Foo", "\"h1\"", "2026-11-16T00:00:00Z")
            .unwrap();
        cache
            .store_doc_to_disk("foo/bar", "# Bar", "\"h2\"", "2026-11-16T00:00:00Z")
            .unwrap();

        let vfs = Arc::new(VfsCore::new(
            cache,
            auth,
            tokio::runtime::Handle::current(),
            Duration::from_secs(300),
        ));

        let docs = vec![
            DocSummary {
                path: "foo".to_string(),
                title: "Foo".to_string(),
                tags: vec![],
                size: 10,
                updated: "2026-11-16T00:00:00Z".to_string(),
            },
            DocSummary {
                path: "foo/bar".to_string(),
                title: "Bar".to_string(),
                tags: vec![],
                size: 5,
                updated: "2026-11-16T00:00:00Z".to_string(),
            },
        ];
        vfs.apply_tree(&docs, now_epoch_ms(), SystemTime::now());

        let foo_dir = vfs.lookup(ROOT_INO, "foo").unwrap();
        assert_eq!(foo_dir.kind, EntryKind::Directory);
        let foo_md = vfs.lookup(ROOT_INO, "foo.md").unwrap();
        assert_eq!(foo_md.kind, EntryKind::RegularFile);
        assert_eq!(foo_md.size, 10);

        let bar_md = vfs.lookup(foo_dir.ino, "bar.md").unwrap();
        assert_eq!(bar_md.kind, EntryKind::RegularFile);

        let entries = vfs.readdir(ROOT_INO, 0).unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec![".", "..", "foo", "foo.md"]);

        // Rebuilding tree preserves inode numbers for existing entries
        vfs.apply_tree(&docs, now_epoch_ms(), SystemTime::now());
        assert_eq!(vfs.lookup(ROOT_INO, "foo").unwrap().ino, foo_dir.ino);
        assert_eq!(vfs.lookup(ROOT_INO, "foo.md").unwrap().ino, foo_md.ino);

        // Open + read works via block_in_place inside async test
        let fh = tokio::task::block_in_place(|| vfs.open(foo_md.ino, false)).unwrap();
        let bytes = vfs.read(fh, 0, 100).unwrap();
        assert_eq!(String::from_utf8_lossy(&bytes), "# Root Foo");
        vfs.release(fh);

        // Write open is rejected with ReadOnly
        assert_eq!(
            tokio::task::block_in_place(|| vfs.open(foo_md.ino, true)),
            Err(VfsError::ReadOnly)
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
