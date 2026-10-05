//! Fixed Cursor IDE 3.22.12 export-v1 codec and read-only registered-profile reader.
//! The protobuf fields were checked against that product's agent.v1 descriptors:
//! root.prompt_messages=1, turns=8, workspace_uris=9; turn.agent=1; agent.user=1/steps=2;
//! user.text=1/message_id=2 and step.assistant=1/assistant.text=1.
//! No Cursor database is written here, and no profile is discovered implicitly.
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use agentkib_core::AgentKind;
use agentkib_platform::path as platform_path;
use anyhow::{Context, Result, bail, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{DateTime, Utc};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::cursor::{
    MAX_BLOB, MAX_TOTAL_BYTES, fields, optional_bytes, required_bytes, string, timestamp,
};
use crate::history::stable_native_ref;
use crate::{
    NativeSessionListing, NativeSessionSummary, SessionAvailability, SessionBlock, SessionDocument,
    SessionLoss, SessionLossCode, SessionOrigin, SessionRole, SessionTurn,
};

pub const CURSOR_IDE_VERSION: &str = "3.22.12";
const MAX_HEADERS: usize = 2_000;
const MAX_JSON: usize = 16 * 1024 * 1024;
const MAX_HEADER: usize = 256 * 1024;
const MAX_PAYLOAD: usize = 96 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CursorIdeProfile {
    pub id: String,
    pub db_path: PathBuf,
    pub version: String,
    pub workspace: PathBuf,
}

impl CursorIdeProfile {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.version == CURSOR_IDE_VERSION,
            "Unverified Cursor IDE version"
        );
        ensure!(
            !self.id.is_empty()
                && self.id.len() <= 128
                && self
                    .id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
            "Invalid Cursor IDE profile identity"
        );
        ensure!(
            self.workspace.is_absolute()
                && fs::canonicalize(&self.workspace)? == self.workspace
                && self.workspace.is_dir(),
            "Cursor IDE workspace must be a canonical local directory"
        );
        ensure!(
            self.db_path.is_absolute()
                && self.db_path.file_name().is_some_and(|n| n == "state.vscdb"),
            "Invalid Cursor IDE database path"
        );
        safe_database_path(&self.db_path)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CursorIdeIdentity {
    pub native_id: String,
    pub title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CursorIdeImportPayload {
    pub payload: String,
    pub expected: SessionDocument,
    pub marker: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Export {
    version: u32,
    conversation_state: String,
    blobs: BTreeMap<String, String>,
    name: String,
    exported_at: i64,
}

struct Graph {
    root: Vec<u8>,
    blobs: BTreeMap<String, Vec<u8>>,
    total_bytes: usize,
}

impl Graph {
    fn from_export(payload: &str) -> Result<(Self, Export)> {
        ensure!(
            payload.len() <= MAX_PAYLOAD,
            "Cursor IDE payload exceeds size limit"
        );
        let export: Export = serde_json::from_str(payload)?;
        ensure!(export.version == 1, "Unverified Cursor IDE export version");
        ensure!(
            export.blobs.len() <= crate::cursor::MAX_FIELDS,
            "Cursor IDE blob count exceeds limit"
        );
        let root = decode_base64(&export.conversation_state)?;
        let mut blobs = BTreeMap::new();
        let mut total = root.len();
        for (id, encoded) in &export.blobs {
            validate_blob_id(id)?;
            let bytes = decode_base64(encoded)?;
            ensure!(
                hex::encode(Sha256::digest(&bytes)) == *id,
                "Cursor IDE blob hash mismatch"
            );
            total = total
                .checked_add(bytes.len())
                .context("Cursor IDE byte limit overflow")?;
            ensure!(
                total <= MAX_TOTAL_BYTES,
                "Cursor IDE graph exceeds size limit"
            );
            blobs.insert(id.clone(), bytes);
        }
        Ok((
            Self {
                root,
                blobs,
                total_bytes: total,
            },
            export,
        ))
    }

    fn blob(&self, reference: &[u8]) -> Result<Vec<u8>> {
        ensure!(
            reference.len() == 32,
            "Unsupported Cursor IDE blob reference"
        );
        self.blobs
            .get(&hex::encode(reference))
            .cloned()
            .context("Cursor IDE history references a missing blob")
    }
}

/// Project executable records to historical prose; preserve all user/assistant
/// text in order. A user turn can have zero or many assistant steps in this schema.
pub fn prepare_cursor_ide_import(
    document: &SessionDocument,
    operation_id: &str,
    workspace: &Path,
) -> Result<CursorIdeImportPayload> {
    ensure!(
        document.schema_version == crate::SESSION_DOCUMENT_SCHEMA_VERSION,
        "Unsupported source document schema"
    );
    let operation = Uuid::parse_str(operation_id).context("Cursor IDE operation must be a UUID")?;
    ensure!(
        workspace.is_absolute() && fs::canonicalize(workspace)? == workspace && workspace.is_dir(),
        "Cursor IDE import requires a canonical local workspace"
    );
    let marker = format!("AgentKib {operation}");
    let mut expected = document.clone();
    expected.turns = vec![SessionTurn {
        id: "agentkib-import-notice".into(),
        role: SessionRole::User,
        timestamp: document.source.created_at,
        blocks: vec![SessionBlock::Text {
            text: crate::import_notice().into(),
        }],
    }];
    let mut tools = 0;
    let mut attachments = 0;
    let mut meaningful = false;
    for turn in &document.turns {
        let mut parts = Vec::new();
        for block in &turn.blocks {
            parts.push(match block {
                SessionBlock::Text { text } if turn.role != SessionRole::Tool => {
                    meaningful |= !text.trim().is_empty();
                    text.clone()
                }
                SessionBlock::Text { .. } => {
                    tools += 1;
                    "[Historical tool output omitted]".into()
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
            });
        }
        ensure!(
            !parts.is_empty() && parts.iter().all(|p| !p.is_empty()),
            "Cursor IDE cannot preserve an empty source text message"
        );
        expected.turns.push(SessionTurn {
            id: turn.id.clone(),
            role: if turn.role == SessionRole::User {
                SessionRole::User
            } else {
                SessionRole::Assistant
            },
            timestamp: turn.timestamp,
            blocks: vec![SessionBlock::Text {
                text: parts.join("\n\n"),
            }],
        });
    }
    ensure!(
        meaningful,
        "Cursor IDE import requires non-empty conversation text"
    );
    for (code, count) in [
        (SessionLossCode::TargetToolSummary, tools),
        (SessionLossCode::TargetAttachmentOmitted, attachments),
    ] {
        if count > 0 {
            if let Some(loss) = expected.losses.iter_mut().find(|loss| loss.code == code) {
                loss.count += count;
            } else {
                expected.losses.push(SessionLoss { code, count });
            }
        }
    }
    expected.losses.sort_by_key(|loss| loss.code);
    let mut graph = Graph {
        root: Vec::new(),
        blobs: BTreeMap::new(),
        total_bytes: 0,
    };
    let mut agent = Vec::new();
    for (index, turn) in expected.turns.iter().enumerate() {
        let SessionBlock::Text { text } = &turn.blocks[0] else {
            unreachable!("text projection")
        };
        // Cursor renders turns but resumes the model from a separate JSON
        // prompt history. Populating only turns produces a readable empty-context
        // conversation. Both representations consume the same frozen projection.
        let prompt = serde_json::to_vec(&serde_json::json!({
            "role": if turn.role == SessionRole::User { "user" } else { "assistant" },
            "content": [{"type": "text", "text": text}]
        }))?;
        let reference = add_blob(&mut graph, prompt)?;
        graph.root.extend(field(1, &reference));
        if turn.role == SessionRole::User {
            if !agent.is_empty() {
                let reference = add_blob(&mut graph, field(1, &agent))?;
                graph.root.extend(field(8, &reference));
            }
            let mut user = field(1, text.as_bytes());
            user.extend(field(2, format!("agentkib-{operation}-{index}").as_bytes()));
            if let Some(time) = turn.timestamp {
                user.extend(integer(
                    25,
                    u64::try_from(time.timestamp_millis())
                        .context("Cursor IDE cannot represent a negative message timestamp")?,
                ));
            }
            let reference = add_blob(&mut graph, user)?;
            agent = field(1, &reference);
        } else {
            ensure!(
                !agent.is_empty(),
                "Cursor IDE assistant history has no preceding user turn"
            );
            let mut message = field(1, text.as_bytes());
            if let Some(time) = turn.timestamp {
                message.extend(integer(
                    2,
                    u64::try_from(time.timestamp_millis())
                        .context("Cursor IDE cannot represent a negative message timestamp")?,
                ));
            }
            let reference = add_blob(&mut graph, field(1, &message))?;
            agent.extend(field(2, &reference));
        }
    }
    let reference = add_blob(&mut graph, field(1, &agent))?;
    graph.root.extend(field(8, &reference));
    graph
        .root
        .extend(field(9, workspace_uri(workspace)?.as_bytes()));
    graph.root = cursor_import_root(&graph.root)?;
    ensure!(
        graph.root.len() <= MAX_BLOB,
        "Cursor IDE root exceeds size limit"
    );
    ensure!(
        graph.total_bytes + graph.root.len() <= MAX_TOTAL_BYTES,
        "Cursor IDE graph exceeds size limit"
    );
    let (decoded, losses) = decode_graph(&graph.root, |r| graph.blob(r))?;
    verify_prompt_projection(&graph, &expected.turns)?;
    ensure!(
        losses.is_empty() && same_prefix(&expected.turns, &decoded, true),
        "Cursor IDE projection cannot preserve the conversation"
    );
    let export = Export {
        version: 1,
        conversation_state: STANDARD.encode(&graph.root),
        blobs: graph
            .blobs
            .iter()
            .map(|(id, b)| (id.clone(), STANDARD.encode(b)))
            .collect(),
        name: marker.clone(),
        exported_at: document
            .source
            .created_at
            .map_or(0, |time| time.timestamp_millis().max(0)),
    };
    let payload = serde_json::to_string_pretty(&export)?;
    Graph::from_export(&payload)?;
    Ok(CursorIdeImportPayload {
        payload,
        expected,
        marker,
    })
}

fn add_blob(graph: &mut Graph, bytes: Vec<u8>) -> Result<Vec<u8>> {
    ensure!(
        bytes.len() <= MAX_BLOB,
        "Cursor IDE blob exceeds size limit"
    );
    let id = Sha256::digest(&bytes).to_vec();
    let key = hex::encode(&id);
    if !graph.blobs.contains_key(&key) {
        graph.total_bytes = graph
            .total_bytes
            .checked_add(bytes.len())
            .context("Cursor IDE byte limit overflow")?;
        ensure!(
            graph.blobs.len() < crate::cursor::MAX_FIELDS && graph.total_bytes <= MAX_TOTAL_BYTES,
            "Cursor IDE graph exceeds size limit"
        );
        graph.blobs.insert(key, bytes);
    }
    Ok(id)
}

fn field(number: u64, bytes: &[u8]) -> Vec<u8> {
    let mut output = varint((number << 3) | 2);
    output.extend(varint(bytes.len() as u64));
    output.extend(bytes);
    output
}

fn varint(mut value: u64) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let byte = (value & 127) as u8;
        value >>= 7;
        out.push(if value == 0 { byte } else { byte | 128 });
        if value == 0 {
            return out;
        }
    }
}

fn integer(number: u64, value: u64) -> Vec<u8> {
    let mut output = varint(number << 3);
    output.extend(varint(value));
    output
}

fn cursor_import_root(root: &[u8]) -> Result<Vec<u8>> {
    // Cursor 3.22.12's protobuf serializer emits each repeated field together,
    // in descriptor order. Older frozen plans interleaved prompt and UI refs.
    // Re-encode only that known export shape; preserve every value and the order
    // within each field. Actual roots and all blobs still require exact bytes.
    let parsed = fields(root)?;
    ensure!(
        parsed.iter().all(|f| matches!(f.number, 1 | 8 | 9))
            && parsed.iter().filter(|f| f.number == 9).count() == 1,
        "Unsupported Cursor IDE import root shape"
    );
    root_workspaces(root)?;
    let mut original = Vec::new();
    for f in &parsed {
        original.extend(field(f.number, f.bytes()?));
    }
    ensure!(
        original == root,
        "Non-canonical Cursor IDE import root wire encoding"
    );
    let mut encoded = Vec::new();
    for number in [1, 8, 9] {
        for f in parsed.iter().filter(|f| f.number == number) {
            let bytes = f.bytes()?;
            ensure!(
                number == 9 || bytes.len() == 32,
                "Invalid Cursor IDE import root reference"
            );
            encoded.extend(field(number, bytes));
        }
    }
    Ok(encoded)
}

fn ide_timestamp(input: &[crate::cursor::Field<'_>], number: u64) -> Result<Option<DateTime<Utc>>> {
    ensure!(
        input.iter().filter(|f| f.number == number).count() <= 1,
        "Duplicate Cursor IDE timestamp"
    );
    timestamp(input, number)
}

fn workspace_uri(workspace: &Path) -> Result<String> {
    let path = workspace
        .to_str()
        .context("Cursor IDE workspace is not valid UTF-8")?;
    let mut uri = String::from("file://");
    for byte in path.as_bytes() {
        if byte.is_ascii_alphanumeric() || b"/-._~:".contains(byte) {
            uri.push(*byte as char);
        } else {
            uri.push_str(&format!("%{byte:02X}"));
        }
    }
    Ok(uri)
}

fn decode_base64(value: &str) -> Result<Vec<u8>> {
    ensure!(
        value.len() <= MAX_BLOB.div_ceil(3) * 4,
        "Cursor IDE encoded blob exceeds size limit"
    );
    let bytes = STANDARD
        .decode(value)
        .context("Invalid Cursor IDE base64 blob")?;
    ensure!(
        bytes.len() <= MAX_BLOB,
        "Cursor IDE blob exceeds size limit"
    );
    Ok(bytes)
}

fn validate_blob_id(id: &str) -> Result<()> {
    ensure!(
        id.len() == 64
            && id
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "Invalid Cursor IDE blob identity"
    );
    Ok(())
}

fn root_workspaces(root: &[u8]) -> Result<Vec<PathBuf>> {
    let root = fields(root)?;
    ensure!(
        !root.iter().any(|f| matches!(f.number, 6 | 11 | 13)),
        "Cursor IDE compacted history/archive is unsupported"
    );
    ensure!(
        root.iter()
            .all(|f| matches!(f.number, 1 | 3..=10 | 12 | 14..=39)),
        "Unknown Cursor IDE root field"
    );
    let paths = root
        .iter()
        .filter(|f| f.number == 9)
        .map(|f| {
            let uri = std::str::from_utf8(f.bytes()?)?;
            platform_path::file_uri_to_path(uri).context("Unsupported Cursor IDE workspace URI")
        })
        .collect::<Result<Vec<_>>>()?;
    ensure!(
        !paths.is_empty(),
        "Cursor IDE history lacks workspace ownership"
    );
    Ok(paths)
}

fn decode_graph(
    root: &[u8],
    blob: impl FnMut(&[u8]) -> Result<Vec<u8>>,
) -> Result<(Vec<SessionTurn>, BTreeMap<SessionLossCode, usize>)> {
    decode_graph_with_prompt_filter(root, blob, None)
}

fn decode_graph_with_prompt_filter(
    root: &[u8],
    mut blob: impl FnMut(&[u8]) -> Result<Vec<u8>>,
    prompt_filter: Option<&BTreeSet<Vec<u8>>>,
) -> Result<(Vec<SessionTurn>, BTreeMap<SessionLossCode, usize>)> {
    root_workspaces(root)?;
    let root = fields(root)?;
    let mut turns = Vec::new();
    let mut losses = BTreeMap::new();
    // Check referenced prompt blobs too, without exporting private system/rule
    // context as source messages. Exact import readback must cover both graphs.
    for reference in root.iter().filter(|f| f.number == 1) {
        let reference = reference.bytes()?;
        ensure!(
            reference.len() == 32,
            "Invalid Cursor IDE prompt blob reference"
        );
        if prompt_filter.is_none_or(|required| required.contains(reference)) {
            blob(reference)?;
        }
    }
    // Root/system context is deliberately excluded, but data which can contain
    // omitted history or another conversation is not advertised as complete.
    ensure!(
        !root
            .iter()
            .any(|f| matches!(f.number, 16 | 23 | 24 | 25 | 28..=32 | 35 | 36)),
        "Cursor IDE subagent/goal/context history is unsupported"
    );
    for reference in root.iter().filter(|f| f.number == 8) {
        let turn_bytes = blob(reference.bytes()?)?;
        let turn = fields(&turn_bytes)?;
        ensure!(
            turn.len() == 1 && turn[0].number == 1,
            "Unsupported Cursor IDE conversation turn"
        );
        let agent = fields(turn[0].bytes()?)?;
        ensure!(
            agent.iter().all(|f| (1..=10).contains(&f.number)),
            "Unknown Cursor IDE agent turn field"
        );
        let user_bytes = blob(required_bytes(&agent, 1)?)?;
        let user = fields(&user_bytes)?;
        ensure!(
            user.iter()
                .all(|f| matches!(f.number, 1..=11 | 13..=19 | 21..=27)),
            "Unknown Cursor IDE user message field"
        );
        ensure!(
            user.iter().filter(|f| f.number == 5).count() <= 1,
            "Duplicate Cursor IDE simulated-message field"
        );
        let simulated = user
            .iter()
            .find(|f| f.number == 5)
            .map(|f| f.varint())
            .transpose()?
            .unwrap_or(0)
            != 0;
        if !simulated {
            let mut text = string(&user, 1)?.unwrap_or_default();
            if let Some(reference) = optional_bytes(&user, 18)? {
                let hydrated = String::from_utf8(blob(reference)?)
                    .context("Invalid Cursor IDE text blob UTF-8")?;
                ensure!(
                    text.is_empty() || text == hydrated,
                    "Cursor IDE text representations disagree"
                );
                text = hydrated;
            }
            ensure!(
                !text.is_empty(),
                "Cursor IDE user message has no supported text"
            );
            if user
                .iter()
                .any(|f| matches!(f.number, 3 | 8 | 11 | 14 | 15 | 19 | 21 | 23 | 27))
            {
                *losses
                    .entry(SessionLossCode::SourceContentTruncated)
                    .or_default() += 1;
            }
            push_turn(
                &mut turns,
                SessionRole::User,
                text,
                ide_timestamp(&user, 25)?,
            );
        }
        for step in agent.iter().filter(|f| f.number == 2) {
            let step_bytes = blob(step.bytes()?)?;
            let step = fields(&step_bytes)?;
            ensure!(
                step.len() == 1,
                "Unknown Cursor IDE conversation step variant"
            );
            match step[0].number {
                1 => {
                    let message = fields(step[0].bytes()?)?;
                    ensure!(
                        message.iter().all(|f| (1..=3).contains(&f.number)),
                        "Unknown Cursor IDE assistant message field"
                    );
                    let text =
                        string(&message, 1)?.context("Cursor IDE assistant message lacks text")?;
                    ensure!(
                        !text.is_empty(),
                        "Cursor IDE assistant message has empty text"
                    );
                    push_turn(
                        &mut turns,
                        SessionRole::Assistant,
                        text,
                        ide_timestamp(&message, 2)?,
                    );
                }
                2 => {
                    *losses
                        .entry(SessionLossCode::SourceContentTruncated)
                        .or_default() += 1;
                }
                3 => {
                    *losses
                        .entry(SessionLossCode::ReasoningExcluded)
                        .or_default() += 1;
                }
                _ => bail!("Unknown Cursor IDE conversation step type"),
            }
        }
    }
    ensure!(
        !turns.is_empty(),
        "Cursor IDE history has no supported original messages"
    );
    Ok((turns, losses))
}

fn push_turn(
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

fn safe_database_path(path: &Path) -> Result<()> {
    for ancestor in path.ancestors() {
        ensure!(
            platform_path::is_safe_scan_entry(ancestor),
            "Unsafe Cursor IDE database path"
        );
    }
    ensure!(
        fs::symlink_metadata(path)?.is_file() && fs::canonicalize(path)? == path,
        "Cursor IDE database must be a canonical regular file"
    );
    for suffix in ["-wal", "-shm"] {
        let sidecar = PathBuf::from(format!("{}{suffix}", path.display()));
        if fs::symlink_metadata(&sidecar).is_ok() {
            ensure!(
                platform_path::is_safe_scan_entry(&sidecar)
                    && fs::symlink_metadata(sidecar)?.is_file(),
                "Unsafe Cursor IDE SQLite sidecar"
            );
        }
    }
    Ok(())
}

struct Database {
    connection: Connection,
    bytes: usize,
}
struct Header {
    id: String,
    title: Option<String>,
    workspace_id: String,
    created: Option<DateTime<Utc>>,
    updated: Option<DateTime<Utc>>,
}

impl Database {
    fn open(profile: &CursorIdeProfile) -> Result<Self> {
        profile.validate()?;
        let connection = Connection::open_with_flags(
            &profile.db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        connection.busy_timeout(Duration::from_millis(100))?;
        connection.execute_batch("BEGIN DEFERRED")?;
        let version: i64 = connection.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        ensure!(version == 1, "Unverified Cursor IDE database version");
        for (table, expected) in [
            ("cursorDiskKV", vec!["key", "value"]),
            (
                "composerHeaders",
                vec![
                    "composerId",
                    "workspaceId",
                    "createdAt",
                    "lastUpdatedAt",
                    "isArchived",
                    "isSubagent",
                    "recency",
                    "checkpointAt",
                    "subagentTypeName",
                    "value",
                ],
            ),
        ] {
            let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
            let columns = statement
                .query_map([], |r| r.get::<_, String>(1))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            ensure!(columns == expected, "Unverified Cursor IDE database schema");
        }
        Ok(Self {
            connection,
            bytes: 0,
        })
    }

    fn bytes(&mut self, table: &str, key_column: &str, key: &str, limit: usize) -> Result<Vec<u8>> {
        let (size, count): (i64, i64) = self.connection.query_row(
            &format!(
                "SELECT COALESCE(MAX(length(value)),0), COUNT(*) FROM {table} WHERE {key_column}=?1"
            ),
            [key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        ensure!(count == 1, "Cursor IDE record is missing or ambiguous");
        ensure!(
            size >= 0 && size as usize <= limit,
            "Cursor IDE record exceeds size limit"
        );
        self.bytes = self
            .bytes
            .checked_add(size as usize)
            .context("Cursor IDE byte limit overflow")?;
        ensure!(
            self.bytes <= MAX_TOTAL_BYTES,
            "Cursor IDE graph exceeds size limit"
        );
        self.connection
            .query_row(
                &format!("SELECT value FROM {table} WHERE {key_column}=?1"),
                [key],
                |r| Ok(r.get_ref(0)?.as_bytes()?.to_vec()),
            )
            .map_err(Into::into)
    }

    fn header(&mut self, profile: &CursorIdeProfile, id: &str) -> Result<Header> {
        ensure!(
            Uuid::parse_str(id)?.to_string() == id,
            "Invalid Cursor IDE session identity"
        );
        let bytes = self.bytes("composerHeaders", "composerId", id, MAX_HEADER)?;
        let value: Value = serde_json::from_slice(&bytes)?;
        self.parse_header(profile, id, &value)
    }

    fn parse_header(&self, profile: &CursorIdeProfile, id: &str, value: &Value) -> Result<Header> {
        ensure!(
            value.get("composerId").and_then(Value::as_str) == Some(id),
            "Cursor IDE header identity mismatch"
        );
        ensure!(
            value
                .get("source")
                .is_none_or(|s| s.as_str() == Some("local"))
                && value.get("subagentInfo").is_none_or(Value::is_null)
                && !value.get("isEphemeral").is_some_and(|v| v == true),
            "Unsupported Cursor IDE product surface or subagent"
        );
        let workspace_id = value
            .pointer("/workspaceIdentifier/id")
            .and_then(Value::as_str)
            .context("Cursor IDE header lacks workspace identity")?
            .to_owned();
        let owned = json_workspace(value)?;
        ensure!(
            owned == profile.workspace,
            "Cursor IDE header belongs to another workspace"
        );
        let (indexed_workspace, archived, subagent, created, updated): (String, i64, i64, Option<i64>, Option<i64>) = self.connection.query_row("SELECT workspaceId,isArchived,isSubagent,createdAt,lastUpdatedAt FROM composerHeaders WHERE composerId=?1", [id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)))?;
        ensure!(
            indexed_workspace == workspace_id
                && archived == 0
                && subagent == 0
                && !value.get("isArchived").is_some_and(|v| v == true),
            "Cursor IDE index ownership or archive mismatch"
        );
        Ok(Header {
            id: id.into(),
            title: value
                .get("name")
                .and_then(Value::as_str)
                .and_then(|name| crate::sanitize_title(Some(name))),
            workspace_id,
            created: created.and_then(DateTime::from_timestamp_millis),
            updated: updated.and_then(DateTime::from_timestamp_millis),
        })
    }

    fn is_empty_window_placeholder(&mut self, id: &str, value: &Value) -> Result<bool> {
        // Cursor 3.22.12 draftIds.js defines empty-state-draft; workspace.js
        // serializes an empty-window identifier as {id}, without a folder URI.
        // Only the observed empty sentinel/timestamp-window shapes are skipped.
        // A missing URI alone must never hide a damaged real conversation.
        let Some(workspace) = value.get("workspaceIdentifier").and_then(Value::as_object) else {
            return Ok(false);
        };
        let Some(workspace_id) = workspace.get("id").and_then(Value::as_str) else {
            return Ok(false);
        };
        let sentinel = id == "empty-state-draft" && workspace_id == "empty-window";
        let empty_window = Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == id)
            && workspace_id.len() == 13
            && workspace_id.bytes().all(|byte| byte.is_ascii_digit());
        if !(sentinel || empty_window) || workspace.len() != 1 {
            return Ok(false);
        }
        ensure!(
            value.get("composerId").and_then(Value::as_str) == Some(id)
                && value.get("type").and_then(Value::as_str) == Some("head")
                && value.get("isDraft").and_then(Value::as_bool) == Some(sentinel)
                && value
                    .get("name")
                    .is_none_or(|name| name.as_str() == Some(""))
                && value
                    .get("source")
                    .is_none_or(|source| source.as_str() == Some("local"))
                && value.get("subagentInfo").is_none_or(Value::is_null)
                && [
                    "isEphemeral",
                    "isArchived",
                    "isWorktree",
                    "isSpec",
                    "isProject",
                    "isBestOfNSubcomposer"
                ]
                .iter()
                .all(|key| {
                    value
                        .get(*key)
                        .is_none_or(|flag| flag.as_bool() == Some(false))
                }),
            "Invalid Cursor empty-window header"
        );
        let (indexed_workspace, archived, subagent): (String, i64, i64) =
            self.connection.query_row(
                "SELECT workspaceId,isArchived,isSubagent FROM composerHeaders WHERE composerId=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
        ensure!(
            indexed_workspace == workspace_id && archived == 0 && subagent == 0,
            "Cursor empty-window index mismatch"
        );
        let bytes = self.bytes(
            "cursorDiskKV",
            "key",
            &format!("composerData:{id}"),
            MAX_JSON,
        )?;
        let composer: Value = serde_json::from_slice(&bytes)?;
        ensure!(
            composer.get("composerId").and_then(Value::as_str) == Some(id)
                && composer.get("_v").and_then(Value::as_u64) == Some(18)
                && composer.get("isDraft").and_then(Value::as_bool) == Some(sentinel)
                && composer.get("status").and_then(Value::as_str) == Some("none")
                && composer.get("text").and_then(Value::as_str) == Some("")
                && composer.get("richText").and_then(Value::as_str) == Some("")
                && composer.get("conversationState").and_then(Value::as_str) == Some("~")
                && composer
                    .get("fullConversationHeadersOnly")
                    .and_then(Value::as_array)
                    .is_some_and(Vec::is_empty)
                && composer
                    .get("conversationMap")
                    .and_then(Value::as_object)
                    .is_some_and(serde_json::Map::is_empty)
                && if sentinel {
                    composer.get("workspaceIdentifier") == value.get("workspaceIdentifier")
                } else {
                    composer
                        .get("workspaceIdentifier")
                        .is_none_or(|body_workspace| {
                            body_workspace.is_null()
                                || body_workspace == &value["workspaceIdentifier"]
                        })
                },
            "Cursor empty-window placeholder contains unsupported conversation data"
        );
        Ok(true)
    }

    fn headers(&mut self, profile: &CursorIdeProfile) -> Result<(Vec<Header>, bool)> {
        let mut statement = self
            .connection
            .prepare("SELECT composerId FROM composerHeaders ORDER BY composerId LIMIT ?1")?;
        let mut ids = statement
            .query_map([MAX_HEADERS as i64 + 1], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        let mut incomplete = ids.len() > MAX_HEADERS;
        ids.truncate(MAX_HEADERS);
        let mut headers = Vec::new();
        for id in ids {
            // The observed header URI authorizes ownership. Do not infer a
            // workspace ID from a hash algorithm or read other workspaces' blobs.
            let result = (|| -> Result<Option<Header>> {
                let bytes = self.bytes("composerHeaders", "composerId", &id, MAX_HEADER)?;
                let value: Value = serde_json::from_slice(&bytes)?;
                if self.is_empty_window_placeholder(&id, &value)? {
                    return Ok(None);
                }
                ensure!(
                    Uuid::parse_str(&id)?.to_string() == id,
                    "Invalid Cursor IDE session identity"
                );
                if json_workspace(&value)? != profile.workspace {
                    return Ok(None);
                }
                let (_, archived, subagent): (Option<String>, i64, i64) = self.connection.query_row("SELECT workspaceId,isArchived,isSubagent FROM composerHeaders WHERE composerId=?1", [&id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
                if archived != 0
                    || subagent != 0
                    || value
                        .get("source")
                        .is_some_and(|s| s.as_str() != Some("local"))
                    || value.get("isEphemeral").is_some_and(|v| v == true)
                    || value.get("subagentInfo").is_some_and(|v| !v.is_null())
                {
                    return Ok(None);
                }
                self.parse_header(profile, &id, &value).map(Some)
            })();
            match result {
                Ok(Some(header)) => headers.push(header),
                Ok(None) => {}
                Err(_) => incomplete = true,
            }
        }
        Ok((headers, incomplete))
    }

    fn read(
        &mut self,
        profile: &CursorIdeProfile,
        header: &Header,
    ) -> Result<(Vec<SessionTurn>, BTreeMap<SessionLossCode, usize>, Graph)> {
        self.read_with_prompt_filter(profile, header, None)
    }

    fn read_with_prompt_filter(
        &mut self,
        profile: &CursorIdeProfile,
        header: &Header,
        prompt_filter: Option<&BTreeSet<Vec<u8>>>,
    ) -> Result<(Vec<SessionTurn>, BTreeMap<SessionLossCode, usize>, Graph)> {
        // Bound each conversation graph independently from the header scan.
        self.bytes = 0;
        let bytes = self.bytes(
            "cursorDiskKV",
            "key",
            &format!("composerData:{}", header.id),
            MAX_JSON,
        )?;
        let value: Value = serde_json::from_slice(&bytes)?;
        ensure!(
            value.get("composerId").and_then(Value::as_str) == Some(header.id.as_str())
                && value.get("_v").and_then(Value::as_u64) == Some(18),
            "Unverified Cursor IDE composer identity or version"
        );
        ensure!(
            json_workspace(&value)? == profile.workspace
                && value
                    .pointer("/workspaceIdentifier/id")
                    .and_then(Value::as_str)
                    == Some(&header.workspace_id),
            "Cursor IDE composer workspace mismatch"
        );
        ensure!(
            value
                .get("source")
                .is_none_or(|s| s.as_str() == Some("local"))
                && value.get("subagentInfo").is_none_or(Value::is_null),
            "Unsupported Cursor IDE composer surface"
        );
        let encoded = value
            .get("conversationState")
            .and_then(Value::as_str)
            .and_then(|s| s.strip_prefix('~'))
            .context("Cursor IDE conversation root is unavailable or encrypted")?;
        let root = decode_base64(encoded)?;
        ensure!(
            root_workspaces(&root)?
                .iter()
                .all(|p| *p == profile.workspace),
            "Cursor IDE conversation workspace mismatch"
        );
        let mut graph = Graph {
            total_bytes: root.len(),
            root,
            blobs: BTreeMap::new(),
        };
        let (turns, losses) = decode_graph_with_prompt_filter(
            &graph.root,
            |reference| {
                ensure!(reference.len() == 32, "Invalid Cursor IDE blob reference");
                let id = hex::encode(reference);
                if let Some(bytes) = graph.blobs.get(&id) {
                    return Ok(bytes.clone());
                }
                let bytes = self.bytes(
                    "cursorDiskKV",
                    "key",
                    &format!("agentKv:blob:{id}"),
                    MAX_BLOB,
                )?;
                ensure!(
                    Sha256::digest(&bytes).as_slice() == reference,
                    "Cursor IDE blob hash mismatch or unsupported encrypted storage"
                );
                graph.blobs.insert(id, bytes.clone());
                Ok(bytes)
            },
            prompt_filter,
        )?;
        Ok((turns, losses, graph))
    }
}

fn json_workspace(value: &Value) -> Result<PathBuf> {
    let uri = value
        .pointer("/workspaceIdentifier/uri")
        .context("Cursor IDE workspace URI is absent")?;
    ensure!(
        uri.get("scheme").and_then(Value::as_str) == Some("file"),
        "Cursor IDE remote workspace is unsupported"
    );
    let external = uri
        .get("external")
        .and_then(Value::as_str)
        .context("Cursor IDE workspace URL is absent")?;
    let path =
        platform_path::file_uri_to_path(external).context("Invalid Cursor IDE workspace URL")?;
    ensure!(
        uri.get("fsPath")
            .and_then(Value::as_str)
            .is_none_or(|p| Path::new(p) == path),
        "Cursor IDE workspace URI representations disagree"
    );
    Ok(path)
}

pub fn list_cursor_ide_identities(profile: &CursorIdeProfile) -> Result<Vec<CursorIdeIdentity>> {
    let mut db = Database::open(profile)?;
    let (headers, incomplete) = db.headers(profile)?;
    ensure!(!incomplete, "Cursor IDE identity listing is incomplete");
    Ok(headers
        .into_iter()
        .map(|h| CursorIdeIdentity {
            native_id: h.id,
            title: h.title,
        })
        .collect())
}

/// Match a regenerated payload against a frozen plan, allowing only Cursor's
/// verified grouping of protobuf root fields. Never rewrite the frozen plan.
pub fn reviewed_cursor_ide_import_payload_matches(prepared: &str, reviewed: &str) -> Result<bool> {
    if prepared == reviewed {
        return Ok(true);
    }
    let (graph, mut export) = Graph::from_export(reviewed)?;
    ensure!(
        serde_json::to_string_pretty(&export)? == reviewed,
        "Cursor IDE reviewed payload encoding differs from generated format"
    );
    export.conversation_state = STANDARD.encode(cursor_import_root(&graph.root)?);
    Ok(serde_json::to_string_pretty(&export)? == prepared)
}

type RecoveryPromptVariants = BTreeMap<Vec<u8>, (Vec<u8>, Vec<u8>)>;

fn recovery_prompt_variants(
    reviewed: &Graph,
    expected: &[SessionTurn],
) -> Result<RecoveryPromptVariants> {
    let references = prompt_references(&reviewed.root)?;
    ensure!(
        references.len() == expected.len(),
        "Missing reviewed model history"
    );
    let mut variants = BTreeMap::new();
    for (reference, turn) in references.into_iter().zip(expected) {
        let original = reviewed.blob(&reference)?;
        variants.insert(reference.clone(), (reference.clone(), original.clone()));
        if turn.role != SessionRole::Assistant {
            continue;
        }
        let [SessionBlock::Text { text }] = turn.blocks.as_slice() else {
            bail!("Unsupported reviewed assistant projection");
        };
        // Fixed 3.22.12 reserializes imported assistant prompts on reply. Only
        // this observed compact UTF-8 object-key order is an alternate encoding.
        // Never parse an actual/private prompt or accept generic JSON equality.
        let generated = serde_json::to_vec(&serde_json::json!({
            "role":"assistant", "content":[{"type":"text", "text":text}]
        }))?;
        ensure!(
            original == generated,
            "Unverified reviewed assistant JSON encoding"
        );
        let alternate = format!(
            "{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":{}}}]}}",
            serde_json::to_string(text)?
        )
        .into_bytes();
        let alternate_reference = Sha256::digest(&alternate).to_vec();
        variants.insert(alternate_reference, (reference, alternate));
    }
    Ok(variants)
}

pub fn verify_cursor_ide_import(
    profile: &CursorIdeProfile,
    payload: &str,
    expected: &SessionDocument,
    marker: &str,
    known_native_id: Option<&str>,
    before_native_ids: &[String],
    exact: bool,
) -> Result<String> {
    let (reviewed, export) = Graph::from_export(payload)?;
    ensure!(
        export.name == marker
            && root_workspaces(&reviewed.root)?
                .iter()
                .all(|p| *p == profile.workspace),
        "Cursor IDE import marker or workspace mismatch"
    );
    let (projected, losses) = decode_graph(&reviewed.root, |r| reviewed.blob(r))?;
    verify_prompt_projection(&reviewed, &expected.turns)?;
    ensure!(
        losses.is_empty() && same_prefix(&expected.turns, &projected, true),
        "Cursor IDE payload differs from reviewed text"
    );
    let mut db = Database::open(profile)?;
    let header = if let Some(id) = known_native_id {
        db.header(profile, id)?
    } else {
        let (headers, incomplete) = db.headers(profile)?;
        ensure!(
            !incomplete,
            "Cursor IDE import identity cannot be determined from partial headers"
        );
        let candidates = headers
            .into_iter()
            .filter(|h| {
                !before_native_ids.contains(&h.id)
                    && h.title
                        .as_deref()
                        .is_some_and(|t| t == marker || t.strip_prefix("(1) ") == Some(marker))
            })
            .collect::<Vec<_>>();
        ensure!(
            candidates.len() == 1,
            "Cursor IDE imported identity is missing or ambiguous"
        );
        candidates.into_iter().next().expect("one candidate")
    };
    let variants = (!exact)
        .then(|| recovery_prompt_variants(&reviewed, &expected.turns))
        .transpose()?;
    let prompt_filter = variants
        .as_ref()
        .map(|values| values.keys().cloned().collect::<BTreeSet<_>>());
    let (actual, losses, graph) =
        db.read_with_prompt_filter(profile, &header, prompt_filter.as_ref())?;
    ensure!(
        (!exact || losses.is_empty()) && same_prefix(&expected.turns, &actual, exact),
        "Cursor IDE imported conversation differs from preview"
    );
    if exact {
        ensure!(
            graph.root == cursor_import_root(&reviewed.root)? && graph.blobs == reviewed.blobs,
            "Cursor IDE imported root or blobs differ from payload"
        );
    } else {
        // Additional private system/context prompts are identified only by
        // references, not hydrated. The reviewed model history must remain a
        // contiguous prefix after any private leading context, rather than an
        // arbitrary subsequence that could hide a replaced or inserted prompt.
        let required = prompt_references(&reviewed.root)?;
        let current = prompt_references(&graph.root)?;
        let variants = variants
            .as_ref()
            .context("Missing recovery prompt contract")?;
        let prefix_start = current
            .iter()
            .position(|reference| variants.contains_key(reference))
            .context("Cursor IDE recovered model history is missing")?;
        let prefix_end = prefix_start + required.len();
        let retained = current
            .get(prefix_start..prefix_end)
            .context("Cursor IDE recovered model history is incomplete")?;
        ensure!(
            retained.iter().zip(&required).all(|(reference, required)| {
                variants
                    .get(reference)
                    .is_some_and(|(original, _)| original == required)
            }),
            "Cursor IDE recovered model history differs from preview"
        );
        // A later native turn can legitimately use the same content-addressed
        // prompt blob. Each such tail reference must be explained, in order,
        // by a distinct appended UI turn of the same role and exact text.
        // Merely appending extra model references still cannot repair history.
        let mut appended_references = actual[expected.turns.len()..]
            .iter()
            .map(|turn| {
                let [SessionBlock::Text { text }] = turn.blocks.as_slice() else {
                    bail!("Unsupported Cursor IDE appended prompt projection");
                };
                let bytes = serde_json::to_vec(&serde_json::json!({
                    "role": if turn.role == SessionRole::User { "user" } else { "assistant" },
                    "content": [{"type": "text", "text": text}]
                }))?;
                Ok(Sha256::digest(bytes).to_vec())
            })
            .collect::<Result<Vec<_>>>()?
            .into_iter();
        for reference in &current[prefix_end..] {
            if let Some((original, _)) = variants.get(reference) {
                ensure!(
                    appended_references.any(|appended| appended == *original),
                    "Cursor IDE recovered model history has an unexplained repeated prompt"
                );
            }
        }
        for reference in &current {
            if let Some((_, bytes)) = variants.get(reference) {
                ensure!(
                    graph.blob(reference)? == *bytes,
                    "Cursor IDE recovered prompt bytes differ"
                );
            }
        }
        // Rewritten references do not authorize dropping the original approved
        // model/UI graph. Read only missing reviewed blobs, never new context.
        for (id, bytes) in &reviewed.blobs {
            let actual = if let Some(value) = graph.blobs.get(id) {
                value.clone()
            } else {
                db.bytes(
                    "cursorDiskKV",
                    "key",
                    &format!("agentKv:blob:{id}"),
                    MAX_BLOB,
                )?
            };
            ensure!(
                actual == *bytes,
                "Cursor IDE reviewed recovery blob is missing or changed"
            );
        }
    }
    Ok(header.id)
}

fn prompt_references(root: &[u8]) -> Result<Vec<Vec<u8>>> {
    fields(root)?
        .into_iter()
        .filter(|f| f.number == 1)
        .map(|f| {
            let reference = f.bytes()?;
            ensure!(
                reference.len() == 32,
                "Invalid Cursor IDE prompt blob reference"
            );
            Ok(reference.to_vec())
        })
        .collect()
}

fn verify_prompt_projection(graph: &Graph, expected: &[SessionTurn]) -> Result<()> {
    let references = prompt_references(&graph.root)?;
    ensure!(
        references.len() == expected.len(),
        "Cursor IDE payload lacks reviewed model history"
    );
    for (reference, turn) in references.iter().zip(expected) {
        let SessionBlock::Text { text } = turn
            .blocks
            .as_slice()
            .first()
            .context("Missing projected text")?
        else {
            bail!("Unsupported Cursor IDE prompt projection");
        };
        ensure!(
            turn.blocks.len() == 1,
            "Unsupported Cursor IDE prompt projection"
        );
        let value: Value = serde_json::from_slice(&graph.blob(reference)?)?;
        ensure!(
            value
                == serde_json::json!({
                    "role": if turn.role == SessionRole::User { "user" } else { "assistant" },
                    "content": [{"type": "text", "text": text}]
                }),
            "Cursor IDE model history differs from reviewed text"
        );
    }
    Ok(())
}

fn same_prefix(expected: &[SessionTurn], actual: &[SessionTurn], exact: bool) -> bool {
    (!exact || expected.len() == actual.len())
        && expected.len() <= actual.len()
        && expected
            .iter()
            .zip(actual)
            .all(|(e, a)| e.role == a.role && e.blocks == a.blocks)
}

pub(super) fn list_registered(
    profiles: &[CursorIdeProfile],
    workspace: &Path,
) -> NativeSessionListing {
    let mut listing = NativeSessionListing {
        sessions: Vec::new(),
        incomplete: false,
    };
    let mut seen = BTreeSet::new();
    for profile in profiles {
        if !platform_path::equivalent(&profile.workspace, workspace) {
            continue;
        }
        if !seen.insert((&profile.id, &profile.workspace)) {
            listing.incomplete = true;
            continue;
        }
        let result = (|| -> Result<()> {
            let mut db = Database::open(profile)?;
            let (headers, incomplete) = db.headers(profile)?;
            listing.incomplete |= incomplete;
            for header in headers {
                let readable = db.read(profile, &header).is_ok();
                listing.sessions.push(NativeSessionSummary {
                    native_ref: ide_ref(profile, &header.id),
                    agent: AgentKind::Cursor,
                    title: header.title,
                    origin: SessionOrigin::Interactive,
                    spawned_by_session_id: None,
                    forked_from_session_id: None,
                    created_at: header.created,
                    updated_at: header.updated,
                    message_count: None,
                    git_branch: None,
                    archived: false,
                    sidechain: false,
                    availability: if readable {
                        SessionAvailability::Readable
                    } else {
                        SessionAvailability::MetadataOnly
                    },
                });
            }
            Ok(())
        })();
        if result.is_err() {
            listing.incomplete = true;
        }
    }
    listing
}

fn ide_ref(profile: &CursorIdeProfile, id: &str) -> String {
    stable_native_ref(
        "cursor-ide",
        &[&profile.id, &profile.db_path.to_string_lossy(), id],
    )
}

pub(super) fn read_registered(
    profiles: &[CursorIdeProfile],
    native_ref: &str,
) -> Result<(Vec<SessionTurn>, BTreeMap<SessionLossCode, usize>, String)> {
    let mut matching = Vec::new();
    for profile in profiles {
        let Ok(mut db) = Database::open(profile) else {
            continue;
        };
        let Ok((headers, _)) = db.headers(profile) else {
            continue;
        };
        for header in headers {
            if ide_ref(profile, &header.id) == native_ref {
                matching.push((profile, header));
            }
        }
    }
    ensure!(
        matching.len() == 1,
        "Cursor IDE source is unavailable or ambiguous"
    );
    let (profile, header) = matching.into_iter().next().expect("one source");
    let mut db = Database::open(profile)?;
    let (turns, losses, graph) = db.read(profile, &header)?;
    Ok((turns, losses, hex::encode(Sha256::digest(&graph.root))))
}

#[cfg(test)]
pub(super) fn matrix_frozen_document() -> SessionDocument {
    tests::matrix_frozen_document()
}

#[cfg(test)]
pub(super) fn matrix_import_readback(document: &SessionDocument) -> CursorIdeImportPayload {
    tests::matrix_import_readback(document)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ConversationProvider, ConversationSessionSummary, CursorProvider, SessionAttachmentKind,
        SessionDocumentSource,
    };
    use rusqlite::params;
    use serde_json::json;
    use tempfile::TempDir;

    const OPERATION: &str = "d6c23a96-81b0-4f6a-8ae6-18c6351c7684";
    const NATIVE: &str = "a82eda5e-adc1-445e-b2e8-f1055816ffae";
    const SECOND: &str = "5f3c16cc-ae26-458d-853e-f594387678ab";

    fn document(messages: &[(SessionRole, &str)]) -> SessionDocument {
        SessionDocument {
            schema_version: 1,
            source: SessionDocumentSource {
                agent: AgentKind::ClaudeCode,
                workspace_id: "workspace".into(),
                title: Some("synthetic".into()),
                created_at: DateTime::from_timestamp_millis(1_790_770_000_000),
                updated_at: None,
                git_branch: None,
            },
            turns: messages
                .iter()
                .enumerate()
                .map(|(i, (role, text))| SessionTurn {
                    id: format!("test-{i}"),
                    role: *role,
                    timestamp: DateTime::from_timestamp_millis(1_790_770_000_001 + i as i64),
                    blocks: vec![SessionBlock::Text {
                        text: (*text).into(),
                    }],
                })
                .collect(),
            losses: Vec::new(),
            redaction_count: 0,
        }
    }

    fn fixture() -> (TempDir, CursorIdeProfile) {
        let temp = TempDir::new().unwrap();
        let temp_path = fs::canonicalize(temp.path()).unwrap();
        let workspace = temp_path.join("工作 space");
        fs::create_dir(&workspace).unwrap();
        let db_path = temp_path.join("state.vscdb");
        let db = Connection::open(&db_path).unwrap();
        db.execute_batch("PRAGMA user_version=1; CREATE TABLE cursorDiskKV(key TEXT UNIQUE ON CONFLICT REPLACE,value BLOB); CREATE TABLE composerHeaders(composerId TEXT PRIMARY KEY,workspaceId TEXT,createdAt INTEGER,lastUpdatedAt INTEGER,isArchived INTEGER,isSubagent INTEGER,recency INTEGER,checkpointAt INTEGER,subagentTypeName TEXT,value TEXT);").unwrap();
        (
            temp,
            CursorIdeProfile {
                id: "explicit-profile".into(),
                db_path,
                version: CURSOR_IDE_VERSION.into(),
                workspace,
            },
        )
    }

    fn workspace_json(profile: &CursorIdeProfile) -> Value {
        // This observed ID is deliberately not derived from the folder URI.
        json!({"id":"observed-workspace-id", "uri":{"scheme":"file","external":workspace_uri(&profile.workspace).unwrap(),"fsPath":profile.workspace.to_str().unwrap()}})
    }

    fn store(profile: &CursorIdeProfile, native: &str, payload: &str, name: &str) {
        let (_, export) = Graph::from_export(payload).unwrap();
        let db = Connection::open(&profile.db_path).unwrap();
        let workspace = workspace_json(profile);
        let header =
            json!({"composerId":native,"name":name,"workspaceIdentifier":workspace,"type":"head"});
        db.execute("INSERT OR REPLACE INTO composerHeaders VALUES (?1,'observed-workspace-id',1790770000000,1790770000001,0,0,1,0,NULL,?2)", params![native, header.to_string()]).unwrap();
        let composer = json!({"composerId":native,"_v":18,"workspaceIdentifier":workspace,"conversationState":format!("~{}",export.conversation_state)});
        db.execute(
            "INSERT OR REPLACE INTO cursorDiskKV VALUES (?1,?2)",
            params![format!("composerData:{native}"), composer.to_string()],
        )
        .unwrap();
        for (id, bytes) in export.blobs {
            db.execute(
                "INSERT OR REPLACE INTO cursorDiskKV VALUES (?1,?2)",
                params![
                    format!("agentKv:blob:{id}"),
                    STANDARD.decode(bytes).unwrap()
                ],
            )
            .unwrap();
        }
    }

    fn source() -> ConversationSessionSummary {
        ConversationSessionSummary {
            id: "cursor-ide-source".into(),
            workspace_id: "workspace".into(),
            agent: AgentKind::Cursor,
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
        }
    }

    fn export_graph(graph: &Graph) -> String {
        serde_json::to_string(&Export {
            version: 1,
            conversation_state: STANDARD.encode(&graph.root),
            blobs: graph
                .blobs
                .iter()
                .map(|(id, bytes)| (id.clone(), STANDARD.encode(bytes)))
                .collect(),
            name: format!("AgentKib {OPERATION}"),
            exported_at: 0,
        })
        .unwrap()
    }

    // These synthetic bytes were accepted and read back byte-for-byte by the
    // official 3.22.12 normal-window importer in isolated QA on 2026-09-30.
    pub(super) fn matrix_frozen_document() -> SessionDocument {
        let (_temp, profile) = fixture();
        let (mut graph, _) = Graph::from_export(include_str!(
            "../tests/fixtures/cursor-ide-3.22.12-export-v1.json"
        ))
        .unwrap();
        let root = fields(&graph.root).unwrap();
        graph.root = field(8, required_bytes(&root, 8).unwrap());
        graph.root.extend(field(
            9,
            workspace_uri(&profile.workspace).unwrap().as_bytes(),
        ));
        let payload = export_graph(&graph);
        store(&profile, NATIVE, &payload, "synthetic fixture");
        let before = fs::read(&profile.db_path).unwrap();
        let listing = list_registered(std::slice::from_ref(&profile), &profile.workspace);
        assert!(!listing.incomplete);
        assert_eq!(listing.sessions.len(), 1);
        assert_eq!(
            listing.sessions[0].availability,
            SessionAvailability::Readable
        );
        let provider = CursorProvider::with_ide_profiles(vec![profile.clone()]);
        let document = provider
            .read_session_document(&source(), &listing.sessions[0].native_ref, None)
            .unwrap();
        assert_eq!(document.turns.len(), 2);
        assert_eq!(document.turns[0].role, SessionRole::User);
        assert_eq!(document.turns[1].role, SessionRole::Assistant);
        // Independent golden text, shared by the source/target matrix and fixture
        // test, prevents an altered source parser from certifying itself.
        assert_eq!(
            document.turns[0].blocks,
            vec![SessionBlock::Text {
                text: "Remember marker AKIB-CURSOR-6e6b1c15238742fe. Project decision: SQLite WAL workspace-a.".into(),
            }]
        );
        assert_eq!(
            document.turns[1].blocks,
            vec![SessionBlock::Text {
                text: "Recorded AKIB-CURSOR-6e6b1c15238742fe; decision is SQLite WAL workspace-a."
                    .into(),
            }]
        );
        assert_eq!(fs::read(&profile.db_path).unwrap(), before);
        assert!(read_registered(&[], &listing.sessions[0].native_ref).is_err());
        document
    }

    #[test]
    fn frozen_official_import_fixture_decodes_and_is_read_only() {
        matrix_frozen_document();
    }

    pub(super) fn matrix_import_readback(document: &SessionDocument) -> CursorIdeImportPayload {
        let (_temp, profile) = fixture();
        let import = prepare_cursor_ide_import(document, OPERATION, &profile.workspace).unwrap();
        let (graph, export) = Graph::from_export(&import.payload).unwrap();
        let (turns, losses) = decode_graph(&graph.root, |reference| graph.blob(reference)).unwrap();
        assert!(losses.is_empty());
        assert!(same_prefix(&import.expected.turns, &turns, true));
        assert_eq!(export.version, 1);
        assert_eq!(export.name, import.marker);
        assert_eq!(
            root_workspaces(&graph.root).unwrap(),
            vec![profile.workspace.clone()]
        );
        for (id, bytes) in &graph.blobs {
            assert_eq!(*id, hex::encode(Sha256::digest(bytes)));
        }
        let before_native_ids = list_cursor_ide_identities(&profile).unwrap();
        assert!(before_native_ids.is_empty());
        store(&profile, NATIVE, &import.payload, &import.marker);
        let before = fs::read(&profile.db_path).unwrap();
        assert_eq!(
            verify_cursor_ide_import(
                &profile,
                &import.payload,
                &import.expected,
                &import.marker,
                None,
                &[],
                true,
            )
            .unwrap(),
            NATIVE
        );
        let listing = list_registered(std::slice::from_ref(&profile), &profile.workspace);
        assert!(!listing.incomplete);
        assert_eq!(listing.sessions.len(), 1);
        assert_eq!(
            listing.sessions[0].availability,
            SessionAvailability::Readable
        );
        assert!(listing.sessions[0].native_ref.starts_with("cursor-ide-"));
        let provider = CursorProvider::with_ide_profiles(vec![profile.clone()]);
        let actual = provider
            .read_session_document(&source(), &listing.sessions[0].native_ref, None)
            .unwrap();
        assert!(same_prefix(&import.expected.turns, &actual.turns, true));
        assert!(actual.losses.is_empty());
        let (_, losses, root_hash) = read_registered(
            std::slice::from_ref(&profile),
            &listing.sessions[0].native_ref,
        )
        .unwrap();
        assert!(losses.is_empty());
        assert_eq!(root_hash, hex::encode(Sha256::digest(&graph.root)));
        assert_eq!(fs::read(&profile.db_path).unwrap(), before);
        import
    }

    #[test]
    fn projection_preserves_unicode_multiturn_and_consecutive_roles() {
        let (_temp, profile) = fixture();
        let document = document(&[
            (SessionRole::Assistant, "先前助手 🦀"),
            (SessionRole::Assistant, "第二位助手\nline"),
            (SessionRole::User, "问一"),
            (SessionRole::User, "问二"),
            (SessionRole::Assistant, "答一"),
            (SessionRole::Assistant, "答二"),
        ]);
        let import = prepare_cursor_ide_import(&document, OPERATION, &profile.workspace).unwrap();
        let (graph, export) = Graph::from_export(&import.payload).unwrap();
        // Inspect the product's model-history representation independently of
        // our UI-turn decoder, including consecutive roles and Unicode/newlines.
        let prompt_messages = prompt_references(&graph.root)
            .unwrap()
            .iter()
            .map(|reference| {
                serde_json::from_slice::<Value>(&graph.blob(reference).unwrap()).unwrap()
            })
            .collect::<Vec<_>>();
        assert_eq!(prompt_messages.len(), 7);
        assert_eq!(
            prompt_messages[1],
            json!({"role":"assistant","content":[{"type":"text","text":"先前助手 🦀"}]})
        );
        assert_eq!(
            prompt_messages[2],
            json!({"role":"assistant","content":[{"type":"text","text":"第二位助手\nline"}]})
        );
        assert_eq!(
            prompt_messages[3],
            json!({"role":"user","content":[{"type":"text","text":"问一"}]})
        );
        assert_eq!(
            prompt_messages[4],
            json!({"role":"user","content":[{"type":"text","text":"问二"}]})
        );
        assert_eq!(
            prompt_messages[5],
            json!({"role":"assistant","content":[{"type":"text","text":"答一"}]})
        );
        assert_eq!(
            prompt_messages[6],
            json!({"role":"assistant","content":[{"type":"text","text":"答二"}]})
        );
        let (turns, losses) = decode_graph(&graph.root, |r| graph.blob(r)).unwrap();
        assert!(losses.is_empty());
        assert!(same_prefix(&import.expected.turns, &turns, true));
        assert_eq!(
            turns.iter().map(|t| t.timestamp).collect::<Vec<_>>(),
            import
                .expected
                .turns
                .iter()
                .map(|t| t.timestamp)
                .collect::<Vec<_>>()
        );
        assert_eq!(export.version, 1);
        assert_eq!(export.name, import.marker);
        assert_eq!(
            root_workspaces(&graph.root).unwrap(),
            vec![profile.workspace.clone()]
        );
        store(
            &profile,
            NATIVE,
            &import.payload,
            &format!("(1) {}", import.marker),
        );
        assert_eq!(
            verify_cursor_ide_import(
                &profile,
                &import.payload,
                &import.expected,
                &import.marker,
                None,
                &[],
                true
            )
            .unwrap(),
            NATIVE
        );
    }

    #[test]
    fn visible_history_without_matching_model_context_cannot_pass_import_readback() {
        let (_temp, profile) = fixture();
        let import = prepare_cursor_ide_import(
            &document(&[
                (SessionRole::User, "Remember marker and SQLite WAL decision"),
                (SessionRole::Assistant, "Recorded the full decision"),
            ]),
            OPERATION,
            &profile.workspace,
        )
        .unwrap();
        let (mut graph, _) = Graph::from_export(&import.payload).unwrap();
        let references = prompt_references(&graph.root).unwrap();
        let original_root = graph.root.clone();
        let mut ui_only = Vec::new();
        for f in fields(&original_root)
            .unwrap()
            .into_iter()
            .filter(|f| f.number != 1)
        {
            ui_only.extend(field(f.number, f.bytes().unwrap()));
        }
        graph.root = ui_only;
        // Reproduces the native GUI success/empty model context from live QA.
        assert!(same_prefix(
            &import.expected.turns,
            &decode_graph(&graph.root, |r| graph.blob(r)).unwrap().0,
            true
        ));
        assert!(
            verify_cursor_ide_import(
                &profile,
                &export_graph(&graph),
                &import.expected,
                &import.marker,
                None,
                &[],
                true
            )
            .is_err()
        );
        graph.root = original_root;
        let altered = serde_json::to_vec(
            &json!({"role":"user","content":[{"type":"text","text":"wrong history"}]}),
        )
        .unwrap();
        let original = graph
            .blobs
            .insert(hex::encode(&references[1]), altered)
            .unwrap();
        assert!(verify_prompt_projection(&graph, &import.expected.turns).is_err());
        graph.blobs.insert(hex::encode(&references[1]), original);
        store(&profile, NATIVE, &import.payload, &import.marker);
        let db = Connection::open(&profile.db_path).unwrap();
        // A missing model-only blob must fail even when all visible messages
        // remain readable; a recovery cannot silently open this conversation.
        db.execute(
            "DELETE FROM cursorDiskKV WHERE key=?1",
            [format!("agentKv:blob:{}", hex::encode(&references[1]))],
        )
        .unwrap();
        assert!(
            verify_cursor_ide_import(
                &profile,
                &import.payload,
                &import.expected,
                &import.marker,
                Some(NATIVE),
                &[],
                true
            )
            .is_err()
        );
        assert!(
            verify_cursor_ide_import(
                &profile,
                &import.payload,
                &import.expected,
                &import.marker,
                Some(NATIVE),
                &[],
                false
            )
            .is_err()
        );
    }

    #[test]
    fn vendor_field_grouping_recovers_legacy_plan_without_changing_history() {
        let (_temp, profile) = fixture();
        let import = prepare_cursor_ide_import(
            &document(&[
                (SessionRole::User, "first\n中文"),
                (SessionRole::Assistant, "response one"),
                (SessionRole::User, "second question"),
                (SessionRole::Assistant, "response two"),
            ]),
            OPERATION,
            &profile.workspace,
        )
        .unwrap();
        let (graph, mut legacy) = Graph::from_export(&import.payload).unwrap();
        let parsed = fields(&graph.root).unwrap();
        let numbers = parsed.iter().map(|f| f.number).collect::<Vec<_>>();
        assert_eq!(numbers, vec![1, 1, 1, 1, 1, 8, 8, 8, 9]);
        // A frozen older plan interleaved UI and model fields. Cursor only
        // groups different fields; no reference array or blob may change.
        let order = [0, 1, 5, 2, 3, 6, 4, 7, 8];
        let legacy_root = order
            .iter()
            .flat_map(|index| field(parsed[*index].number, parsed[*index].bytes().unwrap()))
            .collect::<Vec<_>>();
        assert_ne!(legacy_root, graph.root);
        assert_eq!(cursor_import_root(&legacy_root).unwrap(), graph.root);
        legacy.conversation_state = STANDARD.encode(&legacy_root);
        let legacy_payload = serde_json::to_string_pretty(&legacy).unwrap();
        assert!(
            reviewed_cursor_ide_import_payload_matches(&import.payload, &legacy_payload).unwrap()
        );
        assert!(
            reviewed_cursor_ide_import_payload_matches(&import.payload, &import.payload).unwrap()
        );
        let mut changed_name: Value = serde_json::from_str(&legacy_payload).unwrap();
        changed_name["name"] = Value::String("different operation".into());
        let changed_name: Export = serde_json::from_value(changed_name).unwrap();
        assert!(
            !reviewed_cursor_ide_import_payload_matches(
                &import.payload,
                &serde_json::to_string_pretty(&changed_name).unwrap()
            )
            .unwrap()
        );
        assert!(
            reviewed_cursor_ide_import_payload_matches(
                &import.payload,
                &serde_json::to_string(&legacy).unwrap()
            )
            .is_err()
        );
        store(&profile, NATIVE, &import.payload, &import.marker);
        let before = fs::read(&profile.db_path).unwrap();
        for known in [None, Some(NATIVE)] {
            assert_eq!(
                verify_cursor_ide_import(
                    &profile,
                    &legacy_payload,
                    &import.expected,
                    &import.marker,
                    known,
                    &[],
                    true,
                )
                .unwrap(),
                NATIVE
            );
        }
        assert_eq!(fs::read(&profile.db_path).unwrap(), before);
        let encoded = parsed
            .iter()
            .map(|f| field(f.number, f.bytes().unwrap()))
            .collect::<Vec<_>>();
        for mutation in 0..9 {
            let mut changed = encoded.clone();
            match mutation {
                0 => changed.swap(0, 1),
                1 => changed.swap(5, 6),
                2 => changed.insert(1, changed[0].clone()),
                3 => {
                    changed.remove(0);
                }
                4 => changed[0] = field(1, &[0; 32]),
                5 => changed.push(changed[8].clone()),
                6 => changed.push(integer(10, 1)),
                7 => changed[8] = field(9, b"file:///different-workspace"),
                8 => changed = order.iter().map(|index| encoded[*index].clone()).collect(),
                _ => unreachable!(),
            }
            let mut actual: Value = serde_json::from_str(&import.payload).unwrap();
            actual["conversationState"] = Value::String(STANDARD.encode(changed.concat()));
            store(&profile, NATIVE, &actual.to_string(), &import.marker);
            assert!(
                verify_cursor_ide_import(
                    &profile,
                    &legacy_payload,
                    &import.expected,
                    &import.marker,
                    Some(NATIVE),
                    &[],
                    true,
                )
                .is_err(),
                "root mutation {mutation}"
            );
        }
    }

    fn replace_prompt_references(
        root: &[u8],
        replacements: &BTreeMap<Vec<u8>, Vec<u8>>,
    ) -> Vec<u8> {
        fields(root)
            .unwrap()
            .into_iter()
            .flat_map(|f| {
                let bytes = f.bytes().unwrap();
                field(
                    f.number,
                    if f.number == 1 {
                        replacements.get(bytes).map(Vec::as_slice).unwrap_or(bytes)
                    } else {
                        bytes
                    },
                )
            })
            .collect()
    }

    #[test]
    fn recovery_accepts_only_observed_assistant_key_order_without_reading_private_prompts() {
        let (_temp, profile) = fixture();
        let import = prepare_cursor_ide_import(
            &document(&[
                (SessionRole::User, "question 中文\nline"),
                (SessionRole::Assistant, "answer 🦀\nsecond line"),
                (SessionRole::User, "next question"),
                (SessionRole::Assistant, "answer 🦀\nsecond line"),
            ]),
            OPERATION,
            &profile.workspace,
        )
        .unwrap();
        let (reviewed, _) = Graph::from_export(&import.payload).unwrap();
        let variants = recovery_prompt_variants(&reviewed, &import.expected.turns).unwrap();
        let (mut current, _) = Graph::from_export(&import.payload).unwrap();
        let mut replacements = BTreeMap::new();
        for (alternate, (original, bytes)) in variants {
            if alternate != original {
                replacements.insert(original, alternate.clone());
                current.blobs.insert(hex::encode(alternate), bytes);
            }
        }
        current.root = replace_prompt_references(&current.root, &replacements);
        // Deliberately no record for this private system prompt. Recovery may
        // inspect its reference but must not try to read or decode its content.
        current.root = [field(1, &[0xff; 32]), current.root].concat();
        store(&profile, NATIVE, &export_graph(&current), &import.marker);
        let before = fs::read(&profile.db_path).unwrap();
        assert_eq!(
            verify_cursor_ide_import(
                &profile,
                &import.payload,
                &import.expected,
                &import.marker,
                Some(NATIVE),
                &[],
                false
            )
            .unwrap(),
            NATIVE
        );
        assert_eq!(fs::read(&profile.db_path).unwrap(), before);
        assert!(
            verify_cursor_ide_import(
                &profile,
                &import.payload,
                &import.expected,
                &import.marker,
                Some(NATIVE),
                &[],
                true
            )
            .is_err()
        );
        // The superseded original blob remains mandatory even though the
        // current root references its byte-verified alternate.
        let original = replacements.keys().next().unwrap();
        Connection::open(&profile.db_path)
            .unwrap()
            .execute(
                "DELETE FROM cursorDiskKV WHERE key=?1",
                [format!("agentKv:blob:{}", hex::encode(original))],
            )
            .unwrap();
        assert!(
            verify_cursor_ide_import(
                &profile,
                &import.payload,
                &import.expected,
                &import.marker,
                Some(NATIVE),
                &[],
                false
            )
            .is_err()
        );
    }

    #[test]
    fn recovery_allows_new_turns_to_reuse_historical_prompt_blobs() {
        for appended in [
            vec![(SessionRole::User, "question")],
            vec![(SessionRole::Assistant, "answer 中文")],
            vec![
                (SessionRole::User, "new question"),
                (SessionRole::Assistant, "new answer"),
                (SessionRole::User, "question"),
                (SessionRole::Assistant, "answer 中文"),
            ],
            vec![
                (SessionRole::User, "question"),
                (SessionRole::User, "question"),
                (SessionRole::Assistant, "answer 中文"),
                (SessionRole::Assistant, "answer 中文"),
            ],
        ] {
            for alternate_assistant in [false, true] {
                let (_temp, profile) = fixture();
                let original_messages = [
                    (SessionRole::User, "question"),
                    (SessionRole::User, "question"),
                    (SessionRole::Assistant, "answer 中文"),
                    (SessionRole::Assistant, "answer 中文"),
                ];
                let import = prepare_cursor_ide_import(
                    &document(&original_messages),
                    OPERATION,
                    &profile.workspace,
                )
                .unwrap();
                store(&profile, NATIVE, &import.payload, &import.marker);
                let messages = [original_messages.as_slice(), appended.as_slice()].concat();
                let continued =
                    prepare_cursor_ide_import(&document(&messages), OPERATION, &profile.workspace)
                        .unwrap();
                let (mut graph, _) = Graph::from_export(&continued.payload).unwrap();
                if alternate_assistant {
                    let (reviewed, _) = Graph::from_export(&import.payload).unwrap();
                    let variants =
                        recovery_prompt_variants(&reviewed, &import.expected.turns).unwrap();
                    let mut replacements = BTreeMap::new();
                    for (alternate, (original, bytes)) in variants {
                        if alternate != original {
                            replacements.insert(original, alternate.clone());
                            graph.blobs.insert(hex::encode(alternate), bytes);
                        }
                    }
                    graph.root = replace_prompt_references(&graph.root, &replacements);
                }
                // Private system/context records must remain unhydrated both
                // before the imported prefix and after later native turns.
                graph.root = [field(1, &[0xfe; 32]), graph.root, field(1, &[0xff; 32])].concat();
                store(&profile, NATIVE, &export_graph(&graph), &import.marker);
                let before = fs::read(&profile.db_path).unwrap();
                assert_eq!(
                    verify_cursor_ide_import(
                        &profile,
                        &import.payload,
                        &import.expected,
                        &import.marker,
                        Some(NATIVE),
                        &[],
                        false,
                    )
                    .unwrap(),
                    NATIVE,
                    "appended {appended:?}, alternate assistant {alternate_assistant}"
                );
                assert_eq!(fs::read(&profile.db_path).unwrap(), before);
                assert!(
                    verify_cursor_ide_import(
                        &profile,
                        &import.payload,
                        &import.expected,
                        &import.marker,
                        Some(NATIVE),
                        &[],
                        true,
                    )
                    .is_err()
                );
            }
        }
    }

    #[test]
    fn repeated_tail_prompts_cannot_hide_changed_prefix_or_exceed_new_ui_turns() {
        let original = [
            (SessionRole::User, "question"),
            (SessionRole::Assistant, "answer 中文"),
        ];
        let appended = [
            (SessionRole::User, "question"),
            (SessionRole::Assistant, "answer 中文"),
            (SessionRole::User, "question"),
            (SessionRole::Assistant, "answer 中文"),
        ];
        for mutation in 0..10 {
            let (_temp, profile) = fixture();
            let import =
                prepare_cursor_ide_import(&document(&original), OPERATION, &profile.workspace)
                    .unwrap();
            store(&profile, NATIVE, &import.payload, &import.marker);
            let continued = prepare_cursor_ide_import(
                &document(&[original.as_slice(), appended.as_slice()].concat()),
                OPERATION,
                &profile.workspace,
            )
            .unwrap();
            let (reviewed, _) = Graph::from_export(&import.payload).unwrap();
            let (mut current, _) = Graph::from_export(&continued.payload).unwrap();
            let mut prompts = prompt_references(&current.root).unwrap();
            let variants = recovery_prompt_variants(&reviewed, &import.expected.turns).unwrap();
            let (alternate, (original_assistant, alternate_bytes)) = variants
                .iter()
                .find(|(reference, (original, _))| *reference != original)
                .unwrap();
            current
                .blobs
                .insert(hex::encode(alternate), alternate_bytes.clone());
            // Both retained and later assistant turns use the one permitted
            // native encoding; validation must still distinguish their counts.
            for reference in &mut prompts {
                if reference == original_assistant {
                    *reference = alternate.clone();
                }
            }
            match mutation {
                0 => prompts.insert(1, prompts[0].clone()),
                1 => prompts.insert(1, vec![0xff; 32]),
                2 => prompts[1] = vec![0xff; 32],
                3 => {
                    prompts.remove(1);
                }
                4 => prompts.swap(0, 1),
                5 => prompts.swap(2, 3),
                6 => prompts.push(alternate.clone()),
                7 => {
                    // The UI has four appended turns but the model must not
                    // reuse its user prompt five times to inflate the count.
                    prompts.extend(vec![prompts[0].clone(); 3]);
                }
                8 | 9 => {}
                _ => unreachable!(),
            }
            current.root = prompts
                .iter()
                .flat_map(|reference| field(1, reference))
                .chain(
                    fields(&current.root)
                        .unwrap()
                        .into_iter()
                        .filter(|f| f.number != 1)
                        .flat_map(|f| field(f.number, f.bytes().unwrap())),
                )
                .collect();
            store(&profile, NATIVE, &export_graph(&current), &import.marker);
            if matches!(mutation, 8 | 9) {
                let db = Connection::open(&profile.db_path).unwrap();
                let key = format!("agentKv:blob:{}", hex::encode(original_assistant));
                if mutation == 8 {
                    db.execute("DELETE FROM cursorDiskKV WHERE key=?1", [key])
                        .unwrap();
                } else {
                    db.execute(
                        "UPDATE cursorDiskKV SET value=?1 WHERE key=?2",
                        params![b"changed".to_vec(), key],
                    )
                    .unwrap();
                }
            }
            assert!(
                verify_cursor_ide_import(
                    &profile,
                    &import.payload,
                    &import.expected,
                    &import.marker,
                    Some(NATIVE),
                    &[],
                    false,
                )
                .is_err(),
                "mutation {mutation}"
            );
        }
    }

    #[test]
    fn repeated_prompt_must_match_the_role_of_a_distinct_new_ui_turn() {
        let (_temp, profile) = fixture();
        let import = prepare_cursor_ide_import(
            &document(&[
                (SessionRole::User, "identical text"),
                (SessionRole::Assistant, "identical text"),
            ]),
            OPERATION,
            &profile.workspace,
        )
        .unwrap();
        store(&profile, NATIVE, &import.payload, &import.marker);
        let continued = prepare_cursor_ide_import(
            &document(&[
                (SessionRole::User, "identical text"),
                (SessionRole::Assistant, "identical text"),
                (SessionRole::User, "identical text"),
            ]),
            OPERATION,
            &profile.workspace,
        )
        .unwrap();
        let (mut graph, _) = Graph::from_export(&continued.payload).unwrap();
        let prompts = prompt_references(&graph.root).unwrap();
        let mut changed = vec![prompts[0].clone(), prompts[1].clone(), prompts[1].clone()];
        graph.root = changed
            .drain(..)
            .flat_map(|reference| field(1, &reference))
            .chain(
                fields(&graph.root)
                    .unwrap()
                    .into_iter()
                    .filter(|f| f.number != 1)
                    .flat_map(|f| field(f.number, f.bytes().unwrap())),
            )
            .collect();
        store(&profile, NATIVE, &export_graph(&graph), &import.marker);
        assert!(
            verify_cursor_ide_import(
                &profile,
                &import.payload,
                &import.expected,
                &import.marker,
                Some(NATIVE),
                &[],
                false,
            )
            .is_err()
        );
    }

    #[test]
    fn recovery_rejects_changed_prompt_content_encodings_order_counts_and_blobs() {
        let (_temp, profile) = fixture();
        let import = prepare_cursor_ide_import(
            &document(&[
                (SessionRole::User, "question"),
                (SessionRole::Assistant, "answer\n中文"),
            ]),
            OPERATION,
            &profile.workspace,
        )
        .unwrap();
        let (reviewed, _) = Graph::from_export(&import.payload).unwrap();
        let references = prompt_references(&reviewed.root).unwrap();
        let assistant = references.last().unwrap();
        let variants = recovery_prompt_variants(&reviewed, &import.expected.turns).unwrap();
        let (alternate, (_, alternate_bytes)) = variants
            .iter()
            .find(|(key, (original, _))| *key != original)
            .unwrap();
        let invalid = [
            r#"{"role":"user","content":[{"type":"text","text":"answer\n中文"}]}"#.as_bytes().to_vec(),
            r#"{"role":"assistant","content":[{"type":"text","text":"changed"}]}"#.as_bytes().to_vec(),
            r#"{"role":"assistant","content":[{"type":"text","text":"answer\n中文"}],"extra":0}"#.as_bytes().to_vec(),
            r#"{"role":"assistant","content":[]}"#.as_bytes().to_vec(),
            r#"{"role":"assistant","role":"assistant","content":[{"type":"text","text":"answer\n中文"}]}"#.as_bytes().to_vec(),
            r#"{"role":"assistant","content":[{"type":"text","text":"answer\n中文","text":"answer\n中文"}]}"#.as_bytes().to_vec(),
            [alternate_bytes.clone(), b" ".to_vec()].concat(),
            r#"{"role":"assistant","content":[{"type":"text","text":"answer\n\u4e2d\u6587"}]}"#.as_bytes().to_vec(),
        ];
        for (index, raw) in invalid.into_iter().enumerate() {
            let (mut current, _) = Graph::from_export(&import.payload).unwrap();
            let changed = add_blob(&mut current, raw).unwrap();
            current.root = replace_prompt_references(
                &current.root,
                &BTreeMap::from([(assistant.clone(), changed)]),
            );
            store(&profile, NATIVE, &export_graph(&current), &import.marker);
            assert!(
                verify_cursor_ide_import(
                    &profile,
                    &import.payload,
                    &import.expected,
                    &import.marker,
                    Some(NATIVE),
                    &[],
                    false
                )
                .is_err(),
                "encoding {index}"
            );
        }
        for mutation in 0..6 {
            let (mut current, _) = Graph::from_export(&import.payload).unwrap();
            current
                .blobs
                .insert(hex::encode(alternate), alternate_bytes.clone());
            let mut prompts = references.clone();
            prompts[2] = alternate.clone();
            match mutation {
                0 => prompts.swap(1, 2),
                1 => {
                    prompts.remove(2);
                }
                2 => prompts.push(alternate.clone()),
                3 => prompts.push(assistant.clone()),
                4 | 5 => {}
                _ => unreachable!(),
            }
            current.root = prompts
                .iter()
                .flat_map(|reference| field(1, reference))
                .chain(
                    fields(&reviewed.root)
                        .unwrap()
                        .into_iter()
                        .filter(|f| f.number != 1)
                        .flat_map(|f| field(f.number, f.bytes().unwrap())),
                )
                .collect();
            store(&profile, NATIVE, &export_graph(&current), &import.marker);
            let db = Connection::open(&profile.db_path).unwrap();
            if mutation == 4 {
                db.execute(
                    "DELETE FROM cursorDiskKV WHERE key=?1",
                    [format!("agentKv:blob:{}", hex::encode(alternate))],
                )
                .unwrap();
            } else if mutation == 5 {
                db.execute(
                    "UPDATE cursorDiskKV SET value=?1 WHERE key=?2",
                    params![
                        b"changed".to_vec(),
                        format!("agentKv:blob:{}", hex::encode(alternate))
                    ],
                )
                .unwrap();
            }
            assert!(
                verify_cursor_ide_import(
                    &profile,
                    &import.payload,
                    &import.expected,
                    &import.marker,
                    Some(NATIVE),
                    &[],
                    false
                )
                .is_err(),
                "reference/blob {mutation}"
            );
        }
    }

    #[test]
    fn vendor_import_root_rejects_unobserved_wire_or_workspace_shapes() {
        let root = [
            field(1, &[1; 32]),
            field(8, &[2; 32]),
            field(9, b"file:///project"),
        ]
        .concat();
        assert_eq!(cursor_import_root(&root).unwrap(), root);
        let malformed = [
            [root.clone(), field(10, b"unknown")].concat(),
            [root.clone(), integer(1, 1)].concat(),
            [root.clone(), field(1, &[1; 31])].concat(),
            [field(1, &[1; 32]), field(8, &[2; 32])].concat(),
            [root.clone(), field(9, b"file:///project")].concat(),
            [field(1, &[1; 32]), field(8, &[2; 32]), field(9, &[0xff])].concat(),
            [
                &[0x8a, 0x00, 32][..],
                &[1; 32],
                &field(8, &[2; 32]),
                &field(9, b"file:///project"),
            ]
            .concat(),
            [
                &[0x0a, 0xa0, 0x00][..],
                &[1; 32],
                &field(8, &[2; 32]),
                &field(9, b"file:///project"),
            ]
            .concat(),
            root[..root.len() - 1].to_vec(),
        ];
        for (index, root) in malformed.iter().enumerate() {
            assert!(cursor_import_root(root).is_err(), "shape {index}");
        }
    }

    #[test]
    fn tools_and_attachments_have_preview_losses_and_no_executable_details() {
        let (_temp, profile) = fixture();
        let mut document = document(&[
            (SessionRole::User, "original question"),
            (SessionRole::Assistant, "original answer"),
        ]);
        document.turns[1].blocks.extend([
            SessionBlock::ToolCall {
                call_id: "call".into(),
                name: "synthetic_tool".into(),
                input: "PRIVATE_TOOL_INPUT".into(),
            },
            SessionBlock::Attachment {
                kind: SessionAttachmentKind::Document,
                media_type: "text/plain".into(),
                filename: Some("PRIVATE_FILENAME".into()),
                inline_base64: Some(STANDARD.encode("PRIVATE_ATTACHMENT")),
            },
        ]);
        document.turns.push(SessionTurn {
            id: "tool-output".into(),
            role: SessionRole::Tool,
            timestamp: None,
            blocks: vec![SessionBlock::Text {
                text: "PRIVATE_TOOL_OUTPUT".into(),
            }],
        });
        let import = prepare_cursor_ide_import(&document, OPERATION, &profile.workspace).unwrap();
        assert_eq!(
            import.expected.losses,
            vec![
                SessionLoss {
                    code: SessionLossCode::TargetToolSummary,
                    count: 2
                },
                SessionLoss {
                    code: SessionLossCode::TargetAttachmentOmitted,
                    count: 1
                }
            ]
        );
        let (graph, _) = Graph::from_export(&import.payload).unwrap();
        let text = graph
            .blobs
            .values()
            .flat_map(|b| b.iter().copied())
            .collect::<Vec<_>>();
        assert!(!String::from_utf8_lossy(&text).contains("PRIVATE_"));
        assert!(import.expected.turns.iter().any(|turn| {
            serde_json::to_string(turn)
                .unwrap()
                .contains("Historical tool call: synthetic_tool")
        }));
    }

    #[test]
    fn empty_required_text_invalid_operation_and_unsupported_versions_are_rejected() {
        let (_temp, mut profile) = fixture();
        assert!(prepare_cursor_ide_import(&document(&[]), OPERATION, &profile.workspace).is_err());
        assert!(
            prepare_cursor_ide_import(
                &document(&[(SessionRole::User, "")]),
                OPERATION,
                &profile.workspace
            )
            .is_err()
        );
        assert!(
            prepare_cursor_ide_import(
                &document(&[(SessionRole::User, " ")]),
                OPERATION,
                &profile.workspace
            )
            .is_err()
        );
        assert!(
            prepare_cursor_ide_import(
                &document(&[(SessionRole::User, "text")]),
                "non-uuid",
                &profile.workspace
            )
            .is_err()
        );
        profile.version = "3.22.13".into();
        assert!(list_cursor_ide_identities(&profile).is_err());
    }

    #[test]
    fn corrupt_missing_and_unknown_graph_data_cannot_be_read_as_complete() {
        let (_temp, profile) = fixture();
        let import = prepare_cursor_ide_import(
            &document(&[
                (SessionRole::User, "hello"),
                (SessionRole::Assistant, "world"),
            ]),
            OPERATION,
            &profile.workspace,
        )
        .unwrap();
        let (mut graph, _) = Graph::from_export(&import.payload).unwrap();
        let removed = graph.blobs.keys().next().unwrap().clone();
        let bytes = graph.blobs.remove(&removed).unwrap();
        assert!(decode_graph(&graph.root, |r| graph.blob(r)).is_err());
        graph.blobs.insert(removed.clone(), vec![0]);
        assert!(Graph::from_export(&export_graph(&graph)).is_err());
        graph.blobs.insert(removed, bytes);
        graph.root.extend(field(40, b"unknown"));
        assert!(decode_graph(&graph.root, |r| graph.blob(r)).is_err());
        graph.root = vec![0x42, 0x80];
        assert!(decode_graph(&graph.root, |r| graph.blob(r)).is_err());
        store(&profile, NATIVE, &import.payload, &import.marker);
        Connection::open(&profile.db_path)
            .unwrap()
            .execute(
                "UPDATE cursorDiskKV SET value=?1 WHERE key LIKE 'agentKv:blob:%'",
                [vec![0_u8]],
            )
            .unwrap();
        let listing = list_registered(std::slice::from_ref(&profile), &profile.workspace);
        assert_eq!(
            listing.sessions[0].availability,
            SessionAvailability::MetadataOnly
        );
        assert!(
            verify_cursor_ide_import(
                &profile,
                &import.payload,
                &import.expected,
                &import.marker,
                Some(NATIVE),
                &[],
                true
            )
            .is_err()
        );
    }

    #[test]
    fn discovery_uses_only_bound_profile_and_workspace_and_rejects_index_disagreement() {
        let (_temp, profile) = fixture();
        let import = prepare_cursor_ide_import(
            &document(&[(SessionRole::User, "hello")]),
            OPERATION,
            &profile.workspace,
        )
        .unwrap();
        store(&profile, NATIVE, &import.payload, &import.marker);
        let other = profile.workspace.parent().unwrap().join("other-workspace");
        fs::create_dir(&other).unwrap();
        assert!(
            list_registered(std::slice::from_ref(&profile), &other)
                .sessions
                .is_empty()
        );
        let mut wrong = profile.clone();
        wrong.workspace = other;
        assert!(list_cursor_ide_identities(&wrong).unwrap().is_empty());
        assert!(
            verify_cursor_ide_import(
                &wrong,
                &import.payload,
                &import.expected,
                &import.marker,
                Some(NATIVE),
                &[],
                true
            )
            .is_err()
        );
        Connection::open(&profile.db_path)
            .unwrap()
            .execute("UPDATE composerHeaders SET workspaceId='wrong-index'", [])
            .unwrap();
        assert!(list_cursor_ide_identities(&profile).is_err());
        assert!(list_registered(std::slice::from_ref(&profile), &profile.workspace).incomplete);
    }

    fn empty_window_records(id: &str) -> (Value, Value) {
        let sentinel = id == "empty-state-draft";
        let workspace = json!({"id":if sentinel { "empty-window" } else { "1790833932583" }});
        let header = json!({"type":"head", "composerId":id, "isDraft":sentinel,
            "workspaceIdentifier":workspace});
        let mut composer = json!({"composerId":id, "_v":18, "isDraft":sentinel,
            "status":"none", "text":"", "richText":"", "conversationState":"~",
            "fullConversationHeadersOnly":[], "conversationMap":{}});
        if sentinel {
            composer["workspaceIdentifier"] = workspace;
        }
        (header, composer)
    }

    fn store_empty_window(profile: &CursorIdeProfile, id: &str, header: &Value, composer: &Value) {
        let db = Connection::open(&profile.db_path).unwrap();
        db.execute("INSERT OR REPLACE INTO composerHeaders VALUES (?1,?2,1790833932572,NULL,0,0,1,NULL,NULL,?3)",
            params![id, header["workspaceIdentifier"]["id"].as_str().unwrap(), header.to_string()]).unwrap();
        db.execute(
            "INSERT OR REPLACE INTO cursorDiskKV VALUES (?1,?2)",
            params![format!("composerData:{id}"), composer.to_string()],
        )
        .unwrap();
    }

    #[test]
    fn official_empty_window_placeholders_do_not_block_folder_identity_listing() {
        let (_temp, profile) = fixture();
        let import = prepare_cursor_ide_import(
            &document(&[(SessionRole::User, "real history must remain readable")]),
            OPERATION,
            &profile.workspace,
        )
        .unwrap();
        store(&profile, NATIVE, &import.payload, &import.marker);
        for id in [
            "empty-state-draft",
            SECOND,
            "a73667ea-d877-4cd2-b193-54ee36ec7747",
        ] {
            let (header, composer) = empty_window_records(id);
            store_empty_window(&profile, id, &header, &composer);
        }
        let before = fs::read(&profile.db_path).unwrap();
        let identities = list_cursor_ide_identities(&profile).unwrap();
        assert_eq!(identities.len(), 1);
        assert_eq!(identities[0].native_id, NATIVE);
        assert_eq!(
            verify_cursor_ide_import(
                &profile,
                &import.payload,
                &import.expected,
                &import.marker,
                Some(NATIVE),
                &[],
                true
            )
            .unwrap(),
            NATIVE
        );
        assert_eq!(fs::read(&profile.db_path).unwrap(), before);
    }

    #[test]
    fn forged_or_nonempty_window_placeholders_keep_identity_listing_fail_closed() {
        for id in ["empty-state-draft", SECOND] {
            for mutation in 0..21 {
                let (_temp, profile) = fixture();
                let (mut header, mut composer) = empty_window_records(id);
                match mutation {
                    0 => header["composerId"] = json!(NATIVE),
                    1 => header["type"] = json!("other"),
                    2 => header["isDraft"] = json!(id != "empty-state-draft"),
                    3 => header["name"] = json!("real conversation"),
                    4 => header["workspaceIdentifier"]["uri"] = json!(null),
                    5 => header["workspaceIdentifier"]["configPath"] = json!(null),
                    6 => header["workspaceIdentifier"]["id"] = json!("unrecognized-window"),
                    7 => header["source"] = json!("cloud"),
                    8 => header["subagentInfo"] = json!({}),
                    9 => header["isArchived"] = json!(true),
                    10 => composer["composerId"] = json!(NATIVE),
                    11 => composer["_v"] = json!(19),
                    12 => composer["conversationState"] = json!("~Cg=="),
                    13 => composer["fullConversationHeadersOnly"] = json!([{"type":1}]),
                    14 => composer["conversationMap"] = json!({"message":"history"}),
                    15 => composer["text"] = json!("draft text"),
                    16 => composer["richText"] = json!("draft content"),
                    17 => composer["status"] = json!("completed"),
                    18 => composer["isDraft"] = json!(id != "empty-state-draft"),
                    19 => composer["workspaceIdentifier"] = workspace_json(&profile),
                    20 => header["isWorktree"] = json!(true),
                    _ => unreachable!(),
                }
                store_empty_window(&profile, id, &header, &composer);
                assert!(
                    list_cursor_ide_identities(&profile).is_err(),
                    "{id} mutation {mutation}"
                );
            }
            for column in ["workspaceId", "isArchived", "isSubagent"] {
                let (_temp, profile) = fixture();
                let (header, composer) = empty_window_records(id);
                store_empty_window(&profile, id, &header, &composer);
                let db = Connection::open(&profile.db_path).unwrap();
                let value = if column == "workspaceId" {
                    "'wrong-index'"
                } else {
                    "1"
                };
                db.execute(&format!("UPDATE composerHeaders SET {column}={value}"), [])
                    .unwrap();
                assert!(
                    list_cursor_ide_identities(&profile).is_err(),
                    "{id} index {column}"
                );
            }
        }
        // Neither an unknown non-UUID nor an ordinary folder record missing
        // its URI may be reclassified as a known empty-window placeholder.
        for id in ["unknown-draft", SECOND] {
            let (_temp, profile) = fixture();
            let (mut header, composer) = empty_window_records(id);
            if id == SECOND {
                header["workspaceIdentifier"] = json!({"id":"observed-workspace-id"});
            }
            store_empty_window(&profile, id, &header, &composer);
            assert!(list_cursor_ide_identities(&profile).is_err());
        }
    }

    #[test]
    fn missing_late_and_ambiguous_imports_require_exact_identity_and_never_write() {
        let (_temp, profile) = fixture();
        let import = prepare_cursor_ide_import(
            &document(&[(SessionRole::User, "hello")]),
            OPERATION,
            &profile.workspace,
        )
        .unwrap();
        assert!(
            verify_cursor_ide_import(
                &profile,
                &import.payload,
                &import.expected,
                &import.marker,
                None,
                &[],
                true
            )
            .is_err()
        );
        store(&profile, NATIVE, &import.payload, &import.marker);
        assert_eq!(
            verify_cursor_ide_import(
                &profile,
                &import.payload,
                &import.expected,
                &import.marker,
                None,
                &[],
                true
            )
            .unwrap(),
            NATIVE
        );
        store(&profile, SECOND, &import.payload, &import.marker);
        assert!(
            verify_cursor_ide_import(
                &profile,
                &import.payload,
                &import.expected,
                &import.marker,
                None,
                &[],
                true
            )
            .is_err()
        );
        assert_eq!(
            verify_cursor_ide_import(
                &profile,
                &import.payload,
                &import.expected,
                &import.marker,
                None,
                &[NATIVE.into()],
                true
            )
            .unwrap(),
            SECOND
        );
        let before = fs::read(&profile.db_path).unwrap();
        assert_eq!(
            verify_cursor_ide_import(
                &profile,
                &import.payload,
                &import.expected,
                &import.marker,
                Some(NATIVE),
                &[],
                true
            )
            .unwrap(),
            NATIVE
        );
        assert_eq!(fs::read(&profile.db_path).unwrap(), before);
    }

    #[test]
    fn known_identity_allows_append_but_rejects_prefix_changes() {
        let (_temp, profile) = fixture();
        let original = document(&[
            (SessionRole::User, "question"),
            (SessionRole::Assistant, "answer"),
        ]);
        let import = prepare_cursor_ide_import(&original, OPERATION, &profile.workspace).unwrap();
        // Model a real continuation: the immutable original graph was stored
        // before the new turn, and must remain available during recovery.
        store(&profile, NATIVE, &import.payload, &import.marker);
        let mut continued = original.clone();
        continued.turns.push(SessionTurn {
            id: "late".into(),
            role: SessionRole::Assistant,
            timestamp: None,
            blocks: vec![SessionBlock::Text {
                text: "additional answer".into(),
            }],
        });
        let after = prepare_cursor_ide_import(&continued, OPERATION, &profile.workspace).unwrap();
        store(&profile, NATIVE, &after.payload, "renamed by user");
        assert_eq!(
            verify_cursor_ide_import(
                &profile,
                &import.payload,
                &import.expected,
                &import.marker,
                Some(NATIVE),
                &[],
                false
            )
            .unwrap(),
            NATIVE
        );
        assert!(
            verify_cursor_ide_import(
                &profile,
                &import.payload,
                &import.expected,
                &import.marker,
                Some(NATIVE),
                &[],
                true
            )
            .is_err()
        );
        continued.turns[0].blocks = vec![SessionBlock::Text {
            text: "changed question".into(),
        }];
        let changed = prepare_cursor_ide_import(&continued, OPERATION, &profile.workspace).unwrap();
        store(&profile, NATIVE, &changed.payload, &import.marker);
        assert!(
            verify_cursor_ide_import(
                &profile,
                &import.payload,
                &import.expected,
                &import.marker,
                Some(NATIVE),
                &[],
                false
            )
            .is_err()
        );
    }

    #[test]
    fn selected_context_and_tools_are_losses_reasoning_is_never_text() {
        let (_temp, profile) = fixture();
        let mut graph = Graph {
            root: Vec::new(),
            blobs: BTreeMap::new(),
            total_bytes: 0,
        };
        let mut user = field(1, b"necessary user text");
        user.extend(field(3, b"PRIVATE_CONTEXT"));
        let user = add_blob(&mut graph, user).unwrap();
        let assistant =
            add_blob(&mut graph, field(1, &field(1, b"necessary assistant text"))).unwrap();
        let tool = add_blob(&mut graph, field(2, b"PRIVATE_TOOL")).unwrap();
        let reasoning = add_blob(&mut graph, field(3, b"PRIVATE_REASONING")).unwrap();
        let mut agent = field(1, &user);
        for step in [assistant, tool, reasoning] {
            agent.extend(field(2, &step));
        }
        let turn = add_blob(&mut graph, field(1, &agent)).unwrap();
        graph.root = field(8, &turn);
        graph.root.extend(field(
            9,
            workspace_uri(&profile.workspace).unwrap().as_bytes(),
        ));
        let (turns, losses) = decode_graph(&graph.root, |r| graph.blob(r)).unwrap();
        assert_eq!(turns.len(), 2);
        assert_eq!(
            losses.get(&SessionLossCode::SourceContentTruncated),
            Some(&2)
        );
        assert_eq!(losses.get(&SessionLossCode::ReasoningExcluded), Some(&1));
        assert!(!serde_json::to_string(&turns).unwrap().contains("PRIVATE_"));
    }

    #[cfg(unix)]
    #[test]
    fn symlink_database_and_sidecars_are_rejected() {
        use std::os::unix::fs::symlink;
        let (_temp, profile) = fixture();
        let link = profile.db_path.parent().unwrap().join("linked");
        fs::create_dir(&link).unwrap();
        symlink(&profile.db_path, link.join("state.vscdb")).unwrap();
        let mut linked = profile.clone();
        linked.db_path = link.join("state.vscdb");
        assert!(linked.validate().is_err());
        symlink(
            &profile.db_path,
            PathBuf::from(format!("{}-wal", profile.db_path.display())),
        )
        .unwrap();
        assert!(profile.validate().is_err());
    }
}
