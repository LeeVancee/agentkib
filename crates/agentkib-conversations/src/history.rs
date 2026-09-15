//! Shared bounded helpers for read-only providers whose native stores are outside Codex.

use std::collections::VecDeque;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use anyhow::{Context, Result, bail};
use sha2::{Digest, Sha256};

pub(super) const MAX_DISCOVERY_FILES: usize = 20_000;
pub(super) const MAX_METADATA_BYTES: u64 = 2 * 1024 * 1024;
pub(super) const MAX_HEAD_LINES: usize = 64;
pub(super) const MAX_TAIL_LINES: usize = 32;

pub(super) fn belongs_to_workspace(cwd: &Path, workspace: &Path) -> bool {
    let home = dirs::home_dir();
    match (
        agentkib_platform::path::session_workspace_root(cwd, home.as_deref()),
        agentkib_platform::path::session_workspace_root(workspace, home.as_deref()),
    ) {
        (Some(left), Some(right)) => agentkib_platform::path::equivalent(&left, &right),
        _ => false,
    }
}

pub(super) fn stable_native_ref(kind: &str, parts: &[&str]) -> String {
    let mut input = String::from(kind);
    for part in parts {
        input.push('\0');
        input.push_str(part);
    }
    format!(
        "{kind}-v1-{}",
        hex::encode(Sha256::digest(input.as_bytes()))
    )
}

pub(super) fn safe_regular_file(path: &Path, max_bytes: Option<u64>) -> Result<File> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("Cannot inspect history source {}", path.display()))?;
    if !metadata.file_type().is_file() {
        bail!("History source is not a regular file");
    }
    if let Some(max_bytes) = max_bytes {
        anyhow::ensure!(
            metadata.len() <= max_bytes,
            "History source exceeds read limit"
        );
    }
    File::open(path).with_context(|| format!("Cannot open history source {}", path.display()))
}

pub(super) fn read_bounded(path: &Path, max_bytes: u64) -> Result<Vec<u8>> {
    let file = safe_regular_file(path, Some(max_bytes))?;
    let mut output = Vec::new();
    file.take(max_bytes.saturating_add(1))
        .read_to_end(&mut output)
        .with_context(|| format!("Cannot read history source {}", path.display()))?;
    anyhow::ensure!(
        output.len() as u64 <= max_bytes,
        "History source exceeds read limit"
    );
    Ok(output)
}

pub(super) fn read_head_tail_lines(path: &Path) -> Result<(Vec<String>, Vec<String>)> {
    const HEAD_BYTES: u64 = 2 * 1024 * 1024;
    const TAIL_BYTES: u64 = 512 * 1024;
    let mut file = safe_regular_file(path, None)?;
    let length = file.metadata()?.len();
    let mut head_bytes = Vec::new();
    file.seek(SeekFrom::Start(0))?;
    (&mut file).take(HEAD_BYTES).read_to_end(&mut head_bytes)?;
    let mut tail_bytes = Vec::new();
    file.seek(SeekFrom::Start(length.saturating_sub(TAIL_BYTES)))?;
    file.take(TAIL_BYTES).read_to_end(&mut tail_bytes)?;
    // The bounded tail may begin in the middle of a UTF-8 sequence or JSONL
    // record. Drop that partial first line so a valid following record is not
    // mistaken for a damaged metadata record.
    if length > TAIL_BYTES
        && let Some(newline) = tail_bytes.iter().position(|byte| *byte == b'\n')
    {
        tail_bytes.drain(..=newline);
    }

    let head = String::from_utf8_lossy(&head_bytes)
        .lines()
        .take(MAX_HEAD_LINES)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let mut tail = VecDeque::with_capacity(MAX_TAIL_LINES);
    for line in String::from_utf8_lossy(&tail_bytes).lines() {
        let line = line.to_owned();
        if tail.len() == MAX_TAIL_LINES {
            tail.pop_front();
        }
        tail.push_back(line);
    }
    Ok((head, tail.into_iter().collect()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn tail_seek_inside_utf8_record_keeps_following_jsonl() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("history.jsonl");
        let suffix = "中\n{\"marker\":\"ok\"}\n";
        let prefix_len = 512 * 1024 - suffix.len() + 1;
        let mut bytes = vec![b'x'; prefix_len];
        bytes.extend_from_slice(suffix.as_bytes());
        fs::write(&path, bytes).unwrap();
        let (_, tail) = read_head_tail_lines(&path).unwrap();
        assert!(tail.iter().any(|line| line.contains("\"marker\":\"ok\"")));
    }
}
