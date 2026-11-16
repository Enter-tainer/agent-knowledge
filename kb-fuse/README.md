# kb-fuse

Read-only FUSE filesystem with Stale-While-Revalidate (SWR) disk caching for `agent-knowledge` (`kb.mgt.moe`).

## Features

- **Read-only FUSE vault view**: Exposes `/api/tree` + `/api/docs/{path}` as `<path>.md` files and directories, directly usable with `rg`, `grep`, `git`, and editors.
- **SWR caching**:
  - Cold cache (first `open` without local copy) blocks once on upstream fetch.
  - Warm/stale cache returns immediately from disk on `open`/`read` and refreshes asynchronously via `If-None-Match` (`304` refreshes freshness mtime, `200` atomically swaps body + `ETag`).
  - Tree cache refreshes in the background and checks `/api/health` (`stale != 0` logs a warning recommending `POST /api/admin/reindex`).
- **Cloudflare Access resilience**: IPv4-only socket binding by default + exponential-backoff retries; transient upstream errors warn without crashing.
- **Auth lifecycle & `NeedsLogin`**:
  - Reuses `oauth.json` (`0600`) and the same `refresh_token` exchange logic as `scripts/agent-oauth.mjs`.
  - Refresh failure (expired/revoked grant) enters `NeedsLogin`: mount stays up serving cached files, background revalidation pauses, `sd_notify` updates `STATUS=...`, and `~/.cache/kb-fuse/needs-login` is created.
  - Run `kb-fuse login` (wraps `agent-oauth.mjs login --no-open` + accepts pasted `http://localhost:8400/callback?code=...&state=...` on stdin) to re-authenticate; the running service detects the updated `oauth.json` automatically without restarting the systemd unit.

## Build & Install (Linux)

```bash
# Build deps: libfuse3-dev (fuse3.pc for fuser's pkg-config probe) + fusermount3 at runtime
cd kb-fuse
cargo build --release
install -Dm755 target/release/kb-fuse ~/.local/bin/kb-fuse
```

Warm the cache once after installing (otherwise the first `rg`/`grep` pass pays every cold fetch):

```bash
kb-fuse prefetch --concurrency 6
```

## systemd --user Setup

```bash
mkdir -p ~/.config/kb-fuse ~/.config/systemd/user
cp kb-fuse/systemd/kb-fuse.env.example ~/.config/kb-fuse/env
# Edit ~/.config/kb-fuse/env with your actual user paths
cp kb-fuse/systemd/kb-fuse.service ~/.config/systemd/user/kb-fuse.service

systemctl --user daemon-reload
systemctl --user enable --now kb-fuse

# Optional: keep running when not logged in
loginctl enable-linger "$USER"

# Inspect logs & status
systemctl --user status kb-fuse
journalctl --user -u kb-fuse -f
```

## Platform Support

- **Linux (x86_64 / aarch64, including WSL2)**: Full support (`fuser` over `/dev/fuse` + `fusermount3`, `systemd --user`, `sd_notify`, `0600` file permissions).
- **macOS**: FUSE mount backend compiles via `fuser` (requires macFUSE or FUSE-T); uses `umount` instead of `fusermount3`, and `launchd` instead of `systemd --user`.
- **Windows (native)**: CLI (`login`, `status`) and core SWR/auth/VFS tests compile and run natively, but `mount` requires Unix FUSE (use WSL2 Linux binary or a future WinFsp adapter).
