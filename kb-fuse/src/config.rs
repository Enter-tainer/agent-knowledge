use std::env;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct Config {
    pub base_url: String,
    pub mount_point: PathBuf,
    pub cache_dir: PathBuf,
    pub token_file: PathBuf,
    pub needs_login_file: PathBuf,
    pub needs_login_webhook: Option<String>,
    pub oauth_script: Option<PathBuf>,
    pub doc_ttl: Duration,
    pub tree_ttl: Duration,
    pub max_concurrent_fetch: usize,
    pub http_timeout: Duration,
    pub http_attempts: usize,
    pub ipv4_only: bool,
    pub allow_other: bool,
}

impl Config {
    pub fn from_env_and_overrides(
        base_url: Option<String>,
        mount_point: Option<PathBuf>,
        cache_dir: Option<PathBuf>,
        token_file: Option<PathBuf>,
    ) -> anyhow::Result<Self> {
        let raw_base = base_url
            .or_else(|| env::var("KB_BASE_URL").ok())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "https://kb.mgt.moe".to_string());
        let base_url = normalize_base_url(&raw_base)?;

        let cache_dir = cache_dir
            .or_else(|| env::var_os("KB_CACHE_DIR").map(PathBuf::from))
            .unwrap_or_else(default_cache_dir);

        let mount_point = mount_point
            .or_else(|| env::var_os("KB_MOUNT_POINT").map(PathBuf::from))
            .unwrap_or_else(default_mount_point);

        let token_file = token_file
            .or_else(|| env::var_os("KB_OAUTH_FILE").map(PathBuf::from))
            .or_else(|| env::var_os("AGENT_OAUTH_FILE").map(PathBuf::from))
            .unwrap_or_else(resolve_default_token_file);

        let needs_login_file = env::var_os("KB_NEEDS_LOGIN_FILE")
            .map(PathBuf::from)
            .unwrap_or_else(|| cache_dir.join("needs-login"));

        let needs_login_webhook = env::var("KB_NEEDS_LOGIN_WEBHOOK")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        let oauth_script = env::var_os("KB_OAUTH_SCRIPT")
            .map(PathBuf::from)
            .or_else(find_oauth_script);

        let doc_ttl = Duration::from_secs(parse_env_u64("KB_DOC_TTL_SECS", 300));
        let tree_ttl = Duration::from_secs(parse_env_u64("KB_TREE_TTL_SECS", 60));
        let max_concurrent_fetch = parse_env_u64("KB_MAX_CONCURRENT_FETCH", 4).max(1) as usize;
        let http_timeout = Duration::from_secs(parse_env_u64("KB_HTTP_TIMEOUT_SECS", 30).max(5));
        let http_attempts = parse_env_u64("KB_HTTP_ATTEMPTS", 3).max(1) as usize;
        let ipv4_only = parse_env_bool("KB_IPV4_ONLY", true);
        let allow_other = parse_env_bool("KB_ALLOW_OTHER", false);

        Ok(Self {
            base_url,
            mount_point,
            cache_dir,
            token_file,
            needs_login_file,
            needs_login_webhook,
            oauth_script,
            doc_ttl,
            tree_ttl,
            max_concurrent_fetch,
            http_timeout,
            http_attempts,
            ipv4_only,
            allow_other,
        })
    }
}

pub fn normalize_base_url(input: &str) -> anyhow::Result<String> {
    let trimmed = input.trim().trim_end_matches('/');
    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        anyhow::bail!("base URL must start with http:// or https://: {input}");
    }
    Ok(trimmed.to_string())
}

pub fn is_loopback_base(base_url: &str) -> bool {
    if let Ok(url) = url::Url::parse(base_url) {
        if let Some(host) = url.host_str() {
            return matches!(host, "127.0.0.1" | "localhost" | "::1" | "[::1]");
        }
    }
    false
}

pub fn home_dir() -> PathBuf {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn default_cache_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let base = env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join("AppData").join("Local"));
        base.join("kb-fuse").join("cache")
    }
    #[cfg(target_os = "macos")]
    {
        home_dir().join("Library").join("Caches").join("kb-fuse")
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let base = env::var_os("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join(".cache"));
        base.join("kb-fuse")
    }
}

pub fn default_data_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let base = env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join("AppData").join("Local"));
        base.join("agent-knowledge")
    }
    #[cfg(target_os = "macos")]
    {
        home_dir()
            .join("Library")
            .join("Application Support")
            .join("agent-knowledge")
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let base = env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join(".local").join("share"));
        base.join("agent-knowledge")
    }
}

pub fn default_mount_point() -> PathBuf {
    home_dir().join("kb")
}

/// Mirrors `scripts/agent-oauth.mjs`'s token file resolution order.
pub fn resolve_default_token_file() -> PathBuf {
    let candidates = [
        default_data_dir().join("oauth.json"),
        home_dir().join(".agent-knowledge").join("oauth.json"),
        PathBuf::from(".auth/oauth.json"),
    ];
    for c in &candidates {
        if c.exists() {
            return c.clone();
        }
    }
    candidates[0].clone()
}

fn find_oauth_script() -> Option<PathBuf> {
    let mut candidates = vec![
        PathBuf::from("scripts/agent-oauth.mjs"),
        PathBuf::from("../scripts/agent-oauth.mjs"),
    ];
    if let Ok(exe) = env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("scripts/agent-oauth.mjs"));
            candidates.push(dir.join("../scripts/agent-oauth.mjs"));
            candidates.push(dir.join("../../scripts/agent-oauth.mjs"));
        }
    }
    candidates.into_iter().find(|p| Path::new(p).is_file())
}

fn parse_env_u64(key: &str, default: u64) -> u64 {
    env::var(key)
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(default)
}

fn parse_env_bool(key: &str, default: bool) -> bool {
    match env::var(key) {
        Ok(v) => match v.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => true,
            "0" | "false" | "no" | "off" => false,
            _ => default,
        },
        Err(_) => default,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_base_url() {
        assert_eq!(normalize_base_url("https://kb.mgt.moe/").unwrap(), "https://kb.mgt.moe");
        assert!(normalize_base_url("kb.mgt.moe").is_err());
    }

    #[test]
    fn detects_loopback() {
        assert!(is_loopback_base("http://127.0.0.1:8787"));
        assert!(is_loopback_base("http://localhost:8787"));
        assert!(!is_loopback_base("https://kb.mgt.moe"));
    }
}
