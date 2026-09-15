use std::{
    fs,
    io::{Read, Write},
    net::Shutdown,
    os::{
        fd::AsRawFd,
        unix::{fs::MetadataExt, net::UnixStream},
    },
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{CLIENT_TYPE, method_version};

const MAX_FRAME: usize = 8 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(3);

/// A connection is single-consumer and never registers as a thread owner/router.
pub struct Connection {
    socket: UnixStream,
    client_id: String,
    buffered: Vec<u8>,
    closed: bool,
    peer_executable: Option<PathBuf>,
}

fn endpoint_metadata(path: &Path) -> Result<fs::Metadata> {
    ensure!(path.is_absolute(), "IPC endpoint must be absolute");
    ensure!(
        path.canonicalize()? == path,
        "IPC endpoint must not contain symlinks"
    );
    // SAFETY: geteuid has no pointer arguments or side effects.
    let uid = unsafe { libc::geteuid() };
    let parent = fs::symlink_metadata(path.parent().context("missing IPC directory")?)?;
    ensure!(
        parent.is_dir() && parent.uid() == uid && parent.mode() & 0o077 == 0,
        "IPC directory must be private and owned by the current user"
    );
    let metadata = fs::symlink_metadata(path)?;
    use std::os::unix::fs::FileTypeExt;
    ensure!(
        metadata.file_type().is_socket() && metadata.uid() == uid && metadata.mode() & 0o077 == 0,
        "IPC socket must be private and owned by the current user"
    );
    Ok(metadata)
}

impl Connection {
    pub fn connect(path: &Path) -> Result<Self> {
        let before = endpoint_metadata(path)?;
        let socket = UnixStream::connect(path).context("Codex IPC unavailable")?;
        let after = endpoint_metadata(path)?;
        ensure!(
            before.dev() == after.dev() && before.ino() == after.ino(),
            "IPC endpoint changed"
        );
        let mut uid = 0;
        let mut gid = 0;
        // SAFETY: the fd is live and both output pointers reference initialized uid/gid values.
        let result = unsafe { libc::getpeereid(socket.as_raw_fd(), &mut uid, &mut gid) };
        ensure!(
            result == 0 && uid == unsafe { libc::geteuid() },
            "IPC peer is not the current user"
        );
        socket.set_write_timeout(Some(TIMEOUT))?;
        let peer_executable = peer_executable(&socket);
        let mut connection = Self {
            socket,
            client_id: "uninitialized".into(),
            buffered: Vec::new(),
            closed: false,
            peer_executable,
        };
        let response = connection.request(
            "initialize",
            json!({"clientType": CLIENT_TYPE}),
            None,
            |_| Ok(()),
        )?;
        ensure!(
            response["method"] == "initialize",
            "invalid initialization response"
        );
        connection.client_id = response["result"]["clientId"]
            .as_str()
            .filter(|id| !id.is_empty())
            .context("IPC initialization did not assign a client ID")?
            .to_owned();
        ensure!(connection.client_id.len() <= 256, "invalid client ID");
        Ok(connection)
    }

    pub fn is_connected(&self) -> bool {
        !self.closed
    }

    pub(crate) fn peer_executable(&self) -> Option<&Path> {
        self.peer_executable.as_deref()
    }

    pub fn disconnect(&mut self) {
        self.closed = true;
        self.buffered.clear();
        let _ = self.socket.shutdown(Shutdown::Both);
    }

    pub(crate) fn client_id(&self) -> &str {
        &self.client_id
    }

    fn write(&mut self, value: &Value) -> Result<()> {
        self.write_with_dispatch(value, || Ok(()))
    }

    fn write_with_dispatch(
        &mut self,
        value: &Value,
        dispatch: impl FnOnce() -> Result<()>,
    ) -> Result<()> {
        ensure!(!self.closed, "IPC disconnected");
        let bytes = serde_json::to_vec(value)?;
        ensure!(bytes.len() <= 64 * 1024, "IPC request exceeds limit");
        // A write error can follow a partial frame. Signal before the first byte,
        // after all local checks that can prove no mutation was attempted.
        dispatch()?;
        let result = self
            .socket
            .write_all(&(bytes.len() as u32).to_le_bytes())
            .and_then(|_| self.socket.write_all(&bytes));
        if result.is_err() {
            self.disconnect();
        }
        result.context("IPC write failed; do not retry a mutation")
    }

    pub(crate) fn broadcast(&mut self, method: &str, params: Value, owner: &str) -> Result<()> {
        self.write(&json!({"type":"broadcast", "method":method,
            "version":method_version(method).context("unsupported IPC method")?,
            "sourceClientId":self.client_id, "params":params, "targetClientIds":[owner]}))
    }

    pub(crate) fn request(
        &mut self,
        method: &str,
        params: Value,
        owner: Option<&str>,
        notification: impl FnMut(Value) -> Result<()>,
    ) -> Result<Value> {
        self.request_with_dispatch(method, params, owner, notification, || Ok(()))
    }

    pub(crate) fn request_with_dispatch(
        &mut self,
        method: &str,
        params: Value,
        owner: Option<&str>,
        mut notification: impl FnMut(Value) -> Result<()>,
        dispatch: impl FnOnce() -> Result<()>,
    ) -> Result<Value> {
        let id = Uuid::new_v4().to_string();
        let mut request = json!({"type":"request", "requestId":id, "sourceClientId":self.client_id,
            "version":method_version(method).context("unsupported IPC method")?, "method":method,
            "params":params, "timeoutMs":2500});
        if let Some(owner) = owner {
            request["targetClientId"] = json!(owner);
        }
        self.write_with_dispatch(&request, dispatch)?;
        // The official router gives each owner-discovery candidate up to ten seconds.
        // This read-only lookup needs a longer deadline than a mutation acknowledgement.
        let deadline = Instant::now()
            + if method == "thread-owner-discovery" {
                Duration::from_secs(12)
            } else {
                TIMEOUT
            };
        loop {
            let Some(message) = self.receive(deadline)? else {
                self.disconnect();
                bail!("IPC outcome unknown: request timed out; no automatic retry");
            };
            if message["type"] == "response" && message["requestId"] == id {
                ensure!(
                    message["resultType"] == "success",
                    "IPC request rejected: {}",
                    match message["error"].as_str() {
                        Some("no-client-found") => "no session owner found",
                        Some("request-timeout") => "outcome unknown",
                        _ => "unsupported or unavailable",
                    }
                );
                if let Some(owner) = owner {
                    ensure!(message["handledByClientId"] == owner, "IPC owner changed");
                }
                return Ok(message);
            }
            notification(message)?;
        }
    }

    /// Ignores unrelated broadcasts without exposing their payload to a caller.
    pub(crate) fn receive(&mut self, deadline: Instant) -> Result<Option<Value>> {
        let result = self.receive_inner(deadline);
        if result.is_err() {
            self.disconnect();
        }
        result
    }

    fn receive_inner(&mut self, deadline: Instant) -> Result<Option<Value>> {
        ensure!(!self.closed, "IPC disconnected");
        loop {
            if Instant::now() >= deadline {
                return Ok(None);
            }
            if self.buffered.len() >= 4 {
                let size = u32::from_le_bytes(self.buffered[..4].try_into()?) as usize;
                ensure!(size > 0 && size <= MAX_FRAME, "IPC frame exceeds limit");
                if self.buffered.len() >= size + 4 {
                    let message: Value = serde_json::from_slice(&self.buffered[4..size + 4])?;
                    self.buffered.drain(..size + 4);
                    // A follower must never claim it can handle another client's operations.
                    if message["type"] == "client-discovery-request" {
                        self.write(&json!({"type":"client-discovery-response", "requestId":message["requestId"],
                            "response":{"canHandle":false}}))?;
                        continue;
                    }
                    return Ok(Some(message));
                }
            }
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                return Ok(None);
            };
            self.socket
                .set_read_timeout(Some(remaining.max(Duration::from_millis(1))))?;
            let mut bytes = [0; 8192];
            match self.socket.read(&mut bytes) {
                Ok(0) => bail!("IPC disconnected"),
                Ok(n) => self.buffered.extend_from_slice(&bytes[..n]),
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    return Ok(None);
                }
                Err(e) => return Err(e.into()),
            }
        }
    }
}

fn peer_executable(socket: &UnixStream) -> Option<PathBuf> {
    let mut pid: libc::pid_t = 0;
    let mut length = std::mem::size_of_val(&pid) as libc::socklen_t;
    // SAFETY: getsockopt receives a live descriptor and a correctly sized writable pid buffer.
    let result = unsafe {
        libc::getsockopt(
            socket.as_raw_fd(),
            0,
            libc::LOCAL_PEERPID,
            (&mut pid as *mut libc::pid_t).cast(),
            &mut length,
        )
    };
    if result != 0 || pid <= 0 {
        return None;
    }
    let mut buffer = [0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: buffer is writable for the advertised length; this only queries a process path.
    let size = unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
    if size <= 0 {
        return None;
    }
    let size = buffer.iter().position(|b| *b == 0)?;
    PathBuf::from(std::str::from_utf8(&buffer[..size]).ok()?)
        .canonicalize()
        .ok()
}

impl Drop for Connection {
    fn drop(&mut self) {
        self.disconnect();
    }
}
