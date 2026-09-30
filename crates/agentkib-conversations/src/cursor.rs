//! Read-only Cursor CLI store adapter. Wire fields were checked against the
//! official 2026.09.26-dd393fe package; this is not an IDE/Agents Window reader.
//! The generated `agent-transcripts` files are deliberately not used: they merge
//! thinking into text and omit tool results and source identities.

use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use agentkib_core::AgentKind;
use agentkib_platform::path as platform_path;
use anyhow::{Context, Result, bail, ensure};
use chrono::{DateTime, Utc};
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use sha2::{Digest, Sha256};
use walkdir::WalkDir;

use crate::continuation::finish_document;
use crate::history::{belongs_to_workspace, stable_native_ref};
use crate::{
    ConversationEvent, ConversationEventKind, ConversationEventPage, ConversationProvider,
    ConversationSessionSummary, HandoffContext, NativeSessionListing, NativeSessionSummary,
    SessionAvailability, SessionBlock, SessionDocument, SessionLossCode, SessionOrigin,
    SessionRole, SessionTurn,
};

const MAX_BLOB: usize = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 64 * 1024 * 1024;
const MAX_FIELDS: usize = 100_000;
const MAX_STORES: usize = 2_000;
const MAX_ENTRIES: usize = 20_000;

#[derive(Default)]
pub struct CursorProvider {
    config_dir: Option<PathBuf>,
}

struct Store {
    connection: Connection,
    metadata: Value,
    root: Vec<u8>,
    root_id: String,
    read_bytes: usize,
}

struct LocatedStore {
    path: PathBuf,
    native_ref: String,
    title: Option<String>,
    created_at: Option<DateTime<Utc>>,
    updated_at: Option<DateTime<Utc>>,
}

impl CursorProvider {
    fn config_dir(&self) -> Option<PathBuf> {
        self.config_dir.clone().or_else(|| {
            env::var_os("CURSOR_CONFIG_DIR")
                .filter(|value| !value.to_string_lossy().trim().is_empty())
                .map(PathBuf::from)
                .or_else(|| {
                    env::var_os("XDG_CONFIG_HOME")
                        .filter(|value| !value.to_string_lossy().trim().is_empty())
                        .map(|value| PathBuf::from(value).join("cursor"))
                })
                .or_else(|| dirs::home_dir().map(|home| home.join(".cursor")))
        })
    }

    fn collect(&self, workspace: Option<&Path>) -> Result<(Vec<LocatedStore>, bool)> {
        let Some(config) = self.config_dir() else {
            return Ok((Vec::new(), false));
        };
        let chats = config.join("chats");
        if !chats.exists() {
            return Ok((Vec::new(), false));
        }
        ensure!(
            platform_path::is_safe_scan_entry(&config),
            "Unsafe Cursor config directory"
        );
        ensure!(
            platform_path::is_safe_scan_entry(&chats),
            "Unsafe Cursor chats directory"
        );
        let mut stores = Vec::new();
        let mut incomplete = false;
        let mut inspected = 0;
        for (index, entry) in WalkDir::new(&chats)
            .max_depth(3)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| platform_path::is_safe_scan_entry(entry.path()))
            .enumerate()
        {
            if index >= MAX_ENTRIES || inspected >= MAX_STORES {
                incomplete = true;
                break;
            }
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    incomplete = true;
                    continue;
                }
            };
            if entry.depth() != 3 || entry.file_name() != "store.db" || !entry.file_type().is_file()
            {
                continue;
            }
            inspected += 1;
            let store = match Store::open(entry.path()) {
                Ok(store) => store,
                Err(_) => {
                    incomplete = true;
                    continue;
                }
            };
            let workspaces = match store.workspaces() {
                Ok(workspaces) => workspaces,
                Err(_) => {
                    incomplete = true;
                    continue;
                }
            };
            if workspace.is_some_and(|workspace| {
                !workspaces
                    .iter()
                    .any(|path| belongs_to_workspace(path, workspace))
            }) {
                continue;
            }
            let relative = entry.path().strip_prefix(&chats)?.to_string_lossy();
            stores.push(LocatedStore {
                path: entry.path().to_owned(),
                native_ref: stable_native_ref(
                    "cursor-cli",
                    &[&config.to_string_lossy(), &relative],
                ),
                title: store
                    .metadata
                    .get("name")
                    .and_then(Value::as_str)
                    .map(|title| title.chars().take(crate::MAX_TITLE_CHARS).collect()),
                created_at: store
                    .metadata
                    .get("createdAt")
                    .and_then(Value::as_i64)
                    .and_then(DateTime::from_timestamp_millis),
                updated_at: entry
                    .metadata()
                    .ok()
                    .and_then(|meta| meta.modified().ok())
                    .map(Into::into),
            });
        }
        stores.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.native_ref.cmp(&right.native_ref))
        });
        Ok((stores, incomplete))
    }

    fn resolve(&self, native_ref: &str) -> Result<LocatedStore> {
        self.collect(None)?
            .0
            .into_iter()
            .find(|store| store.native_ref == native_ref)
            .context("Cursor CLI session is unavailable or its native format is unsupported")
    }

    fn read(
        &self,
        native_ref: &str,
    ) -> Result<(Vec<SessionTurn>, BTreeMap<SessionLossCode, usize>, String)> {
        let located = self.resolve(native_ref)?;
        let mut store = Store::open(&located.path)?;
        let (turns, losses) = store.turns()?;
        Ok((turns, losses, store.root_id))
    }
}

impl ConversationProvider for CursorProvider {
    fn agent(&self) -> AgentKind {
        AgentKind::Cursor
    }

    fn list_sessions(&self, workspace: &Path) -> Result<Vec<NativeSessionSummary>> {
        Ok(self.list_sessions_detailed(workspace)?.sessions)
    }

    fn list_sessions_detailed(&self, workspace: &Path) -> Result<NativeSessionListing> {
        let (stores, incomplete) = self.collect(Some(workspace))?;
        Ok(NativeSessionListing {
            sessions: stores
                .into_iter()
                .map(|store| NativeSessionSummary {
                    native_ref: store.native_ref,
                    agent: AgentKind::Cursor,
                    title: store.title,
                    origin: SessionOrigin::Interactive,
                    spawned_by_session_id: None,
                    forked_from_session_id: None,
                    created_at: store.created_at,
                    updated_at: store.updated_at,
                    message_count: None,
                    git_branch: None,
                    archived: false,
                    sidechain: false,
                    availability: SessionAvailability::Readable,
                })
                .collect(),
            incomplete,
        })
    }

    fn read_events(
        &self,
        native_ref: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<ConversationEventPage> {
        let (turns, losses, root_id) = self.read(native_ref)?;
        let offset = match cursor {
            None => 0,
            Some(cursor) => {
                let (root, offset) = cursor
                    .split_once(':')
                    .context("Invalid Cursor history cursor")?;
                ensure!(
                    root == root_id,
                    "Cursor CLI history changed; reload the first page"
                );
                offset
                    .parse::<usize>()
                    .context("Invalid Cursor history offset")?
            }
        };
        ensure!(
            offset <= turns.len(),
            "Cursor history offset is out of range"
        );
        let mut end = offset;
        let mut bytes = 0;
        let mut events = Vec::new();
        // History pages start at the newest turn; the cursor loads older records.
        for turn in turns.iter().rev().skip(offset).take(limit.clamp(1, 200)) {
            let item = event(turn);
            let size = item.content.as_ref().map_or(0, String::len);
            if !events.is_empty() && bytes + size > crate::MAX_PAGE_BYTES {
                break;
            }
            bytes += size;
            events.push(item);
            end += 1;
        }
        events.reverse();
        Ok(ConversationEventPage {
            events,
            next_cursor: (end < turns.len()).then(|| format!("{root_id}:{end}")),
            warnings: warnings(&losses),
        })
    }

    fn read_handoff_context(&self, native_ref: &str) -> Result<HandoffContext> {
        let (turns, losses, _) = self.read(native_ref)?;
        Ok(HandoffContext {
            compact_summary: None,
            messages: turns.iter().map(event).collect(),
            omitted_tool_count: losses
                .get(&SessionLossCode::SourceContentTruncated)
                .copied()
                .unwrap_or(0),
            warnings: warnings(&losses),
        })
    }

    fn read_session_document(
        &self,
        source: &ConversationSessionSummary,
        native_ref: &str,
        home: Option<&Path>,
    ) -> Result<SessionDocument> {
        ensure!(
            source.agent == AgentKind::Cursor,
            "Cursor source agent mismatch"
        );
        let (turns, losses, _) = self.read(native_ref)?;
        finish_document(source, turns, losses, home)
    }
}

fn event(turn: &SessionTurn) -> ConversationEvent {
    let content = turn
        .blocks
        .iter()
        .filter_map(|block| match block {
            SessionBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    let truncated = content.len() > crate::MAX_MESSAGE_BYTES;
    let mut end = content.len().min(crate::MAX_MESSAGE_BYTES);
    while !content.is_char_boundary(end) {
        end -= 1;
    }
    ConversationEvent {
        id: turn.id.clone(),
        kind: if turn.role == SessionRole::User {
            ConversationEventKind::UserMessage
        } else {
            ConversationEventKind::AgentMessage
        },
        turn_id: None,
        message_phase: None,
        timestamp: turn.timestamp,
        content: Some(content[..end].to_owned()),
        tool_name: None,
        tool_status: None,
        duration_ms: None,
        attachment_count: 0,
        truncated,
    }
}

fn warnings(losses: &BTreeMap<SessionLossCode, usize>) -> Vec<String> {
    let mut warnings = Vec::new();
    if losses.contains_key(&SessionLossCode::SourceContentTruncated) {
        warnings.push(
            "Cursor CLI tool and selected-context records are omitted from this text-only adapter"
                .into(),
        );
    }
    if losses.contains_key(&SessionLossCode::ReasoningExcluded) {
        warnings.push("Cursor CLI reasoning is excluded".into());
    }
    warnings
}

impl Store {
    fn open(path: &Path) -> Result<Self> {
        for entry in path.ancestors().take(5) {
            ensure!(
                platform_path::is_safe_scan_entry(entry),
                "Unsafe Cursor store path"
            );
        }
        for suffix in ["-wal", "-shm"] {
            let companion = PathBuf::from(format!("{}{suffix}", path.display()));
            if fs::symlink_metadata(&companion).is_ok() {
                ensure!(
                    platform_path::is_safe_scan_entry(&companion),
                    "Unsafe Cursor SQLite sidecar"
                );
            }
        }
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        connection.busy_timeout(Duration::from_millis(100))?;
        // A single read transaction pins metadata and its content-addressed graph
        // to one snapshot while Cursor writes its next checkpoint.
        connection.execute_batch("BEGIN DEFERRED")?;
        let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        ensure!(version == 1, "Unsupported Cursor CLI database version");
        let size: i64 = connection.query_row(
            "SELECT length(value) FROM meta WHERE key = '0'",
            [],
            |row| row.get(0),
        )?;
        ensure!(
            (0..=131_072).contains(&size),
            "Cursor metadata exceeds read limit"
        );
        let encoded: String =
            connection.query_row("SELECT value FROM meta WHERE key = '0'", [], |row| {
                row.get(0)
            })?;
        let metadata: Value = serde_json::from_slice(&hex::decode(encoded)?)?;
        let root_id = metadata
            .get("latestRootBlobId")
            .and_then(Value::as_str)
            .context("Cursor root identity is absent")?
            .to_owned();
        let root_ref = hex::decode(&root_id)?;
        let mut store = Self {
            connection,
            metadata,
            root: Vec::new(),
            root_id,
            read_bytes: 0,
        };
        store.root = store.blob(&root_ref)?;
        // Validate now, including workspace ownership, before advertising history.
        fields(&store.root)?;
        Ok(store)
    }

    fn blob(&mut self, reference: &[u8]) -> Result<Vec<u8>> {
        ensure!(reference.len() == 32, "Unsupported Cursor blob identity");
        let key = hex::encode(reference);
        let size: i64 = self
            .connection
            .query_row(
                "SELECT length(data) FROM blobs WHERE id = ?1",
                [&key],
                |row| row.get(0),
            )
            .context("Cursor history references a missing blob")?;
        ensure!(
            (0..=MAX_BLOB as i64).contains(&size),
            "Cursor blob exceeds read limit"
        );
        self.read_bytes = self
            .read_bytes
            .checked_add(size as usize)
            .context("Cursor byte limit overflow")?;
        ensure!(
            self.read_bytes <= MAX_TOTAL_BYTES,
            "Cursor history exceeds read limit"
        );
        let bytes: Vec<u8> =
            self.connection
                .query_row("SELECT data FROM blobs WHERE id = ?1", [&key], |row| {
                    row.get(0)
                })?;
        ensure!(bytes.len() == size as usize, "Cursor blob length changed");
        ensure!(
            Sha256::digest(&bytes).as_slice() == reference,
            "Cursor blob hash mismatch or unsupported encrypted storage"
        );
        Ok(bytes)
    }

    fn workspaces(&self) -> Result<Vec<PathBuf>> {
        let root = fields(&self.root)?;
        let paths: Vec<_> = root
            .iter()
            .filter(|field| field.number == 9)
            .map(|field| {
                let uri = std::str::from_utf8(field.bytes()?)?;
                platform_path::file_uri_to_path(uri).context("Cursor workspace URI is unsupported")
            })
            .collect::<Result<_>>()?;
        ensure!(
            !paths.is_empty(),
            "Cursor history lacks verified workspace ownership (older CLI stores unsupported)"
        );
        Ok(paths)
    }

    fn turns(&mut self) -> Result<(Vec<SessionTurn>, BTreeMap<SessionLossCode, usize>)> {
        self.workspaces()?;
        let root = fields(&self.root)?;
        // Compaction changes the relation between turns and summary archives.
        // Refuse it until the complete archive chain is supported; never silently
        // turn a summary or partial tail into an original transcript.
        ensure!(
            !root.iter().any(|field| matches!(field.number, 6 | 11 | 13)),
            "Cursor compacted history/archive import is not supported"
        );
        ensure!(
            !root.iter().any(|field| field.number == 2),
            "Legacy Cursor turns are not supported"
        );
        let references = root
            .iter()
            .filter(|field| field.number == 8)
            .map(|field| field.bytes().map(<[u8]>::to_vec))
            .collect::<Result<Vec<_>>>()?;
        ensure!(
            !references.is_empty(),
            "Cursor history contains no native conversation turns"
        );
        let mut turns = Vec::new();
        let mut losses = BTreeMap::new();
        for reference in references {
            let bytes = self.blob(&reference)?;
            let turn = fields(&bytes)?;
            ensure!(turn.len() == 1, "Unknown Cursor conversation turn variant");
            if turn[0].number == 2 {
                *losses
                    .entry(SessionLossCode::SourceContentTruncated)
                    .or_default() += 1;
                continue;
            }
            ensure!(turn[0].number == 1, "Unknown Cursor conversation turn type");
            let agent = fields(turn[0].bytes()?)?;
            let user_ref = required_bytes(&agent, 1)?;
            let user_blob = self.blob(user_ref)?;
            let user = fields(&user_blob)?;
            let simulated = user
                .iter()
                .find(|field| field.number == 5)
                .map(|field| field.varint())
                .transpose()?
                .unwrap_or(0)
                != 0;
            if !simulated {
                let mut text = string(&user, 1)?.unwrap_or_default();
                if let Some(reference) = optional_bytes(&user, 18)? {
                    let hydrated = String::from_utf8(self.blob(reference)?)
                        .context("Unsupported Cursor user text blob encoding")?;
                    ensure!(
                        text.is_empty() || text == hydrated,
                        "Cursor user text representations disagree"
                    );
                    text = hydrated;
                }
                ensure!(
                    !text.is_empty(),
                    "Cursor user message has no supported text"
                );
                if user.iter().any(|field| field.number == 3) {
                    *losses
                        .entry(SessionLossCode::SourceContentTruncated)
                        .or_default() += 1;
                }
                push_text(&mut turns, SessionRole::User, text, timestamp(&user, 25)?);
            }
            for step in agent.iter().filter(|field| field.number == 2) {
                let bytes = self.blob(step.bytes()?)?;
                let fields = fields(&bytes)?;
                ensure!(
                    fields.len() == 1,
                    "Unknown Cursor conversation step variant"
                );
                match fields[0].number {
                    1 => {
                        let message = self::fields(fields[0].bytes()?)?;
                        let text =
                            string(&message, 1)?.context("Cursor assistant message lacks text")?;
                        if !text.is_empty() {
                            push_text(
                                &mut turns,
                                SessionRole::Assistant,
                                text,
                                timestamp(&message, 2)?,
                            );
                        }
                    }
                    2 => {
                        *losses
                            .entry(SessionLossCode::SourceContentTruncated)
                            .or_default() += 1
                    }
                    3 => {
                        *losses
                            .entry(SessionLossCode::ReasoningExcluded)
                            .or_default() += 1
                    }
                    _ => bail!("Unknown Cursor conversation step type"),
                }
            }
        }
        ensure!(
            !turns.is_empty(),
            "Cursor history has no supported original messages"
        );
        Ok((turns, losses))
    }
}

fn push_text(
    turns: &mut Vec<SessionTurn>,
    role: SessionRole,
    text: String,
    timestamp: Option<DateTime<Utc>>,
) {
    turns.push(SessionTurn {
        id: format!("cursor-{}", turns.len()),
        role,
        timestamp,
        blocks: vec![SessionBlock::Text { text }],
    });
}

#[derive(Clone, Copy)]
struct Field<'a> {
    number: u64,
    wire: u8,
    data: &'a [u8],
}
impl Field<'_> {
    fn bytes(&self) -> Result<&[u8]> {
        ensure!(self.wire == 2, "Unexpected Cursor protobuf field wire type");
        Ok(self.data)
    }
    fn varint(&self) -> Result<u64> {
        ensure!(
            self.wire == 0,
            "Unexpected Cursor protobuf integer wire type"
        );
        let mut input = self.data;
        read_varint(&mut input)
    }
}
fn read_varint(input: &mut &[u8]) -> Result<u64> {
    let mut result = 0;
    for shift in (0..70).step_by(7) {
        let byte = *input.first().context("Truncated Cursor protobuf integer")?;
        *input = &input[1..];
        ensure!(
            shift != 63 || byte <= 1,
            "Overflowed Cursor protobuf integer"
        );
        result |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Ok(result);
        }
    }
    bail!("Overflowed Cursor protobuf integer")
}
fn fields(mut input: &[u8]) -> Result<Vec<Field<'_>>> {
    let mut fields = Vec::new();
    while !input.is_empty() {
        ensure!(
            fields.len() < MAX_FIELDS,
            "Cursor protobuf field limit exceeded"
        );
        let tag = read_varint(&mut input)?;
        let number = tag >> 3;
        ensure!(
            number > 0 && number < (1 << 29),
            "Invalid Cursor protobuf field number"
        );
        let wire = (tag & 7) as u8;
        let length = match wire {
            0 => {
                let original = input;
                read_varint(&mut input)?;
                fields.push(Field {
                    number,
                    wire,
                    data: &original[..original.len() - input.len()],
                });
                continue;
            }
            1 => 8,
            2 => usize::try_from(read_varint(&mut input)?)
                .context("Cursor protobuf length overflow")?,
            5 => 4,
            _ => bail!("Unsupported Cursor protobuf wire encoding"),
        };
        ensure!(length <= input.len(), "Truncated Cursor protobuf field");
        fields.push(Field {
            number,
            wire,
            data: &input[..length],
        });
        input = &input[length..];
    }
    Ok(fields)
}
fn optional_bytes<'a>(fields: &'a [Field<'a>], number: u64) -> Result<Option<&'a [u8]>> {
    let mut matches = fields.iter().filter(|field| field.number == number);
    let value = matches.next().map(Field::bytes).transpose()?;
    ensure!(matches.next().is_none(), "Duplicate Cursor singular field");
    Ok(value)
}
fn required_bytes<'a>(fields: &'a [Field<'a>], number: u64) -> Result<&'a [u8]> {
    optional_bytes(fields, number)?.context("Required Cursor protobuf field is absent")
}
fn string(fields: &[Field<'_>], number: u64) -> Result<Option<String>> {
    optional_bytes(fields, number)?
        .map(|bytes| String::from_utf8(bytes.to_vec()).context("Cursor text is not valid UTF-8"))
        .transpose()
}
fn timestamp(fields: &[Field<'_>], number: u64) -> Result<Option<DateTime<Utc>>> {
    fields
        .iter()
        .find(|field| field.number == number)
        .map(|field| {
            let value = i64::try_from(field.varint()?).context("Cursor timestamp overflow")?;
            DateTime::from_timestamp_millis(value).context("Invalid Cursor timestamp")
        })
        .transpose()
}

#[cfg(test)]
pub(super) fn matrix_document() -> SessionDocument {
    let (temp, _path, workspace) = tests::fixture();
    let provider = CursorProvider {
        config_dir: Some(temp.path().into()),
    };
    let sessions = provider.list_sessions(&workspace).unwrap();
    provider
        .read_session_document(
            &crate::hermes::fixture_source(AgentKind::Cursor),
            &sessions[0].native_ref,
            None,
        )
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    fn encoded_field(number: u8, bytes: &[u8]) -> Vec<u8> {
        let mut output = vec![(number << 3) | 2];
        let mut length = bytes.len();
        loop {
            let byte = (length & 0x7f) as u8;
            length >>= 7;
            output.push(if length == 0 { byte } else { byte | 0x80 });
            if length == 0 {
                break;
            }
        }
        output.extend(bytes);
        output
    }

    pub(super) fn fixture() -> (TempDir, PathBuf, PathBuf) {
        let temp = TempDir::new().unwrap();
        let workspace = temp.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let path = temp
            .path()
            .join("chats/hash/80a61793-41d1-4641-bc66-413f0ab22ba4/store.db");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let fixture: Value =
            serde_json::from_str(include_str!("../tests/fixtures/cursor-cli-2026-09-26.json"))
                .unwrap();
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch("PRAGMA user_version=1; CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE blobs(id TEXT PRIMARY KEY,data BLOB);").unwrap();
        for (id, bytes) in fixture["blobs"].as_object().unwrap() {
            connection
                .execute(
                    "INSERT INTO blobs VALUES (?1,?2)",
                    rusqlite::params![id, hex::decode(bytes.as_str().unwrap()).unwrap()],
                )
                .unwrap();
        }
        let mut metadata = fixture["metadata"].clone();
        let root = hex::decode(
            fixture["blobs"][metadata["latestRootBlobId"].as_str().unwrap()]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        let root_fields = fields(&root).unwrap();
        let mut root = encoded_field(8, required_bytes(&root_fields, 8).unwrap());
        // Canonicalize the fixture directory only: macOS /var is a symlink.
        let uri = format!("file://{}", fs::canonicalize(&workspace).unwrap().display());
        root.extend(encoded_field(9, uri.as_bytes()));
        let root_id = hex::encode(Sha256::digest(&root));
        connection
            .execute(
                "INSERT INTO blobs VALUES (?1,?2)",
                rusqlite::params![&root_id, root],
            )
            .unwrap();
        metadata["latestRootBlobId"] = json!(root_id);
        connection
            .execute(
                "INSERT INTO meta VALUES ('0',?1)",
                [hex::encode(serde_json::to_vec(&metadata).unwrap())],
            )
            .unwrap();
        (temp, path, workspace)
    }

    fn source() -> ConversationSessionSummary {
        ConversationSessionSummary {
            id: "cursor-test".into(),
            workspace_id: "workspace".into(),
            agent: AgentKind::Cursor,
            title: Some("Cursor test".into()),
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
        }
    }

    fn rewrite_root(path: &Path, modify: impl FnOnce(Vec<u8>) -> Vec<u8>) {
        let connection = Connection::open(path).unwrap();
        let meta: String = connection
            .query_row("SELECT value FROM meta", [], |row| row.get(0))
            .unwrap();
        let mut meta: Value = serde_json::from_slice(&hex::decode(meta).unwrap()).unwrap();
        let root: Vec<u8> = connection
            .query_row(
                "SELECT data FROM blobs WHERE id=?1",
                [meta["latestRootBlobId"].as_str().unwrap()],
                |row| row.get(0),
            )
            .unwrap();
        let root = modify(root);
        let id = hex::encode(Sha256::digest(&root));
        connection
            .execute(
                "INSERT OR REPLACE INTO blobs VALUES (?1,?2)",
                rusqlite::params![&id, root],
            )
            .unwrap();
        meta["latestRootBlobId"] = json!(id);
        connection
            .execute(
                "UPDATE meta SET value=?1",
                [hex::encode(serde_json::to_vec(&meta).unwrap())],
            )
            .unwrap();
    }

    #[test]
    fn official_serializer_fixture_preserves_messages_and_excludes_reasoning() {
        let (temp, path, workspace) = fixture();
        let before = fs::read(&path).unwrap();
        let provider = CursorProvider {
            config_dir: Some(temp.path().into()),
        };
        let sessions = provider.list_sessions(&workspace).unwrap();
        assert_eq!(sessions.len(), 1);
        let document = provider
            .read_session_document(&source(), &sessions[0].native_ref, None)
            .unwrap();
        assert_eq!(document.turns.len(), 2);
        assert_eq!(document.turns[0].role, SessionRole::User);
        assert_eq!(document.turns[1].role, SessionRole::Assistant);
        let output = serde_json::to_string(&document).unwrap();
        assert!(output.contains("KIB-CURSOR-73"));
        assert!(!output.contains("PRIVATE_REASONING"));
        assert_eq!(document.losses[0].code, SessionLossCode::ReasoningExcluded);
        assert_eq!(fs::read(path).unwrap(), before);
    }

    #[test]
    fn cursor_is_pinned_to_root_and_loads_older_pages_in_source_order() {
        let (temp, path, workspace) = fixture();
        let provider = CursorProvider {
            config_dir: Some(temp.path().into()),
        };
        let native_ref = provider.list_sessions(&workspace).unwrap()[0]
            .native_ref
            .clone();
        let first = provider.read_events(&native_ref, None, 1).unwrap();
        assert_eq!(first.events[0].kind, ConversationEventKind::AgentMessage);
        let cursor = first.next_cursor.unwrap();
        let second = provider.read_events(&native_ref, Some(&cursor), 1).unwrap();
        assert_eq!(second.events[0].kind, ConversationEventKind::UserMessage);
        assert!(second.next_cursor.is_none());
        let full = provider.read_events(&native_ref, None, 2).unwrap();
        assert_eq!(
            serde_json::to_value(&full.events).unwrap(),
            serde_json::to_value([second.events, first.events].concat()).unwrap()
        );
        assert!(full.next_cursor.is_none());
        rewrite_root(&path, |mut root| {
            root.extend(encoded_field(7, &[3; 32]));
            root
        });
        assert!(provider.read_events(&native_ref, Some(&cursor), 1).is_err());
    }

    #[test]
    fn compacted_and_unowned_history_are_rejected() {
        let (temp, path, workspace) = fixture();
        rewrite_root(&path, |mut root| {
            root.extend(encoded_field(13, &[1; 32]));
            root
        });
        assert!(
            Store::open(&path)
                .unwrap()
                .turns()
                .unwrap_err()
                .to_string()
                .contains("compacted")
        );
        rewrite_root(&path, |root| {
            let root = fields(&root).unwrap();
            encoded_field(8, required_bytes(&root, 8).unwrap())
        });
        let provider = CursorProvider {
            config_dir: Some(temp.path().into()),
        };
        let listing = provider.list_sessions_detailed(&workspace).unwrap();
        assert!(listing.sessions.is_empty());
        assert!(listing.incomplete);
    }

    #[test]
    fn missing_and_corrupted_blobs_do_not_silently_drop_messages() {
        let (_temp, path, _workspace) = fixture();
        let connection = Connection::open(&path).unwrap();
        let user = b"Remember marker KIB-CURSOR-73; choose SQLite.";
        let mut record = encoded_field(1, user);
        record.extend(encoded_field(2, b"message-user-1"));
        let id = hex::encode(Sha256::digest(&record));
        connection
            .execute("UPDATE blobs SET data=x'0000' WHERE id=?1", [&id])
            .unwrap();
        assert!(
            Store::open(&path)
                .unwrap()
                .turns()
                .unwrap_err()
                .to_string()
                .contains("hash mismatch")
        );
        connection
            .execute("DELETE FROM blobs WHERE id=?1", [&id])
            .unwrap();
        assert!(
            Store::open(&path)
                .unwrap()
                .turns()
                .unwrap_err()
                .to_string()
                .contains("missing blob")
        );
    }

    #[test]
    fn workspace_scope_and_opaque_refs_are_checked() {
        let (temp, _path, _workspace) = fixture();
        let other = temp.path().join("other");
        fs::create_dir(&other).unwrap();
        let provider = CursorProvider {
            config_dir: Some(temp.path().into()),
        };
        assert!(provider.list_sessions(&other).unwrap().is_empty());
        assert!(provider.read_events("../../private", None, 10).is_err());
    }

    #[test]
    fn malformed_and_oversized_wire_data_is_rejected() {
        assert!(fields(&[0]).is_err());
        assert!(fields(&[10, 99, 1]).is_err());
        assert!(fields(&[11]).is_err());
        assert!(fields(&[0xff; 11]).is_err());
        let (_temp, path, _workspace) = fixture();
        Connection::open(&path)
            .unwrap()
            .execute_batch("PRAGMA user_version=2")
            .unwrap();
        assert!(Store::open(&path).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_stores_are_not_read() {
        let (temp, path, workspace) = fixture();
        let moved = temp.path().join("external.db");
        fs::rename(&path, &moved).unwrap();
        std::os::unix::fs::symlink(moved, path).unwrap();
        let provider = CursorProvider {
            config_dir: Some(temp.path().into()),
        };
        assert!(provider.list_sessions(&workspace).unwrap().is_empty());
    }
}
