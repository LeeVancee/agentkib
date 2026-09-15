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
    NativeSessionSummary, SessionAvailability, SessionDocument,
};

#[derive(Default)]
pub struct OpenClawProvider {
    home: Option<PathBuf>,
}

#[derive(Clone)]
struct Session {
    native_ref: String,
    transcript: PathBuf,
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
        self.collect(None)
            .map(|(sessions, _)| sessions)
            .and_then(|sessions| {
                sessions
                    .into_iter()
                    .find(|session| session.native_ref == native_ref)
                    .context("OpenClaw session is no longer available")
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
        paging::read_page(&session.transcript, cursor, limit, paging::Format::OpenClaw)
    }

    fn read_handoff_context(&self, _native_ref: &str) -> Result<HandoffContext> {
        bail!("OpenClaw session handoff is unsupported")
    }

    fn read_session_document(
        &self,
        _source: &ConversationSessionSummary,
        _native_ref: &str,
        _home: Option<&Path>,
    ) -> Result<SessionDocument> {
        bail!("OpenClaw session documents are unsupported")
    }
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
        archived: false,
        sidechain: false,
        availability: if paging::is_readable(&session.transcript) {
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
        cwd,
        title,
        created_at,
        updated_at: updated_at.or(created_at),
    }))
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
