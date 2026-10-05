use crate::{Compatibility, Connection, Decision, SessionState, Status};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

const LIVE_OWNER_CHECK_INTERVAL: Duration = Duration::from_secs(2);
const LIVE_FULL_REFRESH_INTERVAL: Duration = Duration::from_secs(60);
const LIVE_DRAIN_BUDGET: Duration = Duration::from_millis(50);
const LIVE_DRAIN_LIMIT: usize = 32;

enum PollEvent {
    Empty,
    Notification,
    Resubscribed,
}

/// Opt-in, local-only facade. IDs/commands supplied by a caller are not forwarded verbatim.
pub struct Bridge {
    observer: Option<crate::state::StateObserver>,
    connection: Connection,
    compatibility: Compatibility,
    verify_installed: bool,
    controls_enabled: bool,
    selected: Option<SessionState>,
    endpoint: PathBuf,
    last_owner_check: Option<Instant>,
    last_full_refresh: Option<Instant>,
    resync_after_mutation: bool,
    acknowledged_state: Option<(Option<u64>, Status)>,
}

impl Bridge {
    pub fn connect_installed(socket: &Path) -> Result<Self> {
        let connection = Connection::connect(socket)?;
        let compatibility = connection
            .peer_executable()
            .map(Compatibility::for_router)
            .unwrap_or_default();
        ensure!(compatibility.is_known(), "unverified-installation");
        Ok(Self {
            observer: None,
            connection,
            compatibility,
            verify_installed: true,
            controls_enabled: false,
            selected: None,
            endpoint: socket.to_owned(),
            last_owner_check: None,
            last_full_refresh: None,
            resync_after_mutation: false,
            acknowledged_state: None,
        })
    }
    pub fn connect(socket: &Path, compatibility: Compatibility) -> Result<Self> {
        Ok(Self {
            observer: None,
            connection: Connection::connect(socket)?,
            compatibility,
            verify_installed: false,
            controls_enabled: false,
            selected: None,
            endpoint: socket.to_owned(),
            last_owner_check: None,
            last_full_refresh: None,
            resync_after_mutation: false,
            acknowledged_state: None,
        })
    }

    pub fn enable_controls(&mut self) -> Result<()> {
        ensure!(
            self.connection
                .peer_executable()
                .is_some_and(|p| self.compatibility.matches_router(p)),
            "unverified Codex installation or IPC router executable; read-only mode"
        );
        self.controls_enabled = true;
        Ok(())
    }

    pub fn disable_controls(&mut self) {
        self.controls_enabled = false;
    }
    pub fn state(&self) -> Option<&SessionState> {
        self.selected.as_ref()
    }
    pub fn needs_reconnect(&self) -> bool {
        !self.connection.is_connected()
            || self
                .selected
                .as_ref()
                .is_some_and(|state| state.revision().is_none())
    }

    /// An acknowledged write needs one read-only confirmation, even when the
    /// final native update arrived while waiting for the acknowledgement.
    pub fn needs_mutation_confirmation(&self) -> bool {
        self.acknowledged_state.is_some()
    }

    /// Re-establish only the read-only follower after an invalidated stream.
    /// No mutation is replayed, and a healthy outcome-unknown snapshot is retained.
    pub fn reconnect(&mut self) -> Result<()> {
        ensure!(self.needs_reconnect(), "session stream is still valid");
        let conversation = self
            .selected
            .as_ref()
            .context("no selected session")?
            .conversation
            .clone();
        let mut replacement = if self.verify_installed {
            Self::connect_installed(&self.endpoint)?
        } else {
            Self::connect(&self.endpoint, self.compatibility.clone())?
        };
        replacement.select(&conversation)?;
        replacement.observer = self.observer.clone();
        if let Some(state) = &mut replacement.selected {
            state.observer = replacement.observer.clone();
        }
        *self = replacement;
        if let Some(state) = &self.selected {
            state.notify_observer();
        }
        Ok(())
    }
    /// Called from the single socket consumer, including broadcasts received
    /// while a control request waits for its correlated response.
    pub fn set_observer(&mut self, observer: impl Fn(&SessionState) + Send + Sync + 'static) {
        let observer = std::sync::Arc::new(observer);
        self.observer = Some(observer.clone());
        if let Some(state) = &mut self.selected {
            state.observer = Some(observer);
            state.notify_observer();
        }
    }

    pub fn supports_thread_settings(&self) -> bool {
        self.compatibility.supports_thread_settings()
    }

    pub fn thread_settings(&self) -> Value {
        let Some(state) = self.selected.as_ref() else {
            return json!({"available":false,"reason":"state-unavailable"});
        };
        let Some(snapshot) = state.snapshot() else {
            return json!({"available":false,"reason":"state-unavailable"});
        };
        let saved = &snapshot["latestThreadSettings"];
        let supported = self.supports_thread_settings();
        let policy = follower_policy_id(saved);
        json!({
            "available": supported,
            "executionMode": "codex-follower",
            "settings": {
                // The owner snapshot is native evidence, unlike a client-side
                // next-turn selection waiting to be sent to app-server.
                "applicationStatus": if supported { "confirmed" } else { "unknown" },
                "current": {
                    "model": saved.get("model").unwrap_or(&snapshot["latestModel"]),
                    "effort": saved.get("effort").unwrap_or(&snapshot["latestReasoningEffort"]),
                    "mode": saved.get("collaborationMode").and_then(|value| value.get("mode")).unwrap_or(&snapshot["latestCollaborationMode"]["mode"]),
                    "serviceTier": saved.get("serviceTier").unwrap_or(&Value::Null),
                    "policyId": policy,
                },
                "defaults": {"model":null,"effort":null,"serviceTier":null},
                "writable": {
                    // The follower snapshot has the current values but no host
                    // model catalog. Do not accept arbitrary browser strings.
                    "model": false,
                    "effort": false,
                    "mode": supported,
                    "serviceTier": false,
                    "policy": supported,
                    "restoreDefaults": false,
                },
            },
            "collaborationModes": if supported {
                json!([{"id":"default","name":"Default"},{"id":"plan","name":"Plan"}])
            } else {
                json!([])
            },
            "policies": [
                {"id":"workspace-write-on-request","name":"Workspace write · ask when needed","description":"Can edit the workspace; risky actions still require user approval."},
                {"id":"full-access-on-request","name":"Full access · no approval prompts","description":"Can access the computer and network without prompting for approvals."},
                {"id":"workspace-write-auto-review","name":"Workspace write · agent review","description":"Can edit the workspace; the native agent reviews approval requests."}
            ],
            "revision": state.revision(),
            "reason": if supported{Value::Null}else{json!("follower-operation-unverified")},
        })
    }

    #[cfg(test)]
    pub(crate) fn force_live_checks_due(&mut self, full: bool) {
        self.last_owner_check = None;
        if full {
            self.last_full_refresh = None;
        }
    }

    pub fn select(&mut self, conversation: &str) -> Result<()> {
        ensure!(
            uuid::Uuid::parse_str(conversation).is_ok(),
            "select an explicit Codex conversation UUID"
        );
        self.unfollow();
        let response = self.connection.request(
            "thread-owner-discovery",
            json!({"hostId":"local", "conversationId":conversation}),
            None,
            |_| Ok(()),
        )?;
        let owner = response["handledByClientId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .context("no session owner found")?
            .to_owned();
        ensure!(owner != self.connection.client_id(), "cannot follow self");
        self.selected = Some(SessionState::new(conversation.into(), owner.clone()));
        self.selected.as_mut().unwrap().observer = self.observer.clone();
        let result = (|| {
            self.connection.broadcast(
                "thread-stream-following-changed",
                json!({"conversationId":conversation,"hostId":"local","following":true}),
                &owner,
            )?;
            let until = Instant::now() + Duration::from_secs(3);
            while Instant::now() < until {
                self.poll(until.saturating_duration_since(Instant::now()))?;
                if self
                    .selected
                    .as_ref()
                    .is_some_and(|s| s.revision().is_some())
                {
                    return Ok(());
                }
            }
            anyhow::bail!("no compatible owner snapshot received; read-only mode");
        })();
        if result.is_err() {
            self.invalidate(Status::Unsupported);
        } else {
            let now = Instant::now();
            self.last_owner_check = Some(now);
            self.last_full_refresh = Some(now);
            self.resync_after_mutation = false;
            self.acknowledged_state = None;
        }
        result
    }

    /// Reads the existing follower stream without asking the owner to serialize
    /// its full conversation on every Web live poll. Mutations still call refresh().
    pub fn observe_live(&mut self) -> Result<()> {
        let state = self.selected.as_ref().context("no selected session")?;
        if state.revision().is_none() {
            return self.select(&state.conversation.clone());
        }
        if self.resync_after_mutation
            || self
                .last_full_refresh
                .is_none_or(|at| at.elapsed() >= LIVE_FULL_REFRESH_INTERVAL)
        {
            return self.refresh();
        }
        let result = (|| {
            let before = self
                .selected
                .as_ref()
                .context("no selected session")?
                .snapshot_count;
            if self
                .last_owner_check
                .is_none_or(|at| at.elapsed() >= LIVE_OWNER_CHECK_INTERVAL)
            {
                let state = self.selected.as_ref().context("no selected session")?;
                let id = state.conversation.clone();
                let owner = state.owner.clone();
                let mut resubscribe_requested = false;
                let selected = &mut self.selected;
                let response = self.connection.request(
                    "thread-owner-discovery",
                    json!({"hostId":"local", "conversationId":id}),
                    None,
                    |message| {
                        let state = selected.as_mut().context("no selected session")?;
                        if following_status_requested(&message, state) {
                            resubscribe_requested = true;
                            Ok(())
                        } else {
                            state.notification(message)
                        }
                    },
                )?;
                ensure!(
                    response["handledByClientId"] == owner,
                    "session owner changed"
                );
                self.last_owner_check = Some(Instant::now());
                if resubscribe_requested {
                    return self.refresh();
                }
            }
            // Codex may publish several patches per turn. Consume a bounded
            // batch so a busy session does not fall further behind each poll.
            let drain_until = Instant::now() + LIVE_DRAIN_BUDGET;
            let mut resubscribed = false;
            for index in 0..LIVE_DRAIN_LIMIT {
                if Instant::now() >= drain_until {
                    break;
                }
                let timeout = if index == 0 {
                    Duration::from_millis(10)
                } else {
                    Duration::from_millis(1)
                };
                match self.poll_once(timeout)? {
                    PollEvent::Empty => break,
                    PollEvent::Notification => {}
                    PollEvent::Resubscribed => {
                        resubscribed = true;
                        break;
                    }
                }
            }
            if resubscribed {
                let until = Instant::now() + Duration::from_secs(3);
                while Instant::now() < until {
                    self.poll(until.saturating_duration_since(Instant::now()))?;
                    if self
                        .selected
                        .as_ref()
                        .is_some_and(|state| state.snapshot_count > before)
                    {
                        break;
                    }
                }
                ensure!(
                    self.selected
                        .as_ref()
                        .is_some_and(|state| state.snapshot_count > before),
                    "no compatible owner refresh snapshot received"
                );
            }
            let state = self.selected.as_ref().context("no selected session")?;
            ensure!(state.revision().is_some(), "session stream invalidated");
            if state.snapshot_count > before {
                self.last_full_refresh = Some(Instant::now());
            }
            Ok(())
        })();
        if result.is_err() {
            self.invalidate(Status::Unsupported);
        }
        result
    }

    pub fn refresh(&mut self) -> Result<()> {
        // Consume the pending confirmation once. Failure invalidates the read
        // stream and uses observation recovery; no control command is replayed.
        let acknowledged_state = self.acknowledged_state.take();
        let state = self.selected.as_ref().context("no selected session")?;
        let id = state.conversation.clone();
        if state.revision().is_none() {
            return self.select(&id);
        }
        let owner = state.owner.clone();
        let result = (|| {
            // Keep the stream intact: unsubscribe/resubscribe makes the owner
            // publish a new revision even when no conversation state changed.
            let selected = &mut self.selected;
            let response = self.connection.request(
                "thread-owner-discovery",
                json!({"hostId":"local", "conversationId":id}),
                None,
                |message| {
                    selected
                        .as_mut()
                        .context("no selected session")?
                        .notification(message)
                },
            )?;
            ensure!(
                response["handledByClientId"] == owner,
                "session owner changed"
            );
            let state = self.selected.as_ref().context("no selected session")?;
            ensure!(state.revision().is_some(), "session stream invalidated");
            let baseline = state.snapshot_count;
            self.connection.broadcast(
                "thread-stream-following-changed",
                json!({"conversationId":id,"hostId":"local","following":true}),
                &owner,
            )?;
            let until = Instant::now() + Duration::from_secs(3);
            while Instant::now() < until {
                self.poll(until.saturating_duration_since(Instant::now()))?;
                let state = self.selected.as_ref().context("no selected session")?;
                ensure!(state.revision().is_some(), "session stream invalidated");
                if state.snapshot_count > baseline {
                    return Ok(());
                }
            }
            anyhow::bail!("no compatible owner refresh snapshot received");
        })();
        if result.is_err() {
            self.invalidate(Status::Unsupported);
        } else {
            if let (Some((revision, status)), Some(state)) =
                (acknowledged_state, &mut self.selected)
                && state.revision() == revision
                && state.status == Status::OutcomeUnknown
            {
                // Equal-revision snapshots normally preserve the write fence.
                // Restore only a native state actually observed during this
                // acknowledged command, now confirmed by the owner snapshot.
                state.status = status;
                state.notify_observer();
            }
            let now = Instant::now();
            self.last_owner_check = Some(now);
            self.last_full_refresh = Some(now);
            self.resync_after_mutation = false;
        }
        result
    }

    pub fn poll(&mut self, timeout: Duration) -> Result<()> {
        self.poll_once(timeout).map(|_| ())
    }

    fn poll_once(&mut self, timeout: Duration) -> Result<PollEvent> {
        let deadline = Instant::now() + timeout.min(Duration::from_secs(3));
        match self.connection.receive(deadline) {
            Ok(Some(message)) => {
                if let Some(state) = &mut self.selected {
                    if following_status_requested(&message, state) {
                        self.connection.broadcast("thread-stream-following-changed",
                            json!({"conversationId":state.conversation,"hostId":"local","following":true}), &state.owner)?;
                        return Ok(PollEvent::Resubscribed);
                    } else {
                        state.notification(message)?;
                    }
                }
                Ok(PollEvent::Notification)
            }
            Ok(None) => Ok(PollEvent::Empty),
            Err(error) => {
                self.invalidate(Status::Disconnected);
                Err(error)
            }
        }
    }

    /// A returned receipt means the owner acknowledged the request, NOT turn completion.
    /// The caller must observe subsequent state; errors never imply it is safe to resend.
    pub fn send_text(&mut self, text: &str) -> Result<()> {
        self.send_text_at_revision(text, None)
    }

    pub fn send_text_at_revision(&mut self, text: &str, revision: Option<u64>) -> Result<()> {
        self.send_text_at_revision_with_dispatch(text, revision, || {})
    }

    /// Runs `dispatch` immediately before the first mutation write attempt, while
    /// the operation lock is held. Errors before this callback did not send it.
    pub fn send_text_at_revision_with_dispatch(
        &mut self,
        text: &str,
        revision: Option<u64>,
        dispatch: impl FnOnce(),
    ) -> Result<()> {
        self.send_text_at_revision_with_authorization(text, revision, || Ok(()), dispatch)
    }

    /// Rechecks host authorization after owner refresh, immediately before writing.
    /// A rejected authorization does not invoke `dispatch` or send request bytes.
    pub fn send_text_at_revision_with_authorization(
        &mut self,
        text: &str,
        revision: Option<u64>,
        authorize: impl FnOnce() -> Result<()>,
        dispatch: impl FnOnce(),
    ) -> Result<()> {
        crate::validate_send_text(text)?;
        self.send_input_inner(
            &json!([{"type":"text","text":text,"text_elements":[]}]),
            None,
            revision,
            authorize,
            dispatch,
        )
    }

    /// Carries the browser request identity into native history so a lost receipt
    /// can be checked without comparing message text or replaying a turn.
    pub fn send_input_at_revision_with_authorization(
        &mut self,
        input: &Value,
        client_id: &str,
        revision: Option<u64>,
        authorize: impl FnOnce() -> Result<()>,
        dispatch: impl FnOnce(),
    ) -> Result<()> {
        uuid::Uuid::parse_str(client_id).context("invalid-message-identity")?;
        self.send_input_inner(input, Some(client_id), revision, authorize, dispatch)
    }

    fn send_input_inner(
        &mut self,
        input: &Value,
        client_id: Option<&str>,
        revision: Option<u64>,
        authorize: impl FnOnce() -> Result<()>,
        dispatch: impl FnOnce(),
    ) -> Result<()> {
        let items = input.as_array().context("invalid-input")?;
        ensure!(!items.is_empty() && items.len() <= 11, "invalid-input-size");
        let mut text_bytes = 0;
        for item in items {
            let obj = item.as_object().context("invalid-input-item")?;
            match item["type"].as_str() {
                Some("text") => {
                    ensure!(
                        obj.keys()
                            .all(|k| matches!(k.as_str(), "type" | "text" | "text_elements")),
                        "invalid-text-input"
                    );
                    let text = item["text"].as_str().context("missing-text")?;
                    crate::validate_send_text(text)?;
                    text_bytes += text.len();
                    ensure!(text_bytes <= 16384, "text-too-large");
                    ensure!(
                        item.get("text_elements")
                            .is_none_or(|v| v.as_array().is_some_and(Vec::is_empty)),
                        "unsupported-text-elements"
                    );
                }
                Some("localImage" | "mention") => {
                    ensure!(
                        obj.keys()
                            .all(|k| matches!(k.as_str(), "type" | "path" | "name")),
                        "invalid-file-input"
                    );
                    let path = item["path"].as_str().context("missing-input-path")?;
                    let path = std::path::Path::new(path);
                    ensure!(
                        path.is_absolute()
                            && path.is_file()
                            && path.canonicalize()?.as_path() == path,
                        "invalid-input-path"
                    );
                    if item["type"] == "mention" {
                        ensure!(
                            item["name"]
                                .as_str()
                                .is_some_and(|s| !s.is_empty() && s.len() <= 255),
                            "invalid-input-name"
                        );
                    }
                }
                _ => anyhow::bail!("unsupported-input-kind"),
            }
        }
        self.ready()?;
        let _operation = OperationGuard::acquire(
            &self.endpoint,
            self.selected
                .as_ref()
                .context("no selected session")?
                .conversation_id(),
        )?;
        self.refresh()?;
        let state = self.selected.as_ref().context("no selected session")?;
        ensure!(
            revision.is_none() || revision == state.revision(),
            "session revision changed; nothing sent"
        );
        ensure!(
            state.status() == Status::Idle,
            "session is not idle; sending is disabled"
        );
        let id = state.conversation.clone();
        let mut request = json!({"threadId":id,"input":input});
        if let Some(client_id) = client_id {
            request["clientUserMessageId"] = json!(client_id);
        }
        self.mutate_with_authorization(
            "thread-follower-start-turn",
            json!({"conversationId":id,
            "turnStart":{"request":request}}),
            authorize,
            dispatch,
        )
        .map(|_| ())
    }

    /// Updates only the verified owner protocol fields on eligible Desktop builds.
    /// The owner condition prevents a concurrent model/effort change
    /// from being overwritten after our final stream refresh.
    pub fn update_thread_settings_at_revision_with_authorization(
        &mut self,
        thread_settings: &Value,
        revision: Option<u64>,
        authorize: impl FnOnce() -> Result<()>,
        dispatch: impl FnOnce(),
    ) -> Result<()> {
        ensure!(
            self.supports_thread_settings(),
            "follower-operation-unverified"
        );
        self.ready()?;
        let _operation = OperationGuard::acquire(
            &self.endpoint,
            self.selected
                .as_ref()
                .context("no selected session")?
                .conversation_id(),
        )?;
        self.refresh()?;
        let state = self.selected.as_ref().context("no selected session")?;
        ensure!(
            revision.is_some() && revision == state.revision(),
            "session revision changed; nothing sent"
        );
        ensure!(
            state.status() == Status::Idle,
            "session is not idle; settings are disabled"
        );
        validate_thread_settings(
            thread_settings,
            state.snapshot().context("missing owner snapshot")?,
        )?;
        let snapshot = state.snapshot().unwrap();
        let condition = json!({
            "ifModelEquals": snapshot["latestModel"],
            "ifEffortEquals": snapshot["latestReasoningEffort"],
        });
        let response = self.mutate_with_authorization(
            "thread-follower-update-thread-settings",
            json!({
                "conversationId": state.conversation_id(),
                "threadSettings": thread_settings,
                "activeTurnId": null,
                "condition": condition,
            }),
            authorize,
            dispatch,
        )?;
        ensure!(response["applied"] == true, "owner rejected stale settings");
        Ok(())
    }

    /// Interrupts the selected turn only. Even a matching owner receipt does not
    /// guarantee that tool subprocesses have exited; never remove the turn guard
    /// or retry without it to attempt thread-wide terminal cleanup.
    pub fn stop(&mut self, expected_turn_id: &str) -> Result<()> {
        self.stop_at_revision_with_authorization(expected_turn_id, None, || Ok(()), || {})
    }

    pub fn stop_at_revision_with_authorization(
        &mut self,
        expected_turn_id: &str,
        revision: Option<u64>,
        authorize: impl FnOnce() -> Result<()>,
        dispatch: impl FnOnce(),
    ) -> Result<()> {
        self.ready()?;
        let _operation = OperationGuard::acquire(
            &self.endpoint,
            self.selected
                .as_ref()
                .context("no selected session")?
                .conversation_id(),
        )?;
        self.refresh()?;
        let state = self.selected.as_ref().context("no selected session")?;
        ensure!(
            revision.is_none() || revision == state.revision(),
            "session revision changed; stop cancelled"
        );
        ensure!(
            state.active_turn() == Some(expected_turn_id),
            "turn changed; stop cancelled"
        );
        let conversation = state.conversation.clone();
        let receipt = self.mutate_with_authorization(
            "thread-follower-interrupt-turn",
            json!({"conversationId":conversation,
            "mode":"user-stop","expectedTurnId":expected_turn_id}),
            authorize,
            dispatch,
        )?;
        validate_interrupt_receipt(&receipt, expected_turn_id)
    }

    pub fn approve(
        &mut self,
        request_id: &Value,
        expected_turn_id: &str,
        decision: Decision,
    ) -> Result<()> {
        self.approve_at_revision(request_id, expected_turn_id, decision, None)
    }

    pub fn approve_at_revision(
        &mut self,
        request_id: &Value,
        expected_turn_id: &str,
        decision: Decision,
        revision: Option<u64>,
    ) -> Result<()> {
        self.approve_at_revision_with_dispatch(
            request_id,
            expected_turn_id,
            decision,
            revision,
            || {},
        )
    }

    /// Like sending, final owner refresh and approval checks precede `dispatch`.
    pub fn approve_at_revision_with_dispatch(
        &mut self,
        request_id: &Value,
        expected_turn_id: &str,
        decision: Decision,
        revision: Option<u64>,
        dispatch: impl FnOnce(),
    ) -> Result<()> {
        self.approve_at_revision_with_authorization(
            request_id,
            expected_turn_id,
            decision,
            revision,
            || Ok(()),
            dispatch,
        )
    }

    /// Rechecks host authorization after the final approval/owner checks.
    pub fn approve_at_revision_with_authorization(
        &mut self,
        request_id: &Value,
        expected_turn_id: &str,
        decision: Decision,
        revision: Option<u64>,
        authorize: impl FnOnce() -> Result<()>,
        dispatch: impl FnOnce(),
    ) -> Result<()> {
        self.ready()?;
        let _operation = OperationGuard::acquire(
            &self.endpoint,
            self.selected
                .as_ref()
                .context("no selected session")?
                .conversation_id(),
        )?;
        self.refresh()?;
        let state = self.selected.as_ref().context("no selected session")?;
        ensure!(
            revision.is_none() || revision == state.revision(),
            "session revision changed; nothing sent"
        );
        let approval = state
            .approvals()
            .into_iter()
            .find(|a| &a.request_id == request_id && a.turn_id == expected_turn_id)
            .context("approval no longer pending; nothing sent")?;
        if matches!(decision, Decision::Accept) {
            ensure!(
                match approval.method.as_str() {
                    "item/commandExecution/requestApproval" =>
                        approval.details["command"]
                            .as_str()
                            .is_some_and(|c| !c.is_empty())
                            && approval
                                .details
                                .get("networkApprovalContext")
                                .is_none_or(Value::is_null)
                            && approval
                                .details
                                .get("additionalPermissions")
                                .is_none_or(Value::is_null),
                    "item/fileChange/requestApproval" =>
                        approval.details["changes"]
                            .as_array()
                            .is_some_and(|c| !c.is_empty())
                            && approval.details.get("grantRoot").is_none_or(Value::is_null),
                    _ => false,
                },
                "approval details are incomplete or unsupported; handle in the original client"
            );
        }
        if let Some(available) = approval
            .details
            .get("availableDecisions")
            .filter(|v| !v.is_null())
        {
            ensure!(
                available
                    .as_array()
                    .is_some_and(|items| items.contains(&json!(decision))),
                "decision not offered by owner"
            );
        }
        let method = match approval.method.as_str() {
            "item/commandExecution/requestApproval" => "thread-follower-command-approval-decision",
            "item/fileChange/requestApproval" => "thread-follower-file-approval-decision",
            _ => anyhow::bail!("please handle this request in the original client"),
        };
        self.mutate_with_authorization(
            method,
            json!({"conversationId":state.conversation,"requestId":request_id,"decision":decision}),
            authorize,
            dispatch,
        )
        .map(|_| ())
    }

    pub fn answer_at_revision_with_authorization(
        &mut self,
        id: &Value,
        turn: &str,
        answers: &Value,
        revision: Option<u64>,
        authorize: impl FnOnce() -> Result<()>,
        dispatch: impl FnOnce(),
    ) -> Result<()> {
        self.ready()?;
        let _operation = OperationGuard::acquire(
            &self.endpoint,
            self.selected
                .as_ref()
                .context("no selected session")?
                .conversation_id(),
        )?;
        self.refresh()?;
        let state = self.selected.as_ref().context("no selected session")?;
        ensure!(
            revision.is_some() && revision == state.revision(),
            "stale question revision"
        );
        let pending = state
            .questions()
            .into_iter()
            .find(|q| &q["requestId"] == id && q["turnId"] == turn && q["supported"] == true)
            .context("question no longer pending or unsupported")?;
        let response = crate::validate_native_answers(&pending["questions"], answers)?;
        self.mutate_with_authorization(
            "thread-follower-submit-user-input",
            json!({"conversationId":state.conversation,"requestId":id,"response":response}),
            authorize,
            dispatch,
        )
        .map(|_| ())
    }

    fn ready(&self) -> Result<()> {
        ensure!(
            self.controls_enabled && self.compatibility.is_known(),
            "experimental controls are disabled"
        );
        ensure!(self.connection.is_connected(), "IPC disconnected");
        let state = self.selected.as_ref().context("no selected session")?;
        ensure!(
            matches!(
                state.status(),
                Status::Idle | Status::Running | Status::AwaitingApproval
            ),
            "session state is not confirmed; synchronize before retrying"
        );
        Ok(())
    }

    fn mutate_with_authorization(
        &mut self,
        method: &str,
        params: Value,
        authorize: impl FnOnce() -> Result<()>,
        dispatch: impl FnOnce(),
    ) -> Result<Value> {
        let state = self.selected.as_mut().context("no selected session")?;
        let owner = state.owner.clone();
        // Invalidating first prevents a second submission even if the acknowledgement is lost.
        let previous_status = state.status;
        state.status = Status::OutcomeUnknown;
        let mut dispatched = false;
        let mut following_requested = false;
        let response = self.connection.request_with_dispatch(
            method,
            params,
            Some(&owner),
            |m| {
                if following_status_requested(&m, state) {
                    following_requested = true;
                    Ok(())
                } else {
                    state.notification(m)
                }
            },
            || {
                authorize()?;
                dispatched = true;
                dispatch();
                Ok(())
            },
        );
        if !dispatched {
            // No request bytes or notifications were processed. Local framing
            // failure must not poison the confirmed snapshot as an unknown write.
            state.status = previous_status;
            return response;
        }
        self.resync_after_mutation = true;
        if following_requested && self.connection.is_connected() {
            self.connection.broadcast(
                "thread-stream-following-changed",
                json!({"conversationId":state.conversation,"hostId":"local","following":true}),
                &owner,
            )?;
        }
        match response {
            Ok(value) if value["method"] == method => {
                self.acknowledged_state = Some((state.revision(), state.status));
                // No blind retry or claimed success. A fresh snapshot resolves the operation.
                state.status = Status::OutcomeUnknown;
                state.notify_observer();
                Ok(value["result"].clone())
            }
            Ok(_) => {
                state.invalidate(Status::Unsupported);
                anyhow::bail!("unrecognized owner acknowledgement")
            }
            Err(error) => {
                state.invalidate(Status::OutcomeUnknown);
                Err(error)
            }
        }
    }

    fn invalidate(&mut self, status: Status) {
        if let Some(state) = &mut self.selected {
            state.invalidate(status);
        }
    }

    fn unfollow(&mut self) {
        self.last_owner_check = None;
        self.last_full_refresh = None;
        self.resync_after_mutation = false;
        self.acknowledged_state = None;
        if let Some(state) = self.selected.take() {
            let _ = self.connection.broadcast(
                "thread-stream-following-changed",
                json!({"conversationId":state.conversation,"hostId":"local","following":false}),
                &state.owner,
            );
        }
    }
}

fn validate_thread_settings(settings: &Value, snapshot: &Value) -> Result<()> {
    let object = settings.as_object().context("invalid-thread-settings")?;
    ensure!(
        !object.is_empty()
            && object.keys().all(|key| matches!(
                key.as_str(),
                "model"
                    | "effort"
                    | "serviceTier"
                    | "collaborationMode"
                    | "approvalPolicy"
                    | "approvalsReviewer"
                    | "sandboxPolicy"
            )),
        "unsupported-thread-setting"
    );
    if let Some(model) = settings.get("model") {
        ensure!(
            model
                .as_str()
                .is_some_and(|value| !value.is_empty() && value.len() <= 256),
            "invalid-model"
        );
    }
    if let Some(effort) = settings.get("effort") {
        ensure!(
            effort.is_null()
                || matches!(
                    effort.as_str(),
                    Some(
                        "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
                    )
                ),
            "invalid-thread-setting"
        );
    }
    for key in ["serviceTier"] {
        if let Some(value) = settings.get(key) {
            ensure!(
                value.is_null()
                    || value
                        .as_str()
                        .is_some_and(|text| !text.is_empty() && text.len() <= 128),
                "invalid-thread-setting"
            );
        }
    }
    if let Some(mode) = settings.get("collaborationMode") {
        let mode = mode.as_object().context("invalid-collaboration-mode")?;
        ensure!(
            mode.keys()
                .all(|key| matches!(key.as_str(), "mode" | "settings")),
            "invalid-collaboration-mode"
        );
        ensure!(
            matches!(mode["mode"].as_str(), Some("default" | "plan")),
            "invalid-collaboration-mode"
        );
        let nested = mode["settings"]
            .as_object()
            .context("invalid-collaboration-mode")?;
        ensure!(
            nested.keys().all(|key| matches!(
                key.as_str(),
                "model" | "reasoning_effort" | "developer_instructions"
            )),
            "invalid-collaboration-mode"
        );
        ensure!(
            nested["developer_instructions"].is_null(),
            "invalid-collaboration-mode"
        );
        let model = nested["model"]
            .as_str()
            .filter(|value| !value.is_empty() && value.len() <= 256)
            .context("invalid-collaboration-mode")?;
        ensure!(
            settings["model"].as_str() == Some(model),
            "invalid-collaboration-mode"
        );
        ensure!(
            nested["reasoning_effort"].is_null()
                || matches!(
                    nested["reasoning_effort"].as_str(),
                    Some(
                        "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
                    )
                ),
            "invalid-collaboration-mode"
        );
    }
    if settings.get("approvalPolicy").is_some()
        || settings.get("approvalsReviewer").is_some()
        || settings.get("sandboxPolicy").is_some()
    {
        ensure!(
            settings.get("approvalPolicy").is_some()
                && settings.get("approvalsReviewer").is_some()
                && settings.get("sandboxPolicy").is_some(),
            "partial-permission-setting"
        );
        let approval = settings["approvalPolicy"]
            .as_str()
            .context("invalid-approval-policy")?;
        let reviewer = settings["approvalsReviewer"]
            .as_str()
            .context("invalid-approvals-reviewer")?;
        let sandbox = &settings["sandboxPolicy"];
        match sandbox["type"].as_str() {
            Some("dangerFullAccess") => {
                ensure!(
                    approval == "never" && reviewer == "user",
                    "invalid-permission-profile"
                );
                ensure!(
                    sandbox.as_object().is_some_and(|value| value.len() == 1),
                    "invalid-sandbox-policy"
                )
            }
            Some("workspaceWrite") => {
                ensure!(
                    approval == "on-request" && matches!(reviewer, "user" | "agent"),
                    "invalid-permission-profile"
                );
                ensure!(sandbox["networkAccess"] == false, "invalid-sandbox-policy");
                let cwd = snapshot["cwd"]
                    .as_str()
                    .and_then(|path| Path::new(path).canonicalize().ok())
                    .context("owner-workspace-unavailable")?;
                ensure!(
                    sandbox["writableRoots"]
                        .as_array()
                        .is_some_and(|roots| roots.len() == 1
                            && roots.iter().all(|root| root
                                .as_str()
                                .and_then(|path| Path::new(path).canonicalize().ok())
                                .as_ref()
                                == Some(&cwd))),
                    "invalid-sandbox-policy"
                );
            }
            _ => anyhow::bail!("invalid-sandbox-policy"),
        }
    }
    Ok(())
}

fn follower_policy_id(settings: &Value) -> Value {
    match (
        settings["approvalPolicy"].as_str(),
        settings["approvalsReviewer"].as_str(),
        settings["sandboxPolicy"]["type"].as_str(),
    ) {
        (Some("on-request"), Some("user"), Some("workspaceWrite")) => {
            json!("workspace-write-on-request")
        }
        (Some("on-request"), Some("agent"), Some("workspaceWrite")) => {
            json!("workspace-write-auto-review")
        }
        (Some("never"), Some("user"), Some("dangerFullAccess")) => json!("full-access-on-request"),
        _ => Value::Null,
    }
}

fn validate_interrupt_receipt(receipt: &Value, expected_turn_id: &str) -> Result<()> {
    ensure!(
        receipt["ok"] == true && receipt["interruptedTurnId"].as_str() == Some(expected_turn_id),
        "owner did not confirm the selected turn interruption; synchronize, do not retry blindly"
    );
    ensure!(
        receipt.get("goalPauseError").is_none_or(Value::is_null),
        "turn interrupted but owner reported a goal pause failure; check the original client"
    );
    Ok(())
}

type OperationKey = (PathBuf, String);
static OPERATIONS: OnceLock<Mutex<BTreeSet<OperationKey>>> = OnceLock::new();

// Serializes bridge instances across cooperating processes, without waiting for a lock.
// Official clients do not participate in this lock; this is not a cross-client CAS.
struct OperationGuard(OperationKey, Option<std::fs::File>);
impl OperationGuard {
    fn acquire(endpoint: &Path, conversation: &str) -> Result<Self> {
        let mut active = OPERATIONS
            .get_or_init(Default::default)
            .lock()
            .map_err(|_| anyhow::anyhow!("bridge operation lock unavailable"))?;
        let key = (endpoint.to_owned(), conversation.into());
        ensure!(
            active.insert(key.clone()),
            "session operation already in flight"
        );
        let mut guard = Self(key, None);
        drop(active);
        guard.1 = Some(process_lock(endpoint, conversation)?);
        Ok(guard)
    }
}

// Keep lock files permanently: unlinking a locked inode permits a second lock domain.
fn process_lock(endpoint: &Path, conversation: &str) -> Result<std::fs::File> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
    let home = dirs::home_dir().context("home unavailable")?;
    let directory = home.join(".agentkib-bridge-locks");
    match std::fs::DirBuilder::new().mode(0o700).create(&directory) {
        Ok(()) => (),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(error) => return Err(error.into()),
    }
    let metadata = std::fs::symlink_metadata(&directory)?;
    ensure!(
        metadata.is_dir()
            && metadata.uid() == unsafe { libc::geteuid() }
            && metadata.mode() & 0o077 == 0,
        "unsafe bridge lock directory"
    );
    // Stable hash limits filenames; a collision only conservatively blocks another operation.
    let identity = format!("{}:{conversation}", endpoint.display());
    let mut hash = 0xcbf29ce484222325u64;
    for byte in identity.as_bytes() {
        hash = (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3);
    }
    let dir = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(&directory)?;
    use std::os::fd::{AsRawFd, FromRawFd};
    let name = std::ffi::CString::new(format!("{hash:016x}.lock").as_bytes())?;
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            name.as_ptr(),
            libc::O_CREAT | libc::O_RDWR | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    ensure!(fd >= 0, "bridge process lock unavailable");
    let file = unsafe { std::fs::File::from_raw_fd(fd) };
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file()
            && metadata.uid() == unsafe { libc::geteuid() }
            && metadata.mode() & 0o077 == 0
            && metadata.nlink() == 1,
        "unsafe bridge process lock"
    );
    ensure!(
        unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0,
        "session operation already in flight"
    );
    Ok(file)
}
impl Drop for OperationGuard {
    fn drop(&mut self) {
        // Release the kernel lock before admitting another in-process operation. Closing
        // alone is insufficient if another test/thread forked while this descriptor was
        // open: its CLOEXEC copy can keep the open-file-description locked until exec.
        if let Some(file) = self.1.take() {
            use std::os::fd::AsRawFd;
            let _ = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) };
            drop(file);
        }
        if let Some(lock) = OPERATIONS.get()
            && let Ok(mut active) = lock.lock()
        {
            active.remove(&self.0);
        }
    }
}

fn following_status_requested(message: &Value, state: &SessionState) -> bool {
    message["type"] == "broadcast"
        && message["method"] == "thread-stream-following-status-requested"
        && message["version"] == 1
        && message["sourceClientId"] == state.owner
        && message["params"]["conversationId"] == state.conversation
        && message["params"]["hostId"] == "local"
}

impl Drop for Bridge {
    fn drop(&mut self) {
        self.unfollow();
    }
}

#[cfg(test)]
mod operation_tests {
    use super::*;

    #[test]
    fn process_lock_rejects_an_independent_process() {
        const KEY: &str = "AGENTKIB_LOCK_TEST_ENDPOINT";
        if let Ok(endpoint) = std::env::var(KEY) {
            assert!(process_lock(Path::new(&endpoint), "cross-process").is_err());
            return;
        }
        let endpoint = format!("/synthetic/{}.sock", uuid::Uuid::new_v4());
        let held = process_lock(Path::new(&endpoint), "cross-process").unwrap();
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "bridge::operation_tests::process_lock_rejects_an_independent_process",
            ])
            .env(KEY, &endpoint)
            .output()
            .unwrap();
        assert!(
            child.status.success(),
            "{}",
            String::from_utf8_lossy(&child.stdout)
        );
        drop(held);
        assert!(process_lock(Path::new(&endpoint), "cross-process").is_ok());
    }

    #[test]
    fn interruption_receipt_must_confirm_exact_turn() {
        for receipt in [
            json!({"ok":true}),
            json!({"ok":true,"interruptedTurnId":null}),
            json!({"ok":true,"interruptedTurnId":"other-turn"}),
            json!({"ok":false,"interruptedTurnId":"turn-1"}),
            json!({"ok":true,"interruptedTurnId":"turn-1","goalPauseError":"failure"}),
        ] {
            assert!(validate_interrupt_receipt(&receipt, "turn-1").is_err());
        }
        assert!(
            validate_interrupt_receipt(&json!({"ok":true,"interruptedTurnId":"turn-1"}), "turn-1")
                .is_ok()
        );
    }

    #[test]
    fn guard_drop_unlocks_even_when_a_descriptor_copy_survives() {
        let directory = tempfile::tempdir().unwrap();
        let endpoint = directory.path().join("inherited-copy.sock");
        let guard = OperationGuard::acquire(&endpoint, "session").unwrap();
        // dup models the shared open-file-description inherited between fork and exec.
        let inherited = guard.1.as_ref().unwrap().try_clone().unwrap();
        drop(guard);
        let next = OperationGuard::acquire(&endpoint, "session").unwrap();
        drop((next, inherited));
    }

    #[test]
    fn operation_lock_rejects_duplicates_and_releases_on_drop() {
        let directory = tempfile::tempdir().unwrap();
        let endpoint_path = directory.path().join("operation-lock-test.sock");
        let endpoint = endpoint_path.as_path();
        let first = OperationGuard::acquire(endpoint, "conversation-a").unwrap();
        assert!(OperationGuard::acquire(endpoint, "conversation-a").is_err());
        let other = OperationGuard::acquire(endpoint, "conversation-b").unwrap();
        let other_endpoint = OperationGuard::acquire(
            &directory.path().join("other-lock-test.sock"),
            "conversation-a",
        )
        .unwrap();
        drop(first);
        assert!(OperationGuard::acquire(endpoint, "conversation-a").is_ok());
        drop((other, other_endpoint));
    }

    #[test]
    fn thread_settings_accept_only_verified_profiles_and_consistent_mode() {
        assert_eq!(
            crate::method_version("thread-follower-update-thread-settings"),
            Some(2)
        );
        let directory = tempfile::tempdir().unwrap();
        let cwd = directory.path().canonicalize().unwrap();
        let snapshot =
            json!({"cwd":cwd,"latestModel":"mock-model","latestReasoningEffort":"medium"});
        for settings in [
            json!({"approvalPolicy":"on-request","approvalsReviewer":"user","sandboxPolicy":{"type":"workspaceWrite","writableRoots":[cwd],"networkAccess":false}}),
            json!({"approvalPolicy":"on-request","approvalsReviewer":"agent","sandboxPolicy":{"type":"workspaceWrite","writableRoots":[cwd],"networkAccess":false}}),
            json!({"approvalPolicy":"never","approvalsReviewer":"user","sandboxPolicy":{"type":"dangerFullAccess"}}),
            json!({"model":"mock-model","effort":"high","collaborationMode":{"mode":"plan","settings":{"model":"mock-model","reasoning_effort":"high","developer_instructions":null}}}),
        ] {
            validate_thread_settings(&settings, &snapshot).unwrap();
        }
        for settings in [
            json!({"approvalPolicy":"never","approvalsReviewer":"agent","sandboxPolicy":{"type":"workspaceWrite","writableRoots":[cwd],"networkAccess":false}}),
            json!({"approvalPolicy":"on-request","approvalsReviewer":"user","sandboxPolicy":{"type":"dangerFullAccess"}}),
            json!({"model":"other","collaborationMode":{"mode":"plan","settings":{"model":"mock-model","reasoning_effort":"medium","developer_instructions":null}}}),
        ] {
            assert!(validate_thread_settings(&settings, &snapshot).is_err());
        }
    }
}
