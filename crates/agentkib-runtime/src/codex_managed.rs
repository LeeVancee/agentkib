//! Codex sessions owned by AgentKib, with durable dispatch fences and native writer locks.
//! An official-client follower is never silently upgraded into a managed writer.
mod completion;
pub(crate) mod ledger;
mod state;
mod transport;
use agentkib_store::Store;
use anyhow::{Context, Result, bail, ensure};
use chrono::Utc;
use ledger::{Ledger, Record};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use state::State;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::OpenOptions,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use transport::Client;
const POLICY: &str = "workspace-write-on-request";
const POLICY_FULL_ACCESS: &str = "full-access-on-request";
const POLICY_AUTO_REVIEW: &str = "workspace-write-auto-review";
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    operation: String,
    session_id: Option<String>,
    workspace_id: Option<String>,
    request_id: Option<String>,
    device_id: Option<String>,
    expected_revision: Option<u64>,
    runtime_boot_id: Option<String>,
    text: Option<String>,
    input: Option<Value>,
    resource_refs: Option<Vec<Value>>,
    native_decision: Option<Value>,
    name: Option<String>,
    mode: Option<String>,
    queued_submission_id: Option<String>,
    queued_submission_ids: Option<Vec<String>>,
    turn_id: Option<String>,
    approval_id: Option<Value>,
    question_id: Option<Value>,
    answers: Option<Value>,
    decision: Option<String>,
    policy_id: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    service_tier: Option<String>,
    #[serde(default)]
    reset_defaults: bool,
    goal: Option<Value>,
    #[serde(default)]
    handoff_confirmed: bool,
    #[serde(default)]
    experimental_enabled: bool,
    cursor: Option<String>,
    limit: Option<usize>,
}
struct Runner {
    plan_verified: bool,
    client: Client,
    state: Arc<Mutex<State>>,
}
#[derive(Default)]
pub(super) struct Service {
    ledger: Option<Ledger>,
    runners: BTreeMap<String, Runner>,
    #[cfg(test)]
    test_root: Option<PathBuf>,
    #[cfg(test)]
    test_executable: Option<PathBuf>,
}
impl Service {
    fn platform_supported(&self) -> bool {
        #[cfg(test)]
        if self.test_root.is_some() || self.test_executable.is_some() {
            // Unix protocol fixtures may run on Linux, but must never fall back
            // to the developer's executable, CODEX_HOME or persistent ledger.
            return self.ledger.is_some()
                && self.test_root.as_ref().is_some_and(|root| {
                    root.canonicalize().is_ok_and(|root| {
                        root.join("home")
                            .canonicalize()
                            .is_ok_and(|home| home.is_dir() && home.starts_with(&root))
                            && self.test_executable.as_ref().is_some_and(|executable| {
                                executable.canonicalize().is_ok_and(|executable| {
                                    executable.is_file() && executable.starts_with(&root)
                                })
                            })
                    })
                });
        }
        cfg!(target_os = "macos")
    }
    fn store(&self) -> Result<Store> {
        #[cfg(test)]
        if let Some(root) = &self.test_root {
            return Store::open(&root.join("agentkib.db"));
        }
        Store::open_default()
    }
    fn home(&self) -> Result<PathBuf> {
        #[cfg(test)]
        if let Some(root) = &self.test_root {
            return root.join("home").canonicalize().map_err(Into::into);
        }
        codex_home()
    }
    fn executable(&self) -> Result<PathBuf> {
        self.executable_info().map(|(path, _)| path)
    }
    fn executable_info(&self) -> Result<(PathBuf, String)> {
        #[cfg(test)]
        if let Some(path) = &self.test_executable {
            return Ok((path.canonicalize()?, verified_version(path)?));
        }
        let path = agentkib_platform::command::resolve("codex").context("codex-cli-unavailable")?;
        let version = verified_version(&path)?;
        Ok((
            path.canonicalize().context("codex-cli-unavailable")?,
            version,
        ))
    }
    fn validate_access(&self, record: &Record) -> Result<()> {
        ensure!(
            self.store()?
                .workspace_path(&record.workspace_id)?
                .canonicalize()?
                == record.workspace,
            "session-workspace-mismatch"
        );
        ensure!(self.home()? == record.home, "codex-home-changed");
        Ok(())
    }
    fn existing_ledger(&mut self) -> Result<Option<Ledger>> {
        if let Some(ledger) = &self.ledger {
            return Ok(Some(ledger.clone()));
        }
        let path = agentkib_store::default_data_dir()?.join("codex-managed/executions.sqlite");
        if !path.is_file() {
            return Ok(None);
        }
        self.ledger = Some(Ledger::open(path)?);
        Ok(self.ledger.clone())
    }
    pub(super) fn ledger(&mut self) -> Result<Ledger> {
        if self.ledger.is_none() {
            self.ledger = Some(Ledger::open(
                agentkib_store::default_data_dir()?.join("codex-managed/executions.sqlite"),
            )?)
        }
        Ok(self.ledger.as_ref().unwrap().clone())
    }
    pub(super) fn has_unconfirmed(&mut self, id: &str) -> Result<bool> {
        Ok(match self.existing_ledger()? {
            Some(ledger) => ledger.has_unknown(id)?,
            None => false,
        })
    }
    pub(super) fn receipt(&mut self, value: Value) -> Result<Value> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Query {
            request_id: String,
            device_id: String,
        }
        let query: Query = serde_json::from_value(value)?;
        uuid::Uuid::parse_str(&query.request_id).context("invalid-request-id")?;
        validate_device(Some(&query.device_id))?;
        ensure!(!query.device_id.is_empty(), "invalid-device-id");
        match self.existing_ledger()? {
            Some(ledger) => ledger.receipt(&query.request_id, &query.device_id),
            None => Ok(json!({"found":false,"requestId":query.request_id})),
        }
    }
    pub fn owns(&mut self, id: &str) -> Result<bool> {
        Ok(match self.existing_ledger()? {
            Some(l) => l.get(id)?.is_some_and(|r| !r.released || !r.adopted),
            None => false,
        })
    }
    fn target(&mut self, id: &str) -> Result<(String, PathBuf, Option<String>)> {
        let store = self.store()?;
        let record = match self.existing_ledger()? {
            Some(ledger) => ledger.get(id)?,
            None => None,
        };
        let (workspace_id, workspace, native) = if let Some(record) = record {
            self.validate_access(&record)?;
            (record.workspace_id, record.workspace, record.native_id)
        } else {
            let session = store
                .get_conversation_session(id)?
                .context("session-unavailable")?;
            ensure!(
                session.agent == agentkib_core::AgentKind::Codex,
                "session-not-codex"
            );
            let workspace = store
                .workspace_path(&session.workspace_id)?
                .canonicalize()?;
            let provider =
                agentkib_conversations::provider(session.agent).context("provider-unavailable")?;
            let candidate = provider
                .list_sessions(&workspace)?
                .into_iter()
                .find(|candidate| {
                    store
                        .conversation_id(session.agent, &candidate.native_ref)
                        .is_ok_and(|candidate_id| candidate_id == id)
                })
                .context("session-unavailable")?;
            let native = provider.verified_control_id(&candidate.native_ref)?;
            (session.workspace_id, workspace, native)
        };
        Ok((workspace_id, workspace, native))
    }
    pub fn context(&mut self, id: &str) -> Result<Value> {
        let (workspace_id, workspace, native) = self.target(id)?;
        let store = self.store()?;
        let Some(native) = native else {
            return Ok(json!({"available":false,"reason":"native-session-unverified"}));
        };
        let client = Client::spawn(&self.executable()?, &workspace, &self.home()?, None, |_| {})?;
        // Metadata-only read does not resume the thread or acquire its writer lock.
        let response = client.request(
            "thread/read",
            json!({"threadId":native,"includeTurns":false}),
        )?;
        ensure!(
            response["thread"]["id"] == native,
            "thread-identity-mismatch"
        );
        ensure!(
            store.workspace_path(&workspace_id)?.canonicalize()? == workspace,
            "session-workspace-mismatch"
        );
        native_context(&response["thread"], &workspace)
    }
    pub fn read_extended(&mut self, id: &str, operation: &str, boot: &str) -> Result<Value> {
        let Some(record) = self
            .existing_ledger()?
            .and_then(|ledger| ledger.get(id).ok().flatten())
        else {
            return Ok(
                json!({"available":false,"executionMode":"codex-follower","reason":"follower-operation-unverified"}),
            );
        };
        self.validate_access(&record)?;
        let ledger = self.ledger()?;
        let Some(runner) = self
            .runners
            .get(id)
            .filter(|runner| runner.client.connected())
        else {
            return Ok(match operation {
                "usage" => {
                    json!({"available":record.token_usage.is_some(),"executionMode":"codex-managed","tokenUsage":record.token_usage,"revision":record.snapshot["revision"],"reason":if record.token_usage.is_some(){Value::Null}else{json!("recovery-required")}})
                }
                "goal" => {
                    json!({"available":true,"executionMode":"codex-managed","goal":record.goal,"revision":record.snapshot["revision"],"reason":"recovery-required"})
                }
                "settings-state" => {
                    let mut settings = state::settings_projection(&record);
                    settings["applicationStatus"] = json!("unknown");
                    json!({"available":false,"executionMode":"codex-managed","reason":"recovery-required","settings":settings})
                }
                _ => {
                    json!({"available":false,"executionMode":"codex-managed","reason":"recovery-required","skills":[],"plugins":[],"apps":[],"contextReferences":{"supportedTypes":[]}})
                }
            });
        };
        let revision = runner.state.lock().unwrap().revision;
        match operation {
            "settings-state" => {
                let models = model_catalog(&runner.client)?;
                let modes = collaboration_mode_catalog(runner);
                let state = runner.state.lock().unwrap();
                let mut settings = state::settings_projection(&state.record);
                settings["writable"] = json!({
                    "model":true,
                    "effort":true,
                    "mode":if modes.is_ok(){json!({"available":true})}else{json!({"available":false,"reason":"native-collaboration-modes-unavailable"})},
                    "serviceTier":true,
                    "policy":true
                });
                Ok(
                    json!({"available":true,"executionMode":"codex-managed","settings":settings,"models":models,"collaborationModes":modes.unwrap_or_default(),"policies":policy_catalog(),"revision":state.revision,"runtimeBootId":boot}),
                )
            }
            "usage" => {
                let usage = runner.state.lock().unwrap().record.token_usage.clone();
                Ok(
                    json!({"available":usage.is_some(),"executionMode":"codex-managed","tokenUsage":usage,"revision":revision,"reason":if usage.is_some(){Value::Null}else{json!("token-usage-unavailable")}}),
                )
            }
            "goal" => {
                let native = record
                    .native_id
                    .as_deref()
                    .context("native-session-unconfirmed")?;
                let goal_revision = runner.state.lock().unwrap().goal_revision;
                let result = runner
                    .client
                    .request("thread/goal/get", json!({"threadId":native}))?;
                let mut state = runner.state.lock().unwrap();
                if state.goal_revision == goal_revision {
                    let goal = result.get("goal").filter(|v| v.is_object()).cloned();
                    if state.record.goal != goal {
                        let before = state.record.goal.as_ref().unwrap_or(&Value::Null);
                        let after = goal.as_ref().unwrap_or(&Value::Null);
                        // Counters/time refresh the snapshot without invalidating
                        // settings forms on every selected-session read.
                        if ["objective", "status", "tokenBudget"]
                            .iter()
                            .any(|key| before[key] != after[key])
                        {
                            state.revision += 1;
                        }
                        state.record.goal = goal;
                        state.save(&ledger)?;
                    }
                }
                Ok(
                    json!({"available":true,"executionMode":"codex-managed","goal":state.record.goal,"revision":state.revision}),
                )
            }
            "resources" => resources(&runner.client, &record.workspace),
            _ => bail!("managed-operation-unsupported"),
        }
    }
    pub fn catalog(&mut self) -> Result<Vec<Value>> {
        let Some(ledger) = self.existing_ledger()? else {
            return Ok(vec![]);
        };
        let store = self.store()?;
        Ok(ledger.list()?.into_iter().filter(|r|!r.released||!r.adopted).filter(|r|store.workspace_path(&r.workspace_id).is_ok_and(|p|p.canonicalize().ok().as_ref()==Some(&r.workspace))).map(|r|json!({"id":r.id,"workspace_id":r.workspace_id,"agent":"codex","title":r.title,"origin":"interactive","created_at":r.created_at,"updated_at":r.created_at,"message_count":null,"git_branch":null,"archived":r.archived,"sidechain":false,"availability":"readable","executionMode":"codex-managed","sourceSessionId":r.source_session_id})).collect())
    }
    /// The index hashes rollout references, while managed creation uses its durable
    /// request identity. Hide verified aliases of the same native thread.
    pub fn indexed_aliases(&mut self) -> Result<BTreeSet<String>> {
        let Some(ledger) = self.existing_ledger()? else {
            return Ok(BTreeSet::new());
        };
        let records = ledger.list()?;
        let store = self.store()?;
        let mut workspaces: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        for record in records.into_iter().filter(|r| !r.released || !r.adopted) {
            if self.validate_access(&record).is_err() {
                continue;
            }
            if let Some(native) = record.native_id {
                workspaces
                    .entry(record.workspace_id)
                    .or_default()
                    .insert(native);
            }
        }
        let provider = agentkib_conversations::provider(agentkib_core::AgentKind::Codex)
            .context("provider-unavailable")?;
        let mut aliases = BTreeSet::new();
        for (workspace, natives) in workspaces {
            let Ok(candidates) = provider.list_sessions(&store.workspace_path(&workspace)?) else {
                continue;
            };
            for candidate in candidates {
                if provider
                    .verified_control_id(&candidate.native_ref)
                    .ok()
                    .flatten()
                    .is_some_and(|id| natives.contains(&id))
                {
                    aliases.insert(
                        store.conversation_id(
                            agentkib_core::AgentKind::Codex,
                            &candidate.native_ref,
                        )?,
                    );
                }
            }
        }
        Ok(aliases)
    }
    pub fn request(&mut self, value: Value, boot: &str, admin: bool) -> Result<Value> {
        let fingerprint = format!("{:x}", Sha256::digest(serde_json::to_vec(&value)?));
        let mut req: Request = serde_json::from_value(value)?;
        validate_device(req.device_id.as_deref())?;
        if req.operation == "options" {
            ensure!(admin, "managed-operation-required");
            return options(self);
        }
        ensure!(self.platform_supported(), "platform-unsupported");
        ensure!(
            if admin {
                matches!(
                    req.operation.as_str(),
                    "create"
                        | "adopt"
                        | "release"
                        | "reconcile"
                        | "resume"
                        | "steer"
                        | "queue-add"
                        | "queue-update"
                        | "queue-delete"
                        | "queue-reorder"
                        | "queue-start"
                        | "rename"
                        | "archive"
                        | "unarchive"
                        | "fork"
                        | "settings"
                        | "settings-state"
                        | "usage"
                        | "goal"
                        | "resources"
                        | "goal-set"
                        | "goal-pause"
                        | "goal-resume"
                        | "goal-clear"
                )
            } else {
                matches!(
                    req.operation.as_str(),
                    "live"
                        | "events"
                        | "send"
                        | "stop"
                        | "approve"
                        | "answer"
                        | "capabilities"
                        | "inspect"
                        | "queue-list"
                        | "resume"
                        | "steer"
                        | "queue-add"
                        | "queue-update"
                        | "queue-delete"
                        | "queue-reorder"
                        | "queue-start"
                        | "rename"
                        | "archive"
                        | "unarchive"
                        | "fork"
                        | "settings"
                        | "settings-state"
                        | "usage"
                        | "goal"
                        | "resources"
                        | "goal-set"
                        | "goal-pause"
                        | "goal-resume"
                        | "goal-clear"
                )
            },
            "managed-operation-unsupported"
        );
        if req.operation == "capabilities" {
            return self.capabilities(
                req.session_id.as_deref().context("missing-session")?,
                boot,
                req.experimental_enabled,
            );
        }
        if req.operation == "inspect" {
            return self.inspect(req.session_id.as_deref().context("missing-session")?, boot);
        }
        if matches!(
            req.operation.as_str(),
            "settings-state" | "usage" | "goal" | "resources"
        ) {
            ensure!(admin, "managed-operation-required");
            return self.read_extended(
                req.session_id.as_deref().context("missing-session")?,
                req.operation.as_str(),
                boot,
            );
        }
        let ledger = self.ledger()?;
        if !matches!(req.operation.as_str(), "live" | "events" | "queue-list")
            && let Some(previous) = ledger.replay(valid_request_id(&req)?, &fingerprint)?
        {
            return Ok(previous);
        }
        if req.operation == "resume"
            && ledger
                .get(req.session_id.as_deref().context("missing-session")?)?
                .is_none()
        {
            ensure!(
                req.experimental_enabled && req.runtime_boot_id.as_deref() == Some(boot),
                "stale-or-disabled-control"
            );
            req.operation = "adopt".into();
        }
        if req.operation == "create" || req.operation == "adopt" {
            return self.create(req, &fingerprint, boot, &ledger);
        }
        let id = req.session_id.as_deref().context("missing-session")?;
        let record = ledger.get(id)?.context("session-unavailable")?;
        self.validate_access(&record)?;
        if req.operation == "events" {
            return ledger.events(id, req.cursor.as_deref(), req.limit.unwrap_or(50));
        }
        if req.operation == "live" {
            return self.snapshot(&record, boot, req.experimental_enabled, &ledger);
        }
        if req.operation == "queue-list" {
            let runner = self.runners.get(id).context("recovery-required")?;
            return completion::queue(
                &runner.client,
                record
                    .native_id
                    .as_deref()
                    .context("native-session-unconfirmed")?,
            );
        }
        let request_id = valid_request_id(&req)?;
        if let Some(previous) = ledger.claim(
            request_id,
            id,
            &fingerprint,
            req.device_id.as_deref(),
            &command_context(&req, boot, &record.workspace_id),
        )? {
            return Ok(previous);
        }
        let outcome = (|| {
            if req.operation == "release" {
                // Explicit release terminates only our dedicated child and its descendants.
                if let Some(mut runner) = self.runners.remove(id) {
                    runner.state.lock().unwrap().record.released = true;
                    runner.client.shutdown();
                }
                let mut record = ledger.get(id)?.context("session-unavailable")?;
                record.released = true;
                record.snapshot["status"] = json!("released");
                record.snapshot["sendEnabled"] = json!(false);
                ledger.save(&record)?;
                return Ok(
                    json!({"sessionId":id,"released":true,"accepted":true,"completed":true,"requestId":request_id,"runtimeBootId":boot}),
                );
            }
            if req.operation == "resume" {
                ensure!(req.handoff_confirmed, "handoff-confirmation-required");
                ensure!(!ledger.has_unknown(id)?, "control-outcome-unconfirmed");
                ensure!(
                    req.experimental_enabled && req.runtime_boot_id.as_deref() == Some(boot),
                    "stale-or-disabled-control"
                );
                ensure!(record.native_id.is_some(), "native-session-unconfirmed");
                ensure!(!record.archived, "session-archived");
                ensure!(
                    !self.runners.get(id).is_some_and(|r| r.client.connected()),
                    "session-already-managed"
                );
                self.runners.remove(id);
                let mut resumed = record.clone();
                resumed.released = false;
                let runner =
                    self.attach(resumed, None, None, &ledger, || ledger.dispatch(request_id))?;
                let live = runner.state.lock().unwrap().snapshot(boot, true);
                self.runners.insert(id.into(), runner);
                return Ok(
                    json!({"sessionId":id,"accepted":true,"completed":true,"live":live,"requestId":request_id,"runtimeBootId":boot}),
                );
            }
            if req.operation == "unarchive" {
                ensure!(
                    record.archived && !ledger.has_unknown(id)?,
                    "session-not-archived"
                );
                ensure!(
                    req.experimental_enabled && req.runtime_boot_id.as_deref() == Some(boot),
                    "stale-or-disabled-control"
                );
                let client = Client::spawn(
                    &self.executable()?,
                    &record.workspace,
                    &record.home,
                    None,
                    |_| {},
                )?;
                let native = record
                    .native_id
                    .as_deref()
                    .context("native-session-unconfirmed")?;
                client.request_with_dispatch(
                    "thread/unarchive",
                    json!({"threadId":native}),
                    || ledger.dispatch(request_id),
                )?;
                if let Some(mut runner) = self.runners.remove(id) {
                    runner.state.lock().unwrap().record.released = true;
                    runner.client.shutdown();
                }
                let mut restored = record.clone();
                restored.archived = false;
                restored.released = true;
                restored.snapshot["status"] = json!("released");
                restored.snapshot["reason"] = json!("session-released");
                ledger.save(&restored)?;
                return Ok(
                    json!({"sessionId":id,"accepted":true,"completed":true,"requestId":request_id,"runtimeBootId":boot,"requiresResume":true}),
                );
            }
            if req.operation == "reconcile" {
                ensure!(!record.archived, "session-archived");
                ensure!(!record.released, "session-released");
                if record.native_id.is_none() {
                    return Ok(
                        json!({"sessionId":id,"reconciled":false,"reason":"native-session-unconfirmed"}),
                    );
                }
                if self.runners.get(id).is_some_and(|r| !r.client.connected()) {
                    self.runners.remove(id);
                }
                if !self.runners.contains_key(id) {
                    match self.attach(record.clone(), None, None, &ledger, || Ok(())) {
                        Ok(runner) => {
                            self.runners.insert(id.into(), runner);
                        }
                        Err(_) => {
                            return Ok(
                                json!({"sessionId":id,"reconciled":false,"reason":"native-resume-unavailable"}),
                            );
                        }
                    }
                }
                let runner = self.runners.get(id).context("session-unavailable")?;
                let native = record
                    .native_id
                    .as_deref()
                    .context("native-session-unconfirmed")?;
                let response = runner.client.request(
                    "thread/read",
                    json!({"threadId":native,"includeTurns":true}),
                )?;
                ensure!(
                    response["thread"]["id"] == native,
                    "thread-identity-mismatch"
                );
                let unknown = ledger.unknown(id)?;
                if !unknown.iter().all(|(request, evidence)| {
                    settings_evidence_matches(evidence, &record)
                        || reconciles(request, evidence, &response["thread"])
                }) {
                    return Ok(
                        json!({"sessionId":id,"reconciled":false,"reason":"control-outcome-unconfirmed"}),
                    );
                }
                for (request, _) in unknown {
                    ledger.finish(&request,&json!({"accepted":true,"completed":false,"reconciled":true,"requestId":request,"runtimeBootId":boot,"sessionId":id}))?;
                }
                let mut state = runner
                    .state
                    .lock()
                    .map_err(|_| anyhow::anyhow!("state-unavailable"))?;
                if state.turn.is_none() {
                    state.hydrate(&response["thread"], &ledger)?;
                } else if state.reason.as_deref() == Some("control-outcome-unconfirmed") {
                    state.reason = None;
                    state.status = if !state.questions.is_empty() {
                        "waiting-input"
                    } else if !state.approvals.is_empty() {
                        "awaiting-approval"
                    } else {
                        "running"
                    }
                    .into();
                    state.revision += 1;
                    state.save(&ledger)?;
                }
                return Ok(
                    json!({"sessionId":id,"reconciled":state.reason.is_none(),"live":state.snapshot(boot,true)}),
                );
            }
            ensure!(
                req.experimental_enabled && req.runtime_boot_id.as_deref() == Some(boot),
                "stale-or-disabled-control"
            );
            ensure!(
                !record.released && !ledger.has_unknown(id)?,
                "control-outcome-unconfirmed"
            );
            if req.operation == "fork" {
                ensure!(self.runners.len() < 8, "managed-session-limit");
                let runner = self.runners.get(id).context("recovery-required")?;
                {
                    let state = runner.state.lock().unwrap();
                    ensure!(
                        state.status == "idle"
                            && state.reason.is_none()
                            && req.expected_revision == Some(state.revision),
                        "session-busy"
                    );
                }
                let source = record
                    .native_id
                    .as_deref()
                    .context("native-session-unconfirmed")?;
                let history = runner.client.request(
                    "thread/read",
                    json!({"threadId":source,"includeTurns":true}),
                )?;
                let turn = history["thread"]["turns"]
                    .as_array()
                    .and_then(|t| t.last())
                    .context("no-completed-turn")?;
                ensure!(
                    matches!(
                        turn["status"].as_str(),
                        Some("completed" | "interrupted" | "failed")
                    ),
                    "session-busy"
                );
                let turn_id = turn["id"].as_str().context("no-completed-turn")?;
                let child_id =
                    format!("{:x}", Sha256::digest(format!("managed-fork:{request_id}")));
                let mut child = record.clone();
                child.id = child_id.clone();
                child.source_session_id = Some(record.id.clone());
                child.native_id = None;
                child.adopted = false;
                child.released = false;
                child.archived = false;
                child.created_at = Utc::now().to_rfc3339();
                child.snapshot = json!({"status":"starting","revision":0});
                ledger.save(&child)?;
                let child_runner = self.attach_native(
                    child,
                    None,
                    None,
                    &ledger,
                    Some((source, turn_id)),
                    || ledger.dispatch(request_id),
                )?;
                let live = child_runner.state.lock().unwrap().snapshot(boot, true);
                self.runners.insert(child_id.clone(), child_runner);
                return Ok(
                    json!({"accepted":true,"completed":true,"sessionId":child_id,"sourceSessionId":id,"requestId":request_id,"runtimeBootId":boot,"live":live}),
                );
            }
            let runner = self.runners.get(id).context("recovery-required")?;
            if matches!(req.operation.as_str(), "queue-update" | "queue-reorder") {
                let queue = completion::queue(
                    &runner.client,
                    record
                        .native_id
                        .as_deref()
                        .context("native-session-unconfirmed")?,
                )?;
                ensure!(queue["complete"] == true, "queue-too-large");
                if req.operation == "queue-update" {
                    let row = queue["data"]
                        .as_array()
                        .and_then(|a| {
                            a.iter()
                                .find(|q| q["id"].as_str() == req.queued_submission_id.as_deref())
                        })
                        .context("queued-submission-unavailable")?;
                    ensure!(
                        row["input"].as_array().is_some_and(|a| a.len() == 1
                            && a[0]["type"] == "text"
                            && a[0]["text"]
                                .as_str()
                                .is_some_and(|s| !s.starts_with("User attached file "))),
                        "queue-attachments-edit-unsupported"
                    );
                } else {
                    let expected = queue["data"]
                        .as_array()
                        .context("invalid-native-queue")?
                        .iter()
                        .filter_map(|q| q["id"].as_str())
                        .collect::<BTreeSet<_>>();
                    let actual = req
                        .queued_submission_ids
                        .as_ref()
                        .context("missing-queue-order")?
                        .iter()
                        .map(String::as_str)
                        .collect::<BTreeSet<_>>();
                    ensure!(expected == actual, "stale-queue-order");
                }
            }
            let available_models = if req.operation == "settings" {
                Some(model_catalog(&runner.client)?)
            } else {
                None
            };
            let available_modes = if (req.operation == "settings" && req.mode.is_some())
                || (req.operation == "send" && record.mode.is_some())
            {
                Some(collaboration_mode_catalog(runner)?)
            } else {
                None
            };
            if req.operation == "settings" {
                let mut state = runner
                    .state
                    .lock()
                    .map_err(|_| anyhow::anyhow!("state-unavailable"))?;
                ensure!(
                    state.reason.is_none()
                        && state.status == "idle"
                        && req.expected_revision == Some(state.revision),
                    "stale-or-disabled-control"
                );
                let selected = completion::select_settings(
                    &req,
                    &state.record,
                    available_models.as_deref().context("models-unavailable")?,
                    available_modes.as_deref(),
                )?;
                let mut evidence = command_context(&req, boot, &record.workspace_id);
                evidence["settings"] = settings_evidence(&selected);
                ledger.annotate(request_id, &evidence)?;
                ledger.dispatch(request_id)?;
                state.record.model = selected.model;
                state.record.effort = selected.effort;
                state.record.service_tier = selected.service_tier;
                state.record.policy_id = selected.policy_id;
                state.record.mode = selected.mode;
                state.revision += 1;
                state.save(&ledger)?;
                return Ok(json!({
                    "accepted":true,
                    "completed":true,
                    "appliesTo":"next-turn",
                    "sessionId":id,
                    "requestId":request_id,
                    "runtimeBootId":boot
                }));
            }
            let (method, params, response_id) = {
                let state = runner
                    .state
                    .lock()
                    .map_err(|_| anyhow::anyhow!("state-unavailable"))?;
                ensure!(
                    state.reason.is_none() && req.expected_revision == Some(state.revision),
                    "stale-or-disabled-control"
                );
                let native = state
                    .record
                    .native_id
                    .as_ref()
                    .context("missing-native-session")?;
                match req.operation.as_str() {
                    "send" => {
                        let input = completion::input_with_resources(
                            &req,
                            Some(&record),
                            Some(&runner.client),
                        )?;
                        ensure!(state.status == "idle", "session-busy");
                        let mut params = json!({"threadId":native,"clientUserMessageId":request_id,"input":input});
                        apply_policy_params(&mut params, &state.record)?;
                        if let Some(model) = state.record.model.as_deref() {
                            params["model"] = json!(model);
                        }
                        if let Some(effort) = state.record.effort.as_deref() {
                            params["effort"] = json!(effort);
                        }
                        if let Some(tier) = state.record.service_tier.as_deref() {
                            params["serviceTier"] = json!(tier);
                        }
                        if let Some(mode) = state.record.mode.as_deref() {
                            let modes = available_modes
                                .as_ref()
                                .context("native-collaboration-modes-unavailable")?;
                            ensure!(
                                modes.iter().any(|entry| entry["id"] == mode),
                                "unsupported-collaboration-mode"
                            );
                            params["collaborationMode"] = json!({"mode":mode,"settings":{
                                "model":state.record.model.as_deref().context("model-required")?,
                                "reasoning_effort":state.record.effort,"developer_instructions":null}});
                        }
                        ("turn/start", params, None)
                    }
                    "stop" => {
                        ensure!(
                            req.turn_id.as_deref() == state.turn.as_deref() && state.turn.is_some(),
                            "stale-turn"
                        );
                        (
                            "turn/interrupt",
                            json!({"threadId":native,"turnId":state.turn}),
                            None,
                        )
                    }
                    "approve" => {
                        let aid = req.approval_id.as_ref().context("missing-approval")?;
                        let a = state
                            .approvals
                            .get(&aid.to_string())
                            .context("approval-no-longer-pending")?;
                        ensure!(
                            a["supported"] == true
                                && req.turn_id.as_deref() == state.turn.as_deref(),
                            "unsupported-approval"
                        );
                        let decision = req
                            .native_decision
                            .clone()
                            .or_else(|| req.decision.as_ref().map(|d| json!(d)))
                            .context("missing-decision")?;
                        let offered = a["decisionOptions"].as_array().is_some_and(|options| {
                            options.iter().any(|o| o["decision"] == decision)
                        });
                        let legacy = decision.is_string()
                            && a["availableDecisions"]
                                .as_array()
                                .is_some_and(|options| options.contains(&decision));
                        ensure!(offered || legacy, "unsupported-decision");
                        let response = if a["method"] == "item/permissions/requestApproval" {
                            decision
                        } else {
                            json!({"decision":decision})
                        };
                        ("", response, Some(aid.clone()))
                    }
                    "answer" => {
                        let qid = req.question_id.as_ref().context("missing-question")?;
                        let q = state
                            .questions
                            .get(&qid.to_string())
                            .context("question-no-longer-pending")?;
                        ensure!(
                            q["supported"] == true
                                && req.turn_id.as_deref() == state.turn.as_deref(),
                            "unsupported-question"
                        );
                        (
                            "",
                            answer_payload(q, req.answers.as_ref().context("missing-answers")?)?,
                            Some(qid.clone()),
                        )
                    }
                    _ => completion::operation(
                        &req,
                        &record,
                        &state,
                        available_models.as_deref(),
                        &runner.client,
                    )?,
                }
            };
            self.validate_access(&record)?;
            {
                let state = runner
                    .state
                    .lock()
                    .map_err(|_| anyhow::anyhow!("state-unavailable"))?;
                ensure!(
                    state.reason.is_none() && req.expected_revision == Some(state.revision),
                    "stale-or-disabled-control"
                );
                ledger.dispatch(request_id)?;
            }

            if let Some(response_id) = response_id {
                runner.client.respond(response_id, params)?;
                // A successful pipe enqueue is not a native approval acknowledgement. Wait
                // for serverRequest/resolved before committing the command receipt.
                let until = Instant::now() + Duration::from_secs(12);
                loop {
                    let state = runner.state.lock().unwrap();
                    let response_key = if req.operation == "approve" {
                        req.approval_id.as_ref().unwrap()
                    } else {
                        req.question_id.as_ref().unwrap()
                    }
                    .to_string();
                    if state.resolved_requests.contains(&format!(
                        "{}:{response_key}",
                        req.turn_id.as_deref().unwrap_or_default()
                    )) {
                        break;
                    }
                    ensure!(
                        state.reason.is_none() && Instant::now() < until,
                        "control-outcome-unconfirmed"
                    );
                    drop(state);
                    std::thread::sleep(Duration::from_millis(15));
                }
            } else {
                let goal_revision = runner.state.lock().unwrap().goal_revision;
                let result = runner.client.request(method, params)?;
                if matches!(
                    req.operation.as_str(),
                    "goal-set" | "goal-pause" | "goal-resume"
                ) {
                    let goal = result
                        .get("goal")
                        .filter(|goal| goal.is_object())
                        .context("native-goal-unconfirmed")?;
                    let mut state = runner.state.lock().unwrap();
                    let mut acknowledged = state.clone();
                    acknowledged.record.goal = Some(goal.clone());
                    ensure!(
                        completion::mutation_confirmed(&req, &acknowledged),
                        "native-goal-unconfirmed"
                    );
                    // Events read after the request may already contain a later
                    // native goal transition. Do not rewind them to the receipt.
                    if state.goal_revision == goal_revision {
                        state.record.goal = Some(goal.clone());
                        state.revision += 1;
                        state.save(&ledger)?;
                    }
                }
                if matches!(req.operation.as_str(), "settings" | "goal-clear") {
                    let until = Instant::now() + Duration::from_secs(12);
                    loop {
                        let state = runner.state.lock().unwrap();
                        if completion::mutation_confirmed(&req, &state) {
                            break;
                        }
                        ensure!(
                            state.reason.is_none() && Instant::now() < until,
                            "control-outcome-unconfirmed"
                        );
                        drop(state);
                        std::thread::sleep(Duration::from_millis(15));
                    }
                }
                if !matches!(
                    req.operation.as_str(),
                    "send" | "stop" | "steer" | "queue-start"
                ) {
                    return completion::finish(&req, runner, &ledger, result, boot);
                }
                if matches!(req.operation.as_str(), "send" | "queue-start") {
                    let mut state = runner.state.lock().unwrap();
                    let turn = result["turn"]["id"].as_str().context("unconfirmed-turn")?;
                    if state.revision == req.expected_revision.unwrap_or(u64::MAX)
                        && state.turn.is_none()
                        && state.status == "idle"
                        && result["turn"]["status"] == "inProgress"
                    {
                        state.turn = Some(turn.into());
                        state.status = "running".into();
                        state.revision += 1;
                        state.save(&ledger)?;
                    }
                }
            }
            Ok(
                json!({"accepted":true,"completed":false,"sessionId":id,"requestId":request_id,"runtimeBootId":boot}),
            )
        })();
        match outcome {
            Ok(value) => {
                ledger.finish(request_id, &value)?;
                Ok(value)
            }
            Err(error) => {
                if error.to_string() == "codex-owner-busy" {
                    let result = json!({"accepted":false,"completed":false,"controlOutcome":"not-dispatched","requestId":request_id,"runtimeBootId":boot,"error":"codex-owner-busy"});
                    ledger.finish(request_id, &result)?;
                    return Ok(result);
                }
                if ledger.has_unknown(id)? {
                    if let Some(r) = self.runners.get(id) {
                        let mut state = r.state.lock().unwrap();
                        state.fail("control-outcome-unconfirmed");
                        state.save(&ledger)?;
                    }
                    return Err(error);
                }
                let safe_error = match error.to_string().as_str() {
                    "settings-not-applied" => "settings-not-applied",
                    "goal-already-exists" => "goal-already-exists",
                    "goal-state-changed" => "goal-state-changed",
                    "native-collaboration-modes-unavailable" | "unsupported-collaboration-mode" => {
                        "native-collaboration-modes-unavailable"
                    }
                    _ => "control_preflight_rejected",
                };
                let result = json!({"accepted":false,"completed":false,"controlOutcome":"not-dispatched","requestId":request_id,"runtimeBootId":boot,"error":safe_error});
                ledger.finish(request_id, &result)?;
                Ok(result)
            }
        }
    }
    fn snapshot(
        &self,
        record: &Record,
        boot: &str,
        controls: bool,
        ledger: &Ledger,
    ) -> Result<Value> {
        if let Some(runner) = self.runners.get(&record.id) {
            let state = runner
                .state
                .lock()
                .map_err(|_| anyhow::anyhow!("state-unavailable"))?;
            return Ok(state.snapshot(boot, controls && !ledger.has_unknown(&record.id)?));
        }
        let mut snapshot = record.snapshot.clone();
        snapshot["settings"] = state::settings_projection(record);
        snapshot["settings"]["applicationStatus"] = json!("unknown");
        snapshot["sessionId"] = json!(record.id);
        snapshot["workspaceId"] = json!(record.workspace_id);
        snapshot["runtimeBootId"] = json!(boot);
        snapshot["executionMode"] = json!("codex-managed");
        snapshot["sendEnabled"] = json!(false);
        snapshot["stopEnabled"] = json!(false);
        snapshot["approvals"] = json!([]);
        snapshot["questions"] = json!([]);
        snapshot["status"] = json!(if record.archived {
            "archived"
        } else if record.released {
            "released"
        } else {
            "outcome-unknown"
        });
        snapshot["reason"] = json!(if record.archived {
            "session-archived"
        } else if record.released {
            "session-released"
        } else {
            "recovery-required"
        });
        Ok(snapshot)
    }
    fn create(
        &mut self,
        req: Request,
        fingerprint: &str,
        boot: &str,
        ledger: &Ledger,
    ) -> Result<Value> {
        let request_id = valid_request_id(&req)?;
        ensure!(
            req.policy_id
                .as_deref()
                .is_none_or(|p| matches!(p, POLICY | POLICY_FULL_ACCESS | POLICY_AUTO_REVIEW)),
            "unsupported-policy"
        );
        ensure!(req.text.is_none(), "send-first-message-separately");
        ensure!(self.runners.len() < 8, "managed-session-limit");
        let store = self.store()?;
        let adopt = req.operation == "adopt";
        let (id, workspace_id, native, title) = if adopt {
            ensure!(req.handoff_confirmed, "handoff-confirmation-required");
            let id = req.session_id.as_ref().context("missing-session")?;
            let session = store
                .get_conversation_session(id)?
                .context("session-unavailable")?;
            ensure!(
                session.agent == agentkib_core::AgentKind::Codex && !session.sidechain,
                "session-not-adoptable"
            );
            ensure!(
                ledger.get(id)?.is_none_or(|r| r.released),
                "session-already-managed"
            );
            let workspace = store.workspace_path(&session.workspace_id)?;
            let provider =
                agentkib_conversations::provider(session.agent).context("provider-unavailable")?;
            let candidate = provider
                .list_sessions(&workspace)?
                .into_iter()
                .find(|c| {
                    store
                        .conversation_id(session.agent, &c.native_ref)
                        .is_ok_and(|s| s == *id)
                })
                .context("session-unavailable")?;
            let native = provider
                .verified_control_id(&candidate.native_ref)?
                .context("unverified-session")?;
            ensure!(!ledger.list()?.iter().any(|r| (!r.released || !r.adopted) && r.native_id.as_deref()==Some(&native)), "session-already-managed");
            (
                id.clone(),
                session.workspace_id,
                Some(native),
                session.title.unwrap_or_else(|| "Codex".into()),
            )
        } else {
            (
                format!("{:x}", Sha256::digest(format!("managed:{request_id}"))),
                req.workspace_id.clone().context("missing-workspace")?,
                None,
                "Codex".into(),
            )
        };
        if let Some(previous) = ledger.claim(
            request_id,
            &id,
            fingerprint,
            req.device_id.as_deref(),
            &command_context(&req, boot, &workspace_id),
        )? {
            return Ok(previous);
        }
        let workspace = store.workspace_path(&workspace_id)?.canonicalize()?;
        let home = self.home()?;
        let record = Record {
            id: id.clone(),
            workspace_id,
            workspace,
            home,
            native_id: native,
            model: req.model.clone(),
            effort: req.effort.clone(),
            service_tier: req.service_tier.clone(),
            policy_id: req.policy_id.clone().unwrap_or_else(|| POLICY.into()),
            default_model: None,
            default_effort: None,
            default_service_tier: None,
            token_usage: None,
            goal: None,
            native_settings: None,
            title,
            archived: false,
            mode: None,
            source_session_id: None,
            created_at: Utc::now().to_rfc3339(),
            released: false,
            adopted: adopt,
            snapshot: json!({"status":"starting","revision":0,"approvals":[],"questions":[]}),
        };
        ledger.save(&record)?;
        let mut dispatched = false;
        let result = self.attach(
            record.clone(),
            req.model.as_deref(),
            req.effort.as_deref(),
            ledger,
            || {
                ledger.dispatch(request_id)?;
                dispatched = true;
                Ok(())
            },
        );
        match result {
            Ok(runner) => {
                let live = runner.state.lock().unwrap().snapshot(boot, true);
                self.runners.insert(id.clone(), runner);
                let response = json!({"sessionId":id,"accepted":true,"completed":true,"requestId":request_id,"runtimeBootId":boot,"live":live});
                ledger.finish(request_id, &response)?;
                Ok(response)
            }
            Err(error) => {
                let definite = error.to_string() == "codex-owner-busy" || !dispatched;
                let mut record = ledger.get(&id)?.unwrap_or(record);
                record.snapshot["status"] = json!(if definite {
                    "unsupported"
                } else {
                    "outcome-unknown"
                });
                record.snapshot["reason"] = json!(if definite {
                    error.to_string()
                } else {
                    "control-outcome-unconfirmed".into()
                });
                if definite {
                    record.released = true;
                }
                ledger.save(&record)?;
                let response = json!({"sessionId":id,"accepted":false,"completed":false,"requestId":request_id,"runtimeBootId":boot,"controlOutcome":if definite{"not-dispatched"}else{"unknown"},"reason":if definite{error.to_string()}else{"control-outcome-unconfirmed".into()}});
                if definite {
                    ledger.finish(request_id, &response)?;
                }
                Ok(response)
            }
        }
    }
    fn attach(
        &self,
        record: Record,
        model: Option<&str>,
        effort: Option<&str>,
        ledger: &Ledger,
        dispatch: impl FnOnce() -> Result<()>,
    ) -> Result<Runner> {
        self.attach_native(record, model, effort, ledger, None, dispatch)
    }
    fn attach_native(
        &self,
        mut record: Record,
        model: Option<&str>,
        effort: Option<&str>,
        ledger: &Ledger,
        fork: Option<(&str, &str)>,
        dispatch: impl FnOnce() -> Result<()>,
    ) -> Result<Runner> {
        self.validate_access(&record)?;
        let (executable, version) = self.executable_info()?;
        let plan_verified = version == "codex-cli 0.155.1";
        let model = model.or(record.model.as_deref());
        let effort = effort.or(record.effort.as_deref());
        let lease = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(ledger.lock_path(&record.id))?;
        lease
            .try_lock()
            .context("session-managed-by-another-runtime")?;
        let state = Arc::new(Mutex::new(State::new(record.clone())));
        let events = state.clone();
        let event_ledger = ledger.clone();
        let client = Client::spawn(
            &executable,
            &record.workspace,
            &record.home,
            Some(lease),
            move |value| {
                let mut state = events.lock().unwrap_or_else(|p| p.into_inner());
                if state.event(value, &event_ledger).is_err() {
                    state.fail("invalid-codex-event");
                    let _ = state.save(&event_ledger);
                }
            },
        )?;
        let models = model_catalog(&client)?;
        if let Some(default) = models.iter().find(|entry| entry["isDefault"] == true) {
            record.default_model = default["id"].as_str().map(str::to_owned);
            record.default_effort = default["defaultEffort"].as_str().map(str::to_owned);
            record.default_service_tier = default["defaultServiceTier"].as_str().map(str::to_owned);
        }
        if let Some(model) = model {
            let entry = models
                .iter()
                .find(|m| m["id"] == model)
                .context("unsupported-model")?;
            if let Some(effort) = effort {
                ensure!(
                    entry["efforts"]
                        .as_array()
                        .is_some_and(|v| v.contains(&json!(effort))),
                    "unsupported-effort"
                )
            }
        } else {
            ensure!(effort.is_none(), "effort-requires-model")
        }
        if let Some(tier) = record.service_tier.as_deref() {
            let selected = model
                .and_then(|model| models.iter().find(|entry| entry["id"] == model))
                .or_else(|| models.iter().find(|entry| entry["isDefault"] == true))
                .context("model-required")?;
            ensure!(
                selected["serviceTiers"]
                    .as_array()
                    .is_some_and(|tiers| tiers.iter().any(|entry| entry["id"] == tier)),
                "unsupported-service-tier"
            );
        }
        if let Some(native) = record.native_id.as_ref() {
            // Read is non-owning. Never resume an active goal: it can create a new turn.
            let goal = client.request("thread/goal/get", json!({"threadId":native}))?;
            ensure!(
                goal["goal"].is_null() || goal["goal"]["status"] != "active",
                "pause-original-goal-before-handoff"
            );
            record.goal = goal.get("goal").filter(|goal| goal.is_object()).cloned();
        }
        let mut params = json!({"cwd":record.workspace,"config":{}});
        apply_policy_params(&mut params, &record)?;
        if let Some(model) = model {
            params["model"] = json!(model)
        }
        if let Some(effort) = effort {
            params["config"]["model_reasoning_effort"] = json!(effort)
        }
        if let Some(tier) = record.service_tier.as_deref() {
            params["serviceTier"] = json!(tier)
        }
        let method = if let Some((source, last_turn)) = fork {
            params["threadId"] = json!(source);
            params["lastTurnId"] = json!(last_turn);
            params["deferGoalContinuation"] = json!(true);
            "thread/fork"
        } else if let Some(native) = &record.native_id {
            params["threadId"] = json!(native);
            "thread/resume"
        } else {
            "thread/start"
        };
        self.validate_access(&record)?;
        let response = client.request_with_dispatch(method, params, dispatch)?;
        verify_policy_response(&record, &response)?;
        ensure!(
            response["cwd"].as_str().is_some_and(
                |p| Path::new(p).canonicalize().ok().as_ref() == Some(&record.workspace)
            ),
            "codex-workspace-mismatch"
        );
        ensure!(
            response["thread"]["environments"]
                .as_array()
                .is_none_or(|envs| envs.iter().all(|env| env
                    .get("id")
                    .or_else(|| env.get("environmentId"))
                    .is_some_and(|id| id == "local"))),
            "remote-environment-not-supported"
        );
        // The native response resolves host defaults, including for legacy records
        // that did not persist a model. Never guess them from model/list ordering.
        let actual_model = response["model"]
            .as_str()
            .filter(|model| !model.is_empty() && model.len() <= 256)
            .context("native-model-unconfirmed")?;
        let actual_effort = match &response["reasoningEffort"] {
            Value::Null => None,
            Value::String(effort) => Some(effort.as_str()),
            _ => bail!("native-effort-unconfirmed"),
        };
        let mut current = state.lock().unwrap();
        current.record.model = Some(actual_model.into());
        current.record.effort = actual_effort.map(str::to_owned);
        current.record.service_tier = normalized_service_tier(&response["serviceTier"]);
        // start/resume resolves these native fields but does not prove that a
        // previously selected collaboration mode was restored. Keep its pending
        // selection and wait for the native settings event on the next turn.
        current.record.native_settings = Some(json!({
            "model":actual_model,"effort":actual_effort,"serviceTier":response["serviceTier"],
            "approvalPolicy":response["approvalPolicy"],"approvalsReviewer":response["approvalsReviewer"],
            "sandboxPolicy":response["sandbox"],"collaborationMode":null
        }));
        current.record.goal = record.goal;
        current.record.default_model = record.default_model;
        current.record.default_effort = record.default_effort;
        current.record.default_service_tier = record.default_service_tier;
        current.hydrate(&response["thread"], ledger)?;
        drop(current);
        Ok(Runner {
            client,
            state,
            plan_verified,
        })
    }
}
fn native_context(thread: &Value, workspace: &Path) -> Result<Value> {
    let cwd = thread["cwd"]
        .as_str()
        .context("codex-context-unavailable")?;
    let cwd = Path::new(cwd)
        .canonicalize()
        .context("codex-context-unavailable")?;
    ensure!(
        cwd.starts_with(workspace),
        "codex-context-outside-workspace"
    );
    let bounded = |value: &Value, max: usize| {
        value
            .as_str()
            .filter(|text| {
                !text.is_empty() && text.len() <= max && !text.chars().any(char::is_control)
            })
            .map(str::to_owned)
    };
    Ok(json!({
        "available":true,
        "cwd":cwd,
        "projectId":bounded(&thread["projectId"],128),
        "branchAtCreation":bounded(&thread["gitInfo"]["branch"],256)
    }))
}

fn apply_policy_params(params: &mut Value, record: &Record) -> Result<()> {
    match record.policy_id.as_str() {
        POLICY => {
            params["approvalPolicy"] = json!("on-request");
            params["approvalsReviewer"] = json!("user");
            params["sandboxPolicy"] = json!({"type":"workspaceWrite","writableRoots":[record.workspace],"networkAccess":false});
            params["sandbox"] = json!("workspace-write");
            params["config"]["sandbox_workspace_write.network_access"] = json!(false);
            params["config"]["sandbox_workspace_write.writable_roots"] = json!([]);
        }
        POLICY_FULL_ACCESS => {
            params["approvalPolicy"] = json!("never");
            params["approvalsReviewer"] = json!("user");
            params["sandboxPolicy"] = json!({"type":"dangerFullAccess"});
            params["sandbox"] = json!("danger-full-access");
        }
        POLICY_AUTO_REVIEW => {
            params["approvalPolicy"] = json!("on-request");
            params["approvalsReviewer"] = json!("auto_review");
            params["sandboxPolicy"] = json!({"type":"workspaceWrite","writableRoots":[record.workspace],"networkAccess":false});
            params["sandbox"] = json!("workspace-write");
            params["config"]["sandbox_workspace_write.network_access"] = json!(false);
            params["config"]["sandbox_workspace_write.writable_roots"] = json!([]);
        }
        _ => bail!("unsupported-policy"),
    }
    Ok(())
}

fn normalized_service_tier(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|tier| !tier.is_empty() && *tier != "default")
        .map(str::to_owned)
}

fn settings_evidence(record: &Record) -> Value {
    json!({
        "model":record.model,
        "effort":record.effort,
        "serviceTier":record.service_tier,
        "policyId":record.policy_id,
        "mode":record.mode
    })
}

fn settings_evidence_matches(evidence: &Value, record: &Record) -> bool {
    let mut selected = settings_evidence(record);
    // Receipts from before collaboration-mode selection omitted this field.
    // They can only reconcile against a record with no explicit mode selection.
    if evidence["settings"].get("mode").is_none() && record.mode.is_none() {
        selected.as_object_mut().unwrap().remove("mode");
    }
    evidence["operation"] == "settings"
        && evidence["settings"].is_object()
        && evidence["settings"] == selected
}

fn verify_policy_response(record: &Record, response: &Value) -> Result<()> {
    let (approval, reviewer, sandbox, network) = match record.policy_id.as_str() {
        POLICY => ("on-request", "user", "workspaceWrite", Some(false)),
        POLICY_FULL_ACCESS => ("never", "user", "dangerFullAccess", None),
        POLICY_AUTO_REVIEW => ("on-request", "auto_review", "workspaceWrite", Some(false)),
        _ => bail!("unsupported-policy"),
    };
    ensure!(
        response["approvalPolicy"] == approval && response["approvalsReviewer"] == reviewer,
        "codex-policy-mismatch"
    );
    ensure!(
        response["sandbox"]["type"] == sandbox,
        "codex-sandbox-mismatch"
    );
    if let Some(network) = network {
        ensure!(
            response["sandbox"]["networkAccess"] == network,
            "codex-sandbox-mismatch"
        );
        ensure!(
            response["sandbox"]["writableRoots"]
                .as_array()
                .is_some_and(
                    |roots| roots.iter().all(|v| v.as_str().is_some_and(|p| Path::new(p)
                        .canonicalize()
                        .ok()
                        .as_ref()
                        == Some(&record.workspace)))
                ),
            "codex-writable-roots-mismatch"
        );
    }
    if let Some(tier) = record.service_tier.as_deref() {
        ensure!(
            response["serviceTier"] == tier,
            "codex-service-tier-mismatch"
        );
    }
    Ok(())
}

fn policy_settings_match(policy_id: &str, settings: &Value, workspace: &Path) -> bool {
    let (approval, reviewer, sandbox, network) = match policy_id {
        POLICY => ("on-request", "user", "workspaceWrite", Some(false)),
        POLICY_FULL_ACCESS => ("never", "user", "dangerFullAccess", None),
        POLICY_AUTO_REVIEW => ("on-request", "auto_review", "workspaceWrite", Some(false)),
        _ => return false,
    };
    if settings["approvalPolicy"] != approval
        || settings["approvalsReviewer"] != reviewer
        || settings["sandboxPolicy"]["type"] != sandbox
    {
        return false;
    }
    network.is_none_or(|network| {
        settings["sandboxPolicy"]["networkAccess"] == network
            && settings["sandboxPolicy"]["writableRoots"]
                .as_array()
                .is_some_and(|roots| {
                    roots.iter().all(|value| {
                        value.as_str().is_some_and(|path| {
                            Path::new(path).canonicalize().ok().as_ref()
                                == Some(&workspace.to_path_buf())
                        })
                    })
                })
    })
}

fn policy_id_from_settings(settings: &Value, workspace: &Path) -> Option<String> {
    [POLICY, POLICY_FULL_ACCESS, POLICY_AUTO_REVIEW]
        .into_iter()
        .find(|policy| policy_settings_match(policy, settings, workspace))
        .map(str::to_owned)
}
fn valid_request_id(req: &Request) -> Result<&str> {
    let id = req.request_id.as_deref().context("missing-request-id")?;
    uuid::Uuid::parse_str(id).context("invalid-request-id")?;
    Ok(id)
}
fn codex_home() -> Result<PathBuf> {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|p| p.join(".codex")))
        .context("codex-home-unavailable")?
        .canonicalize()
        .context("codex-home-unavailable")
}
fn verified_version(path: &Path) -> Result<String> {
    let mut child = Command::new(path)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let until = Instant::now() + Duration::from_secs(3);
    loop {
        if let Some(status) = child.try_wait()? {
            let mut version = String::new();
            child
                .stdout
                .take()
                .context("version-unavailable")?
                .take(4096)
                .read_to_string(&mut version)?;
            ensure!(
                status.success()
                    && matches!(
                        version.trim(),
                        "codex-cli 0.155.1" | "codex-cli 0.155.0-alpha.16.3"
                    ),
                "unsupported-codex-cli-version"
            );
            return Ok(version.trim().to_owned());
        }
        if Instant::now() >= until {
            let _ = child.kill();
            let _ = child.wait();
            bail!("codex-version-timeout")
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}
fn model_catalog(client: &Client) -> Result<Vec<Value>> {
    let result = client.request("model/list", json!({"limit":100}))?;
    Ok(result["data"].as_array().context("invalid-model-catalog")?.iter().filter(|m|m["hidden"]!=true).take(100).map(|m|json!({"id":m["model"],"name":m["displayName"],"isDefault":m["isDefault"],"defaultEffort":m["defaultReasoningEffort"],"defaultServiceTier":m["defaultServiceTier"],"efforts":m["supportedReasoningEfforts"].as_array().into_iter().flatten().map(|v|v["reasoningEffort"].clone()).collect::<Vec<_>>(),"serviceTiers":m["serviceTiers"].as_array().into_iter().flatten().take(16).map(|tier|json!({"id":tier["id"],"name":tier["name"],"description":tier["description"]})).collect::<Vec<_>>()})).collect())
}

fn policy_catalog() -> Value {
    json!([
        {"id":POLICY,"name":"Workspace write · ask when needed","description":"Can edit the workspace; risky actions still require user approval.","sandbox":"workspace-write","approvalPolicy":"on-request","networkAccess":false},
        {"id":POLICY_FULL_ACCESS,"name":"Full access · no approval prompts","description":"Can access the computer and network without prompting for approvals.","sandbox":"danger-full-access","approvalPolicy":"never","approvalsReviewer":"user","networkAccess":true},
        {"id":POLICY_AUTO_REVIEW,"name":"Workspace write · agent review","description":"Can edit the workspace; the native agent reviews approval requests.","sandbox":"workspace-write","approvalPolicy":"on-request","approvalsReviewer":"auto_review","networkAccess":false}
    ])
}

fn resources(client: &Client, workspace: &Path) -> Result<Value> {
    let result = client.request(
        "skills/list",
        json!({"cwds":[workspace],"forceReload":false}),
    )?;
    let mut skills = Vec::new();
    for entry in result["data"].as_array().into_iter().flatten() {
        let cwd = entry["cwd"]
            .as_str()
            .and_then(|p| Path::new(p).canonicalize().ok());
        if cwd.as_ref() != Some(&workspace.to_path_buf()) {
            continue;
        }
        for skill in entry["skills"].as_array().into_iter().flatten().take(256) {
            let Some(path) = skill["path"]
                .as_str()
                .and_then(|p| Path::new(p).canonicalize().ok())
            else {
                continue;
            };
            let Some(name) = skill["name"]
                .as_str()
                .filter(|name| !name.is_empty() && name.len() <= 256)
            else {
                continue;
            };
            let id = format!("{:x}", Sha256::digest(path.as_os_str().as_encoded_bytes()));
            skills.push(json!({"id":id,"name":name,"description":skill["description"],"enabled":skill["enabled"]==true,"scope":skill["scope"],"pluginId":skill["pluginId"]}));
        }
    }
    // Plugin/app discovery was added after the pinned managed protocol. Expose the
    // verified skill surface and fail closed for the newer catalogs.
    Ok(
        json!({"available":true,"executionMode":"codex-managed","skills":skills,"plugins":[],"apps":[],"contextReferences":{"supportedTypes":["computerPath","skill"],"unavailable":{"plugin":"unsupported-codex-cli-version","app":"unsupported-codex-cli-version"}}}),
    )
}
fn options(service: &Service) -> Result<Value> {
    if !service.platform_supported() {
        return Ok(
            json!({"available":false,"reason":"platform-unsupported","models":[],"policies":[]}),
        );
    }
    let result = (|| -> Result<Vec<Value>> {
        let executable = service.executable()?;
        let home = service.home()?;
        let client = Client::spawn(&executable, &home, &home, None, |_| {})?;
        model_catalog(&client)
    })();
    Ok(match result {
        Ok(models) => {
            let default = models
                .iter()
                .find(|model| model["isDefault"] == true)
                .cloned()
                .unwrap_or(Value::Null);
            json!({"available":true,"executionMode":"codex-managed","models":models,"defaults":{"model":default["id"],"effort":default["defaultEffort"],"serviceTier":default["defaultServiceTier"]},"policies":policy_catalog()})
        }
        Err(error) => {
            json!({"available":false,"reason":error.to_string(),"models":[],"policies":[]})
        }
    })
}
fn answer_payload(question: &Value, answers: &Value) -> Result<Value> {
    agentkib_codex_bridge::validate_native_answers(&question["questions"], answers)
}

fn reconciles(request: &str, evidence: &Value, thread: &Value) -> bool {
    match evidence["operation"].as_str() {
        Some("create" | "adopt") => thread["id"].as_str().is_some(),
        Some("send" | "steer" | "queue-add" | "queue-start") => thread["turns"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|t| t["items"].as_array().into_iter().flatten())
            .any(|item| item["type"] == "userMessage" && item["clientId"] == request),
        Some("stop") => thread["turns"].as_array().into_iter().flatten().any(|t| {
            t["id"] == evidence["turnId"]
                && matches!(
                    t["status"].as_str(),
                    Some("completed" | "interrupted" | "failed")
                )
        }),
        _ => false,
    }
}

#[cfg(all(test, unix))]
mod tests;

pub(super) fn validate_device(device: Option<&str>) -> Result<()> {
    ensure!(
        device.is_none_or(|id| !id.is_empty()
            && id.len() <= 256
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b':'))),
        "invalid-device-id"
    );
    Ok(())
}
fn command_context(req: &Request, boot: &str, workspace: &str) -> Value {
    json!({"operation":req.operation,"turnId":req.turn_id,"nativeRequestId":req.approval_id.as_ref().or(req.question_id.as_ref()),"runtimeBootId":boot,"expectedRevision":req.expected_revision,"executionMode":"codex-managed","workspaceId":workspace})
}

/// Called only after the Electron host resolves device-bound upload references.
pub(super) fn normalize_input(
    input: Option<&Value>,
    text: Option<&str>,
    resource_refs: Option<&[Value]>,
) -> Result<Value> {
    ensure!(
        resource_refs.is_none_or(<[Value]>::is_empty),
        "native-resource-unverified"
    );
    let request: Request =
        serde_json::from_value(json!({"operation":"send","input":input,"text":text}))?;
    completion::input(&request)
}

/// Only expose native modes with a verified turn/start mapping. The host's own
/// instructions are requested via developer_instructions:null, never copied.
fn collaboration_mode_catalog(runner: &Runner) -> Result<Vec<Value>> {
    ensure!(
        runner.plan_verified,
        "native-collaboration-modes-unavailable"
    );
    let response = runner.client.request("collaborationMode/list", json!({}))?;
    let entries = response["data"]
        .as_array()
        .context("invalid-collaboration-modes")?;
    let modes: Vec<_> = entries
        .iter()
        .filter_map(|entry| {
            let mode = entry["mode"].as_str()?;
            if !matches!(mode, "plan" | "default") {
                return None;
            }
            let name = entry["name"]
                .as_str()
                .filter(|name| !name.is_empty() && name.len() <= 256)?;
            Some(json!({"id":mode,"name":name}))
        })
        .collect();
    ensure!(!modes.is_empty(), "native-collaboration-modes-unavailable");
    Ok(modes)
}
