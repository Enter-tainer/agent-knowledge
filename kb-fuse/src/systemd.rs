use tracing::debug;

/// Sends a `systemd` `sd_notify` datagram to `$NOTIFY_SOCKET` if present.
/// Supports filesystem paths and Linux abstract namespace sockets (`@...`).
pub fn notify(state: &str) {
    #[cfg(unix)]
    {
        use std::env;
        use std::os::unix::net::UnixDatagram;

        let Some(socket_path) = env::var_os("NOTIFY_SOCKET") else {
            return;
        };
        let raw = socket_path.to_string_lossy();
        if raw.is_empty() {
            return;
        }

        let sock = match UnixDatagram::unbound() {
            Ok(s) => s,
            Err(err) => {
                debug!("sd_notify unbound socket failed: {err}");
                return;
            }
        };

        let res = if let Some(abstract_name) = raw.strip_prefix('@') {
            #[cfg(target_os = "linux")]
            {
                use std::os::linux::net::SocketAddrExt;
                use std::os::unix::net::SocketAddr;
                match SocketAddr::from_abstract_name(abstract_name.as_bytes()) {
                    Ok(addr) => sock.send_to_addr(state.as_bytes(), &addr),
                    Err(err) => Err(err),
                }
            }
            #[cfg(not(target_os = "linux"))]
            {
                let _ = abstract_name;
                return;
            }
        } else {
            sock.send_to(state.as_bytes(), raw.as_ref())
        };

        if let Err(err) = res {
            debug!("sd_notify send failed: {err}");
        }
    }
    #[cfg(not(unix))]
    {
        let _ = state;
    }
}

pub fn notify_ready(status: &str) {
    notify(&format!("READY=1\nSTATUS={status}"));
}

pub fn notify_status(status: &str) {
    notify(&format!("STATUS={status}"));
}

pub fn notify_stopping(status: &str) {
    notify(&format!("STOPPING=1\nSTATUS={status}"));
}
