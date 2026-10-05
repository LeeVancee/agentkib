//! Payloads for official import commands. These functions never read original logs or
//! invoke a model; callers supply the frozen, already-redacted preview document.
use std::path::Path;

use agentkib_core::AgentKind;
use anyhow::{Context, Result, bail};
use chrono::{TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    SessionBlock, SessionDocument, SessionLoss, SessionLossCode, SessionRole, SessionTurn,
    import_notice,
};

pub const OPENCODE_IMPORT_VERSION: &str = "1.18.32";
pub const HERMES_IMPORT_VERSION: &str = "0.21.5";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeTargetModel {
    pub provider_id: String,
    pub model_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NativeImportPayload {
    pub payload: String,
    /// The exact projected conversation that must be visible after import.
    pub expected: SessionDocument,
}

pub fn prepare_native_import(
    target: AgentKind,
    document: &SessionDocument,
    id: &str,
    workspace: &Path,
    model: Option<&NativeTargetModel>,
) -> Result<NativeImportPayload> {
    if document.schema_version != crate::SESSION_DOCUMENT_SCHEMA_VERSION {
        bail!("Unsupported source document schema");
    }
    if !workspace.is_absolute() {
        bail!("Native import requires an absolute workspace path");
    }
    match target {
        AgentKind::OpenCode => {
            let identity = id
                .strip_prefix("ses_")
                .context("OpenCode ID must start with ses_")?;
            Uuid::parse_str(identity)
                .context("OpenCode import ID must contain an operation UUID")?;
            let model = model.context("OpenCode import requires an explicitly configured model")?;
            if model.provider_id.is_empty() || model.model_id.is_empty() {
                bail!("OpenCode import requires a provider and model");
            }
            let expected = project_text(document, false)?;
            let payload = render_opencode(&expected, id, workspace, model)?;
            Ok(NativeImportPayload { payload, expected })
        }
        AgentKind::OpenClaw => {
            Uuid::parse_str(id).context("OpenClaw ID must be an operation UUID")?;
            let expected = project_text(document, false)?;
            let payload = render_openclaw(&expected, id, workspace)?;
            Ok(NativeImportPayload { payload, expected })
        }
        AgentKind::Hermes => {
            let identity =
                Uuid::parse_str(id).context("Hermes source ID must be an operation UUID")?;
            let expected = project_text(document, true)?;
            let payload = render_claude_transport(&expected, identity, workspace)?;
            Ok(NativeImportPayload { payload, expected })
        }
        _ => bail!("No verified command import format for this target"),
    }
}

/// Text projection deliberately removes executable tool records. Tool activity is
/// represented as historical prose and the preview reports every converted block.
fn project_text(document: &SessionDocument, hermes: bool) -> Result<SessionDocument> {
    let mut expected = document.clone();
    expected.turns.clear();
    expected.turns.push(SessionTurn {
        id: "agentkib-import-notice".into(),
        role: SessionRole::User,
        timestamp: document.source.created_at,
        blocks: vec![SessionBlock::Text {
            text: import_notice().into(),
        }],
    });
    let mut tools = 0;
    let mut attachments = 0;
    let mut meaningful_text = false;
    for turn in &document.turns {
        let mut parts = Vec::new();
        for block in &turn.blocks {
            let text = match block {
                SessionBlock::Text { .. } if turn.role == SessionRole::Tool => {
                    tools += 1;
                    "[Historical tool output omitted]".into()
                }
                SessionBlock::Text { text } => {
                    meaningful_text |= !text.trim().is_empty();
                    text.clone()
                }
                SessionBlock::ToolCall { name, .. } => {
                    tools += 1;
                    format!("[Historical tool call: {name}; arguments omitted]")
                }
                SessionBlock::ToolResult { is_error, .. } => {
                    tools += 1;
                    format!(
                        "[Historical tool result{}; output omitted]",
                        if *is_error { " (error)" } else { "" }
                    )
                }
                SessionBlock::Attachment { .. } => {
                    attachments += 1;
                    "[Historical attachment omitted]".into()
                }
            };
            parts.push(text);
        }
        if parts.is_empty() {
            continue;
        }
        let text = parts.join("\n\n");
        let role = if turn.role == SessionRole::User {
            SessionRole::User
        } else {
            SessionRole::Assistant
        };
        // The pinned Hermes importer trims whole messages and drops injected-context
        // prefixes. Reject those payloads instead of quietly losing user text.
        if hermes
            && (text.trim() != text
                || (role == SessionRole::User && hermes_filters_user_text(&text)))
        {
            bail!("Hermes importer would remove or trim conversation text; use a file handoff");
        }
        if hermes && text.is_empty() {
            bail!("Hermes importer would drop an empty text message");
        }
        if hermes
            && expected
                .turns
                .last()
                .is_some_and(|previous| previous.role == role)
        {
            if let Some(SessionBlock::Text { text: previous }) = expected
                .turns
                .last_mut()
                .and_then(|turn| turn.blocks.first_mut())
            {
                previous.push_str("\n\n");
                previous.push_str(&text);
            }
        } else {
            expected.turns.push(SessionTurn {
                id: turn.id.clone(),
                role,
                timestamp: turn.timestamp,
                blocks: vec![SessionBlock::Text { text }],
            });
        }
    }
    if !meaningful_text {
        bail!("Native import requires non-empty conversation text");
    }
    for (code, count) in [
        (SessionLossCode::TargetToolSummary, tools),
        (SessionLossCode::TargetAttachmentOmitted, attachments),
    ] {
        if count == 0 {
            continue;
        }
        if let Some(loss) = expected.losses.iter_mut().find(|loss| loss.code == code) {
            loss.count += count;
        } else {
            expected.losses.push(SessionLoss { code, count });
        }
    }
    expected.losses.sort_by_key(|loss| loss.code);
    Ok(expected)
}

fn hermes_filters_user_text(text: &str) -> bool {
    let lower = text.to_lowercase();
    [
        "user_instructions",
        "environment_context",
        "recommended_plugins",
        "skills_instructions",
        "permissions_instructions",
        "permissions-instructions",
        "turn_context",
        "command-name",
        "command-message",
        "local-command-stdout",
        "system-reminder",
    ]
    .iter()
    .any(|tag| {
        lower.strip_prefix(&format!("<{tag}")).is_some_and(|rest| {
            rest.chars()
                .next()
                .is_none_or(|ch| !(ch.is_alphanumeric() || ch == '_'))
        })
    })
}

fn render_opencode(
    document: &SessionDocument,
    id: &str,
    workspace: &Path,
    model: &NativeTargetModel,
) -> Result<String> {
    let now = document
        .source
        .created_at
        .unwrap_or_else(epoch)
        .timestamp_millis()
        .max(0);
    let mut messages = Vec::new();
    let mut parent = String::new();
    let identity = id
        .strip_prefix("ses_")
        .context("Invalid OpenCode session ID")?;
    for (index, turn) in document.turns.iter().enumerate() {
        let message_id = format!("msg_{identity}_{index:08x}");
        let created = now.saturating_add(index as i64);
        let info = if turn.role == SessionRole::User {
            parent = message_id.clone();
            json!({"id":message_id,"sessionID":id,"role":"user","time":{"created":created},"agent":"build","model":{"providerID":model.provider_id,"modelID":model.model_id}})
        } else {
            json!({"id":message_id,"sessionID":id,"role":"assistant","time":{"created":created,"completed":created},"parentID":parent,"modelID":model.model_id,"providerID":model.provider_id,"mode":"build","agent":"build","path":{"cwd":workspace,"root":workspace},"cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}},"finish":"stop"})
        };
        let parts = turn.blocks.iter().enumerate().map(|(part_index, block)| {
            let SessionBlock::Text { text } = block else { unreachable!("text projection") };
            json!({"id":format!("prt_{identity}_{index:08x}_{part_index:08x}"),"sessionID":id,"messageID":message_id,"type":"text","text":text})
        }).collect::<Vec<_>>();
        messages.push(json!({"info":info,"parts":parts}));
    }
    Ok(serde_json::to_string_pretty(&json!({
        "info":{"id":id,"slug":format!("agentkib-{identity}"),"projectID":"global","directory":workspace,"title":document.source.title.as_deref().unwrap_or("Imported AgentKib conversation"),"version":OPENCODE_IMPORT_VERSION,"time":{"created":now,"updated":now.saturating_add(document.turns.len() as i64)}},
        "messages":messages
    }))?)
}

fn render_openclaw(document: &SessionDocument, id: &str, workspace: &Path) -> Result<String> {
    let timestamp = document.source.created_at.unwrap_or_else(epoch);
    let mut events =
        vec![json!({"type":"session","version":4,"id":id,"cwd":workspace,"timestamp":timestamp})];
    let mut parent: Option<String> = None;
    for (index, turn) in document.turns.iter().enumerate() {
        let event_id = format!("agentkib-{id}-{index:08x}");
        let time = turn.timestamp.unwrap_or(timestamp);
        let role = if turn.role == SessionRole::User {
            "user"
        } else {
            "assistant"
        };
        let content = turn
            .blocks
            .iter()
            .map(|block| match block {
                SessionBlock::Text { text } => json!({"type":"text","text":text}),
                _ => unreachable!("text projection"),
            })
            .collect::<Vec<_>>();
        let mut message =
            json!({"role":role,"content":content,"timestamp":time.timestamp_millis().max(0)});
        if role == "assistant" {
            message["stopReason"] = json!("stop");
            // Historical records are text only; no provider request or tool call is replayable.
            message["usage"] = json!({"input":0,"output":0,"totalTokens":0,"cost":{"input":0,"output":0,"total":0}});
        }
        events.push(json!({"type":"message","id":event_id,"parentId":parent,"timestamp":time,"message":message}));
        parent = Some(event_id);
    }
    Ok(serde_json::to_string(&events)?)
}

fn render_claude_transport(
    document: &SessionDocument,
    id: Uuid,
    workspace: &Path,
) -> Result<String> {
    // The projected notice is already present. Do not call the native renderer,
    // which would add a second notice and change the previewed text.
    let mut records = Vec::new();
    let mut parent: Option<Uuid> = None;
    for (index, turn) in document.turns.iter().enumerate() {
        let hash = Sha256::digest(format!("{id}:{index}").as_bytes());
        let uuid = Uuid::from_slice(&hash[..16])?;
        let content = turn
            .blocks
            .iter()
            .map(|block| match block {
                SessionBlock::Text { text } => json!({"type":"text","text":text}),
                _ => unreachable!("text projection"),
            })
            .collect::<Vec<_>>();
        let role = if turn.role == SessionRole::User {
            "user"
        } else {
            "assistant"
        };
        records.push(serde_json::to_string(&json!({"type":role,"uuid":uuid,"parentUuid":parent,"sessionId":id,"cwd":workspace,"isSidechain":false,"timestamp":turn.timestamp.unwrap_or_else(epoch),"message":{"role":role,"content":content}}))?);
        parent = Some(uuid);
    }
    Ok(records.join("\n") + "\n")
}

/// Compare the actual target document to the confirmed projection. Metadata may
/// change during import, but roles, turn order, text and blocks must not change.
pub fn validate_native_import_document(
    expected: &SessionDocument,
    actual: &SessionDocument,
) -> Result<()> {
    if actual.turns.len() != expected.turns.len() {
        bail!("Imported conversation turn count differs from preview");
    }
    if !actual.losses.is_empty() {
        bail!("Imported conversation could not be read without additional loss");
    }
    for (index, (expected, actual)) in expected.turns.iter().zip(&actual.turns).enumerate() {
        if expected.role != actual.role || expected.blocks != actual.blocks {
            bail!(
                "Imported conversation differs from preview at turn {}",
                index + 1
            );
        }
    }
    Ok(())
}

/// Strict export verification also checks native identity links, not only text.
pub fn validate_native_import_readback(
    target: AgentKind,
    export: &str,
    expected: &SessionDocument,
    native_session_id: &str,
) -> Result<()> {
    validate_opencode_readback(target, export, expected, native_session_id, false)
}

/// Subsequent resume may append turns, but must not alter the reviewed prefix.
pub fn validate_native_import_readback_prefix(
    target: AgentKind,
    export: &str,
    expected: &SessionDocument,
    native_session_id: &str,
) -> Result<()> {
    validate_opencode_readback(target, export, expected, native_session_id, true)
}

fn validate_opencode_readback(
    target: AgentKind,
    export: &str,
    expected: &SessionDocument,
    native_session_id: &str,
    allow_appended: bool,
) -> Result<()> {
    if target != AgentKind::OpenCode {
        bail!("Target requires provider document readback");
    }
    let value: Value = serde_json::from_str(export).context("Invalid OpenCode export")?;
    if value.pointer("/info/id").and_then(Value::as_str) != Some(native_session_id) {
        bail!("Imported session identity does not match operation");
    }
    let messages = value
        .get("messages")
        .and_then(Value::as_array)
        .context("Missing exported messages")?;
    if allow_appended {
        anyhow::ensure!(
            messages.len() >= expected.turns.len(),
            "Imported prefix is missing"
        );
    } else {
        anyhow::ensure!(
            messages.len() == expected.turns.len(),
            "Imported turn count differs from preview"
        );
    }
    anyhow::ensure!(
        value.pointer("/info/permission").is_none_or(Value::is_null),
        "Imported session changed permissions"
    );
    // OpenCode exports reverted messages but excludes them from the effective
    // conversation on resume. Matching stored text alone cannot prove continuity.
    anyhow::ensure!(
        value.pointer("/info/revert").is_none_or(Value::is_null),
        "Imported session has reverted history"
    );
    let identity = native_session_id
        .strip_prefix("ses_")
        .context("Invalid imported session ID")?;
    let mut parent = String::new();
    let mut actual = expected.clone();
    actual.losses.clear();
    actual.turns.clear();
    for (index, message) in messages.iter().take(expected.turns.len()).enumerate() {
        let info = message.get("info").context("Missing message info")?;
        let id = info
            .get("id")
            .and_then(Value::as_str)
            .context("Missing message ID")?;
        if info.get("sessionID").and_then(Value::as_str) != Some(native_session_id) {
            bail!("Imported message belongs to another session");
        }
        let role = match info.get("role").and_then(Value::as_str) {
            Some("user") => SessionRole::User,
            Some("assistant") => SessionRole::Assistant,
            _ => bail!("Unexpected imported message role"),
        };
        anyhow::ensure!(
            id == format!("msg_{identity}_{index:08x}"),
            "Imported message ID differs from operation"
        );
        anyhow::ensure!(
            info.get("agent").and_then(Value::as_str) == Some("build"),
            "Imported agent differs from preview"
        );
        if role == SessionRole::User {
            parent = id.to_owned();
            anyhow::ensure!(
                info.get("system").is_none_or(Value::is_null)
                    && info.get("tools").is_none_or(Value::is_null),
                "Imported user changed execution context"
            );
        } else {
            anyhow::ensure!(
                info.get("parentID").and_then(Value::as_str) == Some(parent.as_str())
                    && info.get("finish").and_then(Value::as_str) == Some("stop")
                    && info.get("error").is_none_or(Value::is_null)
                    && info.get("summary").and_then(Value::as_bool) != Some(true)
                    && info.get("mode").and_then(Value::as_str) == Some("build"),
                "Imported assistant execution state differs from preview"
            );
        }
        let mut blocks = Vec::new();
        for (part_index, part) in message
            .get("parts")
            .and_then(Value::as_array)
            .context("Missing parts")?
            .iter()
            .enumerate()
        {
            anyhow::ensure!(
                part.get("id").and_then(Value::as_str)
                    == Some(format!("prt_{identity}_{index:08x}_{part_index:08x}").as_str()),
                "Imported part ID differs from operation"
            );
            if part.get("sessionID").and_then(Value::as_str) != Some(native_session_id)
                || part.get("messageID").and_then(Value::as_str) != Some(id)
            {
                bail!("Imported part identity mismatch");
            }
            if part.get("type").and_then(Value::as_str) != Some("text")
                || part.get("ignored").and_then(Value::as_bool) == Some(true)
                || part.get("synthetic").and_then(Value::as_bool) == Some(true)
            {
                bail!("Unexpected imported part behavior");
            }
            blocks.push(SessionBlock::Text {
                text: part
                    .get("text")
                    .and_then(Value::as_str)
                    .context("Missing imported text")?
                    .into(),
            });
        }
        actual.turns.push(SessionTurn {
            id: id.into(),
            role,
            timestamp: None,
            blocks,
        });
    }
    validate_native_import_document(expected, &actual)
}

fn epoch() -> chrono::DateTime<Utc> {
    Utc.timestamp_opt(0, 0).single().expect("Unix epoch exists")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{SessionAttachmentKind, SessionDocumentSource};

    /// 各平台都视为绝对路径的合成工作区；Windows 不接受 `/tmp/...` 形式。
    fn synthetic_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(name)
    }

    fn sample() -> SessionDocument {
        SessionDocument {
            schema_version: 1,
            source: SessionDocumentSource {
                agent: AgentKind::Codex,
                workspace_id: "synthetic-workspace".into(),
                title: Some("Marker-only interop fixture".into()),
                created_at: None,
                updated_at: None,
                git_branch: None,
            },
            turns: vec![
                SessionTurn {
                    id: "u1".into(),
                    role: SessionRole::User,
                    timestamp: None,
                    blocks: vec![SessionBlock::Text {
                        text: "Marker: E9JQ. Keep SQLite.".into(),
                    }],
                },
                SessionTurn {
                    id: "a1".into(),
                    role: SessionRole::Assistant,
                    timestamp: None,
                    blocks: vec![
                        SessionBlock::Text {
                            text: "Decision: SQLite. Marker E9JQ.".into(),
                        },
                        SessionBlock::ToolCall {
                            call_id: "call1".into(),
                            name: "read_file".into(),
                            input: "{\"private\":\"omitted\"}".into(),
                        },
                    ],
                },
                SessionTurn {
                    id: "t1".into(),
                    role: SessionRole::Tool,
                    timestamp: None,
                    blocks: vec![SessionBlock::ToolResult {
                        call_id: "call1".into(),
                        output: "private output omitted".into(),
                        is_error: false,
                    }],
                },
                SessionTurn {
                    id: "u2".into(),
                    role: SessionRole::User,
                    timestamp: None,
                    blocks: vec![
                        SessionBlock::Text {
                            text: "Keep this decision.".into(),
                        },
                        SessionBlock::Attachment {
                            kind: SessionAttachmentKind::Image,
                            media_type: "image/png".into(),
                            filename: None,
                            inline_base64: Some("AA==".into()),
                        },
                    ],
                },
            ],
            losses: vec![],
            redaction_count: 0,
        }
    }

    fn open_payload(document: &SessionDocument) -> NativeImportPayload {
        prepare_native_import(
            AgentKind::OpenCode,
            document,
            "ses_00112233445566778899aabbccddeeff",
            &synthetic_path("agentkib-synthetic"),
            Some(&NativeTargetModel {
                provider_id: "test-provider".into(),
                model_id: "test-model".into(),
            }),
        )
        .unwrap()
    }

    #[test]
    fn projected_payload_is_deterministic_and_tool_records_are_not_executable() {
        let first = open_payload(&sample());
        let second = open_payload(&sample());
        assert_eq!(first.payload, second.payload);
        assert_eq!(first.expected, second.expected);
        assert!(!first.payload.contains("private output omitted"));
        assert!(!first.payload.contains("tool_use"));
        assert!(first.expected.losses.contains(&SessionLoss {
            code: SessionLossCode::TargetToolSummary,
            count: 2
        }));
        assert!(first.expected.losses.contains(&SessionLoss {
            code: SessionLossCode::TargetAttachmentOmitted,
            count: 1
        }));
        validate_native_import_readback(
            AgentKind::OpenCode,
            &first.payload,
            &first.expected,
            "ses_00112233445566778899aabbccddeeff",
        )
        .unwrap();
    }

    #[test]
    fn readback_rejects_text_role_order_and_behavior_changes() {
        let prepared = open_payload(&sample());
        let baseline: Value = serde_json::from_str(&prepared.payload).unwrap();
        for (pointer, replacement) in [
            ("/messages/1/parts/0/text", json!("different user request")),
            ("/messages/1/info/role", json!("assistant")),
            ("/messages/1/parts/0/ignored", json!(true)),
            ("/messages/1/parts/0/messageID", json!("msg_another")),
            ("/info/id", json!("ses_another")),
            ("/info/revert", json!({"messageID":"msg_reverted"})),
            ("/messages/2/info/parentID", json!("msg_unrelated")),
            ("/messages/2/info/finish", json!("tool-calls")),
            ("/messages/2/info/error", json!({"name":"APIError"})),
            ("/messages/2/info/summary", json!(true)),
        ] {
            let mut changed = baseline.clone();
            if pointer.ends_with("ignored") {
                changed["messages"][1]["parts"][0]["ignored"] = replacement;
            } else if pointer == "/info/revert" {
                changed["info"]["revert"] = replacement;
            } else if pointer.ends_with("error") || pointer.ends_with("summary") {
                changed["messages"][2]["info"][pointer.rsplit('/').next().unwrap()] = replacement;
            } else {
                *changed.pointer_mut(pointer).unwrap() = replacement;
            }
            assert!(
                validate_native_import_readback(
                    AgentKind::OpenCode,
                    &changed.to_string(),
                    &prepared.expected,
                    "ses_00112233445566778899aabbccddeeff"
                )
                .is_err(),
                "{pointer}"
            );
            assert!(
                validate_native_import_readback_prefix(
                    AgentKind::OpenCode,
                    &changed.to_string(),
                    &prepared.expected,
                    "ses_00112233445566778899aabbccddeeff"
                )
                .is_err(),
                "prefix accepted {pointer}"
            );
        }
        let mut changed = baseline;
        changed["messages"].as_array_mut().unwrap().swap(1, 2);
        assert!(
            validate_native_import_readback(
                AgentKind::OpenCode,
                &changed.to_string(),
                &prepared.expected,
                "ses_00112233445566778899aabbccddeeff"
            )
            .is_err()
        );
    }

    #[test]
    fn hermes_projection_is_alternating_deterministic_and_contains_notice_once() {
        let prepare = || {
            prepare_native_import(
                AgentKind::Hermes,
                &sample(),
                "00112233-4455-6677-8899-aabbccddeeff",
                &synthetic_path("agentkib-synthetic"),
                None,
            )
            .unwrap()
        };
        let first = prepare();
        assert_eq!(first.payload, prepare().payload);
        assert!(
            first
                .expected
                .turns
                .windows(2)
                .all(|pair| pair[0].role != pair[1].role)
        );
        assert_eq!(first.payload.matches(import_notice()).count(), 1);
        let records = first
            .payload
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(records.len(), first.expected.turns.len());
        for (record, turn) in records.iter().zip(&first.expected.turns) {
            let SessionBlock::Text { text } = &turn.blocks[0] else {
                panic!()
            };
            assert_eq!(record["message"]["content"][0]["text"], *text);
        }
    }

    #[test]
    fn hermes_rejects_text_that_official_importer_would_silently_drop_or_trim() {
        for text in [
            " leading space",
            "trailing newline\n",
            "<environment_context>actual user text</environment_context>",
            "<system-reminder>actual user text</system-reminder>",
        ] {
            let mut document = sample();
            document.turns[0].blocks = vec![SessionBlock::Text { text: text.into() }];
            assert!(
                prepare_native_import(
                    AgentKind::Hermes,
                    &document,
                    "00112233-4455-6677-8899-aabbccddeeff",
                    &synthetic_path("project"),
                    None
                )
                .is_err()
            );
        }
    }

    #[test]
    fn prefix_verification_allows_new_turns_but_not_mutated_imported_state() {
        let prepared = open_payload(&sample());
        let mut value: Value = serde_json::from_str(&prepared.payload).unwrap();
        value["messages"]
            .as_array_mut()
            .unwrap()
            .push(json!({"info":{"id":"msg_new","role":"user"},"parts":[]}));
        let id = "ses_00112233445566778899aabbccddeeff";
        assert!(
            validate_native_import_readback(
                AgentKind::OpenCode,
                &value.to_string(),
                &prepared.expected,
                id
            )
            .is_err()
        );
        validate_native_import_readback_prefix(
            AgentKind::OpenCode,
            &value.to_string(),
            &prepared.expected,
            id,
        )
        .unwrap();
        value["messages"][2]["info"]["finish"] = json!("tool-calls");
        assert!(
            validate_native_import_readback_prefix(
                AgentKind::OpenCode,
                &value.to_string(),
                &prepared.expected,
                id
            )
            .is_err()
        );
    }

    #[test]
    fn missing_model_unsupported_target_and_invalid_identity_fail_closed() {
        assert!(
            prepare_native_import(
                AgentKind::OpenCode,
                &sample(),
                "ses_00112233445566778899aabbccddeeff",
                &synthetic_path("project"),
                None
            )
            .is_err()
        );
        assert!(
            prepare_native_import(
                AgentKind::GrokBuild,
                &sample(),
                "00112233-4455-6677-8899-aabbccddeeff",
                &synthetic_path("project"),
                None
            )
            .is_err()
        );
        assert!(
            prepare_native_import(
                AgentKind::Hermes,
                &sample(),
                "../bad",
                &synthetic_path("project"),
                None
            )
            .is_err()
        );
    }

    #[test]
    fn openclaw_projection_is_deterministic_text_only_for_all_sources() {
        let id = "00112233-4455-6677-8899-aabbccddeeff";
        for source in [
            AgentKind::ClaudeCode,
            AgentKind::Codex,
            AgentKind::OpenCode,
            AgentKind::Hermes,
            AgentKind::GrokBuild,
            AgentKind::Cursor,
            AgentKind::Antigravity,
            AgentKind::OpenClaw,
        ] {
            let mut document = sample();
            document.source.agent = source;
            let prepared = prepare_native_import(
                AgentKind::OpenClaw,
                &document,
                id,
                &synthetic_path("project"),
                None,
            )
            .unwrap();
            assert_eq!(
                prepared,
                prepare_native_import(
                    AgentKind::OpenClaw,
                    &document,
                    id,
                    &synthetic_path("project"),
                    None
                )
                .unwrap()
            );
            let events: Vec<Value> = serde_json::from_str(&prepared.payload).unwrap();
            assert_eq!(events[0]["version"], 4);
            assert_eq!(events[0]["id"], id);
            assert_eq!(events.len(), prepared.expected.turns.len() + 1);
            for (index, (event, turn)) in
                events[1..].iter().zip(&prepared.expected.turns).enumerate()
            {
                assert_eq!(event["type"], "message");
                assert_eq!(
                    event["message"]["role"],
                    if turn.role == SessionRole::User {
                        "user"
                    } else {
                        "assistant"
                    }
                );
                assert!(event["message"].get("model").is_none());
                assert_eq!(event["id"], format!("agentkib-{id}-{index:08x}"));
                if index == 0 {
                    assert!(event["parentId"].is_null());
                } else {
                    assert_eq!(event["parentId"], events[index]["id"]);
                }
                let text = turn
                    .blocks
                    .iter()
                    .map(|block| match block {
                        SessionBlock::Text { text } => text.as_str(),
                        _ => panic!("executable block"),
                    })
                    .collect::<Vec<_>>();
                assert_eq!(
                    event["message"]["content"],
                    json!(
                        text.iter()
                            .map(|text| json!({"type":"text","text":text}))
                            .collect::<Vec<_>>()
                    )
                );
            }
        }
        assert!(
            prepare_native_import(
                AgentKind::OpenClaw,
                &sample(),
                "../../bad",
                &synthetic_path("project"),
                None
            )
            .is_err()
        );
    }

    #[test]
    fn all_source_agents_use_the_same_frozen_document_target_path() {
        for agent in [
            AgentKind::ClaudeCode,
            AgentKind::Codex,
            AgentKind::OpenCode,
            AgentKind::Hermes,
            AgentKind::GrokBuild,
            AgentKind::Cursor,
            AgentKind::Antigravity,
            AgentKind::OpenClaw,
        ] {
            let mut turns = sample().turns;
            turns[0].blocks.push(SessionBlock::Text {
                text: "API_KEY=synthetic-secret-must-not-reappear".into(),
            });
            // Exercise the same sanitizing finalizer used by source providers.
            // Individual parser shape fixtures remain in each provider's tests.
            let document = crate::finish_document(
                &crate::hermes::fixture_source(agent),
                turns,
                std::collections::BTreeMap::new(),
                None,
            )
            .unwrap();
            assert!(document.redaction_count > 0);
            let frozen = document.clone();
            for target in [AgentKind::OpenCode, AgentKind::Hermes] {
                let prepared = if target == AgentKind::OpenCode {
                    open_payload(&document)
                } else {
                    prepare_native_import(
                        target,
                        &document,
                        "00112233-4455-6677-8899-aabbccddeeff",
                        &synthetic_path("project"),
                        None,
                    )
                    .unwrap()
                };
                assert!(
                    !prepared
                        .payload
                        .contains("synthetic-secret-must-not-reappear")
                );
                assert!(prepared.payload.contains("[REDACTED]"));
                assert!(!prepared.payload.contains("tool_use"));
                assert!(!prepared.payload.contains("private output omitted"));
                assert_eq!(prepared.expected.redaction_count, document.redaction_count);
                assert!(prepared.expected.losses.contains(&SessionLoss {
                    code: SessionLossCode::TargetToolSummary,
                    count: 2
                }));
                assert!(prepared.expected.losses.contains(&SessionLoss {
                    code: SessionLossCode::TargetAttachmentOmitted,
                    count: 1
                }));
                if target == AgentKind::OpenCode {
                    validate_native_import_readback(
                        target,
                        &prepared.payload,
                        &prepared.expected,
                        "ses_00112233445566778899aabbccddeeff",
                    )
                    .unwrap();
                } else {
                    let records = prepared
                        .payload
                        .lines()
                        .map(|line| serde_json::from_str::<Value>(line).unwrap())
                        .collect::<Vec<_>>();
                    for (record, turn) in records.iter().zip(&prepared.expected.turns) {
                        assert_eq!(
                            record["message"]["role"],
                            if turn.role == SessionRole::User {
                                "user"
                            } else {
                                "assistant"
                            }
                        );
                        let SessionBlock::Text { text } = &turn.blocks[0] else {
                            panic!()
                        };
                        assert_eq!(record["message"]["content"][0]["text"], *text);
                    }
                    assert_eq!(records.len(), prepared.expected.turns.len());
                }
                assert_eq!(
                    document, frozen,
                    "conversion changed the frozen source document"
                );
            }
        }
    }
}

#[cfg(test)]
mod installed_cli_tests {
    use super::*;
    use crate::SessionDocumentSource;
    use std::{fs, process::Command};

    fn document() -> SessionDocument {
        SessionDocument {
            schema_version: 1,
            source: SessionDocumentSource {
                agent: AgentKind::ClaudeCode,
                workspace_id: "synthetic".into(),
                title: Some("AgentKib isolated import".into()),
                created_at: None,
                updated_at: None,
                git_branch: None,
            },
            turns: vec![
                SessionTurn {
                    id: "user".into(),
                    role: SessionRole::User,
                    timestamp: None,
                    blocks: vec![SessionBlock::Text {
                        text: "Random marker E9JQ. Project decision: use SQLite.".into(),
                    }],
                },
                SessionTurn {
                    id: "assistant".into(),
                    role: SessionRole::Assistant,
                    timestamp: None,
                    blocks: vec![SessionBlock::Text {
                        text: "Confirmed SQLite, marker E9JQ.".into(),
                    }],
                },
            ],
            losses: vec![],
            redaction_count: 0,
        }
    }

    #[test]
    #[ignore = "requires AGENTKIB_TEST_OPENCODE pointing to the isolated pinned CLI; no model calls"]
    fn official_opencode_import_export_roundtrip() {
        opencode_roundtrip(document());
    }

    fn rich_document() -> SessionDocument {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("grok.jsonl");
        let rows = [
            json!({"type":"user","content":[{"type":"text","text":"Remember 中文\nAPI_KEY=fixture-secret"},{"type":"image","url":"data:image/png;base64,YWJj"}]}),
            json!({"type":"reasoning","content":"PRIVATE-REASONING"}),
            json!({"type":"assistant","content":"Inspecting.","tool_calls":[{"id":"call-1","name":"read","arguments":"{\"path\":\"SECRET-ARG\"}"}]}),
            json!({"type":"tool_result","tool_call_id":"call-1","content":"SECRET-RESULT"}),
            json!({"type":"assistant","content":"Decision: preserve the complete history."}),
        ];
        fs::write(&path, rows.map(|row| row.to_string()).join("\n")).unwrap();
        let doc = crate::grokbuild::matrix_parse(&path).unwrap();
        assert!(doc.redaction_count > 0);
        assert!(
            !serde_json::to_string(&doc)
                .unwrap()
                .contains("fixture-secret")
        );
        assert!(
            matches!(&doc.turns[1].blocks[1], SessionBlock::ToolCall { call_id, .. } if call_id == "call-1")
        );
        assert!(
            matches!(&doc.turns[2].blocks[0], SessionBlock::ToolResult { call_id, .. } if call_id == "call-1")
        );
        doc
    }

    fn assert_rich_projection(prepared: &NativeImportPayload) {
        for (code, count) in [
            (SessionLossCode::ReasoningExcluded, 1),
            (SessionLossCode::TargetToolSummary, 2),
            (SessionLossCode::TargetAttachmentOmitted, 1),
        ] {
            assert_eq!(
                prepared
                    .expected
                    .losses
                    .iter()
                    .find(|loss| loss.code == code)
                    .map(|loss| loss.count),
                Some(count)
            );
        }
        for omitted in [
            "fixture-secret",
            "SECRET-ARG",
            "SECRET-RESULT",
            "PRIVATE-REASONING",
            "YWJj",
        ] {
            assert!(
                !prepared.payload.contains(omitted),
                "unexpected content: {omitted}"
            );
        }
        let texts: Vec<_> = prepared
            .expected
            .turns
            .iter()
            .flat_map(|turn| &turn.blocks)
            .map(|block| {
                let SessionBlock::Text { text } = block else {
                    panic!("executable or attachment block survived projection")
                };
                text.as_str()
            })
            .collect();
        let full = texts.join("\n");
        for required in [
            "Remember 中文\nAPI_KEY= [REDACTED]",
            "[Historical attachment omitted]",
            "[Historical tool call: read; arguments omitted]",
            "[Historical tool result; output omitted]",
            "Decision: preserve the complete history.",
        ] {
            assert!(full.contains(required), "missing projection: {required}");
        }
    }

    #[test]
    #[ignore = "requires isolated pinned OpenCode; native tool/attachment projection, no model calls"]
    fn official_opencode_rich_import_export_roundtrip() {
        opencode_roundtrip(rich_document());
    }

    fn opencode_roundtrip(document: SessionDocument) {
        let executable =
            std::env::var("AGENTKIB_TEST_OPENCODE").expect("isolated CLI path required");
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("project");
        fs::create_dir(&workspace).unwrap();
        let id = format!("ses_{}", Uuid::new_v4().simple());
        let prepared = prepare_native_import(
            AgentKind::OpenCode,
            &document,
            &id,
            &workspace,
            Some(&NativeTargetModel {
                provider_id: "offline-fixture".into(),
                model_id: "offline-fixture".into(),
            }),
        )
        .unwrap();
        if document.source.agent == AgentKind::GrokBuild {
            assert_rich_projection(&prepared);
        }
        let file = dir.path().join("import.json");
        fs::write(&file, &prepared.payload).unwrap();
        let run = |args: &[&str]| {
            Command::new(&executable)
                .args(args)
                .current_dir(&workspace)
                .env_clear()
                .env("PATH", std::env::var_os("PATH").unwrap_or_default())
                .env("HOME", dir.path().join("home"))
                .env("XDG_DATA_HOME", dir.path().join("data"))
                .env("XDG_CONFIG_HOME", dir.path().join("config"))
                .env("XDG_CACHE_HOME", dir.path().join("cache"))
                .env("XDG_STATE_HOME", dir.path().join("state"))
                .env("OPENCODE_DISABLE_AUTOUPDATE", "true")
                .env("OPENCODE_DISABLE_MODELS_FETCH", "true")
                .env("OPENCODE_DISABLE_DEFAULT_PLUGINS", "true")
                .output()
                .unwrap()
        };
        let imported = run(&["import", file.to_str().unwrap()]);
        assert!(
            imported.status.success(),
            "{}",
            String::from_utf8_lossy(&imported.stderr)
        );
        assert!(String::from_utf8_lossy(&imported.stdout).contains(&id));
        // Each export is a fresh process and therefore exercises persistent storage.
        for _ in 0..2 {
            let exported = run(&["export", &id]);
            assert!(
                exported.status.success(),
                "{}",
                String::from_utf8_lossy(&exported.stderr)
            );
            validate_native_import_readback(
                AgentKind::OpenCode,
                std::str::from_utf8(&exported.stdout).unwrap(),
                &prepared.expected,
                &id,
            )
            .unwrap();
            let native: Value = serde_json::from_slice(&exported.stdout).unwrap();
            for message in native["messages"].as_array().unwrap() {
                assert!(
                    message["parts"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .all(|part| part["type"] == "text")
                );
            }
        }
        assert_eq!(fs::read_to_string(file).unwrap(), prepared.payload);
    }

    #[test]
    #[ignore = "requires AGENTKIB_TEST_HERMES_SOURCE pinned official source and Python; no model calls"]
    fn official_hermes_import_db_roundtrip() {
        hermes_roundtrip(document());
    }

    #[test]
    #[ignore = "requires isolated pinned Hermes; native tool/attachment projection, no model calls"]
    fn official_hermes_rich_import_db_roundtrip() {
        hermes_roundtrip(rich_document());
    }

    fn hermes_roundtrip(document: SessionDocument) {
        let root = std::env::var("AGENTKIB_TEST_HERMES_SOURCE").expect("isolated source required");
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("project");
        fs::create_dir(&workspace).unwrap();
        let id = Uuid::new_v4().to_string();
        let prepared =
            prepare_native_import(AgentKind::Hermes, &document, &id, &workspace, None).unwrap();
        if document.source.agent == AgentKind::GrokBuild {
            assert_rich_projection(&prepared);
        }
        fs::create_dir(dir.path().join("hermes-home")).unwrap();
        fs::write(
            dir.path().join("hermes-home/config.yaml"),
            "updates:\n  check: false\n",
        )
        .unwrap();
        let file = dir.path().join("claude-import.jsonl");
        fs::write(&file, &prepared.payload).unwrap();
        let script = r#"
import json, os, re, subprocess, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from hermes_state import SessionDB
root=Path(sys.argv[2])
env=dict(os.environ, PYTHONPATH=sys.argv[1])
# This is the packaged `hermes` entry point declared in upstream pyproject.toml.
# A separate CLI process imports the Rust-produced payload with isolated HOME.
version=subprocess.run([sys.executable,'-m','hermes_cli.main','--version'],env=env,cwd=root,check=True,capture_output=True,text=True,timeout=30)
assert 'Hermes Agent v0.21.5 (2026.9.24)' in version.stdout
result=subprocess.run([sys.executable,'-m','hermes_cli.main','--profile','default','sessions','import','--from','claude',str(root/'claude-import.jsonl')],env=env,cwd=root,check=True,capture_output=True,text=True,timeout=30)
match=re.search(r'Imported Claude Code session as (\d{8}_\d{6}_[0-9a-f]{6})',result.stdout)
assert match, result.stdout
sid=match.group(1)
# Reopen the official DB after the CLI exited; do not trust the printed receipt.
database=root/'hermes-home'/'state.db'
db=SessionDB(db_path=database)
messages=db.get_messages(sid)
import sqlite3
conn=sqlite3.connect(database)
origin=conn.execute('SELECT origin_json FROM sessions WHERE id=?',(sid,)).fetchone()[0]
assert conn.execute('SELECT count(*) FROM sessions').fetchone()[0] == 1
assert conn.execute('SELECT count(*) FROM messages WHERE session_id=? AND (tool_calls IS NOT NULL OR tool_call_id IS NOT NULL OR tool_name IS NOT NULL)', (sid,)).fetchone()[0] == 0
print(json.dumps({'id':sid,'messages':messages,'origin':json.loads(origin),'cli_version':version.stdout.splitlines()[0],'cli_receipt':result.stdout}))
db.close()
"#;
        let output = Command::new(
            std::env::var("AGENTKIB_TEST_PYTHON").unwrap_or_else(|_| "python3".into()),
        )
        .args(["-c", script, &root, dir.path().to_str().unwrap()])
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOME", dir.path().join("home"))
        .env("HERMES_HOME", dir.path().join("hermes-home"))
        .env("HERMES_STATE_DB_TEST_MODE", "1")
        .output()
        .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(value["cli_version"], "Hermes Agent v0.21.5 (2026.9.24)");
        assert_eq!(fs::read_to_string(&file).unwrap(), prepared.payload);
        assert_eq!(value["origin"]["imported_from"]["foreign_session_id"], id);
        assert_eq!(
            value["origin"]["imported_from"]["path"],
            file.to_str().unwrap()
        );
        let messages = value["messages"].as_array().unwrap();
        assert_eq!(messages.len(), prepared.expected.turns.len());
        for (message, turn) in messages.iter().zip(&prepared.expected.turns) {
            let SessionBlock::Text { text } = &turn.blocks[0] else {
                panic!()
            };
            assert_eq!(message["content"], *text);
            assert_eq!(
                message["role"],
                if turn.role == SessionRole::User {
                    "user"
                } else {
                    "assistant"
                }
            );
        }
    }
}
