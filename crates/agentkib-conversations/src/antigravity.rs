use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use agentkib_antigravity_bridge::{BlockingClient, Compatibility, Event, RpcId};
use agentkib_core::AgentKind;
use agentkib_platform::{command, path as platform_path};
use anyhow::{Context, Result, bail, ensure};
use base64::Engine;
use chrono::{DateTime, Utc};
use serde_json::Value;

use crate::{
    ConversationEvent, ConversationEventKind, ConversationEventPage, ConversationProvider,
    ConversationSessionSummary, HandoffContext, NativeSessionListing, NativeSessionSummary,
    SessionAttachmentKind, SessionAvailability, SessionBlock, SessionDocument, SessionLossCode,
    SessionOrigin, SessionRole, SessionTurn,
};

const ACP_ENV: &str = "AGENTKIB_ANTIGRAVITY_ACP_BIN";
const ACP_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_LIST_PAGES: usize = 100;
const MAX_LIST_SESSIONS: usize = 10_000;
const MAX_REPLAY_UPDATES: usize = 100_000;
const MAX_REPLAY_BYTES: usize = 256 * 1024 * 1024;
const MAX_EVENTS_PER_PAGE: usize = 500;
const SNAPSHOT_TTL: Duration = Duration::from_secs(120);
const MAX_SNAPSHOTS: usize = 4;
const MAX_SNAPSHOT_BYTES: usize = 256 * 1024 * 1024;

static NEXT_SNAPSHOT_ID: AtomicU64 = AtomicU64::new(1);
static EVENT_SNAPSHOTS: OnceLock<Mutex<VecDeque<Arc<EventSnapshot>>>> = OnceLock::new();

struct EventSnapshot {
    id: u64,
    executable: PathBuf,
    native_ref: String,
    workspace: PathBuf,
    created: Instant,
    bytes: usize,
    events: Vec<ConversationEvent>,
    warnings: Vec<String>,
}

#[derive(Clone, Copy)]
enum EventCursor {
    Latest,
    Legacy(usize),
    Snapshot { id: u64, end: usize },
}

#[derive(Default)]
pub struct AntigravityProvider {
    executable: Option<PathBuf>,
}

#[derive(Debug, Clone)]
struct AcpSession {
    id: String,
    workspace: PathBuf,
    title: Option<String>,
    created_at: Option<DateTime<Utc>>,
    updated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Default)]
struct Replay {
    updates: Vec<Value>,
    bytes: usize,
}

#[derive(Debug, Default)]
struct SessionCollection {
    sessions: Vec<AcpSession>,
    incomplete: bool,
}

impl AntigravityProvider {
    fn executable(&self) -> Result<PathBuf> {
        if let Some(path) = &self.executable {
            return verified_executable(path);
        }
        if let Some(value) = env::var_os(ACP_ENV) {
            let path = PathBuf::from(value);
            ensure!(path.is_absolute(), "{ACP_ENV} must be an absolute path");
            return verified_executable(&path);
        }
        for name in ["agy_acp_server.par", "agy_acp_server.exe"] {
            if let Some(path) = command::resolve(name) {
                return verified_executable(&path);
            }
        }
        bail!(
            "Antigravity ACP server is unavailable; set {ACP_ENV} to the official absolute executable path"
        )
    }

    fn connect(&self, cwd: &Path) -> Result<(BlockingClient, Compatibility)> {
        let cwd = fs::canonicalize(cwd)
            .with_context(|| format!("Antigravity workspace is unavailable: {}", cwd.display()))?;
        let client =
            BlockingClient::spawn(&self.executable()?, &[] as &[OsString], &cwd, ACP_TIMEOUT)
                .context("Unable to start the official Antigravity ACP server")?;
        let request = client
            .initialize()
            .context("Antigravity ACP initialization failed")?;
        let value = wait_for_response(
            &client,
            &request,
            "initialize",
            None,
            Instant::now() + ACP_TIMEOUT,
        )?;
        let compatibility = Compatibility::from_initialize(&value)
            .context("Antigravity ACP compatibility negotiation failed")?;
        Ok((client, compatibility))
    }

    fn collect(&self, workspace: Option<&Path>) -> Result<SessionCollection> {
        let canonical_filter = workspace
            .map(fs::canonicalize)
            .transpose()
            .context("Antigravity workspace cannot be canonicalized")?;
        let process_cwd = canonical_filter
            .clone()
            .unwrap_or(fs::canonicalize(env::current_dir()?)?);
        let (client, compatibility) = self.connect(&process_cwd)?;
        ensure!(
            compatibility.list_sessions,
            "Antigravity ACP does not support session/list"
        );
        let result = collect_pages(&client, canonical_filter.as_deref());
        let _ = client.shutdown();
        result
    }

    fn resolve(&self, native_ref: &str) -> Result<AcpSession> {
        validate_native_ref(native_ref)?;
        let matches = self
            .collect(None)?
            .sessions
            .into_iter()
            .filter(|session| session.id == native_ref)
            .collect::<Vec<_>>();
        ensure!(
            matches.len() == 1,
            "Antigravity session is unavailable or ambiguous"
        );
        Ok(matches.into_iter().next().expect("one verified session"))
    }

    fn replay(&self, native_ref: &str) -> Result<(AcpSession, Replay)> {
        let session = self.resolve(native_ref)?;
        let (client, compatibility) = self.connect(&session.workspace)?;
        ensure!(
            compatibility.load_session,
            "Antigravity ACP does not support session/load"
        );
        let request = client
            .load_session(&session.id, &session.workspace)
            .context("Antigravity ACP session/load failed")?;
        let replay = collect_replay(&client, &request, &session.id);
        let _ = client.shutdown();
        Ok((session, replay?))
    }
}

impl ConversationProvider for AntigravityProvider {
    fn agent(&self) -> AgentKind {
        AgentKind::Antigravity
    }

    fn list_sessions(&self, workspace: &Path) -> Result<Vec<NativeSessionSummary>> {
        self.list_sessions_detailed(workspace)
            .map(|listing| listing.sessions)
    }

    fn list_sessions_detailed(&self, workspace: &Path) -> Result<NativeSessionListing> {
        let collected = self.collect(Some(workspace))?;
        let sessions = collected
            .sessions
            .into_iter()
            .map(|session| NativeSessionSummary {
                native_ref: session.id,
                agent: AgentKind::Antigravity,
                title: session.title,
                origin: SessionOrigin::Interactive,
                spawned_by_session_id: None,
                forked_from_session_id: None,
                created_at: session.created_at,
                updated_at: session.updated_at,
                message_count: None,
                git_branch: None,
                archived: false,
                sidechain: false,
                availability: SessionAvailability::Readable,
            })
            .collect();
        Ok(NativeSessionListing {
            sessions,
            incomplete: collected.incomplete,
        })
    }

    fn verified_control_id(&self, native_ref: &str) -> Result<Option<String>> {
        Ok(Some(self.resolve(native_ref)?.id))
    }

    fn verified_control_workspace(&self, native_ref: &str) -> Result<Option<PathBuf>> {
        Ok(Some(self.resolve(native_ref)?.workspace))
    }

    fn read_events(
        &self,
        native_ref: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<ConversationEventPage> {
        ensure!(
            (1..=MAX_EVENTS_PER_PAGE).contains(&limit),
            "Invalid event page size"
        );
        let cursor = parse_event_cursor(cursor)?;
        if let EventCursor::Snapshot { id, end } = cursor {
            let executable = self.executable()?;
            if let Some(snapshot) = cached_snapshot(id, &executable, native_ref) {
                // The cursor binds an old snapshot, but a session ID can be
                // reassigned to another workspace by the ACP server.
                if self.resolve(native_ref)?.workspace == snapshot.workspace {
                    return page_snapshot(&snapshot, end, limit);
                }
            }
        }
        let (session, replay) = self.replay(native_ref)?;
        let parsed = parse_replay(&replay.updates)?;
        match cursor {
            EventCursor::Legacy(end) => page_events(
                parsed.events,
                parsed.warnings,
                Some(&format!("antigravity-v1-{end}")),
                limit,
            ),
            EventCursor::Latest | EventCursor::Snapshot { .. } => {
                let end = match cursor {
                    EventCursor::Snapshot { end, .. } => Some(end),
                    _ => None,
                };
                snapshot_page(
                    self.executable()?,
                    session,
                    parsed.events,
                    parsed.warnings,
                    end,
                    limit,
                )
            }
        }
    }

    fn read_handoff_context(&self, native_ref: &str) -> Result<HandoffContext> {
        let (_, replay) = self.replay(native_ref)?;
        let parsed = parse_replay(&replay.updates)?;
        Ok(HandoffContext {
            compact_summary: None,
            messages: parsed.events,
            omitted_tool_count: 0,
            warnings: parsed.warnings,
        })
    }

    fn read_session_document(
        &self,
        source: &ConversationSessionSummary,
        native_ref: &str,
        home: Option<&Path>,
    ) -> Result<SessionDocument> {
        ensure!(
            source.agent == AgentKind::Antigravity,
            "Session source Agent mismatch"
        );
        let (session, replay) = self.replay(native_ref)?;
        let parsed = parse_replay(&replay.updates)?;
        let mut document_source = source.clone();
        document_source.title = parsed
            .title
            .unwrap_or_else(|| document_source.title.or(session.title));
        document_source.created_at = document_source.created_at.or(session.created_at);
        document_source.updated_at = parsed
            .updated_at
            .unwrap_or_else(|| document_source.updated_at.or(session.updated_at));
        crate::continuation::finish_document(&document_source, parsed.turns, parsed.losses, home)
    }
}

fn verified_executable(path: &Path) -> Result<PathBuf> {
    ensure!(
        path.is_absolute(),
        "Antigravity ACP executable path must be absolute"
    );
    ensure!(
        command::is_executable(path),
        "Antigravity ACP executable is not a runnable regular file"
    );
    fs::canonicalize(path).context("Antigravity ACP executable cannot be canonicalized")
}

fn wait_for_response(
    client: &BlockingClient,
    expected: &RpcId,
    method: &str,
    session_id: Option<&str>,
    deadline: Instant,
) -> Result<Value> {
    for _ in 0..1024 {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .context("Antigravity ACP operation timed out before its response")?;
        match client.next_event(remaining)? {
            Some(Event::Response {
                id,
                method: response_method,
                result,
            }) if &id == expected => {
                ensure!(
                    response_method == method,
                    "Antigravity ACP response method mismatch"
                );
                return result.map_err(|error| {
                    anyhow::anyhow!("Antigravity ACP {method} failed: {}", error.message)
                });
            }
            Some(Event::SessionUpdate {
                session_id: update_session,
                ..
            }) if session_id == Some(update_session.as_str()) => {
                bail!("Antigravity ACP replay was not collected by this operation")
            }
            Some(Event::Permission { id, .. }) => {
                let _ = client.respond_permission(&id, None);
                bail!("Antigravity ACP requested permission during a read-only operation")
            }
            Some(Event::PermissionCancelled { .. } | Event::UnsupportedRequest { .. }) => {
                bail!("Antigravity ACP emitted an invalid event during a read-only operation")
            }
            Some(
                Event::Response { .. } | Event::SessionUpdate { .. } | Event::Notification { .. },
            ) => {}
            None => bail!("Antigravity ACP operation timed out before its response"),
        }
    }
    bail!("Antigravity ACP emitted too many events before its response")
}

fn collect_pages(client: &BlockingClient, workspace: Option<&Path>) -> Result<SessionCollection> {
    let mut output = Vec::new();
    let mut incomplete = false;
    let mut cursor = None::<String>;
    let mut seen_cursors = BTreeSet::new();
    let deadline = Instant::now() + ACP_TIMEOUT;
    for _ in 0..MAX_LIST_PAGES {
        let request = client.list_sessions(workspace, cursor.as_deref())?;
        let result = wait_for_response(client, &request, "session/list", None, deadline)?;
        let sessions = result
            .get("sessions")
            .and_then(Value::as_array)
            .context("Antigravity ACP session/list response is missing sessions")?;
        for value in sessions {
            let session = match parse_session(value) {
                Ok(Some(session)) => session,
                Ok(None) | Err(_) => {
                    incomplete = true;
                    continue;
                }
            };
            if workspace
                .is_some_and(|expected| !platform_path::equivalent(&session.workspace, expected))
            {
                continue;
            }
            output.push(session);
            ensure!(
                output.len() <= MAX_LIST_SESSIONS,
                "Antigravity ACP session/list exceeds the session limit"
            );
        }
        let next = match result.get("nextCursor") {
            None | Some(Value::Null) => None,
            Some(Value::String(value)) if value.is_empty() => None,
            Some(Value::String(value)) => Some(value.clone()),
            Some(_) => bail!("Antigravity ACP session/list returned an invalid nextCursor"),
        };
        let Some(next) = next else {
            return Ok(SessionCollection {
                sessions: deduplicate_sessions(output)?,
                incomplete,
            });
        };
        ensure!(
            seen_cursors.insert(next.clone()),
            "Antigravity ACP pagination cursor repeated"
        );
        cursor = Some(next);
    }
    bail!("Antigravity ACP session/list exceeds the page limit")
}

fn parse_session(value: &Value) -> Result<Option<AcpSession>> {
    let id = value
        .get("sessionId")
        .and_then(Value::as_str)
        .context("Antigravity ACP session is missing sessionId")?;
    validate_native_ref(id)?;
    let cwd = value
        .get("cwd")
        .and_then(Value::as_str)
        .context("Antigravity ACP session is missing cwd")?;
    ensure!(
        Path::new(cwd).is_absolute(),
        "Antigravity ACP session cwd is not absolute"
    );
    let Ok(canonical) = fs::canonicalize(cwd) else {
        return Ok(None);
    };
    Ok(Some(AcpSession {
        id: id.to_owned(),
        workspace: canonical,
        title: value
            .get("title")
            .and_then(Value::as_str)
            .and_then(|title| super::sanitize_title(Some(title))),
        created_at: value.get("createdAt").and_then(super::parse_json_timestamp),
        updated_at: value
            .get("updatedAt")
            .or_else(|| value.get("lastActiveAt"))
            .and_then(super::parse_json_timestamp),
    }))
}

fn deduplicate_sessions(sessions: Vec<AcpSession>) -> Result<Vec<AcpSession>> {
    let mut unique = BTreeMap::new();
    for session in sessions {
        if let Some(previous) = unique.insert(session.id.clone(), session.clone()) {
            ensure!(
                platform_path::equivalent(&previous.workspace, &session.workspace),
                "Antigravity ACP returned one session ID for multiple workspaces"
            );
        }
    }
    Ok(unique.into_values().collect())
}

fn collect_replay(client: &BlockingClient, request: &RpcId, native_ref: &str) -> Result<Replay> {
    let mut replay = Replay::default();
    let deadline = Instant::now() + ACP_TIMEOUT;
    for _ in 0..=MAX_REPLAY_UPDATES {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .context("Antigravity ACP session/load timed out before replay completed")?;
        match client.next_event(remaining)? {
            Some(Event::SessionUpdate { session_id, update }) => {
                ensure!(
                    session_id == native_ref,
                    "Antigravity ACP replay session mismatch"
                );
                replay.bytes = replay
                    .bytes
                    .saturating_add(serde_json::to_vec(&update)?.len());
                ensure!(
                    replay.bytes <= MAX_REPLAY_BYTES,
                    "Antigravity ACP replay exceeds 256 MiB"
                );
                replay.updates.push(update);
            }
            Some(Event::Response { id, method, result }) if &id == request => {
                ensure!(
                    method == "session/load",
                    "Antigravity ACP load response method mismatch"
                );
                result.map_err(|error| {
                    anyhow::anyhow!("Antigravity ACP session/load failed: {}", error.message)
                })?;
                return Ok(replay);
            }
            Some(Event::Permission { id, .. }) => {
                let _ = client.respond_permission(&id, None);
                bail!("Antigravity ACP requested permission while loading history")
            }
            Some(Event::PermissionCancelled { .. } | Event::UnsupportedRequest { .. }) => {
                bail!("Antigravity ACP emitted an invalid event while loading history")
            }
            Some(Event::Response { .. } | Event::Notification { .. }) => {}
            None => bail!("Antigravity ACP session/load timed out before replay completed"),
        }
    }
    bail!("Antigravity ACP replay exceeds the update limit")
}

#[derive(Default)]
struct ParsedReplay {
    events: Vec<ConversationEvent>,
    turns: Vec<SessionTurn>,
    warnings: Vec<String>,
    losses: BTreeMap<SessionLossCode, usize>,
    // Missing field, explicit clear, and replacement are distinct ACP patches.
    title: Option<Option<String>>,
    updated_at: Option<Option<DateTime<Utc>>>,
}

struct ReplayToolCall {
    name: String,
    name_fields: Value,
    status: String,
    raw_output: Option<Value>,
    content_text: Option<String>,
    locations_loss_reported: bool,
    call_turn: usize,
    result_position: Option<(usize, usize)>,
}

impl ReplayToolCall {
    fn output(&self) -> Option<String> {
        match (&self.raw_output, &self.content_text) {
            (Some(raw), Some(text)) => Some(
                serde_json::to_string_pretty(&serde_json::json!({
                    "rawOutput": raw,
                    "contentText": text,
                }))
                .expect("JSON value serialization"),
            ),
            (Some(raw), None) => Some(json_text(raw)),
            (None, Some(text)) => Some(text.clone()),
            (None, None) => None,
        }
    }
}

fn parse_replay(updates: &[Value]) -> Result<ParsedReplay> {
    let mut parsed = ParsedReplay::default();
    let mut known_calls = BTreeMap::new();
    let mut messages = BTreeMap::new();
    let mut last_message_had_id = false;
    for (index, update) in updates.iter().enumerate() {
        let kind = update
            .get("sessionUpdate")
            .and_then(Value::as_str)
            .context("Antigravity ACP replay update is missing sessionUpdate")?;
        let id = format!("antigravity-update-{index}");
        match kind {
            "user_message_chunk" | "agent_message_chunk" => {
                let (event_kind, role) = if kind == "user_message_chunk" {
                    (ConversationEventKind::UserMessage, SessionRole::User)
                } else {
                    (ConversationEventKind::AgentMessage, SessionRole::Assistant)
                };
                let message_id = update
                    .get("messageId")
                    .filter(|value| !value.is_null())
                    .map(|value| {
                        value
                            .as_str()
                            .filter(|value| !value.is_empty())
                            .context("Invalid Antigravity messageId")
                    })
                    .transpose()?;
                if message_id.is_some() || last_message_had_id {
                    let mut chunk = ParsedReplay::default();
                    push_message_content(&mut chunk, id, event_kind, role, update.get("content"))?;
                    merge_message_chunk(&mut parsed, &mut messages, message_id, chunk)?;
                } else {
                    // Older ACP streams do not carry message identity. Preserve
                    // their adjacent-text coalescing, without merging into a
                    // preceding explicitly identified message.
                    push_message_content(&mut parsed, id, event_kind, role, update.get("content"))?;
                }
                last_message_had_id = message_id.is_some();
            }
            "agent_thought_chunk" => {
                record_loss(
                    &mut parsed,
                    SessionLossCode::ReasoningExcluded,
                    "Antigravity reasoning content was excluded",
                );
            }
            "tool_call" => {
                let call_id = tool_call_id(update)?;
                let name = tool_name(update);
                ensure!(
                    !known_calls.contains_key(&call_id),
                    "Duplicate Antigravity tool call ID"
                );
                let mut call = ReplayToolCall {
                    name: name.clone(),
                    name_fields: Value::Object(Default::default()),
                    status: "pending".into(),
                    raw_output: None,
                    content_text: None,
                    locations_loss_reported: false,
                    call_turn: parsed.turns.len(),
                    result_position: None,
                };
                let input = update.get("rawInput").map(json_text).unwrap_or_default();
                parsed.events.push(event(
                    &id,
                    ConversationEventKind::ToolSummary,
                    (!input.is_empty()).then_some(input.clone()),
                    Some(name.clone()),
                    update
                        .get("status")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                ));
                parsed.turns.push(SessionTurn {
                    id: id.clone(),
                    role: SessionRole::Tool,
                    timestamp: None,
                    blocks: vec![SessionBlock::ToolCall {
                        call_id: call_id.clone(),
                        name,
                        input,
                    }],
                });
                update_tool_call(&mut parsed, &id, &call_id, &mut call, update, true)?;
                known_calls.insert(call_id, call);
            }
            "tool_call_update" => {
                let call_id = tool_call_id(update)?;
                let call = known_calls
                    .get_mut(&call_id)
                    .context("Orphan Antigravity tool result")?;
                update_tool_call(&mut parsed, &id, &call_id, call, update, false)?;
            }
            "session_info_update" => parse_session_info(&mut parsed, update)?,
            "plan"
            | "available_commands_update"
            | "current_mode_update"
            | "config_option_update"
            | "usage_update" => {}
            _ => bail!("Unsupported Antigravity ACP replay update: {kind}"),
        }
    }
    Ok(parsed)
}

fn merge_message_chunk(
    parsed: &mut ParsedReplay,
    messages: &mut BTreeMap<String, (usize, usize)>,
    message_id: Option<&str>,
    chunk: ParsedReplay,
) -> Result<()> {
    for (code, count) in chunk.losses {
        *parsed.losses.entry(code).or_default() += count;
    }
    for warning in chunk.warnings {
        if !parsed.warnings.contains(&warning) {
            parsed.warnings.push(warning);
        }
    }
    let Some(mut turn) = chunk.turns.into_iter().next() else {
        return Ok(());
    };
    let incoming = chunk
        .events
        .into_iter()
        .next()
        .context("Missing Antigravity message event")?;
    if let Some(&(turn_index, event_index)) = message_id.and_then(|id| messages.get(id)) {
        let target = &mut parsed.turns[turn_index];
        ensure!(
            target.role == turn.role,
            "Antigravity messageId changed role"
        );
        for block in turn.blocks {
            match (target.blocks.last_mut(), block) {
                (Some(SessionBlock::Text { text }), SessionBlock::Text { text: next }) => {
                    text.push_str(&next)
                }
                (_, block) => target.blocks.push(block),
            }
        }
        let target_event = &mut parsed.events[event_index];
        if let Some(content) = incoming.content {
            if let Some(previous) = &mut target_event.content {
                if target_event.attachment_count > 0 || incoming.attachment_count > 0 {
                    previous.push('\n');
                }
                previous.push_str(&content);
            } else {
                target_event.content = Some(content);
            }
        }
        target_event.attachment_count += incoming.attachment_count;
    } else {
        if let Some(message_id) = message_id {
            messages.insert(
                message_id.to_owned(),
                (parsed.turns.len(), parsed.events.len()),
            );
        }
        // Use the first chunk's stable replay index, not a provider-controlled
        // messageId, as the public turn identity.
        turn.id = incoming.id.clone();
        parsed.turns.push(turn);
        parsed.events.push(incoming);
    }
    Ok(())
}

fn parse_session_info(parsed: &mut ParsedReplay, update: &Value) -> Result<()> {
    let fields = update
        .as_object()
        .context("Invalid Antigravity session metadata")?;
    for (key, value) in fields {
        match key.as_str() {
            "sessionUpdate" => {}
            "title" => {
                parsed.title = Some(if value.is_null() {
                    None
                } else {
                    Some(
                        value
                            .as_str()
                            .context("Invalid Antigravity session title")?
                            .to_owned(),
                    )
                });
            }
            "updatedAt" => {
                parsed.updated_at = Some(if value.is_null() {
                    None
                } else {
                    Some(
                        super::parse_json_timestamp(value)
                            .context("Invalid Antigravity session updatedAt")?,
                    )
                });
            }
            _ => record_loss(
                parsed,
                SessionLossCode::SourceContentTruncated,
                "Antigravity session metadata included fields without a session document mapping",
            ),
        }
    }
    Ok(())
}

fn update_tool_call(
    parsed: &mut ParsedReplay,
    id: &str,
    call_id: &str,
    call: &mut ReplayToolCall,
    update: &Value,
    initial: bool,
) -> Result<()> {
    if let Some(status) = update.get("status").filter(|value| !value.is_null()) {
        let status = status.as_str().context("Invalid Antigravity tool status")?;
        ensure!(
            matches!(status, "pending" | "in_progress" | "completed" | "failed"),
            "Unsupported Antigravity ACP tool status: {status}"
        );
        ensure!(
            call.result_position.is_none() || call.status == status,
            "Antigravity tool status changed after completion"
        );
        call.status = status.into();
    }
    for field in ["title", "name", "kind"] {
        if let Some(value) = update.get(field).filter(|value| !value.is_null()) {
            ensure!(value.is_string(), "Invalid Antigravity tool name metadata");
            call.name_fields[field] = value.clone();
        }
    }
    call.name = tool_name(&call.name_fields);
    // ACP patches these fields independently. Keep both latest values rather
    // than treating a content update as a replacement for rawOutput (or vice versa).
    if let Some(content) = update.get("content").filter(|value| !value.is_null()) {
        call.content_text = Some(tool_content_output(parsed, content)?);
    }
    if let Some(output) = update.get("rawOutput").filter(|value| !value.is_null()) {
        call.raw_output = Some(output.clone());
    }
    if let Some(locations) = update.get("locations").filter(|value| !value.is_null()) {
        let locations = locations
            .as_array()
            .context("Invalid Antigravity tool locations")?;
        if !locations.is_empty() && !call.locations_loss_reported {
            record_loss(
                parsed,
                SessionLossCode::SourceContentTruncated,
                "Antigravity tool locations cannot be represented in the session document",
            );
            // Count affected calls, not every repeated/replaced location snapshot.
            call.locations_loss_reported = true;
        }
    }
    if let SessionBlock::ToolCall { name, input, .. } = &mut parsed.turns[call.call_turn].blocks[0]
    {
        *name = call.name.clone();
        if let Some(value) = update.get("rawInput").filter(|value| !value.is_null()) {
            *input = json_text(value);
        }
    }
    if !matches!(call.status.as_str(), "completed" | "failed") {
        if !initial {
            parsed.events.push(event(
                id,
                ConversationEventKind::ToolSummary,
                call.output(),
                Some(call.name.clone()),
                Some(call.status.clone()),
            ));
        }
        return Ok(());
    }
    let output = call
        .output()
        .unwrap_or_else(|| format!("Antigravity tool status: {}", call.status));
    let block = SessionBlock::ToolResult {
        call_id: call_id.into(),
        output: output.clone(),
        is_error: call.status == "failed",
    };
    if let Some((turn_index, event_index)) = call.result_position {
        parsed.turns[turn_index].blocks[0] = block;
        let result_event = &mut parsed.events[event_index];
        result_event.content = Some(output);
        result_event.tool_name = Some(call.name.clone());
        result_event.tool_status = Some(call.status.clone());
    } else {
        call.result_position = Some((parsed.turns.len(), parsed.events.len()));
        let result_id = format!("{id}-result");
        parsed.events.push(event(
            &result_id,
            ConversationEventKind::ToolSummary,
            Some(output),
            Some(call.name.clone()),
            Some(call.status.clone()),
        ));
        parsed.turns.push(SessionTurn {
            id: result_id,
            role: SessionRole::Tool,
            timestamp: None,
            blocks: vec![block],
        });
    }
    Ok(())
}

fn tool_content_output(parsed: &mut ParsedReplay, content: &Value) -> Result<String> {
    let blocks = content
        .as_array()
        .context("Invalid Antigravity tool content")?;
    let mut texts = Vec::new();
    for block in blocks {
        match block.get("type").and_then(Value::as_str) {
            Some("content") => {
                let content = block
                    .get("content")
                    .context("Missing Antigravity tool content block")?;
                match content.get("type").and_then(Value::as_str) {
                    Some("text") => texts.push(
                        content
                            .get("text")
                            .and_then(Value::as_str)
                            .context("Invalid Antigravity tool text")?
                            .to_owned(),
                    ),
                    Some("resource") => {
                        if let Some(text) =
                            content.pointer("/resource/text").and_then(Value::as_str)
                        {
                            texts.push(text.to_owned());
                        }
                        record_loss(
                            parsed,
                            SessionLossCode::UnsupportedAttachment,
                            "Antigravity tool resource metadata or binary content cannot be represented by a text tool result",
                        );
                    }
                    _ => record_loss(
                        parsed,
                        SessionLossCode::UnsupportedAttachment,
                        "Antigravity tool contained non-text content that cannot be represented by a text tool result",
                    ),
                }
            }
            Some("diff") => record_loss(
                parsed,
                SessionLossCode::SourceContentTruncated,
                "Antigravity tool diff content cannot be represented by a text tool result",
            ),
            Some("terminal") => record_loss(
                parsed,
                SessionLossCode::SourceContentTruncated,
                "Antigravity tool terminal content cannot be represented by a text tool result",
            ),
            _ => record_loss(
                parsed,
                SessionLossCode::SourceContentTruncated,
                "Antigravity tool contained an unsupported structured content block",
            ),
        }
    }
    Ok(texts.join("\n"))
}

fn push_message_content(
    parsed: &mut ParsedReplay,
    id: String,
    event_kind: ConversationEventKind,
    role: SessionRole,
    value: Option<&Value>,
) -> Result<()> {
    let value = value.context("Antigravity ACP message chunk is missing content")?;
    if let Some(text) = value.as_str() {
        if !text.is_empty() {
            push_message(parsed, id, event_kind, role, text.to_owned());
        }
        return Ok(());
    }
    match value.get("type").and_then(Value::as_str) {
        Some("text") => {
            let text = value
                .get("text")
                .and_then(Value::as_str)
                .context("Antigravity ACP text content is missing text")?;
            if !text.is_empty() {
                push_message(parsed, id, event_kind, role, text.to_owned());
            }
        }
        Some("image") => {
            let data = required_base64(value, "image")?;
            let media_type = required_media_type(value, "image")?;
            push_attachment(
                parsed,
                id,
                event_kind,
                role,
                SessionBlock::Attachment {
                    kind: SessionAttachmentKind::Image,
                    media_type,
                    filename: attachment_name(value),
                    inline_base64: Some(data),
                },
            );
        }
        Some("audio") => {
            let data = required_base64(value, "audio")?;
            let media_type = required_media_type(value, "audio")?;
            record_loss(
                parsed,
                SessionLossCode::UnsupportedAttachment,
                "Antigravity audio was preserved as a document attachment",
            );
            push_attachment(
                parsed,
                id,
                event_kind,
                role,
                SessionBlock::Attachment {
                    kind: SessionAttachmentKind::Document,
                    media_type,
                    filename: attachment_name(value),
                    inline_base64: Some(data),
                },
            );
        }
        Some("resource") => {
            let resource = value
                .get("resource")
                .filter(|value| value.is_object())
                .context("Antigravity ACP resource content is missing resource")?;
            let data = if let Some(blob) = resource.get("blob").and_then(Value::as_str) {
                ensure!(
                    base64::engine::general_purpose::STANDARD
                        .decode(blob)
                        .is_ok(),
                    "Antigravity ACP resource blob is not valid base64"
                );
                Some(blob.to_owned())
            } else {
                resource
                    .get("text")
                    .and_then(Value::as_str)
                    .map(|text| base64::engine::general_purpose::STANDARD.encode(text.as_bytes()))
            };
            if data.is_none() {
                record_loss(
                    parsed,
                    SessionLossCode::ExternalAttachment,
                    "Antigravity resource content remains external",
                );
            }
            push_attachment(
                parsed,
                id,
                event_kind,
                role,
                SessionBlock::Attachment {
                    kind: SessionAttachmentKind::Document,
                    media_type: resource
                        .get("mimeType")
                        .and_then(Value::as_str)
                        .filter(|value| !value.trim().is_empty())
                        .unwrap_or_else(|| {
                            if resource.get("text").is_some_and(Value::is_string) {
                                "text/plain"
                            } else {
                                "application/octet-stream"
                            }
                        })
                        .to_owned(),
                    filename: attachment_name(resource),
                    inline_base64: data,
                },
            );
        }
        Some("resource_link") => {
            record_loss(
                parsed,
                SessionLossCode::ExternalAttachment,
                "Antigravity resource link remains external",
            );
            push_attachment(
                parsed,
                id,
                event_kind,
                role,
                SessionBlock::Attachment {
                    kind: SessionAttachmentKind::Document,
                    media_type: value
                        .get("mimeType")
                        .and_then(Value::as_str)
                        .unwrap_or("application/octet-stream")
                        .to_owned(),
                    filename: attachment_name(value),
                    inline_base64: None,
                },
            );
        }
        Some(_) => {
            record_loss(
                parsed,
                SessionLossCode::UnsupportedAttachment,
                "Antigravity message contained an unsupported content block",
            );
        }
        None => bail!("Invalid Antigravity ACP message content"),
    }
    Ok(())
}

fn push_attachment(
    parsed: &mut ParsedReplay,
    id: String,
    event_kind: ConversationEventKind,
    role: SessionRole,
    block: SessionBlock,
) {
    let label = match &block {
        SessionBlock::Attachment {
            media_type,
            filename,
            ..
        } => filename.clone().unwrap_or_else(|| media_type.clone()),
        _ => unreachable!("attachment parser only supplies attachment blocks"),
    };
    let mut attachment_event = event(&id, event_kind, Some(label), None, None);
    attachment_event.attachment_count = 1;
    parsed.events.push(attachment_event);
    parsed.turns.push(SessionTurn {
        id,
        role,
        timestamp: None,
        blocks: vec![block],
    });
}

fn required_base64(value: &Value, kind: &str) -> Result<String> {
    let data = value
        .get("data")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .with_context(|| format!("Antigravity ACP {kind} content is missing data"))?;
    ensure!(
        base64::engine::general_purpose::STANDARD
            .decode(&data)
            .is_ok(),
        "Antigravity ACP {kind} content is not valid base64"
    );
    Ok(data)
}

fn required_media_type(value: &Value, kind: &str) -> Result<String> {
    value
        .get("mimeType")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .with_context(|| format!("Antigravity ACP {kind} content is missing mimeType"))
}

fn attachment_name(value: &Value) -> Option<String> {
    value
        .get("name")
        .or_else(|| value.get("title"))
        .or_else(|| value.get("uri"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn record_loss(parsed: &mut ParsedReplay, code: SessionLossCode, warning: &str) {
    *parsed.losses.entry(code).or_default() += 1;
    if !parsed.warnings.iter().any(|value| value == warning) {
        parsed.warnings.push(warning.to_owned());
    }
}

fn push_message(
    parsed: &mut ParsedReplay,
    id: String,
    event_kind: ConversationEventKind,
    role: SessionRole,
    text: String,
) {
    if let Some(previous) = parsed.events.last_mut()
        && previous.kind == event_kind
        && previous.tool_name.is_none()
        && let Some(content) = previous.content.as_mut()
    {
        content.push_str(&text);
    } else {
        parsed
            .events
            .push(event(&id, event_kind, Some(text.clone()), None, None));
    }
    if let Some(previous) = parsed.turns.last_mut()
        && previous.role == role
        && let Some(SessionBlock::Text { text: content }) = previous.blocks.last_mut()
    {
        content.push_str(&text);
    } else {
        parsed.turns.push(SessionTurn {
            id,
            role,
            timestamp: None,
            blocks: vec![SessionBlock::Text { text }],
        });
    }
}

fn event(
    id: &str,
    kind: ConversationEventKind,
    content: Option<String>,
    tool_name: Option<String>,
    tool_status: Option<String>,
) -> ConversationEvent {
    ConversationEvent {
        id: id.into(),
        kind,
        turn_id: Some(id.into()),
        message_phase: None,
        timestamp: None,
        content,
        tool_name,
        tool_status,
        duration_ms: None,
        attachment_count: 0,
        truncated: false,
    }
}

fn tool_call_id(update: &Value) -> Result<String> {
    update
        .get("toolCallId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .context("Antigravity ACP tool update is missing toolCallId")
}

fn tool_name(update: &Value) -> String {
    update
        .get("title")
        .or_else(|| update.get("name"))
        .or_else(|| update.get("kind"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("tool")
        .to_owned()
}

fn json_text(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| value.to_string())
}

fn parse_event_cursor(cursor: Option<&str>) -> Result<EventCursor> {
    let Some(cursor) = cursor else {
        return Ok(EventCursor::Latest);
    };
    if cursor.starts_with("antigravity-v1-") {
        return Ok(EventCursor::Legacy(
            parse_cursor(Some(cursor))?.expect("legacy cursor is present"),
        ));
    }
    let suffix = cursor
        .strip_prefix("antigravity-v2-")
        .context("Invalid Antigravity event cursor")?;
    let (id, end) = suffix
        .split_once('-')
        .context("Invalid Antigravity event cursor")?;
    let id = id
        .parse::<u64>()
        .context("Invalid Antigravity event cursor")?;
    ensure!(id != 0, "Invalid Antigravity event cursor");
    let end = end
        .parse::<usize>()
        .context("Invalid Antigravity event cursor")?;
    Ok(EventCursor::Snapshot { id, end })
}

fn snapshot_cache() -> &'static Mutex<VecDeque<Arc<EventSnapshot>>> {
    EVENT_SNAPSHOTS.get_or_init(|| Mutex::new(VecDeque::new()))
}

fn cached_snapshot(id: u64, executable: &Path, native_ref: &str) -> Option<Arc<EventSnapshot>> {
    let mut cache = snapshot_cache()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    cache.retain(|snapshot| snapshot.created.elapsed() < SNAPSHOT_TTL);
    cache
        .iter()
        .find(|snapshot| {
            snapshot.id == id
                && snapshot.executable == executable
                && snapshot.native_ref == native_ref
        })
        .cloned()
}

fn snapshot_page(
    executable: PathBuf,
    session: AcpSession,
    events: Vec<ConversationEvent>,
    warnings: Vec<String>,
    end: Option<usize>,
    limit: usize,
) -> Result<ConversationEventPage> {
    let end = end.unwrap_or(events.len());
    ensure!(end <= events.len(), "Invalid Antigravity event cursor");
    let bytes = events.iter().fold(0usize, |total, event| {
        total
            .saturating_add(std::mem::size_of::<ConversationEvent>())
            .saturating_add(event.id.len())
            .saturating_add(event.turn_id.as_ref().map_or(0, String::len))
            .saturating_add(event.content.as_ref().map_or(0, String::len))
            .saturating_add(event.tool_name.as_ref().map_or(0, String::len))
            .saturating_add(event.tool_status.as_ref().map_or(0, String::len))
    });
    let bytes = warnings
        .iter()
        .fold(bytes, |total, warning| total.saturating_add(warning.len()));
    if bytes > MAX_SNAPSHOT_BYTES {
        // Keep the existing offset cursor for histories too large to retain.
        return page_events(
            events,
            warnings,
            Some(&format!("antigravity-v1-{end}")),
            limit,
        );
    }
    let snapshot = Arc::new(EventSnapshot {
        id: NEXT_SNAPSHOT_ID.fetch_add(1, Ordering::Relaxed),
        executable,
        native_ref: session.id,
        workspace: session.workspace,
        created: Instant::now(),
        bytes,
        events,
        warnings,
    });
    {
        let mut cache = snapshot_cache()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        cache.retain(|previous| previous.created.elapsed() < SNAPSHOT_TTL);
        cache.push_back(Arc::clone(&snapshot));
        while cache.len() > MAX_SNAPSHOTS
            || cache.iter().map(|item| item.bytes).sum::<usize>() > MAX_SNAPSHOT_BYTES
        {
            cache.pop_front();
        }
    }
    page_snapshot(&snapshot, end, limit)
}

fn page_snapshot(
    snapshot: &EventSnapshot,
    end: usize,
    limit: usize,
) -> Result<ConversationEventPage> {
    ensure!(
        end <= snapshot.events.len(),
        "Invalid Antigravity event cursor"
    );
    let start = end.saturating_sub(limit);
    Ok(ConversationEventPage {
        events: snapshot.events[start..end].to_vec(),
        next_cursor: (start > 0).then(|| format!("antigravity-v2-{}-{start}", snapshot.id)),
        warnings: snapshot.warnings.clone(),
    })
}

fn page_events(
    events: Vec<ConversationEvent>,
    warnings: Vec<String>,
    cursor: Option<&str>,
    limit: usize,
) -> Result<ConversationEventPage> {
    let end = parse_cursor(cursor)?.unwrap_or(events.len());
    ensure!(end <= events.len(), "Invalid Antigravity event cursor");
    let start = end.saturating_sub(limit);
    Ok(ConversationEventPage {
        events: events[start..end].to_vec(),
        next_cursor: (start > 0).then(|| format!("antigravity-v1-{start}")),
        warnings,
    })
}

fn parse_cursor(cursor: Option<&str>) -> Result<Option<usize>> {
    match cursor {
        None => Ok(None),
        Some(value) => value
            .strip_prefix("antigravity-v1-")
            .context("Invalid Antigravity event cursor")?
            .parse()
            .map(Some)
            .context("Invalid Antigravity event cursor"),
    }
}

fn validate_native_ref(value: &str) -> Result<()> {
    ensure!(
        !value.trim().is_empty() && value.len() <= 4096 && !value.contains(['\n', '\r', '\0']),
        "Invalid Antigravity native session reference"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    #[test]
    fn event_pages_start_with_latest_and_walk_backwards_stably() {
        let events = (0..5)
            .map(|index| {
                event(
                    &format!("event-{index}"),
                    ConversationEventKind::AgentMessage,
                    Some(index.to_string()),
                    None,
                    None,
                )
            })
            .collect::<Vec<_>>();

        let latest = page_events(events.clone(), vec!["warning".into()], None, 2).unwrap();
        assert_eq!(
            latest
                .events
                .iter()
                .filter_map(|event| event.content.as_deref())
                .collect::<Vec<_>>(),
            ["3", "4"]
        );
        assert_eq!(latest.next_cursor.as_deref(), Some("antigravity-v1-3"));
        assert_eq!(latest.warnings, ["warning"]);

        let mut appended = events.clone();
        appended.push(event(
            "event-5",
            ConversationEventKind::AgentMessage,
            Some("5".into()),
            None,
            None,
        ));
        let older = page_events(appended, Vec::new(), latest.next_cursor.as_deref(), 2).unwrap();
        assert_eq!(
            older
                .events
                .iter()
                .filter_map(|event| event.content.as_deref())
                .collect::<Vec<_>>(),
            ["1", "2"]
        );
        assert_eq!(older.next_cursor.as_deref(), Some("antigravity-v1-1"));

        let oldest =
            page_events(events.clone(), Vec::new(), older.next_cursor.as_deref(), 2).unwrap();
        assert_eq!(oldest.events[0].content.as_deref(), Some("0"));
        assert!(oldest.next_cursor.is_none());
        assert!(page_events(events.clone(), Vec::new(), Some("antigravity-v1-6"), 2).is_err());
        assert!(page_events(events, Vec::new(), Some("antigravity-v2-3"), 2).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn event_snapshot_reuses_load_across_provider_instances_and_refreshes_latest() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let moved_workspace = dir.path().join("moved-workspace");
        fs::create_dir(&moved_workspace).unwrap();
        let script = dir.path().join("agy_acp_server.par");
        let log = dir.path().join("calls.log");
        let marker = dir.path().join("new-message");
        let moved_marker = dir.path().join("moved-session");
        fs::write(
            &script,
            format!(
                r#"#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *\"method\":\"initialize\"*)
      printf '%s\n' '{{"jsonrpc":"2.0","id":1,"result":{{"protocolVersion":1,"agentCapabilities":{{"loadSession":true,"sessionCapabilities":{{"list":{{}}}}}}}}}}'
      ;;
    *\"method\":\"session/list\"*)
      printf 'list\n' >> '{}'
      if [ -f '{}' ]; then cwd='{}'; else cwd='{}'; fi
      printf '{{"jsonrpc":"2.0","id":2,"result":{{"sessions":[{{"sessionId":"native-1","cwd":"%s"}}]}}}}\n' "$cwd"
      ;;
    *\"method\":\"session/load\"*)
      printf 'load\n' >> '{}'
      for value in one two three; do
        printf '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"native-1","update":{{"sessionUpdate":"agent_message_chunk","messageId":"%s","content":{{"type":"text","text":"%s"}}}}}}}}\n' "$value" "$value"
      done
      if [ -f '{}' ]; then
        printf '%s\n' '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"native-1","update":{{"sessionUpdate":"agent_message_chunk","messageId":"four","content":{{"type":"text","text":"four"}}}}}}}}'
      fi
      printf '%s\n' '{{"jsonrpc":"2.0","id":2,"result":null}}'
      ;;
  esac
done
"#,
                log.display(),
                moved_marker.display(),
                moved_workspace.display(),
                workspace.display(),
                log.display(),
                marker.display()
            ),
        )
        .unwrap();
        let mut permissions = fs::metadata(&script).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&script, permissions).unwrap();

        let provider = AntigravityProvider {
            executable: Some(script.clone()),
        };
        let first = provider.read_events("native-1", None, 1).unwrap();
        assert_eq!(first.events[0].content.as_deref(), Some("three"));
        assert!(
            first
                .next_cursor
                .as_deref()
                .unwrap()
                .starts_with("antigravity-v2-")
        );
        fs::write(&marker, "updated").unwrap();
        let another_provider = AntigravityProvider {
            executable: Some(script),
        };
        let older = another_provider
            .read_events("native-1", first.next_cursor.as_deref(), 1)
            .unwrap();
        assert_eq!(older.events[0].content.as_deref(), Some("two"));
        assert_eq!(
            fs::read_to_string(&log).unwrap().matches("load\n").count(),
            1
        );

        let refreshed = another_provider.read_events("native-1", None, 1).unwrap();
        assert_eq!(refreshed.events[0].content.as_deref(), Some("four"));
        assert_eq!(
            fs::read_to_string(&log).unwrap().matches("load\n").count(),
            2
        );
        assert_eq!(
            another_provider
                .read_events("native-1", older.next_cursor.as_deref(), 1)
                .unwrap()
                .events[0]
                .content
                .as_deref(),
            Some("one")
        );
        assert_eq!(
            fs::read_to_string(&log).unwrap().matches("load\n").count(),
            2
        );
        let EventCursor::Snapshot { id, .. } =
            parse_event_cursor(first.next_cursor.as_deref()).unwrap()
        else {
            panic!("first page must use a snapshot cursor");
        };
        snapshot_cache()
            .lock()
            .unwrap()
            .retain(|snapshot| snapshot.id != id);
        let recovered = another_provider
            .read_events("native-1", first.next_cursor.as_deref(), 1)
            .unwrap();
        assert_eq!(recovered.events[0].content.as_deref(), Some("two"));
        assert_eq!(
            fs::read_to_string(&log).unwrap().matches("load\n").count(),
            3
        );
        fs::write(&moved_marker, "moved").unwrap();
        let moved = another_provider
            .read_events("native-1", recovered.next_cursor.as_deref(), 1)
            .unwrap();
        assert_eq!(moved.events[0].content.as_deref(), Some("one"));
        assert_eq!(
            fs::read_to_string(&log).unwrap().matches("load\n").count(),
            4
        );
        assert!(parse_event_cursor(Some("antigravity-v2-0-1")).is_err());
        assert!(parse_event_cursor(Some("antigravity-v2-1-invalid")).is_err());
    }

    #[test]
    fn replay_parser_maps_messages_and_tools() {
        let parsed = parse_replay(&[
            json!({"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"inspect"}}),
            json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"working"}}),
            json!({"sessionUpdate":"tool_call","toolCallId":"call-1","title":"shell","rawInput":{"command":"pwd"},"status":"pending"}),
            json!({"sessionUpdate":"tool_call_update","toolCallId":"call-1","title":"shell","rawOutput":"/workspace","status":"completed"}),
            json!({"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"private"}}),
        ])
        .unwrap();
        assert_eq!(parsed.events.len(), 4);
        assert_eq!(parsed.turns.len(), 4);
        assert_eq!(parsed.losses[&SessionLossCode::ReasoningExcluded], 1);
        assert!(matches!(
            parsed.turns[2].blocks[0],
            SessionBlock::ToolCall { .. }
        ));
        assert!(matches!(
            parsed.turns[3].blocks[0],
            SessionBlock::ToolResult { .. }
        ));
    }

    fn tool_results(parsed: &ParsedReplay) -> Vec<(&str, &str, bool)> {
        parsed
            .turns
            .iter()
            .flat_map(|turn| &turn.blocks)
            .filter_map(|block| {
                if let SessionBlock::ToolResult {
                    call_id,
                    output,
                    is_error,
                } = block
                {
                    Some((call_id.as_str(), output.as_str(), *is_error))
                } else {
                    None
                }
            })
            .collect()
    }

    #[test]
    fn progress_output_is_not_a_result_and_completion_uses_final_content() {
        let updates = [
            json!({"sessionUpdate":"tool_call","toolCallId":"call","title":"shell","status":"pending"}),
            json!({"sessionUpdate":"tool_call_update","toolCallId":"call","status":"in_progress","rawOutput":"partial raw output"}),
            json!({"sessionUpdate":"tool_call_update","toolCallId":"call","content":[{"type":"content","content":{"type":"text","text":"partial content"}}]}),
            json!({"sessionUpdate":"tool_call_update","toolCallId":"call","status":"completed","content":[{"type":"content","content":{"type":"text","text":"final output"}}]}),
        ];
        let progress = parse_replay(&updates[..3]).unwrap();
        assert!(tool_results(&progress).is_empty());
        assert_eq!(
            progress.events[2].tool_status.as_deref(),
            Some("in_progress")
        );
        let parsed = parse_replay(&updates).unwrap();
        let results = tool_results(&parsed);
        assert_eq!(results.len(), 1);
        assert_eq!(
            serde_json::from_str::<Value>(results[0].1).unwrap(),
            json!({
                "rawOutput":"partial raw output","contentText":"final output"
            })
        );
    }

    #[test]
    fn status_only_completion_keeps_output_and_later_output_updates_one_result() {
        let updates = [
            json!({"sessionUpdate":"tool_call","toolCallId":"call","status":"pending"}),
            json!({"sessionUpdate":"tool_call_update","toolCallId":"call","status":"in_progress","rawOutput":"latest"}),
            json!({"sessionUpdate":"tool_call_update","toolCallId":"call","status":"failed"}),
            json!({"sessionUpdate":"tool_call_update","toolCallId":"call","rawOutput":"final failure details"}),
            json!({"sessionUpdate":"tool_call_update","toolCallId":"call","status":"failed"}),
        ];
        let first_final = parse_replay(&updates[..3]).unwrap();
        assert_eq!(tool_results(&first_final), vec![("call", "latest", true)]);
        let parsed = parse_replay(&updates).unwrap();
        assert_eq!(
            tool_results(&parsed),
            vec![("call", "final failure details", true)]
        );
        assert_eq!(parsed.events.len(), 3);
        assert_eq!(
            parsed.events[2].content.as_deref(),
            Some("final failure details")
        );
        assert_eq!(
            parsed.events[2].turn_id.as_deref(),
            Some(parsed.turns[1].id.as_str())
        );
    }

    #[test]
    fn interleaved_tool_updates_accumulate_by_call_id() {
        let parsed = parse_replay(&[
            json!({"sessionUpdate":"tool_call","toolCallId":"a","status":"in_progress"}),
            json!({"sessionUpdate":"tool_call","toolCallId":"b","status":"pending"}),
            json!({"sessionUpdate":"tool_call_update","toolCallId":"a","rawOutput":"output a"}),
            json!({"sessionUpdate":"tool_call_update","toolCallId":"b","status":"completed","rawOutput":"output b"}),
            json!({"sessionUpdate":"tool_call_update","toolCallId":"a","status":"completed"}),
        ]).unwrap();
        assert_eq!(
            tool_results(&parsed),
            vec![("b", "output b", false), ("a", "output a", false)]
        );
    }

    #[test]
    fn initial_completed_tool_has_one_result_and_unknown_status_fails_closed() {
        let parsed = parse_replay(&[
            json!({"sessionUpdate":"tool_call","toolCallId":"call","status":"completed","rawOutput":"done"}),
            json!({"sessionUpdate":"tool_call_update","toolCallId":"call","status":"completed"}),
        ]).unwrap();
        assert_eq!(tool_results(&parsed), vec![("call", "done", false)]);
        assert_ne!(parsed.events[0].id, parsed.events[1].id);
        for status in ["cancelled", "error", "future_terminal"] {
            let error = parse_replay(&[
                json!({"sessionUpdate":"tool_call","toolCallId":"call","status":"pending"}),
                json!({"sessionUpdate":"tool_call_update","toolCallId":"call","status":status,"rawOutput":"not a native result"}),
            ]).err().unwrap();
            assert!(
                error
                    .to_string()
                    .contains("Unsupported Antigravity ACP tool status")
            );
        }
        assert!(parse_replay(&[
            json!({"sessionUpdate":"tool_call","toolCallId":"call","status":"completed"}),
            json!({"sessionUpdate":"tool_call_update","toolCallId":"call","status":"in_progress"}),
        ]).is_err());
    }

    #[test]
    fn replay_parser_preserves_content_and_redacts_text_resource_without_mime() {
        let parsed = parse_replay(&[
            json!({"sessionUpdate":"user_message_chunk","content":{"type":"image","data":"aW1hZ2U=","mimeType":"image/png","uri":"diagram.png"}}),
            json!({"sessionUpdate":"agent_message_chunk","content":{"type":"resource","resource":{"uri":"notes.txt","text":"token=sk-abcdefghijklmnop"}}}),
            json!({"sessionUpdate":"agent_message_chunk","content":{"type":"resource_link","uri":"https://example.test/report","name":"report","mimeType":"text/html"}}),
            json!({"sessionUpdate":"agent_message_chunk","content":{"type":"audio","data":"YXVkaW8=","mimeType":"audio/wav"}}),
            json!({"sessionUpdate":"config_option_update","configOptions":[]}),
            json!({"sessionUpdate":"session_info_update","title":"renamed"}),
            json!({"sessionUpdate":"usage_update","used":1}),
        ])
        .unwrap();
        assert_eq!(parsed.events.len(), 4);
        assert_eq!(parsed.turns.len(), 4);
        assert_eq!(parsed.events[0].attachment_count, 1);
        assert!(matches!(
            parsed.turns[0].blocks[0],
            SessionBlock::Attachment {
                kind: SessionAttachmentKind::Image,
                ..
            }
        ));
        assert_eq!(parsed.losses[&SessionLossCode::ExternalAttachment], 1);
        assert_eq!(parsed.losses[&SessionLossCode::UnsupportedAttachment], 1);
        assert_eq!(
            parsed.title.as_ref().and_then(|title| title.as_deref()),
            Some("renamed")
        );
        let source = ConversationSessionSummary {
            id: "stored".into(),
            workspace_id: "workspace".into(),
            agent: AgentKind::Antigravity,
            title: None,
            origin: SessionOrigin::Interactive,
            spawned_by_session_id: None,
            forked_from_session_id: None,
            created_at: None,
            updated_at: None,
            message_count: None,
            git_branch: None,
            archived: false,
            sidechain: false,
            availability: SessionAvailability::Readable,
        };
        let document =
            crate::continuation::finish_document(&source, parsed.turns, parsed.losses, None)
                .unwrap();
        assert_eq!(document.redaction_count, 1);
        let SessionBlock::Attachment {
            media_type,
            inline_base64: Some(data),
            ..
        } = &document.turns[1].blocks[0]
        else {
            panic!("resource attachment was not preserved")
        };
        assert_eq!(media_type, "text/plain");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(data)
            .unwrap();
        assert!(
            !String::from_utf8(decoded)
                .unwrap()
                .contains("sk-abcdefghijklmnop")
        );
    }

    #[test]
    fn replay_parser_fails_closed_for_unknown_or_orphan_updates() {
        assert!(parse_replay(&[json!({"sessionUpdate":"future_update"})]).is_err());
        assert!(
            parse_replay(&[json!({"sessionUpdate":"tool_call_update","toolCallId":"missing"})])
                .is_err()
        );
    }

    #[test]
    fn reasoning_warning_is_recorded_once_alongside_existing_warnings() {
        let parsed = parse_replay(&[
            json!({"sessionUpdate":"session_info_update","unmappedField":"metadata"}),
            json!({"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"private thought one"}}),
            json!({"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"private thought two"}}),
        ]).unwrap();
        assert_eq!(parsed.losses[&SessionLossCode::SourceContentTruncated], 1);
        assert_eq!(parsed.losses[&SessionLossCode::ReasoningExcluded], 2);
        assert_eq!(parsed.warnings.len(), 2);
        assert_eq!(
            parsed
                .warnings
                .iter()
                .filter(|warning| warning.as_str() == "Antigravity reasoning content was excluded")
                .count(),
            1
        );
        assert!(parsed.turns.is_empty());
        assert!(parsed.events.is_empty());
    }

    #[test]
    fn message_ids_keep_boundaries_and_combine_text_with_attachments() {
        let parsed = parse_replay(&[
            json!({"sessionUpdate":"user_message_chunk","messageId":"first","content":{"type":"text","text":"first "}}),
            json!({"sessionUpdate":"user_message_chunk","messageId":"first","content":{"type":"text","text":"message"}}),
            json!({"sessionUpdate":"user_message_chunk","messageId":"second","content":{"type":"image","mimeType":"image/png","data":"aW1hZ2U="}}),
            json!({"sessionUpdate":"user_message_chunk","messageId":"second","content":{"type":"text","text":"image description"}}),
            json!({"sessionUpdate":"user_message_chunk","messageId":"first","content":{"type":"resource","resource":{"uri":"notes.txt","text":"notes"}}}),
        ]).unwrap();
        assert_eq!(parsed.turns.len(), 2);
        assert_eq!(parsed.events.len(), 2);
        assert_eq!(
            parsed.turns[0].blocks[0],
            SessionBlock::Text {
                text: "first message".into()
            }
        );
        assert!(matches!(
            parsed.turns[0].blocks[1],
            SessionBlock::Attachment { .. }
        ));
        assert!(matches!(
            parsed.turns[1].blocks[0],
            SessionBlock::Attachment { .. }
        ));
        assert_eq!(
            parsed.turns[1].blocks[1],
            SessionBlock::Text {
                text: "image description".into()
            }
        );
        assert_eq!(parsed.events[0].attachment_count, 1);
        assert_eq!(parsed.events[1].attachment_count, 1);
        assert_ne!(parsed.events[0].id, parsed.events[1].id);
        assert_eq!(
            parsed.events[0].turn_id.as_deref(),
            Some(parsed.turns[0].id.as_str())
        );
    }

    #[test]
    fn legacy_chunks_coalesce_without_crossing_explicit_message_boundaries() {
        let parsed = parse_replay(&[
            json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"old "}}),
            json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"stream"}}),
            json!({"sessionUpdate":"agent_message_chunk","messageId":"native","content":{"type":"text","text":"explicit"}}),
            json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"legacy "}}),
            json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"tail"}}),
        ]).unwrap();
        assert_eq!(parsed.turns.len(), 3);
        assert_eq!(
            parsed
                .events
                .iter()
                .map(|event| event.content.as_deref().unwrap())
                .collect::<Vec<_>>(),
            ["old stream", "explicit", "legacy tail"]
        );
        assert!(parse_replay(&[
            json!({"sessionUpdate":"user_message_chunk","messageId":"same","content":{"type":"text","text":"user"}}),
            json!({"sessionUpdate":"agent_message_chunk","messageId":"same","content":{"type":"text","text":"agent"}}),
        ]).is_err());
    }

    #[test]
    fn session_info_distinguishes_absent_replacement_and_explicit_clear() {
        let omitted = parse_replay(&[json!({"sessionUpdate":"session_info_update"})]).unwrap();
        assert_eq!(omitted.title, None);
        assert_eq!(omitted.updated_at, None);
        let updates = [
            json!({"sessionUpdate":"session_info_update","title":"set","updatedAt":"2026-09-20T01:00:00Z"}),
            json!({"sessionUpdate":"session_info_update"}),
            json!({"sessionUpdate":"session_info_update","title":null,"updatedAt":null}),
            json!({"sessionUpdate":"session_info_update"}),
        ];
        let assigned = parse_replay(&updates[..2]).unwrap();
        assert_eq!(assigned.title, Some(Some("set".into())));
        assert!(assigned.updated_at.flatten().is_some());
        let cleared = parse_replay(&updates).unwrap();
        assert_eq!(cleared.title, Some(None));
        assert_eq!(cleared.updated_at, Some(None));
    }

    #[test]
    fn tool_display_name_uses_accumulated_independent_title_name_and_kind() {
        let updates = [
            json!({"sessionUpdate":"tool_call","toolCallId":"call","title":"Run tests","name":"shell","kind":"execute","status":"pending"}),
            json!({"sessionUpdate":"tool_call_update","toolCallId":"call","kind":"read"}),
            json!({"sessionUpdate":"tool_call_update","toolCallId":"call","name":"read_file"}),
            json!({"sessionUpdate":"tool_call_update","toolCallId":"call","status":"completed"}),
        ];
        let parsed = parse_replay(&updates).unwrap();
        let SessionBlock::ToolCall { name, .. } = &parsed.turns[0].blocks[0] else {
            panic!("missing call")
        };
        assert_eq!(name, "Run tests");
        assert!(
            parsed
                .events
                .iter()
                .all(|event| event.tool_name.as_deref() == Some("Run tests"))
        );
        let mut named = updates.to_vec();
        named[0].as_object_mut().unwrap().remove("title");
        let parsed = parse_replay(&named).unwrap();
        let SessionBlock::ToolCall { name, .. } = &parsed.turns[0].blocks[0] else {
            panic!("missing call")
        };
        assert_eq!(name, "read_file");
    }

    #[test]
    fn tool_content_extracts_text_and_reports_unrepresentable_blocks() {
        let parsed = parse_replay(&[
            json!({"sessionUpdate":"tool_call","toolCallId":"call","status":"pending","content":[{"type":"content","content":{"type":"text","text":"working"}}]}),
            json!({"sessionUpdate":"tool_call_update","toolCallId":"call","status":"completed","content":[
                {"type":"content","content":{"type":"text","text":"final tool output"}},
                {"type":"content","content":{"type":"image","mimeType":"image/png","data":"aW1hZ2U="}},
                {"type":"content","content":{"type":"resource","resource":{"uri":"notes.txt","text":"resource text"}}},
                {"type":"diff","path":"file.txt","oldText":"old","newText":"new"},
                {"type":"terminal","terminalId":"term-1"}
            ]}),
        ]).unwrap();
        assert_eq!(
            tool_results(&parsed),
            vec![("call", "final tool output\nresource text", false)]
        );
        assert_eq!(parsed.losses[&SessionLossCode::UnsupportedAttachment], 2);
        assert_eq!(parsed.losses[&SessionLossCode::SourceContentTruncated], 2);
        assert!(
            parsed
                .warnings
                .iter()
                .any(|warning| warning.contains("non-text"))
        );
        assert!(
            parsed
                .warnings
                .iter()
                .any(|warning| warning.contains("resource"))
        );
        assert!(
            parsed
                .warnings
                .iter()
                .any(|warning| warning.contains("diff"))
        );
        assert!(
            parsed
                .warnings
                .iter()
                .any(|warning| warning.contains("terminal"))
        );
        assert!(!tool_results(&parsed)[0].1.contains("aW1hZ2U="));
    }

    #[test]
    fn raw_tool_output_does_not_hide_structured_content_losses() {
        let parsed = parse_replay(&[
            json!({"sessionUpdate":"tool_call","toolCallId":"call","status":"completed","rawOutput":"plain result","content":[
                {"type":"content","content":{"type":"image","data":"aW1hZ2U=","mimeType":"image/png"}},
                {"type":"future_block","data":"unmapped"}
            ]}),
        ]).unwrap();
        let results = tool_results(&parsed);
        assert_eq!(results.len(), 1);
        assert_eq!(
            serde_json::from_str::<Value>(results[0].1).unwrap(),
            json!({
                "rawOutput":"plain result","contentText":""
            })
        );
        assert_eq!(parsed.losses[&SessionLossCode::UnsupportedAttachment], 1);
        assert_eq!(parsed.losses[&SessionLossCode::SourceContentTruncated], 1);
        assert_eq!(parsed.warnings.len(), 2);
    }

    #[test]
    fn raw_output_and_text_content_survive_same_or_separate_updates() {
        let raw = json!({"records":[1,2],"contentText":"a distinct raw field"});
        let content =
            json!([{"type":"content","content":{"type":"text","text":"human readable output"}}]);
        let cases = [
            vec![
                json!({"sessionUpdate":"tool_call","toolCallId":"call","status":"completed","rawOutput":raw,"content":content}),
            ],
            vec![
                json!({"sessionUpdate":"tool_call","toolCallId":"call","status":"pending","rawOutput":raw}),
                json!({"sessionUpdate":"tool_call_update","toolCallId":"call","status":"completed","content":content}),
            ],
            vec![
                json!({"sessionUpdate":"tool_call","toolCallId":"call","status":"in_progress","content":content}),
                json!({"sessionUpdate":"tool_call_update","toolCallId":"call","status":"completed","rawOutput":raw}),
            ],
        ];
        for updates in cases {
            let parsed = parse_replay(&updates).unwrap();
            let results = tool_results(&parsed);
            assert_eq!(results.len(), 1);
            assert_eq!(
                serde_json::from_str::<Value>(results[0].1).unwrap(),
                json!({
                    "rawOutput":raw,"contentText":"human readable output"
                })
            );
            assert!(parsed.losses.is_empty());
        }
    }

    #[test]
    fn output_patches_replace_only_their_own_field_and_update_one_final_result() {
        let parsed = parse_replay(&[
            json!({"sessionUpdate":"tool_call","toolCallId":"call","status":"pending","rawOutput":{"version":1},"content":[{"type":"content","content":{"type":"text","text":"first"}}]}),
            json!({"sessionUpdate":"tool_call_update","toolCallId":"call","status":"completed","rawOutput":{"version":2}}),
            json!({"sessionUpdate":"tool_call_update","toolCallId":"call","content":[{"type":"content","content":{"type":"text","text":"latest"}}]}),
            json!({"sessionUpdate":"tool_call_update","toolCallId":"call","status":"completed"}),
        ]).unwrap();
        let results = tool_results(&parsed);
        assert_eq!(results.len(), 1);
        assert_eq!(
            serde_json::from_str::<Value>(results[0].1).unwrap(),
            json!({
                "rawOutput":{"version":2},"contentText":"latest"
            })
        );
        assert_eq!(parsed.events.len(), 2);
        assert_eq!(parsed.events[1].content.as_deref(), Some(results[0].1));
    }

    #[test]
    fn locations_loss_counts_affected_calls_not_repeated_or_replaced_snapshots() {
        let parsed = parse_replay(&[
            json!({"sessionUpdate":"tool_call","toolCallId":"a","status":"pending","locations":[{"path":"a.txt","line":1}]}),
            json!({"sessionUpdate":"tool_call_update","toolCallId":"a","locations":[{"path":"a.txt","line":1}]}),
            json!({"sessionUpdate":"tool_call_update","toolCallId":"a","locations":[{"path":"b.txt","line":20}]}),
            json!({"sessionUpdate":"tool_call_update","toolCallId":"a","locations":[],"status":"completed"}),
            json!({"sessionUpdate":"tool_call","toolCallId":"b","status":"pending","locations":[]}),
            json!({"sessionUpdate":"tool_call_update","toolCallId":"b","locations":[{"path":"c.txt"}],"status":"completed"}),
        ]).unwrap();
        assert_eq!(parsed.losses[&SessionLossCode::SourceContentTruncated], 2);
        assert_eq!(parsed.warnings.len(), 1);
        assert!(parsed.warnings[0].contains("locations"));
        assert_eq!(tool_results(&parsed).len(), 2);
        let empty = parse_replay(&[
            json!({"sessionUpdate":"tool_call","toolCallId":"empty","status":"completed","locations":[]}),
        ]).unwrap();
        assert!(empty.losses.is_empty());
        assert!(parse_replay(&[
            json!({"sessionUpdate":"tool_call","toolCallId":"bad","locations":{"path":"wrong-shape"}}),
        ]).is_err());
    }

    #[test]
    fn session_info_preserves_supported_metadata_and_reports_unmapped_fields() {
        let parsed = parse_replay(&[
            json!({"sessionUpdate":"session_info_update","title":"old title","updatedAt":"2026-09-20T01:00:00Z"}),
            json!({"sessionUpdate":"session_info_update","title":"latest title","futureMetadata":{"value":"not mapped"}}),
            json!({"sessionUpdate":"session_info_update","title":null}),
        ]).unwrap();
        assert_eq!(parsed.title, Some(None));
        assert_eq!(
            parsed.updated_at.unwrap().unwrap().to_rfc3339(),
            "2026-09-20T01:00:00+00:00"
        );
        assert_eq!(parsed.losses[&SessionLossCode::SourceContentTruncated], 1);
        assert!(parsed.warnings[0].contains("metadata"));
        assert!(
            parse_replay(&[json!({"sessionUpdate":"session_info_update","title":123})]).is_err()
        );
        assert!(
            parse_replay(&[json!({"sessionUpdate":"session_info_update","updatedAt":"invalid"})])
                .is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn fake_stdio_server_lists_and_loads_native_history_without_resume() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let script = dir.path().join("agy_acp_server.par");
        let body = format!(
            r#"#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *\"method\":\"initialize\"*)
      printf '%s\n' '{{"jsonrpc":"2.0","id":1,"result":{{"protocolVersion":1,"agentCapabilities":{{"loadSession":true,"sessionCapabilities":{{"list":{{}}}}}}}}}}'
      ;;
    *\"method\":\"session/list\"*)
      printf '%s\n' '{{"jsonrpc":"2.0","id":2,"result":{{"sessions":[{{"cwd":"{}","title":"Missing ID"}},{{"sessionId":"opaque://missing-cwd","title":"Missing cwd"}},{{"sessionId":"opaque://native-1","cwd":"{}","title":"Native"}}]}}}}'
      ;;
    *\"method\":\"session/load\"*)
      printf '%s\n' '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"opaque://native-1","update":{{"sessionUpdate":"user_message_chunk","content":{{"type":"text","text":"original"}}}}}}}}'
      printf '%s\n' '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"opaque://native-1","update":{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":"answer sk-abcdefghijklmnop"}}}}}}}}'
      printf '%s\n' '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"opaque://native-1","update":{{"sessionUpdate":"session_info_update","title":"updated native sk-abcdefghijklmnop","updatedAt":"2026-09-20T01:00:00Z"}}}}}}'
      printf '%s\n' '{{"jsonrpc":"2.0","id":2,"result":null}}'
      ;;
  esac
done
"#,
            workspace.display(),
            workspace.display()
        );
        fs::write(&script, &body).unwrap();
        let mut permissions = fs::metadata(&script).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&script, permissions).unwrap();

        let provider = AntigravityProvider {
            executable: Some(script),
        };
        let listing = provider.list_sessions_detailed(&workspace).unwrap();
        assert!(listing.incomplete);
        assert_eq!(listing.sessions.len(), 1);
        assert_eq!(listing.sessions[0].native_ref, "opaque://native-1");
        let events = provider.read_events("opaque://native-1", None, 10).unwrap();
        assert_eq!(events.events.len(), 2);
        assert_eq!(events.events[0].content.as_deref(), Some("original"));
        assert_eq!(
            provider
                .verified_control_workspace("opaque://native-1")
                .unwrap()
                .unwrap(),
            fs::canonicalize(&workspace).unwrap()
        );
        let source = ConversationSessionSummary {
            id: "stored".into(),
            workspace_id: "workspace".into(),
            agent: AgentKind::Antigravity,
            title: Some(format!("history in {}", dir.path().display())),
            origin: SessionOrigin::Interactive,
            spawned_by_session_id: None,
            forked_from_session_id: None,
            created_at: None,
            updated_at: None,
            message_count: None,
            git_branch: None,
            archived: false,
            sidechain: false,
            availability: SessionAvailability::Readable,
        };
        let document = provider
            .read_session_document(&source, "opaque://native-1", Some(dir.path()))
            .unwrap();
        assert!(document.redaction_count >= 2);
        assert!(
            document
                .source
                .title
                .as_deref()
                .unwrap()
                .starts_with("updated native")
        );
        assert_eq!(
            document.source.updated_at.unwrap().to_rfc3339(),
            "2026-09-20T01:00:00+00:00"
        );
        let serialized = serde_json::to_string(&document).unwrap();
        assert!(!serialized.contains("sk-abcdefghijklmnop"));
        assert!(!serialized.contains(dir.path().to_str().unwrap()));

        let cleared_body = body.replace(
            "\"title\":\"updated native sk-abcdefghijklmnop\",\"updatedAt\":\"2026-09-20T01:00:00Z\"",
            "\"title\":null,\"updatedAt\":null",
        );
        assert_ne!(cleared_body, body);
        fs::write(provider.executable.as_ref().unwrap(), cleared_body).unwrap();
        let mut old_source = source;
        old_source.updated_at = document.source.updated_at;
        let cleared = provider
            .read_session_document(&old_source, "opaque://native-1", None)
            .unwrap();
        assert_eq!(cleared.source.title, None);
        assert_eq!(cleared.source.updated_at, None);

        // Metadata listing does not require load. Reading history does, and
        // each operation reports only its own missing negotiated capability.
        let list_only = body.replace("\"loadSession\":true", "\"loadSession\":false");
        fs::write(provider.executable.as_ref().unwrap(), list_only).unwrap();
        assert_eq!(
            provider
                .list_sessions(&dir.path().join("workspace"))
                .unwrap()
                .len(),
            1
        );
        let error = provider
            .read_events("opaque://native-1", None, 10)
            .unwrap_err();
        assert!(error.to_string().contains("does not support session/load"));

        let load_only = body.replace("\"list\":{}", "");
        fs::write(provider.executable.as_ref().unwrap(), load_only).unwrap();
        let error = provider
            .list_sessions(&dir.path().join("workspace"))
            .unwrap_err();
        assert!(error.to_string().contains("does not support session/list"));

        let invalid_cursor = body.replace("\"sessions\":[", "\"nextCursor\":123,\"sessions\":[");
        assert_ne!(invalid_cursor, body);
        fs::write(provider.executable.as_ref().unwrap(), invalid_cursor).unwrap();
        let error = provider.list_sessions(&workspace).unwrap_err();
        assert!(error.to_string().contains("invalid nextCursor"));
    }
}
