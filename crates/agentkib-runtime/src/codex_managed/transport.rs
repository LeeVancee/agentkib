//! Bounded stdio client. The process and its descendants belong exclusively to this host.
use agentkib_platform::process::{ProcessTree, configure_process_group};
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs::File,
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};
const FRAME_LIMIT: usize = 4 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(12);
type ResponseHandler = Box<dyn FnOnce(&Value) -> Result<()> + Send>;
struct PendingRequest {
    sender: mpsc::SyncSender<Result<Value>>,
    apply: ResponseHandler,
}
type Pending = Arc<Mutex<HashMap<u64, PendingRequest>>>;
pub(super) struct Client {
    child: Child,
    tree: ProcessTree,
    writer: Option<mpsc::SyncSender<Value>>,
    pending: Pending,
    next: AtomicU64,
    closed: Arc<AtomicBool>,
    reader: Option<thread::JoinHandle<()>>,
    _lease: Option<File>,
}
impl Client {
    pub fn spawn(
        executable: &Path,
        workspace: &Path,
        home: &Path,
        lease: Option<File>,
        callback: impl Fn(Value) + Send + 'static,
    ) -> Result<Self> {
        let mut cmd = Command::new(executable);
        configure_process_group(&mut cmd);
        cmd.args(["app-server", "--stdio"])
            .env("CODEX_HOME", home)
            .current_dir(workspace)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = cmd.spawn().context("codex-app-server-unavailable")?;
        let tree = match ProcessTree::attach(&child) {
            Ok(t) => t,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e.into());
            }
        };
        let mut stdin = child.stdin.take().context("codex-stdin-unavailable")?;
        let stdout = child.stdout.take().context("codex-stdout-unavailable")?;
        let (writer, rx) = mpsc::sync_channel::<Value>(32);
        let closed = Arc::new(AtomicBool::new(false));
        let failed = closed.clone();
        thread::spawn(move || {
            for value in rx {
                let result = (|| -> std::io::Result<()> {
                    serde_json::to_writer(&mut stdin, &value)?;
                    stdin.write_all(b"\n")?;
                    stdin.flush()
                })();
                if result.is_err() {
                    failed.store(true, Ordering::Release);
                    break;
                }
            }
        });
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let replies = pending.clone();
        let ended = closed.clone();
        let reader = thread::spawn(move || {
            let mut input = BufReader::new(stdout);
            while let Ok(Some(value)) = read_frame(&mut input) {
                if value.get("method").is_none() {
                    let request = value["id"].as_u64().and_then(|id| {
                        replies
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .remove(&id)
                    });
                    if let Some(request) = request {
                        // Apply a recovered baseline at the response's position
                        // in the native stream, before later notifications can
                        // update the same state. No pending-map lock is held.
                        let result = response_result(value).and_then(|result| {
                            (request.apply)(&result)?;
                            Ok(result)
                        });
                        let _ = request.sender.send(result);
                    }
                } else {
                    callback(value)
                }
            }
            ended.store(true, Ordering::Release);
            replies.lock().unwrap_or_else(|p| p.into_inner()).clear();
            callback(json!({"method":"agentkib/disconnected"}));
        });
        let this = Self {
            child,
            tree,
            writer: Some(writer),
            pending,
            next: AtomicU64::new(1),
            closed,
            reader: Some(reader),
            _lease: lease,
        };
        this.request("initialize",json!({"clientInfo":{"name":"agentkib","title":"AgentKib","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}}))?;
        this.write(json!({"method":"initialized","params":{}}))?;
        Ok(this)
    }
    pub fn connected(&self) -> bool {
        !self.closed.load(Ordering::Acquire)
    }
    pub fn request(&self, method: &str, params: Value) -> Result<Value> {
        self.request_with_dispatch(method, params, || Ok(()))
    }
    pub fn request_with_dispatch(
        &self,
        method: &str,
        params: Value,
        dispatch: impl FnOnce() -> Result<()>,
    ) -> Result<Value> {
        self.request_with_response(method, params, dispatch, |_| Ok(()))
    }
    pub fn request_with_response(
        &self,
        method: &str,
        params: Value,
        dispatch: impl FnOnce() -> Result<()>,
        apply: impl FnOnce(&Value) -> Result<()> + Send + 'static,
    ) -> Result<Value> {
        ensure!(self.connected(), "codex-disconnected");
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::sync_channel(1);
        {
            let mut pending = self
                .pending
                .lock()
                .map_err(|_| anyhow::anyhow!("codex-state-unavailable"))?;
            ensure!(pending.len() < 128, "codex-busy");
            pending.insert(
                id,
                PendingRequest {
                    sender: tx,
                    apply: Box::new(apply),
                },
            );
        }
        let result = (|| {
            let value = json!({"id":id,"method":method,"params":params});
            ensure!(
                serde_json::to_vec(&value)?.len() <= FRAME_LIMIT,
                "codex-request-too-large"
            );
            dispatch()?;
            self.write(value)?;
            rx.recv_timeout(TIMEOUT)
                .context("codex-outcome-unconfirmed")?
        })();
        self.pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&id);
        result
    }
    pub fn write(&self, value: Value) -> Result<()> {
        ensure!(self.connected(), "codex-disconnected");
        ensure!(
            serde_json::to_vec(&value)?.len() <= FRAME_LIMIT,
            "codex-request-too-large"
        );
        self.writer
            .as_ref()
            .context("codex-disconnected")?
            .try_send(value)
            .context("codex-busy")?;
        Ok(())
    }
    pub fn respond(&self, id: Value, result: Value) -> Result<()> {
        self.write(json!({"id":id,"result":result}))
    }
    pub fn shutdown(&mut self) {
        // Closing stdin asks app-server to flush and release its native writer. Kill only
        // our own process group if it does not exit; never touch a shared Codex daemon.
        self.writer.take();
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while std::time::Instant::now() < deadline {
            if self.child.try_wait().ok().flatten().is_some() {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.tree.terminate();
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
        self.closed.store(true, Ordering::Release);
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}
fn response_result(response: Value) -> Result<Value> {
    if response.get("error").is_some() {
        // Return a bounded category, never native diagnostics that may contain secrets.
        let msg = response["error"]["message"].as_str().unwrap_or("");
        if msg.contains("active writer") || msg.contains("live local writer") {
            bail!("codex-owner-busy")
        }
        bail!("codex-request-rejected")
    }
    response
        .get("result")
        .cloned()
        .context("codex-invalid-response")
}
impl Drop for Client {
    fn drop(&mut self) {
        self.shutdown()
    }
}
fn read_frame(input: &mut impl BufRead) -> Result<Option<Value>> {
    let mut bytes = Vec::new();
    loop {
        let available = input.fill_buf()?;
        if available.is_empty() {
            ensure!(bytes.is_empty(), "codex-partial-frame");
            return Ok(None);
        }
        let n = available
            .iter()
            .position(|b| *b == b'\n')
            .map_or(available.len(), |n| n + 1);
        ensure!(bytes.len() + n <= FRAME_LIMIT, "codex-frame-too-large");
        let done = available[n - 1] == b'\n';
        bytes.extend_from_slice(&available[..n]);
        input.consume(n);
        if done {
            return Ok(Some(serde_json::from_slice(&bytes)?));
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frames_are_bounded_and_incomplete_frames_rejected() {
        assert!(read_frame(&mut std::io::Cursor::new(vec![b'a'; FRAME_LIMIT + 1])).is_err());
        assert!(read_frame(&mut std::io::Cursor::new(b"{}")).is_err());
        assert_eq!(
            read_frame(&mut std::io::Cursor::new(b"{}\n")).unwrap(),
            Some(json!({}))
        );
    }
}
