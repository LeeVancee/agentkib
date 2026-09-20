//! Managed ACP sessions. Native session IDs come from the verified conversation
//! provider; this module never imports a foreign transcript or drives a private IDE API.
use agentkib_antigravity_bridge::{BlockingClient, Compatibility, Event, RpcId};
use agentkib_conversations::{HandoffFormat, sanitize_handoff_export};
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    ffi::OsString,
    path::{Component, Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

const TIMEOUT: Duration = Duration::from_secs(15);
const POLL: Duration = Duration::from_millis(100);
const MAX_CONTENT: usize = 512 * 1024;
const MAX_APPROVAL_DETAILS: usize = 64 * 1024;
const DISPATCHING_TURN_ID: &str = "agentkib-prompt-dispatch-in-progress";

/// Resolve an explicitly configured official ACP server or its exact PATH name.
/// Merely finding a binary is not a compatibility/authentication claim: connect
/// performs the ACP handshake and native session attachment before enabling send.
pub fn resolve_installation() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("AGENTKIB_ANTIGRAVITY_ACP_BIN") {
        return executable(Path::new(&path));
    }
    for name in ["agy_acp_server.par", "agy_acp_server.exe"] {
        if let Some(path) = agentkib_platform::command::resolve(name) {
            return executable(&path);
        }
    }
    bail!("official Antigravity ACP server not found")
}

fn executable(path: &Path) -> Result<PathBuf> {
    ensure!(
        path.is_absolute(),
        "ACP executable must be an absolute path"
    );
    let metadata = path.metadata().context("ACP executable unavailable")?;
    ensure!(metadata.is_file(), "ACP executable is not a file");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        ensure!(
            metadata.permissions().mode() & 0o111 != 0,
            "ACP file is not executable"
        );
    }
    path.canonicalize().context("ACP executable unavailable")
}

pub fn installation_supported() -> bool {
    resolve_installation().is_ok()
}

#[derive(Clone)]
struct State {
    session_id: String,
    status: &'static str,
    revision: u64,
    turn: Option<RpcId>,
    cancelling_since: Option<Instant>,
    stream_text: String,
    updates: Vec<Value>,
    tool_calls: Vec<Value>,
    approvals: Vec<Value>,
    seen_permissions: HashSet<RpcId>,
    reason: Option<String>,
}

impl State {
    fn new(session_id: String) -> Self {
        Self {
            session_id,
            status: "idle",
            revision: 0,
            turn: None,
            cancelling_since: None,
            stream_text: String::new(),
            updates: Vec::new(),
            tool_calls: Vec::new(),
            approvals: Vec::new(),
            seen_permissions: HashSet::new(),
            reason: None,
        }
    }

    fn turn_id(&self) -> Option<String> {
        self.turn
            .as_ref()
            .map(|id| serde_json::to_string(id).expect("RPC ID serialization"))
    }

    fn snapshot(&self) -> Value {
        let approvals: Vec<_> = self
            .approvals
            .iter()
            .map(|approval| {
                json!({
                    "requestId": approval["requestId"],
                    "turnId": approval["turnId"],
                    "method": approval["method"],
                    "supported": approval["supported"],
                    "unsupportedReason": approval["unsupportedReason"],
                    "toolCall": approval["toolCall"],
                    "options": approval["options"],
                    "availableDecisions": approval["availableDecisions"],
                })
            })
            .collect();
        json!({"status":self.status,"revision":self.revision,"turnId":self.turn_id(),
            "sendEnabled":self.status == "idle","stopEnabled":self.turn.is_some() && matches!(self.status, "running" | "waiting-approval") && self.cancelling_since.is_none(),
            "cancelling":self.cancelling_since.is_some(),"streamText":self.stream_text,
            "approvals":approvals,
            "reason":self.reason,"executionMode":"acp-managed"})
    }

    fn retained_content_len(&self) -> Result<usize> {
        Ok(serde_json::to_vec(&(
            &self.stream_text,
            &self.updates,
            &self.tool_calls,
            &self.approvals,
            &self.seen_permissions,
            &self.reason,
        ))?
        .len())
    }

    fn fail(&mut self, reason: impl std::fmt::Display) {
        // A transport or protocol failure during an active native turn leaves
        // its completion unknown. Preserve the turn identity and never reconnect
        // automatically: submitting it again could duplicate side effects.
        self.status = if self.turn.is_some() {
            "outcome-unknown"
        } else {
            "failed"
        };
        self.approvals.clear();
        self.cancelling_since = None;
        self.reason = Some(reason.to_string().chars().take(512).collect());
        self.revision += 1;
    }

    fn is_outcome_unknown(&self) -> bool {
        self.status == "outcome-unknown" && self.turn.is_some()
    }

    fn is_reconnectable_failure(&self) -> bool {
        self.status == "failed" && self.turn.is_none()
    }

    fn is_retirable(&self) -> bool {
        self.status == "idle" || self.is_reconnectable_failure()
    }

    fn revision(&self, expected: u64) -> Result<()> {
        ensure!(
            !matches!(self.status, "failed" | "outcome-unknown"),
            "ACP session failed; reconnect required"
        );
        ensure!(expected == self.revision, "stale Antigravity revision");
        Ok(())
    }

    fn active_turn(&self, expected: &str) -> Result<()> {
        ensure!(
            self.turn_id().as_deref() == Some(expected),
            "stale Antigravity turn"
        );
        ensure!(
            matches!(self.status, "running" | "waiting-approval"),
            "Antigravity turn is not active"
        );
        ensure!(
            self.cancelling_since.is_none(),
            "Antigravity cancellation already pending"
        );
        Ok(())
    }

    fn permission(&self, id: &Value, turn: &str, option: &str, revision: u64) -> Result<RpcId> {
        self.revision(revision)?;
        self.active_turn(turn)?;
        let approval = self
            .approvals
            .iter()
            .find(|a| &a["requestId"] == id)
            .context("unknown or already answered Antigravity approval")?;
        ensure!(
            approval["supported"].as_bool() == Some(true),
            "Antigravity approval details cannot be presented safely"
        );
        ensure!(
            approval["turnId"].as_str() == Some(turn),
            "stale Antigravity approval turn"
        );
        ensure!(
            approval["availableDecisions"]
                .as_array()
                .is_some_and(|a| a.iter().any(|v| v.as_str() == Some(option))),
            "option is not offered by Antigravity"
        );
        serde_json::from_value(id.clone()).context("invalid ACP request id")
    }

    fn apply(&mut self, event: Event) -> Result<()> {
        // Reject oversize events atomically: keep the last bounded view and never
        // show an actionable permission with a clipped tool description.
        let mut next = self.clone();
        if !next.apply_inner(event)? {
            return Ok(());
        }
        ensure!(
            next.retained_content_len()? <= MAX_CONTENT - 8192,
            "ACP session content exceeds 512 KiB"
        );
        next.revision += 1;
        *self = next;
        Ok(())
    }

    fn apply_inner(&mut self, event: Event) -> Result<bool> {
        match event {
            Event::SessionUpdate { session_id, update } => {
                ensure!(
                    session_id == self.session_id,
                    "ACP session identity changed"
                );
                ensure!(self.updates.len() < 4096, "too many ACP updates");
                match update["sessionUpdate"].as_str() {
                    Some("agent_message_chunk") => {
                        if update["content"]["type"] == "text" {
                            let text = update["content"]["text"]
                                .as_str()
                                .context("invalid ACP text chunk")?;
                            ensure!(
                                self.stream_text.len() + text.len() <= MAX_CONTENT,
                                "ACP output exceeds 512 KiB"
                            );
                            self.stream_text.push_str(text);
                        }
                    }
                    Some("tool_call" | "tool_call_update") => {
                        let id = update["toolCallId"]
                            .as_str()
                            .filter(|v| !v.is_empty())
                            .context("invalid ACP tool ID")?;
                        if let Some(existing) = self
                            .tool_calls
                            .iter_mut()
                            .find(|v| v["toolCallId"].as_str() == Some(id))
                        {
                            existing
                                .as_object_mut()
                                .context("invalid ACP tool")?
                                .extend(
                                    update
                                        .as_object()
                                        .context("invalid ACP tool update")?
                                        .clone(),
                                );
                        } else {
                            self.tool_calls.push(update.clone());
                        }
                    }
                    // Preserve user/agent thoughts, non-text blocks and future
                    // updates verbatim; none is a permission or turn completion.
                    _ => {}
                }
                self.updates.push(update);
            }
            Event::Permission { id, request } => {
                ensure!(
                    request.session_id == self.session_id,
                    "ACP permission session mismatch"
                );
                // cancel() has already cancelled every permission known by the
                // transport. An earlier queued event can reach this consumer
                // afterwards; it must not recreate an actionable approval.
                if self.cancelling_since.is_some() {
                    return Ok(false);
                }
                ensure!(
                    self.turn.is_some() && matches!(self.status, "running" | "waiting-approval"),
                    "ACP permission outside active turn"
                );
                ensure!(
                    self.approvals.len() < 32 && self.seen_permissions.len() < 4096,
                    "too many ACP permissions"
                );
                ensure!(
                    self.seen_permissions.insert(id.clone()),
                    "reused ACP permission id"
                );
                let mut unique = HashSet::new();
                ensure!(
                    !request.options.is_empty()
                        && request
                            .options
                            .iter()
                            .all(|o| !o.option_id.is_empty() && unique.insert(&o.option_id)),
                    "invalid ACP permission options"
                );
                let decisions: Vec<_> = request
                    .options
                    .iter()
                    .map(|o| o.option_id.clone())
                    .collect();
                let mut redaction_count = 0;
                let options = request
                    .options
                    .iter()
                    .map(|option| {
                        ensure!(
                            option.option_id.len() <= 256
                                && !option.option_id.chars().any(|value| value.is_control())
                                && !option.name.trim().is_empty()
                                && option.name.len() <= 512
                                && !option.kind.trim().is_empty()
                                && option.kind.len() <= 256,
                            "invalid ACP permission option presentation"
                        );
                        Ok(json!({
                            "optionId": option.option_id,
                            "name": agentkib_conversations::sanitize_handoff_content(
                                &option.name,
                                dirs::home_dir().as_deref(),
                                &mut redaction_count,
                            ),
                            "kind": agentkib_conversations::sanitize_handoff_content(
                                &option.kind,
                                dirs::home_dir().as_deref(),
                                &mut redaction_count,
                            ),
                        }))
                    })
                    .collect::<Result<Vec<_>>>()?;
                let projected = project_permission_tool_call(&request.tool_call);
                let (tool_call, supported, unsupported_reason) = match projected {
                    Ok(tool_call) => (tool_call, true, Value::Null),
                    Err(_) => (
                        json!({"toolCallId": "[unavailable]"}),
                        false,
                        json!("incomplete-operation-details"),
                    ),
                };
                self.approvals
                    .push(json!({"requestId":id,"turnId":self.turn_id(),
                    "method":"session/request_permission","supported":supported,
                    "unsupportedReason":unsupported_reason,
                    "toolCall":tool_call,"options":options,
                    "availableDecisions":if supported { decisions } else { Vec::new() }}));
                self.status = "waiting-approval";
            }
            Event::PermissionCancelled { id, session_id } => {
                ensure!(
                    session_id == self.session_id,
                    "ACP cancellation session mismatch"
                );
                let value = serde_json::to_value(id)?;
                self.approvals.retain(|a| a["requestId"] != value);
                if self.approvals.is_empty() && self.status == "waiting-approval" {
                    self.status = "running";
                }
            }
            Event::Response { id, method, result } => {
                ensure!(
                    method == "session/prompt" && self.turn.as_ref() == Some(&id),
                    "unexpected ACP response"
                );
                let result = result.map_err(|error| {
                    anyhow::anyhow!("ACP prompt failed ({}): {}", error.code, error.message)
                })?;
                ensure!(
                    matches!(
                        result["stopReason"].as_str(),
                        Some(
                            "end_turn"
                                | "max_tokens"
                                | "max_turn_requests"
                                | "refusal"
                                | "cancelled"
                        )
                    ),
                    "missing or unsupported ACP stop reason"
                );
                self.status = "idle";
                self.turn = None;
                self.cancelling_since = None;
                self.approvals.clear();
            }
            Event::UnsupportedRequest { .. } | Event::Notification { .. } => return Ok(false),
        }
        Ok(true)
    }
}

fn project_permission_tool_call(source: &Value) -> Result<Value> {
    let source = source
        .as_object()
        .context("ACP permission tool call must be an object")?;
    let allowed = [
        "toolCallId",
        "title",
        "name",
        "kind",
        "status",
        "rawInput",
        "content",
        "locations",
    ];
    ensure!(
        source
            .iter()
            .all(|(key, value)| value.is_null() || allowed.contains(&key.as_str())),
        "ACP permission contains unsupported tool metadata"
    );
    let tool_call_id = source
        .get("toolCallId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 4096)
        .context("ACP permission tool call is missing its ID")?;
    for key in ["title", "name", "kind", "status"] {
        ensure!(
            source.get(key).is_none_or(|value| {
                value.is_null()
                    || value.as_str().is_some_and(|value| {
                        value.len() <= 16 * 1024 && !value.chars().any(|value| value == '\0')
                    })
            }),
            "ACP permission contains invalid {key}"
        );
    }
    for key in ["content", "locations"] {
        ensure!(
            source
                .get(key)
                .is_none_or(|value| value.is_null() || value.is_array()),
            "ACP permission contains invalid {key}"
        );
    }
    let mut projected = serde_json::Map::new();
    projected.insert("toolCallId".into(), json!(tool_call_id));
    for key in allowed.into_iter().skip(1) {
        if let Some(value) = source.get(key)
            && !value.is_null()
        {
            projected.insert(key.into(), value.clone());
        }
    }
    let original = Value::Object(projected);
    let encoded = serde_json::to_string(&original)?;
    ensure!(
        encoded.len() <= MAX_APPROVAL_DETAILS,
        "ACP permission details exceed the display limit"
    );
    let home = dirs::home_dir();
    let (sanitized, _) = sanitize_handoff_export(&encoded, HandoffFormat::Json, home.as_deref())?;
    ensure!(
        sanitized.len() <= MAX_APPROVAL_DETAILS,
        "ACP permission details exceed the display limit"
    );
    let projected: Value =
        serde_json::from_str(&sanitized).context("sanitized ACP permission is invalid")?;
    // Keep the displayed payload sanitized. For path identity checks only, use
    // original paths when their sole presentation change was the known home
    // substitution; other redactions must still fail closed.
    let mut validation = projected.clone();
    restore_home_paths_for_validation(&original, &mut validation, home.as_deref());
    let raw_input = validation.get("rawInput");
    let kind = validation.get("kind").and_then(Value::as_str);
    // ACP also defines move, delete and other. Their operation scope cannot be
    // inferred from a path alone, so require a reviewed contract before enabling them.
    ensure!(
        kind.is_some_and(|kind| {
            matches!(
                kind,
                "execute" | "command" | "terminal" | "shell" | "edit" | "read"
            )
        }),
        "ACP permission tool kind is unsupported"
    );
    let execution =
        kind.is_some_and(|kind| matches!(kind, "execute" | "command" | "terminal" | "shell"));
    let edit = kind == Some("edit");
    let read = kind == Some("read");
    ensure!(
        !raw_input.is_some_and(has_hidden_command)
            && (!execution || raw_input.is_some_and(has_visible_execution_command))
            && (!edit || has_visible_edit_change(&validation))
            && (!read
                || (validation.get("content").is_none() && has_visible_read_scope(&validation)))
            && (raw_input.is_some_and(has_visible_action_detail)
                || validation.get("content").is_some_and(|content| {
                    !contains_redacted_detail(content) && has_visible_action_detail(content)
                })),
        "ACP permission does not describe the requested action after redaction"
    );
    Ok(projected)
}

fn restore_home_paths_for_validation(
    original: &Value,
    validation: &mut Value,
    home: Option<&Path>,
) {
    let Some(home) = home else {
        return;
    };
    for key in ["path", "filePath", "cwd", "workingDirectory"] {
        let pointer = format!("/rawInput/{key}");
        restore_home_path(
            original.pointer(&pointer),
            validation.pointer_mut(&pointer),
            home,
        );
    }
    for key in ["content", "locations"] {
        if let (Some(source), Some(shown)) = (
            original.get(key).and_then(Value::as_array),
            validation.get_mut(key).and_then(Value::as_array_mut),
        ) {
            for (source, shown) in source.iter().zip(shown.iter_mut()) {
                restore_home_path(source.get("path"), shown.get_mut("path"), home);
            }
        }
    }
}

fn restore_home_path(original: Option<&Value>, validation: Option<&mut Value>, home: &Path) {
    let (Some(original), Some(validation), Some(home_text)) =
        (original.and_then(Value::as_str), validation, home.to_str())
    else {
        return;
    };
    let Some(suffix) = original.strip_prefix(home_text) else {
        return;
    };
    let expected = format!("$HOME{suffix}");
    if Path::new(original).starts_with(home)
        && validation.as_str() == Some(expected.as_str())
        && !expected.contains("[REDACTED")
    {
        *validation = Value::String(original.into());
    }
}

fn has_visible_execution_command(value: &Value) -> bool {
    let Some(fields) = value.as_object() else {
        return false;
    };
    let command = ["command", "cmd", "script"]
        .iter()
        .filter_map(|key| fields.get(*key))
        .any(|value| value.as_str().is_some_and(visible_action_text));
    let arguments = ["args", "arguments"]
        .iter()
        .filter_map(|key| fields.get(*key))
        .all(|value| {
            value.as_array().is_some_and(|parts| {
                parts
                    .iter()
                    .all(|part| part.as_str().is_some_and(visible_action_text))
            })
        });
    command && arguments
}

fn has_visible_read_scope(tool_call: &Value) -> bool {
    let Some(value) = tool_call.get("rawInput") else {
        return false;
    };
    let Some(fields) = value.as_object() else {
        return false;
    };
    if contains_redacted_detail(value)
        || fields.keys().any(|key| {
            !matches!(
                key.as_str(),
                "path" | "filePath" | "cwd" | "workingDirectory"
            )
        })
    {
        return false;
    }
    let Some(cwd) = visible_working_directory(fields) else {
        return false;
    };
    let path = fields.get("path").and_then(Value::as_str);
    let file_path = fields.get("filePath").and_then(Value::as_str);
    let path = match (path, file_path) {
        (Some(path), Some(file_path)) if same_file_path(path, file_path, cwd) => path,
        (Some(path), None) | (None, Some(path)) => path,
        _ => return false,
    };
    visible_action_text(path) && locations_match(tool_call.get("locations"), &[path], cwd)
}

fn visible_working_directory(fields: &serde_json::Map<String, Value>) -> Option<Option<&str>> {
    let cwd = match fields.get("cwd") {
        Some(Value::String(path)) => Some(path.as_str()),
        Some(_) => return None,
        None => None,
    };
    let working_directory = match fields.get("workingDirectory") {
        Some(Value::String(path)) => Some(path.as_str()),
        Some(_) => return None,
        None => None,
    };
    for path in [cwd, working_directory].into_iter().flatten() {
        if !visible_action_text(path)
            || !Path::new(path).is_absolute()
            || Path::new(path)
                .components()
                .any(|component| component == Component::ParentDir)
        {
            return None;
        }
    }
    if let (Some(cwd), Some(working_directory)) = (cwd, working_directory)
        && !same_file_path(cwd, working_directory, None)
    {
        return None;
    }
    Some(cwd.or(working_directory))
}

fn same_file_path(left: &str, right: &str, cwd: Option<&str>) -> bool {
    if !visible_action_text(left) || !visible_action_text(right) {
        return false;
    }
    if left == right {
        return true;
    }
    match (
        normalized_file_path(left, cwd),
        normalized_file_path(right, cwd),
    ) {
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

fn normalized_file_path(path: &str, cwd: Option<&str>) -> Option<PathBuf> {
    let path = Path::new(path);
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        Path::new(cwd?).join(path)
    };
    if !path.is_absolute() {
        return None;
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            // Lexical `..` can cross a symlink and point somewhere else on disk.
            Component::ParentDir => return None,
            _ => normalized.push(component.as_os_str()),
        }
    }
    Some(normalized)
}

fn locations_match(locations: Option<&Value>, paths: &[&str], cwd: Option<&str>) -> bool {
    match locations {
        None => true,
        Some(Value::Array(locations)) => locations.iter().all(|location| {
            location.as_object().is_some_and(|fields| {
                fields
                    .keys()
                    .all(|key| matches!(key.as_str(), "path" | "line"))
                    && fields
                        .get("path")
                        .and_then(Value::as_str)
                        .is_some_and(|path| {
                            paths.iter().any(|known| same_file_path(path, known, cwd))
                        })
                    && fields.get("line").is_none_or(|line| {
                        line.is_null() || line.as_u64().is_some_and(|line| line <= u32::MAX as u64)
                    })
            })
        }),
        Some(_) => false,
    }
}

fn has_visible_edit_change(tool_call: &Value) -> bool {
    let raw_input = tool_call.get("rawInput");
    let content = tool_call.get("content");
    if raw_input.is_some_and(contains_redacted_detail)
        || content.is_some_and(contains_redacted_detail)
    {
        return false;
    }
    let input_fields = raw_input.and_then(Value::as_object);
    if raw_input.is_some() && input_fields.is_none()
        || input_fields.is_some_and(|fields| {
            fields.keys().any(|key| {
                !matches!(
                    key.as_str(),
                    "path" | "filePath" | "cwd" | "workingDirectory" | "oldText" | "newText"
                )
            })
        })
    {
        return false;
    }
    let cwd = match input_fields {
        Some(fields) => match visible_working_directory(fields) {
            Some(cwd) => cwd,
            None => return false,
        },
        None => None,
    };
    let input_path = input_fields.and_then(|fields| {
        let path = fields.get("path").and_then(Value::as_str);
        let file_path = fields.get("filePath").and_then(Value::as_str);
        match (path, file_path) {
            (Some(path), Some(file_path)) if same_file_path(path, file_path, cwd) => Some(path),
            (Some(path), None) | (None, Some(path)) => Some(path),
            _ => None,
        }
    });
    if input_fields.is_some() && input_path.is_none_or(|path| !visible_action_text(path)) {
        return false;
    }
    let input_change = input_fields
        .is_some_and(|fields| visible_text_change(fields.get("oldText"), fields.get("newText")));
    if input_fields
        .is_some_and(|fields| fields.contains_key("oldText") || fields.contains_key("newText"))
        && !input_change
    {
        return false;
    }
    let content_blocks = content.and_then(Value::as_array);
    let content_change = content_blocks.is_some_and(|blocks| {
        !blocks.is_empty()
            && blocks.iter().all(|block| {
                block.as_object().is_some_and(|fields| {
                    fields
                        .keys()
                        .all(|key| matches!(key.as_str(), "type" | "path" | "oldText" | "newText"))
                }) && block.get("type").and_then(Value::as_str) == Some("diff")
                    && block
                        .get("path")
                        .and_then(Value::as_str)
                        .is_some_and(visible_action_text)
                    && visible_text_change(block.get("oldText"), block.get("newText"))
                    && input_path.is_none_or(|path| {
                        block
                            .get("path")
                            .and_then(Value::as_str)
                            .is_some_and(|diff_path| same_file_path(path, diff_path, cwd))
                    })
            })
    });
    if content.is_some() && !content_change {
        return false;
    }
    let paths: Vec<&str> = if content_change {
        content_blocks
            .iter()
            .flat_map(|blocks| blocks.iter())
            .filter_map(|block| block.get("path").and_then(Value::as_str))
            .collect()
    } else {
        input_path.into_iter().collect()
    };
    if !locations_match(tool_call.get("locations"), &paths, cwd) {
        return false;
    }
    if input_change && content_change {
        let Some(blocks) = content_blocks else {
            return false;
        };
        return blocks.len() == 1
            && input_fields.is_some_and(|fields| {
                fields.get("oldText") == blocks[0].get("oldText")
                    && fields.get("newText") == blocks[0].get("newText")
            });
    }
    input_change || content_change
}

fn visible_text_change(before: Option<&Value>, after: Option<&Value>) -> bool {
    match (before, after.and_then(Value::as_str)) {
        (Some(Value::Null), Some(after)) => !after.contains("[REDACTED"),
        (Some(before), Some(after)) => before.as_str().is_some_and(|before| {
            before != after && !before.contains("[REDACTED") && !after.contains("[REDACTED")
        }),
        _ => false,
    }
}

fn visible_action_text(text: &str) -> bool {
    !text.trim().is_empty() && !text.contains("[REDACTED")
}

fn has_hidden_command(value: &Value) -> bool {
    match value {
        Value::Object(fields) => fields.iter().any(|(key, value)| {
            if matches!(key.as_str(), "command" | "cmd" | "script") {
                !has_visible_action_detail(value)
            } else {
                has_hidden_command(value)
            }
        }),
        Value::Array(values) => values.iter().any(has_hidden_command),
        _ => false,
    }
}

fn contains_redacted_detail(value: &Value) -> bool {
    match value {
        Value::String(text) => text.contains("[REDACTED"),
        Value::Array(values) => values.iter().any(contains_redacted_detail),
        Value::Object(values) => values.values().any(contains_redacted_detail),
        _ => false,
    }
}

fn has_visible_action_detail(value: &Value) -> bool {
    match value {
        Value::String(text) => visible_action_text(text),
        Value::Array(values) => values.iter().any(has_visible_action_detail),
        Value::Object(values) => values.iter().any(|(key, value)| {
            !matches!(
                key.as_str(),
                "type"
                    | "kind"
                    | "mimeType"
                    | "status"
                    | "encoding"
                    | "cwd"
                    | "workingDirectory"
                    | "env"
                    | "environment"
                    | "headers"
                    | "metadata"
                    | "mode"
                    | "operation"
                    | "action"
                    | "method"
                    | "title"
                    | "name"
                    | "label"
                    | "description"
                    | "summary"
                    | "reason"
            ) && has_visible_action_detail(value)
        }),
        Value::Null | Value::Bool(_) | Value::Number(_) => false,
    }
}

pub struct Runner {
    client: BlockingClient,
    state: Arc<Mutex<State>>,
    stopped: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl Runner {
    pub fn connect(workspace: PathBuf, session_id: String) -> Result<Self> {
        Self::connect_with(&resolve_installation()?, &[], workspace, session_id)
    }

    fn connect_with(
        executable: &Path,
        args: &[OsString],
        workspace: PathBuf,
        session_id: String,
    ) -> Result<Self> {
        ensure!(
            workspace.is_absolute() && workspace.is_dir(),
            "invalid Antigravity workspace"
        );
        ensure!(
            !session_id.is_empty() && session_id.len() <= 4096,
            "invalid Antigravity session id"
        );
        let client = BlockingClient::spawn(executable, args, &workspace, TIMEOUT)?;
        let mut state = State::new(session_id.clone());
        let attached = (|| -> Result<()> {
            let initialize = client.initialize()?;
            let response = wait_response(&client, &initialize, "initialize", None)?;
            let caps = Compatibility::from_initialize(&response)?;
            Compatibility::verify_control_identity(&response)?;
            let (id, method) = if caps.resume_session {
                (
                    client.resume_session(&session_id, &workspace)?,
                    "session/resume",
                )
            } else if caps.load_session {
                (
                    client.load_session(&session_id, &workspace)?,
                    "session/load",
                )
            } else {
                bail!("Antigravity ACP server cannot resume or load native sessions")
            };
            wait_response(&client, &id, method, Some(&mut state))?;
            // Initial live polling reports revision zero before lazy attachment.
            // Native replay is exposed as updates; it is not a new active turn.
            state.revision = 0;
            state.stream_text.clear();
            Ok(())
        })();
        if let Err(error) = attached {
            let _ = client.shutdown();
            return Err(error);
        }
        let state = Arc::new(Mutex::new(state));
        let stopped = Arc::new(AtomicBool::new(false));
        let worker_client = client.clone();
        let worker_state = Arc::clone(&state);
        let worker_stopped = Arc::clone(&stopped);
        let worker = thread::Builder::new()
            .name("antigravity-session".into())
            .spawn(move || {
                while !worker_stopped.load(Ordering::Acquire) {
                    let event = worker_client.next_event(POLL);
                    let mut state = worker_state.lock().unwrap_or_else(|p| p.into_inner());
                    if worker_stopped.load(Ordering::Acquire)
                        || matches!(state.status, "failed" | "outcome-unknown")
                    {
                        break;
                    }
                    let result = match event {
                        Ok(Some(event)) => state.apply(event),
                        Ok(None) => Ok(()),
                        Err(error) => Err(error.into()),
                    };
                    let result = result.and_then(|()| {
                        ensure!(
                            state
                                .cancelling_since
                                .is_none_or(|since| since.elapsed() < TIMEOUT),
                            "Antigravity stop timed out; outcome unknown"
                        );
                        Ok(())
                    });
                    if let Err(error) = result {
                        state.fail(error);
                        break;
                    }
                }
                let _ = worker_client.shutdown();
            })?;
        Ok(Self {
            client,
            state,
            stopped,
            worker: Some(worker),
        })
    }

    pub fn snapshot(&self) -> Value {
        self.state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .snapshot()
    }

    pub fn is_failed(&self) -> bool {
        self.state.lock().unwrap_or_else(|p| p.into_inner()).status == "failed"
    }

    pub fn is_outcome_unknown(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_outcome_unknown()
    }

    pub fn is_retirable(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_retirable()
    }

    #[cfg(all(test, unix))]
    pub(crate) fn connect_for_test(
        executable: &Path,
        args: &[OsString],
        workspace: PathBuf,
        session_id: String,
    ) -> Result<Self> {
        Self::connect_with(executable, args, workspace, session_id)
    }

    pub fn send(&self, text: &str, expected_revision: u64) -> Result<Value> {
        ensure!(
            !text.trim().is_empty() && text.len() <= agentkib_antigravity_bridge::MAX_PROMPT_BYTES,
            "invalid Antigravity prompt"
        );
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("ACP state unavailable"))?;
        state.revision(expected_revision)?;
        ensure!(
            state.status == "idle" && state.turn.is_none(),
            "Antigravity turn already active"
        );
        // BlockingClient cannot distinguish a request rejected before writing
        // from a write/flush/timeout failure after some or all prompt bytes may
        // have reached the server. Fence the session before dispatch so every
        // such error is treated as outcome-unknown. The checks above remain
        // outside the fence because they cannot have reached the native server.
        state.turn = Some(RpcId::String(DISPATCHING_TURN_ID.into()));
        state.status = "running";
        match self.client.prompt(&state.session_id, text) {
            Ok(id) => {
                state.turn = Some(id);
                state.stream_text.clear();
                state.updates.clear();
                state.tool_calls.clear();
                state.seen_permissions.clear();
                state.reason = None;
                state.revision += 1;
                Ok(state.snapshot())
            }
            Err(error) => {
                state.fail(&error);
                Err(error.into())
            }
        }
    }

    pub fn stop(&self, expected_turn_id: &str, expected_revision: u64) -> Result<Value> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("ACP state unavailable"))?;
        state.revision(expected_revision)?;
        state.active_turn(expected_turn_id)?;
        match self.client.cancel(&state.session_id) {
            Ok(()) => {
                state.cancelling_since = Some(Instant::now());
                state.approvals.clear();
                state.status = "running";
                state.revision += 1;
                Ok(state.snapshot())
            }
            Err(error) => {
                state.fail(&error);
                Err(error.into())
            }
        }
    }

    pub fn approve(
        &self,
        request_id: &Value,
        turn_id: &str,
        option_id: &str,
        expected_revision: u64,
    ) -> Result<Value> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("ACP state unavailable"))?;
        let id = state.permission(request_id, turn_id, option_id, expected_revision)?;
        match self.client.respond_permission(&id, Some(option_id)) {
            Ok(()) => {
                state.approvals.retain(|a| &a["requestId"] != request_id);
                state.status = if state.approvals.is_empty() {
                    "running"
                } else {
                    "waiting-approval"
                };
                state.revision += 1;
                Ok(state.snapshot())
            }
            Err(error) => {
                state.fail(&error);
                Err(error.into())
            }
        }
    }
}

impl Drop for Runner {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        let _ = self.client.shutdown();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn wait_response(
    client: &BlockingClient,
    expected_id: &RpcId,
    expected_method: &str,
    mut replay: Option<&mut State>,
) -> Result<Value> {
    let deadline = Instant::now() + TIMEOUT;
    loop {
        ensure!(
            Instant::now() < deadline,
            "ACP attachment timed out; connection closed"
        );
        match client.next_event(deadline.saturating_duration_since(Instant::now()).min(POLL))? {
            Some(Event::Response { id, method, result }) => {
                ensure!(
                    &id == expected_id && method == expected_method,
                    "unexpected ACP attachment response"
                );
                return result.map_err(|error| {
                    anyhow::anyhow!("ACP {method} failed ({}): {}", error.code, error.message)
                });
            }
            Some(event @ Event::SessionUpdate { .. }) => {
                replay
                    .as_mut()
                    .context("unexpected ACP initialization update")?
                    .apply(event)?;
            }
            Some(Event::Notification { .. } | Event::UnsupportedRequest { .. }) | None => {}
            Some(_) => bail!("unexpected ACP interaction during attachment"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agentkib_antigravity_bridge::{PermissionOption, PermissionRequest, RpcError};

    fn active() -> State {
        let mut state = State::new("native-session".into());
        state.turn = Some(RpcId::Number(3));
        state.status = "running";
        state
    }

    fn permission() -> Event {
        Event::Permission {
            id: RpcId::String("approve-a".into()),
            request: PermissionRequest {
                session_id: "native-session".into(),
                tool_call: json!({"toolCallId":"tool-a","title":"Run tests","kind":"execute","rawInput":{"command":"cargo test","api_key":"sk-abcdefghijklmnop"}}),
                options: vec![
                    PermissionOption {
                        option_id: "native-yes".into(),
                        name: "Allow once".into(),
                        kind: "allow_once".into(),
                    },
                    PermissionOption {
                        option_id: "native-no".into(),
                        name: "Reject".into(),
                        kind: "reject_once".into(),
                    },
                ],
            },
        }
    }

    fn update(value: Value) -> Event {
        Event::SessionUpdate {
            session_id: "native-session".into(),
            update: value,
        }
    }

    #[test]
    fn approvals_preserve_native_choices_and_require_exact_pending_identity() {
        let mut state = active();
        state.apply(permission()).unwrap();
        let snapshot = state.snapshot();
        assert_eq!(
            snapshot["approvals"][0]["availableDecisions"],
            json!(["native-yes", "native-no"])
        );
        assert_eq!(snapshot["approvals"][0]["supported"], true);
        assert_eq!(
            snapshot["approvals"][0]["toolCall"],
            json!({"toolCallId":"tool-a","title":"Run tests","kind":"execute","rawInput":{"command":"cargo test","api_key":"[REDACTED]"}})
        );
        assert!(snapshot.get("updates").is_none());
        assert!(snapshot.get("toolCalls").is_none());
        assert_eq!(
            state.approvals[0]["toolCall"]["rawInput"]["command"],
            "cargo test"
        );
        assert_eq!(
            state.approvals[0]["toolCall"]["rawInput"]["api_key"],
            "[REDACTED]"
        );
        for (id, turn, option, revision) in [
            ("approve-a", "3", "accept", 1),
            ("approve-a", "old", "native-yes", 1),
            ("approve-a", "3", "native-yes", 0),
            ("old", "3", "native-yes", 1),
        ] {
            assert!(
                state
                    .permission(&json!(id), turn, option, revision)
                    .is_err()
            );
        }
        assert_eq!(
            state
                .permission(&json!("approve-a"), "3", "native-yes", 1)
                .unwrap(),
            RpcId::String("approve-a".into())
        );
        state.approvals.clear();
        assert!(
            state
                .permission(&json!("approve-a"), "3", "native-yes", 1)
                .is_err()
        );
        assert!(state.apply(permission()).is_err());
    }

    #[test]
    fn approvals_without_safe_action_details_fail_closed() {
        let cwd = std::env::temp_dir().canonicalize().unwrap();
        let file = cwd.join("src/a.rs").to_string_lossy().into_owned();
        let other = cwd.join("other/a.rs").to_string_lossy().into_owned();
        for (case, tool_call) in [
            json!({"toolCallId":"tool-a"}),
            json!({"toolCallId":"tool-a","title":"Run command"}),
            json!({"toolCallId":"tool-a","title":"Run command","rawInput":{"api_key":"sk-abcdefghijklmnop"}}),
            json!({"toolCallId":"tool-a","title":"Run command","rawInput":{"api_key":"sk-abcdefghijklmnop","cwd":"/tmp"}}),
            json!({"toolCallId":"tool-a","title":"Run command","rawInput":{"api_key":"sk-abcdefghijklmnop","description":"Run command"}}),
            json!({"toolCallId":"tool-a","title":"Run command","rawInput":{"command":"sk-abcdefghijklmnop","cwd":"/tmp"}}),
            json!({"toolCallId":"tool-a","title":"Run command","rawInput":{"command":"sk-abcdefghijklmnop","path":"/tmp/output"}}),
            json!({"toolCallId":"tool-a","title":"Run command","kind":"execute","rawInput":{"path":"/tmp/output"}}),
            json!({"toolCallId":"tool-a","title":"Run command","kind":"execute","rawInput":{"path":"/tmp/output"},"content":[{"type":"text","text":"Run command"}]}),
            json!({"toolCallId":"tool-a","title":"Run command","kind":"execute","rawInput":{"command":"cargo test","args":["sk-abcdefghijklmnop"]}}),
            json!({"toolCallId":"tool-a","title":"Move file","kind":"move","rawInput":{"path":"file.txt"}}),
            json!({"toolCallId":"tool-a","title":"Delete file","kind":"delete","rawInput":{"path":"file.txt"}}),
            json!({"toolCallId":"tool-a","title":"Unknown tool","kind":"other","rawInput":{"path":"file.txt"}}),
            json!({"toolCallId":"tool-a","title":"Unknown tool","rawInput":{"path":"file.txt"}}),
            json!({"toolCallId":"tool-a","title":"Search","kind":"search","rawInput":{"path":"file.txt"}}),
            json!({"toolCallId":"tool-a","title":"Fetch","kind":"fetch","rawInput":{"path":"file.txt"}}),
            json!({"toolCallId":"tool-a","title":"Read","kind":"read","rawInput":{"path":"file.txt","operation":"write"}}),
            json!({"toolCallId":"tool-a","title":"Read","kind":"read","rawInput":{"path":"file.txt"},"content":[{"type":"diff","path":"file.txt","oldText":"before","newText":"after"}]}),
            json!({"toolCallId":"tool-a","title":"Read","kind":"read","rawInput":{"path":"file.txt"},"locations":[{"path":"other.txt"}]}),
            json!({"toolCallId":"tool-a","title":"Read","kind":"read","rawInput":{"cwd":cwd,"path":"src/a.rs"},"locations":[{"path":other}]}),
            json!({"toolCallId":"tool-a","title":"Read","kind":"read","rawInput":{"path":"src/a.rs"},"locations":[{"path":file}]}),
            json!({"toolCallId":"tool-a","title":"Read","kind":"read","rawInput":{"cwd":cwd,"workingDirectory":other,"path":"src/a.rs"}}),
            json!({"toolCallId":"tool-a","title":"Edit file","kind":"edit","rawInput":{"path":"file.txt"}}),
            json!({"toolCallId":"tool-a","title":"Edit file","kind":"edit","rawInput":{"path":"file.txt"},"content":[{"type":"text","text":"Update file"}]}),
            json!({"toolCallId":"tool-a","title":"Edit file","kind":"edit","content":[{"type":"diff","path":"file.txt","oldText":"before"}]}),
            json!({"toolCallId":"tool-a","title":"Edit file","kind":"edit","content":[{"type":"diff","path":"file.txt","newText":"after"}]}),
            json!({"toolCallId":"tool-a","title":"Edit file","kind":"edit","content":[{"type":"diff","path":"file.txt","oldText":null,"newText":null}]}),
            json!({"toolCallId":"tool-a","title":"Edit file","kind":"edit","content":[{"type":"diff","path":"file.txt","oldText":"before","newText":"sk-abcdefghijklmnop"}]}),
            json!({"toolCallId":"tool-a","title":"Edit file","kind":"edit","rawInput":{"path":"file.txt","oldText":"before","newText":"sk-abcdefghijklmnop"}}),
            json!({"toolCallId":"tool-a","title":"Edit file","kind":"edit","rawInput":{"path":"file.txt","oldText":"before","newText":"after","operations":["extra"]}}),
            json!({"toolCallId":"tool-a","title":"Edit file","kind":"edit","rawInput":{"path":"file.txt","oldText":"before","newText":"after"},"locations":[{"path":"other.txt"}]}),
            json!({"toolCallId":"tool-a","title":"Edit file","kind":"edit","rawInput":{"cwd":cwd,"path":"src/a.rs","oldText":"before","newText":"after"},"content":[{"type":"diff","path":other,"oldText":"before","newText":"after"}]}),
            json!({"toolCallId":"tool-a","title":"Edit file","kind":"edit","rawInput":{"cwd":cwd,"path":"src/../src/a.rs","oldText":"before","newText":"after"},"content":[{"type":"diff","path":file,"oldText":"before","newText":"after"}]}),
            json!({"toolCallId":"tool-a","title":"Edit file","kind":"edit","rawInput":{"path":"file.txt","filePath":"other.txt","oldText":"before","newText":"after"}}),
            json!({"toolCallId":"tool-a","title":"Edit file","kind":"edit","rawInput":{"path":"file.txt","oldText":"before","newText":"after"},"content":[{"type":"diff","path":"file.txt","oldText":"before"}]}),
            json!({"toolCallId":"tool-a","title":"Edit file","kind":"edit","rawInput":{"path":"file.txt","oldText":"before","newText":"after"},"content":[{"type":"diff","path":"file.txt","oldText":"before","newText":"different"}]}),
            json!({"toolCallId":"tool-a","title":"Edit file","kind":"edit","rawInput":{"path":"file.txt"},"content":[{"type":"diff","path":"other.txt","oldText":"before","newText":"after"}]}),
            json!({"toolCallId":"tool-a","title":"Edit file","kind":"edit","content":[{"type":"diff","path":"file.txt","oldText":"before","newText":"after"},{"type":"diff","path":"other.txt"}]}),
            json!({"toolCallId":"tool-a","title":"Run command","locations":[{}]}),
            json!({"toolCallId":"tool-a","title":"Run command","locations":[{"path":"/tmp/output"}]}),
            json!({"toolCallId":"tool-a","title":"Run command","content":[{"type":"text","text":"sk-abcdefghijklmnop"},{"type":"text","text":"working directory /tmp"}]}),
            json!({"toolCallId":"tool-a","title":"Run command","rawInput":true}),
            json!({"toolCallId":"tool-a","rawOutput":{"secret":"result"}}),
            json!({"toolCallId":"tool-a","futureScope":{"root":"/"}}),
        ]
        .into_iter()
        .enumerate()
        {
            let mut state = active();
            state
                .apply(Event::Permission {
                    id: RpcId::String("approve-a".into()),
                    request: PermissionRequest {
                        session_id: "native-session".into(),
                        tool_call,
                        options: vec![PermissionOption {
                            option_id: "native-yes".into(),
                            name: "Allow once".into(),
                            kind: "allow_once".into(),
                        }],
                    },
                })
                .unwrap();
            let snapshot = state.snapshot();
            assert_eq!(snapshot["approvals"][0]["supported"], false, "case {case}");
            assert_eq!(
                snapshot["approvals"][0]["unsupportedReason"],
                "incomplete-operation-details"
            );
            assert_eq!(snapshot["approvals"][0]["availableDecisions"], json!([]));
            assert!(
                state
                    .permission(&json!("approve-a"), "3", "native-yes", 1)
                    .is_err()
            );
        }
    }

    #[test]
    fn edit_approvals_require_complete_visible_changes() {
        let cwd = std::env::temp_dir().canonicalize().unwrap();
        let file = cwd.join("src/a.rs").to_string_lossy().into_owned();
        for tool_call in [
            json!({"toolCallId":"tool-a","kind":"edit","rawInput":{"path":"file.txt","oldText":"before","newText":"after"}}),
            json!({"toolCallId":"tool-a","kind":"edit","rawInput":{"path":"file.txt","oldText":null,"newText":"new file"}}),
            json!({"toolCallId":"tool-a","kind":"edit","rawInput":{"path":"file.txt"},"content":[{"type":"diff","path":"file.txt","oldText":"before","newText":"after"}]}),
            json!({"toolCallId":"tool-a","kind":"edit","content":[{"type":"diff","path":"file.txt","oldText":null,"newText":"new file"}]}),
            json!({"toolCallId":"tool-a","kind":"edit","content":[{"type":"diff","path":"empty.txt","oldText":null,"newText":""}]}),
            json!({"toolCallId":"tool-a","kind":"edit","content":[{"type":"diff","path":"file.txt","oldText":null,"newText":"new file"}],"locations":[{"path":"file.txt","line":1}]}),
            json!({"toolCallId":"tool-a","kind":"edit","rawInput":{"path":"file.txt","oldText":"before","newText":"after"},"content":[{"type":"diff","path":"file.txt","oldText":"before","newText":"after"}]}),
            json!({"toolCallId":"tool-a","kind":"edit","content":[{"type":"diff","path":"first.txt","oldText":"before","newText":"after"},{"type":"diff","path":"second.txt","oldText":"before","newText":"after"}]}),
            json!({"toolCallId":"tool-a","kind":"edit","rawInput":{"cwd":cwd,"path":"src/a.rs","oldText":"before","newText":"after"},"content":[{"type":"diff","path":file,"oldText":"before","newText":"after"}],"locations":[{"path":file,"line":1}]}),
            json!({"toolCallId":"tool-a","kind":"edit","rawInput":{"cwd":cwd,"path":"src/a.rs","filePath":file,"oldText":null,"newText":"new file"},"content":[{"type":"diff","path":file,"oldText":null,"newText":"new file"}]}),
        ] {
            let projected = project_permission_tool_call(&tool_call).unwrap();
            assert_eq!(projected["kind"], "edit");
            let mut state = active();
            state
                .apply(Event::Permission {
                    id: RpcId::String("approve-a".into()),
                    request: PermissionRequest {
                        session_id: "native-session".into(),
                        tool_call,
                        options: vec![PermissionOption {
                            option_id: "native-yes".into(),
                            name: "Allow once".into(),
                            kind: "allow_once".into(),
                        }],
                    },
                })
                .unwrap();
            let snapshot = state.snapshot();
            assert_eq!(snapshot["approvals"][0]["supported"], true);
            assert_eq!(
                snapshot["approvals"][0]["availableDecisions"],
                json!(["native-yes"])
            );
        }
    }

    #[test]
    fn read_approvals_keep_known_path_actions_available() {
        let cwd = std::env::temp_dir().canonicalize().unwrap();
        let file = cwd.join("src/a.rs").to_string_lossy().into_owned();
        for tool_call in [
            json!({"toolCallId":"tool-a","kind":"read","rawInput":{"path":"file.txt"}}),
            json!({"toolCallId":"tool-a","kind":"read","rawInput":{"cwd":cwd,"path":"src/a.rs"},"locations":[{"path":file}]}),
        ] {
            let projected = project_permission_tool_call(&tool_call).unwrap();
            assert_eq!(projected["kind"], "read");
        }
    }

    #[test]
    fn home_scoped_paths_are_validated_without_exposing_the_home_directory() {
        let home = dirs::home_dir().expect("home directory required for this test");
        let Some(home_text) = home.to_str() else {
            return;
        };
        let cwd = home.join("agentkib-approval-home");
        let file = cwd.join("src/a.rs");
        for tool_call in [
            json!({"toolCallId":"tool-a","kind":"read","rawInput":{"cwd":cwd,"path":"src/a.rs"},"locations":[{"path":file}]}),
            json!({"toolCallId":"tool-a","kind":"edit","rawInput":{"cwd":cwd,"path":"src/a.rs","oldText":"before","newText":"after"},"content":[{"type":"diff","path":file,"oldText":"before","newText":"after"}],"locations":[{"path":file}]}),
        ] {
            let projected = project_permission_tool_call(&tool_call).unwrap();
            let displayed_cwd = projected["rawInput"]["cwd"].as_str().unwrap();
            assert!(displayed_cwd.starts_with("$HOME"));
            assert!(displayed_cwd.ends_with("agentkib-approval-home"));
            assert!(!projected.to_string().contains(home_text));
            let mut state = active();
            state
                .apply(Event::Permission {
                    id: RpcId::String("approve-a".into()),
                    request: PermissionRequest {
                        session_id: "native-session".into(),
                        tool_call,
                        options: vec![PermissionOption {
                            option_id: "native-yes".into(),
                            name: "Allow once".into(),
                            kind: "allow_once".into(),
                        }],
                    },
                })
                .unwrap();
            assert_eq!(state.snapshot()["approvals"][0]["supported"], true);
        }
        assert!(
            project_permission_tool_call(&json!({
                "toolCallId":"tool-a","kind":"read",
                "rawInput":{"cwd":"$HOME/agentkib-approval-home","path":"src/a.rs"},
                "locations":[{"path":file}]
            }))
            .is_err()
        );
        assert!(
            project_permission_tool_call(&json!({
                "toolCallId":"tool-a","kind":"read",
                "rawInput":{"cwd":home.join("sk-abcdefghijklmnop"),"path":"src/a.rs"}
            }))
            .is_err()
        );
    }

    #[test]
    fn unsupported_permission_does_not_expose_unredacted_tool_id() {
        let mut state = active();
        state
            .apply(Event::Permission {
                id: RpcId::String("approve-a".into()),
                request: PermissionRequest {
                    session_id: "native-session".into(),
                    tool_call: json!({"toolCallId":"sk-abcdefghijklmnop","rawInput":{"command":"cargo test"},"rawOutput":{"secret":"private"}}),
                    options: vec![PermissionOption {
                        option_id: "native-yes".into(),
                        name: "Allow once".into(),
                        kind: "allow_once".into(),
                    }],
                },
            })
            .unwrap();
        let snapshot = state.snapshot();
        assert_eq!(snapshot["approvals"][0]["supported"], false);
        assert_eq!(
            snapshot["approvals"][0]["toolCall"]["toolCallId"],
            "[unavailable]"
        );
        assert!(!snapshot.to_string().contains("sk-abcdefghijklmnop"));
    }

    #[test]
    fn cancellation_waits_for_matching_prompt_response() {
        let mut state = active();
        state.apply(permission()).unwrap();
        state.cancelling_since = Some(Instant::now());
        state.approvals.clear();
        state.status = "running";
        state
            .apply(Event::PermissionCancelled {
                id: RpcId::String("approve-a".into()),
                session_id: "native-session".into(),
            })
            .unwrap();
        assert_eq!(state.status, "running");
        assert_eq!(state.snapshot()["sendEnabled"], false);
        assert_eq!(state.snapshot()["stopEnabled"], false);
        state.apply(permission()).unwrap();
        assert!(state.approvals.is_empty());
        assert!(
            state
                .apply(Event::Response {
                    id: RpcId::Number(99),
                    method: "session/prompt".into(),
                    result: Ok(json!({"stopReason":"cancelled"}))
                })
                .is_err()
        );
        state
            .apply(Event::Response {
                id: RpcId::Number(3),
                method: "session/prompt".into(),
                result: Ok(json!({"stopReason":"cancelled"})),
            })
            .unwrap();
        assert_eq!(state.status, "idle");
        assert_eq!(state.snapshot()["turnId"], Value::Null);
        assert!(state.cancelling_since.is_none());
    }

    #[test]
    fn native_user_agent_and_tool_updates_are_preserved() {
        let mut state = active();
        state.apply(update(json!({"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"hello"}}))).unwrap();
        state.apply(update(json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"你好"}}))).unwrap();
        state.apply(update(json!({"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"thinking"}}))).unwrap();
        state.apply(update(json!({"sessionUpdate":"tool_call","toolCallId":"tool","title":"Read","status":"pending","rawInput":{"path":"private.txt"}}))).unwrap();
        state.apply(update(json!({"sessionUpdate":"tool_call_update","toolCallId":"tool","status":"completed","rawOutput":{"content":"secret result"},"content":[{"type":"content","content":{"type":"text","text":"file text"}}]}))).unwrap();
        assert_eq!(state.stream_text, "你好");
        assert_eq!(state.updates.len(), 5);
        assert_eq!(state.tool_calls.len(), 1);
        assert_eq!(state.tool_calls[0]["title"], "Read");
        assert_eq!(state.tool_calls[0]["status"], "completed");
        assert_eq!(state.tool_calls[0]["rawInput"]["path"], "private.txt");
        let snapshot = state.snapshot();
        assert!(snapshot.get("updates").is_none());
        assert!(snapshot.get("toolCalls").is_none());
        let encoded = serde_json::to_string(&snapshot).unwrap();
        assert!(!encoded.contains("thinking"));
        assert!(!encoded.contains("private.txt"));
        assert!(!encoded.contains("secret result"));
        assert!(!encoded.contains("file text"));
    }

    #[test]
    fn oversized_or_wrong_session_updates_never_enter_snapshot() {
        let mut state = active();
        assert!(state.apply(update(json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"\0".repeat(MAX_CONTENT / 4)}}))).is_err());
        assert!(state.stream_text.is_empty());
        assert!(state.updates.is_empty());
        assert!(
            state
                .apply(update(json!({
                    "sessionUpdate":"agent_thought_chunk",
                    "content":{"type":"text","text":"x".repeat(MAX_CONTENT)}
                })))
                .is_err()
        );
        assert!(state.updates.is_empty());
        assert!(
            state
                .apply(Event::SessionUpdate {
                    session_id: "other".into(),
                    update: json!({})
                })
                .is_err()
        );
        state.fail("x".repeat(MAX_CONTENT));
        assert_eq!(state.status, "outcome-unknown");
        assert!(state.is_outcome_unknown());
        assert!(!state.is_retirable());
        assert!(serde_json::to_vec(&state.snapshot()).unwrap().len() < MAX_CONTENT);
        assert!(state.revision(state.revision).is_err());
    }

    #[test]
    fn failures_without_an_active_turn_remain_reconnectable() {
        let mut state = State::new("native-session".into());
        state.fail("transport closed while idle");
        assert_eq!(state.status, "failed");
        assert!(state.is_reconnectable_failure());
        assert!(state.is_retirable());
        assert!(!state.is_outcome_unknown());
        assert_eq!(state.snapshot()["turnId"], Value::Null);
    }

    #[test]
    fn prompt_error_or_missing_stop_reason_does_not_report_idle() {
        let mut state = active();
        for result in [
            Ok(json!({})),
            Ok(json!({"stopReason":"future_unrecognized_reason"})),
            Err(RpcError {
                code: -1,
                message: "native failure".into(),
                data: None,
            }),
        ] {
            assert!(
                state
                    .apply(Event::Response {
                        id: RpcId::Number(3),
                        method: "session/prompt".into(),
                        result
                    })
                    .is_err()
            );
            assert_eq!(state.status, "running");
        }
    }

    #[test]
    fn passive_notifications_do_not_invalidate_approval_revision() {
        let mut state = active();
        state.apply(permission()).unwrap();
        state
            .apply(Event::Notification {
                method: "heartbeat".into(),
                params: json!({}),
            })
            .unwrap();
        assert_eq!(state.revision, 1);
        assert!(
            state
                .permission(&json!("approve-a"), "3", "native-no", 1)
                .is_ok()
        );
    }

    #[test]
    fn relative_executables_are_rejected_without_spawn() {
        assert!(executable(Path::new("agy_acp_server.par")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn control_rejects_unverified_server_versions() {
        let script = r#"
read -r line
printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentInfo":{"name":"antigravity-acp","version":"agy_acp_server_1.1.2"},"agentCapabilities":{"sessionCapabilities":{"resume":{}}}}}'
while read -r line; do :; done
"#;
        let workspace = std::env::temp_dir().canonicalize().unwrap();
        assert!(
            Runner::connect_with(
                Path::new("/bin/sh"),
                &["-c".into(), script.into()],
                workspace,
                "native-session".into(),
            )
            .is_err()
        );
    }

    #[cfg(unix)]
    fn wait_status(runner: &Runner, desired: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let snapshot = runner.snapshot();
            if snapshot["status"] == desired {
                return snapshot;
            }
            assert!(
                Instant::now() < deadline,
                "wanted {desired}, got {snapshot}"
            );
            thread::sleep(Duration::from_millis(5));
        }
    }

    #[cfg(unix)]
    fn wait_status_text(runner: &Runner, desired: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let snapshot = runner.snapshot();
            if snapshot["streamText"] == desired {
                return snapshot;
            }
            assert!(
                Instant::now() < deadline,
                "wanted stream text {desired}, got {snapshot}"
            );
            thread::sleep(Duration::from_millis(5));
        }
    }

    #[cfg(unix)]
    #[test]
    fn blocking_runner_drains_permission_while_prompt_is_running() {
        let script = r#"
read -r line
printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentInfo":{"name":"antigravity-acp","version":"agy_acp_server_1.1.1"},"agentCapabilities":{"sessionCapabilities":{"resume":{}}}}}'
read -r line
printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{}}'
read -r line
printf '%s\n' '{"jsonrpc":"2.0","id":"native-permission","method":"session/request_permission","params":{"sessionId":"native-session","toolCall":{"toolCallId":"tool","title":"Read","kind":"read","rawInput":{"path":"file.txt"}},"options":[{"optionId":"native-allow","name":"Allow once","kind":"allow_once"}]}}'
read -r line
case "$line" in
  *'"optionId":"native-allow"'*) ;;
  *) exit 1 ;;
esac
printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"native-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"done"}}}}'
printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}'
while read -r line; do :; done
"#;
        let workspace = std::env::temp_dir().canonicalize().unwrap();
        let runner = Runner::connect_with(
            Path::new("/bin/sh"),
            &["-c".into(), script.into()],
            workspace,
            "native-session".into(),
        )
        .unwrap();
        assert_eq!(runner.snapshot()["revision"], 0);
        let sent = runner.send("hello", 0).unwrap();
        assert_eq!(sent["turnId"], "3");
        let waiting = wait_status(&runner, "waiting-approval");
        let revision = waiting["revision"].as_u64().unwrap();
        assert!(
            runner
                .approve(&json!("native-permission"), "3", "accept", revision)
                .is_err()
        );
        runner
            .approve(&json!("native-permission"), "3", "native-allow", revision)
            .unwrap();
        let done = wait_status(&runner, "idle");
        assert_eq!(done["streamText"], "done");
        assert!(done["approvals"].as_array().unwrap().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn load_replay_is_captured_before_attach_and_transport_eof_fails_closed() {
        let script = r#"
read -r line
printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentInfo":{"name":"antigravity-acp","version":"agy_acp_server_1.1.1"},"agentCapabilities":{"loadSession":true}}}'
read -r line
printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"native-session","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"native history"}}}}'
printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{}}'
read -r line
exit 0
"#;
        let workspace = std::env::temp_dir().canonicalize().unwrap();
        let runner = Runner::connect_with(
            Path::new("/bin/sh"),
            &["-c".into(), script.into()],
            workspace,
            "native-session".into(),
        )
        .unwrap();
        let snapshot = runner.snapshot();
        assert!(snapshot.get("updates").is_none());
        assert!(snapshot.get("toolCalls").is_none());
        assert_eq!(
            runner.state.lock().unwrap().updates[0]["content"]["text"],
            "native history"
        );
        runner.send("hello", 0).unwrap();
        let failed = wait_status(&runner, "outcome-unknown");
        assert_eq!(failed["sendEnabled"], false);
        assert_eq!(failed["stopEnabled"], false);
        assert!(failed["approvals"].as_array().unwrap().is_empty());
        assert!(runner.is_outcome_unknown());
        assert!(!runner.is_retirable());
        assert!(
            runner
                .send("do not repeat", failed["revision"].as_u64().unwrap())
                .is_err()
        );
        assert_eq!(runner.snapshot()["status"], "outcome-unknown");
    }

    #[cfg(unix)]
    #[test]
    fn prompt_dispatch_error_is_outcome_unknown_and_cannot_be_retried() {
        let script = r#"
read -r line
printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentInfo":{"name":"antigravity-acp","version":"agy_acp_server_1.1.1"},"agentCapabilities":{"sessionCapabilities":{"resume":{}}}}}'
read -r line
printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{}}'
exec 0<&-
printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"native-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"stdin-closed"}}}}'
sleep 5
"#;
        let workspace = std::env::temp_dir().canonicalize().unwrap();
        let runner = Runner::connect_with(
            Path::new("/bin/sh"),
            &["-c".into(), script.into()],
            workspace,
            "native-session".into(),
        )
        .unwrap();
        let ready = wait_status_text(&runner, "stdin-closed");
        assert_eq!(ready["status"], "idle");

        // Pure local validation happens before the dispatch fence.
        assert!(runner.send(" ", 1).is_err());
        assert_eq!(runner.snapshot()["status"], "idle");

        assert!(runner.send("run once", 1).is_err());
        let failed = runner.snapshot();
        assert_eq!(failed["status"], "outcome-unknown");
        assert_eq!(failed["sendEnabled"], false);
        assert_eq!(failed["stopEnabled"], false);
        assert!(failed["turnId"].is_string());
        assert!(runner.is_outcome_unknown());
        assert!(!runner.is_retirable());
        let revision = failed["revision"].as_u64().unwrap();
        assert!(runner.send("do not repeat", revision).is_err());
        assert_eq!(runner.snapshot()["status"], "outcome-unknown");
    }

    #[cfg(unix)]
    #[test]
    fn stop_cancels_pending_permission_and_requires_native_acknowledgement() {
        let script = r#"
read -r line
printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentInfo":{"name":"antigravity-acp","version":"agy_acp_server_1.1.1"},"agentCapabilities":{"sessionCapabilities":{"resume":{}}}}}'
read -r line
printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{}}'
read -r line
printf '%s\n' '{"jsonrpc":"2.0","id":"pending","method":"session/request_permission","params":{"sessionId":"native-session","toolCall":{"toolCallId":"tool","title":"Read"},"options":[{"optionId":"allow","name":"Allow once","kind":"allow_once"}]}}'
read -r line
case "$line" in *'"method":"session/cancel"'*) ;; *) exit 1 ;; esac
read -r line
case "$line" in *'"outcome":"cancelled"'*) ;; *) exit 1 ;; esac
printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"stopReason":"cancelled"}}'
while read -r line; do :; done
"#;
        let workspace = std::env::temp_dir().canonicalize().unwrap();
        let runner = Runner::connect_with(
            Path::new("/bin/sh"),
            &["-c".into(), script.into()],
            workspace,
            "native-session".into(),
        )
        .unwrap();
        runner.send("hello", 0).unwrap();
        let waiting = wait_status(&runner, "waiting-approval");
        let stopped = runner
            .stop("3", waiting["revision"].as_u64().unwrap())
            .unwrap();
        assert_eq!(stopped["status"], "running");
        assert_eq!(stopped["cancelling"], true);
        assert!(stopped["approvals"].as_array().unwrap().is_empty());
        let done = wait_status(&runner, "idle");
        assert_eq!(done["cancelling"], false);
    }

    #[cfg(unix)]
    #[test]
    fn missing_cancel_acknowledgement_fails_closed_at_deadline() {
        let script = r#"
read -r line
printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentInfo":{"name":"antigravity-acp","version":"agy_acp_server_1.1.1"},"agentCapabilities":{"sessionCapabilities":{"resume":{}}}}}'
read -r line
printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{}}'
while read -r line; do :; done
"#;
        let workspace = std::env::temp_dir().canonicalize().unwrap();
        let runner = Runner::connect_with(
            Path::new("/bin/sh"),
            &["-c".into(), script.into()],
            workspace,
            "native-session".into(),
        )
        .unwrap();
        runner.send("hello", 0).unwrap();
        let revision = runner.snapshot()["revision"].as_u64().unwrap();
        runner.stop("3", revision).unwrap();
        runner.state.lock().unwrap().cancelling_since = Some(Instant::now() - TIMEOUT);
        let failed = wait_status(&runner, "outcome-unknown");
        assert_eq!(failed["sendEnabled"], false);
        assert_eq!(failed["stopEnabled"], false);
        assert!(runner.is_outcome_unknown());
        assert!(!runner.is_retirable());
        assert!(
            failed["reason"]
                .as_str()
                .unwrap()
                .contains("outcome unknown")
        );
    }
}
