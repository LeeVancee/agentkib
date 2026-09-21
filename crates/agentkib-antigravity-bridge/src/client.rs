use std::{
    collections::{HashMap, HashSet},
    ffi::OsString,
    path::Path,
    process::Stdio,
};

use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
};

use crate::{
    Compatibility, Error, Event, MAX_FRAME_BYTES, MAX_PROMPT_BYTES, PROTOCOL_VERSION,
    PermissionRequest, Result, RpcError, RpcId,
};

const MAX_PENDING: usize = 128;

struct Pending {
    method: &'static str,
    session_id: Option<String>,
}

pub type StdioClient = Client<ChildStdout, ChildStdin>;

pub struct Client<R, W> {
    reader: BufReader<R>,
    writer: W,
    child: Option<Child>,
    frame: Vec<u8>,
    next_id: i64,
    pending: HashMap<RpcId, Pending>,
    permissions: HashMap<RpcId, PermissionRequest>,
    sessions: HashSet<String>,
    active_turns: HashSet<String>,
    cancelled_turns: HashSet<String>,
    compatibility: Option<Compatibility>,
    initialized: bool,
    closed: bool,
}

impl StdioClient {
    /// Launch an explicitly selected executable. Does not install or authenticate.
    /// Stderr is discarded; it is neither protocol input nor safe diagnostic data.
    pub fn spawn(executable: &Path, args: &[OsString], cwd: &Path) -> Result<Self> {
        if !executable.is_absolute() || !cwd.is_absolute() {
            return Err(Error::Invalid("executable and cwd must be absolute"));
        }
        let mut child = Command::new(executable)
            .args(args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        let reader = child
            .stdout
            .take()
            .ok_or(Error::Protocol("missing stdout"))?;
        let writer = child.stdin.take().ok_or(Error::Protocol("missing stdin"))?;
        let mut client = Self::from_io(reader, writer);
        client.child = Some(child);
        Ok(client)
    }
}

impl<R: AsyncRead + Unpin, W: AsyncWrite + Unpin> Client<R, W> {
    pub fn from_io(reader: R, writer: W) -> Self {
        Self {
            reader: BufReader::new(reader),
            writer,
            child: None,
            frame: Vec::new(),
            next_id: 1,
            pending: HashMap::new(),
            permissions: HashMap::new(),
            sessions: HashSet::new(),
            active_turns: HashSet::new(),
            cancelled_turns: HashSet::new(),
            compatibility: None,
            initialized: false,
            closed: false,
        }
    }

    pub fn compatibility(&self) -> Option<&Compatibility> {
        self.compatibility.as_ref()
    }

    pub async fn initialize(&mut self) -> Result<RpcId> {
        if self.initialized {
            return Err(Error::Invalid("initialize already sent"));
        }
        self.initialized = true;
        self.request(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "clientCapabilities": {},
                "clientInfo": {"name":"agentkib", "version":env!("CARGO_PKG_VERSION")}
            }),
            None,
        )
        .await
    }

    pub async fn list_sessions(
        &mut self,
        cwd: Option<&Path>,
        cursor: Option<&str>,
    ) -> Result<RpcId> {
        if !self.ready()?.list_sessions {
            return Err(Error::Unsupported("session/list"));
        }
        let mut params = json!({});
        if let Some(cwd) = cwd {
            params["cwd"] = json!(absolute_path(cwd)?);
        }
        if let Some(cursor) = cursor {
            params["cursor"] = json!(cursor);
        }
        self.request("session/list", params, None).await
    }

    pub async fn new_session(&mut self, cwd: &Path) -> Result<RpcId> {
        self.ready()?;
        self.request(
            "session/new",
            json!({"cwd":absolute_path(cwd)?,"mcpServers":[]}),
            None,
        )
        .await
    }

    /// Loads native history through session/update; this does not import history.
    pub async fn load_session(&mut self, session_id: &str, cwd: &Path) -> Result<RpcId> {
        if !self.ready()?.load_session {
            return Err(Error::Unsupported("session/load"));
        }
        self.attach("session/load", session_id, cwd).await
    }

    /// Reconnects without replay. The caller must already have the transcript.
    pub async fn resume_session(&mut self, session_id: &str, cwd: &Path) -> Result<RpcId> {
        if !self.ready()?.resume_session {
            return Err(Error::Unsupported("session/resume"));
        }
        self.attach("session/resume", session_id, cwd).await
    }

    async fn attach(
        &mut self,
        method: &'static str,
        session_id: &str,
        cwd: &Path,
    ) -> Result<RpcId> {
        validate_id(session_id)?;
        if self.active_turns.contains(session_id) {
            return Err(Error::Invalid("session has an active turn"));
        }
        self.request(
            method,
            json!({"sessionId":session_id,"cwd":absolute_path(cwd)?,"mcpServers":[]}),
            Some(session_id),
        )
        .await
    }

    pub async fn prompt(&mut self, session_id: &str, text: &str) -> Result<RpcId> {
        self.ready()?;
        if !self.sessions.contains(session_id) {
            return Err(Error::Invalid("session is not attached"));
        }
        if self.active_turns.contains(session_id) {
            return Err(Error::Invalid("session has an active turn"));
        }
        if text.trim().is_empty() || text.len() > MAX_PROMPT_BYTES {
            return Err(Error::Invalid("prompt must be 1–65536 bytes"));
        }
        let id = self
            .request(
                "session/prompt",
                json!({"sessionId":session_id,"prompt":[{"type":"text","text":text}]}),
                Some(session_id),
            )
            .await?;
        self.cancelled_turns.remove(session_id);
        self.active_turns.insert(session_id.to_owned());
        Ok(id)
    }

    /// Cancellation is a notification. Wait for the prompt response to confirm it.
    pub async fn cancel(&mut self, session_id: &str) -> Result<()> {
        self.ready()?;
        if !self.active_turns.contains(session_id) {
            return Err(Error::Invalid("session has no active turn"));
        }
        self.write(
            json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":session_id}}),
        )
        .await?;
        self.cancelled_turns.insert(session_id.to_owned());
        let ids: Vec<_> = self
            .permissions
            .iter()
            .filter(|(_, p)| p.session_id == session_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            self.respond_permission(&id, None).await?;
        }
        Ok(())
    }

    /// `None` cancels the request; an option must exactly match a pending offer.
    pub async fn respond_permission(&mut self, id: &RpcId, option_id: Option<&str>) -> Result<()> {
        self.ready()?;
        let request = self
            .permissions
            .get(id)
            .ok_or(Error::Invalid("permission request is no longer pending"))?;
        let outcome = match option_id {
            Some(option) => {
                if self.cancelled_turns.contains(&request.session_id)
                    || !request.options.iter().any(|o| o.option_id == option)
                {
                    return Err(Error::Invalid("permission option is not available"));
                }
                json!({"outcome":"selected","optionId":option})
            }
            None => json!({"outcome":"cancelled"}),
        };
        self.write(json!({"jsonrpc":"2.0","id":id,"result":{"outcome":outcome}}))
            .await?;
        self.permissions.remove(id);
        Ok(())
    }

    /// Bounded, cancellation-safe line reading: partial input stays in `frame`.
    /// Protocol/transport errors poison the connection instead of retrying writes.
    pub async fn next_event(&mut self) -> Result<Event> {
        if self.closed {
            return Err(Error::Closed);
        }
        let result = self.read_event().await;
        if result.is_err() {
            self.closed = true;
            self.permissions.clear();
        }
        result
    }

    async fn read_event(&mut self) -> Result<Event> {
        loop {
            let buf = self.reader.fill_buf().await?;
            if buf.is_empty() {
                return Err(Error::Closed);
            }
            let end = buf.iter().position(|b| *b == b'\n');
            let count = end.map_or(buf.len(), |i| i + 1);
            if self.frame.len() + count > MAX_FRAME_BYTES {
                return Err(Error::Protocol("frame exceeds limit"));
            }
            self.frame.extend_from_slice(&buf[..count]);
            self.reader.consume(count);
            if end.is_some() {
                break;
            }
        }
        let value: Value = serde_json::from_slice(&self.frame)?;
        self.frame.clear();
        if value.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            return Err(Error::Protocol("expected JSON-RPC 2.0 object"));
        }
        if let Some(method) = value.get("method") {
            let method = method
                .as_str()
                .ok_or(Error::Protocol("invalid method"))?
                .to_owned();
            if value.get("result").is_some() || value.get("error").is_some() {
                return Err(Error::Protocol("request contains response fields"));
            }
            let params = value.get("params").cloned().unwrap_or_else(|| json!({}));
            if let Some(id) = value.get("id") {
                let id: RpcId = serde_json::from_value(id.clone())?;
                if method == "session/request_permission" {
                    return self.permission_event(id, params).await;
                }
                self.write(json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Unsupported client method"}})).await?;
                return Ok(Event::UnsupportedRequest { id, method });
            }
            if method == "session/update" {
                let session_id = params
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .ok_or(Error::Protocol("missing update sessionId"))?
                    .to_owned();
                let update = params
                    .get("update")
                    .filter(|u| u.get("sessionUpdate").is_some_and(Value::is_string))
                    .ok_or(Error::Protocol("invalid session update"))?
                    .clone();
                if !self.sessions.contains(&session_id)
                    && !self.pending.values().any(|p| {
                        p.method == "session/load" && p.session_id.as_deref() == Some(&session_id)
                    })
                {
                    return Err(Error::Protocol("update for unattached session"));
                }
                return Ok(Event::SessionUpdate { session_id, update });
            }
            return Ok(Event::Notification { method, params });
        }
        let id: RpcId = serde_json::from_value(
            value
                .get("id")
                .ok_or(Error::Protocol("response missing id"))?
                .clone(),
        )?;
        let pending = self
            .pending
            .remove(&id)
            .ok_or(Error::Protocol("response id is not pending"))?;
        let result = match (value.get("result"), value.get("error")) {
            (Some(result), None) => Ok(result.clone()),
            (None, Some(error)) => Err(serde_json::from_value::<RpcError>(error.clone())?),
            _ => return Err(Error::Protocol("response must contain result or error")),
        };
        if pending.method == "session/prompt"
            && let Some(session_id) = pending.session_id.as_deref()
        {
            self.active_turns.remove(session_id);
            // Reject stale approvals even if an agent finishes before the UI responds.
            let ids: Vec<_> = self
                .permissions
                .iter()
                .filter(|(_, p)| p.session_id == session_id)
                .map(|(id, _)| id.clone())
                .collect();
            for id in ids {
                self.respond_permission(&id, None).await?;
            }
        }
        if let Ok(ref result) = result {
            match pending.method {
                "initialize" => self.compatibility = Some(Compatibility::from_initialize(result)?),
                "session/new" => {
                    let session_id = result
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .ok_or(Error::Protocol("new session missing id"))?;
                    validate_id(session_id)?;
                    self.sessions.insert(session_id.to_owned());
                }
                "session/load" | "session/resume" => {
                    if let Some(session_id) = pending.session_id {
                        self.sessions.insert(session_id);
                    }
                }
                _ => {}
            }
        }
        Ok(Event::Response {
            id,
            method: pending.method.to_owned(),
            result,
        })
    }

    async fn permission_event(&mut self, id: RpcId, params: Value) -> Result<Event> {
        self.ready()?;
        let request: PermissionRequest = serde_json::from_value(params)?;
        if !request
            .tool_call
            .get("toolCallId")
            .is_some_and(Value::is_string)
            || request.options.is_empty()
        {
            return Err(Error::Protocol("invalid permission request"));
        }
        let mut options = HashSet::new();
        for option in &request.options {
            if option.option_id.is_empty() || !options.insert(&option.option_id) {
                return Err(Error::Protocol("invalid permission options"));
            }
        }
        if self.permissions.contains_key(&id) || self.permissions.len() >= MAX_PENDING {
            return Err(Error::Protocol("duplicate or too many permission requests"));
        }
        if !self.active_turns.contains(&request.session_id)
            || self.cancelled_turns.contains(&request.session_id)
        {
            self.write(
                json!({"jsonrpc":"2.0","id":id,"result":{"outcome":{"outcome":"cancelled"}}}),
            )
            .await?;
            return Ok(Event::PermissionCancelled {
                id,
                session_id: request.session_id,
            });
        }
        self.permissions.insert(id.clone(), request.clone());
        Ok(Event::Permission { id, request })
    }

    fn ready(&self) -> Result<&Compatibility> {
        if self.closed {
            return Err(Error::Closed);
        }
        self.compatibility
            .as_ref()
            .ok_or(Error::Invalid("initialize has not succeeded"))
    }

    async fn request(
        &mut self,
        method: &'static str,
        params: Value,
        session_id: Option<&str>,
    ) -> Result<RpcId> {
        if self.closed {
            return Err(Error::Closed);
        }
        if self.pending.len() >= MAX_PENDING {
            return Err(Error::Invalid("too many outstanding requests"));
        }
        let id = RpcId::Number(self.next_id);
        self.next_id = self
            .next_id
            .checked_add(1)
            .ok_or(Error::Protocol("request id exhausted"))?;
        self.write(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .await?;
        self.pending.insert(
            id.clone(),
            Pending {
                method,
                session_id: session_id.map(str::to_owned),
            },
        );
        Ok(id)
    }

    async fn write(&mut self, value: Value) -> Result<()> {
        if self.closed {
            return Err(Error::Closed);
        }
        let mut bytes = serde_json::to_vec(&value)?;
        bytes.push(b'\n');
        if bytes.len() > MAX_FRAME_BYTES {
            return Err(Error::Invalid("outgoing frame exceeds limit"));
        }
        // Set before awaiting: a cancelled/partial write cannot be retried safely.
        self.closed = true;
        self.writer.write_all(&bytes).await?;
        self.writer.flush().await?;
        self.closed = false;
        Ok(())
    }

    pub async fn shutdown(&mut self) -> Result<()> {
        self.closed = true;
        self.permissions.clear();
        let result = self.writer.shutdown().await;
        if let Some(child) = &mut self.child {
            child.kill().await?;
        }
        result?;
        Ok(())
    }
}

fn validate_id(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 4096 {
        return Err(Error::Invalid("invalid session id"));
    }
    Ok(())
}

fn absolute_path(path: &Path) -> Result<&str> {
    if !path.is_absolute() {
        return Err(Error::Invalid("cwd must be absolute"));
    }
    path.to_str().ok_or(Error::Invalid("cwd must be UTF-8"))
}
