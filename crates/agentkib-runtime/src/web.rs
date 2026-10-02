//! Trusted-host entry point. Browser authentication is performed by the Electron HTTP host;
//! this layer independently restricts operations, source identity and control freshness.
use super::*;
use agentkib_remote::Source;

// The Electron Web host waits 20 seconds for one runtime request. Keep session
// discovery and native attachment within a single budget, leaving reply time.
const ANTIGRAVITY_LIVE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

pub(super) struct Worker {
    sender: Option<mpsc::SyncSender<RpcRequest>>,
    pending: Arc<AtomicU64>,
    handle: Option<std::thread::JoinHandle<()>>,
}
impl Worker {
    pub fn new(events: Sender<RuntimeEvent>) -> Self {
        let (sender, receiver) = mpsc::sync_channel::<RpcRequest>(32);
        let pending = Arc::new(AtomicU64::new(0));
        let finished = pending.clone();
        let handle = std::thread::spawn(move || {
            let mut service = Service::default();
            while let Ok(request) = receiver.recv() {
                let result = if request.method == agentkib_protocol::CONTROL_RECEIPT_METHOD {
                    service
                        .managed
                        .receipt(request.params)
                        .and_then(|receipt| service.claude_managed.receipt(receipt, &service.boot))
                } else if request.method == agentkib_protocol::CLAUDE_MANAGED_METHOD {
                    service
                        .claude_managed
                        .request(request.params, &service.boot, true)
                } else if request.method == agentkib_protocol::CODEX_MANAGED_METHOD {
                    service.managed.request(request.params, &service.boot, true)
                } else {
                    service.request(request.params)
                };
                finished.fetch_sub(1, Ordering::SeqCst);
                let _ = events.send(RuntimeEvent::RemoteFinished {
                    request_id: request.id,
                    result: Box::new(result),
                });
            }
        });
        Self {
            sender: Some(sender),
            pending,
            handle: Some(handle),
        }
    }
    pub fn submit(&self, request: RpcRequest) -> Option<RpcResponse> {
        let id = request.id.clone();
        // Opening a page starts history, live and SSE reads together. Bound and serialize
        // those reads; mutations must still acquire an entirely idle worker, never queue.
        let read = request.method == agentkib_protocol::CONTROL_RECEIPT_METHOD
            || matches!(
                request.params["operation"].as_str(),
                Some(
                    "catalog"
                        | "options"
                        | "events"
                        | "live"
                        | "capabilities"
                        | "inspect"
                        | "context"
                        | "queue-list"
                        | "settings-state"
                        | "usage"
                        | "goal"
                        | "resources"
                )
            );
        let mut pending = self.pending.load(Ordering::SeqCst);
        let claimed = loop {
            if !((read && pending < 32) || pending == 0) {
                break false;
            }
            match self.pending.compare_exchange_weak(
                pending,
                pending + 1,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => break true,
                Err(current) => pending = current,
            }
        };
        if !claimed {
            return Some(RpcResponse::error(id, -32000, "web-busy", None));
        }
        if self
            .sender
            .as_ref()
            .is_none_or(|sender| sender.try_send(request).is_err())
        {
            self.pending.fetch_sub(1, Ordering::SeqCst);
            return Some(RpcResponse::error(id, -32000, "web-unavailable", None));
        }
        None
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.sender.take();
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

#[derive(Deserialize)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    operation: String,
    session_id: Option<String>,
    cursor: Option<String>,
    limit: Option<usize>,
    request_id: Option<String>,
    device_id: Option<String>,
    expected_revision: Option<u64>,
    runtime_boot_id: Option<String>,
    text: Option<String>,
    input: Option<Value>,
    resource_refs: Option<Vec<Value>>,
    model: Option<String>,
    effort: Option<String>,
    mode: Option<String>,
    service_tier: Option<String>,
    policy_id: Option<String>,
    #[serde(default)]
    reset_defaults: bool,
    turn_id: Option<String>,
    approval_id: Option<Value>,
    question_id: Option<Value>,
    answers: Option<Value>,
    decision: Option<String>,
    #[serde(default)]
    experimental_enabled: bool,
}

#[cfg(any(target_os = "macos", test))]
fn codex_stop_enabled(
    controls: bool,
    status: agentkib_codex_bridge::Status,
    active_turn: Option<&str>,
) -> bool {
    controls
        && active_turn.is_some()
        && matches!(
            status,
            agentkib_codex_bridge::Status::Running
                | agentkib_codex_bridge::Status::AwaitingApproval
        )
}

#[cfg(any(target_os = "macos", test))]
fn follower_thread_settings(
    request: &Request,
    workspace: &Path,
    current: &Value,
) -> anyhow::Result<Value> {
    anyhow::ensure!(
        request.model.is_none() && request.effort.is_none() && request.service_tier.is_none(),
        "follower-model-catalog-unavailable"
    );
    let mut settings = json!({});
    if let Some(mode) = request.mode.as_deref() {
        anyhow::ensure!(matches!(mode, "default" | "plan"), "invalid-mode");
        let model = current["model"]
            .as_str()
            .context("model-required-for-mode")?;
        let effort = current["effort"].as_str();
        // The owner applies these as one settings change. Keep its top-level
        // selection and collaboration-mode selection identical, using only the
        // current native values (not browser-provided model strings).
        settings["model"] = json!(model);
        settings["effort"] = json!(effort);
        settings["collaborationMode"] = json!({"mode":mode,"settings":{"model":model,"reasoning_effort":effort,"developer_instructions":null}});
    }
    if let Some(policy) = request.policy_id.as_deref() {
        match policy {
            "workspace-write-on-request" => {
                settings["approvalPolicy"] = json!("on-request");
                settings["approvalsReviewer"] = json!("user");
                settings["sandboxPolicy"] = json!({"type":"workspaceWrite","writableRoots":[workspace],"networkAccess":false});
            }
            "full-access-on-request" => {
                settings["approvalPolicy"] = json!("never");
                settings["approvalsReviewer"] = json!("user");
                settings["sandboxPolicy"] = json!({"type":"dangerFullAccess"});
            }
            "workspace-write-auto-review" => {
                settings["approvalPolicy"] = json!("on-request");
                settings["approvalsReviewer"] = json!("auto_review");
                settings["sandboxPolicy"] = json!({"type":"workspaceWrite","writableRoots":[workspace],"networkAccess":false});
            }
            _ => anyhow::bail!("unsupported-policy"),
        }
    }
    anyhow::ensure!(
        settings.as_object().is_some_and(|value| !value.is_empty()),
        "empty-settings"
    );
    Ok(settings)
}

struct Service {
    managed: crate::codex_managed::Service,
    claude_managed: crate::claude_managed::Service,
    boot: String,
    used: BTreeSet<String>,
    // Independent of the bridge cache: reconnect/eviction must not turn a lost
    // control acknowledgement into permission to submit a second operation.
    unresolved: BTreeSet<String>,
    claude: BTreeMap<String, crate::claude_runner::Runner>,
    claude_identity: BTreeMap<String, (PathBuf, String)>,
    claude_targets: BTreeMap<String, agentkib_conversations::VerifiedClaudeControlTarget>,
    claude_target_retry: BTreeMap<String, std::time::Instant>,
    claude_available: InstallationProbe,
    antigravity: BTreeMap<String, crate::antigravity_runner::Runner>,
    antigravity_targets: BTreeMap<String, (String, PathBuf)>,
    antigravity_target_retry: BTreeMap<String, std::time::Instant>,
    antigravity_available: InstallationProbe,
    #[cfg(target_os = "macos")]
    bridges: BTreeMap<String, agentkib_codex_bridge::Bridge>,
    #[cfg(target_os = "macos")]
    recency: Vec<String>,
}
impl Default for Service {
    fn default() -> Self {
        Self {
            managed: crate::codex_managed::Service::default(),
            claude_managed: crate::claude_managed::Service::default(),
            boot: uuid::Uuid::new_v4().to_string(),
            used: BTreeSet::new(),
            unresolved: BTreeSet::new(),
            claude: BTreeMap::new(),
            claude_identity: BTreeMap::new(),
            claude_targets: BTreeMap::new(),
            claude_target_retry: BTreeMap::new(),
            claude_available: InstallationProbe::default(),
            antigravity: BTreeMap::new(),
            antigravity_targets: BTreeMap::new(),
            antigravity_target_retry: BTreeMap::new(),
            antigravity_available: InstallationProbe::default(),
            #[cfg(target_os = "macos")]
            bridges: BTreeMap::new(),
            #[cfg(target_os = "macos")]
            recency: Vec::new(),
        }
    }
}
impl Service {
    fn follower_settings_state(&self, id: &str) -> Value {
        #[cfg(target_os = "macos")]
        {
            self.bridges
                .get(id)
                .map(|bridge| bridge.thread_settings())
                .unwrap_or_else(|| {
                    json!({"available":false,"executionMode":"codex-follower","reason":"open-in-original-client"})
                })
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = id;
            json!({"available":false,"executionMode":"codex-follower","reason":"platform-unsupported"})
        }
    }

    fn follower_settings_capability(&self, id: &str, live: &Value) -> Value {
        #[cfg(target_os = "macos")]
        {
            if self
                .bridges
                .get(id)
                .is_some_and(|bridge| bridge.supports_thread_settings())
                && live["status"] == "idle"
            {
                json!({"available":true})
            } else {
                json!({"available":false,"reason":"follower-operation-unverified"})
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (id, live);
            json!({"available":false,"reason":"platform-unsupported"})
        }
    }

    fn request(&mut self, value: Value) -> anyhow::Result<Value> {
        if let Some(id) = value["sessionId"].as_str()
            && self.claude_managed.is_claude(id)?
            && (self.claude_managed.has_metadata(id)? || value["operation"] != "events")
            && value["operation"] != "diff"
        {
            return self.claude_managed.request(value, &self.boot, false);
        }

        if matches!(
            value["operation"].as_str(),
            Some(
                "capabilities"
                    | "inspect"
                    | "context"
                    | "settings-state"
                    | "usage"
                    | "goal"
                    | "resources"
            )
        ) {
            let id = value["sessionId"].as_str().context("missing-session")?;
            return match value["operation"].as_str().unwrap() {
                "context" => self.managed.context(id),
                operation @ ("settings-state" | "usage" | "goal" | "resources") => {
                    if self.managed.owns(id)? {
                        self.managed.read_extended(id, operation, &self.boot)
                    } else if operation == "settings-state" {
                        let mut live = value.clone();
                        live["operation"] = json!("live");
                        self.request_inner(live)?;
                        Ok(self.follower_settings_state(id))
                    } else {
                        Ok(
                            json!({"available":false,"executionMode":"codex-follower","reason":"follower-operation-unverified"}),
                        )
                    }
                }
                "capabilities" => {
                    let mut caps = self.managed.capabilities(
                        id,
                        &self.boot,
                        value["experimentalEnabled"] == true,
                    )?;
                    if caps["executionMode"] == "codex-follower" {
                        let mut live_request = value.clone();
                        live_request["operation"] = json!("live");
                        if let Ok(live) = self.request_inner(live_request) {
                            caps["status"] = live["status"].clone();
                            caps["reason"] = live["reason"].clone();
                            for (op, enabled) in [
                                ("send", live["sendEnabled"] == true),
                                ("stop", live["stopEnabled"] == true),
                                (
                                    "approve",
                                    live["approvals"]
                                        .as_array()
                                        .is_some_and(|a| a.iter().any(|x| x["supported"] == true)),
                                ),
                                (
                                    "answer",
                                    live["questions"]
                                        .as_array()
                                        .is_some_and(|a| a.iter().any(|x| x["supported"] == true)),
                                ),
                            ] {
                                caps["features"][op] = if enabled {
                                    json!({"available":true})
                                } else {
                                    json!({"available":false,"reason":"session-state-unavailable"})
                                };
                            }
                            caps["features"]["settings"] =
                                self.follower_settings_capability(id, &live);
                        }
                    }
                    Ok(caps)
                }
                _ => {
                    let result = self.managed.inspect(id, &self.boot)?;
                    if result["reconciled"] == true {
                        self.unresolved.remove(id);
                    }
                    Ok(result)
                }
            };
        }
        if value["operation"] == "resume" {
            return self.managed.request(value, &self.boot, false);
        }
        // Managed controls already use this same durable ledger. Follower controls
        // are wrapped before any native discovery/preflight can dispatch a write.
        if let Some(id) = value["sessionId"].as_str() {
            if self.managed.owns(id)? {
                return self.managed.request(value, &self.boot, false);
            }
            if matches!(
                value["operation"].as_str(),
                Some("send" | "stop" | "approve" | "answer" | "settings")
            ) {
                let store = Store::open_default()?;
                if let Some(session) = store.get_conversation_session(id)?
                    && session.agent == AgentKind::Codex
                {
                    use sha2::Digest;
                    let request: Request = serde_json::from_value(value.clone())?;
                    crate::codex_managed::validate_device(request.device_id.as_deref())?;
                    let request_id = request
                        .request_id
                        .as_deref()
                        .context("invalid-request-id")?;
                    uuid::Uuid::parse_str(request_id).context("invalid-request-id")?;
                    let fingerprint =
                        format!("{:x}", sha2::Sha256::digest(serde_json::to_vec(&value)?));
                    let ledger = self.managed.ledger()?;
                    if let Some(previous) = ledger.claim(
                        request_id, id, &fingerprint, request.device_id.as_deref(),
                        &json!({"operation":request.operation,"workspaceId":session.workspace_id,"executionMode":"codex-follower","runtimeBootId":self.boot,"expectedRevision":request.expected_revision,"turnId":request.turn_id}),
                    )? {
                        return Ok(previous);
                    }
                    let outcome = self.request_inner(value);
                    if ledger.is_dispatched(request_id)? {
                        if let Ok(ack) = &outcome
                            && ack["accepted"] == true
                        {
                            ledger.finish(request_id, ack)?;
                        }
                        return outcome;
                    }
                    let ack = match outcome {
                        Ok(ack) => ack,
                        Err(_) => {
                            json!({"accepted":false,"completed":false,"controlOutcome":"not-dispatched","requestId":request_id,"runtimeBootId":self.boot,"error":"control_preflight_rejected"})
                        }
                    };
                    ledger.finish(request_id, &ack)?;
                    return Ok(ack);
                }
            }
        }
        self.request_inner(value)
    }
    fn request_inner(&mut self, value: Value) -> anyhow::Result<Value> {
        if value["operation"] == "diff" {
            return web_diff(value);
        }
        if value["operation"] == "context" {
            let request: Request = serde_json::from_value(value)?;
            let id = request.session_id.as_deref().context("missing-session")?;
            return self.managed.context(id);
        }
        if let Some(id) = value["sessionId"].as_str()
            && self.managed.owns(id)?
        {
            return self.managed.request(value, &self.boot, false);
        }
        let request: Request = serde_json::from_value(value)?;
        // Reject known-invalid input before claiming a request or installing a
        // control fence. The bridge shares this exact UTF-8 byte validation.
        if request.operation == "send" {
            crate::codex_managed::normalize_input(
                request.input.as_ref(),
                request.text.as_deref(),
                request.resource_refs.as_deref(),
            )?;
        }
        anyhow::ensure!(
            matches!(
                request.operation.as_str(),
                "catalog" | "events" | "live" | "send" | "stop" | "approve" | "answer" | "settings"
            ),
            "web-operation-unsupported"
        );
        let source = RemoteSessionSource {
            data_dir: agentkib_store::default_data_dir()?,
        };
        if request.operation == "catalog" {
            let mut catalog = web_catalog(&source)?;
            let mut managed = self.managed.catalog()?;
            managed.extend(self.claude_managed.catalog()?);
            let mut indexed_aliases = self.managed.indexed_aliases()?;
            indexed_aliases.extend(self.claude_managed.indexed_aliases()?);
            if !managed.is_empty() {
                let store = Store::open_default()?;
                let managed_workspaces: BTreeSet<_> = managed
                    .iter()
                    .filter_map(|s| s["workspace_id"].as_str())
                    .collect();
                if let Some(workspaces) = catalog["workspaces"].as_array_mut() {
                    for workspace in store.list_workspaces()? {
                        if managed_workspaces.contains(workspace.id.as_str())
                            && !workspaces.iter().any(|w| w["id"] == workspace.id)
                        {
                            workspaces.push(json!({"id":workspace.id,"name":workspace.name,"path":workspace.path}));
                        }
                    }
                }
                catalog["indexEnabled"] = json!(true);
            }
            if let Some(sessions) = catalog["sessions"].as_array_mut() {
                let ids: BTreeSet<_> = managed.iter().filter_map(|s| s["id"].as_str()).collect();
                sessions.retain(|s| {
                    !s["id"]
                        .as_str()
                        .is_some_and(|id| ids.contains(id) || indexed_aliases.contains(id))
                });
                sessions.extend(managed);
            }
            return Ok(catalog);
        }
        let epoch = source.availability_epoch()?;
        let id = request
            .session_id
            .as_deref()
            .filter(|id| !id.is_empty() && id.len() <= 256)
            .context("invalid-session")?;
        if request.operation == "events" {
            return source.events(id, request.cursor.as_deref(), request.limit.unwrap_or(50));
        }
        // Validate registry even for live state; no caller-supplied filesystem or native UUID.
        let store = Store::open_default()?;
        let session = store
            .get_conversation_session(id)?
            .context("session-unavailable")?;
        let workspace = store.workspace_path(&session.workspace_id)?;
        if self.unresolved.contains(id) || self.managed.has_unconfirmed(id)? {
            anyhow::ensure!(request.operation == "live", "control-outcome-unconfirmed");
            return Ok(json!({"sessionId":id,"runtimeBootId":self.boot,
                "status":"outcome-unknown","revision":null,"turnId":null,
                "sendEnabled":false,"approvals":[],"reason":"control-outcome-unconfirmed"}));
        }
        if request.operation != "live" {
            self.claim(&request)?;
        }
        if session.agent == AgentKind::ClaudeCode {
            if !cfg!(target_os = "macos") {
                return self.unsupported(&request, "platform-unsupported");
            }
            if !self.claude_available.supported(
                std::time::Instant::now(),
                crate::claude_runner::Runner::installation_supported,
            ) {
                return self.unsupported(&request, "unverified-installation");
            }
            anyhow::ensure!(!session.sidechain, "auxiliary-session-not-controllable");
            // Mutations resolve current provider metadata as well; only the hot
            // read-only polling path may reuse the target's discovery result.
            let target = cached_target(
                &mut self.claude_targets,
                &mut self.claude_target_retry,
                id,
                std::time::Instant::now(),
                request.operation != "live",
                || {
                    let adapter =
                        provider(session.agent, &workspace).context("provider-unavailable")?;
                    let native = adapter
                        .list_sessions(&workspace)?
                        .into_iter()
                        .find(|candidate| {
                            store
                                .conversation_id(session.agent, &candidate.native_ref)
                                .is_ok_and(|found| found == id)
                        })
                        .context("session-unavailable")?;
                    adapter
                        .verified_claude_control_target(&native.native_ref)?
                        .context("unverified-session-identity")
                },
                |target| target.revalidate(),
            )?;
            // Polling an existing target never rediscovers every Claude project.
            // Reopen its bounded metadata on every request to reject deletion or
            // replacement with another session, workspace or auxiliary transcript.
            let uuid = target.session_id.clone();
            let cwd = target.workspace.clone();
            anyhow::ensure!(
                cwd.starts_with(fs::canonicalize(&workspace)?),
                "session-workspace-mismatch"
            );
            if let Some(previous) = self.claude_identity.get(id) {
                anyhow::ensure!(
                    previous == &(cwd.clone(), uuid.clone()),
                    "session-identity-changed"
                );
            }
            if request.operation == "live" && !self.claude.contains_key(id) {
                validate_session_access(&source, epoch, &store, &session, &workspace)?;
                return Ok(json!({"sessionId":id,"runtimeBootId":self.boot,
                    "executionMode":"managed-resume","status":"idle","revision":0,
                    "turnId":null,"approvals":[],"streamText":"",
                    "sendEnabled":request.experimental_enabled}));
            }
            if request.operation == "send" {
                self.reserve_claude_worker(id)?;
            }
            if !self.claude.contains_key(id) {
                self.claude_identity
                    .insert(id.to_owned(), (cwd.clone(), uuid.clone()));
                self.claude
                    .insert(id.to_owned(), crate::claude_runner::Runner::new(cwd, uuid));
            }
            let runner = self
                .claude
                .get_mut(id)
                .context("managed-session-unavailable")?;
            validate_session_access(&source, epoch, &store, &session, &workspace)?;
            if request.operation == "live" {
                let mut state = runner.snapshot();
                state["executionMode"] = json!("managed-resume");
                state["sessionId"] = json!(id);
                state["runtimeBootId"] = json!(self.boot);
                if !request.experimental_enabled {
                    state["sendEnabled"] = json!(false);
                    if let Some(questions) = state["questions"].as_array_mut() {
                        for question in questions {
                            question["supported"] = json!(false);
                        }
                    }
                    if let Some(approvals) = state["approvals"].as_array_mut() {
                        for approval in approvals {
                            approval["supported"] = json!(false);
                        }
                    }
                }
                return Ok(state);
            }
            let revision = request.expected_revision.context("missing-revision")?;
            // Runner errors are preflight/enqueue failures. After acceptance,
            // asynchronous write errors remain fenced in the runner snapshot.
            let outcome = if request.operation == "send" {
                runner.send(request.text.as_deref().context("missing-text")?, revision)
            } else if request.operation == "stop" {
                runner.stop(
                    request.turn_id.as_deref().context("missing-turn")?,
                    revision,
                )
            } else if request.operation == "answer" {
                runner.answer(
                    request.question_id.as_ref().context("missing-question")?,
                    request.turn_id.as_deref().context("missing-turn")?,
                    request.answers.as_ref().context("missing-answers")?,
                    revision,
                )
            } else {
                runner.approve(
                    request.approval_id.as_ref().context("missing-approval")?,
                    request.turn_id.as_deref().context("missing-turn")?,
                    request.decision.as_deref().context("missing-decision")?,
                    revision,
                )
            };
            return control_response(&request, &self.boot, outcome.is_ok(), outcome);
        }
        if session.agent == AgentKind::Antigravity {
            let deadline = std::time::Instant::now() + ANTIGRAVITY_LIVE_TIMEOUT;
            let mut dispatched = false;
            let outcome = (|| -> anyhow::Result<Value> {
                if !request.experimental_enabled {
                    return self.unsupported(&request, "control-disabled");
                }
                if !self.antigravity_available.supported(
                    std::time::Instant::now(),
                    crate::antigravity_runner::installation_supported,
                ) {
                    return self.unsupported(&request, "unverified-installation");
                }
                anyhow::ensure!(!session.sidechain, "auxiliary-session-not-controllable");
                let canonical_workspace = fs::canonicalize(&workspace)?;
                let target = cached_target(
                    &mut self.antigravity_targets,
                    &mut self.antigravity_target_retry,
                    id,
                    std::time::Instant::now(),
                    request.operation != "live",
                    || {
                        let native = agentkib_conversations::AntigravityProvider::default()
                            .list_sessions_until(&canonical_workspace, deadline)?
                            .into_iter()
                            .find(|candidate| {
                                store
                                    .conversation_id(session.agent, &candidate.native_ref)
                                    .is_ok_and(|found| found == id)
                            })
                            .context("session-unavailable")?;
                        Ok((native.native_ref, canonical_workspace.clone()))
                    },
                    |target| {
                        anyhow::ensure!(
                            target.1 == canonical_workspace,
                            "session-workspace-mismatch"
                        );
                        Ok(())
                    },
                )?;
                let native_id = target.0.clone();
                if self.reserve_antigravity_runner(id).is_err() {
                    return self.unsupported(&request, "live-session-limit");
                }
                if !self.antigravity.contains_key(id) {
                    validate_session_access(&source, epoch, &store, &session, &workspace)?;
                    let runner = match crate::antigravity_runner::Runner::connect_until(
                        canonical_workspace,
                        native_id,
                        deadline,
                    ) {
                        Ok(runner) => runner,
                        Err(error) if error.to_string() == "unverified-installation" => {
                            return self.unsupported(&request, "unverified-installation");
                        }
                        Err(_) => return self.unsupported(&request, "open-in-original-client"),
                    };
                    self.antigravity.insert(id.to_owned(), runner);
                }
                validate_session_access(&source, epoch, &store, &session, &workspace)?;
                if request.operation == "live" {
                    let mut state = self.antigravity_live_snapshot(id)?;
                    state["sessionId"] = json!(id);
                    state["runtimeBootId"] = json!(self.boot);
                    return Ok(state);
                }
                let runner = self
                    .antigravity
                    .get(id)
                    .context("managed-session-unavailable")?;
                let revision = request.expected_revision.context("missing-revision")?;
                let outcome = if request.operation == "send" {
                    runner.send(request.text.as_deref().context("missing-text")?, revision)
                } else if request.operation == "stop" {
                    runner.stop(
                        request.turn_id.as_deref().context("missing-turn")?,
                        revision,
                    )
                } else if request.operation == "approve" {
                    runner.approve(
                        request.approval_id.as_ref().context("missing-approval")?,
                        request.turn_id.as_deref().context("missing-turn")?,
                        request.decision.as_deref().context("missing-decision")?,
                        revision,
                    )
                } else {
                    anyhow::bail!("control-unavailable")
                };
                // A transport error can happen after the ACP request has reached the
                // server. Runner fences that case as outcome-unknown; propagate it as
                // dispatched so the Electron host does not clear its durable fence.
                dispatched = antigravity_control_dispatched(runner, &outcome);
                control_response(&request, &self.boot, dispatched, outcome.map(|_| ()))
            })();
            return control_attempt_response(&request, &self.boot, dispatched, outcome);
        }
        #[cfg(target_os = "macos")]
        {
            let mut dispatched = false;
            let outcome = (|| -> anyhow::Result<Value> {
                if session.agent != AgentKind::Codex {
                    return self.unsupported(&request, "provider-unsupported");
                }
                let native = provider(session.agent, &workspace)
                    .context("provider-unavailable")?
                    .list_sessions(&workspace)?
                    .into_iter()
                    .find(|candidate| {
                        store
                            .conversation_id(session.agent, &candidate.native_ref)
                            .is_ok_and(|found| found == id)
                    })
                    .context("session-unavailable")?;
                let uuid = match provider(session.agent, &workspace)
                    .context("provider-unavailable")?
                    .verified_control_id(&native.native_ref)
                {
                    Ok(Some(id)) => id,
                    _ => return self.unsupported(&request, "unverified-session-identity"),
                };
                if !self.bridges.contains_key(id) {
                    if self.bridges.len() >= 8 {
                        // Revalidate a cached idle snapshot before eviction. Never discard a running,
                        // pending-approval or unresolved-outcome bridge to make room for another tab.
                        let candidates = idle_candidates(
                            &self.recency,
                            self.bridges.iter().map(|(id, bridge)| {
                                (
                                    id.as_str(),
                                    bridge.state().is_some_and(|state| {
                                        state.status() == agentkib_codex_bridge::Status::Idle
                                            && state.approvals().is_empty()
                                    }),
                                )
                            }),
                        );
                        let mut removed = false;
                        for candidate in candidates {
                            let Some(bridge) = self.bridges.get_mut(&candidate) else {
                                continue;
                            };
                            if bridge.refresh().is_ok()
                                && bridge.state().is_some_and(|state| {
                                    state.status() == agentkib_codex_bridge::Status::Idle
                                        && state.approvals().is_empty()
                                })
                            {
                                self.bridges.remove(&candidate);
                                self.recency.retain(|id| id != &candidate);
                                removed = true;
                                break;
                            }
                        }
                        if !removed {
                            return self.unsupported(&request, "live-session-busy");
                        }
                    }
                    let socket = codex_home().join("ipc/ipc.sock");
                    let connected = agentkib_codex_bridge::Bridge::connect_installed(&socket)
                        .and_then(|mut bridge| {
                            bridge.select(&uuid)?;
                            Ok(bridge)
                        });
                    match connected {
                        Ok(bridge) => {
                            self.bridges.insert(id.into(), bridge);
                        }
                        Err(_) => return self.unsupported(&request, "open-in-original-client"),
                    }
                }
                self.recency.retain(|entry| entry != id);
                self.recency.push(id.into());
                let command_ledger = if request.operation != "live" {
                    Some(self.managed.ledger()?)
                } else {
                    None
                };
                let bridge = self.bridges.get_mut(id).context("live-unavailable")?;
                if bridge
                    .state()
                    .is_none_or(|state| state.conversation_id() != uuid)
                {
                    self.bridges.remove(id);
                    self.recency.retain(|entry| entry != id);
                    return self.unsupported(&request, "session-identity-changed");
                }
                if (if request.operation == "live" {
                    bridge.observe_live()
                } else {
                    bridge.refresh()
                })
                .is_err()
                {
                    self.bridges.remove(id);
                    self.recency.retain(|entry| entry != id);
                    return self.unsupported(&request, "open-in-original-client");
                }
                let controls = request.experimental_enabled && bridge.enable_controls().is_ok();
                if !controls {
                    bridge.disable_controls();
                }
                let state = bridge.state().context("state-unavailable")?;
                if request.operation == "live" {
                    let questions: Vec<_> = state
                        .questions()
                        .into_iter()
                        .map(|mut q| {
                            if !controls {
                                q["supported"] = json!(false);
                            }
                            q
                        })
                        .collect();
                    let approvals: Vec<_> = state
                        .approvals()
                        .into_iter()
                        .map(|approval| safe_approval(approval, controls))
                        .collect();
                    let status = if !questions.is_empty() {
                        json!("waiting-input")
                    } else {
                        json!(state.status())
                    };
                    validate_session_access(&source, epoch, &store, &session, &workspace)?;
                    return Ok(
                        json!({"sessionId":id,"runtimeBootId":self.boot,"executionMode":"codex-follower","status":status,"revision":state.revision(),"turnId":state.active_turn(),"sendEnabled":controls && state.status()==agentkib_codex_bridge::Status::Idle,"stopEnabled":codex_stop_enabled(controls,state.status(),state.active_turn()),"approvals":approvals,"questions":questions}),
                    );
                }
                anyhow::ensure!(
                    controls
                        && request.expected_revision.is_some()
                        && request.expected_revision == state.revision(),
                    "stale-or-disabled-control"
                );
                let authorize = || {
                    validate_session_access(&source, epoch, &store, &session, &workspace)?;
                    // This fallible hook runs immediately before the bridge writes.
                    // If persistence fails, zero request bytes may be sent.
                    command_ledger
                        .as_ref()
                        .context("control-ledger-unavailable")?
                        .dispatch(
                            request
                                .request_id
                                .as_deref()
                                .context("invalid-request-id")?,
                        )
                };
                let dispatch = || {
                    dispatched = true;
                    self.unresolved.insert(id.to_owned());
                };
                let outcome = if request.operation == "send" {
                    let input = crate::codex_managed::normalize_input(
                        request.input.as_ref(),
                        request.text.as_deref(),
                        request.resource_refs.as_deref(),
                    )?;
                    bridge.send_input_at_revision_with_authorization(
                        &input,
                        request
                            .request_id
                            .as_deref()
                            .context("invalid-request-id")?,
                        request.expected_revision,
                        authorize,
                        dispatch,
                    )
                } else if request.operation == "stop" {
                    bridge.stop_at_revision_with_authorization(
                        request.turn_id.as_deref().context("missing-turn")?,
                        request.expected_revision,
                        authorize,
                        dispatch,
                    )
                } else if request.operation == "answer" {
                    bridge.answer_at_revision_with_authorization(
                        request.question_id.as_ref().context("missing-question")?,
                        request.turn_id.as_deref().context("missing-turn")?,
                        request.answers.as_ref().context("missing-answers")?,
                        request.expected_revision,
                        authorize,
                        dispatch,
                    )
                } else if request.operation == "settings" {
                    anyhow::ensure!(!request.reset_defaults, "follower-defaults-unavailable");
                    let current = bridge.thread_settings()["settings"]["current"].clone();
                    let settings = follower_thread_settings(&request, &workspace, &current)?;
                    bridge.update_thread_settings_at_revision_with_authorization(
                        &settings,
                        request.expected_revision,
                        authorize,
                        dispatch,
                    )
                } else {
                    let approval_id = request.approval_id.as_ref().context("missing-approval")?;
                    let turn = request.turn_id.as_deref().context("missing-turn")?;
                    let approval = state
                        .approvals()
                        .into_iter()
                        .find(|a| &a.request_id == approval_id && a.turn_id == turn)
                        .context("approval-no-longer-pending")?;
                    let safe = safe_approval(approval, controls);
                    let decision = request.decision.as_deref().context("missing-decision")?;
                    anyhow::ensure!(
                        safe["supported"] == true
                            && safe["availableDecisions"]
                                .as_array()
                                .is_some_and(|list| list.contains(&json!(decision))),
                        "unsupported-approval"
                    );
                    let decision = match decision {
                        "accept" => agentkib_codex_bridge::Decision::Accept,
                        "decline" => agentkib_codex_bridge::Decision::Decline,
                        "cancel" => agentkib_codex_bridge::Decision::Cancel,
                        _ => anyhow::bail!("unsupported-decision"),
                    };
                    bridge.approve_at_revision_with_authorization(
                        approval_id,
                        turn,
                        decision,
                        request.expected_revision,
                        authorize,
                        dispatch,
                    )
                };
                // Only a matching acknowledgement clears a dispatched operation.
                // Final bridge preflight errors never installed the fence.
                if outcome.is_ok() {
                    self.unresolved.remove(id);
                }
                control_response(&request, &self.boot, dispatched, outcome)
            })();
            match outcome {
                Err(error) if request.operation != "live" && !dispatched => {
                    control_response(&request, &self.boot, false, Err(error))
                }
                result => result,
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (workspace, session, epoch);
            self.unsupported(&request, "platform-unsupported")
        }
    }
    fn claim(&mut self, request: &Request) -> anyhow::Result<()> {
        anyhow::ensure!(
            request
                .session_id
                .as_ref()
                .is_none_or(|id| !self.unresolved.contains(id)),
            "control-outcome-unconfirmed"
        );
        anyhow::ensure!(
            request.experimental_enabled && request.runtime_boot_id.as_deref() == Some(&self.boot),
            "stale-or-disabled-control"
        );
        let id = request
            .request_id
            .as_ref()
            .filter(|id| uuid::Uuid::parse_str(id).is_ok())
            .context("invalid-request-id")?;
        anyhow::ensure!(
            self.used.len() < 10_000 && self.used.insert(id.clone()),
            "duplicate-or-exhausted-request"
        );
        Ok(())
    }
    fn reserve_claude_worker(&mut self, id: &str) -> anyhow::Result<()> {
        if self
            .claude
            .get(id)
            .is_some_and(|runner| runner.has_worker())
        {
            return Ok(());
        }
        let mut count = self
            .claude
            .values()
            .filter(|runner| runner.has_worker())
            .count();
        for (other_id, runner) in &self.claude {
            if count < 8 {
                break;
            }
            if other_id != id && runner.retire_if_inactive() {
                count -= 1;
            }
        }
        anyhow::ensure!(count < 8, "managed-session-limit");
        Ok(())
    }
    fn reserve_antigravity_runner(&mut self, id: &str) -> anyhow::Result<()> {
        if self.antigravity.contains_key(id) {
            return Ok(());
        }
        while self.antigravity.len() >= 8 {
            let candidate = self
                .antigravity
                .iter()
                .find(|(other_id, runner)| other_id.as_str() != id && runner.is_retirable())
                .map(|(other_id, _)| other_id.clone());
            let Some(candidate) = candidate else {
                break;
            };
            self.antigravity.remove(&candidate);
        }
        anyhow::ensure!(self.antigravity.len() < 8, "managed-session-limit");
        Ok(())
    }
    fn antigravity_live_snapshot(&mut self, id: &str) -> anyhow::Result<Value> {
        let runner = self
            .antigravity
            .get(id)
            .context("managed-session-unavailable")?;
        // Surface a failure once before releasing a reconnectable runner.
        // Outcome-unknown runners retain the native turn and stay fenced.
        let reconnectable_failure = runner.is_failed() && !runner.is_outcome_unknown();
        let state = runner.snapshot();
        if reconnectable_failure {
            self.antigravity.remove(id);
        }
        Ok(state)
    }
    fn unsupported(&self, request: &Request, reason: &str) -> anyhow::Result<Value> {
        anyhow::ensure!(request.operation == "live", "control-unavailable");
        Ok(
            json!({"sessionId":request.session_id,"runtimeBootId":self.boot,"status":"unsupported","revision":null,"turnId":null,"sendEnabled":false,"approvals":[],"reason":reason}),
        )
    }
}

// Failed targets are evicted, not retained forever at an obsolete path. A
// cooldown also bounds discovery when a transcript is absent or malformed.
fn cached_target<'a, T>(
    targets: &'a mut BTreeMap<String, T>,
    retry: &mut BTreeMap<String, std::time::Instant>,
    id: &str,
    now: std::time::Instant,
    refresh: bool,
    resolve: impl FnOnce() -> anyhow::Result<T>,
    validate: impl FnOnce(&T) -> anyhow::Result<()>,
) -> anyhow::Result<&'a T> {
    anyhow::ensure!(
        retry.get(id).is_none_or(|deadline| now >= *deadline),
        "session-rediscovery-cooldown"
    );
    let outcome = (|| {
        if refresh || !targets.contains_key(id) {
            targets.insert(id.to_owned(), resolve()?);
        }
        validate(&targets[id])
    })();
    if let Err(error) = outcome {
        targets.remove(id);
        retry.insert(id.to_owned(), now + std::time::Duration::from_secs(30));
        return Err(error);
    }
    retry.remove(id);
    Ok(&targets[id])
}

#[derive(Default)]
struct InstallationProbe {
    result: Option<(bool, std::time::Instant)>,
}
impl InstallationProbe {
    const RETRY_AFTER: std::time::Duration = std::time::Duration::from_secs(30);

    fn supported(&mut self, now: std::time::Instant, probe: impl FnOnce() -> bool) -> bool {
        if let Some((supported, checked_at)) = self.result {
            // SSE polls must not launch a process every two seconds, but a failed
            // check must recover after an installation/upgrade without a restart.
            // Successful checks retain the existing policy: Runner revalidates
            // the exact supported version before starting each new process.
            if supported || now.saturating_duration_since(checked_at) < Self::RETRY_AFTER {
                return supported;
            }
        }
        let supported = probe();
        self.result = Some((supported, now));
        supported
    }
}

// The browser needs project identity, not the native peer's richer workspace
// summary. Project only this whitelist from the same snapshot as the sessions.
fn web_catalog(source: &impl Source) -> anyhow::Result<Value> {
    if source.ensure_available().is_err() {
        return Ok(json!({"workspaces":[],"sessions":[],"indexEnabled":false}));
    }
    let snapshot = source.catalog()?;
    let workspaces = snapshot["workspaces"]
        .as_array()
        .context("invalid-catalog-workspaces")?
        .iter()
        .map(|workspace| {
            json!({"id":workspace["id"],"name":workspace["name"],"path":workspace["path"]})
        })
        .collect::<Vec<_>>();
    Ok(json!({"workspaces":workspaces,"sessions":snapshot["sessions"],"indexEnabled":true}))
}

fn validate_session_access(
    source: &RemoteSessionSource,
    epoch: u64,
    store: &Store,
    session: &agentkib_conversations::ConversationSessionSummary,
    workspace: &Path,
) -> anyhow::Result<()> {
    // Owner discovery/refresh can block while the main runtime handles index or
    // workspace changes. Recheck after that wait, not only at request admission.
    source.ensure_enabled(epoch)?;
    let current = store
        .get_conversation_session(&session.id)?
        .context("session-unavailable")?;
    anyhow::ensure!(
        current.workspace_id == session.workspace_id
            && current.agent == session.agent
            && store.workspace_path(&session.workspace_id)? == workspace,
        "session-unavailable"
    );
    Ok(())
}

fn control_response(
    request: &Request,
    boot: &str,
    dispatched: bool,
    outcome: anyhow::Result<()>,
) -> anyhow::Result<Value> {
    if outcome.is_err() && !dispatched {
        return Ok(json!({"accepted":false,"completed":false,
            "controlOutcome":"not-dispatched","error":"control_preflight_rejected",
            "requestId":request.request_id,"runtimeBootId":boot}));
    }
    outcome?;
    Ok(
        json!({"accepted":true,"completed":false,"requestId":request.request_id,"runtimeBootId":boot}),
    )
}

fn control_attempt_response(
    request: &Request,
    boot: &str,
    dispatched: bool,
    outcome: anyhow::Result<Value>,
) -> anyhow::Result<Value> {
    match outcome {
        Err(error) if request.operation != "live" && !dispatched => {
            control_response(request, boot, false, Err(error))
        }
        outcome => outcome,
    }
}

fn antigravity_control_dispatched(
    runner: &crate::antigravity_runner::Runner,
    outcome: &anyhow::Result<Value>,
) -> bool {
    outcome.is_ok() || runner.is_outcome_unknown()
}

#[cfg(any(target_os = "macos", test))]
fn idle_candidates<'a>(
    recency: &[String],
    states: impl Iterator<Item = (&'a str, bool)>,
) -> Vec<String> {
    let idle: BTreeSet<_> = states.filter_map(|(id, idle)| idle.then_some(id)).collect();
    recency
        .iter()
        .filter(|id| idle.contains(id.as_str()))
        .cloned()
        .collect()
}

/// Expanded projection is used only by separately verified native adapters.
/// Legacy browsers receive the original narrow projection at the HTTP boundary.
pub(super) fn safe_approval_extended(
    approval: agentkib_codex_bridge::Approval,
    controls: bool,
) -> Value {
    let details = approval.details.clone();
    let valid_identity = (approval.request_id.as_i64().is_some()
        || approval
            .request_id
            .as_str()
            .is_some_and(|s| !s.is_empty() && s.len() <= 256))
        && !approval.turn_id.is_empty()
        && details["turnId"]
            .as_str()
            .is_none_or(|id| id == approval.turn_id);
    let options = agentkib_codex_bridge::native_approval_options(&approval.method, &details);
    let complete = match approval.method.as_str() {
        "item/fileChange/requestApproval" => details["changes"]
            .as_array()
            .is_some_and(|c| !c.is_empty() && c.iter().all(complete_file_change)),
        "item/commandExecution/requestApproval" | "item/permissions/requestApproval" => {
            details["cwd"]
                .as_str()
                .is_some_and(|p| Path::new(p).is_absolute())
        }
        _ => false,
    };
    let mut basic = safe_approval(approval, controls);
    if controls && valid_identity && complete && !options.is_empty() {
        basic["requiresExtendedApproval"] = json!(basic["supported"] != true);
        basic["supported"] = json!(true);
        basic["unsupportedReason"] = Value::Null;
        basic["decisionOptions"] = json!(options);
        // The helper rejected unknown fields before these known scope fields
        // become visible. A label alone never represents an expanded grant.
        basic["requestContext"] = json!({
            "reason":details["reason"],"cwd":details["cwd"],
            "networkApprovalContext":details["networkApprovalContext"],
            "additionalPermissions":details["additionalPermissions"],
            "permissions":details["permissions"],"grantRoot":details["grantRoot"],
            "proposedExecpolicyAmendment":details["proposedExecpolicyAmendment"],
            "proposedNetworkPolicyAmendments":details["proposedNetworkPolicyAmendments"]
        });
    }
    basic
}

pub(super) fn safe_approval(approval: agentkib_codex_bridge::Approval, controls: bool) -> Value {
    let details = approval.details;
    let command_request = approval.method == "item/commandExecution/requestApproval";
    // Pinned official schema: omitted kind means command, not terminal input.
    // A proposal is not an authorization; only one-shot decisions are exposed.
    let valid_metadata = !command_request
        || (details.get("kind").is_none_or(|v| v == "command")
            && details
                .get("startedAtMs")
                .is_none_or(|v| v.as_u64().is_some_and(|n| n <= 9_007_199_254_740_991))
            // codex rust-v0.153.4 reserves `local` for LocalProcess and rejects
            // remote environment registration under this ID (see QA source).
            && details.get("environmentId").is_none_or(|v| v.is_null() || v == "local")
            && details.get("proposedExecpolicyAmendment").is_none_or(|v| {
                v.is_null()
                    || v.as_array().is_some_and(|items| {
                        !items.is_empty()
                            && items.len() <= 100
                            && items.iter().all(|item| {
                                item.as_str().is_some_and(|s| {
                                    !s.is_empty() && s.len() <= 4096 && !s.contains('\0')
                                })
                            })
                    })
            }));
    let complete = match approval.method.as_str() {
        "item/commandExecution/requestApproval" => {
            details["command"]
                .as_str()
                .is_some_and(|v| !v.trim().is_empty() && v.len() <= 16 * 1024 && !v.contains('\0'))
                && details["cwd"]
                    .as_str()
                    .is_some_and(|v| Path::new(v).is_absolute())
        }
        "item/fileChange/requestApproval" => details["changes"].as_array().is_some_and(|changes| {
            !changes.is_empty() && changes.len() <= 100 && changes.iter().all(complete_file_change)
        }),
        _ => false,
    };
    let valid_decisions = details
        .get("availableDecisions")
        .is_none_or(|value| value.is_null() || value.is_array());
    let unknown_metadata: Vec<_> = details.as_object().into_iter().flat_map(|object| object.iter())
        .filter(|(key, value)| !(value.is_null() || matches!(key.as_str(),
            "threadId"|"turnId"|"itemId"|"approvalId"|"command"|"cwd"|"reason"|"commandActions"|"changes"|"availableDecisions")
            || (command_request && matches!(key.as_str(), "kind"|"startedAtMs"|"environmentId"|"proposedExecpolicyAmendment"))))
        .take(32)
        .map(|(key, value)| json!({"field":key.chars().take(80).collect::<String>(),"type":match value {
            Value::Null => "null", Value::Bool(_) => "boolean", Value::Number(_) => "number",
            Value::String(_) => "string", Value::Array(_) => "array", Value::Object(_) => "object"
        }})).collect();
    let supported = valid_decisions
        && valid_metadata
        && (approval.request_id.is_string() || approval.request_id.is_number())
        && controls
        && complete
        // Version-pinned allowlist: unknown non-null metadata may carry a new permission
        // request or an omitted scope. Never silently hide it while enabling approval.
        && details.is_object() && unknown_metadata.is_empty()
        && [
            "additionalPermissions",
            "networkApprovalContext",
            "grantRoot",
        ]
        .iter()
        .all(|key| details.get(key).is_none_or(Value::is_null));
    // Null decisions use the version-pinned protocol's standard decisions; unknown entries never escape.
    let offered = details["availableDecisions"]
        .as_array()
        .cloned()
        .unwrap_or_else(|| vec![json!("accept"), json!("decline"), json!("cancel")]);
    let decisions: Vec<_> = offered
        .into_iter()
        .filter(|v| matches!(v.as_str(), Some("accept" | "decline" | "cancel")))
        .collect();
    let supported = supported && !decisions.is_empty();
    let unsupported_reason = if supported {
        None
    } else if !controls {
        Some("control-disabled")
    } else if !complete {
        Some("incomplete-operation-details")
    } else if !unknown_metadata.is_empty() {
        Some("unsupported-metadata")
    } else {
        Some("unsupported-approval-contract")
    };
    // Diagnostic structure only; never expose unknown permission values or log
    // the raw owner request. It does not grant a new decision or permission.
    json!({"requestId":approval.request_id,"turnId":approval.turn_id,"method":approval.method,"command":details["command"],"cwd":details["cwd"],"changes":details["changes"],"availableDecisions":if supported { decisions } else {vec![]},"supported":supported,
        "unsupportedReason":unsupported_reason,"unsupportedMetadata":unknown_metadata,
        "proposedExecpolicyAmendment":if command_request && valid_metadata {details["proposedExecpolicyAmendment"].clone()} else {Value::Null},
        "environmentId":if command_request && valid_metadata {details["environmentId"].clone()} else {Value::Null}})
}

fn complete_file_change(change: &Value) -> bool {
    let Some(object) = change.as_object() else {
        return false;
    };
    // Summary-only entries (path/kind but no actual diff) are not approvable.
    object
        .keys()
        .all(|key| matches!(key.as_str(), "path" | "kind" | "diff"))
        && change["path"]
            .as_str()
            .is_some_and(|path| !path.contains('\0') && Path::new(path).is_absolute())
        && change["diff"]
            .as_str()
            .is_some_and(|diff| diff.len() <= 256 * 1024 && !diff.contains('\0'))
        && change["kind"].as_object().is_some_and(|kind| {
            kind.keys()
                .all(|key| matches!(key.as_str(), "type" | "movePath"))
                && matches!(
                    change["kind"]["type"].as_str(),
                    Some("add" | "update" | "delete")
                )
                && change["kind"].get("movePath").is_none_or(|path| {
                    path.is_null()
                        || path
                            .as_str()
                            .is_some_and(|path| Path::new(path).is_absolute())
                })
        })
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    #[test]
    fn released_empty_claude_session_keeps_managed_event_routing_and_can_be_readopted() {
        let (directory, managed, workspace) = crate::claude_managed::tests::fixture();
        let mut service = super::Service {
            claude_managed: managed,
            ..Default::default()
        };
        let boot = service.boot.clone();
        let id = || uuid::Uuid::new_v4().to_string();
        let created = service
            .claude_managed
            .request(
                serde_json::json!({"operation":"create","workspaceId":workspace,"requestId":id()}),
                &boot,
                true,
            )
            .unwrap();
        let session = created["sessionId"].as_str().unwrap();
        let released = service.claude_managed.request(serde_json::json!({"operation":"release","sessionId":session,"requestId":id(),"runtimeBootId":boot,"expectedRevision":0}), &boot, true).unwrap();
        assert_eq!(released["accepted"], true);
        assert!(!service.claude_managed.owns(session).unwrap());
        assert!(service.claude_managed.has_metadata(session).unwrap());
        let events = service
            .request(serde_json::json!({"operation":"events","sessionId":session}))
            .unwrap();
        assert_eq!(events["events"], serde_json::json!([]));
        let live = service.request(serde_json::json!({"operation":"live","sessionId":session,"experimentalEnabled":true})).unwrap();
        assert_eq!(live["status"], "released");
        assert_eq!(live["sendEnabled"], false);
        let inspected = service.request(serde_json::json!({"operation":"inspect","sessionId":session,"experimentalEnabled":true})).unwrap();
        let adopted = service.claude_managed.request(serde_json::json!({"operation":"adopt","sessionId":session,"requestId":id(),"handoffConfirmed":true,"handoffFingerprint":inspected["handoffFingerprint"]}), &boot, true).unwrap();
        assert_eq!(adopted["sourceSessionId"], created["sourceSessionId"]);
        let live = service.request(serde_json::json!({"operation":"live","sessionId":session,"experimentalEnabled":true})).unwrap();
        assert_eq!(live["status"], "idle");
        assert_eq!(live["sendEnabled"], true);
        assert!(!directory.path().join("starts").exists());
    }
    use super::*;

    #[test]
    fn follower_settings_require_a_supported_platform_and_attached_owner() {
        let service = Service::default();
        let state = service.follower_settings_state("unattached-session");
        assert_eq!(state["available"], false);
        assert_eq!(state["executionMode"], "codex-follower");
        assert_eq!(
            state["reason"],
            if cfg!(target_os = "macos") {
                "open-in-original-client"
            } else {
                "platform-unsupported"
            }
        );
        // An idle status must not grant settings control without a native owner.
        for status in ["idle", "running", "outcome-unknown"] {
            let capability = service
                .follower_settings_capability("unattached-session", &json!({"status":status}));
            assert_eq!(capability["available"], false);
            assert_eq!(
                capability["reason"],
                if cfg!(target_os = "macos") {
                    "follower-operation-unverified"
                } else {
                    "platform-unsupported"
                }
            );
        }
    }

    #[test]
    fn codex_stop_is_unavailable_while_the_previous_outcome_is_unknown() {
        use agentkib_codex_bridge::Status;

        assert!(!codex_stop_enabled(
            true,
            Status::OutcomeUnknown,
            Some("turn")
        ));
        assert!(codex_stop_enabled(true, Status::Running, Some("turn")));
        assert!(codex_stop_enabled(
            true,
            Status::AwaitingApproval,
            Some("turn")
        ));
        assert!(!codex_stop_enabled(false, Status::Running, Some("turn")));
    }

    #[test]
    fn cached_targets_evict_bad_paths_and_rediscover_after_cooldown() {
        let mut targets = BTreeMap::new();
        let mut retry = BTreeMap::new();
        let now = std::time::Instant::now();
        assert_eq!(
            *cached_target(
                &mut targets,
                &mut retry,
                "s",
                now,
                false,
                || Ok("old-path"),
                |_| Ok(())
            )
            .unwrap(),
            "old-path"
        );
        assert!(
            cached_target(
                &mut targets,
                &mut retry,
                "s",
                now,
                false,
                || panic!("valid cache does not rediscover"),
                |_| anyhow::bail!("transcript replaced")
            )
            .is_err()
        );
        assert!(!targets.contains_key("s"));
        for seconds in [0, 2, 29] {
            assert!(
                cached_target(
                    &mut targets,
                    &mut retry,
                    "s",
                    now + std::time::Duration::from_secs(seconds),
                    false,
                    || panic!("failed cache must not cause a polling discovery storm"),
                    |_| Ok(())
                )
                .is_err()
            );
        }
        let recovered = cached_target(
            &mut targets,
            &mut retry,
            "s",
            now + std::time::Duration::from_secs(30),
            false,
            || Ok("new-path"),
            |path| {
                anyhow::ensure!(*path == "new-path", "wrong path");
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(*recovered, "new-path");
        assert!(retry.is_empty());
        // A control always resolves again, and failed resolution never leaves a
        // previously valid target available for the next live request.
        assert!(
            cached_target(
                &mut targets,
                &mut retry,
                "s",
                now + std::time::Duration::from_secs(31),
                true,
                || anyhow::bail!("identity mismatch"),
                |_| Ok(())
            )
            .is_err()
        );
        assert!(targets.is_empty());
    }

    #[test]
    fn failed_installation_probe_recovers_without_polling_spawn_storm() {
        let mut cache = InstallationProbe::default();
        let start = std::time::Instant::now();
        assert!(!cache.supported(start, || false));
        for seconds in (2..30).step_by(2) {
            assert!(
                !cache.supported(start + std::time::Duration::from_secs(seconds), || {
                    panic!("SSE polling must reuse the failed probe during cooldown")
                })
            );
        }
        // Installing a supported version is discovered at the retry boundary.
        assert!(cache.supported(start + InstallationProbe::RETRY_AFTER, || true));
        assert!(
            cache.supported(start + std::time::Duration::from_secs(120), || {
                panic!("successful probe remains cached; Runner validates before spawn")
            })
        );
    }

    #[test]
    fn unknown_installation_remains_disabled_after_retries() {
        let mut cache = InstallationProbe::default();
        let start = std::time::Instant::now();
        for attempt in 0..3 {
            let mut probed = false;
            assert!(
                !cache.supported(start + InstallationProbe::RETRY_AFTER * attempt, || {
                    probed = true;
                    false
                })
            );
            assert!(probed);
        }
    }

    #[test]
    fn claude_capacity_retires_idle_processes_without_forgetting_security_state() {
        let mut service = Service::default();
        for index in 0..8 {
            service.claude.insert(
                index.to_string(),
                crate::claude_runner::Runner::mock_worker("idle"),
            );
        }
        service.used.insert("used-request".into());
        service
            .claude_identity
            .insert("0".into(), (PathBuf::from("/project"), "native".into()));
        service.reserve_claude_worker("ninth").unwrap();
        assert_eq!(
            service.claude.values().filter(|r| r.has_worker()).count(),
            7
        );
        assert_eq!(service.claude.len(), 8);
        assert!(service.used.contains("used-request"));
        assert!(service.claude_identity.contains_key("0"));
        assert_eq!(service.claude["0"].snapshot()["revision"], 1);
        let mut busy = Service::default();
        for index in 0..8 {
            busy.claude.insert(
                index.to_string(),
                crate::claude_runner::Runner::mock_worker("running"),
            );
        }
        assert!(busy.reserve_claude_worker("ninth").is_err());
        assert!(busy.reserve_claude_worker("0").is_ok());
    }

    #[cfg(unix)]
    fn failed_antigravity_runner(id: &str) -> crate::antigravity_runner::Runner {
        let script = r#"
read -r line
printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentInfo":{"name":"antigravity-acp","version":"agy_acp_server_1.1.1"},"agentCapabilities":{"sessionCapabilities":{"resume":{}}}}}'
read -r line
printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{}}'
exit 0
"#;
        let runner = crate::antigravity_runner::Runner::connect_for_test(
            Path::new("/bin/sh"),
            &[
                std::ffi::OsString::from("-c"),
                std::ffi::OsString::from(script),
            ],
            std::env::temp_dir().canonicalize().unwrap(),
            id.into(),
        )
        .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while !runner.is_failed() {
            assert!(
                std::time::Instant::now() < deadline,
                "fake Antigravity runner did not fail after transport EOF"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        runner
    }

    #[cfg(unix)]
    fn outcome_unknown_antigravity_runner(id: &str) -> crate::antigravity_runner::Runner {
        let script = r#"
read -r line
printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentInfo":{"name":"antigravity-acp","version":"agy_acp_server_1.1.1"},"agentCapabilities":{"sessionCapabilities":{"resume":{}}}}}'
read -r line
printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{}}'
read -r line
exit 0
"#;
        let runner = crate::antigravity_runner::Runner::connect_for_test(
            Path::new("/bin/sh"),
            &[
                std::ffi::OsString::from("-c"),
                std::ffi::OsString::from(script),
            ],
            std::env::temp_dir().canonicalize().unwrap(),
            id.into(),
        )
        .unwrap();
        runner.send("run once", 0).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while !runner.is_outcome_unknown() {
            assert!(
                std::time::Instant::now() < deadline,
                "fake Antigravity runner did not preserve its uncertain turn"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        runner
    }

    #[cfg(unix)]
    fn prompt_dispatch_failed_antigravity_runner(id: &str) -> crate::antigravity_runner::Runner {
        let script = r#"
read -r line
printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentInfo":{"name":"antigravity-acp","version":"agy_acp_server_1.1.1"},"agentCapabilities":{"sessionCapabilities":{"resume":{}}}}}'
read -r line
printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{}}'
exec 0<&-
printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"native-dispatch","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"stdin-closed"}}}}'
sleep 5
"#;
        let runner = crate::antigravity_runner::Runner::connect_for_test(
            Path::new("/bin/sh"),
            &[
                std::ffi::OsString::from("-c"),
                std::ffi::OsString::from(script),
            ],
            std::env::temp_dir().canonicalize().unwrap(),
            id.into(),
        )
        .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            let snapshot = runner.snapshot();
            if snapshot["streamText"] == "stdin-closed" {
                let revision = snapshot["revision"].as_u64().unwrap();
                assert!(runner.send("run once", revision).is_err());
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "fake Antigravity runner did not close stdin"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!(runner.is_outcome_unknown());
        runner
    }

    #[cfg(unix)]
    #[test]
    fn antigravity_capacity_retires_only_safe_failures() {
        let mut same = Service::default();
        same.antigravity
            .insert("same".into(), failed_antigravity_runner("native-same"));
        same.reserve_antigravity_runner("same").unwrap();
        assert!(same.antigravity.contains_key("same"));
        let failed = same.antigravity_live_snapshot("same").unwrap();
        assert_eq!(failed["status"], "failed");
        assert!(!same.antigravity.contains_key("same"));

        let mut full = Service::default();
        for index in 0..8 {
            full.antigravity.insert(
                index.to_string(),
                failed_antigravity_runner(&format!("native-{index}")),
            );
        }
        full.reserve_antigravity_runner("ninth").unwrap();
        assert_eq!(full.antigravity.len(), 7);

        let mut uncertain = Service::default();
        for index in 0..8 {
            uncertain.antigravity.insert(
                index.to_string(),
                outcome_unknown_antigravity_runner(&format!("uncertain-{index}")),
            );
        }
        assert!(uncertain.reserve_antigravity_runner("ninth").is_err());
        assert_eq!(uncertain.antigravity.len(), 8);
        let snapshot = uncertain.antigravity_live_snapshot("0").unwrap();
        assert_eq!(snapshot["status"], "outcome-unknown");
        assert!(snapshot["turnId"].is_string());
        assert!(uncertain.antigravity.contains_key("0"));
        let revision = snapshot["revision"].as_u64().unwrap();
        assert!(uncertain.antigravity["0"].send("repeat", revision).is_err());

        let mut dispatch_failed = Service::default();
        dispatch_failed.antigravity.insert(
            "dispatch".into(),
            prompt_dispatch_failed_antigravity_runner("native-dispatch"),
        );
        let snapshot = dispatch_failed
            .antigravity_live_snapshot("dispatch")
            .unwrap();
        assert_eq!(snapshot["status"], "outcome-unknown");
        assert!(dispatch_failed.antigravity.contains_key("dispatch"));
        assert!(
            dispatch_failed
                .reserve_antigravity_runner("dispatch")
                .is_ok()
        );
        let revision = snapshot["revision"].as_u64().unwrap();
        assert!(
            dispatch_failed.antigravity["dispatch"]
                .send("repeat", revision)
                .is_err()
        );
        let request: Request = serde_json::from_value(json!({
            "operation":"send", "requestId":"dispatch-error"
        }))
        .unwrap();
        let outcome = Err::<Value, _>(anyhow::anyhow!("ACP prompt write failed"));
        let dispatched =
            antigravity_control_dispatched(&dispatch_failed.antigravity["dispatch"], &outcome);
        assert!(dispatched);
        assert!(control_response(&request, "boot-1", dispatched, outcome.map(|_| ())).is_err());
    }

    #[test]
    fn web_catalog_projects_one_snapshot_and_only_browser_workspace_fields() {
        struct Snapshot;
        impl Source for Snapshot {
            fn catalog(&self) -> anyhow::Result<Value> {
                Ok(
                    json!({"workspaces":[{"id":"w","name":"test","path":"/projects/test",
                    "discovery_sources":["private"],"status":"active","asset_count":9}],
                    "sessions":[{"id":"s","workspace_id":"w","origin":"auxiliary",
                    "forked_from_session_id":"parent","spawned_by_session_id":null,
                    "created_at":"2026-09-09T00:00:00Z","git_branch":"main"}]}),
                )
            }
            fn events(&self, _: &str, _: Option<&str>, _: usize) -> anyhow::Result<Value> {
                panic!("catalog must not read individual histories")
            }
        }
        let result = web_catalog(&Snapshot).unwrap();
        assert_eq!(result["indexEnabled"], true);
        assert_eq!(
            result["workspaces"],
            json!([{"id":"w","name":"test","path":"/projects/test"}])
        );
        assert_eq!(result["sessions"], Snapshot.catalog().unwrap()["sessions"]);
    }

    #[test]
    fn web_catalog_disabled_index_returns_no_workspaces_or_sessions() {
        struct Disabled;
        impl Source for Disabled {
            fn ensure_available(&self) -> anyhow::Result<()> {
                anyhow::bail!("index-disabled")
            }
            fn catalog(&self) -> anyhow::Result<Value> {
                panic!("disabled catalog must not read the source")
            }
            fn events(&self, _: &str, _: Option<&str>, _: usize) -> anyhow::Result<Value> {
                panic!("disabled catalog must not read histories")
            }
        }
        assert_eq!(
            web_catalog(&Disabled).unwrap(),
            json!({"workspaces":[],"sessions":[],"indexEnabled":false})
        );
    }

    #[test]
    fn final_session_access_rejects_index_and_registry_changes() {
        use agentkib_conversations::{NativeSessionSummary, SessionAvailability, SessionOrigin};
        for change in ["disable", "epoch", "clear", "exclude"] {
            let directory = tempfile::tempdir().unwrap();
            let source = RemoteSessionSource {
                data_dir: directory.path().into(),
            };
            let store = Store::open(&directory.path().join("agentkib.db")).unwrap();
            let workspace = directory.path().join("project");
            fs::create_dir(&workspace).unwrap();
            let registered = store.add_workspace(&workspace).unwrap();
            // Match request admission: Store strips Windows verbatim prefixes,
            // unlike std::fs::canonicalize, so use its persisted path here too.
            let workspace = store.workspace_path(&registered.id).unwrap();
            let session = store
                .sync_conversation_sessions(
                    &registered.id,
                    AgentKind::Codex,
                    &[NativeSessionSummary {
                        native_ref: "synthetic".into(),
                        agent: AgentKind::Codex,
                        title: None,
                        origin: SessionOrigin::Unknown,
                        spawned_by_session_id: None,
                        forked_from_session_id: None,
                        created_at: None,
                        updated_at: None,
                        message_count: None,
                        git_branch: None,
                        archived: false,
                        sidechain: false,
                        availability: SessionAvailability::Readable,
                    }],
                )
                .unwrap()
                .remove(0);
            let epoch = source.availability_epoch().unwrap();
            validate_session_access(&source, epoch, &store, &session, &workspace).unwrap();
            // Model the main runtime changing policy while the Web worker awaits
            // an owner response. Use another store connection, as production does.
            let writer = Store::open(&directory.path().join("agentkib.db")).unwrap();
            let checked_epoch = match change {
                "disable" => {
                    fs::write(
                        directory.path().join("preferences.json"),
                        r#"{"session_index_enabled":false}"#,
                    )
                    .unwrap();
                    epoch
                }
                "epoch" => epoch.wrapping_add(1),
                "clear" => {
                    writer.clear_conversation_index(None).unwrap();
                    epoch
                }
                "exclude" => {
                    writer.exclude_workspace(&registered.id).unwrap();
                    epoch
                }
                _ => unreachable!(),
            };
            assert!(
                validate_session_access(&source, checked_epoch, &store, &session, &workspace)
                    .is_err(),
                "{change}"
            );
        }
    }

    #[test]
    fn control_preflight_receipt_depends_on_dispatch_not_error_text() {
        for operation in ["send", "approve"] {
            let request: Request = serde_json::from_value(json!({
                "operation":operation, "requestId":"request-1"
            }))
            .unwrap();
            let error = || anyhow::anyhow!("session revision changed; nothing sent");
            let receipt = control_response(&request, "boot-1", false, Err(error())).unwrap();
            assert_eq!(
                receipt,
                json!({"accepted":false,"completed":false,
                "requestId":"request-1","runtimeBootId":"boot-1",
                "controlOutcome":"not-dispatched","error":"control_preflight_rejected"})
            );
            assert!(control_response(&request, "boot-1", true, Err(error())).is_err());
            assert_eq!(
                control_response(&request, "boot-1", true, Ok(())).unwrap()["accepted"],
                true
            );
        }
    }

    #[test]
    fn control_attempt_wraps_only_pre_dispatch_mutation_failures() {
        let request: Request = serde_json::from_value(json!({
            "operation":"send", "requestId":"request-1"
        }))
        .unwrap();
        let receipt = control_attempt_response(
            &request,
            "boot-1",
            false,
            Err(anyhow::anyhow!(
                "session disappeared before native dispatch"
            )),
        )
        .unwrap();
        assert_eq!(receipt["controlOutcome"], "not-dispatched");
        assert_eq!(receipt["requestId"], "request-1");

        assert!(
            control_attempt_response(
                &request,
                "boot-1",
                true,
                Err(anyhow::anyhow!("native outcome unknown")),
            )
            .is_err()
        );

        let live: Request = serde_json::from_value(json!({"operation":"live"})).unwrap();
        assert!(
            control_attempt_response(
                &live,
                "boot-1",
                false,
                Err(anyhow::anyhow!("session unavailable")),
            )
            .is_err()
        );
    }

    #[test]
    fn invalid_send_text_never_claims_or_fences_control() {
        let mut service = Service::default();
        for text in [" ".to_owned(), "中".repeat(6000), "🙂".repeat(4097)] {
            assert!(
                service
                    .request(json!({"operation":"send", "sessionId":"test", "text":text}))
                    .is_err()
            );
            assert!(service.used.is_empty());
            assert!(service.unresolved.is_empty());
        }
        for text in [
            "a".repeat(16384),
            "🙂".repeat(4096),
            format!("{}a", "中".repeat(5461)),
        ] {
            assert!(agentkib_codex_bridge::validate_send_text(&text).is_ok());
        }
    }

    // Projection uses the host's absolute-path semantics, even when control is
    // unavailable on that host. Keep fixtures valid on Windows as well as Unix.
    fn test_cwd() -> std::path::PathBuf {
        std::env::temp_dir()
    }

    fn test_file() -> std::path::PathBuf {
        test_cwd().join("qa.txt")
    }
    fn file_approval(details: Value) -> Value {
        safe_approval(
            agentkib_codex_bridge::Approval {
                request_id: json!(1),
                turn_id: "turn".into(),
                method: "item/fileChange/requestApproval".into(),
                details,
            },
            true,
        )
    }
    #[test]
    fn extended_approval_preserves_offered_scope_and_requires_live_identity() {
        let approval = agentkib_codex_bridge::Approval {
            request_id: json!(5),
            turn_id: "turn".into(),
            method: "item/permissions/requestApproval".into(),
            details: json!({"turnId":"turn","cwd":test_cwd(),"permissions":{"network":{"enabled":true}}}),
        };
        let result = safe_approval_extended(approval.clone(), true);
        assert_eq!(result["supported"], true);
        assert_eq!(result["requiresExtendedApproval"], true);
        assert_eq!(result["decisionOptions"][1]["decision"]["scope"], "session");
        assert_eq!(safe_approval(approval.clone(), true)["supported"], false);
        for request_id in [Value::Null, json!({"id":5}), json!(1.5), json!("")] {
            let mut invalid = approval.clone();
            invalid.request_id = request_id;
            assert_eq!(safe_approval_extended(invalid, true)["supported"], false);
        }
        let mut stale = approval.clone();
        stale.details["turnId"] = json!("different-turn");
        assert_eq!(safe_approval_extended(stale, true)["supported"], false);
        assert_eq!(safe_approval_extended(approval, false)["supported"], false);
    }
    #[test]
    fn file_approval_requires_full_known_change_not_a_path_summary() {
        let good = json!({"changes":[{"path":test_file(),"kind":{"type":"add"},"diff":"QA\n"}]});
        assert_eq!(file_approval(good.clone())["supported"], true);
        for changes in [
            json!([{"path":test_file(),"kind":{"type":"add"}}]),
            json!([{"path":test_file(),"kind":{"type":"add"},"diff":null}]),
            json!([{"path":"qa.txt","kind":{"type":"add"},"diff":"QA"}]),
            json!([{"path":test_file(),"kind":{"type":"unknown"},"diff":"QA"}]),
            json!([{"path":test_file(),"kind":{"type":"add"},"diff":"QA","truncated":true}]),
        ] {
            let projected = file_approval(json!({"changes":changes}));
            assert_eq!(projected["supported"], false);
            assert_eq!(projected["availableDecisions"], json!([]));
        }
        for field in [
            "additionalPermissions",
            "networkApprovalContext",
            "grantRoot",
            "proposedExecpolicyAmendment",
            "proposedNetworkPolicyAmendments",
            "unknownPermissionScope",
        ] {
            let mut details = good.clone();
            details[field] = json!({});
            assert_eq!(file_approval(details)["supported"], false, "{field}");
        }
    }

    #[test]
    fn unsupported_approval_diagnostics_never_expose_unknown_values_or_enable_decisions() {
        let projected = safe_approval(
            agentkib_codex_bridge::Approval {
                request_id: json!(34),
                turn_id: "turn".into(),
                method: "item/commandExecution/requestApproval".into(),
                details: json!({"command":"/usr/bin/true","cwd":test_cwd(),
                "unknownPermissionScope":["private-proposal-value"]}),
            },
            true,
        );
        assert_eq!(projected["supported"], false);
        assert_eq!(projected["availableDecisions"], json!([]));
        assert_eq!(projected["unsupportedReason"], "unsupported-metadata");
        assert_eq!(
            projected["unsupportedMetadata"],
            json!([{"field":"unknownPermissionScope","type":"array"}])
        );
        assert!(!projected.to_string().contains("private-proposal-value"));
    }
    #[test]
    fn command_metadata_is_typed_and_never_grants_persistent_rules() {
        let mut approval = agentkib_codex_bridge::Approval {
            request_id: json!(42),
            turn_id: "turn".into(),
            method: "item/commandExecution/requestApproval".into(),
            details: json!({"command":"/usr/bin/true","cwd":test_cwd(),"kind":"command","environmentId":"local",
                "startedAtMs":1770000000000_u64,"proposedExecpolicyAmendment":["/usr/bin/true"],
                "availableDecisions":["accept","acceptForSession",{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["/usr/bin/true"]}},"decline"]}),
        };
        let good = safe_approval(approval.clone(), true);
        assert_eq!(good["supported"], true);
        assert_eq!(good["availableDecisions"], json!(["accept", "decline"]));
        assert_eq!(good["environmentId"], "local");
        assert_eq!(
            good["proposedExecpolicyAmendment"],
            json!(["/usr/bin/true"])
        );
        for (field, value) in [
            ("kind", json!("writeStdin")),
            ("kind", json!("unknown")),
            ("kind", Value::Null),
            ("startedAtMs", json!(-1)),
            ("startedAtMs", json!(1.5)),
            ("startedAtMs", json!("123")),
            ("startedAtMs", json!(9_007_199_254_740_992_u64)),
            ("environmentId", json!("unverified-environment")),
            ("proposedExecpolicyAmendment", json!([1])),
            ("proposedExecpolicyAmendment", json!({})),
            ("proposedExecpolicyAmendment", json!(["bad\0value"])),
            ("additionalPermissions", json!({})),
            ("proposedNetworkPolicyAmendments", json!([])),
        ] {
            let mut invalid = approval.clone();
            invalid.details[field] = value;
            let result = safe_approval(invalid, true);
            assert_eq!(result["supported"], false, "{field}");
            assert_eq!(result["availableDecisions"], json!([]), "{field}");
        }
        approval.details.as_object_mut().unwrap().remove("kind");
        approval
            .details
            .as_object_mut()
            .unwrap()
            .remove("startedAtMs");
        assert_eq!(safe_approval(approval, true)["supported"], true);
    }
    #[test]
    fn command_approval_requires_visible_working_directory_and_complete_scope() {
        let mut approval = agentkib_codex_bridge::Approval {
            request_id: json!(1),
            turn_id: "turn".into(),
            method: "item/commandExecution/requestApproval".into(),
            details: json!({"command":"/usr/bin/true","cwd":test_cwd()}),
        };
        assert_eq!(safe_approval(approval.clone(), true)["supported"], true);
        approval.details["cwd"] = Value::Null;
        assert_eq!(safe_approval(approval, true)["supported"], false);
    }
    #[test]
    fn eviction_is_lru_and_never_selects_busy_approval_or_unknown_entries() {
        let recency = vec![
            "old-running".into(),
            "old-idle".into(),
            "pending".into(),
            "unknown".into(),
            "new-idle".into(),
        ];
        let states = vec![
            ("new-idle", true),
            ("pending", false),
            ("old-idle", true),
            ("unknown", false),
            ("old-running", false),
        ];
        assert_eq!(
            idle_candidates(&recency, states.into_iter()),
            vec!["old-idle", "new-idle"]
        );
        assert!(idle_candidates(&recency, [("pending", false)].into_iter()).is_empty());
    }
    #[test]
    fn restart_does_not_accept_pre_restart_control_and_eviction_cannot_reset_dedup() {
        let mut before = Service::default();
        let request:Request=serde_json::from_value(json!({"operation":"send","experimentalEnabled":true,"runtimeBootId":before.boot,"requestId":uuid::Uuid::new_v4().to_string()})).unwrap();
        before.claim(&request).unwrap();
        // Bridge cache lifecycle deliberately has no relationship to the operation journal.
        #[cfg(target_os = "macos")]
        {
            before.bridges.clear();
            before.recency.clear();
        }
        assert!(before.claim(&request).is_err());
        assert!(Service::default().claim(&request).is_err());
    }
    #[test]
    fn worker_rejects_busy_without_queuing_control() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let worker = Worker {
            sender: Some(sender),
            pending: Arc::new(AtomicU64::new(1)),
            handle: None,
        };
        let request: RpcRequest = serde_json::from_value(
            json!({"jsonrpc":"2.0","id":1,"method":"web.request","params":{"operation":"send"}}),
        )
        .unwrap();
        assert!(worker.submit(request).unwrap().error.is_some());
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn uncertain_control_fence_survives_bridge_eviction_and_new_request_ids() {
        let mut service = Service::default();
        service.unresolved.insert("session-a".into());
        #[cfg(target_os = "macos")]
        {
            service.bridges.clear();
            service.recency.clear();
        }
        for operation in ["send", "approve"] {
            let request: Request = serde_json::from_value(json!({
                "operation":operation,"sessionId":"session-a","experimentalEnabled":true,
                "runtimeBootId":service.boot,"requestId":uuid::Uuid::new_v4().to_string()
            }))
            .unwrap();
            assert!(
                service
                    .claim(&request)
                    .unwrap_err()
                    .to_string()
                    .contains("outcome-unconfirmed")
            );
        }
        let other: Request = serde_json::from_value(json!({
            "operation":"send","sessionId":"session-b","experimentalEnabled":true,
            "runtimeBootId":service.boot,"requestId":uuid::Uuid::new_v4().to_string()
        }))
        .unwrap();
        service.claim(&other).unwrap();
        assert!(
            Service::default().claim(&other).is_err(),
            "restart must reject the old boot"
        );
    }
    #[test]
    fn worker_serializes_page_reads_with_a_bounded_queue() {
        let (sender, receiver) = mpsc::sync_channel(32);
        let worker = Worker {
            sender: Some(sender),
            pending: Arc::new(AtomicU64::new(0)),
            handle: None,
        };
        for id in 0..32 {
            let operation = ["events", "live", "catalog"][id % 3];
            let request = serde_json::from_value(json!({"jsonrpc":"2.0","id":id,"method":"web.request","params":{"operation":operation}})).unwrap();
            assert!(worker.submit(request).is_none());
        }
        for operation in ["live", "send", "approve"] {
            let request = serde_json::from_value(json!({"jsonrpc":"2.0","id":33,"method":"web.request","params":{"operation":operation}})).unwrap();
            assert!(worker.submit(request).unwrap().error.is_some());
        }
        for id in 0..32 {
            assert_eq!(receiver.try_recv().unwrap().id, json!(id));
        }
        assert_eq!(worker.pending.load(Ordering::SeqCst), 32);
    }

    #[test]
    fn worker_admits_only_available_slots_under_concurrent_submissions() {
        for (operation, capacity) in [("events", 32), ("send", 1)] {
            let (sender, receiver) = mpsc::sync_channel(32);
            let worker = Worker {
                sender: Some(sender),
                pending: Arc::new(AtomicU64::new(0)),
                handle: None,
            };
            let barrier = std::sync::Barrier::new(64);
            let accepted = std::thread::scope(|scope| {
                let handles: Vec<_> = (0..64)
                    .map(|id| {
                        let worker = &worker;
                        let barrier = &barrier;
                        scope.spawn(move || {
                            let request = serde_json::from_value(json!({"jsonrpc":"2.0","id":id,"method":"web.request","params":{"operation":operation}})).unwrap();
                            barrier.wait();
                            match worker.submit(request) {
                                None => 1,
                                Some(response) => {
                                    assert_eq!(response.error.unwrap().message, "web-busy");
                                    0
                                }
                            }
                        })
                    })
                    .collect();
                handles
                    .into_iter()
                    .map(|handle| handle.join().unwrap())
                    .sum::<u64>()
            });
            assert_eq!(accepted, capacity);
            assert_eq!(worker.pending.load(Ordering::SeqCst), capacity);
            assert_eq!(receiver.try_iter().count() as u64, capacity);
        }
    }

    #[test]
    fn worker_releases_claimed_slot_when_delivery_fails() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let worker = Worker {
            sender: Some(sender),
            pending: Arc::new(AtomicU64::new(0)),
            handle: None,
        };
        drop(receiver);
        for operation in ["events", "send"] {
            let request = serde_json::from_value(json!({"jsonrpc":"2.0","id":1,"method":"web.request","params":{"operation":operation}})).unwrap();
            assert_eq!(
                worker.submit(request).unwrap().error.unwrap().message,
                "web-unavailable"
            );
            assert_eq!(worker.pending.load(Ordering::SeqCst), 0);
        }
    }

    #[test]
    fn rejects_arbitrary_fields_and_stale_replays() {
        assert!(
            serde_json::from_value::<Request>(json!({"operation":"send","path":"/tmp"})).is_err()
        );
        let mut service = Service::default();
        let mut value = json!({"operation":"send","experimentalEnabled":true,"runtimeBootId":service.boot,"requestId":uuid::Uuid::new_v4().to_string()});
        let request: Request = serde_json::from_value(value.clone()).unwrap();
        assert!(service.claim(&request).is_ok());
        assert!(service.claim(&request).is_err());
        value["runtimeBootId"] = json!("old");
        assert!(
            service
                .claim(&serde_json::from_value(value).unwrap())
                .is_err()
        );
    }
    #[test]
    fn follower_settings_use_current_model_and_reject_uncatalogued_values() {
        let workspace = std::env::temp_dir();
        let request: Request = serde_json::from_value(json!({
            "operation":"settings",
            "mode":"plan",
            "policyId":"full-access-on-request"
        }))
        .unwrap();
        let projected = follower_thread_settings(
            &request,
            &workspace,
            &json!({"model":"owner-model","effort":"high"}),
        )
        .unwrap();
        assert_eq!(
            projected["collaborationMode"]["settings"]["model"],
            "owner-model"
        );
        assert_eq!(projected["model"], "owner-model");
        assert_eq!(projected["effort"], "high");
        assert_eq!(
            projected["collaborationMode"]["settings"]["reasoning_effort"],
            "high"
        );
        assert_eq!(projected["approvalPolicy"], "never");
        assert_eq!(projected["sandboxPolicy"]["type"], "dangerFullAccess");

        for field in [
            json!({"model":"invented-model"}),
            json!({"effort":"medium"}),
            json!({"serviceTier":"fast"}),
        ] {
            let mut value = json!({"operation":"settings","mode":"plan"});
            value
                .as_object_mut()
                .unwrap()
                .extend(field.as_object().unwrap().clone());
            let request: Request = serde_json::from_value(value).unwrap();
            assert!(
                follower_thread_settings(
                    &request,
                    &workspace,
                    &json!({"model":"owner-model","effort":"high"})
                )
                .is_err()
            );
        }
    }
    #[test]
    fn unsupported_permissions_never_offer_decisions() {
        let value = safe_approval(
            agentkib_codex_bridge::Approval {
                request_id: json!(1),
                turn_id: "turn".into(),
                method: "item/commandExecution/requestApproval".into(),
                details: json!({"command":"true","additionalPermissions":{}}),
            },
            true,
        );
        assert_eq!(value["supported"], false);
        assert_eq!(value["availableDecisions"], json!([]));
    }
}

/// The Web facade accepts registered workspace IDs and a narrow read-only Git contract.
fn web_diff(value: Value) -> anyhow::Result<Value> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Request {
        operation: String,
        workspace_id: String,
        kind: agentkib_git::GitDiffKind,
        path: Option<String>,
        oid: Option<String>,
    }
    let request: Request = serde_json::from_value(value)?;
    anyhow::ensure!(request.operation == "diff", "invalid-operation");
    let store = Store::open_default()?;
    let path = store
        .workspace_path(&request.workspace_id)?
        .canonicalize()?;
    anyhow::ensure!(!sensitive_diff_root(&path), "diff-sensitive-path");
    if let Some(summary) = agentkib_git::workspace_summary(&path)? {
        anyhow::ensure!(
            summary.worktree_root.canonicalize()? == path,
            "diff-workspace-must-be-repository-root"
        );
    }
    if let Some(file) = &request.path {
        anyhow::ensure!(!sensitive_diff_path(file), "diff-sensitive-path");
        anyhow::ensure!(
            !file.is_empty()
                && !std::path::Path::new(file).is_absolute()
                && !file.contains('\\')
                && !file.split('/').any(|p| p.is_empty() || p == "."),
            "diff-invalid-path"
        );
        // Git interprets pathspec magic even after `--`. This endpoint accepts filenames.
        anyhow::ensure!(
            !file.contains(['*', '?', '[', ']', ':']),
            "diff-invalid-path"
        );
    }
    let result = checked_web_diff(
        &path,
        &agentkib_git::GitDiffRequest {
            kind: request.kind,
            path: request.path,
            oid: request.oid,
        },
    )?;
    anyhow::ensure!(
        store
            .workspace_path(&request.workspace_id)?
            .canonicalize()?
            == path,
        "workspace-unavailable"
    );
    Ok(serde_json::to_value(result)?)
}

fn checked_web_diff(
    path: &std::path::Path,
    request: &agentkib_git::GitDiffRequest,
) -> anyhow::Result<Option<agentkib_git::GitDiff>> {
    let check_paths = || -> anyhow::Result<()> {
        let files = agentkib_git::diff_files(path, request)?.unwrap_or_default();
        if let Some(selected) = &request.path {
            anyhow::ensure!(
                files
                    .iter()
                    .any(|file| &file.path == selected || file.old_path.as_ref() == Some(selected)),
                "diff-path-not-changed-file"
            );
        }
        for file in files {
            if request.path.as_ref().is_none_or(|selected| {
                selected == &file.path || file.old_path.as_ref() == Some(selected)
            }) {
                anyhow::ensure!(
                    !sensitive_diff_path(&file.path)
                        && file
                            .old_path
                            .as_deref()
                            .is_none_or(|p| !sensitive_diff_path(p)),
                    "diff-sensitive-path"
                );
            }
        }
        Ok(())
    };
    check_paths()?;
    let result = agentkib_git::diff(path, request)?;
    // Revalidate the same comparison after concurrent Git activity before exposing bytes.
    check_paths()?;
    Ok(result)
}

fn sensitive_diff_path(path: &str) -> bool {
    let lower = path.replace('\\', "/").to_ascii_lowercase();
    lower.split('/').any(|part| {
        part == ".."
            || part == ".git"
            || part == ".ssh"
            || part == ".aws"
            || part == ".agentkib"
            || part == "ai.agentkib"
            || part == "ai.agentkib.dev"
            || part == ".codex"
            || part == ".npmrc"
            || part == ".netrc"
            || part == ".env"
            || part.starts_with(".env.")
            || part.contains("credential")
            || part.contains("privatekey")
            || part.contains("private_key")
            || part.contains("private-key")
            || sensitive_auth_name(part)
            || part == "secret"
            || part.starts_with("secret.")
            || part == "secrets"
            || part.starts_with("secrets.")
            || part.starts_with("id_rsa")
            || part.starts_with("id_ed25519")
            || [".pem", ".key", ".p12", ".pfx", ".jks", ".kdbx", ".keystore"]
                .iter()
                .any(|suffix| part.ends_with(suffix))
    })
}

fn sensitive_auth_name(part: &str) -> bool {
    let base = part.split('.').next().unwrap_or(part);
    matches!(
        base,
        "auth"
            | "oauth"
            | "token"
            | "tokens"
            | "access_token"
            | "access-token"
            | "accesstoken"
            | "refresh_token"
            | "refresh-token"
            | "refreshtoken"
    )
}
fn sensitive_diff_root(path: &std::path::Path) -> bool {
    let parts = path
        .components()
        .map(|p| p.as_os_str().to_string_lossy().to_ascii_lowercase())
        .collect::<Vec<_>>();
    parts.iter().enumerate().any(|(i, part)| {
        matches!(
            part.as_str(),
            ".git"
                | ".ssh"
                | ".gnupg"
                | ".aws"
                | ".azure"
                | ".claude"
                | ".gemini"
                | ".agentkib"
                | "ai.agentkib"
                | "ai.agentkib.dev"
        ) || (part == ".codex"
            && !(parts.get(i + 1).is_some_and(|p| p == "worktrees") && parts.get(i + 2).is_some()))
    })
}
#[cfg(test)]
mod diff_safety_tests {
    use super::*;
    use agentkib_git::{GitDiffKind, GitDiffRequest};

    fn git(path: &std::path::Path, args: &[&str]) {
        let output = std::process::Command::new("git")
            .current_dir(path)
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success(), "git {args:?}: {output:?}");
    }

    fn fixture(track_sensitive_file: bool) -> tempfile::TempDir {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path();
        git(path, &["init", "-b", "main"]);
        git(path, &["config", "user.name", "AgentKib Test"]);
        git(path, &["config", "user.email", "test@example.invalid"]);
        std::fs::write(path.join("code.txt"), "before\n").unwrap();
        if track_sensitive_file {
            std::fs::write(path.join(".env"), "fixture-before\n").unwrap();
        }
        git(path, &["add", "."]);
        git(path, &["commit", "-m", "fixture"]);
        directory
    }

    fn request(kind: GitDiffKind) -> GitDiffRequest {
        GitDiffRequest {
            kind,
            path: None,
            oid: None,
        }
    }

    #[test]
    fn staged_diff_ignores_untracked_sensitive_files() {
        let directory = fixture(false);
        let path = directory.path();
        std::fs::write(path.join("code.txt"), "staged-code\n").unwrap();
        git(path, &["add", "code.txt"]);
        std::fs::write(path.join(".env"), "untracked-fixture\n").unwrap();
        let result = checked_web_diff(path, &request(GitDiffKind::Staged))
            .unwrap()
            .unwrap();
        assert!(result.patch.contains("+staged-code"));
        assert!(!result.patch.contains("untracked-fixture"));
        assert!(
            checked_web_diff(path, &request(GitDiffKind::Worktree))
                .unwrap()
                .unwrap()
                .patch
                .is_empty()
        );
    }

    #[test]
    fn checks_sensitive_paths_only_in_the_requested_index_layer() {
        for kind in [GitDiffKind::Worktree, GitDiffKind::Staged] {
            let directory = fixture(true);
            let path = directory.path();
            std::fs::write(path.join("code.txt"), "safe-change\n").unwrap();
            std::fs::write(path.join(".env"), "sensitive-change\n").unwrap();
            let staged = if kind == GitDiffKind::Worktree {
                ".env"
            } else {
                "code.txt"
            };
            git(path, &["add", staged]);
            let result = checked_web_diff(path, &request(kind)).unwrap().unwrap();
            assert!(result.patch.contains("+safe-change"));
            assert!(!result.patch.contains("sensitive-change"));
            let other_kind = if kind == GitDiffKind::Worktree {
                GitDiffKind::Staged
            } else {
                GitDiffKind::Worktree
            };
            assert_eq!(
                checked_web_diff(path, &request(other_kind))
                    .unwrap_err()
                    .to_string(),
                "diff-sensitive-path"
            );
            let mut wrong_layer = request(other_kind);
            wrong_layer.path = Some("code.txt".into());
            assert_eq!(
                checked_web_diff(path, &wrong_layer)
                    .unwrap_err()
                    .to_string(),
                "diff-path-not-changed-file"
            );
        }
    }

    #[test]
    fn staged_copy_uses_the_same_detection_as_the_patch() {
        let directory = fixture(true);
        let path = directory.path();
        git(path, &["config", "diff.renames", "copies"]);
        std::fs::copy(path.join(".env"), path.join("settings.txt")).unwrap();
        std::fs::write(path.join(".env"), "fixture-after\n").unwrap();
        git(path, &["add", "."]);
        let files = agentkib_git::diff_files(path, &request(GitDiffKind::Staged))
            .unwrap()
            .unwrap();
        let copied = files
            .iter()
            .find(|file| file.path == "settings.txt")
            .unwrap();
        assert_eq!(copied.old_path.as_deref(), Some(".env"));
        let mut selected = request(GitDiffKind::Staged);
        selected.path = Some("settings.txt".into());
        assert_eq!(
            checked_web_diff(path, &selected).unwrap_err().to_string(),
            "diff-sensitive-path"
        );
    }

    #[test]
    fn staged_and_commit_renames_check_both_sensitive_endpoints() {
        for (from, to) in [(".env", "settings.txt"), ("code.txt", ".env.local")] {
            let directory = fixture(true);
            let path = directory.path();
            git(path, &["mv", from, to]);
            let mut staged = request(GitDiffKind::Staged);
            // Selecting the ordinary endpoint must not expose the sensitive one.
            staged.path = Some(if from.starts_with('.') { to } else { from }.into());
            assert_eq!(
                checked_web_diff(path, &staged).unwrap_err().to_string(),
                "diff-sensitive-path"
            );
            git(path, &["commit", "-m", "rename"]);
            let output = std::process::Command::new("git")
                .current_dir(path)
                .args(["rev-parse", "HEAD"])
                .output()
                .unwrap();
            let mut commit = request(GitDiffKind::Commit);
            commit.oid = Some(String::from_utf8(output.stdout).unwrap().trim().into());
            assert_eq!(
                checked_web_diff(path, &commit).unwrap_err().to_string(),
                "diff-sensitive-path"
            );
        }
    }

    #[test]
    fn rejects_secrets_before_reading_patch() {
        for name in [
            ".env",
            "nested/.env.local",
            ".git/config",
            "credentials.json",
            "auth.json",
            "oauth.json",
            "token.txt",
            "access-token.json",
            "refresh_token",
            "private-key.pem",
            "server.jks",
            "db.kdbx",
            "../secret",
            ".agentkib/relay/registration.json",
            "ai.agentkib/codex-managed/executions.sqlite",
            "ai.agentkib.dev/web/web.json",
        ] {
            assert!(sensitive_diff_path(name), "{name}");
        }
        for name in [
            "src/main.rs",
            "docs/authentication.md",
            "packages/oauth-client/index.ts",
        ] {
            assert!(!sensitive_diff_path(name), "{name}");
        }
    }
    #[test]
    fn rejects_private_state_roots_but_allows_codex_worktrees() {
        for name in [
            "/home/me/.codex",
            "/home/me/.codex/sessions/project",
            "/home/me/.codex/logs",
            "/home/me/.ssh/project",
            "/home/me/.claude/projects/repo",
            "/Users/me/Library/Application Support/ai.agentkib/web",
            "/Users/me/Library/Application Support/ai.agentkib.dev",
            "/home/me/.local/share/ai.agentkib",
            "/home/me/.agentkib",
        ] {
            assert!(sensitive_diff_root(std::path::Path::new(name)), "{name}");
        }
        assert!(!sensitive_diff_root(std::path::Path::new(
            "/home/me/.codex/worktrees/abcd/project"
        )));
        assert!(!sensitive_diff_root(std::path::Path::new(
            "/home/me/projects/project"
        )));
    }
}
