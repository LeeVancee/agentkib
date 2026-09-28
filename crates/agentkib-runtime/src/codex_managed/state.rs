use super::{
    ledger::{Ledger, Record},
    *,
};
#[derive(Clone)]
pub(super) struct State {
    pub record: Record,
    pub revision: u64,
    pub goal_revision: u64,
    pub status: String,
    pub turn: Option<String>,
    pub stream: String,
    pub approvals: BTreeMap<String, Value>,
    pub questions: BTreeMap<String, Value>,
    pub resolved_requests: BTreeSet<String>,
    pending_request_turns: BTreeMap<String, String>,
    pub items: BTreeMap<String, Value>,
    pub reason: Option<String>,
}
impl State {
    pub fn new(record: Record) -> Self {
        Self {
            record,
            revision: 0,
            goal_revision: 0,
            status: "starting".into(),
            turn: None,
            stream: String::new(),
            approvals: BTreeMap::new(),
            questions: BTreeMap::new(),
            resolved_requests: BTreeSet::new(),
            pending_request_turns: BTreeMap::new(),
            items: BTreeMap::new(),
            reason: None,
        }
    }
    pub fn snapshot(&self, boot: &str, controls: bool) -> Value {
        let healthy = self.reason.is_none();
        json!({"sessionId":self.record.id,"workspaceId":self.record.workspace_id,"runtimeBootId":boot,"executionMode":"codex-managed","status":self.status,"revision":self.revision,"turnId":self.turn,"sendEnabled":controls&&healthy&&self.status=="idle","stopEnabled":controls&&healthy&&self.turn.is_some()&&matches!(self.status.as_str(),"running"|"awaiting-approval"|"waiting-input"),"approvals":self.approvals.values().cloned().map(|mut a|{if !controls{a["supported"]=json!(false)}a}).collect::<Vec<_>>(),"questions":self.questions.values().cloned().map(|mut q|{if !controls{q["supported"]=json!(false)}q}).collect::<Vec<_>>(),"streamText":self.stream,"settings":settings_projection(&self.record),"tokenUsage":self.record.token_usage,"goal":self.record.goal,"reason":self.reason})
    }
    pub fn save(&mut self, ledger: &Ledger) -> Result<()> {
        self.record.snapshot = self.snapshot("", false);
        ledger.save(&self.record)
    }
    pub fn fail(&mut self, reason: &str) {
        self.status = "outcome-unknown".into();
        self.reason = Some(reason.into());
        // After losing the engine or a mutation result, retained selections are
        // not proof of the current native settings.
        self.record.native_settings = None;
        self.revision += 1;
    }
    pub fn event(&mut self, value: Value, ledger: &Ledger) -> Result<()> {
        let method = value["method"].as_str().unwrap_or("");
        let p = &value["params"];
        if method == "agentkib/disconnected" {
            if !self.record.released {
                self.fail("codex-disconnected");
                self.save(ledger)?;
            }
            return Ok(());
        }
        if let Some(native) = self.record.native_id.as_deref()
            && p.get("threadId")
                .and_then(Value::as_str)
                .is_some_and(|id| id != native)
        {
            return Ok(());
        }
        match method {
            "thread/started" => {
                let id = p["thread"]["id"].as_str().context("invalid-thread")?;
                if self.record.native_id.is_none() {
                    self.record.native_id = Some(id.into());
                } else if self.record.native_id.as_deref() != Some(id) {
                    return Ok(());
                }
            }
            "turn/started" => {
                let id = p["turn"]["id"].as_str().context("invalid-turn")?;
                self.turn = Some(id.into());
                self.status = "running".into();
                self.stream.clear();
                self.reason = None;
            }
            "turn/completed" => {
                if p["turn"]["id"].as_str() != self.turn.as_deref() {
                    return Ok(());
                }
                self.turn = None;
                self.status = "idle".into();
                self.approvals.clear();
                self.questions.clear();
                self.items.clear();
            }
            "item/agentMessage/delta" | "item/plan/delta" => {
                if p["turnId"].as_str() != self.turn.as_deref() {
                    return Ok(());
                }
                if let Some(delta) = p["delta"].as_str()
                    && self.stream.len() + delta.len() <= 128 * 1024
                {
                    self.stream.push_str(delta)
                }
            }
            "item/started" | "item/completed" => {
                if p["turnId"].as_str() != self.turn.as_deref() {
                    return Ok(());
                }
                let item = &p["item"];
                let id = item["id"].as_str().context("invalid-item")?;
                ensure!(
                    self.items.len() < 1024 || self.items.contains_key(id),
                    "too-many-items"
                );
                self.items.insert(id.into(), item.clone());
                if method == "item/completed" {
                    self.persist_item(item, p["turnId"].as_str(), ledger)?;
                }
            }
            "item/commandExecution/requestApproval"
            | "item/fileChange/requestApproval"
            | "item/permissions/requestApproval" => {
                if p["turnId"].as_str() != self.turn.as_deref() {
                    return Ok(());
                }
                ensure!(self.approvals.len() < 32, "too-many-approvals");
                let id = value.get("id").context("missing-request-id")?.clone();
                self.pending_request_turns
                    .insert(id.to_string(), self.turn.clone().unwrap_or_default());
                let mut details = p.clone();
                if method == "item/fileChange/requestApproval"
                    && let Some(item) = p["itemId"].as_str().and_then(|id| self.items.get(id))
                {
                    details["changes"] = item["changes"].clone();
                }
                let approval = crate::web::safe_approval_extended(
                    agentkib_codex_bridge::Approval {
                        request_id: id.clone(),
                        turn_id: self.turn.clone().unwrap_or_default(),
                        method: method.into(),
                        details,
                    },
                    true,
                );
                self.approvals.insert(id.to_string(), approval);
                self.status = "awaiting-approval".into();
            }
            "item/tool/requestUserInput" => {
                if p["turnId"].as_str() != self.turn.as_deref() {
                    return Ok(());
                }
                ensure!(self.questions.len() < 32, "too-many-questions");
                let id = value.get("id").context("missing-request-id")?.clone();
                self.pending_request_turns
                    .insert(id.to_string(), self.turn.clone().unwrap_or_default());
                let projection = agentkib_codex_bridge::project_native_questions(p)
                    .context("invalid-questions")?;
                self.questions.insert(id.to_string(),json!({"requestId":id,"turnId":self.turn,"method":method,"supported":projection["supported"],"questions":projection["questions"]}));
                self.status = "waiting-input".into();
            }
            "serverRequest/resolved" => {
                let key = p["requestId"].to_string();
                if self.resolved_requests.len() >= 256 {
                    self.resolved_requests.clear();
                }
                if let Some(turn) = self.pending_request_turns.remove(&key) {
                    self.resolved_requests.insert(format!("{turn}:{key}"));
                }
                self.approvals.remove(&key);
                self.questions.remove(&key);
                if self.approvals.is_empty() && self.questions.is_empty() && self.turn.is_some() {
                    self.status = "running".into()
                }
            }
            "thread/status/changed" => {
                if p["status"]["type"] == "systemError" {
                    self.fail("codex-thread-error")
                }
            }
            "thread/settings/updated" => {
                let settings = &p["threadSettings"];
                ensure!(settings.is_object(), "invalid-thread-settings");
                self.record.native_settings = Some(settings.clone());
            }
            "thread/tokenUsage/updated" => {
                ensure!(p["tokenUsage"].is_object(), "invalid-token-usage");
                self.record.token_usage = Some(p["tokenUsage"].clone());
            }
            "thread/goal/updated" => {
                ensure!(p["goal"].is_object(), "invalid-goal");
                self.record.goal = Some(p["goal"].clone());
                self.goal_revision += 1;
            }
            "thread/goal/cleared" => {
                self.record.goal = None;
                self.goal_revision += 1;
            }
            _ => {
                if value.get("id").is_some() {
                    self.status = "waiting-input".into();
                    self.reason = Some("unsupported-codex-request".into());
                } else {
                    return Ok(());
                }
            }
        }
        self.revision += 1;
        self.save(ledger)
    }
    pub fn persist_item(&self, item: &Value, turn: Option<&str>, ledger: &Ledger) -> Result<()> {
        let id = item["id"].as_str().context("invalid-item")?;
        let (kind, content, tool, status) = match item["type"].as_str() {
            Some("agentMessage" | "plan") => (
                "agent-message",
                item["text"].as_str().unwrap_or("").to_string(),
                None,
                None,
            ),
            Some("userMessage") => (
                "user-message",
                item["content"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|c| c["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n"),
                None,
                None,
            ),
            Some("commandExecution" | "fileChange" | "mcpToolCall" | "webSearch") => (
                "tool-summary",
                String::new(),
                item["type"].as_str(),
                item["status"].as_str(),
            ),
            _ => return Ok(()),
        };
        let truncated = content.len() > 128 * 1024;
        let content = content.chars().take(32768).collect::<String>();
        ledger.event(&self.record.id,&json!({"id":id,"kind":kind,"turn_id":turn,"timestamp":Utc::now().to_rfc3339(),"content":content,"tool_name":tool,"tool_status":status,"attachment_count":0,"truncated":truncated}))
    }
    pub fn hydrate(&mut self, thread: &Value, ledger: &Ledger) -> Result<()> {
        let id = thread["id"].as_str().context("invalid-thread")?;
        ensure!(
            self.record
                .native_id
                .as_deref()
                .is_none_or(|native| native == id),
            "thread-identity-mismatch"
        );
        self.record.native_id = Some(id.into());
        self.turn = None;
        self.status = "idle".into();
        self.reason = None;
        self.approvals.clear();
        self.questions.clear();
        for turn in thread["turns"].as_array().into_iter().flatten() {
            if turn["status"] == "inProgress" {
                self.turn = turn["id"].as_str().map(str::to_owned);
                self.status = "running".into();
            }
            for item in turn["items"].as_array().into_iter().flatten() {
                self.persist_item(item, turn["id"].as_str(), ledger)?;
            }
        }
        if thread["status"]["type"] == "active" && self.turn.is_none() {
            self.fail("unconfirmed-active-turn");
        }
        self.revision += 1;
        self.save(ledger)
    }
}

pub(super) fn selected_settings(record: &Record) -> Value {
    json!({"model":record.model,"effort":record.effort,"mode":record.mode,
        "serviceTier":record.service_tier,"policyId":record.policy_id})
}

pub(super) fn settings_projection(record: &Record) -> Value {
    let selected = selected_settings(record);
    let current = record.native_settings.as_ref().map(|native| {
        json!({
            "model":native["model"], "effort":native["effort"],
            "mode":native["collaborationMode"]["mode"],
            "serviceTier":normalized_service_tier(&native["serviceTier"]),
            "policyId":policy_id_from_settings(native, &record.workspace)
        })
    });
    // A missing selected mode means no explicit override, not a claim about the
    // native default. Compare the remaining fields without inventing a mode.
    let confirmed = current.as_ref().is_some_and(|current| {
        ["model", "effort", "serviceTier", "policyId"]
            .iter()
            .all(|key| current[key] == selected[key])
            && (record.mode.is_none() || current["mode"] == selected["mode"])
    });
    json!({"current":current.unwrap_or_else(||json!({"model":null,"effort":null,"mode":null,"serviceTier":null,"policyId":null})),
        "selected":selected,
        "applicationStatus":if record.native_settings.is_none(){"unknown"}else if confirmed{"confirmed"}else{"pending"},
        "defaults":{"model":record.default_model,"effort":record.default_effort,"serviceTier":record.default_service_tier}})
}

pub(super) fn settings_applied(record: &Record) -> bool {
    settings_projection(record)["applicationStatus"] == "confirmed"
}
