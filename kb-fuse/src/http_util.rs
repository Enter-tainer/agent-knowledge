use std::net::{IpAddr, Ipv4Addr};
use std::time::Duration;

use reqwest::Client;

use crate::config::{is_loopback_base, Config};

/// Builds a `reqwest::Client` configured for Cloudflare edge stability:
/// - `rustls` TLS (no OpenSSL system dependency)
/// - `local_address(0.0.0.0)` when `ipv4_only` is enabled and target is not an IPv6 literal,
///   avoiding IPv6 AAAA blackhole timeouts.
pub fn build_http_client(config: &Config) -> anyhow::Result<Client> {
    let mut builder = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(config.http_timeout)
        .pool_idle_timeout(Duration::from_secs(30))
        .user_agent(concat!("kb-fuse/", env!("CARGO_PKG_VERSION")));

    let is_v6_literal = url::Url::parse(&config.base_url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.contains(':')))
        .unwrap_or(false);

    if config.ipv4_only && !is_v6_literal && !is_loopback_base(&config.base_url) {
        builder = builder.local_address(IpAddr::V4(Ipv4Addr::UNSPECIFIED));
    }

    Ok(builder.build()?)
}

pub fn is_retryable_status(status: reqwest::StatusCode) -> bool {
    status.is_server_error() || status == reqwest::StatusCode::REQUEST_TIMEOUT || status == reqwest::StatusCode::TOO_MANY_REQUESTS
}

pub fn retry_backoff(attempt: usize) -> Duration {
    let base_ms = 350u64.saturating_mul((attempt as u64) + 1);
    let jitter_ms = rand::random::<u64>() % 150;
    Duration::from_millis(base_ms + jitter_ms)
}
