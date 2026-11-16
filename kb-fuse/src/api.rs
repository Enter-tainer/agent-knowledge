use std::sync::Arc;

use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use reqwest::{Client, Method, StatusCode};
use serde::{Deserialize, Serialize};
use tracing::warn;

use crate::auth::{AuthCredential, AuthError, AuthManager};
use crate::config::Config;
use crate::http_util::{is_retryable_status, retry_backoff};

/// Unreserved URL characters per RFC 3986 (`-`, `_`, `.`, `~`, ASCII alphanumerics).
const PATH_SEG_SET: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocSummary {
    pub path: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub updated: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocFull {
    pub path: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub updated: String,
    pub hash: String,
    #[serde(default)]
    pub revision: u64,
    pub raw: String,
    #[serde(default)]
    pub stale: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthStatus {
    pub ok: bool,
    pub docs: u64,
    pub tokenizer_version: u64,
    pub stale: u64,
}

#[derive(Debug)]
pub enum DocFetch {
    NotModified { etag: Option<String> },
    Modified { doc: DocFull, etag: String },
}

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("NeedsLogin: {0}")]
    NeedsLogin(String),
    #[error("document not found: {0}")]
    NotFound(String),
    #[error("network/server error: {0}")]
    Transient(String),
}

impl From<AuthError> for ApiError {
    fn from(value: AuthError) -> Self {
        match value {
            AuthError::NeedsLogin(msg) => ApiError::NeedsLogin(msg),
            AuthError::Transient(msg) => ApiError::Transient(msg),
        }
    }
}

pub struct KbApiClient {
    config: Config,
    client: Client,
    auth: Arc<AuthManager>,
}

impl KbApiClient {
    pub fn new(config: Config, client: Client, auth: Arc<AuthManager>) -> Self {
        Self { config, client, auth }
    }

    pub fn encode_doc_path(doc_path: &str) -> String {
        doc_path
            .split('/')
            .map(|seg| utf8_percent_encode(seg, PATH_SEG_SET).to_string())
            .collect::<Vec<_>>()
            .join("/")
    }

    pub async fn fetch_tree(&self) -> Result<Vec<DocSummary>, ApiError> {
        let url = format!("{}/api/tree?limit=2000", self.config.base_url);
        let resp = self.send_authed(Method::GET, &url, None).await?;
        let status = resp.status();
        let body = resp
            .text()
            .await
            .map_err(|e| ApiError::Transient(format!("read /api/tree body failed: {e}")))?;

        if !status.is_success() {
            return Err(ApiError::Transient(format!(
                "GET /api/tree returned HTTP {status}: {}",
                truncate(&body, 200)
            )));
        }

        let docs: Vec<DocSummary> = serde_json::from_str(&body)
            .map_err(|e| ApiError::Transient(format!("parse /api/tree JSON failed: {e}")))?;
        if docs.len() >= 2000 {
            warn!(
                "/api/tree returned {} documents (server limit 2000); listing may be truncated",
                docs.len()
            );
        }
        Ok(docs)
    }

    pub async fn fetch_health(&self) -> Result<HealthStatus, ApiError> {
        let url = format!("{}/api/health", self.config.base_url);
        let resp = self.send_authed(Method::GET, &url, None).await?;
        let status = resp.status();
        let body = resp
            .text()
            .await
            .map_err(|e| ApiError::Transient(format!("read /api/health body failed: {e}")))?;
        if !status.is_success() {
            return Err(ApiError::Transient(format!(
                "GET /api/health returned HTTP {status}: {}",
                truncate(&body, 200)
            )));
        }
        serde_json::from_str(&body)
            .map_err(|e| ApiError::Transient(format!("parse /api/health JSON failed: {e}")))
    }

    pub async fn fetch_doc(
        &self,
        doc_path: &str,
        if_none_match: Option<&str>,
    ) -> Result<DocFetch, ApiError> {
        let encoded = Self::encode_doc_path(doc_path);
        let url = format!("{}/api/docs/{encoded}", self.config.base_url);
        let resp = self.send_authed(Method::GET, &url, if_none_match).await?;
        let status = resp.status();
        let header_etag = resp
            .headers()
            .get("etag")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        if status == StatusCode::NOT_MODIFIED {
            return Ok(DocFetch::NotModified { etag: header_etag });
        }
        if status == StatusCode::NOT_FOUND {
            return Err(ApiError::NotFound(doc_path.to_string()));
        }

        let body = resp
            .text()
            .await
            .map_err(|e| ApiError::Transient(format!("read /api/docs body failed: {e}")))?;
        if !status.is_success() {
            return Err(ApiError::Transient(format!(
                "GET /api/docs/{doc_path} returned HTTP {status}: {}",
                truncate(&body, 200)
            )));
        }

        let doc: DocFull = serde_json::from_str(&body)
            .map_err(|e| ApiError::Transient(format!("parse /api/docs JSON failed: {e}")))?;
        let etag = header_etag.unwrap_or_else(|| format!("\"{}\"", doc.hash));
        Ok(DocFetch::Modified { doc, etag })
    }

    async fn send_authed(
        &self,
        method: Method,
        url: &str,
        if_none_match: Option<&str>,
    ) -> Result<reqwest::Response, ApiError> {
        let cred = self.auth.get_credential().await?;
        let mut token_opt = match cred {
            AuthCredential::None => None,
            AuthCredential::Bearer(t) => Some(t),
        };
        let mut refreshed_after_401 = false;

        let mut last_err = String::new();
        for attempt in 0..self.config.http_attempts {
            let mut req = self
                .client
                .request(method.clone(), url)
                .header("accept", "application/json");
            if let Some(ref tok) = token_opt {
                req = req.bearer_auth(tok);
            }
            if let Some(etag) = if_none_match {
                req = req.header("if-none-match", etag);
            }

            match req.send().await {
                Ok(resp) => {
                    let status = resp.status();
                    if status == StatusCode::UNAUTHORIZED {
                        if !refreshed_after_401 {
                            if let Some(used) = token_opt.take() {
                                refreshed_after_401 = true;
                                let fresh = self.auth.refresh_after_401(&used).await?;
                                token_opt = Some(fresh);
                                continue;
                            }
                        }
                        let msg = format!("HTTP 401 from {url} even after token refresh");
                        self.auth.mark_needs_login(&msg).await;
                        return Err(ApiError::NeedsLogin(msg));
                    }
                    if status.is_redirection() && status != StatusCode::NOT_MODIFIED {
                        let msg = format!(
                            "HTTP {status} redirect from {url} (Access login required or Managed OAuth disabled)"
                        );
                        self.auth.mark_needs_login(&msg).await;
                        return Err(ApiError::NeedsLogin(msg));
                    }
                    if is_retryable_status(status) && attempt + 1 < self.config.http_attempts {
                        last_err = format!("HTTP {status}");
                        tokio::time::sleep(retry_backoff(attempt)).await;
                        continue;
                    }
                    return Ok(resp);
                }
                Err(err) => {
                    last_err = err.to_string();
                }
            }
            if attempt + 1 < self.config.http_attempts {
                tokio::time::sleep(retry_backoff(attempt)).await;
            }
        }

        Err(ApiError::Transient(format!(
            "request {url} failed after {} attempts: {last_err}",
            self.config.http_attempts
        )))
    }
}

fn truncate(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_encodes_doc_segments_preserving_slashes() {
        assert_eq!(
            KbApiClient::encode_doc_path("folder/中文 笔记：测试"),
            "folder/%E4%B8%AD%E6%96%87%20%E7%AC%94%E8%AE%B0%EF%BC%9A%E6%B5%8B%E8%AF%95"
        );
        assert_eq!(KbApiClient::encode_doc_path("a-b_c.d~e"), "a-b_c.d~e");
    }
}
