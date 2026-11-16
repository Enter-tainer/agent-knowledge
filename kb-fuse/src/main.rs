use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use clap::{Parser, Subcommand};
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

use kb_fuse::api::KbApiClient;
use kb_fuse::auth::{mask_token, now_epoch_ms, run_login, AuthManager};
use kb_fuse::cache::SwrCache;
use kb_fuse::config::{is_loopback_base, Config};
use kb_fuse::http_util::build_http_client;
use kb_fuse::systemd;
use kb_fuse::vfs::VfsCore;

#[derive(Parser)]
#[command(name = "kb-fuse", version, about = "Read-only FUSE filesystem with SWR cache for agent-knowledge")]
struct Cli {
    #[arg(long, global = true, env = "KB_BASE_URL")]
    base: Option<String>,

    #[arg(long, global = true, env = "KB_CACHE_DIR")]
    cache_dir: Option<PathBuf>,

    #[arg(long, global = true, env = "AGENT_OAUTH_FILE")]
    token_file: Option<PathBuf>,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Mount the knowledge base as a read-only FUSE directory
    Mount {
        #[arg(long, env = "KB_MOUNT_POINT")]
        mountpoint: Option<PathBuf>,
    },
    /// Authenticate via Cloudflare Access Managed OAuth (delegates to agent-oauth.mjs --no-open when present)
    Login {
        /// Open system browser automatically (default is --no-open for headless/remote workflows)
        #[arg(long)]
        open: bool,
        #[arg(long, default_value_t = 8400)]
        port: u16,
        #[arg(long, default_value_t = 300)]
        timeout: u64,
        /// Force built-in Rust OAuth client instead of scripts/agent-oauth.mjs
        #[arg(long)]
        native: bool,
    },
    /// Show auth, cache, and NeedsLogin marker status
    Status {
        #[arg(long, env = "KB_MOUNT_POINT")]
        mountpoint: Option<PathBuf>,
    },
    /// Unmount the FUSE directory (fusermount3 -u on Linux)
    Unmount {
        #[arg(long, env = "KB_MOUNT_POINT")]
        mountpoint: Option<PathBuf>,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .init();

    let cli = Cli::parse();

    match cli.command {
        Commands::Mount { mountpoint } => {
            let config = Config::from_env_and_overrides(cli.base, mountpoint, cli.cache_dir, cli.token_file)?;
            run_mount(config).await
        }
        Commands::Login {
            open,
            port,
            timeout,
            native,
        } => {
            let config = Config::from_env_and_overrides(cli.base, None, cli.cache_dir, cli.token_file)?;
            let client = build_http_client(&config)?;
            run_login(&config, &client, open, port, timeout, native).await
        }
        Commands::Status { mountpoint } => {
            let config = Config::from_env_and_overrides(cli.base, mountpoint, cli.cache_dir, cli.token_file)?;
            run_status(&config)
        }
        Commands::Unmount { mountpoint } => {
            let config = Config::from_env_and_overrides(cli.base, mountpoint, cli.cache_dir, cli.token_file)?;
            #[cfg(unix)]
            {
                kb_fuse::fuse_unix::unmount_path(&config.mount_point)?;
                println!("Unmounted {}", config.mount_point.display());
                Ok(())
            }
            #[cfg(not(unix))]
            {
                let _ = config;
                anyhow::bail!("FUSE mount/unmount is only supported on Unix (Linux / macOS / WSL2)");
            }
        }
    }
}

async fn run_mount(config: Config) -> anyhow::Result<()> {
    #[cfg(not(unix))]
    {
        let _ = config;
        anyhow::bail!(
            "Native FUSE mounting is not supported on Windows. Run kb-fuse inside Linux / WSL2 (or macOS with macFUSE/FUSE-T)."
        );
    }

    #[cfg(unix)]
    {
        let client = build_http_client(&config)?;
        let auth = Arc::new(AuthManager::new(config.clone(), client.clone()));
        let api = Arc::new(KbApiClient::new(config.clone(), client, auth.clone()));
        let cache = Arc::new(SwrCache::new(config.clone(), api, auth.clone())?);
        let rt = tokio::runtime::Handle::current();
        let vfs = Arc::new(VfsCore::new(cache.clone(), auth.clone(), rt, config.tree_ttl));

        vfs.init_tree().await;

        let session = kb_fuse::fuse_unix::spawn_mount(vfs.clone(), &config)?;
        info!(
            "mounted {} at {} (cache: {}, docs: {})",
            config.base_url,
            config.mount_point.display(),
            config.cache_dir.display(),
            vfs.doc_count()
        );

        if auth.is_needs_login() {
            systemd::notify_ready(&format!(
                "NeedsLogin: run `kb-fuse login` (marker: {})",
                config.needs_login_file.display()
            ));
        } else {
            systemd::notify_ready("Mounted (SWR active)");
        }

        let vfs_bg = vfs.clone();
        let auth_bg = auth.clone();
        let cache_bg = cache.clone();
        let tree_ttl = config.tree_ttl;

        let (shutdown_tx, mut shutdown_rx) = tokio::sync::watch::channel(false);

        let bg_task = tokio::spawn(async move {
            let mut tree_interval = tokio::time::interval(tree_ttl.max(Duration::from_secs(10)));
            tree_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            tree_interval.tick().await; // skip immediate tick right after init_tree

            let mut login_poll = tokio::time::interval(Duration::from_secs(2));
            login_poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

            loop {
                tokio::select! {
                    _ = shutdown_rx.changed() => {
                        if *shutdown_rx.borrow() {
                            break;
                        }
                    }
                    _ = tree_interval.tick() => {
                        if !auth_bg.is_needs_login() {
                            if let Some(docs) = cache_bg.refresh_tree_and_health().await {
                                vfs_bg.apply_tree(&docs, now_epoch_ms(), std::time::SystemTime::now());
                            }
                        }
                    }
                    _ = login_poll.tick() => {
                        if auth_bg.is_needs_login() && auth_bg.check_for_external_login().await {
                            if let Some(docs) = cache_bg.refresh_tree_and_health().await {
                                vfs_bg.apply_tree(&docs, now_epoch_ms(), std::time::SystemTime::now());
                            }
                        }
                    }
                }
            }
        });

        wait_for_shutdown_signal(&auth, &cache, &vfs).await;

        systemd::notify_stopping("Unmounting FUSE filesystem");
        let _ = shutdown_tx.send(true);
        bg_task.abort();

        // Drop session on a blocking thread to cleanly unmount /dev/fuse.
        if let Err(err) = tokio::task::spawn_blocking(move || drop(session)).await {
            warn!("error while dropping FUSE session: {err}");
        }
        info!("unmounted {}", config.mount_point.display());
        Ok(())
    }
}

#[cfg(unix)]
async fn wait_for_shutdown_signal(
    auth: &Arc<AuthManager>,
    cache: &Arc<SwrCache>,
    vfs: &Arc<VfsCore>,
) {
    use tokio::signal::unix::{signal, SignalKind};
    let mut sigterm = signal(SignalKind::terminate()).expect("SIGTERM handler");
    let mut sigint = signal(SignalKind::interrupt()).expect("SIGINT handler");
    let mut sighup = signal(SignalKind::hangup()).expect("SIGHUP handler");

    loop {
        tokio::select! {
            _ = sigterm.recv() => {
                info!("received SIGTERM, shutting down");
                break;
            }
            _ = sigint.recv() => {
                info!("received SIGINT, shutting down");
                break;
            }
            _ = sighup.recv() => {
                info!("received SIGHUP, checking credentials and refreshing tree");
                let _ = auth.force_reload_check().await;
                if !auth.is_needs_login() {
                    if let Some(docs) = cache.refresh_tree_and_health().await {
                        vfs.apply_tree(&docs, now_epoch_ms(), std::time::SystemTime::now());
                    }
                }
            }
        }
    }
}

fn run_status(config: &Config) -> anyhow::Result<()> {
    let client = build_http_client(config)?;
    let auth = AuthManager::new(config.clone(), client);
    let tree_docs = std::fs::read(config.cache_dir.join("tree.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<kb_fuse::cache::CachedTree>(&b).ok())
        .map(|t| t.docs.len());

    let needs_login = config.needs_login_file.exists();
    let entry_info = if is_loopback_base(&config.base_url) {
        Some(serde_json::json!({ "mode": "loopback-no-auth" }))
    } else {
        auth.read_host_entry_opt()?.map(|e| {
            let secs_left = (e.expires_at - now_epoch_ms()) / 1000;
            serde_json::json!({
                "accessToken": mask_token(&e.access_token),
                "expiresInSeconds": secs_left,
                "hasRefreshToken": e.refresh_token.as_ref().is_some_and(|s| !s.is_empty()),
                "updatedAt": e.updated_at,
            })
        })
    };

    let out = serde_json::json!({
        "baseUrl": config.base_url,
        "mountPoint": config.mount_point,
        "cacheDir": config.cache_dir,
        "tokenFile": config.token_file,
        "needsLoginMarker": needs_login,
        "needsLoginFile": config.needs_login_file,
        "cachedTreeDocs": tree_docs,
        "auth": entry_info,
    });
    println!("{}", serde_json::to_string_pretty(&out)?);
    Ok(())
}
