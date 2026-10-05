//! Read-only OpenClaw 2026.9.6 (agent schema 23) source adapter.
//! Bodies come from raw events; the official, fully caught-up projection chooses
//! the active branch. Derived summaries and adjacent JSONL are never substitutes.
use super::*;
use anyhow::ensure;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use sha2::{Digest, Sha256};
use std::time::Duration;

const MAX_ROWS: usize = 100_000;
const MAX_EVENT_BYTES: usize = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 64 * 1024 * 1024;
const MAX_LIST: usize = 2_000;

pub(super) fn authority_exists(path: &Path) -> bool {
    ["", "-wal", "-shm", "-journal"].iter().any(|suffix| {
        !matches!(fs::symlink_metadata(PathBuf::from(format!("{}{suffix}", path.display()))), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
    })
}

fn open(path: &Path) -> Result<Connection> {
    for ancestor in path.ancestors().take(5) {
        ensure!(
            platform_path::is_safe_scan_entry(ancestor),
            "Unsafe OpenClaw SQLite path"
        );
    }
    ensure!(
        fs::symlink_metadata(path)?.is_file(),
        "OpenClaw SQLite is not a regular file"
    );
    for suffix in ["-wal", "-shm", "-journal"] {
        let companion = PathBuf::from(format!("{}{suffix}", path.display()));
        match fs::symlink_metadata(&companion) {
            Ok(metadata) => ensure!(
                metadata.is_file() && platform_path::is_safe_scan_entry(&companion),
                "Unsafe OpenClaw SQLite sidecar"
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    connection.busy_timeout(Duration::from_millis(100))?;
    connection
        .execute_batch("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; BEGIN DEFERRED")?;
    let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    ensure!(
        version == 23,
        "Unsupported OpenClaw SQLite schema (expected 23)"
    );
    let expected_agent = path
        .parent()
        .and_then(Path::parent)
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
        .context("Invalid OpenClaw database agent path")?;
    let owner: (String, i64, Option<String>, Option<String>) = connection.query_row(
        "SELECT role,schema_version,agent_id,app_version FROM schema_meta WHERE meta_key='primary'",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;
    ensure!(
        owner.0 == "agent"
            && owner.1 == 23
            && owner.2.as_deref() == Some(expected_agent)
            && owner.3.as_deref() == Some("2026.9.6"),
        "Unsupported OpenClaw database version or agent ownership"
    );
    // A deferred read transaction includes committed WAL data and pins headers,
    // ownership, projection and payloads to the same snapshot.
    Ok(connection)
}

fn bounded_json(connection: &Connection, sql: &str, id: &str) -> Result<Value> {
    let (size, text): (i64, Option<String>) =
        connection.query_row(sql, [id], |row| Ok((row.get(0)?, row.get(1)?)))?;
    ensure!(
        (1..=MAX_EVENT_BYTES as i64).contains(&size),
        "OpenClaw event exceeds read limit"
    );
    Ok(serde_json::from_str(&text.context(
        "OpenClaw compressed event requires an unavailable decoder",
    )?)?)
}

fn header(connection: &Connection, id: &str) -> Result<Value> {
    let value = bounded_json(
        connection,
        "SELECT COALESCE(length(CAST(event_json AS BLOB)), event_utf8_bytes, 0), CASE WHEN length(CAST(event_json AS BLOB)) <= 4194304 THEN event_json END FROM transcript_events WHERE session_id = ?1 ORDER BY seq LIMIT 1",
        id,
    )?;
    ensure!(
        value.get("type").and_then(Value::as_str) == Some("session")
            && value.get("version").and_then(Value::as_u64) == Some(4)
            && value.get("id").and_then(Value::as_str) == Some(id),
        "Unknown or mismatched OpenClaw transcript header"
    );
    ensure!(
        value.get("parentSession").is_none_or(Value::is_null),
        "OpenClaw external parent-session lineage is not fully available"
    );
    Ok(value)
}

fn workspace(header: &Value) -> Result<PathBuf> {
    let cwd = PathBuf::from(
        header
            .get("cwd")
            .and_then(Value::as_str)
            .context("OpenClaw transcript has no workspace")?,
    );
    ensure!(cwd.is_absolute(), "OpenClaw workspace must be absolute");
    Ok(cwd)
}

pub(super) fn collect(
    home: &Path,
    agent: &str,
    path: &Path,
    wanted: Option<&Path>,
) -> Result<(Vec<Session>, bool)> {
    let connection = open(path)?;
    let mut statement = connection.prepare("SELECT w.session_id, w.created_at, COALESCE(w.transcript_updated_at,w.updated_at), substr(w.display_name,1,1024), n.entry_valid, (n.archived_at IS NOT NULL OR n.current_session_id!=w.session_id) FROM session_windows w JOIN session_nodes n ON n.session_key=w.session_key ORDER BY w.updated_at DESC,w.session_id DESC LIMIT 2001")?;
    let mut rows = statement.query([])?;
    let mut sessions = Vec::new();
    let mut count = 0;
    let mut incomplete = false;
    while let Some(row) = rows.next()? {
        count += 1;
        if count > MAX_LIST {
            incomplete = true;
            break;
        }
        let id: String = row.get(0)?;
        if id.len() > 4096 || row.get::<_, i64>(4)? != 1 {
            incomplete = true;
            continue;
        }
        let (header, cwd) =
            match header(&connection, &id).and_then(|value| Ok((workspace(&value)?, value))) {
                Ok((cwd, header)) => (header, cwd),
                Err(_) => {
                    incomplete = true;
                    continue;
                }
            };
        if wanted.is_some_and(|wanted| !belongs_to_workspace(&cwd, wanted)) {
            continue;
        }
        let native_ref = stable_native_ref(
            "openclaw-sqlite-v23",
            &[
                home.to_string_lossy().as_ref(),
                agent,
                &id,
                cwd.to_string_lossy().as_ref(),
            ],
        );
        let name: Option<String> = row.get(3)?;
        sessions.push(Session {
            native_ref,
            transcript: path.to_path_buf(),
            sqlite_id: Some(id),
            archived: row.get(5)?,
            cwd,
            title: name
                .as_deref()
                .and_then(|name| crate::sanitize_title(Some(name))),
            created_at: header
                .get("timestamp")
                .and_then(crate::parse_json_timestamp)
                .or_else(|| DateTime::from_timestamp_millis(row.get(1).unwrap_or(0))),
            updated_at: DateTime::from_timestamp_millis(row.get(2)?),
        });
    }
    Ok((sessions, incomplete))
}

struct Snapshot {
    events: Vec<(i64, Value)>,
    fingerprint: String,
}

fn snapshot(path: &Path, id: &str, expected_workspace: &Path) -> Result<Snapshot> {
    let connection = open(path)?;
    let header = header(&connection, id)?;
    ensure!(
        platform_path::equivalent(&workspace(&header)?, expected_workspace),
        "OpenClaw workspace changed while reading history"
    );
    let ownership: (String, i64, Option<String>, Option<String>, String) = connection.query_row(
        "SELECT n.entry_json, w.acp_owned, w.plugin_owner_id, w.agent_harness_id, w.session_scope FROM session_windows w JOIN session_nodes n ON n.session_key=w.session_key WHERE w.session_id=?1 AND n.entry_valid=1 AND length(CAST(n.entry_json AS BLOB))<=4194304", [id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?)))?;
    let entry: Value = serde_json::from_str(&ownership.0)?;
    ensure!(
        ownership.1 == 0
            && ownership.2.is_none()
            && ownership.3.as_deref().is_none_or(|value| value == "pi")
            && ownership.4 == "conversation",
        "OpenClaw externally owned/shared transcript is not a complete local source"
    );
    for key in [
        "acp",
        "cliSessionIds",
        "claudeCliSessionId",
        "codexCliSessionId",
    ] {
        ensure!(
            entry.get(key).is_none_or(Value::is_null),
            "OpenClaw external CLI history is not a complete local source"
        );
    }
    let cold: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM session_transcript_cold_archives WHERE session_id=?1)",
        [id],
        |row| row.get(0),
    )?;
    ensure!(
        !cold,
        "OpenClaw transcript is in cold storage; restore it in OpenClaw first"
    );
    let (indexed, rebuild, count, message_count, generation): (i64,i64,i64,i64,String) = connection.query_row(
        "SELECT s.indexed_seq,s.needs_rebuild,s.active_event_count,s.active_message_count,r.generation FROM session_transcript_index_state s JOIN transcript_rewrite_watermarks r ON r.session_id=s.session_id WHERE s.session_id=?1",[id],|row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?)))?;
    let latest: i64 = connection.query_row(
        "SELECT max(seq) FROM transcript_events WHERE session_id=?1",
        [id],
        |row| row.get(0),
    )?;
    ensure!(
        rebuild == 0 && indexed == latest && (0..=MAX_ROWS as i64).contains(&count),
        "OpenClaw active projection is stale or exceeds read limit"
    );
    let mut statement = connection.prepare("SELECT a.active_position,a.message_position,a.context_eligible,e.seq,COALESCE(length(CAST(e.event_json AS BLOB)), e.event_utf8_bytes,0),CASE WHEN length(CAST(e.event_json AS BLOB))<=4194304 THEN e.event_json END FROM session_transcript_active_events a JOIN transcript_events e ON e.session_id=a.session_id AND e.seq=a.event_seq WHERE a.session_id=?1 ORDER BY a.active_position LIMIT 100001")?;
    let mut rows = statement.query([id])?;
    let mut events = Vec::new();
    let mut bytes = 0usize;
    let mut messages = 0i64;
    let mut hash = Sha256::new();
    hash.update(id.as_bytes());
    hash.update(generation.as_bytes());
    hash.update(header.to_string().as_bytes());
    let mut ids = BTreeSet::new();
    while let Some(row) = rows.next()? {
        ensure!(
            events.len() < MAX_ROWS && row.get::<_, i64>(0)? == events.len() as i64,
            "OpenClaw active projection has gaps or exceeds limit"
        );
        let eligibility: Option<i64> = row.get(2)?;
        ensure!(
            matches!(eligibility, Some(0 | 1)),
            "OpenClaw projection needs classification"
        );
        let size: i64 = row.get(4)?;
        ensure!(
            (1..=MAX_EVENT_BYTES as i64).contains(&size),
            "OpenClaw event exceeds read limit"
        );
        bytes = bytes
            .checked_add(size as usize)
            .context("OpenClaw history size overflow")?;
        ensure!(
            bytes <= MAX_TOTAL_BYTES,
            "OpenClaw history exceeds bounded source read limit"
        );
        let text: Option<String> = row.get(5)?;
        let text = text.context("OpenClaw compressed event requires an unavailable decoder")?;
        let event: Value = serde_json::from_str(&text)?;
        let expected_eligibility = if event
            .pointer("/message/excludeFromContext")
            .and_then(Value::as_bool)
            == Some(true)
        {
            0
        } else {
            1
        };
        ensure!(
            eligibility == Some(expected_eligibility),
            "OpenClaw projection context eligibility differs from original event"
        );
        let kind = event
            .get("type")
            .and_then(Value::as_str)
            .context("Unknown OpenClaw event type")?;
        ensure!(
            matches!(
                kind,
                "message"
                    | "model_change"
                    | "thinking_level_change"
                    | "compaction"
                    | "reset"
                    | "custom"
                    | "session_info"
                    | "label"
            ),
            "Unsupported OpenClaw event: {kind}"
        );
        let event_id = event
            .get("id")
            .and_then(Value::as_str)
            .context("OpenClaw event identity is absent")?;
        ensure!(
            ids.insert(event_id.to_owned()),
            "Duplicate OpenClaw active event identity"
        );
        let message_position: Option<i64> = row.get(1)?;
        if kind == "message" {
            ensure!(
                message_position == Some(messages),
                "OpenClaw message projection has gaps"
            );
            messages += 1;
        } else {
            ensure!(
                message_position.is_none(),
                "OpenClaw non-message has a message position"
            );
        }
        let seq: i64 = row.get(3)?;
        hash.update(seq.to_le_bytes());
        hash.update(text.as_bytes());
        events.push((seq, event));
    }
    ensure!(
        events.len() as i64 == count && messages == message_count,
        "OpenClaw active projection is incomplete"
    );
    // A compaction retains originals on its active path. It is metadata, never a
    // replacement for missing ancestors or a synthetic assistant response.
    for (position, (_, event)) in events.iter().enumerate() {
        if event.get("type").and_then(Value::as_str) == Some("compaction") {
            let kept = event
                .get("firstKeptEntryId")
                .and_then(Value::as_str)
                .context("OpenClaw compaction has no retained-history identity")?;
            ensure!(
                events[..position]
                    .iter()
                    .any(|(_, prior)| prior.get("id").and_then(Value::as_str) == Some(kept))
                    && event.get("parentId").is_some_and(Value::is_string),
                "OpenClaw compaction originals are not completely available"
            );
        }
        if let Some(parent) = event.get("parentId").and_then(Value::as_str)
            && !ids.contains(parent)
        {
            // Leaf controls are not projected. Verify that they resolve to an
            // ancestor in the same raw session; arbitrary missing parents fail.
            let control: Option<String> = connection.query_row("SELECT event_json FROM transcript_events WHERE session_id=?1 AND json_extract(event_json,'$.id')=?2 AND json_extract(event_json,'$.type')='leaf' LIMIT 1",rusqlite::params![id,parent],|row|row.get(0)).optional()?;
            let control: Value = serde_json::from_str(
                &control.context("OpenClaw active history has a missing ancestor")?,
            )?;
            ensure!(
                control
                    .get("targetId")
                    .is_some_and(|target| target.is_null()
                        || target.as_str().is_some_and(|target| ids.contains(target))),
                "OpenClaw leaf target is outside available history"
            );
        }
    }
    Ok(Snapshot {
        events,
        fingerprint: hex::encode(hash.finalize()),
    })
}

fn current_window(events: &[(i64, Value)]) -> Result<Vec<&(i64, Value)>> {
    let Some(reset) = events
        .iter()
        .rposition(|(_, event)| event.get("type").and_then(Value::as_str) == Some("reset"))
    else {
        return Ok(events.iter().collect());
    };
    let mut selected = Vec::new();
    if let Some(first) = events[reset]
        .1
        .get("firstKeptEntryId")
        .and_then(Value::as_str)
    {
        let start = events[..reset]
            .iter()
            .position(|(_, event)| event.get("id").and_then(Value::as_str) == Some(first))
            .context("OpenClaw reset retained history is missing")?;
        for item in &events[start..reset] {
            if item.1.get("type").and_then(Value::as_str) != Some("message") {
                continue;
            }
            let role = item.1.pointer("/message/role").and_then(Value::as_str);
            // Official history's retained prefix exposes user/assistant records.
            // Tool-bearing retained tails require pairing repair; fail closed.
            ensure!(
                matches!(role, Some("user" | "assistant"))
                    && !item
                        .1
                        .pointer("/message/content")
                        .and_then(Value::as_array)
                        .is_some_and(|parts| parts
                            .iter()
                            .any(
                                |part| part.get("type").and_then(Value::as_str) == Some("toolCall")
                            )),
                "OpenClaw reset retained tool history needs pairing verification"
            );
            selected.push(item);
        }
    }
    selected.extend(events[reset + 1..].iter());
    Ok(selected)
}

pub(super) fn read_turns(
    path: &Path,
    id: &str,
    expected_workspace: &Path,
) -> Result<(crate::hermes::OriginalTurns, String)> {
    parse_turns(path, id, expected_workspace, true)
}

fn parse_turns(
    path: &Path,
    id: &str,
    expected_workspace: &Path,
    for_handoff: bool,
) -> Result<(crate::hermes::OriginalTurns, String)> {
    let snapshot = snapshot(path, id, expected_workspace)?;
    let mut parsed = crate::hermes::OriginalTurns::default();
    let selected = current_window(&snapshot.events)?;
    let omitted = snapshot
        .events
        .iter()
        .filter(|(_, event)| event.get("type").and_then(Value::as_str) == Some("message"))
        .count()
        - selected
            .iter()
            .filter(|(_, event)| event.get("type").and_then(Value::as_str) == Some("message"))
            .count();
    if omitted > 0 {
        parsed
            .losses
            .insert(crate::SessionLossCode::SourceContentTruncated, omitted);
    }
    for (seq, event) in selected {
        if event.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let message = event
            .get("message")
            .context("OpenClaw message payload absent")?;
        ensure!(
            !for_handoff
                || message.get("excludeFromContext").and_then(Value::as_bool) != Some(true),
            "OpenClaw display-only message cannot be promoted into imported model context"
        );
        let previous = parsed.turns.len();
        parsed.push_message(
            *seq as usize,
            message,
            message.get("role").and_then(Value::as_str),
            event.get("timestamp"),
        )?;
        if parsed.turns.len() > previous {
            parsed.turns[previous].id = format!("openclaw-{seq}");
        }
    }
    parsed.ensure_readable()?;
    Ok((parsed, snapshot.fingerprint))
}

pub(super) fn read_events(
    path: &Path,
    id: &str,
    cursor: Option<&str>,
    limit: usize,
    expected_workspace: &Path,
) -> Result<ConversationEventPage> {
    let (parsed, fingerprint) = parse_turns(path, id, expected_workspace, false)?;
    let boundary = match cursor {
        None => None,
        Some(cursor) => {
            let (hash, offset) = cursor
                .split_once(':')
                .context("Invalid OpenClaw SQLite cursor")?;
            ensure!(
                hash == fingerprint,
                "OpenClaw history changed; reload the first page"
            );
            Some(offset.parse::<usize>()?)
        }
    };
    let mut events = Vec::new();
    for turn in parsed.turns {
        for (index, block) in turn.blocks.into_iter().enumerate() {
            let (kind, content, tool_name, tool_status, attachment_count) = match block {
                crate::SessionBlock::Text { text } => (
                    if turn.role == crate::SessionRole::User {
                        crate::ConversationEventKind::UserMessage
                    } else {
                        crate::ConversationEventKind::AgentMessage
                    },
                    Some(text),
                    None,
                    None,
                    0,
                ),
                crate::SessionBlock::ToolCall { name, input, .. } => (
                    crate::ConversationEventKind::ToolSummary,
                    Some(input),
                    Some(name),
                    Some("called".into()),
                    0,
                ),
                crate::SessionBlock::ToolResult {
                    output, is_error, ..
                } => (
                    crate::ConversationEventKind::ToolSummary,
                    Some(output),
                    None,
                    Some(if is_error { "error" } else { "completed" }.into()),
                    0,
                ),
                crate::SessionBlock::Attachment { .. } => (
                    if turn.role == crate::SessionRole::User {
                        crate::ConversationEventKind::UserMessage
                    } else {
                        crate::ConversationEventKind::AgentMessage
                    },
                    None,
                    None,
                    None,
                    1,
                ),
            };
            let truncated = content
                .as_ref()
                .is_some_and(|text| text.len() > crate::MAX_MESSAGE_BYTES);
            events.push(crate::ConversationEvent {
                id: format!("{}:{index}", turn.id),
                kind,
                turn_id: Some(turn.id.clone()),
                message_phase: None,
                timestamp: turn.timestamp,
                content: content
                    .map(|text| crate::truncate_utf8(&text, crate::MAX_MESSAGE_BYTES).0),
                tool_name,
                tool_status,
                duration_ms: None,
                attachment_count,
                truncated,
            });
        }
    }
    let end = boundary.unwrap_or(events.len());
    ensure!(end <= events.len(), "OpenClaw history offset out of range");
    let mut start = end;
    let mut bytes = 0;
    while start > 0 && end - start < limit.clamp(1, 200) {
        let size = events[start - 1].content.as_ref().map_or(0, String::len);
        if start < end && bytes + size > crate::MAX_PAGE_BYTES {
            break;
        }
        bytes += size;
        start -= 1;
    }
    // Provider pages load newest-first; each returned page remains chronological.
    let page = events.into_iter().skip(start).take(end - start).collect();
    Ok(ConversationEventPage {
        events: page,
        next_cursor: (start > 0).then(|| format!("{fingerprint}:{start}")),
        warnings: parsed
            .losses
            .into_iter()
            .map(|(code, count)| format!("Source conversion: {code:?} ({count})"))
            .collect(),
    })
}

#[cfg(test)]
pub(super) fn matrix_document() -> crate::SessionDocument {
    let (dir, path, connection) = tests::fixture();
    tests::append(
        &connection,
        1,
        tests::message(
            "u",
            None,
            "user",
            &format!(
                "MATRIX-OPENCLAW {} API_KEY=matrix-secret",
                uuid::Uuid::new_v4()
            ),
        ),
        true,
    );
    tests::append(
        &connection,
        2,
        tests::message("discarded", Some("u"), "assistant", "ABANDONED-BRANCH"),
        false,
    );
    tests::append(
        &connection,
        3,
        tests::message(
            "a",
            Some("u"),
            "assistant",
            &format!(
                "Decision: project uses storage namespace {}.",
                uuid::Uuid::new_v4()
            ),
        ),
        true,
    );
    let before_read = fs::read(&path).unwrap();
    let provider = OpenClawProvider::with_home(dir.path().into());
    let sessions = provider
        .list_sessions(&dir.path().join("workspace"))
        .unwrap();
    let document = provider
        .read_session_document(
            &crate::hermes::fixture_source(agentkib_core::AgentKind::OpenClaw),
            &sessions[0].native_ref,
            None,
        )
        .unwrap();
    assert_eq!(fs::read(&path).unwrap(), before_read);
    if let Some(output) = std::env::var_os("AGENTKIB_LIVE_FIXTURE_DIR") {
        use sha2::{Digest, Sha256};
        let output = PathBuf::from(output).join("openclaw");
        fs::create_dir_all(&output).unwrap();
        drop(connection);
        let bytes = fs::read(&path).unwrap();
        fs::write(output.join("source.sqlite"), &bytes).unwrap();
        fs::write(
            output.join("source.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "source_agent":"openclaw", "source_schema":23,
                "source_sha256":hex::encode(Sha256::digest(&bytes)),
                "source_workspace":dir.path().join("workspace"),
                "original_source_path":path
            }))
            .unwrap(),
        )
        .unwrap();
        let _retained_source = dir.keep();
    }
    document
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    fn read_turns(path: &Path, id: &str) -> Result<(crate::hermes::OriginalTurns, String)> {
        super::read_turns(
            path,
            id,
            &path.ancestors().nth(4).unwrap().join("workspace"),
        )
    }
    fn read_events(
        path: &Path,
        id: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<ConversationEventPage> {
        super::read_events(
            path,
            id,
            cursor,
            limit,
            &path.ancestors().nth(4).unwrap().join("workspace"),
        )
    }
    pub(super) fn fixture() -> (TempDir, PathBuf, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agents/main/agent/openclaw-agent.sqlite");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::create_dir_all(dir.path().join("workspace")).unwrap();
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(include_str!("../tests/fixtures/openclaw-schema-23.sql"))
            .unwrap();
        connection.execute("INSERT INTO session_nodes(session_key,current_session_id,entry_json,entry_valid,updated_at) VALUES('agent:main:test','session','{}',1,100)",[]).unwrap();
        connection.execute("INSERT INTO session_windows(session_id,session_key,created_at,updated_at) VALUES('session','agent:main:test',100,100)",[]).unwrap();
        connection
            .execute(
                "INSERT INTO transcript_rewrite_watermarks VALUES('session','generation',100)",
                [],
            )
            .unwrap();
        connection.execute("INSERT INTO session_transcript_index_state(session_id,indexed_seq,active_event_count,active_message_count,updated_at) VALUES('session',0,0,0,100)",[]).unwrap();
        let header = json!({"type":"session","version":4,"id":"session","cwd":dir.path().join("workspace"),"timestamp":"2026-09-27T00:00:00Z"});
        connection.execute("INSERT INTO transcript_events(session_id,seq,event_json,created_at) VALUES('session',0,?1,100)",[header.to_string()]).unwrap();
        (dir, path, connection)
    }
    pub(super) fn append(connection: &Connection, seq: i64, event: Value, active: bool) {
        connection.execute("INSERT INTO transcript_events(session_id,seq,event_json,created_at) VALUES('session',?1,?2,100)",rusqlite::params![seq,event.to_string()]).unwrap();
        if active {
            let (position,message): (i64,i64)=connection.query_row("SELECT active_event_count,active_message_count FROM session_transcript_index_state",[],|row|Ok((row.get(0)?,row.get(1)?))).unwrap();
            let is_message = event["type"] == "message";
            connection
                .execute(
                    "INSERT INTO session_transcript_active_events VALUES('session',?1,?2,?3,1)",
                    rusqlite::params![position, seq, is_message.then_some(message)],
                )
                .unwrap();
            connection.execute("UPDATE session_transcript_index_state SET active_event_count=active_event_count+1,active_message_count=active_message_count+?1",[i64::from(is_message)]).unwrap();
        }
        connection
            .execute(
                "UPDATE session_transcript_index_state SET indexed_seq=?1",
                [seq],
            )
            .unwrap();
    }
    pub(super) fn message(id: &str, parent: Option<&str>, role: &str, text: &str) -> Value {
        json!({"type":"message","id":id,"parentId":parent,"message":{"role":role,"content":[{"type":"text","text":text}]}})
    }
    fn text(parsed: &crate::hermes::OriginalTurns) -> Vec<String> {
        parsed
            .turns
            .iter()
            .flat_map(|turn| turn.blocks.iter())
            .filter_map(|block| {
                if let crate::SessionBlock::Text { text } = block {
                    Some(text.clone())
                } else {
                    None
                }
            })
            .collect()
    }

    #[test]
    fn authoritative_sqlite_wal_selects_active_branch_and_preserves_tools() {
        let (dir, path, connection) = fixture();
        connection.execute_batch("PRAGMA journal_mode=WAL").unwrap();
        append(
            &connection,
            1,
            message("u", None, "user", "actual SQLite question"),
            true,
        );
        append(
            &connection,
            2,
            message("old", Some("u"), "assistant", "abandoned branch"),
            false,
        );
        append(
            &connection,
            3,
            json!({"type":"message","id":"call","parentId":"u","message":{"role":"assistant","content":[{"type":"toolCall","id":"t1","name":"read","arguments":{"file":"source"}}]}}),
            true,
        );
        append(
            &connection,
            4,
            json!({"type":"message","id":"result","parentId":"call","message":{"role":"toolResult","toolCallId":"t1","content":[{"type":"text","text":"actual tool result"}]}}),
            true,
        );
        append(
            &connection,
            5,
            message("a", Some("result"), "assistant", "current branch"),
            true,
        );
        let (parsed, _) = read_turns(&path, "session").unwrap();
        assert_eq!(
            text(&parsed),
            vec!["actual SQLite question", "current branch"]
        );
        assert!(
            matches!(&parsed.turns[2].blocks[0],crate::SessionBlock::ToolResult{call_id,output,..} if call_id=="t1" && output=="actual tool result")
        );
        let legacy = dir.path().join("agents/main/sessions/stale.jsonl");
        fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        fs::write(
            legacy,
            format!(
                "{}\n{}",
                json!({"type":"session","id":"stale","cwd":dir.path().join("workspace")}),
                message("wrong", None, "user", "stale private content")
            ),
        )
        .unwrap();
        let sessions = OpenClawProvider::with_home(dir.path().into())
            .list_sessions(&dir.path().join("workspace"))
            .unwrap();
        assert_eq!(sessions.len(), 1);
        let page = OpenClawProvider::with_home(dir.path().into())
            .read_events(&sessions[0].native_ref, None, 200)
            .unwrap();
        assert!(
            page.events
                .iter()
                .any(|e| e.content.as_deref() == Some("actual tool result"))
        );
        assert!(
            !page
                .events
                .iter()
                .any(|e| e.content.as_deref() == Some("stale private content"))
        );
    }

    #[test]
    fn reset_scope_does_not_resurrect_old_window_and_compaction_keeps_originals() {
        let (_dir, path, c) = fixture();
        append(&c, 1, message("old", None, "user", "old secret"), true);
        append(
            &c,
            2,
            json!({"type":"reset","id":"reset","parentId":"old"}),
            true,
        );
        append(
            &c,
            3,
            message("new", Some("reset"), "user", "new question"),
            true,
        );
        append(
            &c,
            4,
            json!({"type":"compaction","id":"compact","parentId":"new","firstKeptEntryId":"new","summary":"not original text"}),
            true,
        );
        append(
            &c,
            5,
            message("a", Some("compact"), "assistant", "new answer"),
            true,
        );
        let parsed = read_turns(&path, "session").unwrap().0;
        assert_eq!(text(&parsed), vec!["new question", "new answer"]);
        assert_eq!(
            parsed
                .losses
                .get(&crate::SessionLossCode::SourceContentTruncated),
            Some(&1)
        );
    }

    #[test]
    fn cursor_rejects_rewrite_and_cross_session_and_limits_page() {
        let (_dir, path, c) = fixture();
        append(&c, 1, message("u", None, "user", "one"), true);
        append(&c, 2, message("a", Some("u"), "assistant", "two"), true);
        let first = read_events(&path, "session", None, 1).unwrap();
        assert_eq!(first.events.len(), 1);
        assert_eq!(first.events[0].content.as_deref(), Some("two"));
        let cursor = first.next_cursor.unwrap();
        assert_eq!(
            read_events(&path, "session", Some(&cursor), 1)
                .unwrap()
                .events[0]
                .content
                .as_deref(),
            Some("one")
        );
        c.execute(
            "UPDATE transcript_rewrite_watermarks SET generation='new'",
            [],
        )
        .unwrap();
        assert!(
            read_events(&path, "session", Some(&cursor), 1)
                .unwrap_err()
                .to_string()
                .contains("changed")
        );
    }

    #[test]
    fn rejects_unknown_schema_stale_projection_compression_and_cold_store() {
        let (_dir, path, c) = fixture();
        append(&c, 1, message("u", None, "user", "one"), true);
        c.execute_batch("PRAGMA user_version=24").unwrap();
        assert!(read_turns(&path, "session").is_err());
        c.execute_batch("PRAGMA user_version=23").unwrap();
        c.execute(
            "UPDATE session_transcript_index_state SET needs_rebuild=1",
            [],
        )
        .unwrap();
        assert!(read_turns(&path, "session").is_err());
        c.execute(
            "UPDATE session_transcript_index_state SET needs_rebuild=0",
            [],
        )
        .unwrap();
        c.execute("UPDATE transcript_events SET event_zstd=X'01',event_json=NULL,event_utf8_bytes=1,navigation_json='{}' WHERE seq=1",[]).unwrap();
        assert!(read_turns(&path, "session").is_err());
        c.execute("UPDATE transcript_events SET event_zstd=NULL,event_json=?1,event_utf8_bytes=NULL,navigation_json=NULL WHERE seq=1",[message("u",None,"user","one").to_string()]).unwrap();
        c.execute("INSERT INTO session_transcript_cold_archives VALUES('session','generation','history.zst',?1,2,100,10,1,100,'file',NULL)",["0".repeat(64)]).unwrap();
        assert!(
            read_turns(&path, "session")
                .err()
                .unwrap()
                .to_string()
                .contains("cold storage")
        );
        c.execute("DELETE FROM session_transcript_cold_archives", [])
            .unwrap();
        c.execute(
            "UPDATE transcript_events SET event_json=?1 WHERE seq=1",
            [message("u", None, "user", &"x".repeat(MAX_EVENT_BYTES)).to_string()],
        )
        .unwrap();
        assert!(
            read_turns(&path, "session")
                .err()
                .unwrap()
                .to_string()
                .contains("read limit")
        );
    }

    #[test]
    fn workspace_unknown_store_and_locks_do_not_fall_back_to_jsonl() {
        let (dir, path, c) = fixture();
        append(&c, 1, message("u", None, "user", "one"), true);
        assert!(
            OpenClawProvider::with_home(dir.path().into())
                .list_sessions(Path::new("/wrong-workspace"))
                .unwrap()
                .is_empty()
        );
        c.execute_batch("BEGIN EXCLUSIVE").unwrap();
        let start = std::time::Instant::now();
        let listing = OpenClawProvider::with_home(dir.path().into())
            .list_sessions_detailed(&dir.path().join("workspace"))
            .unwrap();
        assert!(listing.incomplete && listing.sessions.is_empty());
        assert!(start.elapsed() < Duration::from_secs(1));
        c.execute_batch("ROLLBACK; PRAGMA user_version=999")
            .unwrap();
        assert!(read_turns(&path, "session").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinked_wal() {
        let (dir, path, _) = fixture();
        let outside = dir.path().join("outside");
        fs::write(&outside, b"irrelevant").unwrap();
        std::os::unix::fs::symlink(outside, format!("{}-wal", path.display())).unwrap();
        assert!(open(&path).is_err());
    }

    #[test]
    #[ignore = "requires isolated fixture generated by OpenClaw 2026.9.6 official writer"]
    fn reads_official_writer_fixture() {
        let root = PathBuf::from(
            std::env::var_os("AGENTKIB_TEST_OPENCLAW_STATE").expect("fixture state directory"),
        );
        let listing = OpenClawProvider::with_home(root.clone())
            .list_sessions(&root.join("workspace"))
            .unwrap();
        assert!(!listing.is_empty());
        let expected: Value = serde_json::from_slice(
            &fs::read(
                std::env::var_os("AGENTKIB_TEST_OPENCLAW_EXPECTED").expect("writer result JSON"),
            )
            .unwrap(),
        )
        .unwrap();
        let id = expected["sessionId"].as_str().unwrap();
        let (parsed, _) =
            read_turns(&root.join("agents/main/agent/openclaw-agent.sqlite"), id).unwrap();
        let expected_text: Vec<String> = expected["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|event| {
                event
                    .pointer("/message/content/0/text")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .collect();
        assert_eq!(text(&parsed), expected_text);
        assert_eq!(parsed.turns[0].role, crate::SessionRole::User);
        assert_eq!(parsed.turns[1].role, crate::SessionRole::Assistant);
    }
    #[test]
    #[ignore = "requires qa/probes/openclaw-sqlite-fixtures.mjs official writer fixtures"]
    fn reads_official_branch_window_and_compression_fixtures() {
        let root = PathBuf::from(
            std::env::var_os("AGENTKIB_TEST_OPENCLAW_FIXTURES").expect("fixture state directory"),
        );
        let expected: Value =
            serde_json::from_slice(&fs::read(root.join("expected.json")).unwrap()).unwrap();
        let path = root.join("agents/main/agent/openclaw-agent.sqlite");
        for case in expected["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let id = case["sessionId"].as_str().unwrap();
            let result = read_turns(&path, id);
            if name == "compressed" {
                assert!(result.err().unwrap().to_string().contains("compressed"));
                continue;
            }
            let parsed = result.unwrap_or_else(|error| panic!("{name}: {error:#}")).0;
            let expected_text: Vec<String> = case["visibleEvents"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|event| {
                    event
                        .pointer("/event/message/content/0/text")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .collect();
            assert_eq!(text(&parsed), expected_text, "{name}");
            let roles: Vec<&str> = case["visibleEvents"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|event| event.pointer("/event/message/role").and_then(Value::as_str))
                .collect();
            assert_eq!(parsed.turns.len(), roles.len(), "{name}");
            for (turn, role) in parsed.turns.iter().zip(roles) {
                assert_eq!(
                    turn.role,
                    if role == "user" {
                        crate::SessionRole::User
                    } else {
                        crate::SessionRole::Assistant
                    },
                    "{name}"
                );
            }
        }
    }
    #[test]
    fn rejects_wrong_agent_owner_version_and_workspace_drift() {
        let (dir, path, c) = fixture();
        append(&c, 1, message("u", None, "user", "one"), true);
        c.execute("UPDATE schema_meta SET agent_id='other'", [])
            .unwrap();
        assert!(read_turns(&path, "session").is_err());
        c.execute(
            "UPDATE schema_meta SET agent_id='main',app_version='2026.10.1'",
            [],
        )
        .unwrap();
        assert!(read_turns(&path, "session").is_err());
        c.execute("UPDATE schema_meta SET app_version='2026.9.6'", [])
            .unwrap();
        let provider = OpenClawProvider::with_home(dir.path().into());
        let sessions = provider
            .list_sessions(&dir.path().join("workspace"))
            .unwrap();
        assert_eq!(sessions.len(), 1);
        fs::create_dir_all(dir.path().join("other")).unwrap();
        c.execute(
            "UPDATE transcript_events SET event_json=json_set(event_json,'$.cwd',?1) WHERE seq=0",
            [dir.path().join("other").to_string_lossy()],
        )
        .unwrap();
        assert!(
            super::read_turns(&path, "session", &dir.path().join("workspace"))
                .err()
                .unwrap()
                .to_string()
                .contains("workspace changed")
        );
        assert!(
            provider
                .read_events(&sessions[0].native_ref, None, 10)
                .is_err()
        );
    }
    #[test]
    fn display_only_history_is_visible_but_not_handoff_context() {
        let (dir, path, c) = fixture();
        let mut display = message("display", None, "user", "Display-only UI notification");
        display["message"]["excludeFromContext"] = json!(true);
        append(&c, 1, display, true);
        c.execute(
            "UPDATE session_transcript_active_events SET context_eligible=0",
            [],
        )
        .unwrap();
        let provider = OpenClawProvider::with_home(dir.path().into());
        let sessions = provider
            .list_sessions(&dir.path().join("workspace"))
            .unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(
            provider
                .read_events(&sessions[0].native_ref, None, 10)
                .unwrap()
                .events[0]
                .content
                .as_deref(),
            Some("Display-only UI notification")
        );
        assert!(
            provider
                .read_handoff_context(&sessions[0].native_ref)
                .err()
                .unwrap()
                .to_string()
                .contains("display-only")
        );
        let source = ConversationSessionSummary {
            id: "source".into(),
            workspace_id: "workspace".into(),
            agent: AgentKind::OpenClaw,
            title: None,
            origin: crate::SessionOrigin::Unknown,
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
        assert!(
            provider
                .read_session_document(&source, &sessions[0].native_ref, None)
                .err()
                .unwrap()
                .to_string()
                .contains("display-only")
        );
        assert!(read_events(&path, "session", None, 10).is_ok());
        c.execute("UPDATE transcript_events SET event_json=json_set(event_json,'$.message.excludeFromContext',json('false')) WHERE seq=1",[]).unwrap();
        assert!(
            read_turns(&path, "session")
                .err()
                .unwrap()
                .to_string()
                .contains("eligibility differs")
        );
        assert!(read_events(&path, "session", None, 10).is_err());
    }
}
