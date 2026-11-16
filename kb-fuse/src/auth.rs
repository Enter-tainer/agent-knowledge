use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, Write};
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::Utc;
use rand::RngCore;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::sync::{Mutex, Notify};
use tracing::{error, info, warn};

use crate::config::{is_loopback_base, Config};
use crate::fsutil::write_atomic;
use crate::http_util::{is_retryable_status, retry_backoff};
use crate::systemd;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthStore {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub hosts: BTreeMap<String, HostTokenEntry>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

impl Default for OAuthStore {
    fn default() -> Self {
        Self {
            version: 1,
            hosts: BTreeMap::new(),
            extra: BTreeMap::new(),
        }
    }
}

fn default_version() -> u32 {
    1
}

fn default_token_type() -> String {
    "bearer".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostTokenEntry {
    pub base: String,
    pub client_id: String,
    pub redirect_uri: String,
    pub resource: String,
    pub authorization_server: String,
    pub token_endpoint: String,
    pub access_token: String,
    #[serde(default = "default_token_type")]
    pub token_type: String,
    pub expires_at: i64,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub updated_at: String,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct TokenEndpointResponse {
    access_token: String,
    #[serde(default)]
    token_type: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
    #[serde(default)]
    refresh_token: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("NeedsLogin: {0}")]
    NeedsLogin(String),
    #[error("transient auth error: {0}")]
    Transient(String),
}

pub enum AuthCredential {
    None,
    Bearer(String),
}

pub struct AuthManager {
    config: Config,
    client: Client,
    refresh_lock: Mutex<()>,
    needs_login: AtomicBool,
    last_observed_mtime: Mutex<Option<SystemTime>>,
    last_failed_refresh_token: Mutex<Option<String>>,
    login_recovered_notify: Notify,
}

impl AuthManager {
    pub fn new(config: Config, client: Client) -> Self {
        Self {
            config,
            client,
            refresh_lock: Mutex::new(()),
            needs_login: AtomicBool::new(false),
            last_observed_mtime: Mutex::new(None),
            last_failed_refresh_token: Mutex::new(None),
            login_recovered_notify: Notify::new(),
        }
    }

    pub fn is_needs_login(&self) -> bool {
        self.needs_login.load(Ordering::Acquire)
    }

    pub async fn mark_needs_login(&self, reason: &str) {
        self.enter_needs_login(reason, None).await;
    }

    pub fn requires_auth(&self) -> bool {
        !is_loopback_base(&self.config.base_url)
    }

    /// Returns a valid credential (refreshing silently when close to expiry),
    /// or enters `NeedsLogin` if refresh is permanently rejected or missing.
    pub async fn get_credential(&self) -> Result<AuthCredential, AuthError> {
        if !self.requires_auth() {
            return Ok(AuthCredential::None);
        }
        if self.is_needs_login() {
            // Re-check disk once in case user just completed `kb-fuse login`.
            if !self.check_for_external_login().await {
                return Err(AuthError::NeedsLogin(
                    "waiting for user login (run `kb-fuse login`)".to_string(),
                ));
            }
        }

        if let Some(entry) = self
            .read_host_entry_opt()
            .map_err(|e| AuthError::Transient(e.to_string()))?
        {
            let now_ms = now_epoch_ms();
            if !entry.access_token.is_empty() && entry.expires_at > now_ms + 60_000 {
                return Ok(AuthCredential::Bearer(entry.access_token));
            }
        }

        self.refresh_token_locked(None).await.map(AuthCredential::Bearer)
    }

    /// Called when an API request receives HTTP 401 with `used_token`.
    pub async fn refresh_after_401(&self, used_token: &str) -> Result<String, AuthError> {
        if !self.requires_auth() {
            return Err(AuthError::Transient("loopback server returned 401".to_string()));
        }
        self.refresh_token_locked(Some(used_token)).await
    }

    async fn refresh_token_locked(&self, rejected_token: Option<&str>) -> Result<String, AuthError> {
        let _guard = self.refresh_lock.lock().await;

        let mut store = self
            .load_store()
            .map_err(|e| AuthError::Transient(e.to_string()))?;
        let Some(entry) = store.hosts.get(&self.config.base_url).cloned() else {
            let reason = format!(
                "no OAuth entry for {} in {}",
                self.config.base_url,
                self.config.token_file.display()
            );
            self.enter_needs_login(&reason, None).await;
            return Err(AuthError::NeedsLogin(reason));
        };

        let now_ms = now_epoch_ms();
        let token_was_rejected = rejected_token
            .map(|t| t == entry.access_token)
            .unwrap_or(false);

        if !token_was_rejected && !entry.access_token.is_empty() && entry.expires_at > now_ms + 60_000
        {
            self.clear_needs_login().await;
            return Ok(entry.access_token);
        }

        let Some(refresh_token) = entry.refresh_token.clone().filter(|s| !s.is_empty()) else {
            let reason = "missing refresh_token in oauth.json".to_string();
            self.enter_needs_login(&reason, None).await;
            return Err(AuthError::NeedsLogin(reason));
        };

        // Avoid hammering token endpoint with a refresh_token we already know is dead.
        {
            let failed = self.last_failed_refresh_token.lock().await;
            if failed.as_deref() == Some(refresh_token.as_str()) {
                return Err(AuthError::NeedsLogin(
                    "refresh_token already rejected; awaiting new login".to_string(),
                ));
            }
        }

        info!("refreshing Cloudflare Access OAuth token for {}", self.config.base_url);

        match self.exchange_refresh_token(&entry, &refresh_token).await {
            Ok(tokens) => {
                let mut next = entry.clone();
                next.access_token = tokens.access_token;
                if let Some(tt) = tokens.token_type {
                    next.token_type = tt;
                }
                let expires_in = tokens.expires_in.unwrap_or(900).max(0);
                next.expires_at = now_epoch_ms() + (expires_in.saturating_sub(30)) * 1000;
                if let Some(new_rt) = tokens.refresh_token.filter(|s| !s.is_empty()) {
                    next.refresh_token = Some(new_rt);
                }
                next.updated_at = Utc::now().to_rfc3339();

                store.hosts.insert(self.config.base_url.clone(), next.clone());
                if let Err(err) = self.save_store(&store) {
                    warn!("failed to persist refreshed token to {}: {err}", self.config.token_file.display());
                } else {
                    self.record_token_mtime().await;
                }
                *self.last_failed_refresh_token.lock().await = None;
                self.clear_needs_login().await;
                Ok(next.access_token)
            }
            Err(AuthError::NeedsLogin(reason)) => {
                self.enter_needs_login(&reason, Some(refresh_token)).await;
                Err(AuthError::NeedsLogin(reason))
            }
            Err(AuthError::Transient(msg)) => Err(AuthError::Transient(msg)),
        }
    }

    async fn exchange_refresh_token(
        &self,
        entry: &HostTokenEntry,
        refresh_token: &str,
    ) -> Result<TokenEndpointResponse, AuthError> {
        let params = [
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", entry.client_id.as_str()),
            ("resource", entry.resource.as_str()),
        ];

        let mut last_err = String::new();
        for attempt in 0..self.config.http_attempts {
            let res = self
                .client
                .post(&entry.token_endpoint)
                .header("accept", "application/json")
                .form(&params)
                .send()
                .await;

            match res {
                Ok(resp) => {
                    let status = resp.status();
                    let body = resp.text().await.unwrap_or_default();
                    if status.is_success() {
                        return serde_json::from_str::<TokenEndpointResponse>(&body).map_err(|e| {
                            AuthError::Transient(format!("invalid token response JSON: {e}"))
                        });
                    }
                    // 400/401/403 from OAuth token endpoint means grant is expired/revoked/invalid.
                    if matches!(status.as_u16(), 400 | 401 | 403) {
                        let snippet: String = body.chars().take(200).collect();
                        return Err(AuthError::NeedsLogin(format!(
                            "refresh_token rejected (HTTP {status}): {snippet}"
                        )));
                    }
                    last_err = format!("HTTP {status}");
                    if !is_retryable_status(status) {
                        return Err(AuthError::Transient(last_err));
                    }
                }
                Err(err) => {
                    last_err = err.to_string();
                }
            }
            if attempt + 1 < self.config.http_attempts {
                tokio::time::sleep(retry_backoff(attempt)).await;
            }
        }
        Err(AuthError::Transient(format!(
            "token refresh network failure after {} attempts: {last_err}",
            self.config.http_attempts
        )))
    }

    async fn enter_needs_login(&self, reason: &str, failed_refresh: Option<String>) {
        if let Some(rt) = failed_refresh {
            *self.last_failed_refresh_token.lock().await = Some(rt);
        }
        let was_needs_login = self.needs_login.swap(true, Ordering::AcqRel);
        self.record_token_mtime().await;

        let marker = format!(
            "status=NeedsLogin\nbase={}\nreason={}\nsince={}\ntoken_file={}\naction=Run `kb-fuse login` (or `node scripts/agent-oauth.mjs login --no-open {}`)\n",
            self.config.base_url,
            reason.replace('\n', " "),
            Utc::now().to_rfc3339(),
            self.config.token_file.display(),
            self.config.base_url,
        );
        if let Err(err) = write_atomic(&self.config.needs_login_file, marker.as_bytes(), true) {
            warn!(
                "failed to write needs-login marker {}: {err}",
                self.config.needs_login_file.display()
            );
        }

        if !was_needs_login {
            error!(
                "NeedsLogin: {} — mount remains active serving cached view; background revalidation paused. Marker: {} — run `kb-fuse login` to re-authenticate.",
                reason,
                self.config.needs_login_file.display()
            );
            systemd::notify_status(&format!(
                "NeedsLogin: run `kb-fuse login` (marker: {})",
                self.config.needs_login_file.display()
            ));
            self.send_needs_login_webhook(reason).await;
        }
    }

    async fn clear_needs_login(&self) {
        let was_needs_login = self.needs_login.swap(false, Ordering::AcqRel);
        if self.config.needs_login_file.exists() {
            let _ = fs::remove_file(&self.config.needs_login_file);
        }
        if was_needs_login {
            info!("NeedsLogin cleared; resuming background revalidation");
            systemd::notify_status("Mounted (SWR active)");
            self.login_recovered_notify.notify_waiters();
        }
    }

    async fn send_needs_login_webhook(&self, reason: &str) {
        let Some(url) = &self.config.needs_login_webhook else {
            return;
        };
        let payload = serde_json::json!({
            "event": "NeedsLogin",
            "base": self.config.base_url,
            "reason": reason,
            "markerFile": self.config.needs_login_file.display().to_string(),
            "command": format!("kb-fuse login --base {}", self.config.base_url),
            "timestamp": Utc::now().to_rfc3339(),
        });
        if let Err(err) = self.client.post(url).json(&payload).send().await {
            warn!("failed to deliver NeedsLogin webhook: {err}");
        }
    }

    /// Checks whether `oauth.json` changed on disk (e.g. after `kb-fuse login`)
    /// and attempts recovery from `NeedsLogin`. Returns `true` if recovered.
    pub async fn check_for_external_login(&self) -> bool {
        let current_mtime = fs::metadata(&self.config.token_file)
            .and_then(|m| m.modified())
            .ok();
        let prev_mtime = *self.last_observed_mtime.lock().await;
        if current_mtime.is_none() || current_mtime == prev_mtime {
            return false;
        }
        *self.last_observed_mtime.lock().await = current_mtime;

        let Ok(Some(entry)) = self.read_host_entry_opt() else {
            return false;
        };

        let failed_rt = self.last_failed_refresh_token.lock().await.clone();
        let has_new_rt = entry
            .refresh_token
            .as_deref()
            .is_some_and(|rt| !rt.is_empty() && failed_rt.as_deref() != Some(rt));
        let has_valid_access =
            !entry.access_token.is_empty() && entry.expires_at > now_epoch_ms() + 15_000;

        if has_valid_access || has_new_rt {
            *self.last_failed_refresh_token.lock().await = None;
            self.clear_needs_login().await;
            return true;
        }
        false
    }

    pub async fn force_reload_check(&self) -> bool {
        *self.last_observed_mtime.lock().await = None;
        self.check_for_external_login().await
    }

    async fn record_token_mtime(&self) {
        let mtime = fs::metadata(&self.config.token_file)
            .and_then(|m| m.modified())
            .ok();
        *self.last_observed_mtime.lock().await = mtime;
    }

    pub fn load_store(&self) -> anyhow::Result<OAuthStore> {
        load_store_from(&self.config.token_file)
    }

    pub fn save_store(&self, store: &OAuthStore) -> anyhow::Result<()> {
        save_store_to(&self.config.token_file, store)
    }

    pub fn read_host_entry_opt(&self) -> anyhow::Result<Option<HostTokenEntry>> {
        let store = self.load_store()?;
        Ok(store.hosts.get(&self.config.base_url).cloned())
    }
}

pub fn load_store_from(path: &Path) -> anyhow::Result<OAuthStore> {
    if !path.exists() {
        return Ok(OAuthStore::default());
    }
    let text = fs::read_to_string(path)?;
    let store: OAuthStore = serde_json::from_str(&text)?;
    Ok(store)
}

pub fn save_store_to(path: &Path, store: &OAuthStore) -> anyhow::Result<()> {
    let mut json = serde_json::to_string_pretty(store)?;
    json.push('\n');
    write_atomic(path, json.as_bytes(), true)?;
    Ok(())
}

pub fn now_epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as i64
}

pub fn mask_token(token: &str) -> String {
    if token.is_empty() {
        return "(empty)".to_string();
    }
    let chars: Vec<char> = token.chars().collect();
    if chars.len() <= 16 {
        return "****".to_string();
    }
    let head: String = chars.iter().take(8).collect();
    let tail: String = chars.iter().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect();
    format!("{head}…{tail}")
}

/// Runs interactive OAuth login (`kb-fuse login`):
/// 1. By default delegates to `node scripts/agent-oauth.mjs login --no-open` when available,
///    while also reading pasted callback URLs from stdin and forwarding them to the local
///    callback server (ideal for headless SSH / remote browser sessions).
/// 2. Falls back to built-in native Rust RFC 9728 / 8414 / 7591 PKCE login if `node` or
///    `agent-oauth.mjs` is unavailable or `--native` is requested.
pub async fn run_login(
    config: &Config,
    client: &Client,
    open_browser: bool,
    port: u16,
    timeout_secs: u64,
    force_native: bool,
) -> anyhow::Result<()> {
    if is_loopback_base(&config.base_url) {
        println!("{} is a loopback URL and does not require login.", config.base_url);
        return Ok(());
    }

    if !force_native {
        if let Some(script) = &config.oauth_script {
            if has_node_binary().await {
                match run_login_via_node(config, script, open_browser, port, timeout_secs).await {
                    Ok(()) => {
                        let _ = fs::remove_file(&config.needs_login_file);
                        return Ok(());
                    }
                    Err(err) => {
                        return Err(err);
                    }
                }
            }
        }
    }

    run_login_native(config, client, port, timeout_secs).await?;
    let _ = fs::remove_file(&config.needs_login_file);
    Ok(())
}

async fn has_node_binary() -> bool {
    tokio::process::Command::new("node")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false)
}

async fn run_login_via_node(
    config: &Config,
    script: &Path,
    open_browser: bool,
    port: u16,
    timeout_secs: u64,
) -> anyhow::Result<()> {
    let mut cmd = tokio::process::Command::new("node");
    cmd.arg(script)
        .arg("login")
        .arg(&config.base_url)
        .arg("--token-file")
        .arg(&config.token_file)
        .arg("--port")
        .arg(port.to_string())
        .arg("--timeout")
        .arg(timeout_secs.to_string());
    if !open_browser {
        cmd.arg("--no-open");
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd.spawn()?;
    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    let active_port = std::sync::Arc::new(std::sync::atomic::AtomicU16::new(port));
    let active_port_stderr = active_port.clone();
    let active_port_stdin = active_port.clone();

    let out_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            println!("{line}");
            if line.starts_with("https://") || line.starts_with("http://") {
                eprintln!(
                    "\n完成浏览器登录后，若浏览器无法访问 localhost 回调，请把跳转后的完整 URL（http://localhost:.../callback?code=...&state=...）粘贴到此处并回车（或直接在本机 curl 该地址）："
                );
            }
        }
    });

    let err_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(p) = parse_redirect_port(&line) {
                active_port_stderr.store(p, Ordering::Relaxed);
            }
            eprintln!("{line}");
        }
    });

    let (done_tx, mut done_rx) = tokio::sync::oneshot::channel::<()>();
    let stdin_handle = std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut line = String::new();
        loop {
            if done_rx.try_recv().is_ok() {
                break;
            }
            line.clear();
            match stdin.lock().read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    if let Some(query) = extract_callback_query(&line) {
                        let p = active_port_stdin.load(Ordering::Relaxed);
                        if let Err(err) = forward_callback_to_local(p, &query) {
                            eprintln!("转发回调到 127.0.0.1:{p} 失败：{err}");
                        } else {
                            break;
                        }
                    } else if !line.trim().is_empty() {
                        eprintln!("未识别回调参数；请粘贴包含 ?code=...&state=... 的完整回调 URL。");
                    }
                }
                Err(_) => break,
            }
        }
    });

    let status = child.wait().await?;
    let _ = done_tx.send(());
    let _ = out_task.await;
    let _ = err_task.await;
    drop(stdin_handle);

    if !status.success() {
        anyhow::bail!("agent-oauth.mjs exited with status {status}");
    }
    Ok(())
}

fn forward_callback_to_local(port: u16, query: &str) -> anyhow::Result<()> {
    let mut stream = std::net::TcpStream::connect(("127.0.0.1", port))?;
    let req = format!(
        "GET /callback?{query} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(req.as_bytes())?;
    stream.flush()?;
    Ok(())
}

fn parse_redirect_port(line: &str) -> Option<u16> {
    let idx = line.find("http://localhost:")?;
    let rest = &line[idx + "http://localhost:".len()..];
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse::<u16>().ok()
}

pub fn extract_callback_query(input: &str) -> Option<String> {
    let trimmed = input.trim().trim_matches('"').trim_matches('\'');
    if trimmed.is_empty() {
        return None;
    }
    let query = if let Some((_, q)) = trimmed.split_once('?') {
        q
    } else if trimmed.contains("code=") || trimmed.contains("error=") {
        trimmed
    } else {
        return None;
    };
    let query = query.split('#').next().unwrap_or(query).trim();
    if query.contains("code=") || query.contains("error=") {
        Some(query.to_string())
    } else {
        None
    }
}

#[derive(Debug, Deserialize)]
struct ProtectedResourceMeta {
    #[serde(default)]
    resource: Option<String>,
    #[serde(default)]
    authorization_servers: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct AuthServerMeta {
    authorization_endpoint: String,
    token_endpoint: String,
    registration_endpoint: String,
}

#[derive(Debug, Deserialize)]
struct DcrResponse {
    client_id: String,
}

async fn run_login_native(
    config: &Config,
    client: &Client,
    preferred_port: u16,
    timeout_secs: u64,
) -> anyhow::Result<()> {
    eprintln!("→ 探测受保护资源（native OAuth）：{}", config.base_url);
    let probe_res = client
        .get(format!("{}/", config.base_url))
        .header("accept", "application/json")
        .send()
        .await?;

    let mut resource_meta_url = format!("{}/.well-known/cloudflare-access-protected-resource/", config.base_url);
    if probe_res.status() == reqwest::StatusCode::UNAUTHORIZED {
        if let Some(www) = probe_res.headers().get("www-authenticate").and_then(|v| v.to_str().ok()) {
            if let Some(extracted) = extract_quoted_param(www, "resource_metadata") {
                resource_meta_url = extracted;
            }
        }
    }

    let pr_meta: ProtectedResourceMeta = client
        .get(&resource_meta_url)
        .header("accept", "application/json")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    let auth_server = pr_meta
        .authorization_servers
        .first()
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("authorization_servers missing in {resource_meta_url}"))?;
    let resource = pr_meta.resource.unwrap_or_else(|| config.base_url.clone());

    let as_url = format!("{}/.well-known/oauth-authorization-server", auth_server.trim_end_matches('/'));
    let as_meta: AuthServerMeta = client
        .get(&as_url)
        .header("accept", "application/json")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    let (listener, port) = bind_free_port(preferred_port, 10).await?;
    let redirect_uri = format!("http://localhost:{port}/callback");

    let client_id = register_public_client(client, &as_meta.registration_endpoint, &redirect_uri, &resource).await?;
    let verifier = random_b64url(48);
    let mut challenge = b64url_sha256(&verifier);
    while !challenge.chars().next().is_some_and(|c| c.is_ascii_alphanumeric()) {
        challenge = b64url_sha256(&random_b64url(48));
    }
    let state = random_b64url(16);

    let mut auth_url = url::Url::parse(&as_meta.authorization_endpoint)?;
    auth_url
        .query_pairs_mut()
        .append_pair("client_id", &client_id)
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("resource", &resource)
        .append_pair("state", &state);

    eprintln!("\n→ 在浏览器里完成 Cloudflare Access 登录（邮箱验证码 / SSO）：");
    println!("{auth_url}");
    eprintln!(
        "\n完成浏览器登录后，若浏览器无法直接访问 localhost:{port}，请将跳转后的完整 URL（http://localhost:{port}/callback?code=...&state=...）粘贴到此处并回车："
    );

    let code = wait_for_code_http_or_stdin(listener, &state, Duration::from_secs(timeout_secs)).await?;

    let form = [
        ("grant_type", "authorization_code"),
        ("code", code.as_str()),
        ("client_id", client_id.as_str()),
        ("redirect_uri", redirect_uri.as_str()),
        ("code_verifier", verifier.as_str()),
        ("resource", resource.as_str()),
    ];
    let tokens: TokenEndpointResponse = client
        .post(&as_meta.token_endpoint)
        .header("accept", "application/json")
        .form(&form)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    let expires_in = tokens.expires_in.unwrap_or(900).max(0);
    let entry = HostTokenEntry {
        base: config.base_url.clone(),
        client_id,
        redirect_uri,
        resource,
        authorization_server: auth_server,
        token_endpoint: as_meta.token_endpoint,
        access_token: tokens.access_token,
        token_type: tokens.token_type.unwrap_or_else(default_token_type),
        expires_at: now_epoch_ms() + expires_in.saturating_sub(30) * 1000,
        refresh_token: tokens.refresh_token,
        updated_at: Utc::now().to_rfc3339(),
        extra: BTreeMap::new(),
    };

    let mut store = load_store_from(&config.token_file).unwrap_or_default();
    store.hosts.insert(config.base_url.clone(), entry.clone());
    save_store_to(&config.token_file, &store)?;

    println!("\n✓ 登录成功，token 已保存：{}", config.token_file.display());
    println!("  access_token: {}", mask_token(&entry.access_token));
    Ok(())
}

async fn register_public_client(
    client: &Client,
    registration_endpoint: &str,
    redirect_uri: &str,
    resource: &str,
) -> anyhow::Result<String> {
    let attempts = [
        serde_json::json!({
            "redirect_uris": [redirect_uri],
            "token_endpoint_auth_method": "none",
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "client_name": "agent-knowledge kb-fuse",
            "resource": resource,
        }),
        serde_json::json!({
            "redirect_uris": [redirect_uri],
            "token_endpoint_auth_method": "none",
            "grant_types": ["authorization_code"],
            "response_types": ["code"],
            "client_name": "agent-knowledge kb-fuse",
        }),
    ];

    let mut last_err = String::new();
    for body in attempts {
        let resp = client
            .post(registration_endpoint)
            .header("accept", "application/json")
            .json(&body)
            .send()
            .await?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if status.is_success() {
            if let Ok(reg) = serde_json::from_str::<DcrResponse>(&text) {
                if !reg.client_id.is_empty() {
                    return Ok(reg.client_id);
                }
            }
        }
        last_err = format!("HTTP {status}: {text}");
    }
    anyhow::bail!("dynamic client registration failed: {last_err}");
}

async fn bind_free_port(preferred: u16, tries: u16) -> anyhow::Result<(TcpListener, u16)> {
    for offset in 0..=tries {
        let p = preferred.saturating_add(offset);
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", p)).await {
            return Ok((listener, p));
        }
    }
    anyhow::bail!("could not bind local callback port starting at {preferred}");
}

async fn wait_for_code_http_or_stdin(
    listener: TcpListener,
    expected_state: &str,
    timeout: Duration,
) -> anyhow::Result<String> {
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Result<String, String>>(2);

    let tx_stdin = tx.clone();
    let expected_stdin = expected_state.to_string();
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut line = String::new();
        while let Ok(n) = stdin.lock().read_line(&mut line) {
            if n == 0 {
                break;
            }
            if let Some(q) = extract_callback_query(&line) {
                match parse_code_from_query(&q, &expected_stdin) {
                    Ok(code) => {
                        let _ = tx_stdin.blocking_send(Ok(code));
                        break;
                    }
                    Err(e) => {
                        let _ = tx_stdin.blocking_send(Err(e));
                        break;
                    }
                }
            }
            line.clear();
        }
    });

    let expected_http = expected_state.to_string();
    let http_task = tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            let mut buf = vec![0u8; 8192];
            let Ok(n) = socket.read(&mut buf).await else {
                continue;
            };
            let req = String::from_utf8_lossy(&buf[..n]);
            let first_line = req.lines().next().unwrap_or("");
            let target = first_line.split_whitespace().nth(1).unwrap_or("/");
            let Some(query) = target.strip_prefix("/callback?") else {
                let _ = socket
                    .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\n\r\nnot found")
                    .await;
                continue;
            };
            match parse_code_from_query(query, &expected_http) {
                Ok(code) => {
                    let body = "<h1>Login succeeded</h1><p>You can close this tab.</p>";
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = socket.write_all(resp.as_bytes()).await;
                    let _ = tx.send(Ok(code)).await;
                    break;
                }
                Err(msg) => {
                    let body = format!("<h1>Login failed</h1><p>{msg}</p>");
                    let resp = format!(
                        "HTTP/1.1 400 Bad Request\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = socket.write_all(resp.as_bytes()).await;
                    let _ = tx.send(Err(msg)).await;
                    break;
                }
            }
        }
    });

    let result = tokio::time::timeout(timeout, rx.recv()).await;
    http_task.abort();
    match result {
        Ok(Some(Ok(code))) => Ok(code),
        Ok(Some(Err(err))) => anyhow::bail!(err),
        Ok(None) => anyhow::bail!("callback channel closed"),
        Err(_) => anyhow::bail!("timed out waiting for OAuth callback ({}s)", timeout.as_secs()),
    }
}

fn parse_code_from_query(query: &str, expected_state: &str) -> Result<String, String> {
    let mut code = None;
    let mut state = None;
    let mut error = None;
    let mut error_desc = None;
    for (k, v) in url::form_urlencoded::parse(query.as_bytes()) {
        match k.as_ref() {
            "code" => code = Some(v.into_owned()),
            "state" => state = Some(v.into_owned()),
            "error" => error = Some(v.into_owned()),
            "error_description" => error_desc = Some(v.into_owned()),
            _ => {}
        }
    }
    if let Some(err) = error {
        return Err(format!("{err}: {}", error_desc.unwrap_or_default()));
    }
    if let (Some(st), false) = (state.as_deref(), expected_state.is_empty()) {
        if st != expected_state {
            return Err("state mismatch".to_string());
        }
    }
    code.filter(|c| !c.is_empty())
        .ok_or_else(|| "missing code parameter".to_string())
}

fn extract_quoted_param(header: &str, key: &str) -> Option<String> {
    let needle = format!("{key}=\"");
    let start = header.find(&needle)? + needle.len();
    let end = header[start..].find('"')?;
    Some(header[start..start + end].to_string())
}

fn random_b64url(num_bytes: usize) -> String {
    let mut bytes = vec![0u8; num_bytes];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn b64url_sha256(input: &str) -> String {
    let digest = Sha256::digest(input.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_callback_url_variants() {
        assert_eq!(
            extract_callback_query("http://localhost:8400/callback?code=abc&state=xyz").as_deref(),
            Some("code=abc&state=xyz")
        );
        assert_eq!(
            extract_callback_query("  '/callback?code=abc&state=xyz#frag'  ").as_deref(),
            Some("code=abc&state=xyz")
        );
        assert_eq!(
            extract_callback_query("code=abc&state=xyz").as_deref(),
            Some("code=abc&state=xyz")
        );
        assert!(extract_callback_query("hello world").is_none());
    }

    #[test]
    fn roundtrips_agent_oauth_json_format() {
        let dir = std::env::temp_dir().join(format!("kb-fuse-test-{}", std::process::id()));
        let path = dir.join("oauth.json");
        let _ = fs::remove_dir_all(&dir);

        let json = r#"{
  "version": 1,
  "hosts": {
    "https://kb.mgt.moe": {
      "base": "https://kb.mgt.moe",
      "clientId": "cid",
      "redirectUri": "http://localhost:8400/callback",
      "resource": "https://kb.mgt.moe",
      "authorizationServer": "https://mgt.cloudflareaccess.com/cdn-cgi/access/sso/oidc/123",
      "tokenEndpoint": "https://mgt.cloudflareaccess.com/cdn-cgi/access/sso/oidc/123/token",
      "accessToken": "tok-access",
      "tokenType": "bearer",
      "expiresAt": 9999999999999,
      "refreshToken": "tok-refresh",
      "updatedAt": "2026-11-16T00:00:00.000Z"
    }
  }
}"#;
        write_atomic(&path, json.as_bytes(), true).unwrap();
        let store = load_store_from(&path).unwrap();
        let entry = store.hosts.get("https://kb.mgt.moe").unwrap();
        assert_eq!(entry.client_id, "cid");
        assert_eq!(entry.access_token, "tok-access");
        assert_eq!(entry.refresh_token.as_deref(), Some("tok-refresh"));

        save_store_to(&path, &store).unwrap();
        let reloaded = load_store_from(&path).unwrap();
        assert_eq!(reloaded.hosts["https://kb.mgt.moe"].access_token, "tok-access");

        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn needs_login_marker_and_auto_recovery_on_token_update() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        let dir = std::env::temp_dir().join(format!("kb-fuse-auth-nl-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let token_srv_addr = listener.local_addr().unwrap();
        let srv = tokio::spawn(async move {
            if let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = vec![0u8; 2048];
                let _ = sock.read(&mut buf).await;
                let body = r#"{"error":"invalid_grant"}"#;
                let resp = format!(
                    "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = sock.write_all(resp.as_bytes()).await;
            }
        });

        let token_file = dir.join("oauth.json");
        let marker_file = dir.join("cache").join("needs-login");
        let mut config = Config::from_env_and_overrides(
            Some("https://kb.example.test".to_string()),
            Some(dir.join("mnt")),
            Some(dir.join("cache")),
            Some(token_file.clone()),
        )
        .unwrap();
        config.needs_login_file = marker_file.clone();

        let mut store = OAuthStore::default();
        store.hosts.insert(
            "https://kb.example.test".to_string(),
            HostTokenEntry {
                base: "https://kb.example.test".to_string(),
                client_id: "cid".to_string(),
                redirect_uri: "http://localhost:8400/callback".to_string(),
                resource: "https://kb.example.test".to_string(),
                authorization_server: format!("http://{token_srv_addr}"),
                token_endpoint: format!("http://{token_srv_addr}/token"),
                access_token: "expired-access".to_string(),
                token_type: "bearer".to_string(),
                expires_at: 1, // expired
                refresh_token: Some("bad-refresh".to_string()),
                updated_at: "2026-01-01T00:00:00Z".to_string(),
                extra: BTreeMap::new(),
            },
        );
        save_store_to(&token_file, &store).unwrap();

        let client = crate::http_util::build_http_client(&config).unwrap();
        let auth = AuthManager::new(config, client);

        // Refresh fails with 400 -> enters NeedsLogin and writes marker file
        let res = auth.get_credential().await;
        assert!(matches!(res, Err(AuthError::NeedsLogin(_))));
        assert!(auth.is_needs_login());
        assert!(marker_file.exists());
        let marker_text = fs::read_to_string(&marker_file).unwrap();
        assert!(marker_text.contains("status=NeedsLogin"));

        // External `kb-fuse login` updates oauth.json -> auto-recovers without restart
        tokio::time::sleep(Duration::from_millis(20)).await;
        store.hosts.get_mut("https://kb.example.test").unwrap().access_token = "fresh-access".to_string();
        store.hosts.get_mut("https://kb.example.test").unwrap().expires_at = now_epoch_ms() + 600_000;
        store.hosts.get_mut("https://kb.example.test").unwrap().refresh_token = Some("fresh-refresh".to_string());
        save_store_to(&token_file, &store).unwrap();

        assert!(auth.check_for_external_login().await);
        assert!(!auth.is_needs_login());
        assert!(!marker_file.exists());
        match auth.get_credential().await.unwrap() {
            AuthCredential::Bearer(tok) => assert_eq!(tok, "fresh-access"),
            AuthCredential::None => panic!("expected bearer token"),
        }

        srv.abort();
        let _ = fs::remove_dir_all(&dir);
    }
}
