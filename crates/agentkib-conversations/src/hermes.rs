use std::collections::BTreeSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use agentkib_core::AgentKind;
use agentkib_platform::path as platform_path;
use anyhow::{Context, Result, bail};
use chrono::{DateTime, Utc};
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;

use crate::history::{
    MAX_DISCOVERY_FILES, belongs_to_workspace, read_head_tail_lines, stable_native_ref,
};
use crate::paging;
use crate::{
    ConversationEvent, ConversationEventKind, ConversationEventPage, ConversationProvider,
    ConversationSessionSummary, HandoffContext, NativeSessionListing, NativeSessionSummary,
    SessionAvailability, SessionDocument,
};

const SQLITE_PAGE_SIZE: usize = 100;
const SQLITE_SCAN_LIMIT: i64 = 500;
const SQLITE_MAX_PAGE_BYTES: usize = 2 * 1024 * 1024;
const SQLITE_METADATA_CHARS: usize = 1024;
const SQLITE_ANCHOR_CHARS: usize = 4096;

#[derive(Default)]
pub struct HermesProvider {
    home: Option<PathBuf>,
}

#[derive(Clone)]
enum Source {
    Jsonl(PathBuf),
    Sqlite { path: PathBuf, session_id: String },
}

#[derive(Clone)]
struct Session {
    native_ref: String,
    cwd: Option<PathBuf>,
    title: Option<String>,
    created_at: Option<DateTime<Utc>>,
    updated_at: Option<DateTime<Utc>>,
    source: Source,
}

impl HermesProvider {
    #[cfg(test)]
    pub(super) fn with_home(home: PathBuf) -> Self {
        Self { home: Some(home) }
    }

    fn base_home(&self) -> Option<PathBuf> {
        self.home.clone().or_else(|| {
            env::var_os("HERMES_HOME")
                .map(PathBuf::from)
                .or_else(|| dirs::home_dir().map(|path| path.join(".hermes")))
        })
    }

    fn homes(&self) -> (Vec<(String, PathBuf)>, bool) {
        let Some(base) = self.base_home() else {
            return (Vec::new(), false);
        };
        let mut homes = vec![("default".to_owned(), base.clone())];
        let mut incomplete = false;
        let profiles = base.join("profiles");
        match fs::read_dir(profiles) {
            Ok(entries) => {
                for entry in entries {
                    let entry = match entry {
                        Ok(entry) => entry,
                        Err(_) => {
                            incomplete = true;
                            continue;
                        }
                    };
                    let path = entry.path();
                    match entry.file_type() {
                        Ok(kind) if kind.is_dir() && platform_path::is_safe_scan_entry(&path) => {
                            homes.push((entry.file_name().to_string_lossy().into_owned(), path));
                        }
                        Err(_) => incomplete = true,
                        _ => {}
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => incomplete = true,
        }
        (homes, incomplete)
    }

    fn collect(&self, workspace: Option<&Path>) -> Result<(Vec<Session>, bool)> {
        let mut all = Vec::new();
        let (homes, mut incomplete) = self.homes();
        let mut visited_jsonl = 0usize;
        for (profile, home) in homes {
            if !home.is_dir() {
                continue;
            }
            // Resolve source precedence before filtering ownership, just as
            // read_events does. A stale JSONL cwd must not resurrect a DB
            // session in a different workspace or hide its fallback body.
            let (mut database, db_incomplete) = scan_database(&home, &profile)?;
            incomplete |= db_incomplete;
            let (jsonl, jsonl_incomplete) = scan_jsonl(&home, &profile, &mut visited_jsonl)?;
            incomplete |= jsonl_incomplete;
            for jsonl_session in jsonl {
                if let Some(database_session) = database
                    .iter_mut()
                    .find(|session| session.native_ref == jsonl_session.native_ref)
                {
                    // SQLite metadata wins where present. Fill missing
                    // ownership/title fields from JSONL so a metadata row
                    // without cwd does not get silently assigned to nowhere.
                    if database_session.cwd.is_none() {
                        database_session.cwd = jsonl_session.cwd.clone();
                    }
                    if database_session.title.is_none() {
                        database_session.title = jsonl_session.title.clone();
                    }
                    // A DB without a usable messages table must fall back to
                    // the readable JSONL transcript instead of hiding it.
                    if matches!(
                        &database_session.source,
                        Source::Sqlite { path, .. } if !sqlite_messages_supported(path)
                    ) {
                        database_session.source = jsonl_session.source;
                    }
                } else {
                    database.push(jsonl_session);
                }
            }
            if let Some(workspace) = workspace {
                database.retain(|session| {
                    session
                        .cwd
                        .as_deref()
                        .is_some_and(|cwd| belongs_to_workspace(cwd, workspace))
                });
            }
            all.extend(database);
        }
        all.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| right.native_ref.cmp(&left.native_ref))
        });
        let mut seen = BTreeSet::new();
        all.retain(|session| seen.insert(session.native_ref.clone()));
        Ok((all, incomplete))
    }

    fn resolve(&self, native_ref: &str) -> Result<Session> {
        self.collect(None)
            .map(|(sessions, _)| sessions)
            .and_then(|sessions| {
                sessions
                    .into_iter()
                    .find(|session| session.native_ref == native_ref)
                    .context("Hermes session is no longer available")
            })
    }
}

impl ConversationProvider for HermesProvider {
    fn agent(&self) -> AgentKind {
        AgentKind::Hermes
    }

    fn list_sessions(&self, workspace: &Path) -> Result<Vec<NativeSessionSummary>> {
        Ok(self
            .collect(Some(workspace))?
            .0
            .into_iter()
            .map(summary)
            .collect())
    }

    fn list_sessions_detailed(&self, workspace: &Path) -> Result<NativeSessionListing> {
        let (sessions, incomplete) = self.collect(Some(workspace))?;
        Ok(NativeSessionListing {
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
        match session.source {
            Source::Jsonl(path) => paging::read_page(&path, cursor, limit, paging::Format::Hermes),
            Source::Sqlite { path, session_id } => {
                read_sqlite_events(&path, &session_id, cursor, limit)
            }
        }
    }

    fn read_handoff_context(&self, _native_ref: &str) -> Result<HandoffContext> {
        bail!("Hermes session handoff is unsupported")
    }

    fn read_session_document(
        &self,
        _source: &ConversationSessionSummary,
        _native_ref: &str,
        _home: Option<&Path>,
    ) -> Result<SessionDocument> {
        bail!("Hermes session documents are unsupported")
    }
}

fn summary(session: Session) -> NativeSessionSummary {
    let readable = match &session.source {
        Source::Jsonl(path) => paging::is_readable(path),
        Source::Sqlite { path, .. } => sqlite_messages_supported(path),
    };
    NativeSessionSummary {
        native_ref: session.native_ref,
        agent: AgentKind::Hermes,
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
        availability: if readable {
            SessionAvailability::Readable
        } else {
            SessionAvailability::MetadataOnly
        },
    }
}

fn scan_database(home: &Path, profile: &str) -> Result<(Vec<Session>, bool)> {
    let path = home.join("state.db");
    if !path.is_file() {
        return Ok((Vec::new(), false));
    }
    let connection = match Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(connection) => connection,
        Err(_) => return Ok((Vec::new(), true)),
    };
    let columns = match table_columns(&connection, "sessions") {
        Ok(columns) => columns,
        Err(_) => return Ok((Vec::new(), true)),
    };
    if columns.is_empty() || !columns.contains("id") {
        return Ok((Vec::new(), true));
    }
    let id = bounded_sql_text(&quote_identifier("id"), SQLITE_METADATA_CHARS);
    let title = bounded_sql_text(
        &select_text_expr(&columns, &["title", "name", "summary"]),
        SQLITE_METADATA_CHARS,
    );
    let cwd = bounded_sql_text(
        &select_text_expr(&columns, &["cwd", "directory", "project_dir"]),
        SQLITE_METADATA_CHARS,
    );
    let created = bounded_sql_text(
        &select_text_expr(&columns, &["started_at", "created_at"]),
        SQLITE_METADATA_CHARS,
    );
    let updated = bounded_sql_text(
        &select_text_expr(&columns, &["ended_at", "updated_at", "last_active_at"]),
        SQLITE_METADATA_CHARS,
    );
    let sql = format!(
        "SELECT rowid, {id}, {title}, {cwd}, {created}, {updated} FROM sessions ORDER BY rowid DESC LIMIT {}",
        SQLITE_SCAN_LIMIT + 1
    );
    let mut statement = match connection.prepare(&sql) {
        Ok(statement) => statement,
        Err(_) => return Ok((Vec::new(), true)),
    };
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, Option<String>>(5)?,
        ))
    });
    let Ok(rows) = rows else {
        return Ok((Vec::new(), true));
    };
    let mut output = Vec::new();
    let mut incomplete = false;
    for (index, row) in rows.enumerate() {
        if index >= SQLITE_SCAN_LIMIT as usize {
            incomplete = true;
            break;
        }
        let Ok((_rowid, session_id, title, cwd, created, updated)) = row else {
            incomplete = true;
            continue;
        };
        if session_id.trim().is_empty() {
            incomplete = true;
            continue;
        }
        let cwd = cwd
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from);
        let native_ref = stable_native_ref(
            "hermes",
            &[home.to_string_lossy().as_ref(), profile, &session_id],
        );
        let created_at = created.as_deref().and_then(parse_timestamp_text);
        let updated_at = updated
            .as_deref()
            .and_then(parse_timestamp_text)
            .or(created_at);
        output.push(Session {
            native_ref,
            cwd: cwd.clone(),
            title: title.and_then(|value| super::sanitize_title(Some(&value))),
            created_at,
            updated_at,
            source: Source::Sqlite {
                path: path.to_path_buf(),
                session_id,
            },
        });
    }
    Ok((output, incomplete))
}

fn scan_jsonl(home: &Path, profile: &str, visited: &mut usize) -> Result<(Vec<Session>, bool)> {
    let path = home.join("sessions");
    if !path.is_dir() {
        return Ok((Vec::new(), false));
    }
    let entries = match fs::read_dir(&path) {
        Ok(entries) => entries,
        Err(_) => return Ok((Vec::new(), true)),
    };
    let mut output = Vec::new();
    let mut incomplete = false;
    for entry in entries {
        if *visited >= MAX_DISCOVERY_FILES {
            return Ok((output, true));
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                incomplete = true;
                continue;
            }
        };
        *visited += 1;
        let file = entry.path();
        if !entry
            .file_type()
            .map(|kind| kind.is_file())
            .unwrap_or(false)
            || !matches!(
                file.extension().and_then(|value| value.to_str()),
                Some("jsonl" | "json")
            )
            || !platform_path::is_safe_scan_entry(&file)
        {
            continue;
        }
        match parse_jsonl(home, profile, &file) {
            Ok(JsonlOutcome::Session {
                session,
                incomplete: source_incomplete,
            }) => {
                output.push(session);
                incomplete |= source_incomplete;
            }
            // Missing IDs are valid skips, not partial-read failures.
            // Actual unreadable files arrive as Err below.
            Ok(JsonlOutcome::Skip) => {}
            Err(_) => incomplete = true,
        }
    }
    Ok((output, incomplete))
}

enum JsonlOutcome {
    Session { session: Session, incomplete: bool },
    Skip,
}

fn parse_jsonl(home: &Path, profile: &str, path: &Path) -> Result<JsonlOutcome> {
    let (head, tail) = read_head_tail_lines(path)?;
    let mut id = None;
    let mut title = None;
    let mut cwd = None;
    let mut created_at = None;
    let mut first_user = None;
    let mut valid_records = 0usize;
    let mut malformed_records = 0usize;
    for line in head {
        let value = match serde_json::from_str::<Value>(&line) {
            Ok(value) => {
                valid_records += 1;
                value
            }
            Err(_) => {
                if !line.trim().is_empty() {
                    malformed_records += 1;
                }
                continue;
            }
        };
        let ts = value
            .get("timestamp")
            .or_else(|| value.get("ts"))
            .and_then(super::parse_json_timestamp);
        created_at = created_at.or(ts);
        let record_type = value.get("type").and_then(Value::as_str);
        let message = if record_type == Some("message") {
            value.get("message").unwrap_or(&value)
        } else {
            &value
        };
        if matches!(record_type, Some("session" | "init")) {
            id = id.or_else(|| {
                value
                    .get("id")
                    .or_else(|| value.get("sessionId"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
            title = title.or_else(|| {
                value
                    .get("title")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
            cwd = cwd.or_else(|| {
                value
                    .get("cwd")
                    .or_else(|| value.get("directory"))
                    .and_then(Value::as_str)
                    .map(PathBuf::from)
            });
        }
        if first_user.is_none() && message.get("role").and_then(Value::as_str) == Some("user") {
            first_user = message
                .get("content")
                .and_then(|value| super::response_message_text(Some(value)))
                .and_then(|value| super::sanitize_title(Some(&value)));
        }
    }
    let mut updated_at = None;
    for line in tail.iter().rev() {
        match serde_json::from_str::<Value>(line) {
            Ok(value) => {
                valid_records += 1;
                if updated_at.is_none() {
                    updated_at = value
                        .get("timestamp")
                        .or_else(|| value.get("ts"))
                        .and_then(super::parse_json_timestamp);
                }
            }
            Err(_) => {
                if !line.trim().is_empty() {
                    malformed_records += 1;
                }
            }
        }
    }
    let id = id.or_else(|| path.file_stem()?.to_str().map(str::to_owned));
    let Some(id) = id else {
        return if malformed_records > 0 && valid_records == 0 {
            Err(anyhow::anyhow!("Invalid Hermes transcript metadata"))
        } else {
            Ok(JsonlOutcome::Skip)
        };
    };
    let title = title
        .and_then(|value| super::sanitize_title(Some(&value)))
        .or(first_user)
        .or_else(|| {
            cwd.as_deref()
                .and_then(|path| path.file_name())
                .and_then(|value| value.to_str())
                .map(str::to_owned)
        });
    let native_ref = stable_native_ref("hermes", &[home.to_string_lossy().as_ref(), profile, &id]);
    Ok(JsonlOutcome::Session {
        session: Session {
            native_ref,
            cwd,
            title,
            created_at,
            updated_at: updated_at.or(created_at),
            source: Source::Jsonl(path.to_path_buf()),
        },
        incomplete: malformed_records > 0,
    })
}

fn table_columns(connection: &Connection, table: &str) -> Result<BTreeSet<String>> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
    Ok(rows.collect::<rusqlite::Result<BTreeSet<_>>>()?)
}

fn sqlite_messages_supported(path: &Path) -> bool {
    let Ok(connection) = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return false;
    };
    let Ok(columns) = table_columns(&connection, "messages") else {
        return false;
    };
    let has_session = columns.iter().any(|column| {
        matches!(
            column.as_str(),
            "session_id" | "sessionId" | "session" | "conversation_id" | "conversationId"
        )
    });
    let has_role = columns
        .iter()
        .any(|column| matches!(column.as_str(), "role" | "speaker"));
    let has_content = columns
        .iter()
        .any(|column| matches!(column.as_str(), "content" | "text" | "message"));
    has_session
        && has_role
        && has_content
        && connection
            .prepare("SELECT rowid FROM messages LIMIT 1")
            .is_ok()
}

fn quote_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn select_text_expr(columns: &BTreeSet<String>, candidates: &[&str]) -> String {
    let existing = candidates
        .iter()
        .filter(|column| columns.contains(**column))
        .map(|column| format!("CAST({} AS TEXT)", quote_identifier(column)))
        .collect::<Vec<_>>();
    match existing.as_slice() {
        [] => "NULL".to_owned(),
        [only] => only.clone(),
        values => format!("COALESCE({})", values.join(", ")),
    }
}

fn bounded_sql_text(expression: &str, chars: usize) -> String {
    format!(
        "substr(CAST(({expression}) AS TEXT), 1, {chars})",
        expression = expression
    )
}

fn select_status_expr(columns: &BTreeSet<String>) -> String {
    let status = select_text_expr(columns, &["status", "tool_status", "toolStatus"]);
    if status != "NULL" {
        return status;
    }
    columns
        .iter()
        .find(|column| matches!(column.as_str(), "is_error" | "isError"))
        .map(|column| {
            format!(
                "CASE WHEN CAST({} AS TEXT) IN ('1', 'true', 'TRUE') THEN 'failed' ELSE 'completed' END",
                quote_identifier(column)
            )
        })
        .unwrap_or_else(|| "NULL".to_owned())
}

fn parse_timestamp_text(value: &str) -> Option<DateTime<Utc>> {
    if let Ok(number) = value.parse::<i64>() {
        return super::timestamp_from_integer(number);
    }
    // SQLite REAL timestamps are cast to decimal text. Match discovery's
    // seconds/milliseconds handling without saturating invalid float values.
    if let Ok(number) = value.parse::<f64>() {
        return (number.is_finite() && number > 0.0 && number < i64::MAX as f64)
            .then(|| super::timestamp_from_integer(number as i64))
            .flatten();
    }
    super::parse_json_timestamp(&Value::String(value.to_owned()))
}

#[cfg(unix)]
fn sqlite_identity(_path: &Path, metadata: &fs::Metadata) -> Result<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    Ok((metadata.dev(), metadata.ino()))
}

#[cfg(windows)]
fn sqlite_identity(path: &Path, _metadata: &fs::Metadata) -> Result<(u64, u64)> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };

    let file = fs::File::open(path)
        .with_context(|| format!("Cannot open Hermes database identity {}", path.display()))?;
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: the handle is kept open for the call and points to a regular
    // file; `information` is a valid writable buffer of the required type.
    let succeeded = unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) };
    if succeeded == 0 {
        return Err(std::io::Error::last_os_error())
            .with_context(|| format!("Cannot query Hermes database identity {}", path.display()));
    }
    let file_index =
        (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow);
    Ok((u64::from(information.dwVolumeSerialNumber), file_index))
}

#[cfg(all(not(unix), not(windows)))]
fn sqlite_identity(_path: &Path, _metadata: &fs::Metadata) -> Result<(u64, u64)> {
    bail!("Hermes database identity is unsupported on this platform")
}

fn sqlite_source_digest(path: &Path, session_id: &str) -> String {
    let reference = stable_native_ref(
        "hermes-db-source",
        &[path.to_string_lossy().as_ref(), session_id],
    );
    reference
        .strip_prefix("hermes-db-source-v1-")
        .unwrap_or(&reference)
        .to_owned()
}

struct SqliteCursor {
    high_water: i64,
    before: i64,
    anchor: String,
}

struct SqliteFields<'a> {
    session_column: &'a str,
    role_expr: &'a str,
    content_column: &'a str,
    timestamp_expr: &'a str,
    status_expr: &'a str,
    tool_name_expr: &'a str,
}

fn sqlite_anchor_digest(
    connection: &Connection,
    fields: &SqliteFields<'_>,
    session_id: &str,
    rowid: i64,
) -> Result<Option<String>> {
    let sql = format!(
        "SELECT {role}, length(CAST({content} AS TEXT)), substr(CAST({content} AS TEXT), 1, {anchor_chars}), substr(CAST({content} AS TEXT), -{anchor_chars}), {timestamp}, {status}, {tool_name} FROM messages WHERE CAST({session_column} AS TEXT) = ?1 AND rowid = ?2",
        role = fields.role_expr,
        content = quote_identifier(fields.content_column),
        anchor_chars = SQLITE_ANCHOR_CHARS,
        timestamp = fields.timestamp_expr,
        status = fields.status_expr,
        tool_name = fields.tool_name_expr,
        session_column = quote_identifier(fields.session_column),
    );
    let mut statement = connection.prepare(&sql)?;
    let mut rows = statement.query(rusqlite::params![session_id, rowid])?;
    let Some(row) = rows.next()? else {
        return Ok(None);
    };
    let role_value = row.get::<_, Option<String>>(0)?.unwrap_or_default();
    let content_length = row.get::<_, Option<i64>>(1)?.unwrap_or_default();
    let content_head = row.get::<_, Option<String>>(2)?.unwrap_or_default();
    let content_tail = row.get::<_, Option<String>>(3)?.unwrap_or_default();
    let timestamp_value = row.get::<_, Option<String>>(4)?.unwrap_or_default();
    let status_value = row.get::<_, Option<String>>(5)?.unwrap_or_default();
    let tool_name_value = row.get::<_, Option<String>>(6)?.unwrap_or_default();
    let rowid_value = rowid.to_string();
    let content_length = content_length.to_string();
    let digest = stable_native_ref(
        "hermes-anchor",
        &[
            session_id,
            &rowid_value,
            &role_value,
            &content_length,
            &content_head,
            &content_tail,
            &timestamp_value,
            &status_value,
            &tool_name_value,
        ],
    );
    Ok(Some(
        digest
            .strip_prefix("hermes-anchor-v1-")
            .unwrap_or(&digest)
            .to_owned(),
    ))
}

fn cursor_high_water_hint(value: &str) -> Option<i64> {
    value
        .strip_prefix("hermes-db-v2-")
        .and_then(|rest| rest.split('-').nth(1))
        .and_then(|value| value.parse::<i64>().ok())
}

fn parse_sqlite_cursor(
    value: &str,
    expected_source: &str,
    expected_identity: (u64, u64),
    current_high_water: i64,
    current_anchor: Option<&str>,
) -> Result<SqliteCursor> {
    let parts = value
        .strip_prefix("hermes-db-v2-")
        .ok_or_else(|| anyhow::anyhow!("TRANSCRIPT_CURSOR_INVALID"))?
        .split('-')
        .collect::<Vec<_>>();
    anyhow::ensure!(parts.len() == 6, "TRANSCRIPT_CURSOR_INVALID");
    let source_digest = parts[0];
    anyhow::ensure!(
        source_digest == expected_source
            && source_digest.len() == 64
            && source_digest.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "TRANSCRIPT_CURSOR_INVALID"
    );
    let high_water = parts[1]
        .parse::<i64>()
        .map_err(|_| anyhow::anyhow!("TRANSCRIPT_CURSOR_INVALID"))?;
    let before = parts[2]
        .parse::<i64>()
        .map_err(|_| anyhow::anyhow!("TRANSCRIPT_CURSOR_INVALID"))?;
    let dev = parts[3]
        .parse::<u64>()
        .map_err(|_| anyhow::anyhow!("TRANSCRIPT_CURSOR_INVALID"))?;
    let ino = parts[4]
        .parse::<u64>()
        .map_err(|_| anyhow::anyhow!("TRANSCRIPT_CURSOR_INVALID"))?;
    let anchor = parts[5];
    anyhow::ensure!(
        high_water >= 0 && before >= 0 && before <= high_water.saturating_add(1),
        "TRANSCRIPT_CURSOR_INVALID"
    );
    anyhow::ensure!(
        (high_water == 0 && anchor.is_empty())
            || (anchor.len() == 64 && anchor.bytes().all(|byte| byte.is_ascii_hexdigit())),
        "TRANSCRIPT_CURSOR_INVALID"
    );
    anyhow::ensure!((dev, ino) == expected_identity, "TRANSCRIPT_CURSOR_STALE");
    anyhow::ensure!(current_high_water >= high_water, "TRANSCRIPT_CURSOR_STALE");
    if high_water > 0 {
        anyhow::ensure!(current_anchor == Some(anchor), "TRANSCRIPT_CURSOR_STALE");
    }
    Ok(SqliteCursor {
        high_water,
        before,
        anchor: anchor.to_owned(),
    })
}

fn read_sqlite_events(
    path: &Path,
    session_id: &str,
    cursor: Option<&str>,
    limit: usize,
) -> Result<ConversationEventPage> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("Cannot open Hermes database {}", path.display()))?;
    if connection
        .prepare("SELECT rowid FROM messages LIMIT 1")
        .is_err()
    {
        bail!("Hermes messages table does not support stable rowid paging");
    }
    let columns = table_columns(&connection, "messages")?;
    let session_column = columns
        .iter()
        .find(|column| {
            matches!(
                column.as_str(),
                "session_id" | "sessionId" | "session" | "conversation_id" | "conversationId"
            )
        })
        .cloned()
        .context("Hermes messages table has no session column")?;
    let role = columns
        .iter()
        .find(|column| matches!(column.as_str(), "role" | "speaker"))
        .cloned()
        .context("Hermes messages table has no role column")?;
    let content = columns
        .iter()
        .find(|column| matches!(column.as_str(), "content" | "text" | "message"))
        .cloned()
        .context("Hermes messages table has no content column")?;
    let timestamp = columns
        .iter()
        .find(|column| matches!(column.as_str(), "created_at" | "timestamp" | "ts"))
        .map(|column| format!("CAST({} AS TEXT)", quote_identifier(column)))
        .unwrap_or_else(|| "NULL".to_owned());
    let role_expr = bounded_sql_text(&quote_identifier(&role), SQLITE_METADATA_CHARS);
    let timestamp_expr = bounded_sql_text(&timestamp, SQLITE_METADATA_CHARS);
    let status_expr = bounded_sql_text(&select_status_expr(&columns), SQLITE_METADATA_CHARS);
    let tool_name_expr = bounded_sql_text(
        &select_text_expr(&columns, &["tool_name", "toolName", "name", "tool"]),
        SQLITE_METADATA_CHARS,
    );
    let fields = SqliteFields {
        session_column: &session_column,
        role_expr: &role_expr,
        content_column: &content,
        timestamp_expr: &timestamp_expr,
        status_expr: &status_expr,
        tool_name_expr: &tool_name_expr,
    };
    let file_metadata = fs::metadata(path)
        .with_context(|| format!("Cannot stat Hermes database {}", path.display()))?;
    let db_identity = sqlite_identity(path, &file_metadata)?;
    let source_digest = sqlite_source_digest(path, session_id);
    let max_sql = format!(
        "SELECT COALESCE(MAX(rowid), 0) FROM messages WHERE CAST({} AS TEXT) = ?1",
        quote_identifier(&session_column)
    );
    let current_high_water =
        connection.query_row(&max_sql, [session_id], |row| row.get::<_, i64>(0))?;
    let current_anchor = if current_high_water > 0 {
        sqlite_anchor_digest(&connection, &fields, session_id, current_high_water)?
    } else {
        None
    };
    let cursor_anchor = if let Some(value) = cursor {
        match cursor_high_water_hint(value) {
            Some(high_water) if high_water > 0 => {
                sqlite_anchor_digest(&connection, &fields, session_id, high_water)?
            }
            _ => None,
        }
    } else {
        None
    };
    let validation_anchor = if cursor.is_some() {
        cursor_anchor.as_deref()
    } else {
        current_anchor.as_deref()
    };
    let parsed_cursor = cursor
        .map(|value| {
            parse_sqlite_cursor(
                value,
                &source_digest,
                db_identity,
                current_high_water,
                validation_anchor,
            )
        })
        .transpose()?;
    let high_water = parsed_cursor
        .as_ref()
        .map_or(current_high_water, |cursor| cursor.high_water);
    let before = parsed_cursor
        .as_ref()
        .map_or_else(|| high_water.saturating_add(1), |cursor| cursor.before);
    let page_limit = limit.clamp(1, SQLITE_PAGE_SIZE);
    let scan_limit = SQLITE_SCAN_LIMIT + 1;
    let content_expr = bounded_sql_text(&quote_identifier(&content), super::MAX_MESSAGE_BYTES + 1);
    let sql = format!(
        "SELECT rowid, {}, {}, {}, {}, {} FROM messages WHERE CAST({} AS TEXT) = ?1 AND rowid <= ?2 AND rowid < ?3 ORDER BY rowid DESC LIMIT ?4",
        role_expr,
        content_expr,
        timestamp_expr,
        status_expr,
        tool_name_expr,
        quote_identifier(&session_column),
    );
    let mut statement = connection.prepare(&sql)?;
    let mut rows = statement.query(rusqlite::params![
        session_id, high_water, before, scan_limit,
    ])?;
    let mut events = Vec::new();
    let mut has_more = false;
    let mut scanned_rows = 0usize;
    let mut last_scanned = None;
    let mut page_bytes = 0usize;
    while let Some(row) = rows.next()? {
        if scanned_rows >= SQLITE_SCAN_LIMIT as usize {
            has_more = true;
            break;
        }
        scanned_rows += 1;
        let rowid = row.get::<_, i64>(0)?;
        let previous_scanned = last_scanned;
        last_scanned = Some(rowid);
        let role = row.get::<_, Option<String>>(1)?.unwrap_or_default();
        let content = row.get::<_, Option<String>>(2)?.unwrap_or_default();
        let timestamp = row
            .get::<_, Option<String>>(3)?
            .as_deref()
            .and_then(parse_timestamp_text);
        let status = row
            .get::<_, Option<String>>(4)?
            .filter(|value| !value.trim().is_empty());
        let tool_name = row
            .get::<_, Option<String>>(5)?
            .filter(|value| !value.trim().is_empty());
        let (kind, tool_name, tool_status) = match role.as_str() {
            "user" => (ConversationEventKind::UserMessage, None, None),
            "assistant" | "agent" => (ConversationEventKind::AgentMessage, None, None),
            "tool" | "toolResult" | "tool_result" => (
                ConversationEventKind::ToolSummary,
                Some(tool_name.map_or_else(
                    || "tool".to_owned(),
                    |value| super::sanitize_tool_name(&value),
                )),
                status.map(|value| super::sanitize_tool_status(&value)),
            ),
            _ => continue,
        };
        if content.trim().is_empty() && kind != ConversationEventKind::ToolSummary {
            continue;
        }
        let remaining = SQLITE_MAX_PAGE_BYTES.saturating_sub(page_bytes);
        if remaining == 0 {
            last_scanned = previous_scanned;
            has_more = true;
            break;
        }
        let (content, truncated) =
            super::truncate_utf8(&content, remaining.min(super::MAX_MESSAGE_BYTES));
        if content.is_empty() && truncated {
            // The remaining bytes cannot hold even the first UTF-8 character.
            // Retry this row on the next page, including tool-result bodies.
            last_scanned = previous_scanned;
            has_more = true;
            break;
        }
        let content = (!content.is_empty()).then_some(content);
        if content.is_none() && kind != ConversationEventKind::ToolSummary {
            continue;
        }
        page_bytes = page_bytes.saturating_add(content.as_ref().map_or(0, String::len));
        events.push(ConversationEvent {
            id: format!("hermes-db-{rowid}"),
            kind,
            turn_id: None,
            message_phase: None,
            timestamp,
            content,
            tool_name,
            tool_status,
            duration_ms: None,
            attachment_count: 0,
            truncated,
        });
        if events.len() >= page_limit || page_bytes >= SQLITE_MAX_PAGE_BYTES {
            has_more = rows.next()?.is_some();
            break;
        }
    }
    let high_water_anchor = parsed_cursor
        .as_ref()
        .map(|cursor| cursor.anchor.clone())
        .or(cursor_anchor)
        .or(current_anchor)
        .unwrap_or_default();
    let next_cursor = has_more.then(|| {
        format!(
            "hermes-db-v2-{source_digest}-{high_water}-{}-{}-{}-{high_water_anchor}",
            last_scanned.unwrap_or(before),
            db_identity.0,
            db_identity.1
        )
    });
    events.reverse();
    Ok(ConversationEventPage {
        events,
        next_cursor,
        warnings: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    fn session_line(id: &str, cwd: &Path) -> String {
        serde_json::json!({
            "type": "session",
            "id": id,
            "cwd": cwd.to_string_lossy(),
        })
        .to_string()
    }

    #[test]
    fn merges_database_before_jsonl_for_same_profile_and_id() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("project");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(dir.path().join("sessions")).unwrap();
        let db = Connection::open(dir.path().join("state.db")).unwrap();
        db.execute_batch(
            "CREATE TABLE sessions(id TEXT, title TEXT, cwd TEXT, created_at INTEGER, updated_at INTEGER); CREATE TABLE messages(session_id TEXT, role TEXT, content TEXT, created_at INTEGER);",
        )
        .unwrap();
        db.execute(
            "INSERT INTO sessions VALUES ('same','DB title',?1,1700000000,1700000001)",
            [workspace.display().to_string()],
        )
        .unwrap();
        db.execute(
            "INSERT INTO messages VALUES ('same','user','from db',1700000000)",
            [],
        )
        .unwrap();
        fs::write(
            dir.path().join("sessions/same.jsonl"),
            format!(
                "{}\n{{\"role\":\"user\",\"content\":\"from jsonl\"}}\n",
                session_line("same", &workspace)
            ),
        )
        .unwrap();
        let provider = HermesProvider::with_home(dir.path().to_path_buf());
        let sessions = provider.list_sessions(&workspace).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].title.as_deref(), Some("DB title"));
        let page = provider
            .read_events(&sessions[0].native_ref, None, 50)
            .unwrap();
        assert_eq!(page.events[0].content.as_deref(), Some("from db"));
    }

    #[test]
    fn database_ownership_wins_before_workspace_filtering() {
        for sqlite_messages in [true, false] {
            let dir = tempdir().unwrap();
            let workspace = dir.path().join("owner");
            let stale_workspace = dir.path().join("stale");
            fs::create_dir_all(&workspace).unwrap();
            fs::create_dir_all(&stale_workspace).unwrap();
            fs::create_dir_all(dir.path().join("sessions")).unwrap();
            let db = Connection::open(dir.path().join("state.db")).unwrap();
            db.execute_batch("CREATE TABLE sessions(id TEXT, title TEXT, cwd TEXT);")
                .unwrap();
            db.execute(
                "INSERT INTO sessions VALUES ('same', 'DB title', ?1)",
                [workspace.display().to_string()],
            )
            .unwrap();
            if sqlite_messages {
                db.execute_batch(
                    "CREATE TABLE messages(session_id TEXT, role TEXT, content TEXT, created_at INTEGER);
                     INSERT INTO messages VALUES ('same', 'user', 'from db', 1700000000);",
                ).unwrap();
            }
            fs::write(
                dir.path().join("sessions/same.jsonl"),
                format!(
                    "{}\n{{\"role\":\"user\",\"content\":\"from jsonl\"}}\n",
                    session_line("same", &stale_workspace)
                ),
            )
            .unwrap();
            let provider = HermesProvider::with_home(dir.path().to_path_buf());
            let sessions = provider.list_sessions(&workspace).unwrap();
            assert_eq!(sessions.len(), 1);
            assert_eq!(sessions[0].title.as_deref(), Some("DB title"));
            assert!(provider.list_sessions(&stale_workspace).unwrap().is_empty());
            let resolved = provider.resolve(&sessions[0].native_ref).unwrap();
            assert_eq!(resolved.cwd.as_deref(), Some(workspace.as_path()));
            let page = provider
                .read_events(&sessions[0].native_ref, None, 50)
                .unwrap();
            assert_eq!(
                page.events[0].content.as_deref(),
                Some(if sqlite_messages {
                    "from db"
                } else {
                    "from jsonl"
                })
            );
        }
    }

    #[test]
    fn profile_identity_keeps_same_native_id_separate() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("project");
        fs::create_dir_all(&workspace).unwrap();
        for profile in ["default", "profiles/work"] {
            let root = if profile == "default" {
                dir.path().to_path_buf()
            } else {
                dir.path().join(profile)
            };
            fs::create_dir_all(root.join("sessions")).unwrap();
            fs::write(
                root.join("sessions/same.jsonl"),
                format!("{}\n", session_line("same", &workspace)),
            )
            .unwrap();
        }
        let sessions = HermesProvider::with_home(dir.path().to_path_buf())
            .list_sessions(&workspace)
            .unwrap();
        assert_eq!(sessions.len(), 2);
        assert_ne!(sessions[0].native_ref, sessions[1].native_ref);
    }

    #[test]
    fn unreadable_profile_enumeration_marks_default_listing_partial() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("project");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir(dir.path().join("sessions")).unwrap();
        fs::write(
            dir.path().join("sessions/one.jsonl"),
            session_line("one", &workspace),
        )
        .unwrap();
        let provider = HermesProvider::with_home(dir.path().to_path_buf());
        assert!(
            !provider
                .list_sessions_detailed(&workspace)
                .unwrap()
                .incomplete
        );
        // NotADirectory is a deterministic directory-read error, including when
        // tests run with privileges that would bypass chmod permission denial.
        fs::write(dir.path().join("profiles"), "not a directory").unwrap();
        let listing = provider.list_sessions_detailed(&workspace).unwrap();
        assert_eq!(listing.sessions.len(), 1);
        assert!(listing.incomplete);
    }

    #[test]
    fn sqlite_byte_budget_keeps_unrendered_utf8_row_for_next_page() {
        for remaining in [1, 2] {
            for role in ["user", "tool"] {
                let dir = tempdir().unwrap();
                let path = dir.path().join("state.db");
                let db = Connection::open(&path).unwrap();
                db.execute_batch(
                    "CREATE TABLE messages(session_id TEXT, role TEXT, content TEXT);",
                )
                .unwrap();
                db.execute("INSERT INTO messages VALUES ('s1', ?1, '中文')", [role])
                    .unwrap();
                db.execute_batch("INSERT INTO messages VALUES ('s1', 'system', 'hidden');")
                    .unwrap();
                for index in 0..8 {
                    let size =
                        super::super::MAX_MESSAGE_BYTES - if index == 0 { remaining } else { 0 };
                    db.execute(
                        "INSERT INTO messages VALUES ('s1', 'assistant', ?1)",
                        ["a".repeat(size)],
                    )
                    .unwrap();
                }
                let first = read_sqlite_events(&path, "s1", None, 50).unwrap();
                assert_eq!(first.events.len(), 8);
                let cursor = first
                    .next_cursor
                    .as_deref()
                    .expect("unrendered row needs another page");
                let second = read_sqlite_events(&path, "s1", Some(cursor), 50).unwrap();
                assert_eq!(second.events.len(), 1);
                assert_eq!(second.events[0].id, "hermes-db-1");
                assert_eq!(second.events[0].content.as_deref(), Some("中文"));
                assert!(!second.events[0].truncated);
                assert!(second.next_cursor.is_none());
            }
        }
    }

    #[test]
    fn sqlite_real_timestamps_survive_listing_and_history() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("project");
        fs::create_dir_all(&workspace).unwrap();
        let db = Connection::open(dir.path().join("state.db")).unwrap();
        db.execute_batch(
            "CREATE TABLE sessions(id TEXT, cwd TEXT, started_at REAL, ended_at REAL);
             CREATE TABLE messages(session_id TEXT, role TEXT, content TEXT, timestamp REAL);
             INSERT INTO messages VALUES ('s1', 'user', 'hello', 1788860000.5);",
        )
        .unwrap();
        db.execute(
            "INSERT INTO sessions VALUES ('s1', ?1, 1788860000.5, 1788860001.75)",
            [workspace.display().to_string()],
        )
        .unwrap();
        let provider = HermesProvider::with_home(dir.path().to_path_buf());
        let sessions = provider.list_sessions(&workspace).unwrap();
        assert_eq!(sessions[0].created_at.unwrap().timestamp(), 1788860000);
        assert_eq!(sessions[0].updated_at.unwrap().timestamp(), 1788860001);
        let page = provider
            .read_events(&sessions[0].native_ref, None, 50)
            .unwrap();
        assert_eq!(page.events[0].timestamp.unwrap().timestamp(), 1788860000);
        for value in [
            "1788860000",
            "1788860000000",
            "1788860000000.5",
            "2026-09-08T09:33:20Z",
        ] {
            assert_eq!(
                parse_timestamp_text(value).unwrap().timestamp(),
                1788860000,
                "{value}"
            );
        }
        for value in ["NaN", "inf", "-inf", "1e100", "-1e100", "invalid"] {
            assert!(parse_timestamp_text(value).is_none(), "{value}");
        }
    }

    #[test]
    fn sqlite_cursor_is_strict_and_freezes_high_water_on_append() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("project");
        fs::create_dir_all(&workspace).unwrap();
        let db = Connection::open(dir.path().join("state.db")).unwrap();
        db.execute_batch(
            "CREATE TABLE sessions(id TEXT, title TEXT, cwd TEXT); CREATE TABLE messages(session_id TEXT, role TEXT, content TEXT, created_at INTEGER);",
        )
        .unwrap();
        db.execute(
            "INSERT INTO sessions VALUES ('s1','DB',?1)",
            [workspace.display().to_string()],
        )
        .unwrap();
        for value in ["one", "two", "three"] {
            db.execute(
                "INSERT INTO messages VALUES ('s1','user',?1,1700000000)",
                [value],
            )
            .unwrap();
        }
        drop(db);

        let provider = HermesProvider::with_home(dir.path().to_path_buf());
        let native_ref = provider.list_sessions(&workspace).unwrap()[0]
            .native_ref
            .clone();
        let first = provider.read_events(&native_ref, None, 1).unwrap();
        assert_eq!(first.events[0].content.as_deref(), Some("three"));
        let cursor = first.next_cursor.clone().expect("second page");
        assert!(
            provider
                .read_events(&native_ref, Some("hermes-db-v1-1"), 1)
                .is_err()
        );
        let wrong_session = read_sqlite_events(
            &dir.path().join("state.db"),
            "other-session",
            Some(&cursor),
            1,
        )
        .unwrap_err()
        .to_string();
        assert!(wrong_session.contains("TRANSCRIPT_CURSOR_INVALID"));

        let db = Connection::open(dir.path().join("state.db")).unwrap();
        db.execute(
            "INSERT INTO messages VALUES ('s1','user','appended',1700000001)",
            [],
        )
        .unwrap();
        drop(db);
        let second = provider.read_events(&native_ref, Some(&cursor), 1).unwrap();
        assert_eq!(second.events[0].content.as_deref(), Some("two"));
        assert!(
            !second
                .events
                .iter()
                .any(|event| event.content.as_deref() == Some("appended"))
        );

        // Replacing the high-water row must invalidate the cursor even when
        // the database file and its maximum rowid remain unchanged.
        let db = Connection::open(dir.path().join("state.db")).unwrap();
        db.execute(
            "UPDATE messages SET content = 'rewritten' WHERE rowid = 3",
            [],
        )
        .unwrap();
        drop(db);
        let stale = provider
            .read_events(&native_ref, Some(&cursor), 1)
            .unwrap_err()
            .to_string();
        assert!(stale.contains("TRANSCRIPT_CURSOR_STALE"));
    }

    #[test]
    fn sqlite_identity_survives_append() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("state.db");
        fs::write(&path, b"initial").unwrap();
        let before = sqlite_identity(&path, &fs::metadata(&path).unwrap()).unwrap();
        fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"appended")
            .unwrap();
        let after = sqlite_identity(&path, &fs::metadata(&path).unwrap()).unwrap();
        assert_eq!(before, after);
    }

    #[test]
    fn sqlite_cursor_rejects_replaced_file_with_identical_contents() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("state.db");
        let db = Connection::open(&path).unwrap();
        db.execute_batch(
            "CREATE TABLE messages(session_id TEXT, role TEXT, content TEXT);
            INSERT INTO messages VALUES ('s1', 'user', 'one'), ('s1', 'user', 'two');",
        )
        .unwrap();
        drop(db);
        let page = read_sqlite_events(&path, "s1", None, 1).unwrap();
        let metadata = fs::metadata(&path).unwrap();
        let replacement = dir.path().join("replacement.db");
        fs::copy(&path, &replacement).unwrap();
        fs::File::options()
            .write(true)
            .open(&replacement)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(metadata.modified().unwrap()))
            .unwrap();
        // Retain the original file to prevent immediate file-ID reuse.
        fs::rename(&path, dir.path().join("original.db")).unwrap();
        fs::rename(&replacement, &path).unwrap();
        let error = read_sqlite_events(&path, "s1", page.next_cursor.as_deref(), 1).unwrap_err();
        assert!(error.to_string().contains("TRANSCRIPT_CURSOR_STALE"));
    }

    #[cfg(windows)]
    #[test]
    fn sqlite_identity_failure_is_not_a_shared_placeholder() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("state.db");
        fs::write(&path, "data").unwrap();
        let metadata = fs::metadata(&path).unwrap();
        fs::remove_file(&path).unwrap();
        assert!(sqlite_identity(&path, &metadata).is_err());
    }

    #[test]
    fn sqlite_skips_unknown_rows_without_losing_cross_page_events() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("project");
        fs::create_dir_all(&workspace).unwrap();
        let db = Connection::open(dir.path().join("state.db")).unwrap();
        db.execute_batch(
            "CREATE TABLE sessions(id TEXT, title TEXT, cwd TEXT); CREATE TABLE messages(session_id TEXT, role TEXT, content TEXT, created_at INTEGER);",
        )
        .unwrap();
        db.execute(
            "INSERT INTO sessions VALUES ('s1','DB',?1)",
            [workspace.display().to_string()],
        )
        .unwrap();
        db.execute(
            "INSERT INTO messages VALUES ('s1','user','one',1700000000)",
            [],
        )
        .unwrap();
        db.execute(
            "INSERT INTO messages VALUES ('s1','reasoning','private',1700000001)",
            [],
        )
        .unwrap();
        db.execute(
            "INSERT INTO messages VALUES ('s1','user','two',1700000002)",
            [],
        )
        .unwrap();
        drop(db);

        let provider = HermesProvider::with_home(dir.path().to_path_buf());
        let native_ref = provider.list_sessions(&workspace).unwrap()[0]
            .native_ref
            .clone();
        let first = provider.read_events(&native_ref, None, 1).unwrap();
        assert_eq!(first.events[0].content.as_deref(), Some("two"));
        let second = provider
            .read_events(&native_ref, first.next_cursor.as_deref(), 1)
            .unwrap();
        assert_eq!(second.events[0].content.as_deref(), Some("one"));
    }

    #[test]
    fn sqlite_bounds_large_tool_metadata_before_sanitizing() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("project");
        fs::create_dir_all(&workspace).unwrap();
        let db = Connection::open(dir.path().join("state.db")).unwrap();
        db.execute_batch(
            "CREATE TABLE sessions(id TEXT, title TEXT, cwd TEXT); CREATE TABLE messages(session_id TEXT, role TEXT, content TEXT, created_at TEXT, status TEXT, tool_name TEXT);",
        )
        .unwrap();
        db.execute(
            "INSERT INTO sessions VALUES ('s1','DB',?1)",
            [workspace.display().to_string()],
        )
        .unwrap();
        let huge = "x".repeat(2 * 1024 * 1024);
        db.execute(
            "INSERT INTO messages VALUES ('s1','tool','ok',?1,?2,?3)",
            rusqlite::params![huge, huge, huge],
        )
        .unwrap();
        drop(db);

        let provider = HermesProvider::with_home(dir.path().to_path_buf());
        let native_ref = provider.list_sessions(&workspace).unwrap()[0]
            .native_ref
            .clone();
        let page = provider.read_events(&native_ref, None, 1).unwrap();
        assert_eq!(page.events.len(), 1);
        assert_eq!(page.events[0].kind, ConversationEventKind::ToolSummary);
        assert!(page.events[0].tool_name.as_ref().unwrap().len() <= 200);
        assert_eq!(page.events[0].tool_status.as_deref(), Some("unknown"));
    }

    #[test]
    fn metadata_only_database_falls_back_to_jsonl_transcript() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("project");
        fs::create_dir_all(dir.path().join("sessions")).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        let db = Connection::open(dir.path().join("state.db")).unwrap();
        db.execute_batch("CREATE TABLE sessions(id TEXT, title TEXT, cwd TEXT);")
            .unwrap();
        db.execute(
            "INSERT INTO sessions VALUES ('same','DB title',?1)",
            [workspace.display().to_string()],
        )
        .unwrap();
        drop(db);
        fs::write(
            dir.path().join("sessions/same.jsonl"),
            format!(
                "{}\n{{\"role\":\"user\",\"content\":\"jsonl body\"}}\n",
                session_line("same", &workspace)
            ),
        )
        .unwrap();

        let provider = HermesProvider::with_home(dir.path().to_path_buf());
        let sessions = provider.list_sessions(&workspace).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].title.as_deref(), Some("DB title"));
        let page = provider
            .read_events(&sessions[0].native_ref, None, 50)
            .unwrap();
        assert_eq!(page.events[0].content.as_deref(), Some("jsonl body"));
    }
}
