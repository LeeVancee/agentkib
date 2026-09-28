use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use agentkib_platform::process::{ProcessTree, configure_process_group};
use anyhow::{Context, Result, bail};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(15);
const STATUS_LIMIT: usize = 2 * 1024 * 1024;
const HISTORY_LIMIT: usize = 16 * 1024 * 1024;
const FILES_LIMIT: usize = 8 * 1024 * 1024;
const DIFF_LIMIT: usize = 4 * 1024 * 1024;
const DEFAULT_PAGE_SIZE: usize = 300;
const MAX_PAGE_SIZE: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GitRefKind {
    Head,
    LocalBranch,
    RemoteBranch,
    Tag,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitRefLabel {
    pub name: String,
    pub full_name: String,
    pub kind: GitRefKind,
    pub current: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GitChangeKind {
    Modified,
    Added,
    Deleted,
    Renamed,
    Copied,
    Untracked,
    Conflict,
    TypeChanged,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitWorkingTreeChange {
    pub path: String,
    pub old_path: Option<String>,
    pub kind: GitChangeKind,
    pub index_status: Option<char>,
    pub worktree_status: Option<char>,
    pub conflicted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitWorkspaceSummary {
    pub repository_root: PathBuf,
    pub worktree_root: PathBuf,
    pub head: Option<String>,
    pub head_oid: Option<String>,
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub stash_count: usize,
    pub detached: bool,
    pub refs: Vec<GitRefLabel>,
    pub changes: Vec<GitWorkingTreeChange>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitHistoryQuery {
    pub cursor: Option<String>,
    pub limit: Option<usize>,
    pub reference: Option<String>,
    pub author: Option<String>,
    pub since: Option<String>,
    pub until: Option<String>,
    pub path: Option<String>,
    pub merges_only: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitCommitSummary {
    pub oid: String,
    pub parents: Vec<String>,
    pub subject: String,
    pub author_name: String,
    pub authored_at: DateTime<Utc>,
    pub refs: Vec<GitRefLabel>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitCommitPage {
    pub commits: Vec<GitCommitSummary>,
    pub next_cursor: Option<String>,
    pub repository_fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitFileChange {
    pub status: String,
    pub path: String,
    pub old_path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GitDiffKind {
    Commit,
    Worktree,
    Staged,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitDiffRequest {
    pub kind: GitDiffKind,
    pub path: Option<String>,
    pub oid: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitDiff {
    pub patch: String,
    pub binary: bool,
    pub submodule: bool,
    pub encoding_lossy: bool,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct HistoryCursor {
    fingerprint: String,
    offset: usize,
}

pub fn workspace_summary(workspace: &Path) -> Result<Option<GitWorkspaceSummary>> {
    let Some(repository) = repository(workspace)? else {
        return Ok(None);
    };
    let status = run_git(
        &repository.worktree_root,
        ["status", "--porcelain=v2", "-z", "--branch", "--show-stash"],
        STATUS_LIMIT,
    )?;
    let refs = list_refs(&repository.worktree_root)?;
    Ok(Some(parse_status(&repository, &status, refs)?))
}

pub fn history(workspace: &Path, query: &GitHistoryQuery) -> Result<Option<GitCommitPage>> {
    let Some(repository) = repository(workspace)? else {
        return Ok(None);
    };
    let fingerprint = repository_fingerprint(&repository.worktree_root)?;
    let offset = match query.cursor.as_deref() {
        Some(value) => {
            let bytes = hex::decode(value).context("Invalid Git history cursor")?;
            let cursor: HistoryCursor =
                serde_json::from_slice(&bytes).context("Invalid Git history cursor")?;
            if cursor.fingerprint != fingerprint {
                bail!("Git history changed; reload from the first page");
            }
            cursor.offset
        }
        None => 0,
    };
    let limit = query
        .limit
        .unwrap_or(DEFAULT_PAGE_SIZE)
        .clamp(1, MAX_PAGE_SIZE);
    let mut args = vec![
        OsString::from("log"),
        OsString::from("--topo-order"),
        OsString::from("--parents"),
        OsString::from("--decorate=full"),
        OsString::from("--date=iso-strict"),
        OsString::from("--format=%x1e%H%x1f%P%x1f%an%x1f%aI%x1f%D%x1f%s"),
        OsString::from(format!("--skip={offset}")),
        OsString::from(format!("--max-count={}", limit + 1)),
    ];
    if let Some(author) = non_empty(query.author.as_deref()) {
        args.push(OsString::from(format!("--author={author}")));
    }
    if let Some(since) = non_empty(query.since.as_deref()) {
        args.push(OsString::from(format!("--since={since}")));
    }
    if let Some(until) = non_empty(query.until.as_deref()) {
        args.push(OsString::from(format!("--until={until}")));
    }
    if query.merges_only {
        args.push(OsString::from("--merges"));
    }
    match non_empty(query.reference.as_deref()) {
        Some(reference) => {
            validate_reference(&repository.worktree_root, reference)?;
            args.push(OsString::from(reference));
        }
        None => args.push(OsString::from("--all")),
    }
    if let Some(path) = non_empty(query.path.as_deref()) {
        validate_relative_path(path)?;
        args.push(OsString::from("--"));
        args.push(OsString::from(path));
    }
    let output = run_git_os(&repository.worktree_root, &args, HISTORY_LIMIT)?;
    let mut commits = parse_history(&output)?;
    let has_more = commits.len() > limit;
    commits.truncate(limit);
    let next_cursor = has_more
        .then(|| {
            serde_json::to_vec(&HistoryCursor {
                fingerprint: fingerprint.clone(),
                offset: offset + limit,
            })
            .map(hex::encode)
        })
        .transpose()?;
    Ok(Some(GitCommitPage {
        commits,
        next_cursor,
        repository_fingerprint: fingerprint,
    }))
}

pub fn commit_files(workspace: &Path, oid: &str) -> Result<Option<Vec<GitFileChange>>> {
    let Some(repository) = repository(workspace)? else {
        return Ok(None);
    };
    validate_oid(oid)?;
    let mut args = vec![
        OsString::from("diff-tree"),
        OsString::from("-r"),
        OsString::from("-M"),
        OsString::from("--no-commit-id"),
        OsString::from("--name-status"),
        OsString::from("-z"),
    ];
    if let Some(parent) = first_parent(&repository.worktree_root, oid)? {
        args.extend([OsString::from(parent), OsString::from(oid)]);
    } else {
        args.extend([OsString::from("--root"), OsString::from(oid)]);
    }
    let output = run_git_os(&repository.worktree_root, &args, FILES_LIMIT)?;
    Ok(Some(parse_name_status(&output)))
}

pub fn diff(workspace: &Path, request: &GitDiffRequest) -> Result<Option<GitDiff>> {
    let Some(repository) = repository(workspace)? else {
        return Ok(None);
    };
    if let Some(path) = request.path.as_deref() {
        validate_relative_path(path)?;
    }
    let mut args = match request.kind {
        GitDiffKind::Commit => {
            let oid = request
                .oid
                .as_deref()
                .context("Commit diff requires an oid")?;
            validate_oid(oid)?;
            if let Some(parent) = first_parent(&repository.worktree_root, oid)? {
                vec![
                    OsString::from("diff"),
                    OsString::from(parent),
                    OsString::from(oid),
                ]
            } else {
                vec![
                    OsString::from("show"),
                    OsString::from("--format="),
                    OsString::from(oid),
                ]
            }
        }
        GitDiffKind::Worktree => vec![OsString::from("diff")],
        GitDiffKind::Staged => vec![OsString::from("diff"), OsString::from("--cached")],
    };
    args.extend([
        OsString::from("--no-ext-diff"),
        OsString::from("--no-textconv"),
        OsString::from("--no-color"),
    ]);
    if let Some(path) = request.path.as_deref() {
        args.extend([OsString::from("--"), OsString::from(path)]);
    }
    let bounded = run_git_bounded(&repository.worktree_root, &args, DIFF_LIMIT)?;
    let encoding_lossy = std::str::from_utf8(&bounded.bytes).is_err();
    let patch = String::from_utf8_lossy(&bounded.bytes).into_owned();
    let binary = patch.contains("GIT binary patch") || patch.contains("Binary files ");
    let submodule = patch.contains("Subproject commit ") || patch.contains("-Subproject commit ");
    Ok(Some(GitDiff {
        patch,
        binary,
        submodule,
        encoding_lossy,
        truncated: bounded.truncated,
    }))
}

/// Paths in the requested comparison, before applying an optional file selection.
/// Unlike status, this excludes untracked files and changes in the other index layer.
pub fn diff_files(
    workspace: &Path,
    request: &GitDiffRequest,
) -> Result<Option<Vec<GitFileChange>>> {
    if request.kind == GitDiffKind::Commit {
        return commit_files(
            workspace,
            request
                .oid
                .as_deref()
                .context("Commit diff requires an oid")?,
        );
    }
    let Some(repository) = repository(workspace)? else {
        return Ok(None);
    };
    let mut args = vec![
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--name-status",
        "-z",
    ];
    if request.kind == GitDiffKind::Staged {
        args.push("--cached");
    }
    let output = run_git(&repository.worktree_root, args, FILES_LIMIT)?;
    Ok(Some(parse_name_status(&output)))
}

fn first_parent(worktree: &Path, oid: &str) -> Result<Option<String>> {
    let output = run_git(
        worktree,
        ["rev-list", "--parents", "-n", "1", oid],
        64 * 1024,
    )?;
    Ok(String::from_utf8_lossy(&output)
        .split_whitespace()
        .nth(1)
        .map(str::to_string))
}

#[derive(Debug)]
struct Repository {
    repository_root: PathBuf,
    worktree_root: PathBuf,
}

fn repository(workspace: &Path) -> Result<Option<Repository>> {
    let workspace = agentkib_platform::path::canonicalize(workspace)?;
    let probe = run_git_allow_failure(&workspace, ["rev-parse", "--show-toplevel"], 64 * 1024)?;
    if !probe.success {
        return Ok(None);
    }
    let worktree_root = agentkib_platform::path::canonicalize(Path::new(
        String::from_utf8_lossy(&probe.bytes).trim(),
    ))?;
    if !agentkib_platform::path::starts_with(&workspace, &worktree_root)
        && !agentkib_platform::path::starts_with(&worktree_root, &workspace)
    {
        bail!("Git repository is outside the workspace boundary");
    }
    let common = run_git(
        &worktree_root,
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        64 * 1024,
    )?;
    let common = PathBuf::from(String::from_utf8_lossy(&common).trim());
    let repository_root = common.parent().unwrap_or(&worktree_root).to_path_buf();
    Ok(Some(Repository {
        repository_root,
        worktree_root,
    }))
}

fn parse_status(
    repository: &Repository,
    bytes: &[u8],
    refs: Vec<GitRefLabel>,
) -> Result<GitWorkspaceSummary> {
    let mut head = None;
    let mut head_oid = None;
    let mut upstream = None;
    let mut ahead = 0;
    let mut behind = 0;
    let mut stash_count = 0;
    let mut detached = false;
    let records: Vec<&[u8]> = bytes
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .collect();
    let mut changes = Vec::new();
    let mut index = 0;
    while index < records.len() {
        let record = String::from_utf8_lossy(records[index]);
        if let Some(value) = record.strip_prefix("# branch.head ") {
            detached = value == "(detached)";
            head = (!detached && value != "(unknown)").then(|| value.to_string());
        } else if let Some(value) = record.strip_prefix("# branch.oid ") {
            head_oid = (value != "(initial)").then(|| value.to_string());
        } else if let Some(value) = record.strip_prefix("# branch.upstream ") {
            upstream = Some(value.to_string());
        } else if let Some(value) = record.strip_prefix("# branch.ab ") {
            for field in value.split_whitespace() {
                if let Some(value) = field.strip_prefix('+') {
                    ahead = value.parse().unwrap_or(0);
                }
                if let Some(value) = field.strip_prefix('-') {
                    behind = value.parse().unwrap_or(0);
                }
            }
        } else if let Some(value) = record.strip_prefix("# stash ") {
            stash_count = value.parse().unwrap_or(0);
        } else if let Some(value) = record.strip_prefix("? ") {
            changes.push(GitWorkingTreeChange {
                path: value.to_string(),
                old_path: None,
                kind: GitChangeKind::Untracked,
                index_status: None,
                worktree_status: Some('?'),
                conflicted: false,
            });
        } else if record.starts_with("1 ") || record.starts_with("2 ") || record.starts_with("u ") {
            let renamed = record.starts_with("2 ");
            let conflicted = record.starts_with("u ");
            let fields: Vec<&str> = record
                .splitn(
                    if renamed {
                        10
                    } else if conflicted {
                        11
                    } else {
                        9
                    },
                    ' ',
                )
                .collect();
            let xy = fields.get(1).copied().unwrap_or("..");
            let path = fields.last().copied().unwrap_or_default().to_string();
            let old_path = if renamed && index + 1 < records.len() {
                index += 1;
                Some(String::from_utf8_lossy(records[index]).into_owned())
            } else {
                None
            };
            let index_status = xy.chars().next().filter(|value| *value != '.');
            let worktree_status = xy.chars().nth(1).filter(|value| *value != '.');
            changes.push(GitWorkingTreeChange {
                path,
                old_path,
                kind: if conflicted {
                    GitChangeKind::Conflict
                } else {
                    change_kind(index_status.or(worktree_status))
                },
                index_status,
                worktree_status,
                conflicted,
            });
        }
        index += 1;
    }
    Ok(GitWorkspaceSummary {
        repository_root: repository.repository_root.clone(),
        worktree_root: repository.worktree_root.clone(),
        head,
        head_oid,
        upstream,
        ahead,
        behind,
        stash_count,
        detached,
        refs,
        changes,
    })
}

fn change_kind(status: Option<char>) -> GitChangeKind {
    match status {
        Some('M') => GitChangeKind::Modified,
        Some('A') => GitChangeKind::Added,
        Some('D') => GitChangeKind::Deleted,
        Some('R') => GitChangeKind::Renamed,
        Some('C') => GitChangeKind::Copied,
        Some('T') => GitChangeKind::TypeChanged,
        Some('U') => GitChangeKind::Conflict,
        _ => GitChangeKind::Unknown,
    }
}

fn parse_history(bytes: &[u8]) -> Result<Vec<GitCommitSummary>> {
    let mut output = Vec::new();
    for record in bytes.split(|byte| *byte == 0x1e).skip(1) {
        let record = record.strip_suffix(b"\n").unwrap_or(record);
        if record.is_empty() {
            continue;
        }
        let fields: Vec<&[u8]> = record.splitn(6, |byte| *byte == 0x1f).collect();
        if fields.len() != 6 {
            continue;
        }
        let authored_at = String::from_utf8_lossy(fields[3]).parse::<DateTime<Utc>>()?;
        output.push(GitCommitSummary {
            oid: text(fields[0]),
            parents: text(fields[1])
                .split_whitespace()
                .map(str::to_string)
                .collect(),
            author_name: text(fields[2]),
            authored_at,
            refs: parse_decorations(&text(fields[4])),
            subject: sanitize_subject(&text(fields[5])),
        });
    }
    Ok(output)
}

fn list_refs(worktree: &Path) -> Result<Vec<GitRefLabel>> {
    let output = run_git(
        worktree,
        ["for-each-ref", "--format=%(refname)%09%(HEAD)"],
        2 * 1024 * 1024,
    )?;
    Ok(String::from_utf8_lossy(&output)
        .lines()
        .filter_map(|line| {
            let (name, head) = line.split_once('\t')?;
            Some(ref_label(name, head.trim() == "*"))
        })
        .collect())
}

fn parse_decorations(value: &str) -> Vec<GitRefLabel> {
    value
        .split(',')
        .filter_map(|part| {
            let mut name = part.trim();
            let current = name.starts_with("HEAD -> ");
            if current {
                name = name.trim_start_matches("HEAD -> ");
            }
            name = name.trim_start_matches("tag: ");
            (!name.is_empty()).then(|| ref_label(name, current))
        })
        .collect()
}

fn ref_label(full_name: &str, current: bool) -> GitRefLabel {
    let (kind, name) = if let Some(name) = full_name.strip_prefix("refs/heads/") {
        (GitRefKind::LocalBranch, name)
    } else if let Some(name) = full_name.strip_prefix("refs/remotes/") {
        (GitRefKind::RemoteBranch, name)
    } else if let Some(name) = full_name.strip_prefix("refs/tags/") {
        (GitRefKind::Tag, name)
    } else if full_name == "HEAD" {
        (GitRefKind::Head, full_name)
    } else {
        (GitRefKind::Other, full_name)
    };
    GitRefLabel {
        name: name.to_string(),
        full_name: full_name.to_string(),
        kind,
        current,
    }
}

fn repository_fingerprint(worktree: &Path) -> Result<String> {
    let refs = run_git(
        worktree,
        ["for-each-ref", "--format=%(refname)%00%(objectname)"],
        8 * 1024 * 1024,
    )?;
    let head = run_git_allow_failure(worktree, ["rev-parse", "HEAD"], 64 * 1024)?;
    let mut digest = Sha256::new();
    digest.update(refs);
    digest.update(head.bytes);
    Ok(hex::encode(digest.finalize()))
}

fn validate_reference(worktree: &Path, reference: &str) -> Result<()> {
    if reference.starts_with('-') || reference.contains('\0') {
        bail!("Invalid Git reference");
    }
    let result = run_git_allow_failure(
        worktree,
        ["rev-parse", "--verify", "--quiet", reference],
        64 * 1024,
    )?;
    if !result.success {
        bail!("Git reference does not exist");
    }
    Ok(())
}

fn validate_oid(oid: &str) -> Result<()> {
    if !(7..=64).contains(&oid.len()) || !oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        bail!("Invalid Git object id");
    }
    Ok(())
}

fn validate_relative_path(path: &str) -> Result<()> {
    if path.is_empty() || path.contains('\0') {
        bail!("Invalid empty Git path");
    }
    if Path::new(path).components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        bail!("Git path must stay inside the repository");
    }
    Ok(())
}

fn parse_name_status(bytes: &[u8]) -> Vec<GitFileChange> {
    let fields: Vec<String> = bytes
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
        .map(text)
        .collect();
    let mut output = Vec::new();
    let mut index = 0;
    while index < fields.len() {
        let status = fields[index].clone();
        index += 1;
        if status.starts_with('R') || status.starts_with('C') {
            if index + 1 >= fields.len() {
                break;
            }
            let old_path = fields[index].clone();
            let path = fields[index + 1].clone();
            index += 2;
            output.push(GitFileChange {
                status,
                path,
                old_path: Some(old_path),
            });
        } else {
            let Some(path) = fields.get(index).cloned() else {
                break;
            };
            index += 1;
            output.push(GitFileChange {
                status,
                path,
                old_path: None,
            });
        }
    }
    output
}

fn sanitize_subject(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_control() || *character == '\t')
        .take(500)
        .collect()
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}
fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .trim_end_matches(['\r', '\n'])
        .to_string()
}

fn run_git<I, S>(worktree: &Path, args: I, limit: usize) -> Result<Vec<u8>>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let args: Vec<OsString> = args
        .into_iter()
        .map(|value| value.as_ref().to_os_string())
        .collect();
    let result = run_git_bounded(worktree, &args, limit)?;
    if !result.success {
        bail!("Git command failed: {}", result.error);
    }
    Ok(result.bytes)
}

fn run_git_os(worktree: &Path, args: &[OsString], limit: usize) -> Result<Vec<u8>> {
    let result = run_git_bounded(worktree, args, limit)?;
    if !result.success {
        bail!("Git command failed: {}", result.error);
    }
    Ok(result.bytes)
}

fn run_git_allow_failure<I, S>(worktree: &Path, args: I, limit: usize) -> Result<BoundedOutput>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let args: Vec<OsString> = args
        .into_iter()
        .map(|value| value.as_ref().to_os_string())
        .collect();
    run_git_bounded(worktree, &args, limit)
}

struct BoundedOutput {
    bytes: Vec<u8>,
    truncated: bool,
    success: bool,
    error: String,
}

fn run_git_bounded(worktree: &Path, args: &[OsString], limit: usize) -> Result<BoundedOutput> {
    let executable = agentkib_platform::command::resolve("git").context("Git is not installed")?;
    let mut command = Command::new(executable);
    command
        .current_dir(worktree)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .arg("-c")
        .arg("color.ui=false")
        .arg("-c")
        .arg("core.quotepath=false")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_process_group(&mut command);
    let mut child = command.spawn().context("Failed to start Git")?;
    let process_tree = ProcessTree::attach(&child).context("Failed to supervise Git")?;
    let stdout = child.stdout.take().context("Git stdout is unavailable")?;
    let stderr = child.stderr.take().context("Git stderr is unavailable")?;
    let stdout_reader = thread::spawn(move || read_bounded(stdout, limit));
    let stderr_reader = thread::spawn(move || read_bounded(stderr, 64 * 1024));
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if started.elapsed() >= COMMAND_TIMEOUT {
            let _ = process_tree.terminate();
            let _ = child.kill();
            let _ = child.wait();
            bail!("Git command timed out");
        }
        thread::sleep(Duration::from_millis(20));
    };
    let (bytes, truncated) = stdout_reader
        .join()
        .map_err(|_| anyhow::anyhow!("Git stdout reader panicked"))??;
    let (stderr, _) = stderr_reader
        .join()
        .map_err(|_| anyhow::anyhow!("Git stderr reader panicked"))??;
    Ok(BoundedOutput {
        bytes,
        truncated,
        success: status.success(),
        error: String::from_utf8_lossy(&stderr)
            .trim()
            .chars()
            .take(500)
            .collect(),
    })
}

fn read_bounded(mut reader: impl Read, limit: usize) -> std::io::Result<(Vec<u8>, bool)> {
    let mut output = Vec::with_capacity(limit.min(64 * 1024));
    let mut buffer = [0_u8; 16 * 1024];
    let mut truncated = false;
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        let remaining = limit.saturating_sub(output.len());
        output.extend_from_slice(&buffer[..count.min(remaining)]);
        if count > remaining {
            truncated = true;
        }
    }
    Ok((output, truncated))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn git(path: &Path, args: &[&str]) {
        let status = Command::new("git")
            .current_dir(path)
            .args(args)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?} failed");
    }

    fn fixture() -> tempfile::TempDir {
        let directory = tempdir().unwrap();
        git(directory.path(), &["init", "-b", "main"]);
        git(directory.path(), &["config", "user.name", "AgentKib Test"]);
        git(
            directory.path(),
            &["config", "user.email", "test@example.invalid"],
        );
        std::fs::write(directory.path().join("hello.txt"), "first\n").unwrap();
        git(directory.path(), &["add", "hello.txt"]);
        git(directory.path(), &["commit", "-m", "initial"]);
        directory
    }

    #[test]
    fn reads_status_history_files_and_diff_without_mutating_repository() {
        let directory = fixture();
        let before = run_git(directory.path(), ["rev-parse", "HEAD"], 1024).unwrap();
        std::fs::write(directory.path().join("hello.txt"), "changed\n").unwrap();
        std::fs::write(directory.path().join("新文件.txt"), "new\n").unwrap();
        let summary = workspace_summary(directory.path()).unwrap().unwrap();
        assert_eq!(summary.head.as_deref(), Some("main"));
        assert_eq!(summary.changes.len(), 2);
        let page = history(directory.path(), &GitHistoryQuery::default())
            .unwrap()
            .unwrap();
        assert_eq!(page.commits[0].subject, "initial");
        let files = commit_files(directory.path(), &page.commits[0].oid)
            .unwrap()
            .unwrap();
        assert_eq!(files[0].path, "hello.txt");
        let full_diff = diff(
            directory.path(),
            &GitDiffRequest {
                kind: GitDiffKind::Worktree,
                path: None,
                oid: None,
            },
        )
        .unwrap()
        .unwrap();
        assert!(full_diff.patch.contains("changed"));
        let diff = diff(
            directory.path(),
            &GitDiffRequest {
                kind: GitDiffKind::Worktree,
                path: Some("hello.txt".into()),
                oid: None,
            },
        )
        .unwrap()
        .unwrap();
        assert!(diff.patch.contains("changed"));
        let after = run_git(directory.path(), ["rev-parse", "HEAD"], 1024).unwrap();
        assert_eq!(before, after);
    }

    #[test]
    fn reads_full_diff_for_root_and_empty_commits() {
        let directory = fixture();
        let root_oid = String::from_utf8(
            run_git(
                directory.path(),
                ["rev-list", "--max-parents=0", "HEAD"],
                1024,
            )
            .unwrap(),
        )
        .unwrap();
        let root_diff = diff(
            directory.path(),
            &GitDiffRequest {
                kind: GitDiffKind::Commit,
                path: None,
                oid: Some(root_oid.trim().into()),
            },
        )
        .unwrap()
        .unwrap();
        assert!(root_diff.patch.contains("hello.txt"));
        assert!(root_diff.patch.contains("first"));

        git(
            directory.path(),
            &["commit", "--allow-empty", "-m", "empty"],
        );
        let empty_oid =
            String::from_utf8(run_git(directory.path(), ["rev-parse", "HEAD"], 1024).unwrap())
                .unwrap();
        let empty_diff = diff(
            directory.path(),
            &GitDiffRequest {
                kind: GitDiffKind::Commit,
                path: None,
                oid: Some(empty_oid.trim().into()),
            },
        )
        .unwrap()
        .unwrap();
        assert!(empty_diff.patch.is_empty());
    }

    #[test]
    fn stale_cursor_is_rejected_after_refs_change() {
        let directory = fixture();
        std::fs::write(directory.path().join("second.txt"), "second\n").unwrap();
        git(directory.path(), &["add", "second.txt"]);
        git(directory.path(), &["commit", "-m", "second"]);
        let first = history(
            directory.path(),
            &GitHistoryQuery {
                limit: Some(1),
                ..Default::default()
            },
        )
        .unwrap()
        .unwrap();
        assert!(first.next_cursor.is_some());
        std::fs::write(directory.path().join("third.txt"), "third\n").unwrap();
        git(directory.path(), &["add", "third.txt"]);
        git(directory.path(), &["commit", "-m", "third"]);
        let error = history(
            directory.path(),
            &GitHistoryQuery {
                cursor: first.next_cursor,
                limit: Some(1),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(error.to_string().contains("history changed"));
    }

    #[test]
    fn filters_merge_history_and_reports_refs_and_renames() {
        let directory = fixture();
        git(directory.path(), &["checkout", "-b", "feature"]);
        std::fs::write(directory.path().join("feature.txt"), "feature\n").unwrap();
        git(directory.path(), &["add", "feature.txt"]);
        git(directory.path(), &["commit", "-m", "feature change"]);
        git(directory.path(), &["checkout", "main"]);
        std::fs::write(directory.path().join("main.txt"), "main\n").unwrap();
        git(directory.path(), &["add", "main.txt"]);
        git(directory.path(), &["commit", "-m", "main change"]);
        git(
            directory.path(),
            &["merge", "--no-ff", "feature", "-m", "merge feature"],
        );
        git(directory.path(), &["tag", "v1"]);

        let page = history(
            directory.path(),
            &GitHistoryQuery {
                merges_only: true,
                ..Default::default()
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(page.commits.len(), 1);
        assert_eq!(page.commits[0].parents.len(), 2);
        assert!(
            page.commits[0]
                .refs
                .iter()
                .any(|reference| reference.kind == GitRefKind::Tag)
        );
        let merge_oid = &page.commits[0].oid;
        let merge_files = commit_files(directory.path(), merge_oid).unwrap().unwrap();
        assert!(
            merge_files
                .iter()
                .any(|change| change.path == "feature.txt")
        );
        let merge_diff = diff(
            directory.path(),
            &GitDiffRequest {
                kind: GitDiffKind::Commit,
                path: Some("feature.txt".into()),
                oid: Some(merge_oid.clone()),
            },
        )
        .unwrap()
        .unwrap();
        assert!(merge_diff.patch.contains("feature"));
        let full_merge_diff = diff(
            directory.path(),
            &GitDiffRequest {
                kind: GitDiffKind::Commit,
                path: None,
                oid: Some(merge_oid.clone()),
            },
        )
        .unwrap()
        .unwrap();
        assert!(full_merge_diff.patch.contains(&merge_diff.patch));

        git(directory.path(), &["mv", "hello.txt", "renamed.txt"]);
        git(directory.path(), &["commit", "-m", "rename file"]);
        let latest = history(
            directory.path(),
            &GitHistoryQuery {
                limit: Some(1),
                ..Default::default()
            },
        )
        .unwrap()
        .unwrap();
        let files = commit_files(directory.path(), &latest.commits[0].oid)
            .unwrap()
            .unwrap();
        assert_eq!(files[0].old_path.as_deref(), Some("hello.txt"));
        assert_eq!(files[0].path, "renamed.txt");
    }

    #[test]
    fn reports_submodule_and_binary_diffs_without_treating_them_as_text() {
        let directory = fixture();
        let head =
            String::from_utf8(run_git(directory.path(), ["rev-parse", "HEAD"], 1024).unwrap())
                .unwrap();
        git(
            directory.path(),
            &[
                "update-index",
                "--add",
                "--cacheinfo",
                &format!("160000,{},vendor/demo", head.trim()),
            ],
        );
        git(directory.path(), &["commit", "-m", "add submodule pointer"]);
        let submodule_oid =
            String::from_utf8(run_git(directory.path(), ["rev-parse", "HEAD"], 1024).unwrap())
                .unwrap();
        let submodule = diff(
            directory.path(),
            &GitDiffRequest {
                kind: GitDiffKind::Commit,
                path: Some("vendor/demo".into()),
                oid: Some(submodule_oid.trim().into()),
            },
        )
        .unwrap()
        .unwrap();
        assert!(submodule.submodule);

        std::fs::write(directory.path().join("image.bin"), [0, 159, 146, 150]).unwrap();
        git(directory.path(), &["add", "image.bin"]);
        git(directory.path(), &["commit", "-m", "add binary"]);
        let binary_oid =
            String::from_utf8(run_git(directory.path(), ["rev-parse", "HEAD"], 1024).unwrap())
                .unwrap();
        let binary = diff(
            directory.path(),
            &GitDiffRequest {
                kind: GitDiffKind::Commit,
                path: Some("image.bin".into()),
                oid: Some(binary_oid.trim().into()),
            },
        )
        .unwrap()
        .unwrap();
        assert!(binary.binary);
        assert!(!binary.encoding_lossy);
    }

    #[test]
    fn rejects_paths_outside_repository() {
        assert!(validate_relative_path("../secret").is_err());
        assert!(validate_relative_path("/tmp/secret").is_err());
        assert!(validate_relative_path("src/main.rs").is_ok());
    }
}
