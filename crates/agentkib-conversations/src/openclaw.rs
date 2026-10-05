use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use agentkib_core::AgentKind;
use agentkib_platform::path as platform_path;
use anyhow::{Context, Result, bail};
use chrono::{DateTime, Utc};
use serde_json::Value;

use crate::history::{
    MAX_DISCOVERY_FILES, belongs_to_workspace, read_head_tail_lines, stable_native_ref,
};
use crate::paging;
use crate::{
    ConversationEventPage, ConversationProvider, ConversationSessionSummary, HandoffContext,
    NativeSessionSummary, SessionAvailability, SessionDocument, finish_document,
};

#[path = "openclaw_sqlite.rs"]
mod sqlite;

#[derive(Default)]
pub struct OpenClawProvider {
    home: Option<PathBuf>,
}

#[derive(Clone)]
struct Session {
    native_ref: String,
    transcript: PathBuf,
    sqlite_id: Option<String>,
    archived: bool,
    cwd: PathBuf,
    title: Option<String>,
    created_at: Option<DateTime<Utc>>,
    updated_at: Option<DateTime<Utc>>,
}

impl OpenClawProvider {
    #[cfg(test)]
    pub(super) fn with_home(home: PathBuf) -> Self {
        Self { home: Some(home) }
    }

    fn home(&self) -> Option<PathBuf> {
        self.home.clone().or_else(|| {
            env::var_os("OPENCLAW_STATE_DIR")
                .map(PathBuf::from)
                .or_else(|| dirs::home_dir().map(|path| path.join(".openclaw")))
        })
    }

    fn collect(&self, workspace: Option<&Path>) -> Result<(Vec<Session>, bool)> {
        let Some(home) = self.home() else {
            return Ok((Vec::new(), false));
        };
        let agents = home.join("agents");
        if !agents.is_dir() {
            return Ok((Vec::new(), false));
        }
        let mut sessions = Vec::new();
        let mut incomplete = false;
        let mut visited = 0usize;
        let entries = match fs::read_dir(&agents) {
            Ok(entries) => entries,
            Err(_) => return Ok((Vec::new(), true)),
        };
        'agents: for entry in entries {
            if visited >= MAX_DISCOVERY_FILES {
                incomplete = true;
                break 'agents;
            }
            let entry = match entry {
                Ok(value) => value,
                Err(_) => {
                    incomplete = true;
                    continue;
                }
            };
            visited += 1;
            let agent_path = entry.path();
            if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false)
                || !platform_path::is_safe_scan_entry(&agent_path)
            {
                continue;
            }
            let agent_instance = entry.file_name().to_string_lossy().into_owned();
            let database = agent_path.join("agent/openclaw-agent.sqlite");
            if sqlite::authority_exists(&database) {
                match sqlite::collect(&home, &agent_instance, &database, workspace) {
                    Ok((found, partial)) => {
                        sessions.extend(found);
                        incomplete |= partial;
                    }
                    Err(_) => incomplete = true,
                }
                // SQLite is authoritative even when locked, damaged, or newer than
                // our reader. Never advertise adjacent stale JSONL checkpoints.
                continue;
            }
            let sessions_path = agent_path.join("sessions");
            if !sessions_path.is_dir() {
                continue;
            }
            let (display_names, names_incomplete) = load_display_names(&sessions_path);
            incomplete |= names_incomplete;
            let session_entries = match fs::read_dir(&sessions_path) {
                Ok(entries) => entries,
                Err(_) => {
                    incomplete = true;
                    continue;
                }
            };
            for entry in session_entries {
                if visited >= MAX_DISCOVERY_FILES {
                    incomplete = true;
                    break 'agents;
                }
                let entry = match entry {
                    Ok(value) => value,
                    Err(_) => {
                        incomplete = true;
                        continue;
                    }
                };
                visited += 1;
                let path = entry.path();
                if path.file_name().and_then(|value| value.to_str()) == Some("sessions.json")
                    || path.extension().and_then(|value| value.to_str()) != Some("jsonl")
                    || !entry
                        .file_type()
                        .map(|kind| kind.is_file())
                        .unwrap_or(false)
                    || !platform_path::is_safe_scan_entry(&path)
                {
                    continue;
                }
                match parse_session(&home, &agent_instance, &path, &display_names) {
                    Ok(Some(session)) => {
                        if workspace
                            .is_none_or(|workspace| belongs_to_workspace(&session.cwd, workspace))
                        {
                            sessions.push(session);
                        }
                    }
                    Ok(None) => incomplete = true,
                    Err(_) => incomplete = true,
                }
            }
        }
        let mut seen = BTreeSet::new();
        sessions.retain(|session| seen.insert(session.native_ref.clone()));
        sessions.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| right.native_ref.cmp(&left.native_ref))
        });
        Ok((sessions, incomplete))
    }

    fn resolve(&self, native_ref: &str) -> Result<Session> {
        let (sessions, incomplete) = self.collect(None)?;
        sessions
            .into_iter()
            .find(|session| session.native_ref == native_ref)
            .context(if incomplete {
                "OpenClaw session discovery is incomplete; cannot establish session availability"
            } else {
                "OpenClaw session is no longer available"
            })
    }
}

impl ConversationProvider for OpenClawProvider {
    fn agent(&self) -> AgentKind {
        AgentKind::OpenClaw
    }

    fn list_sessions(&self, workspace: &Path) -> Result<Vec<NativeSessionSummary>> {
        Ok(self
            .collect(Some(workspace))?
            .0
            .into_iter()
            .map(summary)
            .collect())
    }

    fn list_sessions_detailed(&self, workspace: &Path) -> Result<crate::NativeSessionListing> {
        let (sessions, incomplete) = self.collect(Some(workspace))?;
        Ok(crate::NativeSessionListing {
            sessions: sessions.into_iter().map(summary).collect(),
            incomplete,
        })
    }

    fn read_events(
        &self,
        native_ref: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<ConversationEventPage> {
        let session = self.resolve(native_ref)?;
        if let Some(id) = &session.sqlite_id {
            return sqlite::read_events(&session.transcript, id, cursor, limit, &session.cwd);
        }
        paging::read_page(&session.transcript, cursor, limit, paging::Format::OpenClaw)
    }

    fn read_handoff_context(&self, native_ref: &str) -> Result<HandoffContext> {
        let session = self.resolve(native_ref)?;
        Ok(match &session.sqlite_id {
            Some(id) => sqlite::read_turns(&session.transcript, id, &session.cwd)?.0,
            None => read_original_turns(&session.transcript)?,
        }
        .into_handoff())
    }

    fn read_session_document(
        &self,
        source: &ConversationSessionSummary,
        native_ref: &str,
        home: Option<&Path>,
    ) -> Result<SessionDocument> {
        anyhow::ensure!(
            source.agent == AgentKind::OpenClaw,
            "OpenClaw source agent mismatch"
        );
        let session = self.resolve(native_ref)?;
        let parsed = match &session.sqlite_id {
            Some(id) => sqlite::read_turns(&session.transcript, id, &session.cwd)?.0,
            None => read_original_turns(&session.transcript)?,
        };
        finish_document(source, parsed.turns, parsed.losses, home)
    }
}

// Legacy Pi/OpenClaw JSONL is a tree. Flat files are accepted only when they
// predate IDs; tree files follow the last persisted leaf back to the root.
// SQLite is the current runtime authority. Legacy checkpoint files beside it
// are not a safe substitute for the current conversation.
fn read_original_turns(path: &Path) -> Result<crate::hermes::OriginalTurns> {
    if let Some(parent) = path.parent() {
        let mut directories = vec![parent.to_path_buf()];
        if let Some(agent) = parent.parent() {
            // Current canonical store: agents/<id>/agent/openclaw-agent.sqlite.
            directories.push(agent.join("agent"));
        }
        for directory in directories {
            let entries = match fs::read_dir(directory) {
                Ok(entries) => entries,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            for entry in entries {
                let entry = entry?;
                let filename = entry.file_name();
                let name = filename.to_string_lossy();
                let main_name = name
                    .strip_suffix("-wal")
                    .or_else(|| name.strip_suffix("-shm"))
                    .or_else(|| name.strip_suffix("-journal"))
                    .unwrap_or(&name);
                if matches!(
                    Path::new(main_name)
                        .extension()
                        .and_then(|value| value.to_str()),
                    Some("db" | "sqlite" | "sqlite3")
                ) {
                    bail!(
                        "OpenClaw SQLite history is not yet verified; refusing a possibly stale JSONL checkpoint"
                    );
                }
            }
        }
    }
    let records = crate::hermes::read_original_jsonl(path)?;
    let mut ids = BTreeMap::new();
    let mut leaf = None;
    let mut tree = false;
    for (index, (_, record)) in records.iter().enumerate() {
        match record.get("type").and_then(Value::as_str) {
            Some("session") => {
                if let Some(version) = record.get("version") {
                    anyhow::ensure!(
                        matches!(version.as_u64(), Some(1..=3)),
                        "Unknown OpenClaw transcript version"
                    );
                }
                anyhow::ensure!(
                    record.get("parentSession").is_none_or(Value::is_null),
                    "OpenClaw parent-session history requires a verified lineage reader"
                );
                continue;
            }
            Some("reset" | "compaction" | "branch_summary") => bail!(
                "OpenClaw reset/compaction history requires a verified window reader before import"
            ),
            Some(
                "message"
                | "model_change"
                | "thinking_level_change"
                | "custom"
                | "session_info"
                | "label",
            ) => {}
            _ => bail!("Unsupported OpenClaw original-history entry type"),
        }
        if let Some(id) = record.get("id").and_then(Value::as_str) {
            anyhow::ensure!(
                ids.insert(id.to_owned(), index).is_none(),
                "Duplicate OpenClaw entry identity"
            );
            leaf = Some(id.to_owned());
            tree = true;
        }
    }
    let mut selected = BTreeSet::new();
    if tree {
        while let Some(id) = leaf {
            let index = *ids.get(&id).context("Missing OpenClaw branch ancestor")?;
            anyhow::ensure!(selected.insert(index), "Cyclic OpenClaw transcript branch");
            let record = &records[index].1;
            leaf = match record.get("parentId") {
                Some(Value::Null) => None,
                Some(Value::String(parent)) => {
                    anyhow::ensure!(
                        ids.get(parent)
                            .is_some_and(|parent_index| *parent_index < index),
                        "OpenClaw branch ancestor is missing or out of order"
                    );
                    Some(parent.clone())
                }
                _ => bail!("OpenClaw tree entry has no valid parent identity"),
            };
        }
        anyhow::ensure!(
            records
                .iter()
                .all(
                    |(_, record)| record.get("type").and_then(Value::as_str) != Some("message")
                        || record.get("id").and_then(Value::as_str).is_some()
                ),
            "Mixed flat and tree OpenClaw messages are unsupported"
        );
    }
    let mut parsed = crate::hermes::OriginalTurns::default();
    for (index, (line, record)) in records.into_iter().enumerate() {
        if tree && !selected.contains(&index) {
            continue;
        }
        if record.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let message = record
            .get("message")
            .context("OpenClaw message envelope is missing")?;
        parsed.push_message(
            line,
            message,
            message.get("role").and_then(Value::as_str),
            record.get("timestamp"),
        )?;
    }
    parsed.ensure_readable()?;
    Ok(parsed)
}

fn summary(session: Session) -> NativeSessionSummary {
    NativeSessionSummary {
        native_ref: session.native_ref,
        agent: AgentKind::OpenClaw,
        title: session.title,
        origin: crate::SessionOrigin::Unknown,
        spawned_by_session_id: None,
        forked_from_session_id: None,
        created_at: session.created_at,
        updated_at: session.updated_at,
        message_count: None,
        git_branch: None,
        archived: session.archived,
        sidechain: false,
        availability: if session.sqlite_id.is_some() || paging::is_readable(&session.transcript) {
            SessionAvailability::Readable
        } else {
            SessionAvailability::MetadataOnly
        },
    }
}

fn load_display_names(sessions_dir: &Path) -> (BTreeMap<String, String>, bool) {
    let path = sessions_dir.join("sessions.json");
    if !path.exists() {
        return (BTreeMap::new(), false);
    }
    let Ok(bytes) = crate::history::read_bounded(&path, crate::history::MAX_METADATA_BYTES) else {
        return (BTreeMap::new(), true);
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return (BTreeMap::new(), true);
    };
    let names = value
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(_, item)| {
            Some((
                item.get("sessionId")?.as_str()?.to_owned(),
                item.get("displayName")?.as_str()?.to_owned(),
            ))
        })
        .filter(|(_, value)| !value.trim().is_empty())
        .collect();
    (names, false)
}

fn parse_session(
    home: &Path,
    agent_instance: &str,
    path: &Path,
    display_names: &BTreeMap<String, String>,
) -> Result<Option<Session>> {
    let (head, tail) = read_head_tail_lines(path)?;
    let mut session_id = None;
    let mut cwd = None;
    let mut created_at = None;
    let mut first_user = None;
    for line in head {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        created_at =
            created_at.or_else(|| value.get("timestamp").and_then(super::parse_json_timestamp));
        if value.get("type").and_then(Value::as_str) == Some("session") {
            session_id = session_id.or_else(|| {
                value
                    .get("id")
                    .or_else(|| value.get("sessionId"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
            cwd = cwd.or_else(|| value.get("cwd").and_then(Value::as_str).map(PathBuf::from));
        }
        if value.get("type").and_then(Value::as_str) == Some("message")
            && value.pointer("/message/role").and_then(Value::as_str) == Some("user")
            && first_user.is_none()
        {
            first_user = value
                .pointer("/message/content")
                .and_then(|value| super::response_message_text(Some(value)))
                .and_then(|value| super::sanitize_title(Some(&value)));
        }
    }
    let updated_at = tail
        .iter()
        .rev()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find_map(|value| value.get("timestamp").and_then(super::parse_json_timestamp));
    let session_id = session_id.or_else(|| path.file_stem()?.to_str().map(str::to_owned));
    let cwd = cwd.filter(|path| path.is_absolute());
    let (Some(session_id), Some(cwd)) = (session_id, cwd) else {
        return Ok(None);
    };
    let title = display_names
        .get(&session_id)
        .and_then(|value| super::sanitize_title(Some(value)))
        .or(first_user)
        .or_else(|| {
            cwd.file_name()
                .and_then(|value| value.to_str())
                .map(str::to_owned)
        });
    let relative = path.strip_prefix(home).unwrap_or(path).to_string_lossy();
    let native_ref = stable_native_ref(
        "openclaw",
        &[
            home.to_string_lossy().as_ref(),
            agent_instance,
            &session_id,
            &relative,
        ],
    );
    Ok(Some(Session {
        native_ref,
        transcript: path.to_path_buf(),
        sqlite_id: None,
        archived: false,
        cwd,
        title,
        created_at,
        updated_at: updated_at.or(created_at),
    }))
}

#[cfg(test)]
pub(super) fn matrix_document() -> SessionDocument {
    sqlite::matrix_document()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn session_line(id: &str, cwd: &Path, timestamp: &str) -> String {
        serde_json::json!({
            "type": "session",
            "id": id,
            "cwd": cwd.to_string_lossy(),
            "timestamp": timestamp,
        })
        .to_string()
    }

    #[test]
    fn original_import_refuses_missing_user_content_before_valid_assistant() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("history.jsonl");
        fs::write(&path, "{\"type\":\"message\",\"message\":{\"role\":\"user\"}}\n{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":\"answer\"}}\n").unwrap();
        assert!(read_original_turns(&path).is_err());
    }

    #[test]
    fn original_tree_import_selects_latest_branch_without_resurrecting_other_leaf() {
        use crate::SessionBlock;
        let dir = tempdir().unwrap();
        let path = dir.path().join("history.jsonl");
        let records = [
            serde_json::json!({"type":"session","version":3,"id":"session","cwd":"/tmp/project"}),
            serde_json::json!({"type":"message","id":"root","parentId":null,"message":{"role":"user","content":"question"}}),
            serde_json::json!({"type":"message","id":"old","parentId":"root","message":{"role":"assistant","content":"abandoned answer"}}),
            serde_json::json!({"type":"message","id":"new","parentId":"root","message":{"role":"assistant","content":[{"type":"toolCall","id":"call1","name":"read","arguments":{}}]}}),
            serde_json::json!({"type":"message","id":"result","parentId":"new","message":{"role":"toolResult","toolCallId":"call1","content":[{"type":"text","text":"found"}],"isError":false}}),
        ];
        fs::write(
            &path,
            records
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();
        let parsed = read_original_turns(&path).unwrap();
        assert_eq!(parsed.turns.len(), 3);
        assert!(
            matches!(&parsed.turns[1].blocks[0], SessionBlock::ToolCall { call_id, .. } if call_id == "call1")
        );
        assert!(
            matches!(&parsed.turns[2].blocks[0], SessionBlock::ToolResult { output, .. } if output == "found")
        );
        assert!(parsed.losses.is_empty());
    }

    #[test]
    fn original_import_rejects_stale_sqlite_checkpoint_and_unknown_lifecycle() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("history.jsonl");
        fs::write(
            &path,
            r#"{"type":"message","message":{"role":"user","content":"legacy"}}"#,
        )
        .unwrap();
        fs::write(dir.path().join("sessions.db"), "not opened").unwrap();
        assert!(
            read_original_turns(&path)
                .err()
                .unwrap()
                .to_string()
                .contains("SQLite")
        );
        fs::remove_file(dir.path().join("sessions.db")).unwrap();
        let sessions = dir.path().join("agents/main/sessions");
        let store = dir.path().join("agents/main/agent");
        fs::create_dir_all(&sessions).unwrap();
        fs::create_dir_all(&store).unwrap();
        fs::copy(&path, sessions.join("legacy.jsonl")).unwrap();
        fs::write(store.join("openclaw-agent.sqlite-wal"), "orphan WAL").unwrap();
        assert!(
            read_original_turns(&sessions.join("legacy.jsonl"))
                .err()
                .unwrap()
                .to_string()
                .contains("SQLite")
        );
        for record in [
            r#"{"type":"reset"}"#,
            r#"{"type":"session","version":99}"#,
            r#"{"type":"message","id":"a","parentId":"missing","message":{"role":"user","content":"x"}}"#,
            r#"{"type":"message","id":"a","parentId":"a","message":{"role":"user","content":"x"}}"#,
        ] {
            fs::write(&path, record).unwrap();
            assert!(read_original_turns(&path).is_err());
        }
    }

    #[test]
    fn discovers_agent_scoped_session_and_display_name() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("project");
        let sessions = dir.path().join("agents/main/sessions");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&sessions).unwrap();
        fs::write(
            sessions.join("sessions.json"),
            r#"{"agent:main:main":{"sessionId":"s1","displayName":"Named"}}"#,
        )
        .unwrap();
        fs::write(
            sessions.join("s1.jsonl"),
            format!(
                "{}\n{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"hello\"}},\"timestamp\":\"2026-01-01T00:00:01Z\"}}\n",
                session_line("s1", &workspace, "2026-01-01T00:00:00Z")
            ),
        )
        .unwrap();
        let provider = OpenClawProvider::with_home(dir.path().to_path_buf());
        let sessions = provider.list_sessions(&workspace).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].title.as_deref(), Some("Named"));
        assert!(sessions[0].native_ref.starts_with("openclaw-v1-"));
        let page = provider
            .read_events(&sessions[0].native_ref, None, 50)
            .unwrap();
        assert_eq!(page.events.len(), 1);
        assert_eq!(page.events[0].content.as_deref(), Some("hello"));
    }

    #[test]
    fn malformed_source_is_reported_as_incomplete_without_dropping_good_sessions() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("project");
        let sessions = dir.path().join("agents/main/sessions");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&sessions).unwrap();
        fs::write(
            sessions.join("good.jsonl"),
            format!(
                "{}\n",
                session_line("good", &workspace, "2026-01-01T00:00:00Z")
            ),
        )
        .unwrap();
        fs::write(sessions.join("bad.jsonl"), "not-json\n").unwrap();
        let provider = OpenClawProvider::with_home(dir.path().to_path_buf());
        let listing = provider.list_sessions_detailed(&workspace).unwrap();
        assert_eq!(listing.sessions.len(), 1);
        assert!(listing.incomplete);
    }
}
