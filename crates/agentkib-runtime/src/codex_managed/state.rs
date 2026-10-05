use super::{
    ledger::{Ledger, Record},
    *,
};
#[derive(Clone)]
pub(super) struct State {
    pub publisher: Option<crate::session_stream::Publisher>,
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
            publisher: None,
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
        ledger.save(&self.record)?;
        self.publish(ledger)
    }
    pub fn publish(&self, ledger: &Ledger) -> Result<()> {
        if let Some(publisher) = &self.publisher {
            publisher.observe(self.snapshot("", !ledger.has_unknown(&self.record.id)?));
        }
        Ok(())
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
        let domain = match method {
            "thread/settings/updated" => Some(("settings", "settings")),
            "thread/tokenUsage/updated" => Some(("tokenUsage", "usage")),
            "thread/goal/updated" | "thread/goal/cleared" => Some(("goal", "goal")),
            _ => None,
        };
        let before = domain.map(|(field, _)| self.record.snapshot[field].clone());
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
                if let Some(delta) = p["delta"].as_str() {
                    if self.stream.len() + delta.len() <= 128 * 1024 {
                        self.stream.push_str(delta);
                    }
                    let id = p["itemId"].as_str().context("missing-item-id")?;
                    ensure!(
                        self.items.len() < 1024 || self.items.contains_key(id),
                        "too-many-items"
                    );
                    let item = self
                        .items
                        .entry(id.into())
                        .or_insert_with(|| json!({"id":id,"type":"agentMessage","text":""}));
                    let mut text = item["text"].as_str().unwrap_or("").to_owned();
                    // Retain one extra scalar to make exceeding the preview
                    // boundary explicit, without accumulating unbounded tokens.
                    let mut end = delta
                        .len()
                        .min((128 * 1024 + 4usize).saturating_sub(text.len()));
                    while !delta.is_char_boundary(end) {
                        end -= 1;
                    }
                    text.push_str(&delta[..end]);
                    item["text"] = json!(text);
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
        self.save(ledger)?;
        if let Some((field, domain)) = domain
            && before.as_ref() != Some(&self.record.snapshot[field])
            && let Some(publisher) = &self.publisher
        {
            // Only native pushes invalidate reads. Publishing this from save()
            // would make goal/get counter refreshes trigger another goal/get.
            publisher.invalidate(&[domain]);
        }
        if matches!(method, "item/agentMessage/delta" | "item/plan/delta")
            && let Some(publisher) = &self.publisher
            && let Some(id) = p["itemId"].as_str()
            && let Some(text) = self.items.get(id).and_then(|item| item["text"].as_str())
        {
            publisher.item_text(id, self.turn.as_deref(), text);
        }
        if method == "item/started"
            && let Some(event) = project_item(&p["item"], p["turnId"].as_str())?
        {
            // Running items belong to the live baseline, not completed history.
            self.publish_item(event);
        }
        Ok(())
    }
    pub fn persist_item(&self, item: &Value, turn: Option<&str>, ledger: &Ledger) -> Result<()> {
        let Some(event) = project_item(item, turn)? else {
            return Ok(());
        };
        self.store_item(&event, ledger)?;
        self.publish_item(event);
        Ok(())
    }
    fn store_item(&self, event: &Value, ledger: &Ledger) -> Result<()> {
        let mut stored = event.clone();
        stored["content"] = json!(
            event["content"]
                .as_str()
                .unwrap_or("")
                .chars()
                .take(32768)
                .collect::<String>()
        );
        ledger.event(&self.record.id, &stored)?;
        Ok(())
    }
    fn publish_item(&self, mut event: Value) {
        if let Some(publisher) = &self.publisher {
            // Persistence retains its existing summary budget. Completion on
            // the live channel must use the same preview boundary as deltas.
            let (content, truncated) =
                crate::session_stream::bounded_text(event["content"].as_str().unwrap_or(""));
            event["content"] = json!(content);
            event["truncated"] = json!(truncated);
            publisher.item(event);
        }
    }
    pub fn hydrate(&mut self, thread: &Value, ledger: &Ledger) -> Result<()> {
        let id = thread["id"].as_str().context("invalid-thread")?;
        ensure!(thread["turns"].is_array(), "native-history-unavailable");
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
        self.items.clear();
        self.stream.clear();
        let mut projected = std::collections::VecDeque::new();
        let mut projected_bytes = 2; // JSON array delimiters and per-item separators.
        let mut coverage = Vec::new();
        let mut retained = Vec::new();
        for turn in thread["turns"].as_array().into_iter().flatten() {
            let turn_id = turn["id"].as_str();
            if let Some(id) = turn_id {
                retained.push(id.to_owned());
            }
            if turn["status"] == "inProgress" {
                self.turn = turn_id.map(str::to_owned);
                self.status = "running".into();
            }
            let mut ids = Vec::new();
            for item in turn["items"].as_array().into_iter().flatten() {
                let Some(mut event) = project_item(item, turn_id)? else {
                    continue;
                };
                self.store_item(&event, ledger)?;
                ids.push(event["id"].as_str().expect("projected item ID").to_owned());
                if turn["status"] == "inProgress" {
                    let mut item = item.clone();
                    if let Some(text) = item["text"].as_str() {
                        let mut end = text
                            .len()
                            .min(crate::session_stream::MAX_ITEM_TEXT_BYTES + 4);
                        while !text.is_char_boundary(end) {
                            end -= 1;
                        }
                        item["text"] = json!(&text[..end]);
                    }
                    self.items.insert(ids.last().unwrap().clone(), item);
                }
                let (content, truncated) =
                    crate::session_stream::bounded_text(event["content"].as_str().unwrap_or(""));
                let content = content.to_owned();
                event["content"] = json!(content);
                event["truncated"] = json!(truncated);
                let bytes = serde_json::to_vec(&event)?.len() + 1;
                projected_bytes += bytes;
                projected.push_back((event, bytes));
                while projected.len() > 100
                    || projected_bytes > crate::session_stream::MAX_ITEMS_BYTES
                {
                    if let Some((item, bytes)) = projected.pop_front() {
                        projected_bytes -= bytes;
                        if let Some(id) = item["id"].as_str() {
                            self.items.remove(id);
                        }
                    }
                }
            }
            // An absent items field is not evidence of a complete empty turn.
            if let Some(id) = turn_id.filter(|_| turn["items"].is_array()) {
                coverage.push((id.to_owned(), ids));
            }
        }
        if thread["status"]["type"] == "active" && self.turn.is_none() {
            self.fail("unconfirmed-active-turn");
        }
        for (item, _) in &projected {
            if item["kind"] == "agent-message"
                && item["turn_id"].as_str() == self.turn.as_deref()
                && let Some(content) = item["content"].as_str()
                && self.stream.len() + content.len() <= crate::session_stream::MAX_ITEM_TEXT_BYTES
            {
                self.stream.push_str(content);
            }
        }
        self.revision += 1;
        // Commit durable state before exposing the recovered baseline. save()
        // would announce an idle transition and invalidate history first.
        self.record.snapshot = self.snapshot("", false);
        ledger.save(&self.record)?;
        if let Some(publisher) = &self.publisher {
            publisher.hydrate(
                self.snapshot("", !ledger.has_unknown(&self.record.id)?),
                projected.into_iter().map(|(item, _)| item).collect(),
                &coverage,
                &retained,
            );
        }
        Ok(())
    }
}

fn project_item(item: &Value, turn: Option<&str>) -> Result<Option<Value>> {
    let id = item["id"].as_str().context("invalid-item")?;
    let Some(kind) = crate::codex_item::item_kind(item) else {
        return Ok(None);
    };
    let (content, tool, status) = match kind {
        "agent-message" => (item["text"].as_str().unwrap_or("").to_string(), None, None),
        "user-message" => (crate::codex_item::content_parts_text(item), None, None),
        "tool-summary" => (
            String::new(),
            item["type"].as_str(),
            item["status"].as_str(),
        ),
        _ => unreachable!("shared Codex item classification"),
    };
    let truncated = content.len() > 128 * 1024;
    Ok(Some(
        json!({"id":id,"kind":kind,"turn_id":turn,"timestamp":Utc::now().to_rfc3339(),"content":content,"tool_name":tool,"tool_status":status,"attachment_count":0,"truncated":truncated}),
    ))
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
