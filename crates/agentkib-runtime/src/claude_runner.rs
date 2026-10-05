//! Managed Claude stream-json transport. Construction and snapshots never start Claude.
//! Wire contract: anthropics/claude-agent-sdk-python `_internal/query.py`.
//! The private lock coordinates AgentKib runtimes only; official Claude clients
//! do not honor it. This transport therefore remains an experimental capability.
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::{File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, SyncSender},
    },
    thread,
    time::{Duration, Instant},
};

const MAX_TEXT: usize = 4 * 1024 * 1024;
// JSON can escape each text byte as six ASCII bytes (e.g. \u0000).
// Allow a completed copy of the output plus bounded protocol metadata.
const MAX_LINE: usize = 6 * MAX_TEXT + 1024 * 1024;

fn read_frame(reader: &mut impl BufRead) -> Result<Option<Value>> {
    let mut bytes = Vec::new();
    let size = reader
        .take((MAX_LINE + 1) as u64)
        .read_until(b'\n', &mut bytes)?;
    if size == 0 {
        return Ok(None);
    }
    ensure!(size <= MAX_LINE, "Claude frame exceeds 25 MiB");
    Ok(Some(
        serde_json::from_slice(&bytes).context("malformed Claude stream JSON")?,
    ))
}
const SUPPORTED_VERSION: &str = "2.1.263 (Claude Code)";
const CURRENT_SUPPORTED_VERSION: &str = "2.1.285 (Claude Code)";

/// Host-resolved input only: never accepts paths, URLs or arbitrary native roles.
pub(crate) fn validate_content(content: &Value) -> Result<()> {
    use base64::Engine;
    if let Some(text) = content.as_str() {
        ensure!(
            !text.trim().is_empty() && text.len() <= 128 * 1024,
            "invalid Claude text"
        );
        return Ok(());
    }
    let blocks = content.as_array().context("invalid Claude input blocks")?;
    ensure!(
        !blocks.is_empty() && blocks.len() <= 32,
        "invalid Claude input count"
    );
    let mut text_bytes = 0;
    let mut image_bytes = 0;
    for block in blocks {
        match block["type"].as_str() {
            Some("text") => {
                ensure!(
                    block.as_object().is_some_and(|v| v.len() == 2),
                    "invalid Claude text block"
                );
                let text = block["text"].as_str().context("invalid Claude text")?;
                ensure!(!text.trim().is_empty(), "empty Claude text");
                text_bytes += text.len();
            }
            Some("image") => {
                ensure!(
                    block.as_object().is_some_and(|v| v.len() == 2),
                    "invalid Claude image block"
                );
                let source = &block["source"];
                ensure!(
                    source.as_object().is_some_and(|v| v.len() == 3) && source["type"] == "base64",
                    "invalid Claude image source"
                );
                let encoded = source["data"]
                    .as_str()
                    .context("invalid Claude image data")?;
                ensure!(
                    encoded.len() <= (4_usize * 1024 * 1024).div_ceil(3) * 4,
                    "Claude image exceeds 4 MiB"
                );
                let bytes = base64::engine::general_purpose::STANDARD.decode(encoded)?;
                ensure!(
                    !bytes.is_empty() && bytes.len() <= 4 * 1024 * 1024,
                    "Claude image exceeds 4 MiB"
                );
                let valid = match source["media_type"].as_str() {
                    Some("image/png") => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
                    Some("image/jpeg") => bytes.starts_with(b"\xff\xd8\xff"),
                    Some("image/gif") => {
                        bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")
                    }
                    Some("image/webp") => {
                        bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP")
                    }
                    _ => false,
                };
                ensure!(valid, "Claude image format mismatch");
                image_bytes += bytes.len();
            }
            _ => bail!("unsupported Claude input block"),
        }
    }
    ensure!(text_bytes <= 128 * 1024, "Claude text exceeds 128 KiB");
    ensure!(
        image_bytes <= 12 * 1024 * 1024,
        "Claude images exceed 12 MiB"
    );
    Ok(())
}

// Embedded 2.1.263 AskUserQuestion schema: answers are keyed by question text,
// and multi-select values use comma-separated labels. New form kinds fail closed.
fn question_schema(input: &Value) -> Result<Vec<Value>> {
    ensure!(
        input.as_object().is_some_and(|o| o
            .keys()
            .all(|k| matches!(k.as_str(), "questions" | "metadata"))),
        "unsupported question input"
    );
    let rows = input["questions"].as_array().context("missing questions")?;
    ensure!((1..=4).contains(&rows.len()), "unsupported question count");
    let mut ids = HashSet::new();
    rows.iter().map(|q| {
        ensure!(q.as_object().is_some_and(|o| o.keys().all(|k| matches!(k.as_str(), "question" | "header" | "options" | "multiSelect"))), "unsupported question fields");
        ensure!(q.get("kind").is_none(), "unsupported question kind");
        let text = q["question"].as_str().filter(|s| !s.is_empty()).context("invalid question")?;
        ensure!(ids.insert(text), "duplicate question");
        let options = q["options"].as_array().context("missing choices")?;
        ensure!((2..=4).contains(&options.len()), "unsupported choices");
        let mut labels = HashSet::new();
        for option in options {
            ensure!(option.as_object().is_some_and(|o| o.keys().all(|k| matches!(k.as_str(), "label" | "description"))), "unsupported choice fields");
            let label = option["label"].as_str().filter(|s| !s.is_empty()).context("invalid choice")?;
            ensure!(labels.insert(label), "duplicate choice");
            ensure!(option.get("preview").is_none(), "unsupported question preview");
        }
        let multi = q.get("multiSelect").map(Value::as_bool).unwrap_or(Some(false)).context("invalid multiSelect")?;
        Ok(json!({"id":text,"header":q["header"],"question":text,"options":options,"multiSelect":multi,"allowCustom":true}))
    }).collect()
}

#[derive(Default, Clone)]
struct State {
    publisher: Option<crate::session_stream::Publisher>,
    stream_context: Value,
    session_id: String,
    revision: u64,
    turn_id: String,
    status: String,
    approvals: Vec<Value>,
    questions: Vec<Value>,
    seen_requests: HashSet<String>,
    stream_text: String,
    message_id: String,
    message_text: String,
    text_block_serial: u64,
    tools: BTreeMap<String, Value>,
    reason: Option<String>,
    initialized: bool,
    init_id: String,
    pending_user: Option<Value>,
    model: Option<String>,
    usage: Option<Value>,
    last_outcome: Option<String>,
    partial: bool,
    foreground_bash_contract: bool,
    cleanup_error: Option<String>,
    bash_tool_ids: HashSet<String>,
    foreground_tasks: HashMap<String, String>,
}

impl State {
    fn snapshot(&self) -> Value {
        let mut end = self.stream_text.len().min((512 * 1024 - 2) / 6);
        while !self.stream_text.is_char_boundary(end) {
            end -= 1;
        }
        json!({"lastOutcome":self.last_outcome,"model":self.model,"tokenUsage":self.usage,"status":self.status,"sendEnabled":self.status == "idle","stopEnabled":self.status != "idle" && !self.turn_id.is_empty() && self.reason.is_none(),"revision":self.revision,"turnId":self.turn_id,"approvals":self.approvals,"questions":self.questions,"streamText":&self.stream_text[..end],"streamTextTruncated":end < self.stream_text.len(),"reason":self.reason})
    }
    fn stream_snapshot(&self) -> Value {
        let mut live = self.snapshot();
        if let Some(fields) = self.stream_context.as_object() {
            for (key, value) in fields {
                live[key] = value.clone();
            }
            if fields.get("cliVersion").is_some_and(Value::is_null) {
                live["sendEnabled"] = json!(false);
                if live["status"] == "idle" {
                    live["reason"] = json!("unverified-installation");
                }
            }
        }
        live
    }
    fn publish(&self) {
        if let Some(publisher) = &self.publisher {
            let fallback = format!("live:{}:assistant", self.turn_id);
            let id = if self.message_id.is_empty() {
                &fallback
            } else {
                &self.message_id
            };
            publisher.item_text(id, Some(&self.turn_id), &self.message_text);
            publisher.observe(self.stream_snapshot());
        }
    }
    fn publish_completed_message(&self) {
        if let Some(publisher) = &self.publisher
            && !self.message_text.is_empty()
        {
            let id = if self.message_id.is_empty() {
                format!("live:{}:assistant", self.turn_id)
            } else {
                self.message_id.clone()
            };
            publisher.item(json!({"id":id,"kind":"agent-message","turn_id":self.turn_id,"content":self.message_text,"timestamp":chrono::Utc::now().to_rfc3339(),"attachment_count":0,"truncated":false}));
        }
    }
    fn publish_user(&self, frame: &Value) {
        let Some(publisher) = &self.publisher else {
            return;
        };
        // Match the history reader's identity, including replayed native users.
        let Some(id) = frame["uuid"]
            .as_str()
            .filter(|id| valid_message_id(id))
            .or_else(|| {
                frame["message"]["id"]
                    .as_str()
                    .filter(|id| valid_message_id(id))
            })
        else {
            return;
        };
        if frame["isCompactSummary"] == true {
            return;
        }
        let content = &frame["message"]["content"];
        let text = content.as_str().map(str::to_owned).unwrap_or_else(|| {
            content
                .as_array()
                .into_iter()
                .flatten()
                .filter(|block| {
                    matches!(
                        block["type"].as_str(),
                        Some("text" | "input_text" | "output_text")
                    )
                })
                .filter_map(|block| block["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        });
        let attachments = content
            .as_array()
            .into_iter()
            .flatten()
            .filter(|block| matches!(block["type"].as_str(), Some("image" | "document")))
            .count();
        if text.is_empty() && attachments == 0 {
            return;
        }
        publisher.item(json!({"id":id,"kind":"user-message","content":text,"attachment_count":attachments,"truncated":false}));
    }
    fn observe_bash(&mut self, block: &Value, parent: &Value) -> Result<()> {
        if !self.foreground_bash_contract || block["type"] != "tool_use" || block["name"] != "Bash"
        {
            return Ok(());
        }
        ensure!(
            self.initialized
                && self.status == "running"
                && !self.turn_id.is_empty()
                && parent.is_null(),
            "Claude Bash outside current top-level turn"
        );
        let id = block["id"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 256)
            .context("invalid Claude Bash tool ID")?;
        ensure!(
            self.bash_tool_ids.len() < 4096,
            "too many Claude Bash tools"
        );
        self.bash_tool_ids.insert(id.to_owned());
        Ok(())
    }

    fn task_frame(&mut self, frame: &Value) -> Result<()> {
        ensure!(
            self.foreground_bash_contract,
            "Claude background tasks are unsupported in managed sessions"
        );
        let subtype = frame["subtype"].as_str().unwrap_or_default();
        if subtype == "background_tasks_changed" {
            ensure!(
                frame["tasks"].as_array().is_some_and(Vec::is_empty),
                "Claude background tasks are unsupported in managed sessions"
            );
            return Ok(());
        }
        ensure!(
            self.initialized
                && matches!(
                    self.status.as_str(),
                    "running" | "waiting-approval" | "waiting-input"
                ),
            "Claude task outside active turn"
        );
        let task = frame["task_id"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 256)
            .context("invalid Claude task ID")?;
        match subtype {
            "task_started" => {
                let tool = frame["tool_use_id"]
                    .as_str()
                    .context("missing Claude task tool ID")?;
                ensure!(
                    frame["task_type"] == "local_bash"
                        && frame["is_backgrounded"] == false
                        && frame["owned_by_subagent"] != true
                        && self.bash_tool_ids.contains(tool),
                    "unverified Claude foreground Bash task"
                );
                ensure!(
                    self.foreground_tasks.len() < 4096
                        && !self.foreground_tasks.contains_key(task)
                        && !self.foreground_tasks.values().any(|id| id == tool),
                    "duplicate Claude foreground task"
                );
                self.foreground_tasks
                    .insert(task.to_owned(), tool.to_owned());
            }
            "task_updated" => {
                ensure!(
                    self.foreground_tasks.contains_key(task),
                    "unknown Claude foreground task"
                );
                let patch = frame["patch"]
                    .as_object()
                    .context("invalid Claude task patch")?;
                ensure!(
                    patch
                        .get("is_backgrounded")
                        .is_none_or(|value| value == false),
                    "Claude background tasks are unsupported in managed sessions"
                );
                ensure!(
                    patch.get("status").is_none_or(|value| matches!(
                        value.as_str(),
                        Some("pending" | "running" | "completed" | "failed" | "killed" | "paused")
                    )),
                    "invalid Claude task status"
                );
            }
            "task_notification" => {
                let tool = self
                    .foreground_tasks
                    .get(task)
                    .context("unknown Claude foreground task")?;
                ensure!(
                    frame["tool_use_id"].as_str() == Some(tool.as_str())
                        && matches!(
                            frame["status"].as_str(),
                            Some("completed" | "failed" | "stopped")
                        ),
                    "unverified Claude task completion"
                );
                self.foreground_tasks.remove(task);
            }
            _ => unreachable!(),
        }
        Ok(())
    }

    fn answer(&mut self, id: &Value, turn: &str, answers: &Value, revision: u64) -> Result<Value> {
        ensure!(
            revision == self.revision && turn == self.turn_id,
            "stale Claude question"
        );
        let index = self
            .questions
            .iter()
            .position(|q| &q["requestId"] == id)
            .context("question no longer pending")?;
        let pending = &self.questions[index];
        let rows = pending["questions"]
            .as_array()
            .context("invalid pending questions")?;
        let answer_map = answers.as_object().context("invalid answers")?;
        ensure!(rows.len() == answer_map.len(), "answer keys mismatch");
        let mut native = serde_json::Map::new();
        for row in rows {
            let key = row["id"].as_str().context("invalid question id")?;
            let values = answer_map
                .get(key)
                .and_then(Value::as_array)
                .context("missing answer")?;
            ensure!(
                !values.is_empty()
                    && values.len() <= 16
                    && (row["multiSelect"] == true || values.len() == 1),
                "invalid answer cardinality"
            );
            let mut unique = HashSet::new();
            let text = values
                .iter()
                .map(|v| {
                    let text = v
                        .as_str()
                        .filter(|s| !s.trim().is_empty() && s.len() <= 8192)
                        .context("invalid answer text")?;
                    ensure!(unique.insert(text), "duplicate answer");
                    Ok(text)
                })
                .collect::<Result<Vec<_>>>()?
                .join(", ");
            native.insert(key.to_owned(), json!(text));
        }
        let mut input = pending["input"].clone();
        input["answers"] = Value::Object(native);
        self.questions.remove(index);
        self.revision += 1;
        self.status = if !self.questions.is_empty() {
            "waiting-input"
        } else if !self.approvals.is_empty() {
            "waiting-approval"
        } else {
            "running"
        }
        .into();
        self.publish();
        Ok(
            json!({"type":"control_response","response":{"subtype":"success","request_id":id,"response":{"behavior":"allow","updatedInput":input}}}),
        )
    }
    fn fail(&mut self, reason: impl Into<String>) {
        self.status = "outcome-unknown".into();
        let mut reason = reason.into();
        if reason.len() > 4096 {
            let mut end = 4096;
            while !reason.is_char_boundary(end) {
                end -= 1;
            }
            reason.truncate(end);
            reason.push_str("… [truncated]");
        }
        self.reason = Some(reason);
        self.last_outcome = None;
        self.approvals.clear();
        self.questions.clear();
        self.pending_user = None;
        self.revision += 1;
        self.publish();
    }

    fn check_interaction_budget(&self, pending: &Value) -> Result<()> {
        // Count the complete projected inputs (including duplicated question
        // descriptions) together. Never offer approval of a clipped command.
        ensure!(
            serde_json::to_vec(&(&self.approvals, &self.questions, pending))?.len() <= 1024 * 1024,
            "Claude pending interaction exceeds Web delivery budget; process stopped"
        );
        Ok(())
    }

    fn start_text_block(&mut self) {
        self.text_block_serial += 1;
        // A transcript UUID arrives only with the completed AssistantMessage.
        // Keep partial blocks separate until that UUID replaces this identity.
        self.message_id = format!("live:{}:assistant:{}", self.turn_id, self.text_block_serial);
        self.message_text.clear();
        self.partial = false;
    }

    fn append(&mut self, text: &str) -> Result<()> {
        ensure!(
            self.stream_text.len() + text.len() <= MAX_TEXT,
            "Claude output exceeds 4 MiB"
        );
        self.stream_text.push_str(text);
        self.message_text.push_str(text);
        Ok(())
    }

    fn approve(
        &mut self,
        request_id: &Value,
        turn_id: &str,
        decision: &str,
        revision: u64,
    ) -> Result<Value> {
        ensure!(revision == self.revision, "stale Claude revision");
        ensure!(
            turn_id == self.turn_id
                && matches!(self.status.as_str(), "waiting-approval" | "waiting-input"),
            "stale Claude turn"
        );
        ensure!(
            matches!(decision, "allow" | "deny"),
            "unsupported Claude approval decision"
        );
        let index = self
            .approvals
            .iter()
            .position(|a| &a["requestId"] == request_id)
            .context("unknown or already answered Claude approval")?;
        let approval = self.approvals.remove(index);
        self.revision += 1;
        self.status = if !self.questions.is_empty() {
            "waiting-input"
        } else if self.approvals.is_empty() {
            "running"
        } else {
            "waiting-approval"
        }
        .into();
        self.publish();
        let response = if decision == "allow" {
            json!({"behavior":"allow", "updatedInput":approval["input"]})
        } else {
            json!({"behavior":"deny", "message":"Denied by the user"})
        };
        Ok(
            json!({"type":"control_response", "response":{"subtype":"success", "request_id":request_id,"response":response}}),
        )
    }

    fn frame(&mut self, frame: Value) -> Result<Option<Value>> {
        if let Some(id) = frame.get("session_id") {
            ensure!(
                id.as_str() == Some(self.session_id.as_str()),
                "Claude session ID changed unexpectedly"
            );
        }
        match frame["type"]
            .as_str()
            .context("Claude frame missing type")?
        {
            // Claude 2.1.263's embedded SDK schema declares these as outbound
            // notifications. A command lifecycle event describes queue delivery,
            // not a tool permission or the authoritative turn result. Heartbeats
            // explicitly require no response. Keep notifications revision-neutral
            // so liveness/metadata cannot invalidate a pending approval.
            "command_lifecycle" | "keep_alive" | "transcript_mirror" | "active_goal"
            | "autocompact_state" => return Ok(None),
            "control_response" => {
                ensure!(
                    !self.initialized && frame["response"]["request_id"] == self.init_id,
                    "unexpected Claude control response"
                );
                ensure!(
                    frame["response"]["subtype"] == "success",
                    "Claude initialize failed"
                );
                self.initialized = true;
                self.revision += 1;
                self.publish();
                return Ok(self.pending_user.take());
            }
            "control_request" => {
                ensure!(
                    self.initialized,
                    "Claude requested interaction before initialize"
                );
                ensure!(
                    matches!(
                        self.status.as_str(),
                        "running" | "waiting-approval" | "waiting-input"
                    ),
                    "Claude interaction outside active turn"
                );
                let id = frame["request_id"]
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .context("invalid Claude request id")?;
                ensure!(
                    self.seen_requests.len() < 4096,
                    "too many Claude control requests"
                );
                ensure!(
                    self.seen_requests.insert(id.to_owned()),
                    "duplicate Claude control request"
                );
                let request = &frame["request"];
                ensure!(
                    request["subtype"] == "can_use_tool",
                    "unsupported Claude control request; process stopped"
                );
                let name = request["tool_name"]
                    .as_str()
                    .filter(|name| !name.is_empty())
                    .context("invalid Claude tool name")?;
                ensure!(request["input"].is_object(), "invalid Claude tool input");
                ensure!(
                    self.approvals.len() < 32,
                    "too many pending Claude approvals"
                );
                ensure!(
                    request.as_object().unwrap().keys().all(|key| matches!(
                        key.as_str(),
                        "subtype"
                            | "tool_name"
                            | "input"
                            | "tool_use_id"
                            | "permission_suggestions"
                            | "blocked_path"
                            | "decision_reason"
                            | "agent_id"
                            | "title"
                            | "display_name"
                            | "description"
                            | "decision_reason_type"
                            | "matched_ask_rule"
                            | "classifier_approvable"
                            | "suppress_always_allow_rule"
                            | "default_to_no"
                            | "requires_user_interaction"
                    )),
                    "unsupported Claude permission scope"
                );
                if name == "AskUserQuestion" {
                    let questions = question_schema(&request["input"])?;
                    ensure!(self.questions.len() < 32, "too many pending questions");
                    let pending = json!({"requestId":id,"turnId":self.turn_id,"method":"claude/AskUserQuestion","supported":true,"questions":questions,"input":request["input"]});
                    self.check_interaction_budget(&pending)?;
                    self.questions.push(pending);
                    self.status = "waiting-input".into();
                    self.revision += 1;
                    self.publish();
                    return Ok(None);
                }
                ensure!(
                    request
                        .get("requires_user_interaction")
                        .is_none_or(|value| value == false)
                        && name != "AskUserQuestion",
                    "unsupported Claude user interaction; process stopped"
                );
                let mut context = request.as_object().unwrap().clone();
                context.remove("input");
                context.remove("tool_name");
                context.remove("subtype");
                context.insert("blockedPath".into(), request["blocked_path"].clone());
                context.insert("decisionReason".into(), request["decision_reason"].clone());
                context.insert(
                    "permissionSuggestions".into(),
                    request["permission_suggestions"].clone(),
                );
                let pending = json!({"requestId":id,"turnId":self.turn_id,"method":"claude/can_use_tool","supported":true,"toolName":name,"input":request["input"],"context":context,"availableDecisions":["allow","deny"]});
                self.check_interaction_budget(&pending)?;
                self.approvals.push(pending);
                self.status = if self.questions.is_empty() {
                    "waiting-approval"
                } else {
                    "waiting-input"
                }
                .into();
            }
            "control_cancel_request" => {
                ensure!(
                    frame["request_id"].is_string(),
                    "invalid Claude cancellation"
                );
                self.approvals
                    .retain(|a| a["requestId"] != frame["request_id"]);
                self.questions
                    .retain(|a| a["requestId"] != frame["request_id"]);
                if self.questions.is_empty() && self.status == "waiting-input" {
                    self.status = if self.approvals.is_empty() {
                        "running"
                    } else {
                        "waiting-approval"
                    }
                    .into();
                }
                if self.approvals.is_empty() && self.status == "waiting-approval" {
                    self.status = "running".into();
                }
            }
            "stream_event" => {
                let event = &frame["event"];
                if event["type"] == "message_start" {
                    self.message_id.clear();
                    self.message_text.clear();
                    self.partial = false;
                }
                if event["type"] == "content_block_start"
                    && event["content_block"]["type"] == "text"
                {
                    self.start_text_block();
                    self.append(event["content_block"]["text"].as_str().unwrap_or(""))?;
                    self.partial = true;
                }
                if event["type"] == "content_block_start" {
                    self.observe_bash(&event["content_block"], &frame["parent_tool_use_id"])?;
                }
                if event["type"] == "content_block_delta" && event["delta"]["type"] == "text_delta"
                {
                    let text = event["delta"]["text"]
                        .as_str()
                        .context("invalid Claude text delta")?;
                    if !self.partial {
                        self.start_text_block();
                    }
                    self.append(text)?;
                    self.partial = true;
                }
            }
            "assistant" => {
                let native = frame["uuid"]
                    .as_str()
                    .filter(|id| valid_message_id(id))
                    .or_else(|| {
                        frame["message"]["id"]
                            .as_str()
                            .filter(|id| valid_message_id(id))
                    })
                    .unwrap_or("");
                let has_text = frame["message"]["content"]
                    .as_array()
                    .is_some_and(|blocks| blocks.iter().any(|block| block["type"] == "text"));
                if self.partial && has_text && !native.is_empty() {
                    if let Some(publisher) = &self.publisher {
                        publisher.alias_item(&self.message_id, native);
                    }
                    self.message_id = native.into();
                } else if !self.partial && has_text && self.message_id != native {
                    self.message_id = native.into();
                    self.message_text.clear();
                }
                if let Some(blocks) = frame["message"]["content"].as_array() {
                    for block in blocks {
                        self.observe_bash(block, &frame["parent_tool_use_id"])?;
                    }
                }
                if !self.partial
                    && let Some(blocks) = frame["message"]["content"].as_array()
                {
                    for block in blocks {
                        if block["type"] == "text" {
                            self.append(block["text"].as_str().context("invalid Claude text")?)?;
                        }
                    }
                }
                if has_text {
                    self.publish_completed_message();
                }
                if let Some(publisher) = &self.publisher {
                    for block in frame["message"]["content"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|block| block["type"] == "tool_use")
                    {
                        if let Some(id) = block["id"]
                            .as_str()
                            .filter(|id| !id.is_empty() && id.len() <= 256)
                        {
                            ensure!(
                                self.tools.len() < 1024 || self.tools.contains_key(id),
                                "too many Claude tools"
                            );
                            let item = json!({"id":id,"kind":"tool-summary","turn_id":self.turn_id,"tool_name":block["name"],"tool_status":"running","attachment_count":0,"truncated":false});
                            self.tools.insert(id.into(), item.clone());
                            publisher.item(item);
                        }
                    }
                }
                self.partial = false;
            }
            "result" => {
                ensure!(
                    self.foreground_tasks.is_empty(),
                    "Claude result with unresolved foreground tasks"
                );
                self.usage = frame.get("usage").cloned();
                ensure!(
                    self.initialized,
                    "Claude resume failed before initialization"
                );
                ensure!(
                    self.approvals.is_empty() && self.questions.is_empty(),
                    "Claude result with unresolved approvals"
                );
                if frame["is_error"] == true || frame["subtype"] != "success" {
                    bail!(
                        "Claude turn failed: {}",
                        frame["errors"]
                            .as_array()
                            .map(|errors| errors
                                .iter()
                                .filter_map(Value::as_str)
                                .collect::<Vec<_>>()
                                .join("; "))
                            .filter(|s| !s.is_empty())
                            .or_else(|| frame["result"].as_str().map(str::to_owned))
                            .unwrap_or_else(|| "unknown execution error".into())
                    );
                }
                if self.stream_text.is_empty()
                    && let Some(text) = frame["result"].as_str()
                {
                    self.append(text)?;
                }
                self.status = "idle".into();
                self.publish_completed_message();
                self.stream_text.clear();
            }
            "system" => {
                if frame["subtype"] == "init" {
                    self.model = frame["model"].as_str().map(str::to_owned);
                }
                if matches!(
                    frame["subtype"].as_str(),
                    Some("task_started" | "background_tasks_changed")
                ) || (self.foreground_bash_contract
                    && matches!(
                        frame["subtype"].as_str(),
                        Some("task_updated" | "task_notification")
                    ))
                {
                    // 2.1.285 registers foreground Bash as tasks too. Association and
                    // explicit foreground state are required; this grants no tool permission.
                    self.task_frame(&frame)?;
                }
            }
            "user" => {
                self.publish_user(&frame);
                for block in frame["message"]["content"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|block| block["type"] == "tool_result")
                {
                    if let Some(item) = block["tool_use_id"]
                        .as_str()
                        .and_then(|id| self.tools.get_mut(id))
                    {
                        item["tool_status"] = json!(if block["is_error"] == true {
                            "failed"
                        } else {
                            "completed"
                        });
                        if let Some(publisher) = &self.publisher {
                            publisher.item(item.clone());
                        }
                    }
                }
            }
            "tool_progress" | "tool_use_summary" | "rate_limit_event" | "auth_status"
            | "prompt_suggestion" => {}
            unknown => {
                let safe_type: String = unknown
                    .chars()
                    .take(64)
                    .map(|character| {
                        if character.is_ascii_alphanumeric() || matches!(character, '_' | '-') {
                            character
                        } else {
                            '_'
                        }
                    })
                    .collect();
                bail!("unsupported Claude stream frame ({safe_type}); process stopped");
            }
        }
        self.revision += 1;
        self.publish();
        Ok(None)
    }
}

enum Event {
    Frame(Value),
    Error(String),
    Eof,
    Write(Value),
    UserWritten(Value),
    Control(Control, SyncSender<Result<()>>),
}

fn valid_message_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 256 && id.trim() == id && !id.chars().any(char::is_control)
}

fn write_native_frame(
    stdin: &mut impl Write,
    frame: Value,
    events: &SyncSender<Event>,
) -> Result<()> {
    serde_json::to_writer(&mut *stdin, &frame)?;
    stdin.write_all(b"\n")?;
    stdin.flush()?;
    // Queue admission and initialize acknowledgement do not prove dispatch.
    // Only a complete pipe write publishes the original native user UUID.
    if frame["type"] == "user" {
        events.send(Event::UserWritten(frame))?;
    }
    Ok(())
}

enum Control {
    Approve(Value, String, String, u64),
    Answer(Value, String, Value, u64),
}

impl Control {
    fn apply(self, state: &mut State) -> Result<Value> {
        match self {
            Self::Approve(id, turn, decision, revision) => {
                state.approve(&id, &turn, &decision, revision)
            }
            Self::Answer(id, turn, answers, revision) => {
                state.answer(&id, &turn, &answers, revision)
            }
        }
    }
}

fn process_control(state: &mut State, control: Control, writer: &SyncSender<Value>) -> Result<()> {
    // Called by the same lifecycle consumer as cancellation/result frames.
    // Never enqueue a prevalidated response ahead of pending inbound events.
    let response = control.apply(state)?;
    if let Err(error) = write_frame(writer, response) {
        state.fail("Claude interaction transport unavailable");
        return Err(error);
    }
    Ok(())
}

struct Worker {
    sender: SyncSender<Event>,
    stop: Arc<AtomicBool>,
    join: Option<thread::JoinHandle<()>>,
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

pub struct Runner {
    workspace: PathBuf,
    uuid: String,
    state: Arc<Mutex<State>>,
    worker: Mutex<Option<Worker>>,
    fresh: AtomicBool,
    #[cfg(test)]
    executable: Option<PathBuf>,
}

struct SessionLock(File);

impl Drop for SessionLock {
    fn drop(&mut self) {
        // A concurrently forked child can retain this open file description
        // until exec closes it. Closing only our descriptor would then leave
        // flock held transiently; explicitly release ownership before closing.
        let _ = self.0.unlock();
    }
}

fn acquire_session_lock(path: &std::path::Path) -> Result<SessionLock> {
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)?;
    lock.try_lock()
        .context("Claude session is managed by another process")?;
    Ok(SessionLock(lock))
}

impl Runner {
    pub(crate) fn republish_live(&self) {
        let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(publisher) = &state.publisher {
            publisher.observe(state.stream_snapshot());
        }
    }
    pub(crate) fn set_publisher(&self, publisher: crate::session_stream::Publisher) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.publisher = Some(publisher);
        state.publish();
    }
    pub(crate) fn set_managed_publisher(
        &self,
        publisher: crate::session_stream::Publisher,
        live: &Value,
    ) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        // Service metadata accompanies every native update. Copy only static
        // identity/configuration: `live` may predate a frame that already won
        // the runner lock, so its revision/status must never replace that frame.
        state.stream_context = json!({
            "sourceSessionId": live["sourceSessionId"],
            "workspaceId": live["workspaceId"],
            "permissionMode": live["permissionMode"],
            "cliVersion": live["cliVersion"],
        });
        state.publisher = Some(publisher);
        state.publish();
    }
    #[cfg(test)]
    pub(crate) fn mock_worker(status: &str) -> Self {
        let runner = Self::new(PathBuf::new(), "test".into());
        runner.state.lock().unwrap().status = status.into();
        let (sender, _) = mpsc::sync_channel(32);
        *runner.worker.lock().unwrap() = Some(Worker {
            sender,
            stop: Arc::new(AtomicBool::new(false)),
            join: None,
        });
        runner
    }

    #[cfg(test)]
    pub(crate) fn mock_cleanup_failure(status: &str) -> Self {
        let runner = Self::mock_worker(status);
        runner.state.lock().unwrap().turn_id = "cleanup-turn".into();
        let shared = runner.state.clone();
        let mut worker = runner.worker.lock().unwrap();
        let stop = worker.as_ref().unwrap().stop.clone();
        worker.as_mut().unwrap().join = Some(thread::spawn(move || {
            while !stop.load(Ordering::Acquire) {
                thread::yield_now();
            }
            let mut state = shared.lock().unwrap();
            state.cleanup_error = Some("injected process enumeration failure".into());
            state.fail("Claude process cleanup unconfirmed");
        }));
        drop(worker);
        runner
    }

    #[cfg(all(test, unix))]
    pub(crate) fn mock_cleanup_gate(
        started: mpsc::Sender<()>,
        released: mpsc::Receiver<()>,
    ) -> Self {
        let runner = Self::mock_worker("idle");
        let mut worker = runner.worker.lock().unwrap();
        let stop = worker.as_ref().unwrap().stop.clone();
        worker.as_mut().unwrap().join = Some(thread::spawn(move || {
            while !stop.load(Ordering::Acquire) {
                thread::yield_now();
            }
            started.send(()).unwrap();
            released.recv().unwrap();
        }));
        drop(worker);
        runner
    }

    pub fn has_worker(&self) -> bool {
        self.worker
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_some()
    }

    pub fn retire_if_inactive(&self) -> bool {
        let mut worker = self.worker.lock().unwrap_or_else(|p| p.into_inner());
        let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let finished = worker
            .as_ref()
            .and_then(|worker| worker.join.as_ref())
            .is_some_and(thread::JoinHandle::is_finished);
        if worker.is_none() || (state.status != "idle" && !finished) {
            return false;
        }
        let retired = worker.take();
        if let Some(retired) = &retired {
            retired.stop.store(true, Ordering::Release);
        }
        // Stop and join with the old initialized state intact: a worker may
        // already be waiting for this mutex with an inbound frame in hand.
        drop(state);
        drop(retired);
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.status == "idle" {
            state.initialized = false;
            state.init_id.clear();
            state.seen_requests.clear();
            state.bash_tool_ids.clear();
            state.foreground_tasks.clear();
            state.revision += 1;
            state.publish();
        }
        true
    }

    pub fn installation_supported() -> bool {
        Self::installation_version().is_some()
    }
    pub fn installation_version() -> Option<String> {
        let executable = agentkib_platform::command::resolve("claude")?;
        check_version_info(executable)
            .ok()
            .map(|(_, version)| version)
    }

    pub fn new(workspace: PathBuf, uuid: String) -> Self {
        Self {
            workspace,
            uuid,
            state: Arc::new(Mutex::new(State {
                status: "idle".into(),
                ..State::default()
            })),
            worker: Mutex::new(None),
            fresh: AtomicBool::new(false),
            #[cfg(test)]
            executable: None,
        }
    }

    pub fn new_session(workspace: PathBuf, uuid: String) -> Self {
        let runner = Self::new(workspace, uuid);
        runner.fresh.store(true, Ordering::Release);
        runner
    }

    #[cfg(test)]
    pub fn set_test_executable(&mut self, path: PathBuf) {
        self.executable = Some(path);
    }

    pub fn restore_revision(&self, revision: u64) -> Result<()> {
        ensure!(!self.has_worker(), "Claude worker already started");
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("Claude state lock poisoned"))?;
        ensure!(state.status == "idle", "Claude state is not idle");
        state.revision = revision;
        Ok(())
    }

    pub fn shutdown(&self) -> Result<()> {
        let worker = self.worker.lock().unwrap_or_else(|p| p.into_inner()).take();
        drop(worker);
        let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        ensure!(
            state.cleanup_error.is_none(),
            "Claude process cleanup unconfirmed: {}",
            state.cleanup_error.as_deref().unwrap_or_default()
        );
        Ok(())
    }

    pub fn snapshot(&self) -> Value {
        let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.snapshot()
    }

    pub fn send(&self, text: &str, expected_revision: u64) -> Result<()> {
        self.send_with_start(text, expected_revision, |state, user| {
            self.start(state, user)
        })
    }

    fn send_with_start(
        &self,
        text: &str,
        expected_revision: u64,
        start: impl FnOnce(&mut State, Value) -> Result<Worker>,
    ) -> Result<()> {
        ensure!(
            !text.trim().is_empty() && text.len() <= 128 * 1024,
            "Claude message must contain 1–131072 bytes"
        );
        self.send_content_with_start(json!(text), None, expected_revision, start)
    }

    pub fn send_content(&self, content: Value, turn_id: &str, revision: u64) -> Result<()> {
        uuid::Uuid::parse_str(turn_id).context("invalid Claude turn ID")?;
        validate_content(&content)?;
        self.send_content_with_start(content, Some(turn_id), revision, |state, user| {
            self.start(state, user)
        })
    }

    fn send_content_with_start(
        &self,
        content: Value,
        turn: Option<&str>,
        expected_revision: u64,
        start: impl FnOnce(&mut State, Value) -> Result<Worker>,
    ) -> Result<()> {
        let mut worker = self
            .worker
            .lock()
            .map_err(|_| anyhow::anyhow!("Claude worker lock poisoned"))?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("Claude state lock poisoned"))?;
        ensure!(state.revision == expected_revision, "stale Claude revision");
        ensure!(state.status == "idle", "Claude session is busy or failed");
        let before_start = worker.is_none().then(|| state.clone());
        let turn_id = turn
            .map(str::to_owned)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let user = json!({"type":"user","session_id":self.uuid,"parent_tool_use_id":null,"uuid":turn_id,"message":{"role":"user","content":content}});
        state.turn_id = turn_id;
        state.stream_text.clear();
        state.message_text.clear();
        state.message_id.clear();
        state.tools.clear();
        state.partial = false;
        state.reason = None;
        state.last_outcome = None;
        ensure!(
            state.cleanup_error.is_none(),
            "Claude process cleanup unconfirmed"
        );
        state.bash_tool_ids.clear();
        state.foreground_tasks.clear();
        state.status = "running".into();
        state.revision += 1;
        state.publish();
        if let Some(worker) = worker.as_ref() {
            if let Err(error) = worker.sender.try_send(Event::Write(user)) {
                state.fail("Claude worker unavailable");
                return Err(error.into());
            }
        } else {
            match start(&mut state, user) {
                Ok(started) => *worker = Some(started),
                Err(error) => {
                    // start only returns errors before any frame is admitted.
                    // A temporary lock/version/spawn failure must not poison this
                    // retained runner. Preserve the last completed turn, but make
                    // callers resynchronize before explicitly trying again.
                    *state = before_start.expect("startup state captured");
                    state.revision += 1;
                    state.reason = Some(error.to_string());
                    state.publish();
                    return Err(error);
                }
            }
        }
        Ok(())
    }

    pub fn approve(
        &self,
        request_id: &Value,
        turn_id: &str,
        decision: &str,
        expected_revision: u64,
    ) -> Result<()> {
        self.control(Control::Approve(
            request_id.clone(),
            turn_id.into(),
            decision.into(),
            expected_revision,
        ))
    }

    pub fn answer(&self, id: &Value, turn: &str, answers: &Value, revision: u64) -> Result<()> {
        self.control(Control::Answer(
            id.clone(),
            turn.into(),
            answers.clone(),
            revision,
        ))
    }

    pub fn stop(&self, turn: &str, revision: u64) -> Result<()> {
        let mut worker = self
            .worker
            .lock()
            .map_err(|_| anyhow::anyhow!("Claude worker lock poisoned"))?;
        let state = self
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("Claude state lock poisoned"))?;
        ensure!(
            state.revision == revision
                && state.turn_id == turn
                && matches!(
                    state.status.as_str(),
                    "running" | "waiting-approval" | "waiting-input"
                )
                && state.reason.is_none(),
            "stale Claude turn"
        );
        let retired = worker.take().context("Claude session has not started")?;
        retired.stop.store(true, Ordering::Release);
        // Keep the worker lock until the old process has exited. It can still
        // hold the state lock or have an inbound frame in flight.
        drop(state);
        drop(retired);
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("Claude state lock poisoned"))?;
        ensure!(
            state.cleanup_error.is_none(),
            "Claude process cleanup unconfirmed: {}",
            state.cleanup_error.as_deref().unwrap_or_default()
        );
        state.bash_tool_ids.clear();
        state.foreground_tasks.clear();
        state.status = "idle".into();
        state.last_outcome = Some("cancelled".into());
        state.initialized = false;
        state.init_id.clear();
        state.seen_requests.clear();
        state.partial = false;
        state.approvals.clear();
        state.questions.clear();
        state.pending_user = None;
        state.reason = None;
        state.revision += 1;
        state.publish();
        Ok(())
    }

    fn control(&self, control: Control) -> Result<()> {
        let worker = self
            .worker
            .lock()
            .map_err(|_| anyhow::anyhow!("Claude worker lock poisoned"))?;
        let worker = worker.as_ref().context("Claude session has not started")?;
        let (reply, result) = mpsc::sync_channel(1);
        worker.sender.try_send(Event::Control(control, reply))?;
        match result.recv_timeout(Duration::from_secs(5)) {
            Ok(outcome) => outcome,
            Err(_) => {
                // Admission succeeded but its acknowledgement is uncertain. Do
                // not report a safe rejection or permit another operation.
                self.state
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .fail("Claude interaction acknowledgement unavailable");
                worker.stop.store(true, Ordering::Release);
                Ok(())
            }
        }
    }

    fn start(&self, state: &mut State, user: Value) -> Result<Worker> {
        let uuid = uuid::Uuid::parse_str(&self.uuid).context("invalid Claude session UUID")?;
        state.session_id = self.uuid.clone();
        let lock_dir = dirs::data_local_dir()
            .context("runtime data directory unavailable")?
            .join("agentkib/claude-runner-locks");
        std::fs::create_dir_all(&lock_dir)?;
        let lock = acquire_session_lock(&lock_dir.join(format!("{uuid}.lock")))?;
        // GUI launches may have only the system PATH. Resolve with the same
        // platform search rules as discovery, then launch the verified binary.
        #[cfg(not(test))]
        let (executable, version) = check_version()?;
        #[cfg(test)]
        let (executable, version) = match &self.executable {
            Some(path) => check_version_info(path.clone())?,
            None => check_version()?,
        };
        state.foreground_bash_contract = version == CURRENT_SUPPORTED_VERSION;
        let mut command = Command::new(executable);
        #[cfg(unix)]
        command.process_group(0);
        // Non-Unix descendant cleanup needs a job object before it can be enabled.
        ensure!(cfg!(unix), "managed Claude process groups require Unix");
        let fresh = self.fresh.load(Ordering::Acquire);
        let mut child = command
            .current_dir(&self.workspace)
            .arg(format!(
                "{}={}",
                if fresh { "--session-id" } else { "--resume" },
                self.uuid
            ))
            .args([
                "--print",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--verbose",
                "--include-partial-messages",
                "--permission-prompts",
                "host",
                "--permission-prompt-tool",
                "stdio",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .context("failed to start Claude")?;
        #[cfg(target_os = "macos")]
        let owned_tree = agentkib_platform::process::owned_tree::OwnedProcessTree::attach(&child);
        self.fresh.store(false, Ordering::Release);
        // No error after this point may escape as a retryable startup failure.
        // Pipe setup failure has not sent input, but still needs child cleanup.
        let pipes = child.stdout.take().zip(child.stdin.take());
        let Some((stdout, mut stdin)) = pipes else {
            let _ = child.kill();
            let _ = child.wait();
            bail!("Claude stdio unavailable");
        };
        let (sender, receiver) = mpsc::sync_channel(32);
        let (writer, write_queue) = mpsc::sync_channel::<Value>(32);
        let write_errors = sender.clone();
        // Keep pipe backpressure off the lifecycle worker so Drop can always kill
        // our own child, even when that child has stopped reading stdin.
        thread::spawn(move || {
            for frame in write_queue {
                let result = write_native_frame(&mut stdin, frame, &write_errors);
                if result.is_err() {
                    let _ = write_errors.send(Event::Error("Claude stdin write failed".into()));
                    break;
                }
            }
        });
        let reader_sender = sender.clone();
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                match read_frame(&mut reader) {
                    Ok(None) => {
                        let _ = reader_sender.send(Event::Eof);
                        break;
                    }
                    Ok(Some(frame)) => {
                        if reader_sender.send(Event::Frame(frame)).is_err() {
                            break;
                        }
                    }
                    Err(error) => {
                        let _ = reader_sender.send(Event::Error(error.to_string()));
                        break;
                    }
                }
            }
        });
        state.init_id = uuid::Uuid::new_v4().to_string();
        state.pending_user = Some(user);
        let initialize = json!({"type":"control_request","request_id":state.init_id,"request":{"subtype":"initialize","hooks":null}});
        let shared = self.state.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = stop.clone();
        let join = thread::spawn(move || {
            let _lock = lock;
            let started = Instant::now();
            let result = (|| -> Result<()> {
                let mut awaiting_user_write = false;
                let mut early_frames = Vec::new();
                let mut early_bytes = 0usize;
                write_frame(&writer, initialize)?;
                loop {
                    if worker_stop.load(Ordering::Acquire) {
                        return Ok(());
                    }
                    let state = shared
                        .lock()
                        .map_err(|_| anyhow::anyhow!("Claude state lock poisoned"))?;
                    ensure!(state.status != "outcome-unknown", "Claude session failed");
                    ensure!(
                        state.initialized || started.elapsed() < Duration::from_secs(30),
                        "Claude initialize timed out"
                    );
                    #[cfg(target_os = "macos")]
                    ensure!(
                        owned_tree
                            .as_ref()
                            .map_err(|error| anyhow::anyhow!(error.to_string()))?
                            .root_running()?,
                        "Claude process exited before managed cleanup"
                    );
                    #[cfg(not(target_os = "macos"))]
                    if let Some(exit) = child.try_wait()? {
                        bail!("Claude process exited ({exit})");
                    }
                    drop(state);
                    let event = receiver.recv_timeout(Duration::from_millis(100));
                    if worker_stop.load(Ordering::Acquire) {
                        return Ok(());
                    }
                    match event {
                        Ok(Event::Frame(frame)) => {
                            if awaiting_user_write {
                                // The stdout reader can win the scheduling race
                                // with the writer acknowledgement. Keep the user
                                // before its reply without holding a state lock
                                // across a potentially blocked stdin write.
                                early_bytes += serde_json::to_vec(&frame)?.len();
                                ensure!(
                                    early_bytes <= MAX_LINE,
                                    "Claude output before dispatch confirmation exceeds limit"
                                );
                                early_frames.push(frame);
                                continue;
                            }
                            let response = shared
                                .lock()
                                .unwrap_or_else(|p| p.into_inner())
                                .frame(frame)?;
                            if let Some(response) = response {
                                awaiting_user_write = response["type"] == "user";
                                write_frame(&writer, response)?;
                            }
                        }
                        Ok(Event::Write(frame)) => {
                            awaiting_user_write = frame["type"] == "user";
                            write_frame(&writer, frame)?;
                        }
                        Ok(Event::UserWritten(frame)) => {
                            let mut state = shared.lock().unwrap_or_else(|p| p.into_inner());
                            state.publish_user(&frame);
                            awaiting_user_write = false;
                            for frame in early_frames.drain(..) {
                                if let Some(response) = state.frame(frame)? {
                                    write_frame(&writer, response)?;
                                }
                            }
                            early_bytes = 0;
                        }
                        Ok(Event::Control(control, reply)) => {
                            let result = process_control(
                                &mut shared.lock().unwrap_or_else(|p| p.into_inner()),
                                control,
                                &writer,
                            );
                            let _ = reply.send(result);
                        }
                        Ok(Event::Error(error)) => bail!("{error}"),
                        Ok(Event::Eof) => bail!("Claude stream closed"),
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Err(mpsc::RecvTimeoutError::Disconnected) => {
                            bail!("Claude transport disconnected")
                        }
                    }
                }
            })();
            // Freeze the verified tree before terminating it: asking a shell to
            // exit first can orphan newly detached grandchildren before capture.
            #[cfg(target_os = "macos")]
            let cleanup = owned_tree.and_then(|mut tree| tree.terminate(&mut child));
            #[cfg(not(target_os = "macos"))]
            let cleanup = {
                terminate_owned_process_group(&mut child);
                Ok::<(), std::io::Error>(())
            };
            if let Err(error) = cleanup {
                // Best effort root termination cannot prove detached children exited.
                let _ = child.kill();
                let _ = child.try_wait();
                let mut state = shared.lock().unwrap_or_else(|p| p.into_inner());
                state.cleanup_error = Some(error.to_string());
                state.fail(format!("Claude process cleanup unconfirmed: {error}"));
            }
            if let Err(error) = result
                && !worker_stop.load(Ordering::Acquire)
            {
                let mut state = shared.lock().unwrap_or_else(|p| p.into_inner());
                if state.status != "outcome-unknown" {
                    state.fail(error.to_string());
                }
            }
        });
        Ok(Worker {
            sender,
            stop,
            join: Some(join),
        })
    }
}

fn write_frame(writer: &SyncSender<Value>, frame: Value) -> Result<()> {
    writer
        .try_send(frame)
        .context("Claude stdin queue unavailable")?;
    Ok(())
}

#[cfg(any(test, not(target_os = "macos")))]
fn terminate_owned_process_group(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        // Only called for children spawned with process_group(0), so their PID
        // is the private PGID; never discover or signal an external Claude group.
        let _ = Command::new("/bin/kill")
            .args(["-KILL", "--", &format!("-{}", child.id())])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn check_version() -> Result<(PathBuf, String)> {
    let executable =
        agentkib_platform::command::resolve("claude").context("Claude CLI unavailable")?;
    check_version_info(executable)
}

#[cfg(all(test, unix))]
fn check_version_at(executable: PathBuf) -> Result<PathBuf> {
    check_version_info(executable).map(|(path, _)| path)
}
fn check_version_info(executable: PathBuf) -> Result<(PathBuf, String)> {
    let mut child = Command::new(&executable)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .context("Claude CLI unavailable")?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = child.try_wait()? {
            let mut output = String::new();
            child
                .stdout
                .take()
                .context("Claude version stdout unavailable")?
                .take(4096)
                .read_to_string(&mut output)?;
            ensure!(
                status.success()
                    && matches!(output.trim(), SUPPORTED_VERSION | CURRENT_SUPPORTED_VERSION),
                "managed Claude requires CLI 2.1.263 or 2.1.285"
            );
            return Ok((executable, output.trim().to_owned()));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            bail!("Claude version check timed out");
        }
        thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn verifies_and_launches_resolved_cli_without_shell_path() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let system_bin = directory.path().join("system-bin");
        let user_bin = directory.path().join("home/.local/bin");
        std::fs::create_dir_all(&system_bin).unwrap();
        std::fs::create_dir_all(&user_bin).unwrap();
        let executable = user_bin.join("claude");
        std::fs::write(
            &executable,
            format!("#!/bin/sh\nprintf '%s\\n' '{SUPPORTED_VERSION}'\n"),
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(agentkib_platform::command::resolve_in("claude", [system_bin.as_path()]).is_none());
        let resolved = agentkib_platform::command::resolve_in(
            "claude",
            [system_bin.as_path(), user_bin.as_path()],
        )
        .unwrap();
        let verified = check_version_at(resolved).unwrap();
        assert_eq!(verified, executable);
        let output = Command::new(verified)
            .env("PATH", &system_bin)
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).unwrap().trim(),
            SUPPORTED_VERSION
        );

        std::fs::write(&executable, "#!/bin/sh\nprintf 'unknown version\\n'\n").unwrap();
        assert!(check_version_at(executable).is_err());
        assert!(check_version_at(user_bin.join("missing")).is_err());
    }

    #[test]
    fn startup_lock_failure_can_recover_only_after_resynchronizing() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("session.lock");
        let held = acquire_session_lock(&path).unwrap();
        let runner = Runner::new(PathBuf::new(), "test".into());
        {
            let mut state = runner.state.lock().unwrap();
            state.turn_id = "completed-turn".into();
            state.stream_text = "completed reply".into();
        }
        assert!(
            runner
                .send_with_start("first", 0, |_, _| {
                    acquire_session_lock(&path)?;
                    panic!("lock contention must reject before startup")
                })
                .is_err()
        );
        assert!(!runner.has_worker());
        assert_eq!(runner.snapshot()["status"], "idle");
        assert_eq!(runner.snapshot()["turnId"], "completed-turn");
        assert_eq!(runner.snapshot()["streamText"], "completed reply");
        assert!(
            runner
                .send_with_start("stale", 0, |_, _| panic!("stale revision"))
                .is_err()
        );
        drop(held);
        let revision = runner.snapshot()["revision"].as_u64().unwrap();
        runner
            .send_with_start("explicit retry", revision, |_, _| {
                let _lock = acquire_session_lock(&path)?;
                let (sender, _) = mpsc::sync_channel(32);
                Ok(Worker {
                    sender,
                    stop: Arc::new(AtomicBool::new(false)),
                    join: None,
                })
            })
            .unwrap();
        assert!(runner.has_worker());
        assert_eq!(runner.snapshot()["status"], "running");
    }

    #[test]
    fn startup_failure_does_not_recover_an_existing_uncertain_worker() {
        let runner = Runner::mock_worker("idle");
        assert!(runner.send("broken transport", 0).is_err());
        assert_eq!(runner.snapshot()["status"], "outcome-unknown");
        let revision = runner.snapshot()["revision"].as_u64().unwrap();
        assert!(
            runner
                .send_with_start("do not replay", revision, |_, _| {
                    panic!("uncertain delivery must never restart")
                })
                .is_err()
        );
    }

    #[test]
    fn synchronous_startup_failures_never_leave_pending_input() {
        let runner = Runner::new(PathBuf::new(), "test".into());
        for reason in ["version timeout", "spawn unavailable"] {
            let revision = runner.snapshot()["revision"].as_u64().unwrap();
            assert!(
                runner
                    .send_with_start("not delivered", revision, |state, user| {
                        state.session_id = "temporary".into();
                        state.pending_user = Some(user);
                        bail!(reason)
                    })
                    .is_err()
            );
            assert_eq!(runner.snapshot()["sendEnabled"], true);
            assert!(runner.state.lock().unwrap().pending_user.is_none());
            assert!(!runner.has_worker());
        }
    }

    fn active() -> State {
        State {
            initialized: true,
            status: "running".into(),
            turn_id: "turn".into(),
            ..State::default()
        }
    }
    #[test]
    fn control_republication_reads_native_completion_without_repeating_items() {
        let hub = crate::session_stream::Hub::new("boot".into(), |_| true);
        let runner = Runner::new(PathBuf::new(), "native".into());
        runner.set_publisher(hub.publisher("session", "managed-resume"));
        {
            let mut state = runner.state.lock().unwrap();
            state.status = "running".into();
            state.turn_id = "turn".into();
            state.initialized = true;
            state.revision = 10;
            state.publish();
        }
        let detached = runner.snapshot();
        {
            let mut state = runner.state.lock().unwrap();
            state.frame(json!({"type":"assistant","uuid":"answer","message":{"content":[{"type":"text","text":"done"}]}})).unwrap();
            state
                .frame(json!({"type":"result","subtype":"success","is_error":false}))
                .unwrap();
        }
        let completed = hub.subscribe("session", None).unwrap();
        runner.republish_live();
        let after = hub.subscribe("session", None).unwrap();
        let live = &after["events"][0]["payload"]["live"];
        assert_eq!(live["status"], "idle");
        assert_eq!(live["sendEnabled"], true);
        assert!(live["revision"].as_u64() > detached["revision"].as_u64());
        assert_eq!(after["cursor"], completed["cursor"]);
        assert_eq!(
            after["events"][0]["payload"]["items"],
            completed["events"][0]["payload"]["items"]
        );
    }
    #[test]
    fn managed_publication_preserves_identity_without_reverting_new_native_state() {
        let hub = crate::session_stream::Hub::new("boot".into(), |_| true);
        let runner = Runner::new(PathBuf::new(), "native".into());
        let mut previous = runner.snapshot();
        previous["sourceSessionId"] = json!("native");
        previous["workspaceId"] = json!("workspace");
        previous["cliVersion"] = json!(CURRENT_SUPPORTED_VERSION);
        previous["permissionMode"] = json!("cli-configured");
        runner.set_managed_publisher(hub.publisher("managed", "claude-managed"), &previous);
        {
            let mut state = runner.state.lock().unwrap();
            state.status = "running".into();
            state.turn_id = "turn".into();
            state.initialized = true;
            state
                .frame(json!({"type":"system","subtype":"init","model":"model"}))
                .unwrap();
            state.frame(permission("approval")).unwrap();
        }
        // This service snapshot was read before the approval arrived. A fresh
        // subscription must still see the approval and its current revision.
        runner.set_managed_publisher(hub.publisher("managed", "claude-managed"), &previous);
        let snapshot = hub.subscribe("managed", None).unwrap();
        let live = &snapshot["events"][0]["payload"]["live"];
        assert_eq!(live["status"], "waiting-approval");
        assert_eq!(live["model"], "model");
        assert_eq!(live["approvals"][0]["requestId"], "approval");
        assert!(live["revision"].as_u64().unwrap() > 0);
        for field in [
            "sourceSessionId",
            "workspaceId",
            "cliVersion",
            "permissionMode",
        ] {
            assert_eq!(live[field], previous[field]);
        }
        assert_eq!(live["sessionId"], "managed");
        assert_eq!(live["executionMode"], "claude-managed");
        {
            let mut state = runner.state.lock().unwrap();
            let revision = state.revision;
            state
                .approve(&json!("approval"), "turn", "allow", revision)
                .unwrap();
        }
        let live = hub.subscribe("managed", None).unwrap()["events"][0]["payload"]["live"].clone();
        assert_eq!(live["status"], "running");
        assert_eq!(live["approvals"], json!([]));
        assert_eq!(live["sourceSessionId"], "native");
    }

    fn permission(id: &str) -> Value {
        json!({"type":"control_request","request_id":id,"request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"pwd"}}})
    }

    #[test]
    fn interaction_budget_rejects_large_and_accumulated_inputs_without_clipping() {
        let mut state = active();
        let mut large = permission("large");
        large["request"]["input"]["command"] = json!("x".repeat(5 * 1024 * 1024));
        assert!(
            state
                .frame(large)
                .unwrap_err()
                .to_string()
                .contains("delivery budget")
        );
        assert!(state.approvals.is_empty());
        let mut question = permission("question");
        question["request"]["tool_name"] = json!("AskUserQuestion");
        question["request"]["input"] = json!({"questions":[{"question":"x".repeat(600 * 1024),"options":[{"label":"A"},{"label":"B"}]}]});
        assert!(
            state
                .frame(question)
                .unwrap_err()
                .to_string()
                .contains("delivery budget")
        );
        assert!(state.questions.is_empty());
        for index in 0..3 {
            let mut request = permission(&index.to_string());
            request["request"]["input"]["command"] = json!("x".repeat(300 * 1024));
            state.frame(request).unwrap();
        }
        let mut next = permission("overflow");
        next["request"]["input"]["command"] = json!("x".repeat(300 * 1024));
        assert!(state.frame(next).is_err());
        assert_eq!(state.approvals.len(), 3);
        // The lifecycle worker fails closed on this error and clears interactions.
        state.fail("Claude pending interaction exceeds Web delivery budget; process stopped");
        assert!(state.approvals.is_empty());
        assert_eq!(state.status, "outcome-unknown");
    }

    #[test]
    fn queued_cancellation_rejects_approval_and_answer_without_writing() {
        for question in [false, true] {
            let mut state = active();
            let mut request = permission("pending");
            if question {
                request["request"]["tool_name"] = json!("AskUserQuestion");
                request["request"]["input"] = json!({"questions":[{"question":"Which?","options":[{"label":"A"},{"label":"B"}]}]});
            }
            state.frame(request).unwrap();
            let revision = state.revision;
            let control = if question {
                Control::Answer(
                    json!("pending"),
                    "turn".into(),
                    json!({"Which?":["A"]}),
                    revision,
                )
            } else {
                Control::Approve(json!("pending"), "turn".into(), "allow".into(), revision)
            };
            let (events, queue) = mpsc::sync_channel(2);
            let (reply, outcome) = mpsc::sync_channel(1);
            events
                .send(Event::Frame(
                    json!({"type":"control_cancel_request","request_id":"pending"}),
                ))
                .unwrap();
            events.send(Event::Control(control, reply)).unwrap();
            let (writer, writes) = mpsc::sync_channel(1);
            if let Event::Frame(frame) = queue.recv().unwrap() {
                state.frame(frame).unwrap();
            }
            if let Event::Control(control, reply) = queue.recv().unwrap() {
                reply
                    .send(process_control(&mut state, control, &writer))
                    .unwrap();
            }
            assert!(outcome.recv().unwrap().is_err());
            assert!(writes.try_recv().is_err());
            assert_eq!(state.status, "running");
        }
    }

    #[test]
    fn lifecycle_control_writes_once_and_rejects_duplicate() {
        let mut state = active();
        state.frame(permission("pending")).unwrap();
        let revision = state.revision;
        let (writer, writes) = mpsc::sync_channel(2);
        let command =
            || Control::Approve(json!("pending"), "turn".into(), "allow".into(), revision);
        process_control(&mut state, command(), &writer).unwrap();
        assert_eq!(writes.recv().unwrap()["response"]["request_id"], "pending");
        assert!(process_control(&mut state, command(), &writer).is_err());
        assert!(writes.try_recv().is_err());
    }

    #[test]
    fn retirement_keeps_initialized_state_until_worker_has_joined() {
        let runner = Runner::mock_worker("idle");
        runner.state.lock().unwrap().initialized = true;
        let shared = runner.state.clone();
        let mut worker = runner.worker.lock().unwrap();
        let stop = worker.as_ref().unwrap().stop.clone();
        worker.as_mut().unwrap().join = Some(thread::spawn(move || {
            while !stop.load(Ordering::Acquire) {
                thread::yield_now();
            }
            let mut state = shared.lock().unwrap();
            if state
                .frame(json!({"type":"result","subtype":"success"}))
                .is_err()
            {
                state.fail("initialization was reset before pending frame drained");
            }
        }));
        drop(worker);
        assert!(runner.retire_if_inactive());
        assert_eq!(runner.snapshot()["status"], "idle");
        assert!(!runner.state.lock().unwrap().initialized);
    }

    #[test]
    fn retiring_idle_worker_preserves_freshness_and_never_recovers_unknown() {
        let runner = Runner::mock_worker("idle");
        let old = runner.snapshot()["revision"].as_u64().unwrap();
        assert!(runner.retire_if_inactive());
        assert!(!runner.has_worker());
        assert!(runner.snapshot()["revision"].as_u64().unwrap() > old);
        assert!(runner.send("must fail before launching", old).is_err());
        for status in [
            "running",
            "waiting-input",
            "waiting-approval",
            "outcome-unknown",
        ] {
            let runner = Runner::mock_worker(status);
            assert!(!runner.retire_if_inactive());
            assert!(runner.has_worker());
            assert_eq!(runner.snapshot()["status"], status);
        }
        let failed = Runner::mock_worker("outcome-unknown");
        let done = thread::spawn(|| {});
        while !done.is_finished() {
            thread::yield_now();
        }
        failed.worker.lock().unwrap().as_mut().unwrap().join = Some(done);
        assert!(failed.retire_if_inactive());
        assert!(!failed.has_worker());
        assert_eq!(failed.snapshot()["status"], "outcome-unknown");
        assert!(failed.send("must stay fenced", 0).is_err());
    }

    #[test]
    fn questions_round_trip_and_expire() {
        let mut state = active();
        let mut request = permission("question");
        request["request"]["tool_name"] = json!("AskUserQuestion");
        request["request"]["input"] = json!({"questions":[{"question":"Which?","header":"Choice","options":[{"label":"A"},{"label":"B"}],"multiSelect":true}]});
        request["request"]["requires_user_interaction"] = json!(true);
        state.frame(request).unwrap();
        assert!(state.approvals.is_empty());
        assert_eq!(state.status, "waiting-input");
        assert!(
            state
                .answer(
                    &json!("question"),
                    "turn",
                    &json!({"bad":["A"]}),
                    state.revision
                )
                .is_err()
        );
        state.frame(permission("approval")).unwrap();
        state
            .approve(&json!("approval"), "turn", "deny", state.revision)
            .unwrap();
        assert_eq!(state.status, "waiting-input");
        let response = state
            .answer(
                &json!("question"),
                "turn",
                &json!({"Which?":["A","B"]}),
                state.revision,
            )
            .unwrap();
        assert_eq!(
            response["response"]["response"]["updatedInput"]["answers"]["Which?"],
            "A, B"
        );
        assert_eq!(state.status, "running");
        assert!(
            state
                .answer(
                    &json!("question"),
                    "turn",
                    &json!({"Which?":["A"]}),
                    state.revision
                )
                .is_err()
        );
    }
    #[test]
    fn construction_is_passive() {
        let runner = Runner::new(PathBuf::from("/missing"), "invalid".into());
        assert_eq!(runner.snapshot()["status"], "idle");
        assert!(runner.worker.lock().unwrap().is_none());
    }
    #[test]
    fn approvals_are_exact_and_one_shot() {
        let mut state = active();
        state.frame(permission("a")).unwrap();
        assert!(state.approve(&json!("a"), "turn", "allow", 0).is_err());
        assert!(state.approve(&json!("a"), "old", "allow", 1).is_err());
        assert!(state.approve(&json!("a"), "turn", "always", 1).is_err());
        let response = state.approve(&json!("a"), "turn", "allow", 1).unwrap();
        assert_eq!(
            response["response"]["response"],
            json!({"behavior":"allow","updatedInput":{"command":"pwd"}})
        );
        assert!(state.approve(&json!("a"), "turn", "allow", 2).is_err());
        assert!(state.frame(permission("a")).is_err());
    }
    #[test]
    fn initialize_precedes_user_input() {
        let mut state = State {
            init_id: "init".into(),
            pending_user: Some(json!({"type":"user"})),
            ..State::default()
        };
        assert!(state.frame(permission("a")).is_err());
        assert_eq!(state.frame(json!({"type":"control_response","response":{"request_id":"init","subtype":"success"}})).unwrap(), Some(json!({"type":"user"})));
        assert!(state.initialized);
    }
    #[test]
    fn subscriptions_receive_written_users_on_initial_and_continuing_sends() {
        let (published, events) = mpsc::channel();
        let hub = crate::session_stream::Hub::new("boot".into(), move |event| {
            published.send(event).is_ok()
        });
        let runner = Runner::new(PathBuf::new(), "native-session".into());
        runner.set_publisher(hub.publisher("s", "managed-resume"));
        hub.subscribe("s", None).unwrap();
        let shared = runner.state.clone();
        runner
            .send_with_start("same prompt", 0, move |state, user| {
                state.init_id = "init".into();
                state.pending_user = Some(user);
                let (sender, receiver) = mpsc::sync_channel(32);
                let written = sender.clone();
                let stop = Arc::new(AtomicBool::new(false));
                let stopped = stop.clone();
                let join = thread::spawn(move || {
                    let mut stdin = Vec::new();
                    while !stopped.load(Ordering::Acquire) {
                        match receiver.recv_timeout(Duration::from_millis(10)) {
                            Ok(Event::Frame(frame)) => {
                                let response = shared.lock().unwrap().frame(frame).unwrap();
                                if let Some(response) = response {
                                    write_native_frame(&mut stdin, response, &written).unwrap();
                                }
                            }
                            Ok(Event::Write(frame)) => {
                                write_native_frame(&mut stdin, frame, &written).unwrap()
                            }
                            Ok(Event::UserWritten(frame)) => {
                                shared.lock().unwrap().publish_user(&frame)
                            }
                            Err(mpsc::RecvTimeoutError::Timeout) => {}
                            _ => break,
                        }
                    }
                });
                Ok(Worker {
                    sender,
                    stop,
                    join: Some(join),
                })
            })
            .unwrap();
        let pending = hub.subscribe("s", None).unwrap();
        assert!(
            pending["events"][0]["payload"]["items"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        hub.unsubscribe(pending["subscriptionId"].as_str().unwrap());
        runner.worker.lock().unwrap().as_ref().unwrap().sender.send(Event::Frame(json!({"type":"control_response","response":{"request_id":"init","subtype":"success"}}))).unwrap();
        let mut ids = Vec::new();
        for index in 0..2 {
            let deadline = Instant::now() + Duration::from_secs(2);
            let event = loop {
                let event = events
                    .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                    .unwrap();
                if event["type"] == "item-upsert" && event["payload"]["kind"] == "user-message" {
                    break event;
                }
            };
            let id = event["payload"]["id"].as_str().unwrap().to_owned();
            assert_eq!(event["payload"]["content"], "same prompt");
            assert_eq!(runner.snapshot()["turnId"], id);
            ids.push(id.clone());
            // The echoed/replayed native UUID has the same identity as JSONL history.
            let mut state = runner.state.lock().unwrap();
            state.frame(json!({"type":"user","uuid":id,"message":{"role":"user","content":"same prompt"}})).unwrap();
            state
                .frame(json!({"type":"result","subtype":"success","is_error":false}))
                .unwrap();
            let revision = state.revision;
            drop(state);
            if index == 0 {
                runner.send("same prompt", revision).unwrap();
            }
        }
        assert_ne!(ids[0], ids[1]);
        let baseline = hub.subscribe("s", None).unwrap();
        let users: Vec<_> = baseline["events"][0]["payload"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item["kind"] == "user-message")
            .collect();
        assert_eq!(users.len(), 2);
        assert_eq!(
            users
                .iter()
                .map(|item| item["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ids.iter().map(String::as_str).collect::<Vec<_>>()
        );
    }

    #[test]
    fn failed_user_writes_and_startup_never_publish_a_user() {
        struct FailedFlush;
        impl Write for FailedFlush {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Err(std::io::ErrorKind::BrokenPipe.into())
            }
        }
        let (sender, receiver) = mpsc::sync_channel(1);
        assert!(
            write_native_frame(
                &mut FailedFlush,
                json!({"type":"user","uuid":"user","message":{"content":"not confirmed"}}),
                &sender
            )
            .is_err()
        );
        assert!(receiver.try_recv().is_err());
        let hub = crate::session_stream::Hub::new("boot".into(), |_| true);
        let runner = Runner::new(PathBuf::new(), "test".into());
        runner.set_publisher(hub.publisher("s", "managed-resume"));
        assert!(
            runner
                .send_with_start("not dispatched", 0, |_, _| bail!(
                    "synthetic startup failure"
                ))
                .is_err()
        );
        assert!(
            hub.subscribe("s", None).unwrap()["events"][0]["payload"]["items"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
    #[test]
    fn deny_cancel_unknown_and_failure() {
        let mut state = active();
        state.frame(permission("a")).unwrap();
        let denied = state.approve(&json!("a"), "turn", "deny", 1).unwrap();
        assert_eq!(denied["response"]["response"]["behavior"], "deny");
        state.frame(permission("b")).unwrap();
        state
            .frame(json!({"type":"control_cancel_request","request_id":"b"}))
            .unwrap();
        assert!(state.approvals.is_empty());
        assert!(state.frame(json!({"type":"control_request","request_id":"c","request":{"subtype":"elicitation"}})).is_err());
        assert!(
            state
                .frame(json!({"type":"result","subtype":"success","is_error":true}))
                .is_err()
        );
    }
    #[test]
    fn partial_stream_is_not_duplicated() {
        let mut state = active();
        state.frame(json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}})).unwrap();
        state
            .frame(
                json!({"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}),
            )
            .unwrap();
        assert_eq!(state.stream_text, "hello");
        assert!(state.append(&"x".repeat(MAX_TEXT)).is_err());
        state
            .frame(json!({"type":"result","subtype":"success","is_error":false,"result":"hello"}))
            .unwrap();
        assert_eq!(state.status, "idle");
        assert!(state.stream_text.is_empty());
    }
    #[test]
    fn completed_message_projection_preserves_native_and_result_only_identities() {
        for (native, expected_id) in [
            (Some("message-id"), "message-id"),
            (None, "live:turn:assistant"),
        ] {
            let hub = crate::session_stream::Hub::new("boot".into(), |_| true);
            let mut state = active();
            state.publisher = Some(hub.publisher("s", "managed-resume"));
            state.publish();
            if let Some(native) = native {
                state.frame(json!({"type":"assistant","uuid":native,"message":{"content":[{"type":"text","text":"hello"}]}})).unwrap();
                let completed = hub.subscribe("s", None).unwrap();
                hub.unsubscribe(completed["subscriptionId"].as_str().unwrap());
                assert_eq!(
                    completed["events"][0]["payload"]["items"][0]["id"],
                    expected_id
                );
            }
            state
                .frame(
                    json!({"type":"result","subtype":"success","is_error":false,"result":"hello"}),
                )
                .unwrap();
            let result = hub.subscribe("s", None).unwrap();
            let items = result["events"][0]["payload"]["items"].as_array().unwrap();
            assert_eq!(items.len(), 1);
            assert_eq!(items[0]["id"], expected_id);
            assert_eq!(items[0]["kind"], "agent-message");
            assert_eq!(items[0]["content"], "hello");
            assert_eq!(items[0]["turn_id"], state.turn_id);
            assert_eq!(items[0]["truncated"], false);
            assert!(items[0]["timestamp"].as_str().is_some());
            assert!(state.stream_text.is_empty());
        }
    }

    #[test]
    fn native_message_ids_survive_deltas_and_multiple_messages_in_one_turn() {
        let hub = crate::session_stream::Hub::new("boot".into(), |_| true);
        let mut state = active();
        state.publisher = Some(hub.publisher("s", "managed-resume"));
        state.publish();
        for (id, text) in [("msg-z", "first"), ("msg-a", "second")] {
            state.frame(json!({"type":"stream_event","event":{"type":"message_start","message":{"id":id}}})).unwrap();
            state.frame(json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":text}}})).unwrap();
            state.frame(json!({"type":"assistant","message":{"id":id,"content":[{"type":"text","text":text}]}})).unwrap();
        }
        state.frame(json!({"type":"assistant","message":{"id":"msg-a","content":[{"type":"tool_use","id":"tool-a","name":"Read","input":{}}]}})).unwrap();
        let result = hub.subscribe("s", None).unwrap();
        let items = result["events"][0]["payload"]["items"].as_array().unwrap();
        assert_eq!(items.len(), 3);
        assert_eq!(items[0]["id"], "msg-z");
        assert_eq!(items[0]["content"], "first");
        assert_eq!(items[1]["id"], "msg-a");
        assert_eq!(items[1]["content"], "second");
    }

    #[test]
    fn shared_api_message_keeps_each_completed_block_and_partial_identity() {
        for streaming in [false, true] {
            let hub = crate::session_stream::Hub::new("boot".into(), |_| true);
            let mut state = active();
            state.publisher = Some(hub.publisher("s", "managed-resume"));
            state.publish();
            if streaming {
                state.frame(json!({"type":"stream_event","event":{"type":"message_start","message":{"id":"shared-response"}}})).unwrap();
            }
            for (index, id, text) in [
                (0, "text-before", "before tool"),
                (2, "text-after", "after tool"),
            ] {
                if index == 2 {
                    state.frame(json!({"type":"assistant","uuid":"tool-record","message":{"id":"shared-response","content":[{"type":"tool_use","id":"tool-1","name":"Read","input":{}}]}})).unwrap();
                }
                if streaming {
                    state.frame(json!({"type":"stream_event","event":{"type":"content_block_start","index":index,"content_block":{"type":"text","text":""}}})).unwrap();
                    state.frame(json!({"type":"stream_event","event":{"type":"content_block_delta","index":index,"delta":{"type":"text_delta","text":text}}})).unwrap();
                    let partial = hub.subscribe("s", None).unwrap();
                    let items = partial["events"][0]["payload"]["items"].as_array().unwrap();
                    let item = items.last().unwrap();
                    assert!(item["id"].as_str().unwrap().starts_with("live:"));
                    assert_eq!(item["content"], text);
                    assert_eq!(items.len(), if index == 0 { 1 } else { 3 });
                }
                // Claude emits one AssistantMessage per completed block with
                // a distinct record UUID and the same API response ID.
                state.frame(json!({"type":"assistant","uuid":id,"message":{"id":"shared-response","content":[{"type":"text","text":text}]}})).unwrap();
                if streaming {
                    state.frame(json!({"type":"stream_event","event":{"type":"content_block_stop","index":index}})).unwrap();
                }
            }
            assert_eq!(state.stream_text, "before toolafter tool");
            state
                .frame(json!({"type":"result","subtype":"success","is_error":false}))
                .unwrap();
            let result = hub.subscribe("s", None).unwrap();
            let items = result["events"][0]["payload"]["items"].as_array().unwrap();
            assert_eq!(
                items
                    .iter()
                    .map(|item| item["id"].as_str().unwrap())
                    .collect::<Vec<_>>(),
                ["text-before", "tool-1", "text-after"]
            );
            assert_eq!(items[0]["content"], "before tool");
            assert_eq!(items[2]["content"], "after tool");
        }
    }

    #[test]
    fn replayed_user_uses_transcript_uuid_before_api_message_id() {
        let hub = crate::session_stream::Hub::new("boot".into(), |_| true);
        let mut state = active();
        state.publisher = Some(hub.publisher("s", "managed-resume"));
        state.frame(json!({"type":"user","uuid":"user-record","message":{"id":"api-message","content":"hello"}})).unwrap();
        let result = hub.subscribe("s", None).unwrap();
        assert_eq!(
            result["events"][0]["payload"]["items"][0]["id"],
            "user-record"
        );
    }

    #[test]
    fn native_tool_results_replace_running_items_and_survive_reconnect() {
        let hub = crate::session_stream::Hub::new("boot".into(), |_| true);
        let mut state = active();
        state.publisher = Some(hub.publisher("s", "managed-resume"));
        state.publish();
        state
            .frame(
                json!({"type":"assistant","message":{"id":"message","content":[
                    {"type":"tool_use","id":"read","name":"Read","input":{}},
                    {"type":"tool_use","id":"write","name":"Write","input":{}}
                ]}}),
            )
            .unwrap();
        state.frame(json!({"type":"user","message":{"content":[
            {"type":"tool_result","tool_use_id":"read","content":"private result"},
            {"type":"tool_result","tool_use_id":"write","is_error":true,"content":"private error"}
        ]}})).unwrap();
        state
            .frame(json!({"type":"result","subtype":"success","is_error":false}))
            .unwrap();
        let baseline = hub.subscribe("s", None).unwrap();
        let items = baseline["events"][0]["payload"]["items"]
            .as_array()
            .unwrap();
        assert_eq!(
            items.iter().find(|item| item["id"] == "read").unwrap()["tool_status"],
            "completed"
        );
        assert_eq!(
            items.iter().find(|item| item["id"] == "write").unwrap()["tool_status"],
            "failed"
        );
        assert!(!baseline.to_string().contains("private"));
    }

    #[test]
    fn completed_frames_allow_full_output_and_json_escaping() {
        for text in ["x".repeat(MAX_TEXT), "\0".repeat(MAX_TEXT)] {
            let mut state = active();
            state.frame(json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":text}}})).unwrap();
            let frame =
                json!({"type":"assistant","message":{"content":[{"type":"text","text":text}]}});
            let mut bytes = serde_json::to_vec(&frame).unwrap();
            bytes.push(b'\n');
            state
                .frame(read_frame(&mut bytes.as_slice()).unwrap().unwrap())
                .unwrap();
            assert_eq!(state.stream_text, text);
        }
        let oversized = vec![b'x'; MAX_LINE + 2];
        let mut input = oversized.as_slice();
        assert!(
            read_frame(&mut input)
                .unwrap_err()
                .to_string()
                .contains("exceeds")
        );
        assert_eq!(input.len(), 1);
    }

    #[test]
    fn live_preview_bounds_encoded_text_without_losing_internal_output() {
        let runner = Runner::new(PathBuf::new(), "test".into());
        for text in ["\0".repeat(MAX_TEXT), "文😀".repeat(MAX_TEXT / 7)] {
            runner.state.lock().unwrap().stream_text = text.clone();
            let snapshot = runner.snapshot();
            assert_eq!(snapshot["streamTextTruncated"], true);
            let preview = snapshot["streamText"].as_str().unwrap();
            assert!(text.starts_with(preview));
            assert!(serde_json::to_vec(&snapshot).unwrap().len() < 600 * 1024);
            assert_eq!(runner.state.lock().unwrap().stream_text, text);
        }
        runner.state.lock().unwrap().stream_text = "short".into();
        assert_eq!(runner.snapshot()["streamTextTruncated"], false);
    }

    #[test]
    fn large_failure_result_keeps_a_deliverable_failure_snapshot() {
        let runner = Runner::new(PathBuf::new(), "test".into());
        let frame = json!({"type":"result","subtype":"error_during_execution","is_error":true,"errors":["文".repeat(2 * 1024 * 1024)]});
        let bytes = serde_json::to_vec(&frame).unwrap();
        let mut state = active();
        let error = state
            .frame(read_frame(&mut bytes.as_slice()).unwrap().unwrap())
            .unwrap_err();
        state.fail(error.to_string());
        *runner.state.lock().unwrap() = state;
        let snapshot = runner.snapshot();
        assert_eq!(snapshot["status"], "outcome-unknown");
        assert!(
            snapshot["reason"]
                .as_str()
                .unwrap()
                .ends_with("[truncated]")
        );
        assert!(serde_json::to_vec(&snapshot).unwrap().len() < 32 * 1024);
    }

    #[test]
    fn mismatched_session_and_background_tasks_fail_closed() {
        let mut state = active();
        state.session_id = "expected".into();
        assert!(
            state
                .frame(json!({"type":"system","session_id":"forked","subtype":"init"}))
                .is_err()
        );
        assert!(
            state
                .frame(json!({"type":"system","session_id":"expected","subtype":"task_started"}))
                .is_err()
        );
        let mut request = permission("scope");
        request["request"]["additional_permissions"] = json!({"network":true});
        assert!(state.frame(request).is_err());
        assert!(state.approvals.is_empty());
    }

    fn foreground_state() -> State {
        let mut state = active();
        state.foreground_bash_contract = true;
        state.frame(json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"bash-1","name":"Bash","input":{"command":"sleep 30"}}]}})).unwrap();
        state
    }

    fn foreground_start() -> Value {
        json!({"type":"system","subtype":"task_started","task_id":"task-1","tool_use_id":"bash-1","task_type":"local_bash","is_backgrounded":false})
    }

    #[test]
    fn captured_2_1_285_foreground_bash_frames_are_correlated_without_completing_turn() {
        let mut state = active();
        state.foreground_bash_contract = true;
        state.session_id = "17836aef-2d90-40c7-baa6-0c925ece4559".into();
        for line in include_str!("../tests/fixtures/claude-2.1.285-foreground-bash.jsonl").lines() {
            state.frame(serde_json::from_str(line).unwrap()).unwrap();
        }
        assert!(state.foreground_tasks.is_empty());
        assert_eq!(state.status, "running");
    }

    #[test]
    fn current_foreground_bash_lifecycle_stays_in_active_turn() {
        let mut state = foreground_state();
        state.frame(foreground_start()).unwrap();
        state
            .frame(json!({"type":"system","subtype":"background_tasks_changed","tasks":[]}))
            .unwrap();
        state.frame(json!({"type":"system","subtype":"task_updated","task_id":"task-1","patch":{"status":"completed","is_backgrounded":false}})).unwrap();
        assert_eq!(state.status, "running");
        state.frame(json!({"type":"system","subtype":"task_notification","task_id":"task-1","tool_use_id":"bash-1","status":"completed"})).unwrap();
        assert_eq!(state.status, "running");
        state
            .frame(json!({"type":"result","subtype":"success","is_error":false}))
            .unwrap();
        assert_eq!(state.status, "idle");
    }

    #[test]
    fn foreground_bash_start_requires_exact_scope_and_correlation() {
        for (key, value) in [
            ("tool_use_id", json!("other")),
            ("task_type", json!("local_agent")),
            ("is_backgrounded", json!(true)),
            ("is_backgrounded", Value::Null),
            ("owned_by_subagent", json!(true)),
        ] {
            let mut state = foreground_state();
            let mut frame = foreground_start();
            frame[key] = value;
            assert!(state.frame(frame).is_err(), "accepted {key}");
        }
        for key in ["task_id", "tool_use_id", "task_type", "is_backgrounded"] {
            let mut state = foreground_state();
            let mut frame = foreground_start();
            frame.as_object_mut().unwrap().remove(key);
            assert!(state.frame(frame).is_err(), "accepted missing {key}");
        }
        let mut unobserved = active();
        unobserved.foreground_bash_contract = true;
        assert!(unobserved.frame(foreground_start()).is_err());
        let mut old = foreground_state();
        old.foreground_bash_contract = false;
        assert!(old.frame(foreground_start()).is_err());
        assert!(
            old.frame(json!({"type":"system","subtype":"background_tasks_changed","tasks":[]}))
                .is_err()
        );
    }

    #[test]
    fn foreground_bash_background_upgrade_and_unresolved_result_fail_closed() {
        let mut state = foreground_state();
        state.frame(foreground_start()).unwrap();
        assert!(state.frame(json!({"type":"system","subtype":"task_updated","task_id":"task-1","patch":{"is_backgrounded":true}})).is_err());
        assert!(state.frame(json!({"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"task-1"}]})).is_err());
        assert!(
            state
                .frame(json!({"type":"result","subtype":"success"}))
                .is_err()
        );
        assert!(state.frame(json!({"type":"system","subtype":"task_notification","task_id":"task-1","tool_use_id":"other","status":"completed"})).is_err());
        assert!(state.frame(json!({"type":"system","subtype":"task_notification","task_id":"unknown","tool_use_id":"bash-1","status":"completed"})).is_err());
        assert!(state.frame(foreground_start()).is_err());
    }

    #[test]
    fn streamed_tool_id_is_usable_but_previous_turn_is_not() {
        let mut state = active();
        state.foreground_bash_contract = true;
        state.frame(json!({"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","id":"bash-1","name":"Bash","input":{}}}})).unwrap();
        state.frame(foreground_start()).unwrap();
        state.frame(json!({"type":"system","subtype":"task_notification","task_id":"task-1","tool_use_id":"bash-1","status":"stopped"})).unwrap();
        state.bash_tool_ids.clear();
        assert!(state.frame(foreground_start()).is_err());
    }

    #[test]
    fn session_lock_excludes_another_owner() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("session.lock");
        let first = acquire_session_lock(&path).unwrap();
        assert!(acquire_session_lock(&path).is_err());
        drop(first);
        let _second = acquire_session_lock(&path).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn session_lock_releases_with_an_inherited_descriptor_still_open() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("session.lock");
        let owner = acquire_session_lock(&path).unwrap();
        // dup shares the open file description just as fork inheritance does,
        // deterministically reproducing the parallel spawn window without timing.
        let inherited = owner.0.try_clone().unwrap();
        assert!(acquire_session_lock(&path).is_err());
        drop(owner);
        let contender = acquire_session_lock(&path).unwrap();
        drop(inherited);
        assert!(acquire_session_lock(&path).is_err());
        drop(contender);
        assert!(acquire_session_lock(&path).is_ok());
    }

    #[test]
    fn native_permission_metadata_is_preserved() {
        let mut state = active();
        let mut request = permission("metadata");
        for (key, value) in [
            ("decision_reason_type", json!("ask-rule")),
            ("matched_ask_rule", json!({"tool":"Bash"})),
            ("classifier_approvable", json!(false)),
            ("suppress_always_allow_rule", json!(true)),
            ("default_to_no", json!(true)),
            ("requires_user_interaction", json!(false)),
        ] {
            request["request"][key] = value;
        }
        state.frame(request).unwrap();
        assert_eq!(
            state.approvals[0]["context"]["decision_reason_type"],
            "ask-rule"
        );
        assert_eq!(state.approvals[0]["context"]["default_to_no"], true);
        assert_eq!(state.approvals[0]["input"], json!({"command":"pwd"}));
    }

    #[test]
    fn interactive_requests_never_become_allow_buttons() {
        {
            let name = "OtherInteractiveTool";
            let mut state = active();
            let mut request = permission(name);
            request["request"]["tool_name"] = json!(name);
            request["request"]["requires_user_interaction"] = json!(true);
            assert!(
                state
                    .frame(request)
                    .unwrap_err()
                    .to_string()
                    .contains("unsupported Claude user interaction")
            );
            assert!(state.approvals.is_empty());
        }
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_closes_descendant_pipes() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "sleep 60 & echo ready; wait"])
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap());
        let mut ready = String::new();
        stdout.read_line(&mut ready).unwrap();
        assert_eq!(ready.trim(), "ready");
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = sender.send(stdout.read_to_end(&mut bytes));
        });
        terminate_owned_process_group(&mut child);
        assert!(
            receiver
                .recv_timeout(Duration::from_secs(2))
                .unwrap()
                .is_ok()
        );
    }

    #[test]
    fn sdk_notifications_do_not_change_turn_or_approvals() {
        let mut state = active();
        state.frame(permission("pending")).unwrap();
        state.stream_text = "partial".into();
        let before = (
            state.status.clone(),
            state.revision,
            state.approvals.clone(),
            state.stream_text.clone(),
        );
        for message_type in [
            "command_lifecycle",
            "keep_alive",
            "transcript_mirror",
            "active_goal",
            "autocompact_state",
        ] {
            assert!(
                state
                    .frame(json!({"type":message_type,"state":"completed","command_uuid":"turn"}))
                    .unwrap()
                    .is_none()
            );
        }
        assert_eq!(
            before,
            (
                state.status.clone(),
                state.revision,
                state.approvals.clone(),
                state.stream_text.clone()
            )
        );
        let mut initializing = State {
            status: "running".into(),
            ..State::default()
        };
        initializing
            .frame(json!({"type":"command_lifecycle","state":"queued","command_uuid":"turn"}))
            .unwrap();
        assert!(!initializing.initialized);
        assert_eq!(initializing.status, "running");
        assert!(state.frame(json!({"type":"conversation_reset"})).is_err());
        assert!(state.frame(json!({"type":"unknown_notification"})).is_err());
    }

    #[test]
    fn stop_requires_the_exact_active_turn_and_retires_the_worker() {
        let runner = Runner::mock_worker("running");
        {
            let mut state = runner.state.lock().unwrap();
            state.turn_id = "turn-1".into();
            state.revision = 7;
            state.approvals.push(json!({"requestId":"pending"}));
        }
        assert!(runner.stop("old", 7).is_err());
        runner.stop("turn-1", 7).unwrap();
        let snapshot = runner.snapshot();
        assert_eq!(snapshot["status"], "idle");
        assert_eq!(snapshot["revision"], 8);
        assert_eq!(snapshot["approvals"], json!([]));
        assert!(!runner.has_worker());
    }

    #[test]
    fn cleanup_failure_never_reports_cancelled_idle_or_successful_shutdown() {
        let runner = Runner::mock_cleanup_failure("running");
        {
            let mut state = runner.state.lock().unwrap();
            state.turn_id = "turn".into();
        }
        assert!(runner.stop("turn", 0).is_err());
        assert_eq!(runner.snapshot()["status"], "outcome-unknown");
        assert!(runner.snapshot()["lastOutcome"].is_null());
        assert!(runner.shutdown().is_err());
    }

    #[test]
    fn stop_waits_for_worker_exit_before_reporting_idle() {
        let runner = Arc::new(Runner::mock_worker("running"));
        {
            let mut state = runner.state.lock().unwrap();
            state.turn_id = "turn-1".into();
            state.revision = 7;
        }
        let (stopping, observed) = mpsc::sync_channel(1);
        let (release, released) = mpsc::sync_channel(1);
        let shared = Arc::clone(&runner.state);
        let mut worker = runner.worker.lock().unwrap();
        let stop = Arc::clone(&worker.as_ref().unwrap().stop);
        worker.as_mut().unwrap().join = Some(thread::spawn(move || {
            while !stop.load(Ordering::Acquire) {
                thread::yield_now();
            }
            stopping.send(()).unwrap();
            released.recv().unwrap();
            shared.lock().unwrap().fail("late Claude stream close");
        }));
        drop(worker);

        let target = Arc::clone(&runner);
        let request = thread::spawn(move || target.stop("turn-1", 7));
        observed.recv_timeout(Duration::from_secs(2)).unwrap();
        let in_flight = runner.snapshot();
        release.send(()).unwrap();
        request.join().unwrap().unwrap();
        assert_eq!(in_flight["status"], "running");
        let complete = runner.snapshot();
        assert_eq!(complete["status"], "idle");
        assert_eq!(complete["revision"], 9);
        assert!(complete["reason"].is_null());
    }
    #[test]
    fn native_image_input_accepts_known_media_and_rejects_paths_oversize_and_mismatch() {
        use base64::Engine;
        let png = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\nfixture");
        let block =
            json!({"type":"image","source":{"type":"base64","media_type":"image/png","data":png}});
        assert!(validate_content(&json!([block.clone()])).is_ok());
        assert!(
            validate_content(&json!([{"type":"text","text":"describe"},block.clone()])).is_ok()
        );
        let mut wrong = block.clone();
        wrong["source"]["media_type"] = json!("image/jpeg");
        assert!(validate_content(&json!([wrong])).is_err());
        assert!(
            validate_content(
                &json!([{"type":"image","source":{"type":"url","url":"file:///private/data"}}])
            )
            .is_err()
        );
        assert!(validate_content(&json!([{"type":"localImage","path":"/tmp/private"}])).is_err());
        assert!(validate_content(&json!([])).is_err());
        let mut bytes = vec![0u8; 4 * 1024 * 1024];
        bytes[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        let image = json!({"type":"image","source":{"type":"base64","media_type":"image/png","data":base64::engine::general_purpose::STANDARD.encode(&bytes)}});
        assert!(validate_content(&json!([image.clone(), image.clone(), image.clone()])).is_ok());
        assert!(
            validate_content(&json!([image.clone(), image.clone(), image.clone(), image])).is_err()
        );
        bytes.push(0);
        let mut oversized = block;
        oversized["source"]["data"] =
            json!(base64::engine::general_purpose::STANDARD.encode(bytes));
        assert!(validate_content(&json!([oversized])).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn version_gate_admits_exact_new_contract_but_not_adjacent_versions() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let executable = root.path().join("claude");
        for (version, supported) in [("2.1.263", true), ("2.1.285", true), ("2.1.286", false)] {
            std::fs::write(
                &executable,
                format!("#!/bin/sh\nprintf '%s\\n' '{version} (Claude Code)'\n"),
            )
            .unwrap();
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
            assert_eq!(
                check_version_at(executable.clone()).is_ok(),
                supported,
                "{version}"
            );
        }
    }
}
