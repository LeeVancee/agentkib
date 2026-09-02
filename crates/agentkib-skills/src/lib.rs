use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use agentkib_core::{
    CatalogAsset, CatalogScope, InstalledSkill, InstalledSkillStatus, RemovedSkill, SkillCandidate,
    SkillCatalogEntry, SkillCatalogSnapshot, SkillFileEntry, SkillFilePreview, SkillOperationKind,
    SkillOperationPreview, SkillSource, SkillSourceKind, inspect_skill_entrypoint,
    is_readable_skill_file,
};
use agentkib_platform::fs::{atomic_write, move_path};
use agentkib_platform::path as platform_path;
use anyhow::{Context, Result, bail, ensure};
use chrono::{DateTime, Duration, Utc};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use uuid::Uuid;
use walkdir::WalkDir;

const MAX_TREE_ENTRIES: usize = 20_000;
const MAX_CANDIDATES: usize = 200;
const MAX_DISCOVERY_DEPTH: usize = 8;
const MAX_SKILL_FILES: usize = 512;
const MAX_SKILL_PACKAGE_ENTRIES: usize = 4_096;
const MAX_SKILL_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_SKILL_TOTAL_BYTES: u64 = 32 * 1024 * 1024;
const MAX_SKILL_ENTRY_BYTES: u64 = 1024 * 1024;
const MAX_PREVIEW_BYTES: u64 = 256 * 1024;
const MAX_RETAINED_PREVIEWS: usize = 4;
const MAX_REF_RESOLUTION_ATTEMPTS: usize = 8;
const PREVIEW_TTL_MINUTES: i64 = 15;
const CURATED_URL: &str = "https://github.com/openai/skills/tree/main/skills/.curated";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SkillLockEntry {
    source: Option<SkillSource>,
    content_sha256: String,
    installed_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct SkillLockFile {
    #[serde(default = "lock_schema_version")]
    schema_version: u32,
    #[serde(default)]
    skills: BTreeMap<String, SkillLockEntry>,
    #[serde(default)]
    previous: BTreeMap<String, SkillLockEntry>,
}

fn lock_schema_version() -> u32 {
    1
}

#[derive(Debug, Serialize, Deserialize)]
struct TrashRecord {
    id: String,
    name: String,
    #[serde(default)]
    display_name: String,
    removed_at: DateTime<Utc>,
    lock: Option<SkillLockEntry>,
    #[serde(default)]
    previous: Option<SkillLockEntry>,
}

struct PreparedOperation {
    preview: SkillOperationPreview,
    target_name: String,
    temp: TempDir,
    package: PathBuf,
    lock: SkillLockEntry,
    expected_existing_sha256: Option<String>,
}

#[derive(Debug, Clone)]
struct ParsedGitHubUrl {
    owner: String,
    repository: String,
    reference: Option<String>,
    path: String,
    selector: Option<GitHubUrlSelector>,
}

#[derive(Debug, Clone)]
struct GitHubUrlSelector {
    kind: GitHubUrlKind,
    parts: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GitHubUrlKind {
    Tree,
    Blob,
}

#[derive(Debug, Clone, Deserialize)]
struct RepositoryResponse {
    default_branch: String,
}

#[derive(Debug, Clone, Deserialize)]
struct CommitResponse {
    sha: String,
    commit: CommitDetail,
}

#[derive(Debug, Clone, Deserialize)]
struct CommitDetail {
    tree: TreePointer,
}

#[derive(Debug, Clone, Deserialize)]
struct TreePointer {
    sha: String,
}

#[derive(Debug, Clone, Deserialize)]
struct TreeResponse {
    sha: String,
    #[serde(default)]
    tree: Vec<TreeEntry>,
    #[serde(default)]
    truncated: bool,
}

#[derive(Debug, Clone, Deserialize)]
struct TreeEntry {
    path: String,
    mode: String,
    #[serde(rename = "type")]
    kind: String,
    sha: String,
    size: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct SkillFrontmatter {
    name: String,
    description: String,
    license: Option<String>,
    compatibility: Option<String>,
}

struct ResolvedRepository {
    owner: String,
    repository: String,
    reference: String,
    commit: String,
    root_tree: String,
    root_path: String,
    entries: Vec<TreeEntry>,
}

pub struct SkillHub {
    root: PathBuf,
    cache_dir: PathBuf,
    client: Client,
    previews: Mutex<HashMap<String, PreparedOperation>>,
    lifecycle: Mutex<()>,
}

impl SkillHub {
    pub fn new(root: PathBuf, cache_dir: PathBuf) -> Result<Self> {
        let client = Client::builder()
            .user_agent("agentkib-skill-hub")
            .redirect(reqwest::redirect::Policy::limited(4))
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(30))
            .build()?;
        Ok(Self {
            root,
            cache_dir,
            client,
            previews: Mutex::new(HashMap::new()),
            lifecycle: Mutex::new(()),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub async fn curated(&self, force: bool) -> Result<SkillCatalogSnapshot> {
        let cache = self.cache_dir.join("curated-skills.json");
        if !force
            && let Ok(snapshot) = read_json::<SkillCatalogSnapshot>(&cache)
            && Utc::now() - snapshot.cached_at < Duration::hours(6)
        {
            return self.annotate_installed(snapshot);
        }
        match self.discover(CURATED_URL).await {
            Ok(candidates) => {
                let snapshot = SkillCatalogSnapshot {
                    entries: candidates
                        .into_iter()
                        .map(|candidate| SkillCatalogEntry {
                            candidate,
                            installed: false,
                        })
                        .collect(),
                    cached_at: Utc::now(),
                    stale: false,
                };
                write_json(&cache, &snapshot)?;
                self.annotate_installed(snapshot)
            }
            Err(error) => {
                let mut snapshot = read_json::<SkillCatalogSnapshot>(&cache)
                    .with_context(|| format!("Could not refresh curated Skills: {error}"))?;
                snapshot.stale = true;
                self.annotate_installed(snapshot)
            }
        }
    }

    pub async fn discover(&self, value: &str) -> Result<Vec<SkillCandidate>> {
        let parsed = parse_github_url(value)?;
        let resolved = self.resolve_repository(&parsed).await?;
        let directories = candidate_directories(&resolved.entries, &resolved.root_path)?;
        let mut results = Vec::with_capacity(directories.len());
        for directory in directories {
            let result: Result<SkillCandidate> = async {
                let skill_path = join_repo_path(&directory, "SKILL.md");
                let content = self
                    .download_raw(
                        &resolved.owner,
                        &resolved.repository,
                        &resolved.commit,
                        &skill_path,
                        MAX_SKILL_ENTRY_BYTES,
                    )
                    .await?;
                let content = String::from_utf8(content).context("SKILL.md must be UTF-8")?;
                let metadata = parse_skill_frontmatter(&content)?;
                let tree_sha = directory_tree_sha(&resolved, &directory)?;
                Ok(SkillCandidate {
                    name: metadata.name,
                    description: metadata.description,
                    license: metadata.license,
                    compatibility: metadata.compatibility,
                    source: SkillSource {
                        kind: source_kind(&resolved.owner, &resolved.repository, &directory),
                        repository: format!("{}/{}", resolved.owner, resolved.repository),
                        reference: resolved.reference.clone(),
                        path: directory.clone(),
                        resolved_commit: resolved.commit.clone(),
                        tree_sha,
                    },
                })
            }
            .await;
            results.push(result.with_context(|| format!("Could not inspect Skill at {directory}")));
        }
        valid_discovery_candidates(results)
    }

    pub fn installed(&self) -> Result<Vec<InstalledSkill>> {
        list_installed(&self.root)
    }

    pub async fn check_updates(&self) -> Result<Vec<InstalledSkill>> {
        let mut installed = list_installed(&self.root)?;
        let mut commits = HashMap::<(String, String, String), CommitResponse>::new();
        for skill in &mut installed {
            let Some(source) = skill.source.clone() else {
                continue;
            };
            let check: Result<bool> = async {
                let parsed = parsed_source(&source)?;
                let key = (
                    parsed.owner.to_ascii_lowercase(),
                    parsed.repository.to_ascii_lowercase(),
                    source.reference.clone(),
                );
                let commit = if let Some(commit) = commits.get(&key) {
                    commit.clone()
                } else {
                    let commit = self.get_commit(&parsed, &source.reference).await?;
                    commits.insert(key, commit.clone());
                    commit
                };
                let resolved = self
                    .resolve_repository_at_commit(
                        &parsed,
                        source.reference.clone(),
                        parsed.path.clone(),
                        commit,
                    )
                    .await?;
                Ok(directory_tree_sha(&resolved, &source.path)? != source.tree_sha)
            }
            .await;
            skill.status = update_check_status(skill.status, check);
        }
        Ok(installed)
    }

    pub async fn prepare_install(&self, source: SkillSource) -> Result<SkillOperationPreview> {
        let lock = load_lock(&self.root)?;
        let existing = installed_name_for_source(&self.root, &lock, &source);
        match existing {
            Some(name) => {
                self.prepare(source, SkillOperationKind::Update, Some(&name))
                    .await
            }
            None => {
                self.prepare(source, SkillOperationKind::Install, None)
                    .await
            }
        }
    }

    pub async fn prepare_update(&self, name: &str) -> Result<SkillOperationPreview> {
        validate_library_id(name)?;
        let lock = load_lock(&self.root)?;
        let entry = lock
            .skills
            .get(name)
            .context("Unmanaged Skills cannot be updated")?;
        let source = entry
            .source
            .clone()
            .context("This Skill has no update source")?;
        self.prepare(source, SkillOperationKind::Update, Some(name))
            .await
    }

    pub fn apply(
        &self,
        token: &str,
        confirmed: bool,
        allow_modified: bool,
    ) -> Result<InstalledSkill> {
        ensure!(
            confirmed,
            "Skill installation requires explicit confirmation"
        );
        let prepared = self
            .previews
            .lock()
            .map_err(|_| anyhow::anyhow!("Skill preview lock is unavailable"))?
            .remove(token)
            .context("Skill preview expired or does not exist")?;
        ensure!(
            prepared.preview.expires_at > Utc::now(),
            "Skill preview expired"
        );
        if prepared.preview.local_modified && !allow_modified {
            bail!("The installed Skill was modified locally; replacement requires confirmation");
        }
        let _guard = self
            .lifecycle
            .lock()
            .map_err(|_| anyhow::anyhow!("Skill lifecycle lock is unavailable"))?;
        self.ensure_layout()?;
        let name = prepared.target_name.clone();
        let expected_package_sha256 = &prepared.lock.content_sha256;
        let prepared_package = package_hash(&prepared.package)?;
        ensure!(
            prepared_package.0 == *expected_package_sha256,
            "Prepared Skill package changed after preview"
        );
        let target = self.skills_dir().join(&name);
        let actual_existing_sha256 = target
            .is_dir()
            .then(|| package_hash(&target).map(|value| value.0))
            .transpose()?;
        ensure!(
            actual_existing_sha256 == prepared.expected_existing_sha256,
            "Installed Skill changed after preview; prepare the operation again"
        );
        let installed = prepared_installed_skill(&prepared, &target, &prepared_package);
        match prepared.preview.operation {
            SkillOperationKind::Install => self.apply_install(prepared)?,
            SkillOperationKind::Update => self.apply_update(prepared)?,
        }
        Ok(installed)
    }

    pub fn rollback(&self, name: &str, confirmed: bool) -> Result<InstalledSkill> {
        ensure!(confirmed, "Skill rollback requires explicit confirmation");
        validate_library_id(name)?;
        let _guard = self
            .lifecycle
            .lock()
            .map_err(|_| anyhow::anyhow!("Skill lifecycle lock is unavailable"))?;
        let target = self.skills_dir().join(name);
        let backup = self.backups_dir().join(name);
        ensure!(
            target.is_dir() && backup.is_dir(),
            "No rollback version is available"
        );
        ensure!(
            !platform_path::is_reparse_or_symlink(&target)?
                && !platform_path::is_reparse_or_symlink(&backup)?,
            "Rollback paths must be regular directories"
        );
        let mut lock = load_lock(&self.root)?;
        let current = lock
            .skills
            .remove(name)
            .context("Installed Skill is unmanaged")?;
        let previous = lock
            .previous
            .remove(name)
            .context("Rollback metadata is missing")?;
        let rolled_back = managed_skill_result(name, &backup, &target, &previous, true)?;
        lock.skills.insert(name.to_string(), previous);
        lock.previous.insert(name.to_string(), current);
        swap_directories(&self.root, &target, &backup)?;
        if let Err(error) = save_lock(&self.root, &lock) {
            return Err(rollback_lock_failure_with(error, &target, &backup, || {
                swap_directories(&self.root, &target, &backup)
            }));
        }
        Ok(rolled_back)
    }

    pub fn uninstall(&self, name: &str, confirmed: bool) -> Result<RemovedSkill> {
        ensure!(confirmed, "Skill uninstall requires explicit confirmation");
        validate_library_id(name)?;
        let _guard = self
            .lifecycle
            .lock()
            .map_err(|_| anyhow::anyhow!("Skill lifecycle lock is unavailable"))?;
        self.ensure_layout()?;
        let target = self.skills_dir().join(name);
        ensure!(target.is_dir(), "Installed Skill does not exist");
        ensure!(
            !platform_path::is_reparse_or_symlink(&target)?,
            "Symbolic Skill packages cannot be removed"
        );
        let backup = self.backups_dir().join(name);
        if backup.exists() {
            ensure!(
                backup.is_dir() && !platform_path::is_reparse_or_symlink(&backup)?,
                "Rollback Skill must be a regular directory"
            );
        }
        let id = format!("skill-{}", Uuid::new_v4());
        let trash_root = self.trash_dir().join(&id);
        fs::create_dir_all(&trash_root)?;
        let package = trash_root.join("package");
        let mut lock = load_lock(&self.root)?;
        let record = TrashRecord {
            id: id.clone(),
            name: name.to_string(),
            display_name: skill_display_name(&target, name),
            removed_at: Utc::now(),
            lock: lock.skills.remove(name),
            previous: lock.previous.remove(name),
        };
        if let Err(error) = write_json(&trash_root.join("record.json"), &record) {
            let _ = fs::remove_dir_all(&trash_root);
            return Err(error);
        }
        if let Err(error) = move_path(&target, &package) {
            let _ = fs::remove_dir_all(&trash_root);
            return Err(error.into());
        }
        let trashed_backup = trash_root.join("backup");
        if backup.is_dir()
            && let Err(error) = move_path(&backup, &trashed_backup)
        {
            match recover_uninstall_moves(&package, &target, &trashed_backup, &backup) {
                Ok(()) => {
                    let _ = fs::remove_dir_all(&trash_root);
                    return Err(error.into());
                }
                Err(recovery_error) => bail!(
                    "Could not move the rollback package to trash ({error}); automatic recovery also failed ({recovery_error}). Package state is preserved under {} and {}",
                    trash_root.display(),
                    target.display()
                ),
            }
        }
        if let Err(error) = save_lock(&self.root, &lock) {
            match recover_uninstall_moves(&package, &target, &trashed_backup, &backup) {
                Ok(()) => {
                    let _ = fs::remove_dir_all(&trash_root);
                    return Err(error);
                }
                Err(recovery_error) => bail!(
                    "Could not save Skill removal metadata ({error}); automatic recovery also failed ({recovery_error}). Package state is preserved under {} and {}",
                    trash_root.display(),
                    target.display()
                ),
            }
        }
        Ok(RemovedSkill {
            id,
            name: name.to_string(),
            display_name: record.display_name,
            removed_at: record.removed_at,
            path: package,
        })
    }

    pub fn removed(&self) -> Result<Vec<RemovedSkill>> {
        let mut output = Vec::new();
        let directory = self.trash_dir();
        let Ok(entries) = fs::read_dir(directory) else {
            return Ok(output);
        };
        for entry in entries.filter_map(Result::ok) {
            if !entry.file_type().is_ok_and(|kind| kind.is_dir())
                || platform_path::is_reparse_or_symlink(&entry.path()).unwrap_or(true)
            {
                continue;
            }
            let record_path = entry.path().join("record.json");
            if !record_path.is_file()
                || platform_path::is_reparse_or_symlink(&record_path).unwrap_or(true)
            {
                continue;
            }
            let Ok(record) = read_json::<TrashRecord>(&record_path) else {
                continue;
            };
            let package = entry.path().join("package");
            if !package.is_dir() || platform_path::is_reparse_or_symlink(&package).unwrap_or(true) {
                continue;
            }
            let display_name = if record.display_name.is_empty() {
                record.name.clone()
            } else {
                record.display_name
            };
            output.push(RemovedSkill {
                id: record.id,
                name: record.name,
                display_name,
                removed_at: record.removed_at,
                path: package,
            });
        }
        output.sort_by_key(|entry| std::cmp::Reverse(entry.removed_at));
        Ok(output)
    }

    pub fn restore(&self, id: &str, confirmed: bool) -> Result<InstalledSkill> {
        ensure!(confirmed, "Skill restore requires explicit confirmation");
        validate_trash_id(id)?;
        let _guard = self
            .lifecycle
            .lock()
            .map_err(|_| anyhow::anyhow!("Skill lifecycle lock is unavailable"))?;
        let trash_root = self.trash_dir().join(id);
        ensure!(
            trash_root.is_dir() && !platform_path::is_reparse_or_symlink(&trash_root)?,
            "Removed Skill record is not a regular directory"
        );
        let record_path = trash_root.join("record.json");
        ensure!(
            record_path.is_file() && !platform_path::is_reparse_or_symlink(&record_path)?,
            "Removed Skill metadata is not a regular file"
        );
        let package = trash_root.join("package");
        ensure!(
            package.is_dir() && !platform_path::is_reparse_or_symlink(&package)?,
            "Removed Skill package is not a regular directory"
        );
        let record = read_json::<TrashRecord>(&record_path)?;
        validate_library_id(&record.name)?;
        let target = self.skills_dir().join(&record.name);
        ensure!(!target.exists(), "A Skill with this name already exists");
        let backup = self.backups_dir().join(&record.name);
        let trashed_backup = trash_root.join("backup");
        if backup.exists() {
            ensure!(
                backup.is_dir() && !platform_path::is_reparse_or_symlink(&backup)?,
                "Rollback Skill must be a regular directory"
            );
        }
        if trashed_backup.exists() {
            ensure!(
                trashed_backup.is_dir() && !platform_path::is_reparse_or_symlink(&trashed_backup)?,
                "Removed rollback package is not a regular directory"
            );
        }
        let mut lock = load_lock(&self.root)?;
        self.ensure_layout()?;
        let conflicting_backup = trash_root.join(format!("conflicting-backup-{}", Uuid::new_v4()));
        if backup.is_dir() {
            move_path(&backup, &conflicting_backup)?;
        }
        if let Err(error) = move_path(&package, &target) {
            if let Err(recovery_error) = recover_directory_moves(&[(&conflicting_backup, &backup)])
            {
                bail!(
                    "Could not restore the Skill package ({error}); restoring the conflicting rollback package also failed ({recovery_error}). Package state is preserved under {} and {}",
                    trash_root.display(),
                    backup.display()
                );
            }
            return Err(error.into());
        }
        if trashed_backup.is_dir()
            && let Err(error) = move_path(&trashed_backup, &backup)
        {
            if let Err(recovery_error) =
                recover_directory_moves(&[(&target, &package), (&conflicting_backup, &backup)])
            {
                bail!(
                    "Could not restore the rollback package ({error}); automatic recovery also failed ({recovery_error}). Package state is preserved under {}, {}, and {}",
                    trash_root.display(),
                    target.display(),
                    backup.display()
                );
            }
            return Err(error.into());
        }
        lock.skills.remove(&record.name);
        lock.previous.remove(&record.name);
        if let Some(entry) = record.lock.clone() {
            lock.skills.insert(record.name.clone(), entry);
        }
        if let Some(entry) = record.previous.clone() {
            lock.previous.insert(record.name.clone(), entry);
        }
        if let Err(error) = save_lock(&self.root, &lock) {
            if let Err(recovery_error) = recover_directory_moves(&[
                (&backup, &trashed_backup),
                (&target, &package),
                (&conflicting_backup, &backup),
            ]) {
                bail!(
                    "Could not save restored Skill metadata ({error}); automatic recovery also failed ({recovery_error}). Package state is preserved under {}, {}, and {}",
                    trash_root.display(),
                    target.display(),
                    backup.display()
                );
            }
            return Err(error);
        }
        let restored = restored_skill(&record, &target, &backup);
        // The package and lock are already restored; cleanup must not turn that durable mutation
        // into a reported failure or encourage a duplicate retry.
        let _ = fs::remove_dir_all(trash_root);
        Ok(restored)
    }

    pub fn read_file(&self, name: &str, relative: &str) -> Result<SkillFilePreview> {
        validate_library_id(name)?;
        let relative = safe_relative_path(relative)?;
        let root = platform_path::canonicalize(&self.skills_dir().join(name))?;
        let requested = self.skills_dir().join(name).join(&relative);
        ensure!(
            is_readable_skill_file(&root.join("SKILL.md"), &requested),
            "Skill resource is private, unsafe, or outside the package"
        );
        let metadata = fs::symlink_metadata(&requested)?;
        ensure!(
            metadata.file_type().is_file(),
            "Skill resource is not a regular file"
        );
        ensure!(
            !platform_path::is_reparse_or_symlink(&requested)?,
            "Symbolic Skill resources cannot be read"
        );
        ensure!(
            metadata.len() <= MAX_PREVIEW_BYTES,
            "Skill resource exceeds the preview limit"
        );
        let requested = platform_path::canonicalize(&requested)?;
        ensure!(
            platform_path::starts_with(&requested, &root),
            "Skill resource is outside the package"
        );
        let content = fs::read_to_string(&requested).context("Skill resource is not UTF-8 text")?;
        Ok(SkillFilePreview {
            path: relative.to_string_lossy().replace('\\', "/"),
            content,
        })
    }

    async fn prepare(
        &self,
        source: SkillSource,
        operation: SkillOperationKind,
        installed_name: Option<&str>,
    ) -> Result<SkillOperationPreview> {
        let parsed = parsed_source(&source)?;
        let resolved = self.resolve_repository(&parsed).await?;
        let direct = candidate_directories(&resolved.entries, &source.path)?;
        ensure!(
            direct.iter().any(|path| path == &source.path),
            "Selected Skill path no longer contains SKILL.md"
        );
        let entries = package_entries(&resolved.entries, &source.path)?;
        let staging = self.root.join(".staging");
        fs::create_dir_all(&staging)?;
        let temp = tempfile::Builder::new()
            .prefix("skill-")
            .tempdir_in(staging)?;
        let package = temp.path().join("package");
        fs::create_dir(&package)?;
        let mut total_size = 0_u64;
        let mut files = Vec::new();
        for entry in entries {
            let size = entry.size.unwrap_or_default();
            ensure!(
                size <= MAX_SKILL_FILE_BYTES,
                "Skill file exceeds the 8 MiB limit: {}",
                entry.path
            );
            total_size = total_size
                .checked_add(size)
                .context("Skill package size overflow")?;
            ensure!(
                total_size <= MAX_SKILL_TOTAL_BYTES,
                "Skill package exceeds the 32 MiB limit"
            );
            let relative = entry
                .path
                .strip_prefix(&source.path)
                .unwrap_or(&entry.path)
                .trim_start_matches('/');
            let relative = safe_relative_path(relative)?;
            let bytes = self
                .download_raw(
                    &resolved.owner,
                    &resolved.repository,
                    &resolved.commit,
                    &entry.path,
                    MAX_SKILL_FILE_BYTES,
                )
                .await?;
            ensure!(
                bytes.len() as u64 == size,
                "GitHub file size changed during download: {}",
                entry.path
            );
            let target = package.join(&relative);
            fs::create_dir_all(target.parent().context("Skill file has no parent")?)?;
            fs::write(&target, &bytes)?;
            set_executable(&target, entry.mode == "100755")?;
            files.push(SkillFileEntry {
                path: relative.to_string_lossy().replace('\\', "/"),
                size,
                executable: entry.mode == "100755",
            });
        }
        ensure!(
            files.len() <= MAX_SKILL_FILES,
            "Skill package exceeds the 512 file limit"
        );
        let entrypoint = package.join("SKILL.md");
        let entry_content = read_skill_entrypoint(&entrypoint)?;
        let metadata = parse_skill_frontmatter(&entry_content)?;
        if let Some(installed_name) = installed_name {
            ensure!(
                metadata.name == installed_name,
                "Skill update changed the package name"
            );
        }
        let tree_sha = directory_tree_sha(&resolved, &source.path)?;
        let resolved_source = SkillSource {
            kind: source_kind(&resolved.owner, &resolved.repository, &source.path),
            repository: format!("{}/{}", resolved.owner, resolved.repository),
            reference: resolved.reference,
            path: source.path.clone(),
            resolved_commit: resolved.commit,
            tree_sha,
        };
        let candidate = SkillCandidate {
            name: metadata.name,
            description: metadata.description,
            license: metadata.license,
            compatibility: metadata.compatibility,
            source: resolved_source,
        };
        validate_skill_name(&candidate.name)?;
        if operation == SkillOperationKind::Install {
            ensure!(
                !self
                    .installed()?
                    .iter()
                    .any(|skill| skill.display_name == candidate.name),
                "A Skill with this name already exists"
            );
        }
        let (content_sha256, _, _) = package_hash(&package)?;
        let target_name = installed_name.unwrap_or(&candidate.name).to_string();
        let existing = self.skills_dir().join(&target_name);
        match operation {
            SkillOperationKind::Install => {
                ensure!(!existing.exists(), "A Skill with this name already exists")
            }
            SkillOperationKind::Update => {
                ensure!(existing.is_dir(), "Installed Skill does not exist")
            }
        }
        let (added, modified, removed) = file_delta(&existing, &package)?;
        let lock = load_lock(&self.root)?;
        let previous = lock.skills.get(&target_name);
        if operation == SkillOperationKind::Update {
            let previous_source = previous
                .and_then(|entry| entry.source.as_ref())
                .context("Unmanaged Skills cannot be updated")?;
            ensure!(
                same_source(previous_source, &candidate.source),
                "Skill update source changed"
            );
        }
        let expected_existing_sha256 = existing
            .is_dir()
            .then(|| package_hash(&existing).map(|value| value.0))
            .transpose()?;
        let local_modified = previous
            .zip(expected_existing_sha256.as_ref())
            .is_some_and(|(entry, actual)| actual != &entry.content_sha256);
        let token = Uuid::new_v4().to_string();
        let expires_at = Utc::now() + Duration::minutes(PREVIEW_TTL_MINUTES);
        let preview = SkillOperationPreview {
            token: token.clone(),
            operation,
            skill: candidate,
            files,
            added,
            modified,
            removed,
            total_size,
            local_modified,
            expires_at,
        };
        let now = Utc::now();
        let lock_entry = SkillLockEntry {
            source: Some(preview.skill.source.clone()),
            content_sha256,
            installed_at: previous.map_or(now, |entry| entry.installed_at),
            updated_at: now,
        };
        self.store_prepared_preview(PreparedOperation {
            preview: preview.clone(),
            target_name,
            temp,
            package,
            lock: lock_entry,
            expected_existing_sha256,
        })?;
        Ok(preview)
    }

    fn store_prepared_preview(&self, prepared: PreparedOperation) -> Result<()> {
        let mut previews = self
            .previews
            .lock()
            .map_err(|_| anyhow::anyhow!("Skill preview lock is unavailable"))?;
        previews.retain(|_, value| value.preview.expires_at > Utc::now());
        while previews.len() >= MAX_RETAINED_PREVIEWS {
            let Some(oldest) = previews
                .iter()
                .min_by_key(|(_, value)| value.preview.expires_at)
                .map(|(token, _)| token.clone())
            else {
                break;
            };
            previews.remove(&oldest);
        }
        previews.insert(prepared.preview.token.clone(), prepared);
        Ok(())
    }

    fn apply_install(&self, prepared: PreparedOperation) -> Result<()> {
        let name = &prepared.target_name;
        let target = self.skills_dir().join(name);
        let backup = self.backups_dir().join(name);
        ensure!(!target.exists(), "A Skill with this name already exists");
        if backup.exists() {
            ensure!(
                backup.is_dir() && !platform_path::is_reparse_or_symlink(&backup)?,
                "Rollback Skill must be a regular directory"
            );
        }
        let mut lock = load_lock(&self.root)?;
        // Keep the displaced rollback package outside the preview TempDir. If recovery is
        // blocked (for example by a transient Windows file lock), dropping the preview must
        // not delete the last copy of the previous package.
        let stale_backup = self
            .root
            .join(".staging")
            .join(format!("stale-backup-{}", Uuid::new_v4()));
        if backup.is_dir() {
            move_path(&backup, &stale_backup)?;
        }
        if let Err(error) = move_path(&prepared.package, &target) {
            if let Err(recovery_error) = recover_staged_backup(&stale_backup, &backup) {
                let preserved_preview = prepared.temp.keep();
                bail!(
                    "Could not activate the prepared Skill ({error}); restoring the previous rollback package also failed ({recovery_error}). Package state is preserved under {}, {}, and {} for recovery",
                    target.display(),
                    stale_backup.display(),
                    preserved_preview.display()
                );
            }
            return Err(error.into());
        }
        lock.skills.insert(name.clone(), prepared.lock);
        lock.previous.remove(name);
        if let Err(error) = save_lock(&self.root, &lock) {
            let recovery =
                recover_install_moves(&target, &prepared.package, &stale_backup, &backup);
            if let Err(recovery_error) = recovery {
                let preserved_preview = prepared.temp.keep();
                bail!(
                    "Could not save Skill installation metadata ({error}); automatic recovery also failed ({recovery_error}). Package state is preserved under {}, {}, and {} for recovery",
                    target.display(),
                    stale_backup.display(),
                    preserved_preview.display()
                );
            }
            return Err(error);
        }
        if stale_backup.is_dir() {
            let _ = fs::remove_dir_all(stale_backup);
        }
        drop(prepared.temp);
        Ok(())
    }

    fn apply_update(&self, prepared: PreparedOperation) -> Result<()> {
        let name = &prepared.target_name;
        let target = self.skills_dir().join(name);
        let backup = self.backups_dir().join(name);
        ensure!(
            !platform_path::is_reparse_or_symlink(&target)?,
            "Installed Skill must be a regular directory"
        );
        if backup.exists() {
            ensure!(
                backup.is_dir() && !platform_path::is_reparse_or_symlink(&backup)?,
                "Rollback Skill must be a regular directory"
            );
        }
        let mut lock = load_lock(&self.root)?;
        let mut previous = lock
            .skills
            .get(name)
            .cloned()
            .context("Installed Skill is unmanaged")?;
        previous.content_sha256 = package_hash(&target)?.0;
        fs::create_dir_all(self.backups_dir())?;
        let prior_backup = self
            .root
            .join(".staging")
            .join(format!("prior-backup-{}", Uuid::new_v4()));
        if backup.exists() {
            move_path(&backup, &prior_backup)?;
        }
        if let Err(error) = move_path(&target, &backup) {
            if let Err(recovery_error) = recover_staged_backup(&prior_backup, &backup) {
                bail!(
                    "Could not stage the current Skill for update ({error}); restoring the prior rollback package also failed ({recovery_error}). The current Skill remains at {} and the prior rollback package is preserved at {}",
                    target.display(),
                    prior_backup.display()
                );
            }
            return Err(error.into());
        }
        if let Err(error) = move_path(&prepared.package, &target) {
            if let Err(recovery_error) = recover_update_moves(&backup, &target, &prior_backup) {
                let preserved_preview = prepared.temp.keep();
                bail!(
                    "Could not activate the prepared Skill update ({error}); automatic recovery also failed ({recovery_error}). Package state is preserved under {}, {}, and {} for recovery",
                    target.display(),
                    backup.display(),
                    preserved_preview.display()
                );
            }
            return Err(error.into());
        }
        lock.previous.insert(name.clone(), previous);
        lock.skills.insert(name.clone(), prepared.lock);
        if let Err(error) = save_lock(&self.root, &lock) {
            let recovery = move_path(&target, &prepared.package)
                .with_context(|| {
                    format!(
                        "the incoming Skill remains at {} because it could not be returned to staging",
                        target.display()
                    )
                })
                .and_then(|_| recover_update_moves(&backup, &target, &prior_backup));
            if let Err(recovery_error) = recovery {
                let preserved_preview = prepared.temp.keep();
                bail!(
                    "Could not save Skill update metadata ({error}); automatic recovery also failed ({recovery_error}). Package state is preserved under {}, {}, and {} for recovery",
                    target.display(),
                    backup.display(),
                    preserved_preview.display()
                );
            }
            return Err(error);
        }
        if prior_backup.is_dir() {
            let _ = fs::remove_dir_all(prior_backup);
        }
        drop(prepared.temp);
        Ok(())
    }

    async fn resolve_repository(&self, parsed: &ParsedGitHubUrl) -> Result<ResolvedRepository> {
        let (reference, root_path, commit) = self.resolve_reference(parsed).await?;
        self.resolve_repository_at_commit(parsed, reference, root_path, commit)
            .await
    }

    async fn resolve_repository_at_commit(
        &self,
        parsed: &ParsedGitHubUrl,
        reference: String,
        root_path: String,
        commit: CommitResponse,
    ) -> Result<ResolvedRepository> {
        let tree_spec = if root_path.is_empty() {
            commit.commit.tree.sha.clone()
        } else {
            format!("{}:{root_path}", commit.commit.tree.sha)
        };
        let mut tree = self
            .fetch_tree(&parsed.owner, &parsed.repository, &tree_spec, true)
            .await?;
        let root_tree = tree.sha.clone();
        ensure!(
            !tree.truncated,
            "Selected GitHub location is too large; provide a direct Skill directory URL"
        );
        ensure!(
            tree.tree.len() <= MAX_TREE_ENTRIES,
            "Selected GitHub location exceeds the 20,000 entry discovery limit"
        );
        if !root_path.is_empty() {
            for entry in &mut tree.tree {
                entry.path = join_repo_path(&root_path, &entry.path);
            }
        }
        Ok(ResolvedRepository {
            owner: parsed.owner.clone(),
            repository: parsed.repository.clone(),
            reference,
            commit: commit.sha,
            root_tree,
            root_path,
            entries: tree.tree,
        })
    }

    async fn resolve_reference(
        &self,
        parsed: &ParsedGitHubUrl,
    ) -> Result<(String, String, CommitResponse)> {
        if let Some(reference) = parsed.reference.clone() {
            let commit = self.get_commit(parsed, &reference).await?;
            return Ok((reference, parsed.path.clone(), commit));
        }
        if let Some(selector) = &parsed.selector {
            for (reference, path) in selector_reference_candidates(selector)? {
                if let Some(commit) = self.try_get_commit(parsed, &reference).await? {
                    let tree_spec = if path.is_empty() {
                        commit.commit.tree.sha.clone()
                    } else {
                        format!("{}:{path}", commit.commit.tree.sha)
                    };
                    if self
                        .fetch_tree(&parsed.owner, &parsed.repository, &tree_spec, false)
                        .await
                        .is_ok()
                    {
                        return Ok((reference, path, commit));
                    }
                }
            }
            bail!("GitHub tree or blob URL does not contain a resolvable ref");
        }
        let repository: RepositoryResponse = self
            .get_json(&github_api_url(&[
                "repos",
                &parsed.owner,
                &parsed.repository,
            ])?)
            .await?;
        let commit = self.get_commit(parsed, &repository.default_branch).await?;
        Ok((repository.default_branch, String::new(), commit))
    }

    async fn get_commit(
        &self,
        parsed: &ParsedGitHubUrl,
        reference: &str,
    ) -> Result<CommitResponse> {
        self.get_json(&github_api_url(&[
            "repos",
            &parsed.owner,
            &parsed.repository,
            "commits",
            reference,
        ])?)
        .await
    }

    async fn try_get_commit(
        &self,
        parsed: &ParsedGitHubUrl,
        reference: &str,
    ) -> Result<Option<CommitResponse>> {
        self.try_get_json(&github_api_url(&[
            "repos",
            &parsed.owner,
            &parsed.repository,
            "commits",
            reference,
        ])?)
        .await
    }

    async fn fetch_tree(
        &self,
        owner: &str,
        repository: &str,
        tree: &str,
        recursive: bool,
    ) -> Result<TreeResponse> {
        let mut url = github_api_url(&["repos", owner, repository, "git", "trees", tree])?;
        if recursive {
            url.query_pairs_mut().append_pair("recursive", "1");
        }
        self.get_json(&url).await
    }

    async fn get_json<T: for<'de> Deserialize<'de>>(&self, url: &Url) -> Result<T> {
        let response = self.client.get(url.clone()).send().await?;
        let status = response.status();
        ensure!(
            status.is_success(),
            "GitHub request failed with HTTP {status}"
        );
        Ok(response.json().await?)
    }

    async fn try_get_json<T: for<'de> Deserialize<'de>>(&self, url: &Url) -> Result<Option<T>> {
        let response = self.client.get(url.clone()).send().await?;
        let status = response.status();
        if matches!(status.as_u16(), 404 | 422) {
            return Ok(None);
        }
        ensure!(
            status.is_success(),
            "GitHub request failed with HTTP {status}"
        );
        Ok(Some(response.json().await?))
    }

    async fn download_raw(
        &self,
        owner: &str,
        repository: &str,
        commit: &str,
        path: &str,
        limit: u64,
    ) -> Result<Vec<u8>> {
        let url = raw_url(owner, repository, commit, path)?;
        let mut response = self.client.get(url).send().await?;
        let status = response.status();
        ensure!(
            status.is_success(),
            "GitHub file download failed with HTTP {status}"
        );
        if let Some(length) = response.content_length() {
            ensure!(length <= limit, "GitHub file exceeds the download limit");
        }
        let mut bytes =
            Vec::with_capacity(response.content_length().unwrap_or_default().min(limit) as usize);
        while let Some(chunk) = response.chunk().await? {
            let next_size = (bytes.len() as u64)
                .checked_add(chunk.len() as u64)
                .context("GitHub file size overflow")?;
            ensure!(next_size <= limit, "GitHub file exceeds the download limit");
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }

    fn annotate_installed(
        &self,
        mut snapshot: SkillCatalogSnapshot,
    ) -> Result<SkillCatalogSnapshot> {
        let installed = self
            .installed()?
            .into_iter()
            .map(|skill| skill.display_name)
            .collect::<std::collections::BTreeSet<_>>();
        for entry in &mut snapshot.entries {
            entry.installed = installed.contains(&entry.candidate.name);
        }
        Ok(snapshot)
    }

    fn ensure_layout(&self) -> Result<()> {
        for directory in [
            self.skills_dir(),
            self.backups_dir(),
            self.trash_dir(),
            self.root.join(".staging"),
        ] {
            fs::create_dir_all(directory)?;
        }
        Ok(())
    }

    fn skills_dir(&self) -> PathBuf {
        self.root.join("skills")
    }

    fn backups_dir(&self) -> PathBuf {
        self.root.join("backups/skills")
    }

    fn trash_dir(&self) -> PathBuf {
        self.root.join("trash/skills")
    }
}

fn swap_directories(root: &Path, left: &Path, right: &Path) -> Result<()> {
    swap_directories_with(root, left, right, move_path)
}

fn recover_uninstall_moves(
    package: &Path,
    target: &Path,
    trashed_backup: &Path,
    backup: &Path,
) -> Result<()> {
    recover_uninstall_moves_with(package, target, trashed_backup, backup, move_path)
}

fn recover_staged_backup(staged_backup: &Path, backup: &Path) -> Result<()> {
    recover_staged_backup_with(staged_backup, backup, move_path)
}

fn recover_staged_backup_with<F>(staged_backup: &Path, backup: &Path, mut move_dir: F) -> Result<()>
where
    F: FnMut(&Path, &Path) -> io::Result<()>,
{
    if staged_backup.is_dir() {
        move_dir(staged_backup, backup).with_context(|| {
            format!(
                "the rollback package is preserved at {} because it could not be restored to {}",
                staged_backup.display(),
                backup.display()
            )
        })?;
    }
    Ok(())
}

fn recover_update_moves(backup: &Path, target: &Path, prior_backup: &Path) -> Result<()> {
    recover_update_moves_with(backup, target, prior_backup, move_path)
}

fn recover_install_moves(
    target: &Path,
    package: &Path,
    staged_backup: &Path,
    backup: &Path,
) -> Result<()> {
    recover_install_moves_with(target, package, staged_backup, backup, move_path)
}

fn recover_install_moves_with<F>(
    target: &Path,
    package: &Path,
    staged_backup: &Path,
    backup: &Path,
    mut move_dir: F,
) -> Result<()>
where
    F: FnMut(&Path, &Path) -> io::Result<()>,
{
    move_dir(target, package).with_context(|| {
        format!(
            "the activated Skill remains at {} because it could not be returned to {}",
            target.display(),
            package.display()
        )
    })?;
    recover_staged_backup_with(staged_backup, backup, move_dir)
}

fn update_check_status(current: InstalledSkillStatus, check: Result<bool>) -> InstalledSkillStatus {
    match check {
        Ok(true) => InstalledSkillStatus::UpdateAvailable,
        Ok(false) | Err(_) => current,
    }
}

fn recover_update_moves_with<F>(
    backup: &Path,
    target: &Path,
    prior_backup: &Path,
    mut move_dir: F,
) -> Result<()>
where
    F: FnMut(&Path, &Path) -> io::Result<()>,
{
    move_dir(backup, target).with_context(|| {
        format!(
            "the current Skill is preserved at {} because it could not be restored to {}",
            backup.display(),
            target.display()
        )
    })?;
    recover_staged_backup_with(prior_backup, backup, move_dir)
}

fn rollback_lock_failure_with<F>(
    lock_error: anyhow::Error,
    target: &Path,
    backup: &Path,
    reverse_swap: F,
) -> anyhow::Error
where
    F: FnOnce() -> Result<()>,
{
    match reverse_swap() {
        Ok(()) => lock_error,
        Err(recovery_error) => anyhow::anyhow!(
            "Could not save rollback metadata ({lock_error}); reversing the package swap also failed ({recovery_error}). Package state is preserved at {} and {}; inspect it before retrying",
            target.display(),
            backup.display()
        ),
    }
}

fn recover_uninstall_moves_with<F>(
    package: &Path,
    target: &Path,
    trashed_backup: &Path,
    backup: &Path,
    move_dir: F,
) -> Result<()>
where
    F: FnMut(&Path, &Path) -> io::Result<()>,
{
    recover_directory_moves_with(&[(package, target), (trashed_backup, backup)], move_dir)
}

fn recover_directory_moves(steps: &[(&Path, &Path)]) -> Result<()> {
    recover_directory_moves_with(steps, move_path)
}

fn recover_directory_moves_with<F>(steps: &[(&Path, &Path)], mut move_dir: F) -> Result<()>
where
    F: FnMut(&Path, &Path) -> io::Result<()>,
{
    let mut failures = Vec::new();
    for (source, target) in steps {
        if !source.is_dir() {
            continue;
        }
        if let Err(error) = move_dir(source, target) {
            failures.push(format!(
                "{} -> {}: {error}",
                source.display(),
                target.display()
            ));
        }
    }
    ensure!(
        failures.is_empty(),
        "automatic recovery is incomplete: {}",
        failures.join("; ")
    );
    Ok(())
}

fn swap_directories_with<F>(root: &Path, left: &Path, right: &Path, mut move_dir: F) -> Result<()>
where
    F: FnMut(&Path, &Path) -> io::Result<()>,
{
    let swap = root
        .join(".staging")
        .join(format!("swap-{}", Uuid::new_v4()));
    fs::create_dir_all(swap.parent().context("Swap path has no parent")?)?;
    move_dir(left, &swap)?;
    if let Err(error) = move_dir(right, left) {
        if let Err(recovery_error) = recover_directory_moves_with(&[(&swap, left)], &mut move_dir) {
            bail!(
                "Could not move {} into {} ({error}); restoring the live package also failed ({recovery_error}). The original package is preserved at {}",
                right.display(),
                left.display(),
                swap.display()
            );
        }
        return Err(error.into());
    }
    if let Err(error) = move_dir(&swap, right) {
        if let Err(recovery_error) =
            recover_directory_moves_with(&[(left, right), (&swap, left)], &mut move_dir)
        {
            bail!(
                "Could not complete the directory swap ({error}); restoring the original packages also failed ({recovery_error}). Package state is preserved under {}, {}, and {}",
                left.display(),
                right.display(),
                swap.display()
            );
        }
        return Err(error.into());
    }
    Ok(())
}

pub fn default_home_dir() -> Result<PathBuf> {
    if let Some(value) = std::env::var_os("AGENTKIB_HOME") {
        let path = PathBuf::from(value);
        ensure!(path.is_absolute(), "AGENTKIB_HOME must be an absolute path");
        return Ok(path);
    }
    let home = dirs::home_dir().context("User home directory is unavailable")?;
    let development = std::env::var("AGENTKIB_APP_FLAVOR").as_deref() == Ok("ai.agentkib.dev");
    Ok(home.join(if development {
        ".agentkib-dev"
    } else {
        ".agentkib"
    }))
}

pub fn scan_library_assets(root: &Path) -> Result<Vec<CatalogAsset>> {
    let directory = root.join("skills");
    let Ok(entries) = fs::read_dir(directory) else {
        return Ok(Vec::new());
    };
    let mut output = Vec::new();
    for entry in entries {
        let entry = entry?;
        if !entry.file_type()?.is_dir() || platform_path::is_reparse_or_symlink(&entry.path())? {
            continue;
        }
        let Ok(package) = inspect_skill_entrypoint(&entry.path().join("SKILL.md")) else {
            continue;
        };
        let stable_id = format!(
            "{:x}",
            Sha256::digest(platform_path::identity(&package.root).as_bytes())
        );
        output.push(CatalogAsset {
            id: format!("agentkib-home:skill:{stable_id}"),
            scope: CatalogScope::AgentkibHome,
            workspace_id: None,
            agent: None,
            kind: agentkib_core::AssetKind::Skill,
            name: package.name,
            path: package.root,
            summary: "AgentKib Skill library".into(),
            summary_key: Some("assets.summary.agentkibSkill".into()),
            summary_params: BTreeMap::new(),
            size: package.size,
            modified_at: package.modified_at,
        });
    }
    output.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(output)
}

fn parse_github_url(value: &str) -> Result<ParsedGitHubUrl> {
    let value = value.trim();
    validate_raw_url_path(value)?;
    let url = Url::parse(value).context("Enter a valid GitHub URL")?;
    ensure!(
        url.scheme() == "https",
        "Only HTTPS GitHub URLs are supported"
    );
    ensure!(
        matches!(url.host_str(), Some("github.com" | "www.github.com")),
        "Only public github.com URLs are supported"
    );
    let parts = url
        .path_segments()
        .into_iter()
        .flatten()
        .filter(|value| !value.is_empty())
        .map(decode_url_segment)
        .collect::<Result<Vec<_>>>()?;
    ensure!(
        parts.len() >= 2,
        "GitHub URL must include an owner and repository"
    );
    let owner = parts[0].clone();
    let repository = parts[1].trim_end_matches(".git").to_string();
    validate_repo_segment(&owner)?;
    validate_repo_segment(&repository)?;
    let mut selector = None;
    if parts.len() > 2 {
        ensure!(
            matches!(parts[2].as_str(), "tree" | "blob"),
            "GitHub URL must point to a repository, tree, or SKILL.md blob"
        );
        ensure!(parts.len() >= 4, "GitHub tree URL is missing a ref");
        selector = Some(GitHubUrlSelector {
            kind: if parts[2] == "blob" {
                GitHubUrlKind::Blob
            } else {
                GitHubUrlKind::Tree
            },
            parts: parts[3..].to_vec(),
        });
    }
    Ok(ParsedGitHubUrl {
        owner,
        repository,
        reference: None,
        path: String::new(),
        selector,
    })
}

fn selector_reference_candidates(selector: &GitHubUrlSelector) -> Result<Vec<(String, String)>> {
    let path_parts = usize::from(selector.kind == GitHubUrlKind::Blob);
    ensure!(
        selector.parts.len() > path_parts,
        "GitHub tree or blob URL does not contain a valid ref"
    );
    (1..=selector.parts.len() - path_parts)
        .take(MAX_REF_RESOLUTION_ATTEMPTS)
        .map(|split| {
            Ok((
                selector.parts[..split].join("/"),
                selector_path(selector, split)?,
            ))
        })
        .collect()
}

fn selector_path(selector: &GitHubUrlSelector, split: usize) -> Result<String> {
    ensure!(
        split > 0 && split <= selector.parts.len(),
        "GitHub tree or blob URL does not contain a valid ref"
    );
    let mut path = selector.parts[split..].join("/");
    if selector.kind == GitHubUrlKind::Blob {
        ensure!(
            selector.parts.last().map(String::as_str) == Some("SKILL.md"),
            "GitHub blob URL must point to SKILL.md"
        );
        path = path
            .strip_suffix("SKILL.md")
            .unwrap_or(&path)
            .trim_end_matches('/')
            .to_string();
    }
    safe_repo_path(&path)
}

fn validate_raw_url_path(value: &str) -> Result<()> {
    let path = value
        .split_once("://")
        .map(|(_, suffix)| suffix)
        .unwrap_or(value)
        .split(['?', '#'])
        .next()
        .unwrap_or_default();
    for segment in path.split('/') {
        decode_url_segment(segment)?;
    }
    Ok(())
}

fn decode_url_segment(segment: &str) -> Result<String> {
    let mut decoded = Vec::with_capacity(segment.len());
    let bytes = segment.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            ensure!(
                index + 2 < bytes.len(),
                "GitHub URL contains invalid percent encoding"
            );
            let high = hex_value(bytes[index + 1])
                .context("GitHub URL contains invalid percent encoding")?;
            let low = hex_value(bytes[index + 2])
                .context("GitHub URL contains invalid percent encoding")?;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    ensure!(
        decoded.as_slice() != b"."
            && decoded.as_slice() != b".."
            && !decoded.contains(&b'/')
            && !decoded.contains(&b'\\'),
        "GitHub URL contains an unsafe path component"
    );
    String::from_utf8(decoded).context("GitHub URL path is not valid UTF-8")
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn parsed_source(source: &SkillSource) -> Result<ParsedGitHubUrl> {
    let (owner, repository) = source
        .repository
        .split_once('/')
        .context("Skill source repository is invalid")?;
    validate_repo_segment(owner)?;
    validate_repo_segment(repository)?;
    ensure!(
        !source.reference.trim().is_empty(),
        "Skill source ref is empty"
    );
    Ok(ParsedGitHubUrl {
        owner: owner.to_string(),
        repository: repository.to_string(),
        reference: Some(source.reference.clone()),
        path: safe_repo_path(&source.path)?,
        selector: None,
    })
}

fn validate_repo_segment(value: &str) -> Result<()> {
    ensure!(
        !value.is_empty()
            && value.len() <= 100
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')),
        "GitHub owner or repository is invalid"
    );
    Ok(())
}

fn safe_repo_path(value: &str) -> Result<String> {
    let path = safe_relative_path(value)?;
    Ok(path
        .to_string_lossy()
        .replace('\\', "/")
        .trim_matches('/')
        .to_string())
}

fn safe_relative_path(value: &str) -> Result<PathBuf> {
    let path = Path::new(value);
    ensure!(!path.is_absolute(), "Skill path must be relative");
    for component in path.components() {
        ensure!(
            matches!(component, Component::Normal(_)),
            "Skill path contains an unsafe component"
        );
    }
    Ok(path.to_path_buf())
}

fn candidate_directories(entries: &[TreeEntry], selected: &str) -> Result<Vec<String>> {
    let direct = join_repo_path(selected, "SKILL.md");
    if entries
        .iter()
        .any(|entry| entry.kind == "blob" && entry.path == direct)
    {
        return Ok(vec![selected.to_string()]);
    }
    let prefix = if selected.is_empty() {
        String::new()
    } else {
        format!("{selected}/")
    };
    let mut directories = entries
        .iter()
        .filter(|entry| entry.kind == "blob" && entry.path.ends_with("/SKILL.md"))
        .filter_map(|entry| entry.path.strip_suffix("/SKILL.md"))
        .filter(|directory| selected.is_empty() || directory.starts_with(&prefix))
        .filter(|directory| {
            let relative = directory.strip_prefix(&prefix).unwrap_or(directory);
            relative.split('/').filter(|part| !part.is_empty()).count() <= MAX_DISCOVERY_DEPTH
        })
        .map(str::to_string)
        .collect::<Vec<_>>();
    directories.sort();
    directories.dedup();
    ensure!(
        !directories.is_empty(),
        "No Skill package with SKILL.md was found at this GitHub location"
    );
    ensure!(
        directories.len() <= MAX_CANDIDATES,
        "GitHub location contains more than 200 Skill candidates"
    );
    Ok(directories)
}

fn valid_discovery_candidates(
    results: impl IntoIterator<Item = Result<SkillCandidate>>,
) -> Result<Vec<SkillCandidate>> {
    let mut candidates = Vec::new();
    let mut first_error = None;
    for result in results {
        match result {
            Ok(candidate) => candidates.push(candidate),
            Err(error) if first_error.is_none() => first_error = Some(error),
            Err(_) => {}
        }
    }
    if candidates.is_empty()
        && let Some(error) = first_error
    {
        return Err(error);
    }
    candidates.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(candidates)
}

fn package_entries<'a>(entries: &'a [TreeEntry], path: &str) -> Result<Vec<&'a TreeEntry>> {
    let prefix = if path.is_empty() {
        String::new()
    } else {
        format!("{path}/")
    };
    let mut output = entries
        .iter()
        .filter(|entry| entry.path.starts_with(&prefix) && entry.kind != "tree")
        .collect::<Vec<_>>();
    ensure!(!output.is_empty(), "Skill package is empty");
    ensure!(
        output.len() <= MAX_SKILL_FILES,
        "Skill package exceeds the 512 file limit"
    );
    for entry in &output {
        ensure!(
            entry.kind == "blob",
            "Skill package contains an unsupported Git object: {}",
            entry.path
        );
        ensure!(
            matches!(entry.mode.as_str(), "100644" | "100755"),
            "Skill package contains a symbolic link, submodule, or special file: {}",
            entry.path
        );
    }
    output.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(output)
}

fn directory_tree_sha(resolved: &ResolvedRepository, directory: &str) -> Result<String> {
    if directory == resolved.root_path {
        return Ok(resolved.root_tree.clone());
    }
    resolved
        .entries
        .iter()
        .find(|entry| entry.kind == "tree" && entry.path == directory)
        .map(|entry| entry.sha.clone())
        .context("Skill directory tree was not found")
}

fn parse_skill_frontmatter(content: &str) -> Result<SkillFrontmatter> {
    let content = content
        .strip_prefix("---\n")
        .or_else(|| content.strip_prefix("---\r\n"))
        .context("SKILL.md must begin with YAML frontmatter")?;
    let mut offset = 0;
    let mut end = None;
    for line in content.split_inclusive('\n') {
        if line.trim_end_matches(['\r', '\n']) == "---" {
            end = Some(offset);
            break;
        }
        offset += line.len();
    }
    let end = end.context("SKILL.md frontmatter is not closed")?;
    let metadata: SkillFrontmatter = serde_yaml::from_str(&content[..end])?;
    validate_skill_name(&metadata.name)?;
    ensure!(
        !metadata.description.trim().is_empty(),
        "Skill description is required"
    );
    ensure!(
        metadata.description.len() <= 1024,
        "Skill description exceeds 1024 characters"
    );
    if let Some(compatibility) = metadata.compatibility.as_deref() {
        ensure!(
            compatibility.len() <= 500,
            "Skill compatibility exceeds 500 characters"
        );
    }
    if let Some(license) = metadata.license.as_deref() {
        ensure!(license.len() <= 256, "Skill license exceeds 256 characters");
    }
    Ok(metadata)
}

fn read_skill_entrypoint(path: &Path) -> Result<String> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("Could not inspect {}", path.display()))?;
    ensure!(
        metadata.file_type().is_file() && !platform_path::is_reparse_or_symlink(path)?,
        "SKILL.md must be a regular file"
    );
    ensure!(
        metadata.len() <= MAX_SKILL_ENTRY_BYTES,
        "SKILL.md exceeds the 1 MiB limit"
    );
    let mut content = String::with_capacity(metadata.len() as usize);
    fs::File::open(path)
        .with_context(|| format!("Could not open {}", path.display()))?
        .take(MAX_SKILL_ENTRY_BYTES + 1)
        .read_to_string(&mut content)
        .context("SKILL.md must be UTF-8")?;
    ensure!(
        content.len() as u64 <= MAX_SKILL_ENTRY_BYTES,
        "SKILL.md exceeds the 1 MiB limit"
    );
    Ok(content)
}

fn validate_skill_name(name: &str) -> Result<()> {
    ensure!(
        !name.is_empty()
            && name.len() <= 64
            && name
                .bytes()
                .all(|value| value.is_ascii_lowercase() || value.is_ascii_digit() || value == b'-')
            && name
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphanumeric)
            && name
                .as_bytes()
                .last()
                .is_some_and(u8::is_ascii_alphanumeric)
            && !name.contains("--"),
        "Skill name must use lowercase letters, numbers, and single hyphens"
    );
    Ok(())
}

fn validate_library_id(name: &str) -> Result<()> {
    ensure!(
        !name.is_empty() && name.len() <= 255 && !name.chars().any(char::is_control),
        "Skill library identifier is invalid"
    );
    let path = Path::new(name);
    ensure!(
        path.components().count() == 1
            && matches!(path.components().next(), Some(Component::Normal(_))),
        "Skill library identifier must be one safe path component"
    );
    Ok(())
}

fn validate_trash_id(id: &str) -> Result<()> {
    ensure!(
        !id.is_empty()
            && id.len() <= 160
            && id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-'),
        "Removed Skill id is invalid"
    );
    Ok(())
}

fn source_kind(owner: &str, repository: &str, path: &str) -> SkillSourceKind {
    if owner.eq_ignore_ascii_case("openai")
        && repository.eq_ignore_ascii_case("skills")
        && path.starts_with("skills/.curated/")
    {
        SkillSourceKind::OpenaiCurated
    } else {
        SkillSourceKind::Github
    }
}

fn same_source(left: &SkillSource, right: &SkillSource) -> bool {
    left.repository.eq_ignore_ascii_case(&right.repository)
        && left.reference == right.reference
        && left.path == right.path
}

fn installed_name_for_source(
    root: &Path,
    lock: &SkillLockFile,
    source: &SkillSource,
) -> Option<String> {
    lock.skills.iter().find_map(|(name, entry)| {
        (root.join("skills").join(name).is_dir()
            && entry
                .source
                .as_ref()
                .is_some_and(|current| same_source(current, source)))
        .then(|| name.clone())
    })
}

fn join_repo_path(left: &str, right: &str) -> String {
    if left.is_empty() {
        right.to_string()
    } else {
        format!(
            "{}/{}",
            left.trim_end_matches('/'),
            right.trim_start_matches('/')
        )
    }
}

fn github_api_url(parts: &[&str]) -> Result<Url> {
    let mut url = Url::parse("https://api.github.com/")?;
    url.path_segments_mut()
        .map_err(|_| anyhow::anyhow!("GitHub API URL cannot accept path segments"))?
        .extend(parts.iter().copied());
    Ok(url)
}

fn raw_url(owner: &str, repository: &str, commit: &str, path: &str) -> Result<Url> {
    let mut url = Url::parse("https://raw.githubusercontent.com/")?;
    url.path_segments_mut()
        .map_err(|_| anyhow::anyhow!("GitHub raw URL cannot accept path segments"))?
        .extend([owner, repository, commit])
        .extend(path.split('/'));
    Ok(url)
}

fn lock_path(root: &Path) -> PathBuf {
    root.join("skills.lock.json")
}

fn load_lock(root: &Path) -> Result<SkillLockFile> {
    let path = lock_path(root);
    if !path.exists() {
        return Ok(SkillLockFile {
            schema_version: 1,
            ..Default::default()
        });
    }
    let lock: SkillLockFile = read_json(&path)?;
    ensure!(
        lock.schema_version == 1,
        "Unsupported Skill lock schema version"
    );
    Ok(lock)
}

fn save_lock(root: &Path, lock: &SkillLockFile) -> Result<()> {
    fs::create_dir_all(root)?;
    let mut content = serde_json::to_vec_pretty(lock)?;
    content.push(b'\n');
    atomic_write(&lock_path(root), &content)?;
    Ok(())
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T> {
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut content = serde_json::to_vec_pretty(value)?;
    content.push(b'\n');
    atomic_write(path, &content)?;
    Ok(())
}

fn list_installed(root: &Path) -> Result<Vec<InstalledSkill>> {
    let directory = root.join("skills");
    let lock = load_lock(root)?;
    let Ok(entries) = fs::read_dir(directory) else {
        return Ok(Vec::new());
    };
    let mut output = Vec::new();
    for entry in entries {
        let entry = entry?;
        if !entry.file_type()?.is_dir() || platform_path::is_reparse_or_symlink(&entry.path())? {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let record = lock.skills.get(&name);
        let entrypoint = entry.path().join("SKILL.md");
        let content = read_skill_entrypoint(&entrypoint).ok();
        if content.is_none() && record.is_none() {
            continue;
        }
        let metadata = content
            .as_deref()
            .and_then(|content| parse_skill_frontmatter(content).ok());
        let display_name = metadata
            .as_ref()
            .map(|value| value.name.clone())
            .unwrap_or_else(|| name.clone());
        let (hash, size, modified_at) = match package_hash(&entry.path()) {
            Ok((hash, size, modified_at)) => (Some(hash), size, modified_at),
            Err(_) if record.is_none() => continue,
            Err(_) => (
                None,
                0,
                fs::metadata(entry.path())
                    .ok()
                    .and_then(|metadata| metadata.modified().ok())
                    .map(DateTime::<Utc>::from),
            ),
        };
        let status = match record {
            Some(record) if hash.as_deref() != Some(record.content_sha256.as_str()) => {
                InstalledSkillStatus::Modified
            }
            Some(_) => InstalledSkillStatus::Current,
            None => InstalledSkillStatus::Unmanaged,
        };
        output.push(InstalledSkill {
            name: name.clone(),
            display_name,
            description: metadata.map(|value| value.description).unwrap_or_default(),
            path: entry.path(),
            size,
            modified_at,
            status,
            source: record.and_then(|entry| entry.source.clone()),
            installed_at: record.map(|entry| entry.installed_at),
            updated_at: record.map(|entry| entry.updated_at),
            can_rollback: lock.previous.contains_key(&name)
                && root.join("backups/skills").join(&name).is_dir(),
        });
    }
    output.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(output)
}

fn skill_display_name(root: &Path, fallback: &str) -> String {
    read_skill_entrypoint(&root.join("SKILL.md"))
        .ok()
        .and_then(|content| parse_skill_frontmatter(&content).ok())
        .map(|metadata| metadata.name)
        .unwrap_or_else(|| fallback.to_string())
}

fn restored_skill(record: &TrashRecord, target: &Path, backup: &Path) -> InstalledSkill {
    let content = read_skill_entrypoint(&target.join("SKILL.md")).ok();
    let metadata = content
        .as_deref()
        .and_then(|content| parse_skill_frontmatter(content).ok());
    let package = package_hash(target).ok();
    let lock = record.lock.as_ref();
    let status = match lock {
        Some(lock)
            if package
                .as_ref()
                .is_some_and(|(hash, _, _)| hash == &lock.content_sha256) =>
        {
            InstalledSkillStatus::Current
        }
        Some(_) => InstalledSkillStatus::Modified,
        None => InstalledSkillStatus::Unmanaged,
    };
    InstalledSkill {
        name: record.name.clone(),
        display_name: if record.display_name.is_empty() {
            metadata
                .as_ref()
                .map(|value| value.name.clone())
                .unwrap_or_else(|| record.name.clone())
        } else {
            record.display_name.clone()
        },
        description: metadata.map(|value| value.description).unwrap_or_default(),
        path: target.to_path_buf(),
        size: package.as_ref().map_or(0, |(_, size, _)| *size),
        modified_at: package.and_then(|(_, _, modified_at)| modified_at),
        status,
        source: lock.and_then(|entry| entry.source.clone()),
        installed_at: lock.map(|entry| entry.installed_at),
        updated_at: lock.map(|entry| entry.updated_at),
        can_rollback: record.previous.is_some() && backup.is_dir(),
    }
}

fn managed_skill_result(
    name: &str,
    package_root: &Path,
    result_path: &Path,
    lock: &SkillLockEntry,
    can_rollback: bool,
) -> Result<InstalledSkill> {
    let content = read_skill_entrypoint(&package_root.join("SKILL.md"))?;
    let metadata = parse_skill_frontmatter(&content)?;
    let package = package_hash(package_root)?;
    Ok(InstalledSkill {
        name: name.to_string(),
        display_name: metadata.name,
        description: metadata.description,
        path: result_path.to_path_buf(),
        size: package.1,
        modified_at: package.2,
        status: if package.0 == lock.content_sha256 {
            InstalledSkillStatus::Current
        } else {
            InstalledSkillStatus::Modified
        },
        source: lock.source.clone(),
        installed_at: Some(lock.installed_at),
        updated_at: Some(lock.updated_at),
        can_rollback,
    })
}

fn prepared_installed_skill(
    prepared: &PreparedOperation,
    target: &Path,
    package: &(String, u64, Option<DateTime<Utc>>),
) -> InstalledSkill {
    InstalledSkill {
        name: prepared.target_name.clone(),
        display_name: prepared.preview.skill.name.clone(),
        description: prepared.preview.skill.description.clone(),
        path: target.to_path_buf(),
        size: package.1,
        modified_at: package.2,
        status: InstalledSkillStatus::Current,
        source: prepared.lock.source.clone(),
        installed_at: Some(prepared.lock.installed_at),
        updated_at: Some(prepared.lock.updated_at),
        can_rollback: prepared.preview.operation == SkillOperationKind::Update,
    }
}

#[cfg(unix)]
fn set_executable(path: &Path, executable: bool) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    if executable {
        let mut permissions = fs::metadata(path)?.permissions();
        permissions.set_mode(permissions.mode() | 0o111);
        fs::set_permissions(path, permissions)?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn set_executable(_path: &Path, _executable: bool) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn is_executable(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;

    metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_metadata: &fs::Metadata) -> bool {
    false
}

fn package_hash(root: &Path) -> Result<(String, u64, Option<DateTime<Utc>>)> {
    let (files, total) = bounded_package_files(root)?;
    let mut hash = Sha256::new();
    let mut modified_at = None;
    for (path, metadata) in files {
        let relative = path
            .strip_prefix(root)?
            .to_string_lossy()
            .replace('\\', "/");
        hash.update((relative.len() as u64).to_le_bytes());
        hash.update(relative.as_bytes());
        hash.update([u8::from(is_executable(&metadata))]);
        hash.update(metadata.len().to_le_bytes());
        hash_file_contents(&path, &mut hash)?;
        if let Ok(modified) = metadata.modified() {
            let modified = DateTime::<Utc>::from(modified);
            modified_at =
                Some(modified_at.map_or(modified, |current: DateTime<Utc>| current.max(modified)));
        }
    }
    Ok((format!("{:x}", hash.finalize()), total, modified_at))
}

fn bounded_package_files(root: &Path) -> Result<(Vec<(PathBuf, fs::Metadata)>, u64)> {
    let mut files = Vec::new();
    let mut total = 0_u64;
    let mut entries = 0_usize;
    for entry in WalkDir::new(root).follow_links(false) {
        let entry = entry?;
        entries += 1;
        ensure!(
            entries <= MAX_SKILL_PACKAGE_ENTRIES,
            "Skill package contains more than 4096 entries"
        );
        if entry.file_type().is_dir() {
            continue;
        }
        ensure!(
            entry.file_type().is_file() && !platform_path::is_reparse_or_symlink(entry.path())?,
            "Skill package contains an unsupported file"
        );
        let metadata = fs::metadata(entry.path())?;
        ensure!(
            metadata.len() <= MAX_SKILL_FILE_BYTES,
            "Skill package contains a file larger than 8 MiB"
        );
        ensure!(
            files.len() < MAX_SKILL_FILES,
            "Skill package contains more than 512 files"
        );
        total = total
            .checked_add(metadata.len())
            .context("Skill package size overflow")?;
        ensure!(
            total <= MAX_SKILL_TOTAL_BYTES,
            "Skill package is larger than 32 MiB"
        );
        files.push((entry.into_path(), metadata));
    }
    files.sort_by(|left, right| left.0.cmp(&right.0));
    Ok((files, total))
}

fn hash_file_contents(path: &Path, hash: &mut Sha256) -> Result<()> {
    let mut file = fs::File::open(path)?;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    Ok(())
}

fn package_file_hashes(root: &Path) -> Result<BTreeMap<String, String>> {
    if !root.is_dir() {
        return Ok(BTreeMap::new());
    }
    let mut output = BTreeMap::new();
    for (path, metadata) in bounded_package_files(root)?.0 {
        let relative = path
            .strip_prefix(root)?
            .to_string_lossy()
            .replace('\\', "/");
        let mut hash = Sha256::new();
        hash.update([u8::from(is_executable(&metadata))]);
        hash.update(metadata.len().to_le_bytes());
        hash_file_contents(&path, &mut hash)?;
        output.insert(relative, format!("{:x}", hash.finalize()));
    }
    Ok(output)
}

fn file_delta(existing: &Path, incoming: &Path) -> Result<(Vec<String>, Vec<String>, Vec<String>)> {
    let before = package_file_hashes(existing)?;
    let after = package_file_hashes(incoming)?;
    let added = after
        .keys()
        .filter(|path| !before.contains_key(*path))
        .cloned()
        .collect();
    let modified = after
        .iter()
        .filter(|(path, hash)| before.get(*path).is_some_and(|before| before != *hash))
        .map(|(path, _)| path.clone())
        .collect();
    let removed = before
        .keys()
        .filter(|path| !after.contains_key(*path))
        .cloned()
        .collect();
    Ok((added, modified, removed))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(commit: &str, tree: &str) -> SkillSource {
        SkillSource {
            kind: SkillSourceKind::Github,
            repository: "owner/repository".into(),
            reference: "main".into(),
            path: "skills/reviewer".into(),
            resolved_commit: commit.into(),
            tree_sha: tree.into(),
        }
    }

    fn write_skill(root: &Path, body: &str) {
        fs::create_dir_all(root).unwrap();
        fs::write(
            root.join("SKILL.md"),
            format!("---\nname: reviewer\ndescription: Review changes\n---\n{body}"),
        )
        .unwrap();
    }

    fn prepared_operation(
        root: &Path,
        operation: SkillOperationKind,
        expected_existing_sha256: Option<String>,
        expires_at: DateTime<Utc>,
    ) -> PreparedOperation {
        fs::create_dir_all(root.join(".staging")).unwrap();
        let temp = tempfile::Builder::new()
            .prefix("skill-")
            .tempdir_in(root.join(".staging"))
            .unwrap();
        let package = temp.path().join("package");
        write_skill(&package, "incoming");
        let resolved_source = source("commit-incoming", "tree-incoming");
        PreparedOperation {
            preview: SkillOperationPreview {
                token: "preview".into(),
                operation,
                skill: SkillCandidate {
                    name: "reviewer".into(),
                    description: "Review changes".into(),
                    license: None,
                    compatibility: None,
                    source: resolved_source.clone(),
                },
                files: Vec::new(),
                added: vec!["SKILL.md".into()],
                modified: Vec::new(),
                removed: Vec::new(),
                total_size: 0,
                local_modified: false,
                expires_at,
            },
            target_name: "reviewer".into(),
            lock: SkillLockEntry {
                source: Some(resolved_source),
                content_sha256: package_hash(&package).unwrap().0,
                installed_at: Utc::now(),
                updated_at: Utc::now(),
            },
            temp,
            package,
            expected_existing_sha256,
        }
    }

    #[test]
    fn parses_repository_tree_and_blob_urls() {
        let root = parse_github_url("https://github.com/openai/skills").unwrap();
        assert_eq!(root.owner, "openai");
        assert_eq!(root.repository, "skills");
        assert!(root.reference.is_none());

        let tree = parse_github_url(
            "https://github.com/openai/skills/tree/main/skills/.curated/openai-docs",
        )
        .unwrap();
        let tree_selector = tree.selector.unwrap();
        assert_eq!(tree_selector.kind, GitHubUrlKind::Tree);
        assert_eq!(
            tree_selector.parts,
            ["main", "skills", ".curated", "openai-docs"]
        );

        let blob = parse_github_url(
            "https://github.com/openai/skills/blob/main/skills/.curated/openai-docs/SKILL.md",
        )
        .unwrap();
        let blob_selector = blob.selector.unwrap();
        assert_eq!(blob_selector.kind, GitHubUrlKind::Blob);
        assert_eq!(
            blob_selector.parts,
            ["main", "skills", ".curated", "openai-docs", "SKILL.md"]
        );

        let slash_ref =
            parse_github_url("https://github.com/example/skills/tree/feature/foo/skills/reviewer")
                .unwrap();
        let slash_selector = slash_ref.selector.unwrap();
        assert_eq!(
            slash_selector.parts,
            ["feature", "foo", "skills", "reviewer"]
        );
        assert_eq!(
            selector_reference_candidates(&slash_selector).unwrap(),
            [
                ("feature".into(), "foo/skills/reviewer".into()),
                ("feature/foo".into(), "skills/reviewer".into()),
                ("feature/foo/skills".into(), "reviewer".into()),
                ("feature/foo/skills/reviewer".into(), "".into()),
            ]
        );

        let deep_selector = GitHubUrlSelector {
            kind: GitHubUrlKind::Tree,
            parts: std::iter::once("main".to_string())
                .chain((0..20).map(|index| format!("path-{index}")))
                .collect(),
        };
        let candidates = selector_reference_candidates(&deep_selector).unwrap();
        assert_eq!(candidates.len(), MAX_REF_RESOLUTION_ATTEMPTS);
        assert_eq!(candidates[0].0, "main");
    }

    #[test]
    fn rejects_non_github_and_unsafe_urls() {
        assert!(parse_github_url("https://example.com/openai/skills").is_err());
        assert!(parse_github_url("http://github.com/openai/skills").is_err());
        assert!(parse_github_url("https://github.com/openai/skills/tree/main/../secret").is_err());
        assert!(
            parse_github_url("https://github.com/openai/skills/tree/main/%2e%2e/secret").is_err()
        );
        assert!(
            parse_github_url("https://github.com/openai/skills/tree/main/path%2Fsecret").is_err()
        );
        assert_eq!(
            parse_github_url(
                "https://github.com/openai/skills/tree/main/skills/%E7%A4%BA%E4%BE%8B"
            )
            .unwrap()
            .selector
            .unwrap()
            .parts,
            ["main", "skills", "示例"]
        );
    }

    #[test]
    fn strict_frontmatter_requires_standard_fields() {
        let metadata = parse_skill_frontmatter(
            "---\nname: reviewer\ndescription: Review changes\nlicense: MIT\n---\nBody",
        )
        .unwrap();
        assert_eq!(metadata.name, "reviewer");
        assert!(parse_skill_frontmatter("# Missing metadata").is_err());
        assert!(parse_skill_frontmatter("---\nname: Bad Name\ndescription: x\n---\n").is_err());
        assert!(
            parse_skill_frontmatter("---\nname: reviewer\ndescription: x\n---invalid\n").is_err()
        );
        let oversized_license = format!(
            "---\nname: reviewer\ndescription: x\nlicense: {}\n---\n",
            "x".repeat(257)
        );
        assert!(parse_skill_frontmatter(&oversized_license).is_err());
    }

    #[test]
    fn installed_library_rejects_an_oversized_skill_entrypoint_before_reading_it() {
        let directory = tempfile::tempdir().unwrap();
        let skill = directory.path().join("skills/oversized");
        fs::create_dir_all(&skill).unwrap();
        fs::write(
            skill.join("SKILL.md"),
            vec![b'x'; MAX_SKILL_ENTRY_BYTES as usize + 1],
        )
        .unwrap();

        assert!(read_skill_entrypoint(&skill.join("SKILL.md")).is_err());
        assert!(list_installed(directory.path()).unwrap().is_empty());
    }

    #[test]
    fn github_sources_ignore_repository_case_but_preserve_ref_and_path_case() {
        let original = source("commit", "tree");
        let mut differently_cased_repository = original.clone();
        differently_cased_repository.repository = "Owner/Repository".into();
        assert!(same_source(&original, &differently_cased_repository));

        let mut differently_cased_ref = differently_cased_repository.clone();
        differently_cased_ref.reference = "Main".into();
        assert!(!same_source(&original, &differently_cased_ref));

        let mut differently_cased_path = differently_cased_repository;
        differently_cased_path.path = "skills/Reviewer".into();
        assert!(!same_source(&original, &differently_cased_path));
    }

    #[test]
    fn curated_source_classification_ignores_repository_case_only() {
        assert_eq!(
            source_kind("OpenAI", "Skills", "skills/.curated/reviewer"),
            SkillSourceKind::OpenaiCurated
        );
        assert_eq!(
            source_kind("OpenAI", "Skills", "Skills/.curated/reviewer"),
            SkillSourceKind::Github
        );
    }

    #[test]
    fn candidate_discovery_prefers_direct_skill_directory() {
        let entries = vec![
            TreeEntry {
                path: "skills/a/SKILL.md".into(),
                mode: "100644".into(),
                kind: "blob".into(),
                sha: "a".into(),
                size: Some(1),
            },
            TreeEntry {
                path: "skills/a/references/guide.md".into(),
                mode: "100644".into(),
                kind: "blob".into(),
                sha: "b".into(),
                size: Some(1),
            },
        ];
        assert_eq!(
            candidate_directories(&entries, "skills/a").unwrap(),
            ["skills/a"]
        );
    }

    #[test]
    fn repository_discovery_keeps_valid_candidates_when_a_sibling_is_invalid() {
        let valid = SkillCandidate {
            name: "reviewer".into(),
            description: "Review changes".into(),
            license: None,
            compatibility: None,
            source: source("commit", "tree"),
        };

        let candidates = valid_discovery_candidates(vec![
            Err(anyhow::anyhow!("invalid sibling")),
            Ok(valid.clone()),
        ])
        .unwrap();
        assert_eq!(candidates, [valid]);
        assert!(
            valid_discovery_candidates(vec![Err(anyhow::anyhow!("invalid only"))])
                .unwrap_err()
                .to_string()
                .contains("invalid only")
        );
    }

    #[test]
    fn unmanaged_packages_are_listed_without_a_lockfile() {
        let directory = tempfile::tempdir().unwrap();
        let skill = directory.path().join("skills/my_skill");
        fs::create_dir_all(&skill).unwrap();
        fs::write(
            skill.join("SKILL.md"),
            "---\nname: reviewer\ndescription: Review changes\n---\nBody",
        )
        .unwrap();
        let installed = list_installed(directory.path()).unwrap();
        assert_eq!(installed.len(), 1);
        assert_eq!(installed[0].name, "my_skill");
        assert_eq!(installed[0].display_name, "reviewer");
        assert_eq!(installed[0].status, InstalledSkillStatus::Unmanaged);

        let hub = SkillHub::new(
            directory.path().to_path_buf(),
            directory.path().join("cache"),
        )
        .unwrap();
        let removed = hub.uninstall("my_skill", true).unwrap();
        assert_eq!(removed.name, "my_skill");
        assert_eq!(removed.display_name, "reviewer");
        validate_trash_id(&removed.id).unwrap();
        let conflicting_backup = directory.path().join("backups/skills/my_skill");
        write_skill(&conflicting_backup, "unrelated backup");
        let conflicting_entry = SkillLockEntry {
            source: Some(source("unrelated-commit", "unrelated-tree")),
            content_sha256: "unrelated-hash".into(),
            installed_at: Utc::now(),
            updated_at: Utc::now(),
        };
        save_lock(
            directory.path(),
            &SkillLockFile {
                schema_version: 1,
                skills: BTreeMap::from([("my_skill".into(), conflicting_entry.clone())]),
                previous: BTreeMap::from([("my_skill".into(), conflicting_entry)]),
            },
        )
        .unwrap();

        let restored = hub.restore(&removed.id, true).unwrap();
        let lock = load_lock(directory.path()).unwrap();

        assert_eq!(restored.name, "my_skill");
        assert_eq!(restored.status, InstalledSkillStatus::Unmanaged);
        assert!(!restored.can_rollback);
        assert!(!lock.skills.contains_key("my_skill"));
        assert!(!lock.previous.contains_key("my_skill"));
        assert!(!conflicting_backup.exists());
    }

    #[test]
    fn removed_skills_omit_records_without_a_restorable_package() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        write_skill(&root.join("skills/reviewer"), "body");
        let hub = SkillHub::new(root.to_path_buf(), root.join("cache")).unwrap();
        let removed = hub.uninstall("reviewer", true).unwrap();

        fs::remove_dir_all(removed.path).unwrap();

        assert!(hub.removed().unwrap().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn restore_reports_success_for_an_unmanaged_package_skipped_by_library_scan() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let skill = root.join("skills/reviewer");
        write_skill(&skill, "body");
        symlink("SKILL.md", skill.join("nested-link")).unwrap();
        let hub = SkillHub::new(root.to_path_buf(), root.join("cache")).unwrap();
        let removed = hub.uninstall("reviewer", true).unwrap();

        let restored = hub.restore(&removed.id, true).unwrap();

        assert_eq!(restored.name, "reviewer");
        assert_eq!(restored.status, InstalledSkillStatus::Unmanaged);
        assert!(skill.is_dir());
        assert!(!root.join("trash/skills").join(removed.id).exists());
    }

    #[test]
    fn stale_lock_entries_do_not_select_the_update_path() {
        let directory = tempfile::tempdir().unwrap();
        let source = source("commit", "tree");
        let lock = SkillLockFile {
            schema_version: 1,
            skills: BTreeMap::from([(
                "reviewer".into(),
                SkillLockEntry {
                    source: Some(source.clone()),
                    content_sha256: "hash".into(),
                    installed_at: Utc::now(),
                    updated_at: Utc::now(),
                },
            )]),
            previous: BTreeMap::new(),
        };

        assert_eq!(
            installed_name_for_source(directory.path(), &lock, &source),
            None
        );
        write_skill(&directory.path().join("skills/reviewer"), "body");
        assert_eq!(
            installed_name_for_source(directory.path(), &lock, &source),
            Some("reviewer".into())
        );
    }

    #[test]
    fn reinstall_clears_stale_rollback_state() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let backup = root.join("backups/skills/reviewer");
        write_skill(&backup, "stale backup");
        let stale_entry = SkillLockEntry {
            source: Some(source("stale-commit", "stale-tree")),
            content_sha256: "stale-hash".into(),
            installed_at: Utc::now(),
            updated_at: Utc::now(),
        };
        save_lock(
            root,
            &SkillLockFile {
                schema_version: 1,
                skills: BTreeMap::from([("reviewer".into(), stale_entry.clone())]),
                previous: BTreeMap::from([("reviewer".into(), stale_entry)]),
            },
        )
        .unwrap();
        let hub = SkillHub::new(root.to_path_buf(), root.join("cache")).unwrap();
        let prepared = prepared_operation(
            root,
            SkillOperationKind::Install,
            None,
            Utc::now() + Duration::minutes(15),
        );
        hub.previews
            .lock()
            .unwrap()
            .insert("reinstall".into(), prepared);

        let installed = hub.apply("reinstall", true, false).unwrap();
        let lock = load_lock(root).unwrap();

        assert!(!backup.exists());
        assert!(!lock.previous.contains_key("reviewer"));
        assert_eq!(
            lock.skills["reviewer"]
                .source
                .as_ref()
                .unwrap()
                .resolved_commit,
            "commit-incoming"
        );
        assert!(!installed.can_rollback);
    }

    #[test]
    fn update_validation_failure_preserves_the_existing_rollback_package() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let current = root.join("skills/reviewer");
        let backup = root.join("backups/skills/reviewer");
        write_skill(&current, "current");
        write_skill(&backup, "rollback");
        fs::write(lock_path(root), b"not valid json").unwrap();
        let hub = SkillHub::new(root.to_path_buf(), root.join("cache")).unwrap();
        let prepared = prepared_operation(
            root,
            SkillOperationKind::Update,
            Some(package_hash(&current).unwrap().0),
            Utc::now() + Duration::minutes(15),
        );

        assert!(hub.apply_update(prepared).is_err());
        assert!(
            fs::read_to_string(current.join("SKILL.md"))
                .unwrap()
                .ends_with("current")
        );
        assert!(
            fs::read_to_string(backup.join("SKILL.md"))
                .unwrap()
                .ends_with("rollback")
        );
    }

    #[test]
    fn managed_update_rollback_uninstall_and_restore_preserve_versions() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let current = root.join("skills/reviewer");
        let old_backup = root.join("backups/skills/reviewer");
        write_skill(&current, "current");
        write_skill(&old_backup, "old backup");
        let now = Utc::now();
        let current_entry = SkillLockEntry {
            source: Some(source("commit-current", "tree-current")),
            content_sha256: package_hash(&current).unwrap().0,
            installed_at: now,
            updated_at: now,
        };
        let old_entry = SkillLockEntry {
            source: Some(source("commit-old", "tree-old")),
            content_sha256: package_hash(&old_backup).unwrap().0,
            installed_at: now,
            updated_at: now,
        };
        save_lock(
            root,
            &SkillLockFile {
                schema_version: 1,
                skills: BTreeMap::from([("reviewer".into(), current_entry)]),
                previous: BTreeMap::from([("reviewer".into(), old_entry)]),
            },
        )
        .unwrap();

        fs::create_dir_all(root.join(".staging")).unwrap();
        let temp = tempfile::Builder::new()
            .prefix("skill-")
            .tempdir_in(root.join(".staging"))
            .unwrap();
        let package = temp.path().join("package");
        write_skill(&package, "incoming");
        let incoming_source = source("commit-incoming", "tree-incoming");
        let incoming_lock = SkillLockEntry {
            source: Some(incoming_source.clone()),
            content_sha256: package_hash(&package).unwrap().0,
            installed_at: now,
            updated_at: now,
        };
        let prepared = PreparedOperation {
            preview: SkillOperationPreview {
                token: "preview".into(),
                operation: SkillOperationKind::Update,
                skill: SkillCandidate {
                    name: "reviewer".into(),
                    description: "Review changes".into(),
                    license: None,
                    compatibility: None,
                    source: incoming_source,
                },
                files: Vec::new(),
                added: Vec::new(),
                modified: vec!["SKILL.md".into()],
                removed: Vec::new(),
                total_size: 0,
                local_modified: false,
                expires_at: now + Duration::minutes(15),
            },
            target_name: "reviewer".into(),
            temp,
            package,
            lock: incoming_lock,
            expected_existing_sha256: Some(package_hash(&current).unwrap().0),
        };
        let hub = SkillHub::new(root.to_path_buf(), root.join("cache")).unwrap();

        hub.previews
            .lock()
            .unwrap()
            .insert("preview".into(), prepared);
        hub.apply("preview", true, false).unwrap();
        assert!(
            fs::read_to_string(current.join("SKILL.md"))
                .unwrap()
                .ends_with("incoming")
        );
        assert!(
            fs::read_to_string(old_backup.join("SKILL.md"))
                .unwrap()
                .ends_with("current")
        );

        hub.rollback("reviewer", true).unwrap();
        assert!(
            fs::read_to_string(current.join("SKILL.md"))
                .unwrap()
                .ends_with("current")
        );
        assert!(
            fs::read_to_string(old_backup.join("SKILL.md"))
                .unwrap()
                .ends_with("incoming")
        );

        let removed = hub.uninstall("reviewer", true).unwrap();
        assert!(!current.exists());
        assert!(!old_backup.exists());
        assert_eq!(hub.removed().unwrap().len(), 1);
        let trash_root = root.join("trash/skills").join(&removed.id);
        fs::write(trash_root.join("unexpected"), "leftover").unwrap();

        let restored = hub.restore(&removed.id, true).unwrap();
        assert_eq!(restored.name, "reviewer");
        assert!(current.is_dir());
        assert!(old_backup.is_dir());
        assert!(restored.can_rollback);
        assert!(!trash_root.exists());
        assert!(hub.removed().unwrap().is_empty());
    }

    #[test]
    fn file_preview_rejects_private_and_traversal_paths() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let skill = root.join("skills/reviewer");
        write_skill(&skill, "body");
        fs::create_dir_all(skill.join("references")).unwrap();
        fs::write(skill.join("references/guide.md"), "guide").unwrap();
        fs::write(skill.join("access-token.txt"), "private").unwrap();
        let hub = SkillHub::new(root.to_path_buf(), root.join("cache")).unwrap();

        assert_eq!(
            hub.read_file("reviewer", "references/guide.md")
                .unwrap()
                .content,
            "guide"
        );
        assert!(hub.read_file("reviewer", "access-token.txt").is_err());
        assert!(hub.read_file("reviewer", "../outside.md").is_err());
    }

    #[test]
    fn package_rejects_links_gitlinks_and_too_many_candidates() {
        let unsupported = vec![TreeEntry {
            path: "skills/a/link".into(),
            mode: "120000".into(),
            kind: "blob".into(),
            sha: "a".into(),
            size: Some(1),
        }];
        assert!(package_entries(&unsupported, "skills/a").is_err());

        let candidates = (0..=MAX_CANDIDATES)
            .map(|index| TreeEntry {
                path: format!("skills/{index}/SKILL.md"),
                mode: "100644".into(),
                kind: "blob".into(),
                sha: index.to_string(),
                size: Some(1),
            })
            .collect::<Vec<_>>();
        assert!(candidate_directories(&candidates, "").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn executable_mode_is_applied_and_included_in_package_hashes() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("run.sh");
        fs::write(&script, "#!/bin/sh\n").unwrap();
        let before = package_hash(directory.path()).unwrap().0;

        set_executable(&script, true).unwrap();

        assert_ne!(
            fs::metadata(&script).unwrap().permissions().mode() & 0o111,
            0
        );
        assert_ne!(package_hash(directory.path()).unwrap().0, before);
    }

    #[test]
    fn package_hash_frames_file_paths_and_contents() {
        let directory = tempfile::tempdir().unwrap();
        let split = directory.path().join("split");
        let combined = directory.path().join("combined");
        write_skill(&split, "same");
        write_skill(&combined, "same");
        fs::write(split.join("a"), []).unwrap();
        fs::write(split.join("b"), []).unwrap();
        fs::write(combined.join("a"), b"b\0\0").unwrap();

        assert_ne!(
            package_hash(&split).unwrap().0,
            package_hash(&combined).unwrap().0
        );
    }

    #[test]
    fn package_hash_and_file_deltas_reject_unbounded_local_file_trees() {
        let directory = tempfile::tempdir().unwrap();
        let incoming = tempfile::tempdir().unwrap();
        for index in 0..=MAX_SKILL_FILES {
            fs::write(directory.path().join(format!("file-{index:03}")), []).unwrap();
        }

        assert!(
            package_hash(directory.path())
                .unwrap_err()
                .to_string()
                .contains("more than 512 files")
        );
        assert!(
            file_delta(directory.path(), incoming.path())
                .unwrap_err()
                .to_string()
                .contains("more than 512 files")
        );
    }

    #[test]
    fn package_hash_rejects_unbounded_empty_directory_trees() {
        let directory = tempfile::tempdir().unwrap();
        for index in 0..MAX_SKILL_PACKAGE_ENTRIES {
            fs::create_dir(directory.path().join(format!("directory-{index:04}"))).unwrap();
        }

        assert!(
            package_hash(directory.path())
                .unwrap_err()
                .to_string()
                .contains("more than 4096 entries")
        );
    }

    #[test]
    fn library_scan_emits_one_logical_agentkib_home_asset() {
        let directory = tempfile::tempdir().unwrap();
        let skill = directory.path().join("skills/folder-name");
        write_skill(&skill, "body");
        fs::create_dir_all(skill.join("references")).unwrap();
        fs::write(skill.join("references/guide.md"), "guide").unwrap();

        let assets = scan_library_assets(directory.path()).unwrap();

        assert_eq!(assets.len(), 1);
        assert_eq!(assets[0].scope, CatalogScope::AgentkibHome);
        assert_eq!(assets[0].name, "reviewer");
        assert_eq!(assets[0].path, platform_path::canonicalize(&skill).unwrap());
        assert!(assets[0].size > 5);
    }

    #[cfg(unix)]
    #[test]
    fn installed_list_isolates_malformed_unmanaged_packages() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        write_skill(&directory.path().join("skills/valid"), "valid");
        let unmanaged = directory.path().join("skills/unmanaged-malformed");
        write_skill(&unmanaged, "unmanaged");
        symlink("SKILL.md", unmanaged.join("nested-link")).unwrap();
        let managed = directory.path().join("skills/managed-malformed");
        write_skill(&managed, "managed");
        symlink("SKILL.md", managed.join("nested-link")).unwrap();
        fs::create_dir_all(directory.path().join("skills/managed-missing-entrypoint")).unwrap();
        save_lock(
            directory.path(),
            &SkillLockFile {
                schema_version: 1,
                skills: BTreeMap::from([
                    (
                        "managed-malformed".into(),
                        SkillLockEntry {
                            source: Some(source("commit", "tree")),
                            content_sha256: "prior-hash".into(),
                            installed_at: Utc::now(),
                            updated_at: Utc::now(),
                        },
                    ),
                    (
                        "managed-missing-entrypoint".into(),
                        SkillLockEntry {
                            source: Some(source("commit", "tree")),
                            content_sha256: "prior-hash".into(),
                            installed_at: Utc::now(),
                            updated_at: Utc::now(),
                        },
                    ),
                ]),
                previous: BTreeMap::new(),
            },
        )
        .unwrap();

        let installed = list_installed(directory.path()).unwrap();

        assert_eq!(installed.len(), 3);
        assert_eq!(installed[0].name, "managed-malformed");
        assert_eq!(installed[0].status, InstalledSkillStatus::Modified);
        assert_eq!(installed[1].name, "managed-missing-entrypoint");
        assert_eq!(installed[1].status, InstalledSkillStatus::Modified);
        assert_eq!(installed[2].name, "valid");
    }

    #[test]
    fn library_catalog_ids_do_not_collide_for_matching_frontmatter_names() {
        let directory = tempfile::tempdir().unwrap();
        write_skill(&directory.path().join("skills/first"), "first");
        write_skill(&directory.path().join("skills/second"), "second");

        let assets = scan_library_assets(directory.path()).unwrap();
        let ids = assets
            .iter()
            .map(|asset| asset.id.as_str())
            .collect::<std::collections::BTreeSet<_>>();

        assert_eq!(assets.len(), 2);
        assert!(assets.iter().all(|asset| asset.name == "reviewer"));
        assert_eq!(ids.len(), 2);
    }

    #[test]
    fn expired_or_tampered_previews_cannot_be_applied() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let hub = SkillHub::new(root.to_path_buf(), root.join("cache")).unwrap();

        let expired = prepared_operation(
            root,
            SkillOperationKind::Install,
            None,
            Utc::now() - Duration::seconds(1),
        );
        let expired_path = expired.temp.path().to_path_buf();
        hub.previews
            .lock()
            .unwrap()
            .insert("expired".into(), expired);
        assert!(hub.apply("expired", true, false).is_err());
        assert!(!expired_path.exists());

        let tampered = prepared_operation(
            root,
            SkillOperationKind::Install,
            None,
            Utc::now() + Duration::minutes(15),
        );
        fs::write(tampered.package.join("extra.txt"), "changed after preview").unwrap();
        hub.previews
            .lock()
            .unwrap()
            .insert("tampered".into(), tampered);
        let error = hub.apply("tampered", true, false).unwrap_err().to_string();
        assert!(error.contains("changed after preview"));
        assert!(!root.join("skills/reviewer").exists());
    }

    #[test]
    fn prepared_preview_pool_is_bounded_and_drops_oldest_staging_directory() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let hub = SkillHub::new(root.to_path_buf(), root.join("cache")).unwrap();
        let mut oldest_path = None;

        for index in 0..=MAX_RETAINED_PREVIEWS {
            let mut prepared = prepared_operation(
                root,
                SkillOperationKind::Install,
                None,
                Utc::now() + Duration::minutes(1) + Duration::seconds(index as i64),
            );
            prepared.preview.token = format!("preview-{index}");
            if index == 0 {
                oldest_path = Some(prepared.temp.path().to_path_buf());
            }
            hub.store_prepared_preview(prepared).unwrap();
        }

        let previews = hub.previews.lock().unwrap();
        assert_eq!(previews.len(), MAX_RETAINED_PREVIEWS);
        assert!(!previews.contains_key("preview-0"));
        assert!(!oldest_path.unwrap().exists());
    }

    #[test]
    fn directory_swap_restores_both_sides_when_the_final_move_fails() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let left = root.join("left");
        let right = root.join("right");
        write_skill(&left, "left");
        write_skill(&right, "right");
        let mut moves = 0;

        let error = swap_directories_with(root, &left, &right, |source, target| {
            moves += 1;
            if moves == 3 {
                Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "simulated transient file lock",
                ))
            } else {
                move_path(source, target)
            }
        })
        .unwrap_err();

        assert!(error.to_string().contains("simulated transient file lock"));
        assert!(
            fs::read_to_string(left.join("SKILL.md"))
                .unwrap()
                .ends_with("left")
        );
        assert!(
            fs::read_to_string(right.join("SKILL.md"))
                .unwrap()
                .ends_with("right")
        );
        assert_eq!(fs::read_dir(root.join(".staging")).unwrap().count(), 0);
    }

    #[test]
    fn directory_swap_reports_the_staged_package_when_initial_recovery_fails() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let left = root.join("left");
        let right = root.join("right");
        write_skill(&left, "left");
        write_skill(&right, "right");
        let mut moves = 0;

        let error = swap_directories_with(root, &left, &right, |source, target| {
            moves += 1;
            if moves >= 2 {
                Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "simulated transient file lock",
                ))
            } else {
                move_path(source, target)
            }
        })
        .unwrap_err()
        .to_string();

        assert!(error.contains("simulated transient file lock"));
        assert!(error.contains("The original package is preserved"));
        assert!(!left.exists());
        assert!(right.is_dir());
        let staged = fs::read_dir(root.join(".staging"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert!(staged.is_dir());
        assert!(error.contains(&staged.display().to_string()));
    }

    #[test]
    fn failed_uninstall_recovery_keeps_the_package_in_trash() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let package = root.join("trash/package");
        let target = root.join("skills/reviewer");
        let trashed_backup = root.join("trash/backup");
        let backup = root.join("backups/skills/reviewer");
        write_skill(&package, "current");
        write_skill(&trashed_backup, "rollback");

        let recovery =
            recover_uninstall_moves_with(&package, &target, &trashed_backup, &backup, |_, _| {
                Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "simulated transient file lock",
                ))
            });

        assert!(recovery.is_err());
        assert!(package.is_dir());
        assert!(trashed_backup.is_dir());
        assert!(!target.exists());
        assert!(!backup.exists());
    }

    #[test]
    fn failed_restore_reversal_reports_the_live_package_and_restores_other_backups() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let target = root.join("skills/reviewer");
        let package = root.join("trash/package");
        let conflicting_backup = root.join("trash/conflicting-backup");
        let backup = root.join("backups/skills/reviewer");
        fs::create_dir_all(backup.parent().unwrap()).unwrap();
        write_skill(&target, "restored package");
        write_skill(&conflicting_backup, "conflicting backup");
        let mut moves = 0;

        let error = recover_directory_moves_with(
            &[(&target, &package), (&conflicting_backup, &backup)],
            |source, destination| {
                moves += 1;
                if moves == 1 {
                    Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "simulated transient file lock",
                    ))
                } else {
                    move_path(source, destination)
                }
            },
        )
        .unwrap_err()
        .to_string();

        assert!(error.contains(&target.display().to_string()));
        assert!(error.contains(&package.display().to_string()));
        assert!(target.is_dir());
        assert!(!package.exists());
        assert!(!conflicting_backup.exists());
        assert!(backup.is_dir());
    }

    #[test]
    fn failed_install_backup_recovery_keeps_the_package_outside_preview_staging() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        fs::create_dir_all(root.join(".staging")).unwrap();
        let preview = tempfile::Builder::new()
            .prefix("skill-")
            .tempdir_in(root.join(".staging"))
            .unwrap();
        let staged_backup = root.join(".staging/stale-backup-test");
        let backup = root.join("backups/skills/reviewer");
        write_skill(&staged_backup, "previous package");

        let recovery = recover_staged_backup_with(&staged_backup, &backup, |_, _| {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "simulated transient file lock",
            ))
        });
        drop(preview);

        assert!(recovery.is_err());
        assert!(staged_backup.is_dir());
        assert!(!backup.exists());
    }

    #[test]
    fn failed_update_recovery_reports_where_the_current_package_is_preserved() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let backup = root.join("backups/skills/reviewer");
        let target = root.join("skills/reviewer");
        let prior_backup = root.join(".staging/prior-backup-test");
        write_skill(&backup, "current");
        write_skill(&prior_backup, "prior rollback");

        let error = recover_update_moves_with(&backup, &target, &prior_backup, |_, _| {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "simulated transient file lock",
            ))
        })
        .unwrap_err()
        .to_string();

        assert!(error.contains(&backup.display().to_string()));
        assert!(error.contains(&target.display().to_string()));
        assert!(backup.is_dir());
        assert!(prior_backup.is_dir());
        assert!(!target.exists());
    }

    #[test]
    fn failed_install_recovery_reports_the_live_package_location() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let target = root.join("skills/reviewer");
        let package = root.join(".staging/preview/package");
        let staged_backup = root.join(".staging/stale-backup-test");
        let backup = root.join("backups/skills/reviewer");
        write_skill(&target, "incoming");
        write_skill(&staged_backup, "previous rollback");

        let error =
            recover_install_moves_with(&target, &package, &staged_backup, &backup, |_, _| {
                Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "simulated transient file lock",
                ))
            })
            .unwrap_err()
            .to_string();

        assert!(error.contains(&target.display().to_string()));
        assert!(error.contains(&package.display().to_string()));
        assert!(target.is_dir());
        assert!(staged_backup.is_dir());
    }

    #[test]
    fn failed_update_check_does_not_mask_a_healthy_update() {
        assert_eq!(
            update_check_status(
                InstalledSkillStatus::Current,
                Err(anyhow::anyhow!("source is unavailable")),
            ),
            InstalledSkillStatus::Current
        );
        assert_eq!(
            update_check_status(InstalledSkillStatus::Current, Ok(true)),
            InstalledSkillStatus::UpdateAvailable
        );
    }

    #[test]
    fn failed_rollback_reversal_reports_both_failures_and_package_paths() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("skills/reviewer");
        let backup = directory.path().join("backups/skills/reviewer");

        let error = rollback_lock_failure_with(
            anyhow::anyhow!("simulated lock write failure"),
            &target,
            &backup,
            || anyhow::bail!("simulated reverse swap failure"),
        )
        .to_string();

        assert!(error.contains("simulated lock write failure"));
        assert!(error.contains("simulated reverse swap failure"));
        assert!(error.contains(&target.display().to_string()));
        assert!(error.contains(&backup.display().to_string()));
    }

    #[tokio::test]
    async fn curated_catalog_falls_back_to_a_timestamped_cache_when_offline() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("home");
        let cache_dir = directory.path().join("cache");
        let cached_at = Utc::now() - Duration::days(1);
        write_json(
            &cache_dir.join("curated-skills.json"),
            &SkillCatalogSnapshot {
                entries: vec![SkillCatalogEntry {
                    candidate: SkillCandidate {
                        name: "reviewer".into(),
                        description: "Review changes".into(),
                        license: None,
                        compatibility: None,
                        source: source("commit", "tree"),
                    },
                    installed: false,
                }],
                cached_at,
                stale: false,
            },
        )
        .unwrap();
        let client = Client::builder()
            .proxy(reqwest::Proxy::all("http://127.0.0.1:1").unwrap())
            .connect_timeout(std::time::Duration::from_millis(50))
            .build()
            .unwrap();
        let hub = SkillHub {
            root,
            cache_dir,
            client,
            previews: Mutex::new(HashMap::new()),
            lifecycle: Mutex::new(()),
        };

        let catalog = hub.curated(true).await.unwrap();

        assert!(catalog.stale);
        assert_eq!(catalog.cached_at, cached_at);
        assert_eq!(catalog.entries[0].candidate.name, "reviewer");
    }
}
