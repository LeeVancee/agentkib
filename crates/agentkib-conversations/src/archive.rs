use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    SESSION_DOCUMENT_SCHEMA_VERSION, SessionBlock, SessionDocument, SessionImportStats,
    SessionRole, SessionTurn, stats,
};

pub const DEFAULT_HISTORY_BUDGET_TOKENS: usize = 120_000;
pub const HISTORY_BUDGET_OPTIONS: [usize; 3] = [64_000, 120_000, 180_000];
pub const MAX_ACTIVE_BLOCK_TOKENS: usize = 16_000;
pub const MAX_ARCHIVE_CHUNK_BYTES: usize = 64 * 1024;
const ARCHIVE_FRAGMENT_CHARS: usize = 8 * 1024;
const MAX_ARCHIVE_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionWindowStrategy {
    Full,
    Windowed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionWindowStats {
    pub estimated_total_tokens: usize,
    pub estimated_active_tokens: usize,
    pub estimated_deferred_tokens: usize,
    pub active: SessionImportStats,
    pub deferred_turn_count: usize,
    pub deferred_block_count: usize,
    pub estimate_quality: String,
}

#[derive(Debug, Clone)]
pub struct SessionWindowPlan {
    pub strategy: SessionWindowStrategy,
    pub active_document: SessionDocument,
    pub stats: SessionWindowStats,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionArchiveManifest {
    pub schema_version: u32,
    pub archive_id: String,
    pub workspace_id: String,
    pub source_fingerprint: String,
    pub document_sha256: String,
    pub chunks_sha256: String,
    pub chunk_count: usize,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct SessionArchiveBundle {
    pub manifest: SessionArchiveManifest,
    pub manifest_content: String,
    pub document_content: String,
    pub chunks_content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionArchiveChunk {
    pub chunk_id: String,
    #[serde(default)]
    pub block_id: String,
    pub turn_id: String,
    pub role: SessionRole,
    pub timestamp: Option<DateTime<Utc>>,
    pub block_type: String,
    pub part: usize,
    pub parts: usize,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionArchiveSearchHit {
    pub chunk_id: String,
    pub block_id: String,
    pub turn_id: String,
    pub role: SessionRole,
    pub timestamp: Option<DateTime<Utc>>,
    pub block_type: String,
    pub part: usize,
    pub parts: usize,
    pub first_chunk_id: String,
    pub last_chunk_id: String,
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionArchiveSearchResult {
    pub archive_id: String,
    pub chunk_count: usize,
    pub hits: Vec<SessionArchiveSearchHit>,
}

pub fn validate_history_budget(value: usize) -> Result<()> {
    if HISTORY_BUDGET_OPTIONS.contains(&value) {
        Ok(())
    } else {
        bail!("History budget must be one of 64000, 120000, or 180000 tokens")
    }
}

/// This intentionally overestimates mixed prose/code without coupling the app to a model tokenizer.
pub fn estimate_text_tokens(value: &str) -> usize {
    let mut quarters = 0usize;
    for character in value.chars() {
        quarters = quarters.saturating_add(
            if character.is_ascii_alphanumeric() || character.is_ascii_whitespace() {
                1
            } else if character.is_ascii() {
                2
            } else {
                4
            },
        );
    }
    quarters.div_ceil(4).max(value.len().div_ceil(3))
}

pub fn estimate_document_tokens(document: &SessionDocument) -> usize {
    document
        .turns
        .iter()
        .map(estimate_turn_tokens)
        .sum::<usize>()
        .saturating_add(64)
}

pub fn plan_session_window(
    document: &SessionDocument,
    history_budget_tokens: usize,
    archive_id: &str,
) -> Result<SessionWindowPlan> {
    validate_history_budget(history_budget_tokens)?;
    let _: Uuid = archive_id.parse().context("Archive ID must be a UUID")?;
    let total_tokens = estimate_document_tokens(document);
    let mut normalized = document.clone();
    let mut externalized_blocks = 0usize;
    let mut block_number = 0usize;
    for turn in &mut normalized.turns {
        for (index, block) in turn.blocks.iter_mut().enumerate() {
            block_number += 1;
            if estimate_block_tokens(block) > MAX_ACTIVE_BLOCK_TOKENS {
                *block = SessionBlock::Text {
                    text: archive_reference(archive_id, &turn.id, index, &block_id(block_number)),
                };
                externalized_blocks += 1;
            }
        }
    }

    let groups = conversation_groups(&normalized.turns);
    let mut start = groups.len();
    let mut used = 64usize;
    for index in (0..groups.len()).rev() {
        let group_tokens = groups[index]
            .iter()
            .map(estimate_turn_tokens)
            .sum::<usize>();
        if used.saturating_add(group_tokens) > history_budget_tokens {
            break;
        }
        used = used.saturating_add(group_tokens);
        start = index;
    }
    let active_turns = groups[start..]
        .iter()
        .flat_map(|group| group.iter().cloned())
        .collect::<Vec<_>>();
    let skipped_turns = normalized.turns.len().saturating_sub(active_turns.len());
    let active_blocks = active_turns
        .iter()
        .map(|turn| turn.blocks.len())
        .sum::<usize>();
    let total_blocks = document
        .turns
        .iter()
        .map(|turn| turn.blocks.len())
        .sum::<usize>();
    let mut active_document = normalized;
    active_document.turns = active_turns;
    if active_document.turns.is_empty() {
        active_document.turns.push(SessionTurn {
            id: "archive-reference".into(),
            role: SessionRole::User,
            timestamp: document.source.updated_at,
            blocks: vec![SessionBlock::Text {
                text: format!(
                    "[AgentKib archived this conversation as {archive_id}. Use session_search and session_read_chunk to retrieve the latest task before continuing.]"
                ),
            }],
        });
    }
    let active_tokens = estimate_document_tokens(&active_document);
    if active_tokens > history_budget_tokens {
        bail!("Active session window exceeds its token budget")
    }
    let deferred_blocks = total_blocks
        .saturating_sub(active_blocks)
        .saturating_add(externalized_blocks);
    let strategy = if skipped_turns == 0 && externalized_blocks == 0 {
        SessionWindowStrategy::Full
    } else {
        SessionWindowStrategy::Windowed
    };
    Ok(SessionWindowPlan {
        strategy,
        stats: SessionWindowStats {
            estimated_total_tokens: total_tokens,
            estimated_active_tokens: active_tokens,
            estimated_deferred_tokens: total_tokens.saturating_sub(active_tokens),
            active: stats(&active_document),
            deferred_turn_count: skipped_turns,
            deferred_block_count: deferred_blocks,
            estimate_quality: "conservative".into(),
        },
        active_document,
    })
}

pub fn build_session_archive(
    document: &SessionDocument,
    workspace_id: &str,
    archive_id: &str,
    source_fingerprint: &str,
    created_at: DateTime<Utc>,
) -> Result<SessionArchiveBundle> {
    let _: Uuid = archive_id.parse().context("Archive ID must be a UUID")?;
    if document.source.workspace_id != workspace_id {
        bail!("Archive workspace does not match the session document")
    }
    let document_content = format!("{}\n", serde_json::to_string_pretty(document)?);
    validate_archive_size(document_content.len() as u64, "document")?;
    let chunks = archive_chunks(document);
    let mut chunks_content = String::new();
    for chunk in &chunks {
        let line = serde_json::to_string(chunk)?;
        if line.len() > MAX_ARCHIVE_CHUNK_BYTES {
            bail!("Session archive chunk exceeds the 64 KiB limit")
        }
        chunks_content.push_str(&line);
        chunks_content.push('\n');
        validate_archive_size(chunks_content.len() as u64, "chunks")?;
    }
    let document_sha256 = hex::encode(Sha256::digest(document_content.as_bytes()));
    let chunks_sha256 = hex::encode(Sha256::digest(chunks_content.as_bytes()));
    let manifest = SessionArchiveManifest {
        schema_version: SESSION_DOCUMENT_SCHEMA_VERSION,
        archive_id: archive_id.into(),
        workspace_id: workspace_id.into(),
        source_fingerprint: source_fingerprint.into(),
        document_sha256,
        chunks_sha256,
        chunk_count: chunks.len(),
        created_at,
    };
    let manifest_content = format!("{}\n", serde_json::to_string_pretty(&manifest)?);
    Ok(SessionArchiveBundle {
        manifest,
        manifest_content,
        document_content,
        chunks_content,
    })
}

fn validate_archive_size(bytes: u64, content: &str) -> Result<()> {
    if bytes > MAX_ARCHIVE_BYTES {
        bail!("Session archive {content} content exceeds the 256 MiB limit")
    }
    Ok(())
}

pub fn archive_workspace_root(data_root: &Path, workspace_id: &str) -> PathBuf {
    let workspace_hash = hex::encode(Sha256::digest(workspace_id.as_bytes()));
    data_root.join("continuations").join(&workspace_hash[..32])
}

pub fn archive_directory(
    data_root: &Path,
    workspace_id: &str,
    archive_id: &str,
) -> Result<PathBuf> {
    let id: Uuid = archive_id.parse().context("Archive ID must be a UUID")?;
    Ok(archive_workspace_root(data_root, workspace_id).join(id.to_string()))
}

pub fn validate_session_archive(
    directory: &Path,
    workspace_id: &str,
    archive_id: &str,
) -> Result<SessionArchiveManifest> {
    read_validated_session_archive(directory, workspace_id, archive_id)
        .map(|(manifest, _)| manifest)
}

fn read_validated_session_archive(
    directory: &Path,
    workspace_id: &str,
    archive_id: &str,
) -> Result<(SessionArchiveManifest, Vec<u8>)> {
    validate_archive_directory_chain(directory)?;
    let manifest_path = directory.join("manifest.json");
    let document_path = directory.join("document.json");
    let chunks_path = directory.join("chunks.jsonl");
    for path in [&manifest_path, &document_path, &chunks_path] {
        let metadata = std::fs::symlink_metadata(path)
            .with_context(|| format!("Session archive file is unavailable: {}", path.display()))?;
        if agentkib_platform::path::is_reparse_or_symlink(path)? || !metadata.is_file() {
            bail!("Session archive contains an invalid file")
        }
    }
    let manifest: SessionArchiveManifest =
        read_limited_json(&manifest_path, MAX_ARCHIVE_CHUNK_BYTES as u64)?;
    if manifest.workspace_id != workspace_id || manifest.archive_id != archive_id {
        bail!("Session archive scope does not match the request")
    }
    let document = read_limited(&document_path, MAX_ARCHIVE_BYTES)?;
    if hex::encode(Sha256::digest(&document)) != manifest.document_sha256 {
        bail!("Session archive document hash does not match")
    }
    let chunks = read_limited(&chunks_path, MAX_ARCHIVE_BYTES)?;
    if hex::encode(Sha256::digest(&chunks)) != manifest.chunks_sha256 {
        bail!("Session archive chunks hash does not match")
    }
    let parsed: SessionDocument = serde_json::from_slice(&document)?;
    if parsed.source.workspace_id != workspace_id {
        bail!("Session archive document belongs to another workspace")
    }
    Ok((manifest, chunks))
}

fn validate_archive_directory_chain(directory: &Path) -> Result<()> {
    // The runtime derives this path itself, but an attacker with local filesystem access could
    // otherwise replace a continuation directory (or one of its parents) with a symlink between
    // creation and a later MCP read.
    for path in directory.ancestors() {
        let metadata = std::fs::symlink_metadata(path).with_context(|| {
            format!(
                "Session archive directory is unavailable: {}",
                path.display()
            )
        })?;
        if agentkib_platform::path::is_reparse_or_symlink(path)? || !metadata.is_dir() {
            bail!("Session archive contains an invalid directory")
        }
    }
    Ok(())
}

pub fn search_session_archive(
    data_root: &Path,
    workspace_id: &str,
    archive_id: &str,
    query: &str,
    limit: usize,
) -> Result<SessionArchiveSearchResult> {
    if query.chars().count() > 256 {
        bail!("Session archive query exceeds 256 characters")
    }
    let directory = archive_directory(data_root, workspace_id, archive_id)?;
    let (manifest, chunks) = read_validated_session_archive(&directory, workspace_id, archive_id)?;
    let chunks = parse_chunks(&chunks)?;
    let needle = query.to_lowercase();
    let mut hits = chunks
        .into_iter()
        .rev()
        .filter(|chunk| {
            needle.is_empty()
                || chunk.content.to_lowercase().contains(&needle)
                || format!(
                    "{} turn_id={} {}",
                    chunk.block_id, chunk.turn_id, chunk.block_type
                )
                .to_lowercase()
                .contains(&needle)
        })
        .take(limit.clamp(1, 20))
        .map(|chunk| {
            let (first_chunk_id, last_chunk_id) = chunk_range_ids(&chunk);
            SessionArchiveSearchHit {
                chunk_id: chunk.chunk_id,
                block_id: chunk.block_id,
                turn_id: chunk.turn_id,
                role: chunk.role,
                timestamp: chunk.timestamp,
                block_type: chunk.block_type,
                part: chunk.part,
                parts: chunk.parts,
                first_chunk_id,
                last_chunk_id,
                snippet: snippet(&chunk.content, &needle, 500),
            }
        })
        .collect::<Vec<_>>();
    hits.reverse();
    Ok(SessionArchiveSearchResult {
        archive_id: archive_id.into(),
        chunk_count: manifest.chunk_count,
        hits,
    })
}

pub fn read_session_archive_chunk(
    data_root: &Path,
    workspace_id: &str,
    archive_id: &str,
    chunk_id: &str,
) -> Result<SessionArchiveChunk> {
    if !valid_chunk_id(chunk_id) {
        bail!("Invalid session archive chunk ID")
    }
    let directory = archive_directory(data_root, workspace_id, archive_id)?;
    let (_, chunks) = read_validated_session_archive(&directory, workspace_id, archive_id)?;
    parse_chunks(&chunks)?
        .into_iter()
        .find(|chunk| chunk.chunk_id == chunk_id)
        .context("Session archive chunk was not found")
}

fn estimate_turn_tokens(turn: &SessionTurn) -> usize {
    turn.blocks
        .iter()
        .map(estimate_block_tokens)
        .sum::<usize>()
        .saturating_add(16)
}

fn estimate_block_tokens(block: &SessionBlock) -> usize {
    let content = match block {
        SessionBlock::Text { text } => estimate_text_tokens(text),
        SessionBlock::ToolCall {
            call_id,
            name,
            input,
        } => {
            estimate_text_tokens(call_id) + estimate_text_tokens(name) + estimate_text_tokens(input)
        }
        SessionBlock::ToolResult {
            call_id, output, ..
        } => estimate_text_tokens(call_id) + estimate_text_tokens(output),
        SessionBlock::Attachment {
            media_type,
            filename,
            inline_base64,
            ..
        } => {
            estimate_text_tokens(media_type)
                + filename.as_deref().map(estimate_text_tokens).unwrap_or(0)
                + inline_base64
                    .as_deref()
                    .map(estimate_text_tokens)
                    .unwrap_or(0)
        }
    };
    content.saturating_add(8)
}

fn conversation_groups(turns: &[SessionTurn]) -> Vec<Vec<SessionTurn>> {
    let mut groups: Vec<Vec<SessionTurn>> = Vec::new();
    for turn in turns {
        let contains_tool_result = turn
            .blocks
            .iter()
            .any(|block| matches!(block, SessionBlock::ToolResult { .. }));
        let starts_exchange = turn.role == SessionRole::User
            && !contains_tool_result
            && turn
                .blocks
                .iter()
                .any(|block| matches!(block, SessionBlock::Text { .. }));
        if starts_exchange || groups.is_empty() {
            groups.push(Vec::new());
        }
        if let Some(group) = groups.last_mut() {
            group.push(turn.clone());
        }
    }
    while groups.first().is_some_and(|group| {
        group
            .first()
            .map(|turn| turn.role != SessionRole::User)
            .unwrap_or(true)
    }) {
        groups.remove(0);
    }
    groups
}

fn archive_reference(archive_id: &str, turn_id: &str, block: usize, block_id: &str) -> String {
    format!(
        "[AgentKib archived an oversized block: archive_id={archive_id}, turn_id={turn_id}, block={block}, block_id={block_id}. Use session_search with query \"{block_id}\"; each hit includes the exact first/last chunk IDs for session_read_chunk.]"
    )
}

fn archive_chunks(document: &SessionDocument) -> Vec<SessionArchiveChunk> {
    let mut chunks = Vec::new();
    let mut block_number = 0usize;
    for turn in &document.turns {
        for block in &turn.blocks {
            block_number += 1;
            let (block_type, content) = archive_block(block);
            let fragments = split_chars(&content, ARCHIVE_FRAGMENT_CHARS);
            let parts = fragments.len();
            for (part, content) in fragments.into_iter().enumerate() {
                chunks.push(SessionArchiveChunk {
                    chunk_id: format!("chunk-{:06}", chunks.len() + 1),
                    block_id: block_id(block_number),
                    turn_id: turn.id.clone(),
                    role: turn.role,
                    timestamp: turn.timestamp,
                    block_type: block_type.into(),
                    part: part + 1,
                    parts,
                    content,
                });
            }
        }
    }
    chunks
}

fn block_id(index: usize) -> String {
    format!("block-{index:06}")
}

fn chunk_range_ids(chunk: &SessionArchiveChunk) -> (String, String) {
    let current = chunk
        .chunk_id
        .strip_prefix("chunk-")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(1);
    let first = current.saturating_sub(chunk.part.saturating_sub(1)).max(1);
    let last = first.saturating_add(chunk.parts.saturating_sub(1));
    (format!("chunk-{first:06}"), format!("chunk-{last:06}"))
}

fn archive_block(block: &SessionBlock) -> (&'static str, String) {
    match block {
        SessionBlock::Text { text } => ("text", text.clone()),
        SessionBlock::ToolCall { call_id, name, input } => ("tool-call", serde_json::json!({"call_id":call_id,"name":name,"input":input}).to_string()),
        SessionBlock::ToolResult { call_id, output, is_error } => ("tool-result", serde_json::json!({"call_id":call_id,"output":output,"is_error":is_error}).to_string()),
        SessionBlock::Attachment { kind, media_type, filename, inline_base64 } => ("attachment", serde_json::json!({"kind":kind,"media_type":media_type,"filename":filename,"inline_base64":inline_base64}).to_string()),
    }
}

fn split_chars(value: &str, maximum: usize) -> Vec<String> {
    if value.is_empty() {
        return vec![String::new()];
    }
    let mut values = Vec::new();
    let mut current = String::new();
    for character in value.chars() {
        if current.len().saturating_add(character.len_utf8()) > maximum && !current.is_empty() {
            values.push(std::mem::take(&mut current));
        }
        current.push(character);
    }
    if !current.is_empty() {
        values.push(current);
    }
    values
}

fn parse_chunks(value: &[u8]) -> Result<Vec<SessionArchiveChunk>> {
    let reader = BufReader::new(value);
    let mut chunks = Vec::new();
    for (index, line) in reader.lines().enumerate() {
        let line = line?;
        if line.len() > MAX_ARCHIVE_CHUNK_BYTES {
            bail!(
                "Session archive chunk {} exceeds the 64 KiB limit",
                index + 1
            )
        }
        chunks.push(serde_json::from_str(&line)?);
    }
    Ok(chunks)
}

fn read_limited(path: &Path, maximum: u64) -> Result<Vec<u8>> {
    let file = File::open(path)?;
    if file.metadata()?.len() > maximum {
        bail!("Session archive file exceeds its read limit")
    }
    let mut value = Vec::new();
    file.take(maximum + 1).read_to_end(&mut value)?;
    if value.len() as u64 > maximum {
        bail!("Session archive file exceeds its read limit")
    }
    Ok(value)
}

fn read_limited_json<T: for<'de> Deserialize<'de>>(path: &Path, maximum: u64) -> Result<T> {
    Ok(serde_json::from_slice(&read_limited(path, maximum)?)?)
}

fn snippet(content: &str, needle: &str, maximum: usize) -> String {
    let lower = content.to_lowercase();
    let start = if needle.is_empty() {
        0
    } else {
        lower.find(needle).unwrap_or(0).saturating_sub(maximum / 4)
    };
    let mut output = content
        .get(start..)
        .unwrap_or(content)
        .chars()
        .take(maximum)
        .collect::<String>();
    if start > 0 {
        output.insert(0, '…');
    }
    if output.len() < content.len().saturating_sub(start) {
        output.push('…');
    }
    output
}

fn valid_chunk_id(value: &str) -> bool {
    value.len() == 12
        && value.starts_with("chunk-")
        && value[6..]
            .chars()
            .all(|character| character.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use agentkib_core::AgentKind;
    use tempfile::tempdir;

    use super::*;
    use crate::SessionDocumentSource;

    fn document(turns: Vec<SessionTurn>) -> SessionDocument {
        SessionDocument {
            schema_version: SESSION_DOCUMENT_SCHEMA_VERSION,
            source: SessionDocumentSource {
                agent: AgentKind::Codex,
                workspace_id: "workspace".into(),
                title: None,
                created_at: None,
                updated_at: None,
                git_branch: None,
            },
            turns,
            losses: Vec::new(),
            redaction_count: 0,
        }
    }

    fn text_turn(id: usize, role: SessionRole, text: String) -> SessionTurn {
        SessionTurn {
            id: format!("turn-{id}"),
            role,
            timestamp: None,
            blocks: vec![SessionBlock::Text { text }],
        }
    }

    #[test]
    fn windows_a_large_session_without_marking_a_loss() {
        let turns = (0..40)
            .flat_map(|index| {
                [
                    text_turn(
                        index * 2,
                        SessionRole::User,
                        format!("task {index} {}", "中".repeat(5_000)),
                    ),
                    text_turn(
                        index * 2 + 1,
                        SessionRole::Assistant,
                        "answer ".repeat(2_000),
                    ),
                ]
            })
            .collect();
        let source = document(turns);
        let plan = plan_session_window(&source, 64_000, &Uuid::new_v4().to_string()).unwrap();
        assert_eq!(plan.strategy, SessionWindowStrategy::Windowed);
        assert!(plan.stats.estimated_active_tokens <= 64_000);
        assert!(plan.stats.deferred_turn_count > 0);
        assert!(plan.active_document.losses.is_empty());
        assert_eq!(
            plan.active_document.turns.first().unwrap().role,
            SessionRole::User
        );
    }

    #[test]
    fn one_million_token_source_keeps_a_bounded_recent_window() {
        let turns = (0..300)
            .flat_map(|index| {
                [
                    text_turn(
                        index * 2,
                        SessionRole::User,
                        format!("task {index} {}", "中".repeat(4_000)),
                    ),
                    text_turn(
                        index * 2 + 1,
                        SessionRole::Assistant,
                        "answer ".repeat(1_000),
                    ),
                ]
            })
            .collect();
        let source = document(turns);
        assert!(estimate_document_tokens(&source) > 1_000_000);
        let plan = plan_session_window(&source, 120_000, &Uuid::new_v4().to_string()).unwrap();
        assert_eq!(plan.strategy, SessionWindowStrategy::Windowed);
        assert!(plan.stats.estimated_active_tokens <= 120_000);
        assert!(plan.stats.estimated_deferred_tokens > 800_000);
        assert_eq!(
            plan.active_document.turns.first().unwrap().role,
            SessionRole::User
        );
    }

    #[test]
    fn archive_size_limit_applies_to_aggregate_content() {
        assert!(validate_archive_size(MAX_ARCHIVE_BYTES, "chunks").is_ok());
        assert!(validate_archive_size(MAX_ARCHIVE_BYTES + 1, "chunks").is_err());
    }

    #[test]
    fn tool_call_and_result_stay_in_the_same_recent_exchange() {
        let source = document(vec![
            text_turn(1, SessionRole::User, "inspect".into()),
            SessionTurn {
                id: "turn-2".into(),
                role: SessionRole::Assistant,
                timestamp: None,
                blocks: vec![SessionBlock::ToolCall {
                    call_id: "call-1".into(),
                    name: "read".into(),
                    input: "{}".into(),
                }],
            },
            SessionTurn {
                id: "turn-3".into(),
                role: SessionRole::User,
                timestamp: None,
                blocks: vec![SessionBlock::ToolResult {
                    call_id: "call-1".into(),
                    output: "done".into(),
                    is_error: false,
                }],
            },
            text_turn(4, SessionRole::Assistant, "finished".into()),
        ]);
        let plan = plan_session_window(&source, 64_000, &Uuid::new_v4().to_string()).unwrap();
        let encoded = serde_json::to_string(&plan.active_document).unwrap();
        assert!(encoded.contains("tool-call"));
        assert!(encoded.contains("tool-result"));
    }

    #[test]
    fn tool_result_with_text_cannot_start_a_new_window_exchange() {
        let source = document(vec![
            text_turn(1, SessionRole::User, "inspect".into()),
            SessionTurn {
                id: "turn-2".into(),
                role: SessionRole::Assistant,
                timestamp: None,
                blocks: vec![SessionBlock::ToolCall {
                    call_id: "call-1".into(),
                    name: "read".into(),
                    input: "x".repeat(45_000),
                }],
            },
            text_turn(5, SessionRole::Assistant, "x".repeat(45_000)),
            text_turn(6, SessionRole::Assistant, "x".repeat(45_000)),
            text_turn(7, SessionRole::Assistant, "x".repeat(45_000)),
            text_turn(8, SessionRole::Assistant, "x".repeat(45_000)),
            SessionTurn {
                id: "turn-3".into(),
                role: SessionRole::User,
                timestamp: None,
                blocks: vec![
                    SessionBlock::ToolResult {
                        call_id: "call-1".into(),
                        output: "done".into(),
                        is_error: false,
                    },
                    SessionBlock::Text {
                        text: "continue".into(),
                    },
                ],
            },
            text_turn(4, SessionRole::Assistant, "finished".into()),
        ]);
        let plan = plan_session_window(&source, 64_000, &Uuid::new_v4().to_string()).unwrap();
        let encoded = serde_json::to_string(&plan.active_document).unwrap();
        assert!(!encoded.contains("tool-result") || encoded.contains("tool-call"));
    }

    #[test]
    fn oversized_block_reference_resolves_to_its_exact_chunk_range() {
        let source = document(vec![text_turn(
            1,
            SessionRole::User,
            "archived evidence ".repeat(5_000),
        )]);
        let archive_id = Uuid::new_v4().to_string();
        let plan = plan_session_window(&source, 64_000, &archive_id).unwrap();
        let active = serde_json::to_string(&plan.active_document).unwrap();
        assert!(active.contains("block-000001"));

        let bundle =
            build_session_archive(&source, "workspace", &archive_id, "fingerprint", Utc::now())
                .unwrap();
        let root = tempfile::tempdir_in(std::env::current_dir().unwrap()).unwrap();
        let directory = archive_directory(root.path(), "workspace", &archive_id).unwrap();
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("manifest.json"), bundle.manifest_content).unwrap();
        std::fs::write(directory.join("document.json"), bundle.document_content).unwrap();
        std::fs::write(directory.join("chunks.jsonl"), bundle.chunks_content).unwrap();

        let result =
            search_session_archive(root.path(), "workspace", &archive_id, "block-000001", 20)
                .unwrap();
        assert!(!result.hits.is_empty());
        assert!(result.hits.iter().all(|hit| hit.block_id == "block-000001"));
        assert_eq!(result.hits[0].first_chunk_id, "chunk-000001");
        assert!(result.hits[0].parts > 1);
        assert_eq!(
            result.hits[0].last_chunk_id,
            format!("chunk-{:06}", result.hits[0].parts)
        );
    }

    #[test]
    fn archives_and_reads_scoped_chunks() {
        let source = document(vec![text_turn(
            1,
            SessionRole::User,
            "find this needle".into(),
        )]);
        let archive_id = Uuid::new_v4().to_string();
        let bundle =
            build_session_archive(&source, "workspace", &archive_id, "fingerprint", Utc::now())
                .unwrap();
        let root = tempfile::tempdir_in(std::env::current_dir().unwrap()).unwrap();
        let directory = archive_directory(root.path(), "workspace", &archive_id).unwrap();
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("manifest.json"), bundle.manifest_content).unwrap();
        std::fs::write(directory.join("document.json"), bundle.document_content).unwrap();
        std::fs::write(directory.join("chunks.jsonl"), bundle.chunks_content).unwrap();
        let result =
            search_session_archive(root.path(), "workspace", &archive_id, "needle", 10).unwrap();
        assert_eq!(result.hits.len(), 1);
        assert_eq!(result.hits[0].block_id, "block-000001");
        assert_eq!(result.hits[0].first_chunk_id, "chunk-000001");
        assert_eq!(result.hits[0].last_chunk_id, "chunk-000001");
        let chunk = read_session_archive_chunk(
            root.path(),
            "workspace",
            &archive_id,
            &result.hits[0].chunk_id,
        )
        .unwrap();
        assert!(chunk.content.contains("needle"));
        assert!(search_session_archive(root.path(), "other", &archive_id, "", 10).is_err());
    }

    #[test]
    fn archive_validation_rejects_tampered_chunks() {
        let source = document(vec![text_turn(
            1,
            SessionRole::User,
            "original archived evidence".into(),
        )]);
        let archive_id = Uuid::new_v4().to_string();
        let bundle =
            build_session_archive(&source, "workspace", &archive_id, "fingerprint", Utc::now())
                .unwrap();
        let root = tempfile::tempdir_in(std::env::current_dir().unwrap()).unwrap();
        let directory = archive_directory(root.path(), "workspace", &archive_id).unwrap();
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("manifest.json"), bundle.manifest_content).unwrap();
        std::fs::write(directory.join("document.json"), bundle.document_content).unwrap();
        std::fs::write(
            directory.join("chunks.jsonl"),
            bundle
                .chunks_content
                .replace("original archived evidence", "tampered archived evidence"),
        )
        .unwrap();

        assert!(validate_session_archive(&directory, "workspace", &archive_id).is_err());
        assert!(
            search_session_archive(root.path(), "workspace", &archive_id, "tampered", 10).is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn archive_validation_rejects_symlinked_directory_ancestors() {
        use std::os::unix::fs::symlink;

        let source = document(vec![text_turn(1, SessionRole::User, "private".into())]);
        let archive_id = Uuid::new_v4().to_string();
        let bundle =
            build_session_archive(&source, "workspace", &archive_id, "fingerprint", Utc::now())
                .unwrap();
        let root = tempfile::tempdir_in(std::env::current_dir().unwrap()).unwrap();
        let outside = tempdir().unwrap();
        let outside_directory =
            archive_directory(outside.path(), "workspace", &archive_id).unwrap();
        std::fs::create_dir_all(&outside_directory).unwrap();
        std::fs::write(
            outside_directory.join("manifest.json"),
            bundle.manifest_content,
        )
        .unwrap();
        std::fs::write(
            outside_directory.join("document.json"),
            bundle.document_content,
        )
        .unwrap();
        std::fs::write(
            outside_directory.join("chunks.jsonl"),
            bundle.chunks_content,
        )
        .unwrap();
        symlink(
            outside.path().join("continuations"),
            root.path().join("continuations"),
        )
        .unwrap();

        let linked_directory = archive_directory(root.path(), "workspace", &archive_id).unwrap();
        assert!(validate_session_archive(&linked_directory, "workspace", &archive_id).is_err());
    }
}
