//! Shared ownership checks for the legacy manifest writer and Skill deployments.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use agentkib_platform::fs::{ExpectedFile, atomic_write_checked};
use agentkib_platform::path as platform_path;
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};

use crate::{AgentKind, ChangeSet, Manifest, SkillDeployment, SkillScope};

static SKILL_WRITE_LOCK: Mutex<()> = Mutex::new(());
const MAX_SKILL_DEPLOYMENT_RECORD_BYTES: u64 = 4 * 1024 * 1024;
const MAX_SKILL_DEPLOYMENT_RECORDS: usize = 4096;

/// Serializes both package deployments and the older text ChangeSet writer.
pub fn skill_write_lock() -> Result<MutexGuard<'static, ()>> {
    SKILL_WRITE_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("Skill ownership write lock is unavailable"))
}

/// The process mutex prevents competing local writers from deadlocking while these locks
/// serialize runtimes/CLI processes that share a physical scope.
pub struct SkillScopeLocks {
    files: Vec<fs::File>,
}

impl Drop for SkillScopeLocks {
    fn drop(&mut self) {
        for file in &self.files {
            // Closing alone can leave a Unix lock held by a descriptor inherited between
            // fork and exec in another thread. Unlock the shared file description explicitly.
            let _ = file.unlock();
        }
    }
}

pub fn skill_scope_locks(scopes: &[PathBuf]) -> Result<SkillScopeLocks> {
    let mut scopes = scopes.to_vec();
    scopes.sort_by_key(|path| platform_path::identity(path));
    scopes.dedup_by(|left, right| platform_path::equivalent(left, right));
    let mut locks = SkillScopeLocks { files: Vec::new() };
    for root in scopes {
        ensure!(root.is_absolute(), "Skill lock scope must be absolute");
        if root.exists() {
            ensure!(
                root.is_dir() && !platform_path::is_reparse_or_symlink(&root)?,
                "Skill lock scope must be a regular directory"
            );
        }
        let directory = root.join(".agentkib");
        if directory.exists() {
            ensure!(
                directory.is_dir() && !platform_path::is_reparse_or_symlink(&directory)?,
                "Skill lock directory must be a regular directory"
            );
        }
        fs::create_dir_all(&directory)?;
        let path = directory.join("skill-write.lock");
        if let Ok(metadata) = fs::symlink_metadata(&path) {
            ensure!(
                metadata.is_file() && !platform_path::is_reparse_or_symlink(&path)?,
                "Skill write lock must be a regular file"
            );
        }
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)?;
        file.lock()
            .context("Could not acquire the Skill scope write lock")?;
        locks.files.push(file);
    }
    Ok(locks)
}

pub fn project_skill_record_path(project: &Path) -> PathBuf {
    project.join(".agentkib/skill-deployments.json")
}

pub fn project_skill_reservation_path(project: &Path) -> PathBuf {
    project.join(".agentkib/skill-deployment-reservations.json")
}

/// Find ownership scopes along the actual access paths, without walking unrelated trees.
/// The explicit project is always included; nested/ancestor projects need an existing marker.
pub fn skill_ownership_scope_roots(project: &Path, paths: &[PathBuf]) -> Result<Vec<PathBuf>> {
    ownership_scope_roots(project, paths, &mut BTreeMap::new())
}

/// Find existing workspace scopes along destination paths without treating an Agent Home
/// or an unrelated ChangeSet project as a workspace that needs to be locked or written.
pub fn skill_workspace_scope_roots(paths: &[PathBuf]) -> Result<Vec<PathBuf>> {
    Ok(
        marked_workspace_scope_roots(paths.iter(), &mut BTreeMap::new())?
            .into_values()
            .collect(),
    )
}

fn ownership_scope_roots(
    project: &Path,
    paths: &[PathBuf],
    markers: &mut BTreeMap<String, bool>,
) -> Result<Vec<PathBuf>> {
    ensure!(
        project.is_absolute(),
        "Skill ownership project must be absolute"
    );
    let project = platform_path::canonicalize_allow_missing(project)?;
    ensure!(
        project.parent().is_some(),
        "Filesystem root is not a Skill project"
    );
    let mut roots = marked_workspace_scope_roots(std::iter::once(&project).chain(paths), markers)?;
    roots.insert(platform_path::identity(&project), project);
    Ok(roots.into_values().collect())
}

fn marked_workspace_scope_roots<'a>(
    paths: impl Iterator<Item = &'a PathBuf>,
    markers: &mut BTreeMap<String, bool>,
) -> Result<BTreeMap<String, PathBuf>> {
    let mut roots = BTreeMap::new();
    for path in paths {
        ensure!(path.is_absolute(), "Skill ownership paths must be absolute");
        let path = platform_path::canonicalize_allow_missing(path)?;
        for ancestor in path.ancestors().filter(|path| path.parent().is_some()) {
            let key = platform_path::identity(ancestor);
            let is_scope = match markers.get(&key) {
                Some(value) => *value,
                None => {
                    let value = is_skill_project_scope(ancestor)?;
                    markers.insert(key.clone(), value);
                    value
                }
            };
            if is_scope {
                roots.insert(key, ancestor.to_path_buf());
            }
        }
    }
    Ok(roots)
}

fn is_skill_project_scope(root: &Path) -> Result<bool> {
    // Access paths can be files or still-missing directories. Only inspect metadata below
    // regular existing directories; resolving an alias happens once at the public boundary.
    match fs::symlink_metadata(root) {
        Ok(metadata) if metadata.is_dir() && !platform_path::is_reparse_or_symlink(root)? => {}
        Ok(_) => return Ok(false),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    }
    let metadata = root.join(".agentkib");
    match fs::symlink_metadata(&metadata) {
        Ok(entry) => ensure!(
            entry.is_dir() && !platform_path::is_reparse_or_symlink(&metadata)?,
            "Skill ownership metadata must be a regular directory"
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    for marker in [
        root.join(".git"),
        crate::manifest_path(root),
        project_skill_libraries_path(root),
    ] {
        match fs::symlink_metadata(marker) {
            Ok(_) => return Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    // ~/.agentkib is also a personal library: a personal or empty receipt does not
    // establish a workspace. An actual workspace record identifies unmarked projects.
    for path in [
        project_skill_record_path(root),
        project_skill_reservation_path(root),
    ] {
        match fs::symlink_metadata(&path) {
            Ok(_) => {
                if read_skill_deployment_records(&path)?
                    .iter()
                    .any(|record| record.scope == SkillScope::Workspace)
                {
                    return Ok(true);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(false)
}

/// Read-only scan cache. Each encountered scope is parsed once, including child projects
/// discovered after scanning has entered their directory. Apply uses a fresh reader.
pub struct SkillOwnershipReader {
    project: PathBuf,
    home: PathBuf,
    markers: BTreeMap<String, bool>,
    records: BTreeMap<String, Vec<SkillDeployment>>,
    personal_markers: BTreeMap<String, bool>,
    personal_records: BTreeMap<String, Vec<SkillDeployment>>,
}

impl SkillOwnershipReader {
    pub fn new(project: &Path) -> Result<Self> {
        let mut reader = Self {
            project: platform_path::canonicalize(project)?,
            home: skill_library_home()?,
            markers: BTreeMap::new(),
            records: BTreeMap::new(),
            personal_markers: BTreeMap::new(),
            personal_records: BTreeMap::new(),
        };
        for root in ownership_scope_roots(&reader.project, &[], &mut reader.markers)? {
            reader.records.insert(
                platform_path::identity(&root),
                project_skill_ownership_at_home(&root, &reader.home)?,
            );
        }
        Ok(reader)
    }

    pub fn contains(&mut self, path: &Path, include_ancestors: bool) -> Result<bool> {
        let resolved_relative;
        let path = if path.is_absolute() {
            path
        } else {
            resolved_relative = platform_path::canonicalize(path)?;
            &resolved_relative
        };
        for root in ownership_scope_roots(&self.project, &[path.to_path_buf()], &mut self.markers)?
        {
            let key = platform_path::identity(&root);
            if !self.records.contains_key(&key) {
                self.records.insert(
                    key.clone(),
                    project_skill_ownership_at_home(&root, &self.home)?,
                );
            }
            if self.records[&key]
                .iter()
                .any(|record| deployment_path_matches(&record.target, path, include_ancestors))
            {
                return Ok(true);
            }
        }
        for scope in personal_scope_roots(&[path.to_path_buf()], &mut self.personal_markers)? {
            let key = platform_path::identity(&scope);
            if !self.personal_records.contains_key(&key) {
                self.personal_records.insert(
                    key.clone(),
                    personal_skill_scope_ownership(&scope, &self.home)?,
                );
            }
            if self.personal_records[&key]
                .iter()
                .any(|record| deployment_path_matches(&record.target, path, include_ancestors))
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

/// Shared by library writers and legacy readers so environment/profile overrides cannot
/// leave a personal deployment invisible to a project that contains its native directory.
pub fn skill_library_home() -> Result<PathBuf> {
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

pub fn personal_skill_record_path(home: &Path) -> PathBuf {
    home.join("skill-deployments.json")
}

pub fn personal_skill_reservation_path(home: &Path) -> PathBuf {
    home.join("skill-deployment-reservations.json")
}

pub fn personal_skill_reservations(home: &Path) -> Result<Vec<SkillDeployment>> {
    personal_records_at(&personal_skill_reservation_path(home))
}

fn project_skill_libraries_path(project: &Path) -> PathBuf {
    project.join(".agentkib/skill-library-roots.json")
}

fn personal_skill_scope_libraries_path(scope: &Path) -> PathBuf {
    scope.join(".agentkib/skill-personal-library-roots.json")
}

/// Personal indexes establish their own lock/ownership scope, never a workspace identity.
pub fn personal_skill_scope_roots(paths: &[PathBuf]) -> Result<Vec<PathBuf>> {
    personal_scope_roots(paths, &mut BTreeMap::new())
}

fn personal_scope_roots(
    paths: &[PathBuf],
    markers: &mut BTreeMap<String, bool>,
) -> Result<Vec<PathBuf>> {
    let mut scopes = BTreeMap::new();
    for path in paths {
        ensure!(path.is_absolute(), "Skill ownership paths must be absolute");
        let resolved = platform_path::canonicalize_allow_missing(path)?;
        for access in [path.as_path(), resolved.as_path()] {
            for ancestor in access.ancestors().filter(|path| path.parent().is_some()) {
                let key = platform_path::lexical_identity(ancestor);
                let present = match markers.get(&key) {
                    Some(present) => *present,
                    None => {
                        let present = match fs::symlink_metadata(ancestor) {
                            Ok(metadata)
                                if metadata.is_dir()
                                    && !platform_path::is_reparse_or_symlink(ancestor)? =>
                            {
                                match fs::symlink_metadata(personal_skill_scope_libraries_path(
                                    ancestor,
                                )) {
                                    Ok(_) => true,
                                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                                        false
                                    }
                                    Err(error) => return Err(error.into()),
                                }
                            }
                            Ok(_) => false,
                            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
                            Err(error) => return Err(error.into()),
                        };
                        markers.insert(key.clone(), present);
                        present
                    }
                };
                if present {
                    scopes.insert(key, ancestor.to_path_buf());
                }
            }
        }
    }
    Ok(scopes.into_values().collect())
}

#[derive(Serialize, Deserialize)]
struct ProjectSkillLibraries {
    schema_version: u32,
    libraries: Vec<PathBuf>,
}

fn project_skill_libraries(project: &Path) -> Result<Vec<PathBuf>> {
    read_skill_libraries(&project_skill_libraries_path(project))
}

fn read_skill_libraries(path: &Path) -> Result<Vec<PathBuf>> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    ensure!(
        metadata.is_file()
            && !platform_path::is_reparse_or_symlink(path)?
            && !platform_path::is_reparse_or_symlink(path.parent().unwrap())?
            && metadata.len() <= 1024 * 1024,
        "Skill library ownership index is unsafe or too large"
    );
    let index: ProjectSkillLibraries = serde_json::from_slice(&fs::read(path)?)?;
    ensure!(
        index.schema_version == 1 && index.libraries.len() <= 128,
        "Unsupported Skill library ownership index"
    );
    ensure!(
        index.libraries.iter().all(|path| path.is_absolute()
            && !path
                .components()
                .any(|part| matches!(part, std::path::Component::ParentDir))),
        "Skill library ownership index contains an invalid path"
    );
    Ok(index.libraries)
}

/// Call only while holding the project and library scope locks, before personal native writes.
/// Keeping the owning root here lets another app flavor/CLI observe ownership after restart.
pub fn register_project_skill_library(project: &Path, home: &Path) -> Result<()> {
    register_skill_library(project, home, &project_skill_libraries_path(project))
}

/// Call only while holding the personal scope and library locks. This index lives beside the
/// physical target, so switching AgentKib Home cannot hide an unfinished personal deployment.
pub fn register_personal_skill_scope_library(scope: &Path, home: &Path) -> Result<()> {
    register_skill_library(scope, home, &personal_skill_scope_libraries_path(scope))
}

fn register_skill_library(project: &Path, home: &Path, path: &Path) -> Result<()> {
    ensure!(
        project.is_absolute(),
        "Skill ownership project must be absolute"
    );
    for directory in [project.to_path_buf(), project.join(".agentkib")] {
        ensure!(
            directory.is_dir() && !platform_path::is_reparse_or_symlink(&directory)?,
            "Skill ownership directory must be a regular directory"
        );
    }
    let home = platform_path::canonicalize(home)?;
    let mut libraries = read_skill_libraries(path)?;
    if libraries
        .iter()
        .any(|root| platform_path::equivalent(root, &home))
    {
        return Ok(());
    }
    let expected = match fs::read(path) {
        Ok(bytes) => Some(crate::hash_content(&bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    // Capture the fingerprint before reading values used by the write.
    libraries = read_skill_libraries(path)?;
    if !libraries
        .iter()
        .any(|root| platform_path::equivalent(root, &home))
    {
        libraries.push(home);
    }
    ensure!(
        libraries.len() <= 128,
        "Too many Skill library ownership roots"
    );
    let bytes = serde_json::to_vec_pretty(&ProjectSkillLibraries {
        schema_version: 1,
        libraries,
    })?;
    ensure!(
        bytes.len() <= 1024 * 1024,
        "Skill library ownership index is too large"
    );
    atomic_write_checked(
        path,
        &bytes,
        expected
            .as_deref()
            .map(ExpectedFile::Sha256)
            .unwrap_or(ExpectedFile::Missing),
    )?;
    Ok(())
}

/// Reads only; old libraries are associated when an explicitly approved operation next writes.
pub fn personal_skill_scope_ownership(scope: &Path, home: &Path) -> Result<Vec<SkillDeployment>> {
    let mut libraries = read_skill_libraries(&personal_skill_scope_libraries_path(scope))?;
    for library in &libraries {
        ensure!(
            library.is_dir() && !platform_path::is_reparse_or_symlink(library)?,
            "A personal Skill ownership library is unavailable; ownership cannot be verified"
        );
    }
    if !libraries
        .iter()
        .any(|library| platform_path::equivalent(library, home))
    {
        libraries.push(home.to_path_buf());
    }
    let mut records = Vec::new();
    for library in libraries {
        let mut personal = personal_records_at(&personal_skill_record_path(&library))?;
        personal.extend(personal_skill_reservations(&library)?);
        records.extend(
            personal
                .into_iter()
                .filter(|record| deployment_path_matches(&record.target, scope, true)),
        );
    }
    Ok(records)
}

/// The text writer cannot rewrite a deployment manager's cross-library ownership index,
/// including an approved Home write outside the ChangeSet's project.
pub fn ensure_changeset_personal_skill_scope_indexes(changeset: &ChangeSet) -> Result<()> {
    let is_index = |path: &Path| {
        path.file_name()
            .is_some_and(|name| name == "skill-personal-library-roots.json")
            && path
                .parent()
                .and_then(Path::file_name)
                .is_some_and(|name| name == ".agentkib")
    };
    for change in &changeset.changes {
        ensure!(
            !is_index(&change.target)
                && !platform_path::canonicalize_allow_missing(&change.target)
                    .is_ok_and(|path| is_index(&path)),
            "Skill deployment records cannot be changed by a text ChangeSet"
        );
    }
    Ok(())
}

fn personal_records_at(path: &Path) -> Result<Vec<SkillDeployment>> {
    let records = read_skill_deployment_records(path)?;
    ensure!(
        records
            .iter()
            .all(|record| record.scope == SkillScope::Personal),
        "Personal Skill receipts contain workspace records"
    );
    Ok(records)
}

pub fn skill_paths_overlap(left: &Path, right: &Path) -> bool {
    platform_path::starts_with(left, right) || platform_path::starts_with(right, left)
}

/// A receipt owns its recorded location, never the destination of a later replacement link.
/// Resolve only the access path so an alias to an intact managed directory is still protected.
pub fn skill_deployment_contains_path(recorded: &Path, candidate: &Path) -> bool {
    deployment_path_matches(recorded, candidate, false)
}

fn deployment_path_matches(recorded: &Path, candidate: &Path, include_ancestors: bool) -> bool {
    let matches = |path: &Path| {
        platform_path::lexical_starts_with(path, recorded)
            || include_ancestors && platform_path::lexical_starts_with(recorded, path)
    };
    matches(candidate)
        || platform_path::canonicalize_allow_missing(candidate)
            .is_ok_and(|resolved| matches(&resolved))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillDeploymentRecords {
    pub schema_version: u32,
    pub deployments: Vec<SkillDeployment>,
}

/// Encode receipts with the same limits and invariants required by every reader.
pub fn encode_skill_deployment_records(records: &SkillDeploymentRecords) -> Result<Vec<u8>> {
    validate_skill_deployment_records(records)?;
    let bytes = serde_json::to_vec_pretty(records)?;
    ensure!(
        bytes.len() as u64 <= MAX_SKILL_DEPLOYMENT_RECORD_BYTES,
        "Skill deployment records exceed the size limit"
    );
    Ok(bytes)
}

pub fn read_skill_deployment_records(path: &Path) -> Result<Vec<SkillDeployment>> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    ensure!(
        metadata.is_file() && !platform_path::is_reparse_or_symlink(path)?,
        "Skill deployment records must be a regular file"
    );
    if let Some(parent) = path.parent() {
        ensure!(
            !platform_path::is_reparse_or_symlink(parent)?,
            "Skill deployment record directory cannot be a symbolic link"
        );
    }
    ensure!(
        metadata.len() <= MAX_SKILL_DEPLOYMENT_RECORD_BYTES,
        "Skill deployment records exceed the size limit"
    );
    let records: SkillDeploymentRecords =
        serde_json::from_slice(&fs::read(path)?).with_context(|| {
            format!(
                "Could not read Skill deployment records: {}",
                path.display()
            )
        })?;
    validate_skill_deployment_records(&records)?;
    Ok(records.deployments)
}

fn validate_skill_deployment_records(records: &SkillDeploymentRecords) -> Result<()> {
    ensure!(
        records.schema_version == 1,
        "Unsupported Skill deployment record version"
    );
    ensure!(
        records.deployments.len() <= MAX_SKILL_DEPLOYMENT_RECORDS,
        "Too many Skill deployment records"
    );
    for record in &records.deployments {
        if let Some(library) = &record.library_root {
            ensure!(
                library.is_absolute()
                    && !library
                        .components()
                        .any(|part| matches!(part, std::path::Component::ParentDir)),
                "Skill deployment library root must be an absolute path without parent components"
            );
        }
        ensure!(
            record.target.is_absolute() && record.scope_root.is_absolute(),
            "Skill deployment paths must be absolute"
        );
        // Validate the recorded lexical location, not the current link destination. A foreign
        // symlink replacing a deployed directory must remain visible as an ownership conflict.
        ensure!(
            record.target.starts_with(&record.scope_root),
            "Skill deployment target is outside its scope"
        );
        ensure!(
            record.target != record.scope_root,
            "Skill deployment target cannot replace its scope root"
        );
        ensure!(
            !record
                .target
                .components()
                .any(|part| matches!(part, std::path::Component::ParentDir)),
            "Skill deployment target contains parent components"
        );
    }
    Ok(())
}

pub fn project_skill_deployments(project: &Path) -> Result<Vec<SkillDeployment>> {
    project_records_at(project, &project_skill_record_path(project))
}

pub fn project_skill_reservations(project: &Path) -> Result<Vec<SkillDeployment>> {
    project_records_at(project, &project_skill_reservation_path(project))
}

/// Includes operations that have reserved a native path but have not committed a receipt yet.
/// Reading ownership never repairs or migrates either durable file.
pub fn project_skill_ownership(project: &Path) -> Result<Vec<SkillDeployment>> {
    project_skill_ownership_at_home(project, &skill_library_home()?)
}

/// Reads ownership using an explicit library while retaining indexed libraries from other homes.
pub fn project_skill_ownership_at_home(
    project: &Path,
    home: &Path,
) -> Result<Vec<SkillDeployment>> {
    let receipt = project_skill_record_path(project);
    let reservation = project_skill_reservation_path(project);
    let mut records = project_records_at_home(project, &receipt, home)?;
    records.extend(project_records_at_home(project, &reservation, home)?);
    let mut libraries = project_skill_libraries(project)?;
    // A dotfiles repository at HOME shares this metadata directory with the default
    // personal library. Keep its personal ownership visible without parsing it as a workspace.
    for path in [&receipt, &reservation] {
        if is_personal_record_file(path, home, &read_skill_deployment_records(path)?) {
            let library = project.join(".agentkib");
            if !libraries
                .iter()
                .any(|root| platform_path::equivalent(root, &library))
            {
                libraries.push(library);
            }
            break;
        }
    }
    if !libraries
        .iter()
        .any(|root| platform_path::equivalent(root, home))
    {
        libraries.push(home.to_path_buf());
    }
    for library in libraries {
        let mut personal = personal_records_at(&personal_skill_record_path(&library))?;
        personal.extend(personal_skill_reservations(&library)?);
        records.extend(
            personal
                .into_iter()
                .filter(|record| deployment_path_matches(&record.target, project, true)),
        );
    }
    Ok(records)
}

fn project_records_at(project: &Path, path: &Path) -> Result<Vec<SkillDeployment>> {
    project_records_at_home(project, path, &skill_library_home()?)
}

fn project_records_at_home(
    project: &Path,
    path: &Path,
    home: &Path,
) -> Result<Vec<SkillDeployment>> {
    let records = read_skill_deployment_records(path)?;
    if is_personal_record_file(path, home, &records) {
        return Ok(Vec::new());
    }
    for record in &records {
        ensure!(
            record.scope == SkillScope::Workspace
                && platform_path::equivalent(&record.scope_root, project),
            "Skill deployment record belongs to another workspace"
        );
    }
    Ok(records)
}

fn is_personal_record_file(path: &Path, home: &Path, records: &[SkillDeployment]) -> bool {
    if records.is_empty()
        || records
            .iter()
            .any(|record| record.scope != SkillScope::Personal)
    {
        return false;
    }
    let Some(library) = path.parent() else {
        return false;
    };
    is_personal_library_directory(library, home)
        || records.iter().all(|record| {
            record.library_root.as_ref().is_some_and(|root| {
                platform_path::lexical_identity(root) == platform_path::lexical_identity(library)
            })
        })
}

fn is_personal_library_directory(library: &Path, home: &Path) -> bool {
    platform_path::equivalent(library, home)
        || dirs::home_dir().is_some_and(|user_home| {
            [".agentkib", ".agentkib-dev"]
                .into_iter()
                .any(|name| platform_path::equivalent(library, &user_home.join(name)))
        })
}

/// A project at HOME may read personal receipts, but cannot mix workspace receipts into them.
pub fn ensure_workspace_skill_record_namespace(project: &Path, home: &Path) -> Result<()> {
    ensure!(
        !is_personal_library_directory(&project.join(".agentkib"), home),
        "Project deployment records overlap a personal Skill library"
    );
    for path in [
        project_skill_record_path(project),
        project_skill_reservation_path(project),
    ] {
        ensure!(
            read_skill_deployment_records(&path)?
                .iter()
                .all(|record| record.scope == SkillScope::Workspace),
            "Project deployment records overlap a personal Skill library"
        );
    }
    Ok(())
}

/// Inactive receipts retain their reservation so an old manifest cannot recreate an undeployed
/// package. Only the deployment manager may release or reuse that physical target.
pub fn is_project_skill_owned(project: &Path, target: &Path) -> Result<bool> {
    SkillOwnershipReader::new(project)?.contains(target, true)
}

pub fn ensure_manifest_skill_ownership(project: &Path, manifest: &Manifest) -> Result<()> {
    let mut ownership = SkillOwnershipReader::new(project)?;
    for path in manifest_skill_paths(project, manifest) {
        ensure!(
            !ownership.contains(&path, true)?,
            "Workspace manifest overlaps a Skill deployment: {}",
            path.display()
        );
    }
    Ok(())
}

/// Includes manifest sources when a plan changes only generated outputs. The current
/// manifest is re-read under these same scopes before a delayed ChangeSet can be applied.
pub fn changeset_skill_scope_roots(changeset: &ChangeSet) -> Result<Vec<PathBuf>> {
    let paths = changeset_skill_paths(changeset)?;
    let mut scopes = skill_ownership_scope_roots(&changeset.project_root, &paths)?;
    scopes.extend(personal_skill_scope_roots(&paths)?);
    scopes.sort_by_key(|scope| platform_path::identity(scope));
    scopes.dedup_by(|left, right| platform_path::equivalent(left, right));
    Ok(scopes)
}

pub(crate) fn changeset_target_skill_scope_roots(changeset: &ChangeSet) -> Result<Vec<PathBuf>> {
    let paths = changeset_target_paths(changeset);
    let mut scopes = skill_workspace_scope_roots(&paths)?;
    scopes.extend(personal_skill_scope_roots(&paths)?);
    scopes.sort_by_key(|scope| platform_path::identity(scope));
    scopes.dedup_by(|left, right| platform_path::equivalent(left, right));
    Ok(scopes)
}

fn changeset_target_paths(changeset: &ChangeSet) -> Vec<PathBuf> {
    changeset
        .changes
        .iter()
        .map(|change| change.target.clone())
        .collect()
}

fn changeset_skill_paths(changeset: &ChangeSet) -> Result<Vec<PathBuf>> {
    let mut paths = changeset_target_paths(changeset);
    let current = crate::manifest_path(&changeset.project_root);
    match fs::symlink_metadata(&current) {
        Ok(_) => paths.extend(manifest_skill_paths(
            &changeset.project_root,
            &crate::load_manifest(&changeset.project_root)?,
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    for change in &changeset.changes {
        if let Some(project) = changed_manifest_project(&change.target) {
            let manifest: Manifest =
                serde_yaml::from_str(&change.after).context("ChangeSet manifest is invalid")?;
            paths.extend(manifest_skill_paths(project, &manifest));
        }
    }
    Ok(paths)
}

fn changed_manifest_project(path: &Path) -> Option<&Path> {
    let metadata = path.parent()?;
    (path.file_name()? == "manifest.yaml" && metadata.file_name()? == ".agentkib")
        .then(|| metadata.parent())
        .flatten()
}

pub fn ensure_changeset_skill_ownership(changeset: &ChangeSet) -> Result<()> {
    let project = &changeset.project_root;
    let paths = changeset_skill_paths(changeset)?;
    let scopes = skill_ownership_scope_roots(project, &paths)?;
    ensure_changeset_skill_ownership_in_scopes(changeset, &paths, &scopes)?;
    if crate::manifest_path(project).is_file()
        && !changeset
            .changes
            .iter()
            .any(|change| platform_path::equivalent(&change.target, &crate::manifest_path(project)))
    {
        ensure_manifest_skill_ownership(project, &crate::load_manifest(project)?)?;
    }
    Ok(())
}

fn ensure_changeset_skill_ownership_in_scopes(
    changeset: &ChangeSet,
    paths: &[PathBuf],
    scopes: &[PathBuf],
) -> Result<()> {
    let mut records = Vec::new();
    let mut protected = Vec::new();
    let home = skill_library_home()?;
    let mut libraries = vec![home.clone()];
    for scope in scopes {
        records.extend(project_skill_ownership_at_home(scope, &home)?);
        protected.extend([
            project_skill_record_path(scope),
            project_skill_reservation_path(scope),
            project_skill_libraries_path(scope),
        ]);
        libraries.extend(project_skill_libraries(scope)?);
    }
    for scope in personal_skill_scope_roots(paths)? {
        records.extend(personal_skill_scope_ownership(&scope, &home)?);
        protected.push(personal_skill_scope_libraries_path(&scope));
    }
    for library in libraries {
        protected.extend([
            personal_skill_record_path(&library),
            personal_skill_reservation_path(&library),
        ]);
    }
    for change in &changeset.changes {
        ensure!(
            !protected
                .iter()
                .any(|path| skill_paths_overlap(&change.target, path)),
            "Skill deployment records cannot be changed by a text ChangeSet"
        );
        ensure!(
            !records.iter().any(|record| deployment_path_matches(
                &record.target,
                &change.target,
                true
            )),
            "ChangeSet overlaps a Skill deployment: {}",
            change.target.display()
        );
        if let Some(project) = changed_manifest_project(&change.target) {
            let manifest: Manifest =
                serde_yaml::from_str(&change.after).context("ChangeSet manifest is invalid")?;
            crate::validate_manifest(&manifest)?;
            ensure_manifest_skill_ownership(project, &manifest)?;
        }
    }
    Ok(())
}

/// Home/application writes inspect ownership at their actual destinations without reading
/// the unrelated project's manifest or requiring its metadata directory to be writable.
pub(crate) fn ensure_changeset_target_skill_ownership(changeset: &ChangeSet) -> Result<()> {
    let paths = changeset_target_paths(changeset);
    let scopes = skill_workspace_scope_roots(&paths)?;
    ensure_changeset_skill_ownership_in_scopes(changeset, &paths, &scopes)
}

/// Includes source directories as well as generated targets: importing a managed copy as a
/// manifest source would let the legacy planner silently redistribute it to other agents.
/// Scoped instruction outputs also write inside packages and need the same protection.
pub fn manifest_skill_paths(project: &Path, manifest: &Manifest) -> Vec<PathBuf> {
    let enabled = |agent| {
        manifest.adapters.get(&agent).map_or(
            !matches!(
                agent,
                AgentKind::OpenCode | AgentKind::GrokBuild | AgentKind::Antigravity
            ),
            |state| state.enabled,
        )
    };
    let mut paths = Vec::new();
    let common_instructions_enabled = [
        AgentKind::Codex,
        AgentKind::Cursor,
        AgentKind::OpenCode,
        AgentKind::OpenClaw,
        AgentKind::Hermes,
        AgentKind::GrokBuild,
        AgentKind::Antigravity,
    ]
    .into_iter()
    .any(enabled);
    for scoped in &manifest.instructions.scoped {
        let directory = project.join(&scoped.path);
        if common_instructions_enabled {
            paths.push(directory.join("AGENTS.md"));
        }
        if enabled(AgentKind::ClaudeCode) {
            paths.push(directory.join("CLAUDE.md"));
        }
    }
    for skill in &manifest.skills {
        paths.push(project.join(&skill.path));
        let selected =
            |agent| enabled(agent) && (skill.targets.is_empty() || skill.targets.contains(&agent));
        let shared = [
            AgentKind::Codex,
            AgentKind::OpenCode,
            AgentKind::OpenClaw,
            AgentKind::Hermes,
            AgentKind::Antigravity,
        ]
        .into_iter()
        .any(selected);
        if shared {
            paths.push(project.join(".agents/skills").join(&skill.name));
        }
        if selected(AgentKind::Cursor) && !shared {
            paths.push(project.join(".cursor/skills").join(&skill.name));
        }
        if selected(AgentKind::ClaudeCode) {
            paths.push(project.join(".claude/skills").join(&skill.name));
        }
        if selected(AgentKind::GrokBuild) {
            paths.push(project.join(".grok/skills").join(&skill.name));
        }
    }
    paths
}

pub fn ensure_skill_target_not_manifest_owned(project: &Path, target: &Path) -> Result<()> {
    for root in skill_ownership_scope_roots(project, &[target.to_path_buf()])? {
        ensure_single_project_manifest_does_not_own(&root, target)?;
    }
    Ok(())
}

fn ensure_single_project_manifest_does_not_own(project: &Path, target: &Path) -> Result<()> {
    let manifest_path = crate::manifest_path(project);
    match fs::symlink_metadata(&manifest_path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
        Ok(_) => {}
    }
    let manifest = crate::load_manifest(project)?;
    ensure!(
        !manifest_skill_paths(project, &manifest)
            .iter()
            .any(|path| skill_paths_overlap(path, target)),
        "Skill target is owned by the workspace manifest: {}",
        target.display()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        AdapterState, ChangeScope, FileChange, RiskLevel, SkillDefinition, WorkspaceIdentity,
    };
    use chrono::Utc;

    fn manifest() -> Manifest {
        Manifest {
            schema_version: 2,
            workspace: WorkspaceIdentity {
                id: "project".into(),
                name: "Project".into(),
            },
            instructions: Default::default(),
            skills: Vec::new(),
            mcp: Default::default(),
            connections: Vec::new(),
            memories: Default::default(),
            adapters: [(
                AgentKind::Codex,
                AdapterState {
                    enabled: true,
                    generated_hashes: Default::default(),
                },
            )]
            .into(),
        }
    }

    fn owned(project: &Path) -> SkillDeployment {
        let record = SkillDeployment {
            id: uuid::Uuid::new_v4().to_string(),
            library_id: "reviewer".into(),
            library_root: None,
            package_name: "reviewer".into(),
            package_hash: "hash".into(),
            scope: SkillScope::Workspace,
            workspace_id: Some("project".into()),
            scope_root: project.to_path_buf(),
            target: project.join(".agents/skills/reviewer"),
            agents: vec![AgentKind::Codex],
            visible_to: vec![AgentKind::Codex],
            status: "active".into(),
            diagnostics: Vec::new(),
            previous_hash: None,
            operation_id: uuid::Uuid::new_v4().to_string(),
            updated_at: Utc::now(),
        };
        let path = project_skill_record_path(project);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            path,
            serde_json::to_vec(&SkillDeploymentRecords {
                schema_version: 1,
                deployments: vec![record.clone()],
            })
            .unwrap(),
        )
        .unwrap();
        record
    }

    #[test]
    fn protects_both_manifest_sources_and_generated_destinations() {
        let temp = tempfile::tempdir().unwrap();
        let root = platform_path::canonicalize(temp.path()).unwrap();
        owned(&root);
        let mut manifest = manifest();
        manifest.skills.push(SkillDefinition {
            name: "different-name".into(),
            path: ".agents/skills/reviewer".into(),
            targets: vec![AgentKind::ClaudeCode],
        });
        assert!(ensure_manifest_skill_ownership(&root, &manifest).is_err());
        manifest.skills[0] = SkillDefinition {
            name: "reviewer".into(),
            path: "some-other-source".into(),
            targets: vec![AgentKind::Codex],
        };
        assert!(ensure_manifest_skill_ownership(&root, &manifest).is_err());
        manifest.skills[0].name = "independent".into();
        assert!(ensure_manifest_skill_ownership(&root, &manifest).is_ok());
    }

    #[test]
    fn non_project_changes_respect_ancestor_workspace_receipts_and_reservations() {
        for pending in [false, true] {
            for scope in [ChangeScope::AgentHome, ChangeScope::ApplicationData] {
                let temp = tempfile::tempdir().unwrap();
                let root = platform_path::canonicalize(temp.path()).unwrap();
                let project = root.join("unregistered-project");
                let unrelated = root.join("unrelated");
                fs::create_dir_all(&project).unwrap();
                fs::create_dir_all(&unrelated).unwrap();
                let record = owned(&project);
                let receipt = project_skill_record_path(&project);
                let record_path = if pending {
                    let reservation = project_skill_reservation_path(&project);
                    fs::rename(&receipt, &reservation).unwrap();
                    reservation
                } else {
                    receipt
                };
                let original_record = fs::read(&record_path).unwrap();
                // No Git/manifest/library-index marker exists: the workspace record alone
                // must protect both its package and its metadata from an outside writer.
                for target in [record.target.join("config.json"), record_path.clone()] {
                    let before = fs::read_to_string(&target).ok();
                    let set = ChangeSet {
                        id: uuid::Uuid::new_v4().to_string(),
                        project_root: unrelated.clone(),
                        created_at: Utc::now(),
                        changes: vec![FileChange {
                            target: target.clone(),
                            scope,
                            original_hash: before
                                .as_ref()
                                .map(|text| crate::hash_content(text.as_bytes())),
                            before: before.clone().unwrap_or_default(),
                            after: "{}".into(),
                            risk: RiskLevel::Low,
                            validator: "json".into(),
                        }],
                        requires_home_approval: matches!(scope, ChangeScope::AgentHome),
                    };
                    assert_eq!(
                        skill_workspace_scope_roots(std::slice::from_ref(&target)).unwrap(),
                        vec![project.clone()]
                    );
                    let error = crate::apply_changeset(
                        &set,
                        &root.join("backups"),
                        &crate::ApplyOptions {
                            approved_home_files: vec![target.clone()],
                            approved_application_files: vec![target.clone()],
                            home_approval: true,
                            ..crate::ApplyOptions::default()
                        },
                    )
                    .unwrap_err();
                    assert!(error.to_string().contains("Skill deployment"), "{error}");
                    assert_eq!(fs::read_to_string(&target).ok(), before);
                    assert_eq!(fs::read(&record_path).unwrap(), original_record);
                    assert!(!unrelated.join(".agentkib").exists());
                    assert!(!root.join("backups").exists());
                }
            }
        }
    }

    #[test]
    fn personal_receipts_and_reservations_remain_visible_after_switching_library_home() {
        for pending in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let root = platform_path::canonicalize(temp.path()).unwrap();
            let project = root.join("project");
            let library = root.join("old-library");
            let next_library = root.join("new-library");
            fs::create_dir_all(&project).unwrap();
            fs::create_dir_all(&library).unwrap();
            let mut record = owned(&project);
            fs::remove_file(project_skill_record_path(&project)).unwrap();
            record.scope = SkillScope::Personal;
            record.workspace_id = None;
            record.scope_root = project.join(".claude");
            record.target = record.scope_root.join("skills/reviewer");
            let path = if pending {
                personal_skill_reservation_path(&library)
            } else {
                personal_skill_record_path(&library)
            };
            let original = encode_skill_deployment_records(&SkillDeploymentRecords {
                schema_version: 1,
                deployments: vec![record.clone()],
            })
            .unwrap();
            fs::write(&path, &original).unwrap();
            // Compatibility discovery can observe a personal deployment without writing an index.
            assert_eq!(
                project_skill_ownership_at_home(&project, &library)
                    .unwrap()
                    .len(),
                1
            );
            assert!(!project_skill_libraries_path(&project).exists());
            register_project_skill_library(&project, &library).unwrap();
            let index = fs::read(project_skill_libraries_path(&project)).unwrap();
            let found = project_skill_ownership_at_home(&project, &next_library).unwrap();
            assert_eq!(found.len(), 1);
            assert_eq!(found[0].id, record.id);
            assert_eq!(fs::read(&path).unwrap(), original);
            assert_eq!(
                fs::read(project_skill_libraries_path(&project)).unwrap(),
                index
            );
            assert!(!next_library.exists());
            let unrelated = root.join("unrelated");
            fs::create_dir(&unrelated).unwrap();
            assert!(
                project_skill_ownership_at_home(&unrelated, &library)
                    .unwrap()
                    .is_empty()
            );
            assert!(!unrelated.join(".agentkib").exists());
        }
    }

    #[test]
    fn personal_scope_index_preserves_cross_library_ownership_without_read_side_effects() {
        for pending in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let root = platform_path::canonicalize(temp.path()).unwrap();
            let project = root.join("project");
            let library = root.join("old-library");
            let next_library = root.join("new-library");
            let scope = root.join("native-home");
            for path in [&project, &library, &scope] {
                fs::create_dir(path).unwrap();
            }
            let mut record = owned(&project);
            fs::remove_file(project_skill_record_path(&project)).unwrap();
            record.scope = SkillScope::Personal;
            record.workspace_id = None;
            record.scope_root = scope.clone();
            record.target = scope.join("skills/reviewer");
            record.library_root = Some(library.clone());
            let receipt = if pending {
                personal_skill_reservation_path(&library)
            } else {
                personal_skill_record_path(&library)
            };
            let bytes = encode_skill_deployment_records(&SkillDeploymentRecords {
                schema_version: 1,
                deployments: vec![record.clone()],
            })
            .unwrap();
            fs::write(&receipt, &bytes).unwrap();
            assert!(
                personal_skill_scope_ownership(&scope, &next_library)
                    .unwrap()
                    .is_empty()
            );
            assert!(!scope.join(".agentkib").exists());
            {
                let _write = skill_write_lock().unwrap();
                let _scopes = skill_scope_locks(&[scope.clone(), library.clone()]).unwrap();
                register_personal_skill_scope_library(&scope, &library).unwrap();
            }
            let index = fs::read(personal_skill_scope_libraries_path(&scope)).unwrap();
            let records = personal_skill_scope_ownership(&scope, &next_library).unwrap();
            assert_eq!(records.len(), 1);
            assert_eq!(records[0].id, record.id);
            assert_eq!(fs::read(receipt).unwrap(), bytes);
            assert_eq!(
                fs::read(personal_skill_scope_libraries_path(&scope)).unwrap(),
                index
            );
            assert!(!next_library.exists());
            // A personal index must not turn an agent home into an ancestor workspace.
            assert!(!is_skill_project_scope(&scope).unwrap());
            fs::rename(&library, root.join("offline-library")).unwrap();
            assert!(personal_skill_scope_ownership(&scope, &next_library).is_err());
        }
    }

    #[test]
    fn dotfiles_ancestor_reads_personal_receipts_without_treating_them_as_workspace_records() {
        for pending in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let home = platform_path::canonicalize(temp.path()).unwrap();
            let library = home.join(".agentkib");
            let child = home.join("project");
            fs::create_dir(home.join(".git")).unwrap();
            fs::create_dir_all(child.join(".git")).unwrap();
            let mut record = owned(&home);
            record.scope = SkillScope::Personal;
            record.workspace_id = None;
            record.scope_root = home.join(".claude");
            record.target = record.scope_root.join("skills/reviewer");
            record.library_root = Some(library.clone());
            let receipt = if pending {
                fs::remove_file(project_skill_record_path(&home)).unwrap();
                personal_skill_reservation_path(&library)
            } else {
                personal_skill_record_path(&library)
            };
            let bytes = encode_skill_deployment_records(&SkillDeploymentRecords {
                schema_version: 1,
                deployments: vec![record.clone()],
            })
            .unwrap();
            fs::write(&receipt, &bytes).unwrap();
            assert!(project_skill_deployments(&home).unwrap().is_empty());
            assert!(project_skill_reservations(&home).unwrap().is_empty());
            let mut reader = SkillOwnershipReader::new(&child).unwrap();
            assert!(!reader.contains(&child.join("AGENTS.md"), true).unwrap());
            assert!(reader.contains(&record.target, true).unwrap());
            assert_eq!(
                project_skill_ownership_at_home(&home, &library)
                    .unwrap()
                    .len(),
                1
            );
            assert!(ensure_workspace_skill_record_namespace(&home, &library).is_err());
            assert_eq!(fs::read(&receipt).unwrap(), bytes);
            assert!(!child.join(".agentkib").exists());
            assert!(!project_skill_libraries_path(&home).exists());
            // Legacy records lack a source binding; the explicit owning library still
            // identifies the namespace without migrating the record on read.
            record.library_root = None;
            fs::write(
                &receipt,
                encode_skill_deployment_records(&SkillDeploymentRecords {
                    schema_version: 1,
                    deployments: vec![record],
                })
                .unwrap(),
            )
            .unwrap();
            assert!(
                project_records_at_home(&home, &receipt, &library)
                    .unwrap()
                    .is_empty()
            );
            assert_eq!(
                project_skill_ownership_at_home(&home, &library)
                    .unwrap()
                    .len(),
                1
            );
        }
    }

    #[test]
    fn text_changesets_cannot_modify_personal_scope_indexes_inside_or_outside_the_project() {
        for scope in [ChangeScope::Project, ChangeScope::AgentHome] {
            let temp = tempfile::tempdir().unwrap();
            let root = platform_path::canonicalize(temp.path()).unwrap();
            let project = root.join("project");
            fs::create_dir(&project).unwrap();
            let native_scope = if matches!(scope, ChangeScope::Project) {
                project.join(".claude")
            } else {
                root.join(".claude")
            };
            let index = personal_skill_scope_libraries_path(&native_scope);
            let set = ChangeSet {
                id: uuid::Uuid::new_v4().to_string(),
                project_root: project,
                created_at: Utc::now(),
                changes: vec![FileChange {
                    target: index.clone(),
                    scope,
                    original_hash: None,
                    before: String::new(),
                    after: "{}".into(),
                    risk: RiskLevel::Low,
                    validator: "json".into(),
                }],
                requires_home_approval: matches!(scope, ChangeScope::AgentHome),
            };
            let error = crate::apply_changeset(
                &set,
                &root.join("backups"),
                &crate::ApplyOptions {
                    approved_home_files: vec![index.clone()],
                    home_approval: true,
                    ..crate::ApplyOptions::default()
                },
            )
            .unwrap_err();
            assert!(
                error
                    .to_string()
                    .contains("Skill deployment records cannot be changed")
            );
            assert!(!index.exists());
            assert!(!root.join("backups").exists());
        }
    }

    #[test]
    fn later_projects_and_home_changesets_observe_personal_indexes_from_another_library() {
        let temp = tempfile::tempdir().unwrap();
        let root = platform_path::canonicalize(temp.path()).unwrap();
        let project = root.join("home");
        let library = root.join("old-library");
        let scope = project.join(".claude");
        let unrelated = root.join("unrelated");
        for path in [&scope, &library, &unrelated] {
            fs::create_dir_all(path).unwrap();
        }
        let mut record = owned(&project);
        fs::remove_file(project_skill_record_path(&project)).unwrap();
        record.scope = SkillScope::Personal;
        record.workspace_id = None;
        record.scope_root = scope.clone();
        record.target = scope.join("skills/reviewer");
        record.library_root = Some(library.clone());
        let bytes = encode_skill_deployment_records(&SkillDeploymentRecords {
            schema_version: 1,
            deployments: vec![record.clone()],
        })
        .unwrap();
        let receipt = personal_skill_record_path(&library);
        fs::write(&receipt, &bytes).unwrap();
        {
            let _write = skill_write_lock().unwrap();
            let _scopes = skill_scope_locks(&[scope.clone(), library.clone()]).unwrap();
            register_personal_skill_scope_library(&scope, &library).unwrap();
        }
        let index = personal_skill_scope_libraries_path(&scope);
        let index_bytes = fs::read(&index).unwrap();
        let mut reader = SkillOwnershipReader::new(&project).unwrap();
        assert!(reader.contains(&record.target, true).unwrap());
        assert!(
            reader
                .contains(&record.target.join("AGENTS.md"), false)
                .unwrap()
        );
        let mut claimed = manifest();
        claimed.skills.push(SkillDefinition {
            name: "copy".into(),
            path: ".claude/skills/reviewer".into(),
            targets: vec![AgentKind::Codex],
        });
        assert!(ensure_manifest_skill_ownership(&project, &claimed).is_err());
        let change = |target, scope, after: String| FileChange {
            target,
            scope,
            original_hash: None,
            before: String::new(),
            after,
            risk: RiskLevel::Low,
            validator: "markdown".into(),
        };
        let mut set = ChangeSet {
            id: uuid::Uuid::new_v4().to_string(),
            project_root: project.clone(),
            created_at: Utc::now(),
            changes: vec![change(
                crate::manifest_path(&project),
                ChangeScope::Project,
                serde_yaml::to_string(&claimed).unwrap(),
            )],
            requires_home_approval: false,
        };
        // Both a proposed manifest and an already-persisted source must contribute its
        // personal scope even if this ChangeSet only writes unrelated generated outputs.
        assert!(changeset_skill_scope_roots(&set).unwrap().contains(&scope));
        assert!(ensure_changeset_skill_ownership(&set).is_err());
        fs::write(
            crate::manifest_path(&project),
            serde_yaml::to_string(&claimed).unwrap(),
        )
        .unwrap();
        set.changes = vec![change(
            project.join("AGENTS.md"),
            ChangeScope::Project,
            "instructions".into(),
        )];
        assert!(changeset_skill_scope_roots(&set).unwrap().contains(&scope));
        assert!(ensure_changeset_skill_ownership(&set).is_err());
        let native_file = record.target.join("SKILL.md");
        set.project_root = unrelated.clone();
        set.changes = vec![change(
            native_file.clone(),
            ChangeScope::AgentHome,
            "external overwrite".into(),
        )];
        set.requires_home_approval = true;
        let error = crate::apply_changeset(
            &set,
            &root.join("backups"),
            &crate::ApplyOptions {
                approved_home_files: vec![native_file.clone()],
                home_approval: true,
                ..crate::ApplyOptions::default()
            },
        )
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("ChangeSet overlaps a Skill deployment")
        );
        assert!(!native_file.exists());
        assert!(!unrelated.join(".agentkib").exists());
        assert!(!project_skill_libraries_path(&project).exists());
        assert_eq!(fs::read(index).unwrap(), index_bytes);
        assert_eq!(fs::read(receipt).unwrap(), bytes);
    }

    #[cfg(unix)]
    #[test]
    fn registering_a_library_does_not_follow_a_replaced_project_metadata_directory() {
        let temp = tempfile::tempdir().unwrap();
        let root = platform_path::canonicalize(temp.path()).unwrap();
        let project = root.join("project");
        let library = root.join("library");
        let outside = root.join("outside");
        for path in [&project, &library, &outside] {
            fs::create_dir(path).unwrap();
        }
        let lock = skill_scope_locks(std::slice::from_ref(&project)).unwrap();
        fs::rename(project.join(".agentkib"), project.join("old-metadata")).unwrap();
        std::os::unix::fs::symlink(&outside, project.join(".agentkib")).unwrap();
        assert!(!project_skill_libraries_path(&project).exists());
        assert!(register_project_skill_library(&project, &library).is_err());
        assert!(fs::read_dir(&outside).unwrap().next().is_none());
        assert!(platform_path::is_reparse_or_symlink(&project.join(".agentkib")).unwrap());
        drop(lock);
    }

    #[test]
    fn non_project_scope_labels_do_not_bypass_project_deployment_ownership() {
        for scope in [ChangeScope::AgentHome, ChangeScope::ApplicationData] {
            let temp = tempfile::tempdir().unwrap();
            let root = platform_path::canonicalize(temp.path()).unwrap();
            let record = owned(&root);
            fs::create_dir_all(&record.target).unwrap();
            let target = record.target.join("SKILL.md");
            fs::write(&target, "managed").unwrap();
            let set = ChangeSet {
                id: uuid::Uuid::new_v4().to_string(),
                project_root: root.clone(),
                created_at: Utc::now(),
                changes: vec![FileChange {
                    target: target.clone(),
                    scope,
                    original_hash: Some(crate::hash_content(b"managed")),
                    before: "managed".into(),
                    after: "unmanaged".into(),
                    risk: RiskLevel::Low,
                    validator: "markdown".into(),
                }],
                requires_home_approval: false,
            };
            let error = crate::apply_changeset(
                &set,
                &root.join("backups"),
                &crate::ApplyOptions {
                    approved_home_files: vec![target.clone()],
                    approved_application_files: vec![target.clone()],
                    home_approval: true,
                    ..crate::ApplyOptions::default()
                },
            )
            .unwrap_err();
            assert!(
                error
                    .to_string()
                    .contains("ChangeSet overlaps a Skill deployment")
            );
            assert_eq!(fs::read_to_string(target).unwrap(), "managed");
        }
    }

    #[cfg(unix)]
    #[test]
    fn replacing_a_deployment_or_its_parent_with_a_link_does_not_claim_legacy_files() {
        for reservation in [false, true] {
            for ancestor in [false, true] {
                let temp = tempfile::tempdir().unwrap();
                let root = platform_path::canonicalize(temp.path()).unwrap();
                let record = owned(&root);
                let record_path = if reservation {
                    let path = project_skill_reservation_path(&root);
                    fs::rename(project_skill_record_path(&root), &path).unwrap();
                    path
                } else {
                    project_skill_record_path(&root)
                };
                let original_receipt = fs::read(&record_path).unwrap();
                let legacy_root = root.join("legacy");
                let legacy = if ancestor {
                    legacy_root.join("reviewer")
                } else {
                    legacy_root.clone()
                };
                fs::create_dir_all(&legacy).unwrap();
                let entrypoint = legacy.join("SKILL.md");
                fs::write(&entrypoint, "legacy").unwrap();
                let replaced = if ancestor {
                    record.target.parent().unwrap()
                } else {
                    &record.target
                };
                fs::create_dir_all(replaced.parent().unwrap()).unwrap();
                std::os::unix::fs::symlink(&legacy_root, replaced).unwrap();
                assert!(is_project_skill_owned(&root, &record.target).unwrap());
                assert!(!is_project_skill_owned(&root, &legacy).unwrap());
                assert!(!skill_deployment_contains_path(&record.target, &entrypoint));
                let mut manifest = manifest();
                manifest.skills.push(SkillDefinition {
                    name: "legacy".into(),
                    path: legacy.strip_prefix(&root).unwrap().to_string_lossy().into(),
                    targets: vec![AgentKind::ClaudeCode],
                });
                ensure_manifest_skill_ownership(&root, &manifest).unwrap();
                let set = ChangeSet {
                    id: uuid::Uuid::new_v4().to_string(),
                    project_root: root.clone(),
                    created_at: Utc::now(),
                    changes: vec![FileChange {
                        target: entrypoint.clone(),
                        scope: ChangeScope::Project,
                        original_hash: Some(crate::hash_content(b"legacy")),
                        before: "legacy".into(),
                        after: "updated legacy".into(),
                        risk: RiskLevel::Low,
                        validator: "markdown".into(),
                    }],
                    requires_home_approval: false,
                };
                crate::apply_changeset(
                    &set,
                    &root.join("backups"),
                    &crate::ApplyOptions::default(),
                )
                .unwrap();
                assert_eq!(fs::read_to_string(entrypoint).unwrap(), "updated legacy");
                assert!(
                    fs::symlink_metadata(replaced)
                        .unwrap()
                        .file_type()
                        .is_symlink()
                );
                assert_eq!(fs::read(record_path).unwrap(), original_receipt);
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn outside_aliases_to_intact_deployments_cannot_bypass_ownership_as_home_writes() {
        let temp = tempfile::tempdir().unwrap();
        let root = platform_path::canonicalize(temp.path()).unwrap();
        let project = root.join("project");
        fs::create_dir(&project).unwrap();
        let record = owned(&project);
        fs::create_dir_all(&record.target).unwrap();
        let alias = root.join("alias");
        std::os::unix::fs::symlink(record.target.parent().unwrap(), &alias).unwrap();
        let source = alias.join("reviewer");
        let target = source.join("new.md");
        assert!(!target.exists());
        assert!(skill_deployment_contains_path(&record.target, &target));
        assert!(is_project_skill_owned(&project, &source).unwrap());
        let set = ChangeSet {
            id: uuid::Uuid::new_v4().to_string(),
            project_root: project.clone(),
            created_at: Utc::now(),
            changes: vec![FileChange {
                target: target.clone(),
                scope: ChangeScope::AgentHome,
                original_hash: None,
                before: String::new(),
                after: "unmanaged".into(),
                risk: RiskLevel::Low,
                validator: "markdown".into(),
            }],
            requires_home_approval: true,
        };
        let error = crate::apply_changeset(
            &set,
            &root.join("backups"),
            &crate::ApplyOptions {
                approved_home_files: vec![target.clone()],
                home_approval: true,
                ..crate::ApplyOptions::default()
            },
        )
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("ChangeSet overlaps a Skill deployment")
        );
        assert!(!target.exists());
        let project_alias = project.join("legacy-alias");
        std::os::unix::fs::symlink(&record.target, &project_alias).unwrap();
        let mut manifest = manifest();
        manifest.skills.push(SkillDefinition {
            name: "legacy".into(),
            path: "legacy-alias".into(),
            targets: vec![AgentKind::ClaudeCode],
        });
        assert!(ensure_manifest_skill_ownership(&project, &manifest).is_err());
    }

    #[test]
    fn text_changesets_cannot_overwrite_managed_packages_or_reintroduce_manifest_claims() {
        let temp = tempfile::tempdir().unwrap();
        let root = platform_path::canonicalize(temp.path()).unwrap();
        let record = owned(&root);
        fs::create_dir_all(&record.target).unwrap();
        fs::write(record.target.join("SKILL.md"), "managed").unwrap();
        let change = FileChange {
            target: record.target.join("SKILL.md"),
            scope: ChangeScope::Project,
            original_hash: Some(crate::hash_content(b"managed")),
            before: "managed".into(),
            after: "legacy".into(),
            risk: RiskLevel::Low,
            validator: "markdown".into(),
        };
        let mut set = ChangeSet {
            id: uuid::Uuid::new_v4().to_string(),
            project_root: root.clone(),
            created_at: Utc::now(),
            changes: vec![change],
            requires_home_approval: false,
        };
        assert!(
            crate::apply_changeset(&set, &root.join("backup"), &crate::ApplyOptions::default())
                .is_err()
        );
        assert_eq!(
            fs::read_to_string(record.target.join("SKILL.md")).unwrap(),
            "managed"
        );
        let mut manifest = manifest();
        manifest.skills.push(SkillDefinition {
            name: "reviewer".into(),
            path: "source".into(),
            targets: Vec::new(),
        });
        set.changes[0].target = crate::manifest_path(&root);
        set.changes[0].original_hash = None;
        set.changes[0].after = serde_yaml::to_string(&manifest).unwrap();
        assert!(
            crate::apply_changeset(&set, &root.join("backup"), &crate::ApplyOptions::default())
                .is_err()
        );
        assert!(!crate::manifest_path(&root).exists());
    }

    #[test]
    fn pending_reservations_protect_legacy_sources_targets_and_the_reservation_file() {
        let temp = tempfile::tempdir().unwrap();
        let root = platform_path::canonicalize(temp.path()).unwrap();
        let record = owned(&root);
        let reservation = project_skill_reservation_path(&root);
        fs::rename(project_skill_record_path(&root), &reservation).unwrap();
        let original = fs::read(&reservation).unwrap();
        assert!(project_skill_deployments(&root).unwrap().is_empty());
        assert!(is_project_skill_owned(&root, &record.target).unwrap());
        let mut manifest = manifest();
        manifest.skills.push(SkillDefinition {
            name: "other-name".into(),
            path: ".agents/skills/reviewer".into(),
            targets: vec![AgentKind::ClaudeCode],
        });
        assert!(ensure_manifest_skill_ownership(&root, &manifest).is_err());
        manifest.skills[0].name = "reviewer".into();
        manifest.skills[0].path = "independent-source".into();
        manifest.skills[0].targets = vec![AgentKind::Codex];
        assert!(ensure_manifest_skill_ownership(&root, &manifest).is_err());
        // An earlier text preview must recheck reservation ownership at apply time,
        // including attempts to rewrite the reservation file itself.
        for target in [record.target.join("SKILL.md"), reservation.clone()] {
            let existing = fs::read(&target).ok();
            let set = ChangeSet {
                id: uuid::Uuid::new_v4().to_string(),
                project_root: root.clone(),
                created_at: Utc::now(),
                changes: vec![FileChange {
                    target,
                    scope: ChangeScope::Project,
                    original_hash: existing.as_deref().map(crate::hash_content),
                    before: existing
                        .map(|bytes| String::from_utf8(bytes).unwrap())
                        .unwrap_or_default(),
                    after: "legacy write".into(),
                    risk: RiskLevel::Low,
                    validator: "markdown".into(),
                }],
                requires_home_approval: false,
            };
            assert!(
                crate::apply_changeset(&set, &root.join("backup"), &crate::ApplyOptions::default())
                    .is_err()
            );
        }
        assert_eq!(fs::read(&reservation).unwrap(), original);
        assert!(!record.target.exists());
        assert!(!project_skill_record_path(&root).exists());
    }

    #[test]
    fn scope_lock_is_an_os_lock_and_readers_do_not_create_it() {
        let temp = tempfile::tempdir().unwrap();
        let root = platform_path::canonicalize(temp.path()).unwrap();
        assert!(project_skill_deployments(&root).unwrap().is_empty());
        assert!(!root.join(".agentkib").exists());
        let _process_guard = skill_write_lock().unwrap();
        let scope_guard = skill_scope_locks(std::slice::from_ref(&root)).unwrap();
        let second = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(root.join(".agentkib/skill-write.lock"))
            .unwrap();
        assert!(second.try_lock().is_err());
        drop(scope_guard);
        assert!(second.try_lock().is_ok());
    }

    #[test]
    fn nested_receipts_and_reservations_protect_parent_manifest_sources_and_delayed_changes() {
        for pending in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let parent = platform_path::canonicalize(temp.path()).unwrap();
            let child = parent.join("packages/app");
            fs::create_dir_all(child.join(".git")).unwrap();
            let target = child.join(".agents/skills/reviewer/SKILL.md");
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::write(&target, "managed").unwrap();
            let set = ChangeSet {
                id: uuid::Uuid::new_v4().to_string(),
                project_root: parent.clone(),
                created_at: Utc::now(),
                changes: vec![FileChange {
                    target: target.clone(),
                    scope: ChangeScope::Project,
                    original_hash: Some(crate::hash_content(b"managed")),
                    before: "managed".into(),
                    after: "legacy".into(),
                    risk: RiskLevel::Low,
                    validator: "markdown".into(),
                }],
                requires_home_approval: false,
            };
            ensure_changeset_skill_ownership(&set).unwrap();
            owned(&child);
            if pending {
                fs::rename(
                    project_skill_record_path(&child),
                    project_skill_reservation_path(&child),
                )
                .unwrap();
            }
            let mut manifest = manifest();
            manifest.skills.push(SkillDefinition {
                name: "copy".into(),
                path: "packages/app/.agents/skills/reviewer".into(),
                targets: vec![AgentKind::ClaudeCode],
            });
            assert!(ensure_manifest_skill_ownership(&parent, &manifest).is_err());
            manifest.skills.clear();
            manifest.instructions.scoped.push(crate::ScopedInstruction {
                path: "packages/app/.agents/skills/reviewer".into(),
                content: "legacy scoped instructions".into(),
            });
            assert!(ensure_manifest_skill_ownership(&parent, &manifest).is_err());
            assert!(is_project_skill_owned(&parent, &target).unwrap());
            assert!(!parent.join(".agentkib").exists());
            let scopes = changeset_skill_scope_roots(&set).unwrap();
            assert!(scopes.contains(&parent));
            assert!(scopes.contains(&child));
            assert!(
                crate::apply_changeset(
                    &set,
                    &parent.join("backups"),
                    &crate::ApplyOptions::default()
                )
                .is_err()
            );
            assert_eq!(fs::read_to_string(&target).unwrap(), "managed");
            assert!(!parent.join("backups").exists());
        }
    }

    #[test]
    fn child_project_cannot_claim_an_ancestor_deployment_or_ancestor_manifest_source() {
        let temp = tempfile::tempdir().unwrap();
        let parent = platform_path::canonicalize(temp.path()).unwrap();
        let child = parent.join("packages/app");
        fs::create_dir_all(&child).unwrap();
        let mut record = owned(&parent);
        record.target = child.join(".agents/skills/reviewer");
        fs::write(
            project_skill_record_path(&parent),
            encode_skill_deployment_records(&SkillDeploymentRecords {
                schema_version: 1,
                deployments: vec![record.clone()],
            })
            .unwrap(),
        )
        .unwrap();
        let mut child_manifest = manifest();
        child_manifest.skills.push(SkillDefinition {
            name: "reviewer".into(),
            path: "source".into(),
            targets: vec![AgentKind::Codex],
        });
        assert!(ensure_manifest_skill_ownership(&child, &child_manifest).is_err());
        assert!(is_project_skill_owned(&child, &record.target).unwrap());
        assert!(!child.join(".agentkib").exists());
        fs::remove_file(project_skill_record_path(&parent)).unwrap();
        let mut parent_manifest = manifest();
        parent_manifest.skills.push(SkillDefinition {
            name: "source".into(),
            path: "packages/app/.agents/skills/reviewer".into(),
            targets: vec![AgentKind::ClaudeCode],
        });
        fs::write(
            crate::manifest_path(&parent),
            serde_yaml::to_string(&parent_manifest).unwrap(),
        )
        .unwrap();
        assert!(ensure_skill_target_not_manifest_owned(&child, &record.target).is_err());
        parent_manifest.skills.clear();
        parent_manifest
            .instructions
            .scoped
            .push(crate::ScopedInstruction {
                path: "packages/app/.agents/skills/reviewer".into(),
                content: "legacy scoped instructions".into(),
            });
        fs::write(
            crate::manifest_path(&parent),
            serde_yaml::to_string(&parent_manifest).unwrap(),
        )
        .unwrap();
        assert!(ensure_skill_target_not_manifest_owned(&child, &record.target).is_err());
    }

    #[test]
    fn ownership_scope_queries_ignore_unrelated_trees_and_personal_home_receipts() {
        let temp = tempfile::tempdir().unwrap();
        let home = platform_path::canonicalize(temp.path()).unwrap();
        let child = home.join("project");
        fs::create_dir_all(child.join(".git")).unwrap();
        let mut personal = owned(&home);
        personal.scope = SkillScope::Personal;
        personal.workspace_id = None;
        fs::write(
            project_skill_record_path(&home),
            encode_skill_deployment_records(&SkillDeploymentRecords {
                schema_version: 1,
                deployments: vec![personal],
            })
            .unwrap(),
        )
        .unwrap();
        fs::write(
            project_skill_reservation_path(&home),
            encode_skill_deployment_records(&SkillDeploymentRecords {
                schema_version: 1,
                deployments: vec![],
            })
            .unwrap(),
        )
        .unwrap();
        let unrelated = home.join("unrelated/.agentkib");
        fs::create_dir_all(&unrelated).unwrap();
        fs::write(
            unrelated.join("skill-deployments.json"),
            "broken unrelated receipt",
        )
        .unwrap();
        assert_eq!(
            skill_ownership_scope_roots(&child, &[child.join(".agents/skills/reviewer")]).unwrap(),
            vec![child.clone()]
        );
        assert!(!child.join(".agentkib").exists());
    }

    #[test]
    fn deployment_library_identity_accepts_offline_roots_but_rejects_unsafe_paths() {
        let temp = tempfile::tempdir().unwrap();
        let project = platform_path::canonicalize(temp.path()).unwrap();
        let mut record = owned(&project);
        for library in [None, Some(project.join("offline-library"))] {
            record.library_root = library;
            encode_skill_deployment_records(&SkillDeploymentRecords {
                schema_version: 1,
                deployments: vec![record.clone()],
            })
            .unwrap();
        }
        for library in [
            PathBuf::from("relative-library"),
            project.join("source/../other"),
        ] {
            record.library_root = Some(library);
            let records = SkillDeploymentRecords {
                schema_version: 1,
                deployments: vec![record.clone()],
            };
            assert!(encode_skill_deployment_records(&records).is_err());
            fs::write(
                project_skill_record_path(&project),
                serde_json::to_vec(&records).unwrap(),
            )
            .unwrap();
            assert!(project_skill_deployments(&project).is_err());
        }
        assert!(!project.join("offline-library").exists());
    }
}
