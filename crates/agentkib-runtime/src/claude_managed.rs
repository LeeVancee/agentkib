//! Claude ownership and dispatch fences. Native logs remain owned by Claude;
//! versioned private metadata records only AgentKib's execution responsibility.
use crate::claude_runner::Runner;
use crate::codex_managed::ledger::Ledger;
use agentkib_conversations::{VerifiedClaudeControlTarget, provider};
use agentkib_core::AgentKind;
use agentkib_store::Store;
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    version: u32,
    id: String,
    workspace_id: String,
    workspace: PathBuf,
    #[serde(default)]
    registered_workspace: Option<PathBuf>,
    home: PathBuf,
    native_id: String,
    title: String,
    created_at: String,
    adopted: bool,
    released: bool,
    fresh: bool,
    fingerprint: Option<String>,
    snapshot: Value,
    #[serde(default)]
    completed_requests: BTreeSet<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    operation: String,
    session_id: Option<String>,
    workspace_id: Option<String>,
    name: Option<String>,
    request_id: Option<String>,
    device_id: Option<String>,
    runtime_boot_id: Option<String>,
    expected_revision: Option<u64>,
    handoff_fingerprint: Option<String>,
    #[serde(default)]
    handoff_confirmed: bool,
    #[serde(default)]
    experimental_enabled: bool,
    text: Option<String>,
    input: Option<Value>,
    resource_refs: Option<Vec<Value>>,
    turn_id: Option<String>,
    approval_id: Option<Value>,
    question_id: Option<Value>,
    answers: Option<Value>,
    decision: Option<String>,
    cursor: Option<String>,
    limit: Option<usize>,
}
#[derive(Default)]
pub(super) struct Service {
    runners: BTreeMap<String, Runner>,
    owners: BTreeMap<String, fs::File>,
    installation: Option<(std::time::Instant, Option<String>)>,
    #[cfg(test)]
    root: Option<PathBuf>,
    #[cfg(test)]
    executable: Option<PathBuf>,
    #[cfg(test)]
    fail_after_record_save: bool,
}
impl Service {
    fn installation_version(&mut self) -> Option<String> {
        #[cfg(test)]
        if self.executable.is_some() {
            return Some("2.1.285 (Claude Code)".into());
        }
        if let Some((time, version)) = &self.installation
            && time.elapsed() < std::time::Duration::from_secs(30)
        {
            return version.clone();
        }
        let version = Runner::installation_version();
        self.installation = Some((std::time::Instant::now(), version.clone()));
        version
    }
    fn home(&self) -> Result<PathBuf> {
        #[cfg(test)]
        if let Some(root) = &self.root {
            return Ok(root.join("home"));
        }
        claude_home()
    }
    fn data(&self) -> Result<PathBuf> {
        #[cfg(test)]
        if let Some(root) = &self.root {
            return Ok(root.clone());
        }
        agentkib_store::default_data_dir()
    }
    fn store(&self) -> Result<Store> {
        Store::open(&self.data()?.join("agentkib.db"))
    }
    fn directory(&self) -> Result<PathBuf> {
        Ok(self.data()?.join("claude-managed"))
    }
    fn ledger(&self) -> Result<Ledger> {
        Ledger::open(self.data()?.join("codex-managed/executions.sqlite"))
    }
    fn path(&self, id: &str) -> Result<PathBuf> {
        ensure!(
            !id.is_empty()
                && id.len() <= 128
                && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'),
            "invalid-session"
        );
        Ok(self.directory()?.join(format!("{id}.json")))
    }
    fn load(&self, id: &str) -> Result<Option<Record>> {
        let path = self.path(id)?;
        if !path.try_exists()? {
            return Ok(None);
        }
        private_directory(&self.directory()?, false)?;
        let metadata = fs::symlink_metadata(&path)?;
        ensure!(
            metadata.is_file()
                && !metadata.file_type().is_symlink()
                && metadata.len() <= 2 * 1024 * 1024,
            "invalid-Claude-metadata"
        );
        let record: Record = serde_json::from_slice(&fs::read(path)?)?;
        ensure!(
            record.version == 1 && record.id == id,
            "unsupported-Claude-metadata"
        );
        uuid::Uuid::parse_str(&record.native_id)?;
        Ok(Some(record))
    }
    fn save(&self, record: &Record) -> Result<()> {
        let directory = self.directory()?;
        private_directory(&directory, true)?;
        let path = self.path(&record.id)?;
        if path.try_exists()? {
            ensure!(
                !fs::symlink_metadata(&path)?.file_type().is_symlink(),
                "invalid-Claude-metadata"
            );
        }
        let temporary = directory.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        let result = (|| {
            file.write_all(&serde_json::to_vec(record)?)?;
            file.sync_all()?;
            fs::rename(&temporary, &path)?;
            fs::File::open(&directory)?.sync_all()?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result
    }
    fn validate(&self, record: &Record) -> Result<()> {
        let root = self
            .store()?
            .workspace_path(&record.workspace_id)?
            .canonicalize()?;
        ensure!(
            root == *record
                .registered_workspace
                .as_ref()
                .unwrap_or(&record.workspace)
                && record.workspace.starts_with(&root),
            "session-workspace-mismatch"
        );
        ensure!(self.home()? == record.home, "claude-home-changed");
        Ok(())
    }
    pub fn has_metadata(&self, id: &str) -> Result<bool> {
        Ok(self.load(id)?.is_some())
    }
    pub fn owns(&self, id: &str) -> Result<bool> {
        Ok(self.load(id)?.is_some_and(|r| !r.released))
    }
    pub fn is_claude(&self, id: &str) -> Result<bool> {
        if self.load(id)?.is_some() {
            return Ok(true);
        }
        Ok(self
            .store()?
            .get_conversation_session(id)?
            .is_some_and(|s| s.agent == AgentKind::ClaudeCode))
    }
    fn target(&self, id: &str) -> Result<(String, VerifiedClaudeControlTarget)> {
        if let Some(record) = self.load(id)? {
            self.validate(&record)?;
            let target = provider(AgentKind::ClaudeCode)
                .context("provider-unavailable")?
                .verified_claude_control_target(&record.native_id)?
                .context("unverified-session-identity")?;
            ensure!(
                target.workspace == record.workspace,
                "session-workspace-mismatch"
            );
            return Ok((record.workspace_id, target));
        }
        let store = self.store()?;
        let session = store
            .get_conversation_session(id)?
            .context("session-unavailable")?;
        ensure!(
            session.agent == AgentKind::ClaudeCode && !session.sidechain,
            "session-not-controllable"
        );
        let workspace = store
            .workspace_path(&session.workspace_id)?
            .canonicalize()?;
        let adapter = provider(AgentKind::ClaudeCode).context("provider-unavailable")?;
        let native = adapter
            .list_sessions(&workspace)?
            .into_iter()
            .find(|s| {
                store
                    .conversation_id(AgentKind::ClaudeCode, &s.native_ref)
                    .is_ok_and(|found| found == id)
            })
            .context("session-unavailable")?;
        let target = adapter
            .verified_claude_control_target(&native.native_ref)?
            .context("unverified-session-identity")?;
        ensure!(
            target.workspace.starts_with(&workspace),
            "session-workspace-mismatch"
        );
        Ok((session.workspace_id, target))
    }
    fn live(&mut self, id: &str, boot: &str, controls: bool) -> Result<Value> {
        let Some(mut record) = self.load(id)? else {
            self.target(id)?;
            return Ok(
                json!({"sessionId":id,"runtimeBootId":boot,"executionMode":"managed-resume","status":"idle","revision":0,"turnId":null,"sendEnabled":false,"stopEnabled":false,"approvals":[],"questions":[],"streamText":"","reason":"handoff-required"}),
            );
        };
        self.validate(&record)?;
        self.recover_completions(&record, boot)?;
        let mut live = if let Some(runner) = self.runners.get(id) {
            let current = runner.snapshot();
            if current["status"] == "idle"
                && let Some(turn) = current["turnId"].as_str().filter(|s| !s.is_empty())
                && !record.completed_requests.contains(turn)
            {
                if let Ok((_, target)) = self.target(id) {
                    record.fingerprint = Some(target_fingerprint(&target)?);
                }
                record.completed_requests.insert(turn.into());
            }
            record.snapshot = current.clone();
            self.save(&record)?;
            self.recover_completions(&record, boot)?;
            current
        } else if record.snapshot["status"] != "idle" || self.ledger()?.has_unknown(id)? {
            json!({"status":"outcome-unknown","revision":record.snapshot["revision"],"turnId":record.snapshot["turnId"],"sendEnabled":false,"stopEnabled":false,"approvals":[],"questions":[],"streamText":"","reason":"control-outcome-unconfirmed"})
        } else {
            record.snapshot.clone()
        };
        if record.released {
            live["status"] = json!("released");
            live["reason"] = json!("handoff-required");
        }
        live["sessionId"] = json!(id);
        live["sourceSessionId"] = json!(record.native_id);
        live["workspaceId"] = json!(record.workspace_id);
        live["runtimeBootId"] = json!(boot);
        live["executionMode"] = json!("claude-managed");
        live["permissionMode"] = json!("cli-configured");
        let version = self.installation_version();
        if version.is_none() {
            live["sendEnabled"] = json!(false);
            if live["status"] == "idle" {
                live["reason"] = json!("unverified-installation");
            }
        }
        live["cliVersion"] = json!(version);
        if !controls || record.released {
            live["sendEnabled"] = json!(false);
            live["stopEnabled"] = json!(false);
            for kind in ["approvals", "questions"] {
                if let Some(items) = live[kind].as_array_mut() {
                    for item in items {
                        item["supported"] = json!(false);
                    }
                }
            }
        }
        Ok(live)
    }
    fn capabilities(&mut self, id: &str, boot: &str, controls: bool) -> Result<Value> {
        let live = self.live(id, boot, controls)?;
        let owned = self.owns(id)?;
        let healthy = cfg!(any(target_os = "macos", test)) && self.installation_version().is_some();
        let mut features = serde_json::Map::new();
        for operation in [
            "send",
            "stop",
            "approve",
            "answer",
            "attachments",
            "files",
            "adopt",
            "release",
            "inspect",
            "reconcile",
            "settings",
            "queue",
            "fork",
            "archive",
            "rename",
            "goal",
            "resources",
        ] {
            let available = match operation {
                "inspect" | "files" => true,
                "reconcile" => owned,
                "adopt" => !owned && healthy && controls,
                "send" | "attachments" => healthy && controls && live["sendEnabled"] == true,
                "stop" => healthy && controls && live["stopEnabled"] == true,
                "approve" => {
                    healthy
                        && controls
                        && live["approvals"].as_array().is_some_and(|v| !v.is_empty())
                }
                "answer" => {
                    healthy
                        && controls
                        && live["questions"].as_array().is_some_and(|v| !v.is_empty())
                }
                "release" => owned && controls && live["status"] == "idle",
                _ => false,
            };
            features.insert(operation.into(), if available { json!({"available":true}) } else { json!({"available":false,"reason": if !healthy { "unverified-installation" } else if !owned { "handoff-required" } else { "operation-unavailable" }}) });
        }
        Ok(
            json!({"sessionId":id,"executionMode":live["executionMode"],"status":live["status"],"reason":live["reason"],"features":features}),
        )
    }
    pub fn catalog(&self) -> Result<Vec<Value>> {
        let directory = self.directory()?;
        if !directory.try_exists()? {
            return Ok(vec![]);
        }
        private_directory(&directory, false)?;
        let store = self.store()?;
        let mut out = vec![];
        for entry in fs::read_dir(directory)?.take(20001) {
            ensure!(out.len() < 20000, "Claude managed catalog exceeds limit");
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|v| v.to_str()) != Some("json") {
                continue;
            }
            let Some(id) = path.file_stem().and_then(|v| v.to_str()) else {
                continue;
            };
            let Some(record) = self.load(id)? else {
                continue;
            };
            if record.released && record.adopted {
                continue;
            }
            if self.validate(&record).is_err() {
                continue;
            }
            let indexed_id = store.conversation_id(AgentKind::ClaudeCode, &record.native_id)?;
            out.push(json!({"id":record.id,"indexedSessionId":indexed_id,"workspace_id":record.workspace_id,"agent":"claude-code","title":record.title,"origin":"interactive","created_at":record.created_at,"updated_at":record.created_at,"message_count":null,"git_branch":null,"archived":false,"sidechain":false,"availability":"readable","executionMode":"claude-managed","sourceSessionId":record.native_id}));
        }
        Ok(out)
    }
    pub fn indexed_aliases(&self) -> Result<BTreeSet<String>> {
        let store = self.store()?;
        self.catalog()?
            .into_iter()
            .map(|v| {
                store.conversation_id(
                    AgentKind::ClaudeCode,
                    v["sourceSessionId"].as_str().context("missing-native-id")?,
                )
            })
            .collect()
    }
    pub fn request(&mut self, value: Value, boot: &str, admin: bool) -> Result<Value> {
        let mutation = matches!(
            value["operation"].as_str(),
            Some(
                "create"
                    | "adopt"
                    | "release"
                    | "reconcile"
                    | "send"
                    | "stop"
                    | "approve"
                    | "answer"
            )
        );
        let result = self.request_inner(value.clone(), boot, admin);
        let Err(error) = result else {
            return result;
        };
        if !mutation {
            return Err(error);
        }
        let request_id = value["requestId"].as_str().context("invalid-request-id")?;
        uuid::Uuid::parse_str(request_id).context("invalid-request-id")?;
        let device = value["deviceId"].as_str();
        crate::codex_managed::validate_device(device)?;
        let mut logical = value.clone();
        if let Some(fields) = logical.as_object_mut() {
            fields.remove("runtimeBootId");
        }
        let fingerprint = format!("{:x}", Sha256::digest(serde_json::to_vec(&logical)?));
        let ledger = self.ledger()?;
        let session = value["sessionId"].as_str().unwrap_or("claude-preflight");
        let mut ack = json!({"accepted":false,"completed":false,"requestId":request_id,"sessionId":value["sessionId"],"runtimeBootId":boot,"controlOutcome":"not-dispatched","error":error.to_string()});
        match ledger.replay(request_id, &fingerprint) {
            Err(error)
                if error
                    .to_string()
                    .contains("request-id-reused-with-different-input") =>
            {
                // This rejection says nothing about the original request's dispatch.
                ack["controlOutcome"] = json!("unknown");
                return Ok(ack);
            }
            Err(error) => return Err(error),
            Ok(Some(previous)) => return Ok(previous),
            Ok(None) => {}
        }
        let workspace = value["workspaceId"]
            .as_str()
            .map(str::to_owned)
            .or_else(|| self.load(session).ok().flatten().map(|r| r.workspace_id));
        let evidence = json!({"operation":value["operation"],"workspaceId":workspace,"executionMode":"claude-managed","runtimeBootId":boot,"expectedRevision":value["expectedRevision"],"turnId":value["turnId"]});
        if let Some(previous) =
            ledger.claim(request_id, session, &fingerprint, device, &evidence)?
        {
            return Ok(previous);
        }
        ledger.finish(request_id, &ack)?;
        Ok(ack)
    }
    fn request_inner(&mut self, value: Value, boot: &str, admin: bool) -> Result<Value> {
        let mut logical = value.clone();
        if let Some(fields) = logical.as_object_mut() {
            fields.remove("runtimeBootId");
        }
        let fingerprint = format!("{:x}", Sha256::digest(serde_json::to_vec(&logical)?));
        let req: Request = serde_json::from_value(value)?;
        crate::codex_managed::validate_device(req.device_id.as_deref())?;
        if req.operation == "options" {
            ensure!(admin, "managed-operation-required");
            let version = self.installation_version();
            let available = cfg!(any(target_os = "macos", test)) && version.is_some();
            return Ok(
                json!({"available":available,"reason":if available { Value::Null } else { json!("unverified-installation") },"workspaces":self.store()?.list_workspaces()?.into_iter().map(|w|json!({"id":w.id,"name":w.name})).collect::<Vec<_>>(),"models":[],"cliVersion":version,"permissionMode":"cli-configured"}),
            );
        }
        let id = req.session_id.as_deref();
        match req.operation.as_str() {
            "context" => {
                let id = id.context("missing-session")?;
                let workspace = if let Some(record) = self.load(id)? {
                    self.validate(&record)?;
                    record.workspace
                } else {
                    self.target(id)?.1.workspace
                };
                return Ok(
                    json!({"available":true,"cwd":workspace,"projectId":null,"branchAtCreation":null}),
                );
            }
            "settings-state" | "usage" | "goal" | "resources" => {
                let live = self.live(id.context("missing-session")?, boot, false)?;
                return Ok(
                    json!({"available": req.operation == "usage" && !live["tokenUsage"].is_null(), "executionMode":"claude-managed", "tokenUsage":live["tokenUsage"],"reason":"cli-configured", "settings":{"model":live["model"],"permissionMode":"cli-configured"},"skills":[],"plugins":[],"apps":[],"contextReferences":{"supportedTypes":[]}}),
                );
            }
            "capabilities" => {
                return self.capabilities(
                    id.context("missing-session")?,
                    boot,
                    req.experimental_enabled || admin,
                );
            }
            "live" => {
                return self.live(
                    id.context("missing-session")?,
                    boot,
                    req.experimental_enabled || admin,
                );
            }
            "inspect" => {
                let id = id.context("missing-session")?;
                let live = self.live(id, boot, req.experimental_enabled || admin)?;
                if let Some(record) = self.load(id)?
                    && record.fresh
                {
                    return Ok(
                        json!({"sessionId":id,"live":live,"workspaceId":record.workspace_id,"sourceSessionId":record.native_id,"handoffFingerprint":empty_fingerprint(&record)?,"reconciled":false}),
                    );
                }
                let (workspace, target) = self.target(id)?;
                return Ok(
                    json!({"sessionId":id,"workspaceId":workspace,"sourceSessionId":target.session_id,"handoffFingerprint":target_fingerprint(&target)?,"live":live,"reconciled":false}),
                );
            }
            "events" => {
                let id = id.context("missing-session")?;
                let record = self.load(id)?.context("session-unavailable")?;
                self.validate(&record)?;
                if record.fresh {
                    return Ok(json!({"events":[],"next_cursor":null,"warnings":[]}));
                }
                let adapter = provider(AgentKind::ClaudeCode).context("provider-unavailable")?;
                // Startup can be accepted before Claude has created its transcript.
                if adapter
                    .verified_claude_control_target(&record.native_id)
                    .is_err()
                    && self
                        .runners
                        .get(id)
                        .is_some_and(|r| r.snapshot()["status"] == "running")
                {
                    return Ok(json!({"events":[],"next_cursor":null,"warnings":[]}));
                }
                return Ok(serde_json::to_value(adapter.read_events(
                    &record.native_id,
                    req.cursor.as_deref(),
                    req.limit.unwrap_or(50).clamp(1, 100),
                )?)?);
            }
            _ => {}
        }
        ensure!(cfg!(any(target_os = "macos", test)), "platform-unsupported");
        ensure!(
            matches!(
                req.operation.as_str(),
                "create"
                    | "adopt"
                    | "release"
                    | "reconcile"
                    | "send"
                    | "stop"
                    | "approve"
                    | "answer"
            ),
            "managed-operation-unsupported"
        );
        if matches!(
            req.operation.as_str(),
            "create" | "adopt" | "release" | "reconcile"
        ) {
            ensure!(admin, "managed-operation-required");
        }
        let request_id = req.request_id.as_deref().context("invalid-request-id")?;
        uuid::Uuid::parse_str(request_id)?;
        let ledger = self.ledger()?;
        if let Some(previous) = ledger.replay(request_id, &fingerprint)? {
            return Ok(previous);
        }
        if req.operation == "create" || req.operation == "adopt" {
            return self.create(&req, boot, &ledger, &fingerprint);
        }
        let id = id.context("missing-session")?;
        self.load(id)?.context("session-unavailable")?;
        self.acquire_owner(id)?;
        let mut record = self.load(id)?.context("session-unavailable")?;
        self.validate(&record)?;
        ensure!(!record.released, "session-released");
        let live = self.live(id, boot, true)?;
        record = self.load(id)?.context("session-unavailable")?;
        if req.operation == "reconcile" {
            // Read-only evidence check. Native JSONL lacks a reliable terminal result
            // fence, so a user message or assistant text alone cannot unlock a turn.
            if let Some(previous) = ledger.claim(request_id, id, &fingerprint, req.device_id.as_deref(), &json!({"operation":"reconcile","workspaceId":record.workspace_id,"executionMode":"claude-managed","runtimeBootId":boot}))? {
                return Ok(previous);
            }
            let ack = json!({"accepted":true,"completed":true,"requestId":request_id,"sessionId":id,"runtimeBootId":boot,"controlOutcome":"accepted","reconciled":live["status"] == "idle","live":live});
            ledger.finish(request_id, &ack)?;
            return Ok(ack);
        }
        ensure!(
            req.runtime_boot_id.as_deref() == Some(boot),
            "stale-runtime-boot"
        );
        ensure!(
            req.expected_revision == live["revision"].as_u64(),
            "stale-Claude-revision"
        );
        ensure!(req.experimental_enabled || admin, "control-disabled");
        ensure!(
            live["status"] != "outcome-unknown",
            "control-outcome-unconfirmed"
        );
        let content = if req.operation == "send" {
            ensure!(live["sendEnabled"] == true, "session-busy");
            ensure!(
                req.resource_refs.as_ref().is_none_or(Vec::is_empty),
                "native-resource-unverified"
            );
            let input = req
                .input
                .clone()
                .or_else(|| req.text.as_ref().map(|v| json!(v)))
                .context("missing-input")?;
            self.installation_version()
                .is_some()
                .then_some(())
                .context("unverified-installation")?;
            crate::claude_runner::validate_content(&input)?;
            if !record.fresh {
                let (_, target) = self.target(id)?;
                ensure!(
                    record.fingerprint.as_deref() == Some(target_fingerprint(&target)?.as_str()),
                    "Claude-history-changed-requires-handoff"
                );
            }
            if !self.runners.get(id).is_some_and(Runner::has_worker) {
                ensure_no_external_owner(&record.native_id)?;
            }
            self.reserve(id)?;
            Some(input)
        } else {
            None
        };
        if req.operation == "release" {
            ensure!(live["status"] == "idle", "session-busy");
        }
        if let Some(previous) = ledger.claim(request_id, id, &fingerprint, req.device_id.as_deref(), &json!({"operation":req.operation,"workspaceId":record.workspace_id,"executionMode":"claude-managed","runtimeBootId":boot,"expectedRevision":req.expected_revision,"turnId":req.turn_id,"inputFingerprint":content.as_ref().map(|v|format!("{:x}",Sha256::digest(v.to_string().as_bytes())))}))? {
            return Ok(previous);
        }
        if req.operation == "release" {
            ledger.dispatch(request_id)?;
            if let Some(runner) = self.runners.get(id)
                && let Err(error) = runner.shutdown()
            {
                record.snapshot = runner.snapshot();
                self.save(&record)?;
                return Err(error);
            }
            self.runners.remove(id);
            record.released = true;
            self.save(&record)?;
            #[cfg(test)]
            ensure!(
                !self.fail_after_record_save,
                "injected receipt loss after save"
            );
            if let Some(lock) = self.owners.remove(id) {
                let _ = lock.unlock();
            }
            let ack = json!({"accepted":true,"completed":true,"requestId":request_id,"sessionId":id,"runtimeBootId":boot,"controlOutcome":"accepted"});
            ledger.finish(request_id, &ack)?;
            return Ok(ack);
        }
        if !self.runners.contains_key(id) {
            ensure!(req.operation == "send", "Claude-runner-unavailable");
            self.runners.insert(
                id.into(),
                if record.fresh {
                    Runner::new_session(record.workspace.clone(), record.native_id.clone())
                } else {
                    Runner::new(record.workspace.clone(), record.native_id.clone())
                },
            );
        }
        #[cfg(test)]
        if let Some(executable) = &self.executable {
            self.runners
                .get_mut(id)
                .unwrap()
                .set_test_executable(executable.clone());
        }
        let runner = self.runners.get(id).context("Claude-runner-unavailable")?;
        let revision = req.expected_revision.context("missing-revision")?;
        if !runner.has_worker() {
            runner.restore_revision(revision)?;
        }
        // Persist uncertainty before crossing the process boundary. On restart this
        // can only become idle through evidence, never by replaying the request.
        record.snapshot = live.clone();
        record.snapshot["status"] = json!("outcome-unknown");
        self.save(&record)?;
        ledger.dispatch(request_id)?;
        let result = match req.operation.as_str() {
            "send" => runner.send_content(content.unwrap(), request_id, revision),
            "stop" => runner.stop(req.turn_id.as_deref().context("missing-turn")?, revision),
            "approve" => runner.approve(
                req.approval_id.as_ref().context("missing-approval")?,
                req.turn_id.as_deref().context("missing-turn")?,
                req.decision.as_deref().context("missing-decision")?,
                revision,
            ),
            "answer" => runner.answer(
                req.question_id.as_ref().context("missing-question")?,
                req.turn_id.as_deref().context("missing-turn")?,
                req.answers.as_ref().context("missing-answers")?,
                revision,
            ),
            _ => unreachable!(),
        };
        record.snapshot = runner.snapshot();
        if result.is_ok() && req.operation == "send" {
            record.fresh = false;
        }
        self.save(&record)?;
        #[cfg(test)]
        ensure!(
            !self.fail_after_record_save,
            "injected receipt loss after dispatch"
        );
        let ack = match result {
            Ok(()) => {
                json!({"accepted":true,"completed":false,"requestId":request_id,"sessionId":id,"runtimeBootId":boot,"controlOutcome":"accepted","live":self.live(id,boot,true)?})
            }
            Err(error) => {
                json!({"accepted":false,"completed":false,"requestId":request_id,"sessionId":id,"runtimeBootId":boot,"controlOutcome":if record.snapshot["status"] == "outcome-unknown" {"unknown"}else{"not-dispatched"},"error":error.to_string()})
            }
        };
        if ack["controlOutcome"] != "unknown" {
            ledger.finish(request_id, &ack)?;
        }
        Ok(ack)
    }
    pub fn receipt(&mut self, mut receipt: Value, boot: &str) -> Result<Value> {
        if receipt["executionMode"] == "claude-managed"
            && receipt["found"] == true
            && let Some(id) = receipt["sessionId"].as_str().map(str::to_owned)
            && self.load(&id)?.is_some()
        {
            self.live(&id, boot, false)?;
            let record = self.load(&id)?.context("session-unavailable")?;
            receipt["completionObserved"] = json!(
                record
                    .completed_requests
                    .contains(receipt["requestId"].as_str().unwrap_or(""))
            );
            if receipt["completionObserved"] == true
                && receipt["operation"] == "send"
                && receipt["status"] == "unknown"
            {
                receipt["ack"] = completed_ack(
                    receipt["requestId"]
                        .as_str()
                        .context("missing-request-id")?,
                    &record,
                    receipt["runtimeBootId"].as_str().unwrap_or(boot),
                );
                receipt["status"] = json!("accepted");
            }
        }
        Ok(receipt)
    }
    fn recover_completions(&self, record: &Record, boot: &str) -> Result<()> {
        if record.completed_requests.is_empty() {
            return Ok(());
        }
        let ledger = self.ledger()?;
        for (request, evidence) in ledger.unknown(&record.id)? {
            if evidence["operation"] == "send" && record.completed_requests.contains(&request) {
                ledger.finish(
                    &request,
                    &completed_ack(
                        &request,
                        record,
                        evidence["runtimeBootId"].as_str().unwrap_or(boot),
                    ),
                )?;
            }
        }
        Ok(())
    }
    fn acquire_owner(&mut self, id: &str) -> Result<()> {
        if self.owners.contains_key(id) {
            return Ok(());
        }
        private_directory(&self.directory()?, true)?;
        let path = self.path(id)?.with_extension("lock");
        if path.try_exists()? {
            ensure!(
                !fs::symlink_metadata(&path)?.file_type().is_symlink(),
                "invalid-Claude-lock"
            );
        }
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path)?;
        file.try_lock()
            .context("Claude session is managed by another Runtime")?;
        self.owners.insert(id.into(), file);
        Ok(())
    }
    fn fence_cleanup(&self, id: &str, runner: &Runner) -> Result<()> {
        if runner.has_worker()
            && let Some(mut record) = self.load(id)?
        {
            record.snapshot = runner.snapshot();
            record.snapshot["status"] = json!("outcome-unknown");
            self.save(&record)?;
        }
        Ok(())
    }
    fn reserve(&mut self, id: &str) -> Result<()> {
        for (key, runner) in &self.runners {
            if key != id {
                self.fence_cleanup(key, runner)?;
                if runner.retire_if_inactive()
                    && let Some(mut record) = self.load(key)?
                {
                    record.snapshot = runner.snapshot();
                    self.save(&record)?;
                }
            }
        }
        ensure!(
            self.runners.get(id).is_some_and(Runner::has_worker)
                || self.runners.values().filter(|r| r.has_worker()).count() < 8,
            "Claude-runner-limit"
        );
        Ok(())
    }
    fn create(
        &mut self,
        req: &Request,
        boot: &str,
        ledger: &Ledger,
        fingerprint: &str,
    ) -> Result<Value> {
        ensure!(
            self.installation_version().is_some(),
            "unverified-installation"
        );
        let request_id = req.request_id.as_deref().context("missing-request-id")?;
        let adopted = req.operation == "adopt";
        let (id, workspace_id, workspace, native_id, handoff, fresh) = if adopted {
            ensure!(req.handoff_confirmed, "handoff-confirmation-required");
            let id = req.session_id.as_deref().context("missing-session")?;
            ensure!(!self.owns(id)?, "session-already-managed");
            if let Some(record) = self.load(id)?
                && record.fresh
            {
                self.validate(&record)?;
                ensure!(
                    req.handoff_fingerprint.as_deref()
                        == Some(empty_fingerprint(&record)?.as_str()),
                    "handoff-fingerprint-changed"
                );
                (
                    id.to_owned(),
                    record.workspace_id,
                    record.workspace,
                    record.native_id,
                    None,
                    true,
                )
            } else {
                let (workspace_id, target) = self.target(id)?;
                ensure_no_external_owner(&target.session_id)?;
                let hash = target_fingerprint(&target)?;
                ensure!(
                    req.handoff_fingerprint.as_deref() == Some(&hash),
                    "handoff-fingerprint-changed"
                );
                (
                    id.to_owned(),
                    workspace_id,
                    target.workspace,
                    target.session_id,
                    Some(hash),
                    false,
                )
            }
        } else {
            let workspace_id = req.workspace_id.as_ref().context("missing-workspace")?;
            let workspace = self.store()?.workspace_path(workspace_id)?.canonicalize()?;
            let native = uuid::Uuid::new_v4().to_string();
            (
                uuid::Uuid::new_v4().to_string(),
                workspace_id.clone(),
                workspace,
                native,
                None,
                true,
            )
        };
        self.acquire_owner(&id)?;
        if let Some(previous) = ledger.claim(request_id, &id, fingerprint, req.device_id.as_deref(), &json!({"operation":req.operation,"workspaceId":workspace_id,"runtimeBootId":boot,"executionMode":"claude-managed"}))? {
            return Ok(previous);
        }
        let record = Record {
            version: 1,
            id: id.clone(),
            registered_workspace: Some(
                self.store()?
                    .workspace_path(&workspace_id)?
                    .canonicalize()?,
            ),
            workspace_id,
            workspace,
            home: self.home()?,
            native_id,
            title: req
                .name
                .as_deref()
                .filter(|n| !n.trim().is_empty() && n.len() <= 512)
                .unwrap_or("Claude Code")
                .into(),
            created_at: chrono::Utc::now().to_rfc3339(),
            adopted: self.load(&id)?.map(|r| r.adopted).unwrap_or(adopted),
            released: false,
            fresh,
            fingerprint: handoff,
            completed_requests: self
                .load(&id)?
                .map(|r| r.completed_requests)
                .unwrap_or_default(),
            snapshot: json!({"status":"idle","revision":0,"turnId":null,"sendEnabled":true,"stopEnabled":false,"approvals":[],"questions":[],"streamText":""}),
        };
        ledger.dispatch(request_id)?;
        self.save(&record)?;
        #[cfg(test)]
        ensure!(
            !self.fail_after_record_save,
            "injected receipt loss after save"
        );
        let mut live = record.snapshot.clone();
        live["sessionId"] = json!(id);
        live["workspaceId"] = json!(record.workspace_id);
        live["sourceSessionId"] = json!(record.native_id);
        live["runtimeBootId"] = json!(boot);
        live["executionMode"] = json!("claude-managed");
        live["cliVersion"] = json!(self.installation_version());
        live["permissionMode"] = json!("cli-configured");
        let ack = json!({"accepted":true,"completed":true,"controlOutcome":"accepted","requestId":request_id,"sessionId":id,"sourceSessionId":record.native_id,"runtimeBootId":boot,"live":live});
        ledger.finish(request_id, &ack)?;
        Ok(ack)
    }
}
impl Drop for Service {
    fn drop(&mut self) {
        // Preserve an observed idle result before retiring its native process.
        let ids: Vec<_> = self.runners.keys().cloned().collect();
        for id in ids {
            let _ = self.live(&id, "shutdown", false);
            if let Some(runner) = self.runners.get(&id) {
                let _ = self.fence_cleanup(&id, runner);
                let _ = runner.shutdown();
            }
            // A failed cleanup must overwrite an earlier idle snapshot before restart.
            let _ = self.live(&id, "shutdown", false);
            self.runners.remove(&id);
        }
        for (_, lock) in std::mem::take(&mut self.owners) {
            let _ = lock.unlock();
        }
    }
}
fn private_directory(path: &Path, create: bool) -> Result<()> {
    if create {
        fs::create_dir_all(path)?;
    }
    for ancestor in path.ancestors() {
        if ancestor.exists() {
            ensure!(
                !fs::symlink_metadata(ancestor)?.file_type().is_symlink(),
                "Claude metadata path is a symlink"
            );
        }
    }
    ensure!(path.is_dir(), "Claude metadata directory unavailable");
    #[cfg(unix)]
    if create {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}
fn claude_home() -> Result<PathBuf> {
    let path = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or(
            dirs::home_dir()
                .context("home-unavailable")?
                .join(".claude"),
        );
    // New installations can have no logs yet; identify the nearest real parent.
    if path.exists() {
        Ok(path.canonicalize()?)
    } else {
        Ok(path
            .parent()
            .context("invalid-Claude-home")?
            .canonicalize()?
            .join(path.file_name().context("invalid-Claude-home")?))
    }
}
fn completed_ack(request: &str, record: &Record, boot: &str) -> Value {
    json!({"accepted":true,"completed":true,"controlOutcome":"accepted","requestId":request,"sessionId":record.id,"sourceSessionId":record.native_id,"runtimeBootId":boot,"completionObserved":true})
}
fn empty_fingerprint(record: &Record) -> Result<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(
            record.id.as_str(),
            record.native_id.as_str(),
            &record.workspace,
            &record.home,
            record.fresh,
            record.released
        ))?)
    ))
}
fn target_fingerprint(target: &VerifiedClaudeControlTarget) -> Result<String> {
    target.revalidate()?;
    let path = target.transcript_path();
    ensure!(
        !fs::symlink_metadata(path)?.file_type().is_symlink(),
        "Claude transcript symlink unsupported"
    );
    let mut file = fs::File::open(path)?;
    let before = file.metadata()?;
    ensure!(
        before.len() <= 128 * 1024 * 1024,
        "Claude transcript exceeds handoff budget"
    );
    let mut bytes = vec![];
    Read::by_ref(&mut file)
        .take(128 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    let after = file.metadata()?;
    ensure!(
        before.len() == after.len()
            && before.modified()? == after.modified()?
            && bytes.len() as u64 == before.len(),
        "Claude history changed during handoff"
    );
    target.revalidate()?;
    let mut hash = Sha256::new();
    hash.update(serde_json::to_vec(&(
        target.session_id.as_str(),
        &target.workspace,
    ))?);
    hash.update(bytes);
    Ok(format!("{:x}", hash.finalize()))
}

// 产品只在 macOS 启用托管；非 Unix 平台没有外部进程检查实现。
#[cfg_attr(not(unix), allow(unused_variables))]
fn ensure_no_external_owner(native_id: &str) -> Result<()> {
    #[cfg(unix)]
    {
        use std::process::{Command, Stdio};
        let output = Command::new("/bin/ps")
            .args(["-axo", "pid=,command="])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .context("Claude process inspection unavailable")?;
        ensure!(
            output.status.success(),
            "Claude process inspection unavailable"
        );
        ensure!(
            !String::from_utf8_lossy(&output.stdout)
                .lines()
                .any(|line| process_mentions_session(line, native_id)),
            "Claude session is active in an external process"
        );
    }
    Ok(())
}
#[cfg(unix)]
fn process_mentions_session(line: &str, id: &str) -> bool {
    let words: Vec<_> = line.split_whitespace().collect();
    words.iter().any(|w| w.rsplit('/').next() == Some("claude"))
        && (words
            .iter()
            .any(|w| *w == format!("--resume={id}") || *w == format!("--session-id={id}"))
            || words
                .windows(2)
                .any(|pair| matches!(pair[0], "--resume" | "-r" | "--session-id") && pair[1] == id))
}

#[cfg(all(test, unix))]
#[path = "claude_managed_tests.rs"]
pub(crate) mod tests;
