use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Creates directory and parents, applying `0o700` on Unix when `restrictive` is true.
pub fn ensure_dir(path: &Path, restrictive: bool) -> std::io::Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    if restrictive {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o700));
    }
    #[cfg(not(unix))]
    let _ = restrictive;
    Ok(())
}

/// Atomically writes `bytes` to `target` via a sibling temporary file + rename.
/// On Unix, sets file mode `0o600` when `mode_0600` is true before renaming.
pub fn write_atomic(target: &Path, bytes: &[u8], mode_0600: bool) -> std::io::Result<()> {
    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    ensure_dir(parent, mode_0600)?;

    let seq = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    let file_name = target
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("tmp");
    let tmp_path = parent.join(format!(".{file_name}.tmp.{pid}.{seq}"));

    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    if mode_0600 {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }

    let mut file = opts.open(&tmp_path)?;
    let write_res = (|| -> std::io::Result<()> {
        file.write_all(bytes)?;
        file.flush()?;
        #[cfg(unix)]
        if mode_0600 {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))?;
        }
        Ok(())
    })();

    if let Err(err) = write_res {
        let _ = fs::remove_file(&tmp_path);
        return Err(err);
    }
    drop(file);

    if let Err(err) = fs::rename(&tmp_path, target) {
        let _ = fs::remove_file(&tmp_path);
        return Err(err);
    }
    Ok(())
}
