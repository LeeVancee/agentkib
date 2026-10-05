//! Copy-based native Skill deployments. Package bytes never cross the RPC boundary.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use agentkib_core::{
    PrepareSkillDeploymentRequest, SkillDeployment, SkillDeploymentOperation,
    SkillDeploymentPreview, SkillDeploymentRecords, SkillDeploymentReport, SkillDeploymentResult,
    SkillDeploymentTargetPreview, SkillPreviewFile, SkillScope, SkillTargetCapability,
    SkillWorkspace, encode_skill_deployment_records, ensure_skill_target_not_manifest_owned,
    personal_skill_record_path, personal_skill_reservation_path, personal_skill_reservations,
    project_skill_record_path, project_skill_reservation_path, project_skill_reservations,
    read_skill_deployment_records, register_project_skill_library, skill_scope_locks,
    skill_write_lock,
};
use agentkib_platform::{
    fs::{ExpectedFile, atomic_write, atomic_write_checked, move_path},
    path as platform_path,
};
use anyhow::{Context, Result, bail, ensure};
use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use tempfile::TempDir;
use uuid::Uuid;

use crate::package_io::{copy_package, ensure_importable, preview_file};
use crate::{file_delta, library_skill_metadata, package_hash, validate_library_id};

const MAX_PREVIEWS: usize = 4;
const MAX_JOURNAL_BYTES: u64 = 8 * 1024 * 1024;
type SelectedTarget = (
    SkillTargetCapability,
    Vec<String>,
    Vec<agentkib_core::AgentKind>,
);
type ScopeLockResult = (
    Vec<agentkib_core::SkillScopeLocks>,
    BTreeMap<String, String>,
);

pub struct DeploymentManager {
    library_root: PathBuf,
    previews: Mutex<HashMap<String, PreparedDeployment>>,
}

struct PreparedDeployment {
    preview: SkillDeploymentPreview,
    targets: Vec<PreparedTarget>,
    _temp: TempDir,
}

struct PreparedTarget {
    capability_ids: Vec<String>,
    capability: SkillTargetCapability,
    associated_projects: Vec<PathBuf>,
    before_record: Option<SkillDeployment>,
    after_record: SkillDeployment,
    before: Option<PathBuf>,
    after: Option<PathBuf>,
    source: Option<PathBuf>,
    uses_library_source: bool,
    source_hash: Option<String>,
    before_hash: Option<String>,
    after_hash: Option<String>,
    previous_backup_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct OperationJournal {
    schema_version: u32,
    operation_id: String,
    // Records the reviewed plan; recovery derives approval from unfinished targets only.
    requires_home_approval: bool,
    targets: Vec<TargetJournal>,
    report: Option<SkillDeploymentReport>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TargetJournal {
    target_id: String,
    capability_ids: Vec<String>,
    capability: SkillTargetCapability,
    #[serde(default)]
    associated_projects: Vec<PathBuf>,
    before_record: Option<SkillDeployment>,
    after_record: SkillDeployment,
    before_hash: Option<String>,
    after_hash: Option<String>,
    previous_backup_hash: Option<String>,
    phase: String,
    result: Option<SkillDeploymentResult>,
}

struct OperationPaths {
    operation: PathBuf,
    incoming: PathBuf,
    before: PathBuf,
    prior_backup: PathBuf,
    backup: PathBuf,
}

impl DeploymentManager {
    pub fn new(library_root: PathBuf) -> Self {
        Self {
            library_root,
            previews: Mutex::new(HashMap::new()),
        }
    }

    pub fn list(&self, workspaces: &[SkillWorkspace]) -> Result<Vec<SkillDeployment>> {
        let mut records = self.records(workspaces)?;
        let journals = self.journals()?;
        // Completed journals also index workspaces that have since been removed from discovery.
        // They only authorize a read-only diagnostic; execution still needs a current capability.
        let mut historical = BTreeMap::<String, SkillDeployment>::new();
        for journal in &journals {
            for target in &journal.targets {
                if target.result.as_ref().is_some_and(|result| result.success) {
                    let record = &target.after_record;
                    let identity = platform_path::lexical_identity(&record.target);
                    if historical
                        .get(&identity)
                        .is_none_or(|old| old.updated_at < record.updated_at)
                    {
                        historical.insert(identity, record.clone());
                    }
                }
            }
        }
        for mut record in historical.into_values() {
            if !records.iter().any(|current| {
                same_record_target(&current.target, &record.target)
                    && same_deployment_identity(current, &record)
            }) {
                if record.scope == SkillScope::Workspace {
                    // Another library can update the shared project receipt. A journal only
                    // locates that receipt; its old successful result is not current ownership.
                    let current = agentkib_core::project_skill_deployments(&record.scope_root)?;
                    let reservations = project_skill_reservations(&record.scope_root)?;
                    if let Some(reservation) = reservations
                        .into_iter()
                        .find(|current| same_record_target(&current.target, &record.target))
                    {
                        record.status = "unverified".into();
                        record.diagnostics.push(format!(
                            "The deployment location is reserved by operation {}; ownership cannot be verified",
                            reservation.operation_id
                        ));
                    } else if let Some(current) = current.into_iter().find(|current| {
                        same_record_target(&current.target, &record.target)
                            && same_deployment_identity(current, &record)
                    }) {
                        record = current;
                    } else {
                        record.status = "unverified".into();
                        record.diagnostics.push(
                            "The current project deployment receipt is missing or has a different identity; ownership cannot be verified".into(),
                        );
                    }
                }
                if !matches!(record.status.as_str(), "inactive" | "unverified") {
                    record.status = "unregistered-workspace".into();
                    record.diagnostics.push(
                        "Deployment remains recorded outside the current workspace inventory"
                            .into(),
                    );
                }
                records.push(record);
            }
        }
        for record in &mut records {
            if !matches!(
                record.status.as_str(),
                "inactive" | "unregistered-workspace" | "unverified"
            ) {
                record.status = match directory_hash(&record.target) {
                    Ok(Some(hash)) if hash == record.package_hash => "current",
                    Ok(None) => "missing",
                    _ => "modified",
                }
                .into();
            }
        }
        let mut pending = BTreeMap::<String, (String, TargetJournal)>::new();
        for journal in journals {
            for target in journal.targets {
                if target_needs_recovery(&target) {
                    let identity = platform_path::lexical_identity(&target.after_record.target);
                    if pending.get(&identity).is_none_or(|(_, previous)| {
                        previous.after_record.updated_at < target.after_record.updated_at
                    }) {
                        pending.insert(identity, (journal.operation_id.clone(), target));
                    }
                }
            }
        }
        for (operation_id, target) in pending.into_values() {
            if let Some(record) = records.iter_mut().find(|value| {
                same_record_target(&value.target, &target.after_record.target)
                    && same_deployment_identity(value, &target.after_record)
            }) {
                record.status = "recovery-required".into();
                record.operation_id = operation_id.clone();
                record
                    .diagnostics
                    .push(format!("Interrupted deployment operation: {operation_id}"));
            } else {
                let mut record = target.after_record;
                record.status = "recovery-required".into();
                record.operation_id = operation_id.clone();
                record
                    .diagnostics
                    .push(format!("Interrupted deployment operation: {operation_id}"));
                records.push(record);
            }
        }
        for record in &mut records {
            if record.scope == SkillScope::Workspace
                && platform_path::starts_with(&record.target, &record.scope_root)
                && let Some(workspace) = workspaces.iter().find(|workspace| {
                    platform_path::equivalent(&workspace.path, &record.scope_root)
                })
            {
                // Registration IDs can change while the physical project and its receipt stay
                // intact. Resolve navigation here without migrating the durable ownership record.
                record.workspace_id = Some(workspace.id.clone());
            }
        }
        records.sort_by(|left, right| left.target.cmp(&right.target));
        Ok(records)
    }

    pub fn has_active_deployments(
        &self,
        library_id: &str,
        workspaces: &[SkillWorkspace],
    ) -> Result<bool> {
        if self.list(workspaces)?.iter().any(|record| {
            self.belongs_to_library(record, library_id) && record.status != "inactive"
        }) {
            return Ok(true);
        }
        if personal_skill_reservations(&self.library_root)?
            .iter()
            .any(|record| self.belongs_to_library(record, library_id))
        {
            return Ok(true);
        }
        let mut projects = self.recorded_workspace_scopes(library_id)?;
        projects.extend(workspaces.iter().map(|workspace| workspace.path.clone()));
        projects.sort_by_key(|path| platform_path::identity(path));
        projects.dedup_by(|left, right| platform_path::equivalent(left, right));
        for project in projects {
            if project_skill_reservations(&project)?
                .iter()
                .any(|record| self.belongs_to_library(record, library_id))
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn belongs_to_library(&self, record: &SkillDeployment, library_id: &str) -> bool {
        record.library_id == library_id
            // Legacy ownership is ambiguous, so keep removal protection until it is withdrawn.
            && record.library_root.as_ref().is_none_or(|root| {
                platform_path::equivalent(root, &self.library_root)
            })
    }

    fn ensure_current_source_library(&self, record: &SkillDeployment) -> Result<()> {
        let root = record
            .library_root
            .as_ref()
            .context("Deployment has no verified source library; its source cannot be replaced")?;
        ensure!(
            platform_path::equivalent(root, &self.library_root),
            "Deployment belongs to another source library; update it from its original library"
        );
        Ok(())
    }

    fn recorded_workspace_scopes(&self, library_id: &str) -> Result<Vec<PathBuf>> {
        let mut scopes = BTreeMap::new();
        for journal in self.journals()? {
            for target in journal.targets {
                let record = &target.after_record;
                if self.belongs_to_library(record, library_id)
                    && record.scope == SkillScope::Workspace
                    && (target.result.as_ref().is_some_and(|result| result.success)
                        || target_needs_recovery(&target))
                {
                    scopes.insert(
                        platform_path::identity(&record.scope_root),
                        record.scope_root.clone(),
                    );
                }
            }
        }
        Ok(scopes.into_values().collect())
    }

    /// The caller holds the process write lock. Acquire project and library locks together
    /// in the same order as deployment writers, then reject a changed scope set before removal.
    pub(crate) fn library_removal_locks(
        &self,
        library_id: &str,
    ) -> Result<agentkib_core::SkillScopeLocks> {
        let projects = self.recorded_workspace_scopes(library_id)?;
        for project in &projects {
            ensure!(
                project.is_dir(),
                "A Skill deployment project is unavailable; ownership cannot be verified"
            );
        }
        let mut scopes = projects;
        scopes.push(self.library_root.clone());
        let locked: BTreeSet<_> = scopes
            .iter()
            .map(|scope| platform_path::identity(scope))
            .collect();
        let guard = skill_scope_locks(&scopes)?;
        ensure!(
            self.recorded_workspace_scopes(library_id)?
                .iter()
                .all(|scope| locked.contains(&platform_path::identity(scope))),
            "Skill deployment ownership scopes changed while acquiring locks; retry removal"
        );
        Ok(guard)
    }

    pub fn prepare(
        &self,
        request: PrepareSkillDeploymentRequest,
        targets: &[SkillTargetCapability],
        workspaces: &[SkillWorkspace],
    ) -> Result<SkillDeploymentPreview> {
        match request.operation {
            SkillDeploymentOperation::Deploy => ensure!(
                request.library_id.is_some()
                    && request.deployment_id.is_none()
                    && !request.target_ids.is_empty(),
                "Deploy requires a library ID and target IDs only"
            ),
            _ => ensure!(
                request.deployment_id.is_some()
                    && request.library_id.is_none()
                    && request.target_ids.is_empty(),
                "Deployment lifecycle operations require a deployment ID only"
            ),
        }
        let _guard = skill_write_lock()?;
        let records = self.records(workspaces)?;
        let selected_record = request
            .deployment_id
            .as_deref()
            .map(|id| {
                records
                    .iter()
                    .find(|record| record.id == id)
                    .cloned()
                    .context("Skill deployment does not exist")
            })
            .transpose()?;
        if matches!(
            request.operation,
            SkillDeploymentOperation::Undeploy
                | SkillDeploymentOperation::Rollback
                | SkillDeploymentOperation::Update
        ) {
            ensure!(
                selected_record.is_some(),
                "This operation requires a deployment ID"
            );
        }
        let library_id = request
            .library_id
            .clone()
            .or_else(|| {
                selected_record
                    .as_ref()
                    .map(|record| record.library_id.clone())
            })
            .context("A library Skill is required")?;
        validate_library_id(&library_id)?;
        if let Some(record) = &selected_record {
            ensure!(
                record.library_id == library_id,
                "Deployment source cannot be changed"
            );
            if request.operation == SkillDeploymentOperation::Update {
                self.ensure_current_source_library(record)?;
            }
        }
        let source = if matches!(
            request.operation,
            SkillDeploymentOperation::Deploy | SkillDeploymentOperation::Update
        ) {
            let path = self.library_root.join("skills").join(&library_id);
            ensure_safe_directory(&self.library_root, &path)?;
            ensure_regular_package(&path)?;
            ensure_importable(&path)?;
            Some(path)
        } else {
            None
        };
        let package_name = if source.is_some() {
            library_skill_metadata(&self.library_root, &library_id)?.name
        } else {
            selected_record
                .as_ref()
                .context("Deployment is required")?
                .package_name
                .clone()
        };
        if let Some(record) = &selected_record {
            ensure!(
                record.package_name == package_name,
                "Skill package name changed; deployment cannot be updated"
            );
        }
        let groups = select_targets(&request, selected_record.as_ref(), targets)?;
        ensure!(
            !groups.is_empty(),
            "Select at least one Skill deployment target"
        );
        ensure!(groups.len() <= 64, "Too many Skill deployment targets");
        let staging = self.library_root.join(".staging");
        ensure_safe_directory(&self.library_root, &staging)?;
        fs::create_dir_all(&staging)?;
        let temp = tempfile::Builder::new()
            .prefix("deployment-")
            .tempdir_in(&staging)?;
        let token = Uuid::new_v4().to_string();
        let mut prepared_targets = Vec::new();
        let mut previews = Vec::new();
        for (index, (capability, ids, mut agents)) in groups.into_iter().enumerate() {
            let target = capability.root.join(&package_name);
            let existing = records
                .iter()
                .find(|record| same_record_target(&record.target, &target))
                .cloned();
            let replacing_inactive = existing.as_ref().is_some_and(|record| {
                record.status == "inactive"
                    && record.library_id != library_id
                    && self.ensure_current_source_library(record).is_ok()
            }) && request.operation == SkillDeploymentOperation::Deploy;
            if let Some(record) = &existing
                && !replacing_inactive
            {
                for agent in &record.agents {
                    if !agents.contains(agent) {
                        agents.push(*agent);
                    }
                }
                agents.sort();
            }
            if let Some(selected) = &selected_record {
                ensure!(
                    existing
                        .as_ref()
                        .is_some_and(|record| record.id == selected.id),
                    "Deployment target changed"
                );
            }
            let mut conflicts = Vec::new();
            if let Err(error) = validate_capability(&capability, workspaces) {
                conflicts.push(error.to_string());
            }
            if let Err(error) = ensure_target_safe(&capability, &target) {
                conflicts.push(error.to_string());
            }
            let associated_projects =
                match associated_project_roots(&capability, &target, workspaces, &[]) {
                    Ok(roots) => roots,
                    Err(error) => {
                        conflicts.push(error.to_string());
                        Vec::new()
                    }
                };
            if let Err(error) = ensure_no_manifest_claim(&capability, &target, &associated_projects)
            {
                conflicts.push(error.to_string());
            }
            if let Err(error) = ensure_associated_ownership(
                &self.library_root,
                &capability,
                &target,
                &associated_projects,
                existing.as_ref(),
                None,
            ) {
                conflicts.push(error.to_string());
            }
            let before_hash = match directory_hash(&target) {
                Ok(value) => value,
                Err(error) => {
                    conflicts.push(error.to_string());
                    None
                }
            };
            match &existing {
                Some(record) => {
                    if source.is_some()
                        && let Err(error) = self.ensure_current_source_library(record)
                    {
                        conflicts.push(error.to_string());
                    }
                    if record.library_id != library_id && !replacing_inactive {
                        conflicts.push("Target is owned by another library Skill".into());
                    }
                    if record.status == "inactive" {
                        if before_hash.is_some() {
                            conflicts.push(
                                "An external package appeared at the inactive deployment target"
                                    .into(),
                            );
                        }
                    } else if before_hash.as_deref() != Some(&record.package_hash) {
                        conflicts.push(
                            "Deployed Skill is missing or was modified outside AgentKib".into(),
                        );
                    }
                }
                None if before_hash.is_some() => conflicts.push(
                    "Target is an external Skill; existing installations are not taken over".into(),
                ),
                None => {}
            }
            if self.pending_target(&target)? {
                conflicts
                    .push("Target has an interrupted deployment that requires recovery".into());
            }
            if capability.scope == SkillScope::Workspace
                && project_skill_reservations(&capability.scope_root)?
                    .iter()
                    .any(|record| recorded_targets_overlap(&record.target, &target))
            {
                conflicts.push("Target is reserved by an unfinished Skill deployment".into());
            }
            let deployment_id = existing
                .as_ref()
                .filter(|_| !replacing_inactive)
                .map(|record| record.id.clone())
                .unwrap_or_else(|| Uuid::new_v4().to_string());
            let backup =
                operation_paths(&capability, &deployment_id, &token).map(|paths| paths.backup);
            let previous_backup_hash = match backup
                .as_ref()
                .map_err(|error| anyhow::anyhow!(error.to_string()))
                .and_then(|path| directory_hash(path))
            {
                Ok(hash) => hash,
                Err(error) => {
                    conflicts.push(error.to_string());
                    None
                }
            };
            if let Some(expected) = existing
                .as_ref()
                .filter(|_| !replacing_inactive)
                .and_then(|record| record.previous_hash.as_ref())
            {
                if previous_backup_hash.as_ref() != Some(expected) {
                    conflicts.push("Deployment rollback package is missing or was modified".into());
                }
            } else if previous_backup_hash.is_some() {
                conflicts.push("An unowned package exists at the deployment backup path".into());
            }
            let mut actual_source = source.clone();
            if request.operation == SkillDeploymentOperation::Rollback {
                let record = existing.as_ref().context("Deployment is required")?;
                match (&backup, &previous_backup_hash) {
                    (Ok(backup), Some(hash)) if record.previous_hash.as_deref() == Some(hash) => {
                        actual_source = Some(backup.clone())
                    }
                    _ => conflicts.push("No intact rollback version is available".into()),
                }
            }
            let snapshot = temp.path().join(index.to_string());
            let before = before_hash.as_ref().map(|_| snapshot.join("before"));
            let after = actual_source.as_ref().map(|_| snapshot.join("after"));
            let source_hash = match actual_source
                .as_ref()
                .map(|path| package_hash(path).map(|value| value.0))
                .transpose()
            {
                Ok(hash) => hash,
                Err(error) => {
                    conflicts.push(error.to_string());
                    None
                }
            };
            let delta = if conflicts.is_empty() {
                (|| -> Result<_> {
                    if let Some(before) = &before {
                        copy_package(&target, before)?;
                    }
                    if let (Some(source), Some(after)) = (&actual_source, &after) {
                        copy_package(source, after)?;
                        ensure!(
                            package_hash(after)?.0 == *source_hash.as_ref().unwrap(),
                            "Skill source changed while preparing deployment"
                        );
                    }
                    if let Some(before) = &before {
                        ensure!(
                            package_hash(before)?.0 == *before_hash.as_ref().unwrap(),
                            "Deployment target changed while preparing preview"
                        );
                    }
                    file_delta(
                        before.as_deref().unwrap_or(&snapshot.join("absent-before")),
                        after.as_deref().unwrap_or(&snapshot.join("absent-after")),
                    )
                })()
            } else {
                Ok((Vec::new(), Vec::new(), Vec::new()))
            };
            let (added, modified, removed) = match delta {
                Ok(delta) => delta,
                Err(error) => {
                    conflicts.push(error.to_string());
                    (Vec::new(), Vec::new(), Vec::new())
                }
            };
            let after_hash = source_hash.clone();
            let active = request.operation != SkillDeploymentOperation::Undeploy;
            let after_record = SkillDeployment {
                id: deployment_id,
                library_id: library_id.clone(),
                library_root: match existing.as_ref().filter(|_| !replacing_inactive) {
                    Some(record) => record.library_root.clone(),
                    None => Some(platform_path::canonicalize(&self.library_root)?),
                },
                package_name: package_name.clone(),
                package_hash: after_hash
                    .clone()
                    .or_else(|| before_hash.clone())
                    .unwrap_or_default(),
                scope: capability.scope,
                workspace_id: capability.workspace_id.clone(),
                scope_root: capability.scope_root.clone(),
                target: target.clone(),
                agents: agents.clone(),
                visible_to: capability.visible_to.clone(),
                status: if active { "active" } else { "inactive" }.into(),
                diagnostics: Vec::new(),
                previous_hash: before_hash.clone().or_else(|| {
                    existing
                        .as_ref()
                        .filter(|_| !replacing_inactive)
                        .and_then(|record| record.previous_hash.clone())
                }),
                operation_id: token.clone(),
                updated_at: Utc::now(),
            };
            previews.push(SkillDeploymentTargetPreview {
                target_id: capability.id.clone(),
                deployment_id: existing.as_ref().map(|record| record.id.clone()),
                path: target,
                scope: capability.scope,
                workspace_id: capability.workspace_id.clone(),
                agents,
                visible_to: capability.visible_to.clone(),
                added,
                modified,
                removed,
                conflicts,
                conditions: capability.conditions.clone(),
            });
            prepared_targets.push(PreparedTarget {
                capability_ids: ids,
                capability,
                associated_projects,
                before_record: existing,
                after_record,
                before,
                after,
                source: actual_source,
                uses_library_source: source.is_some(),
                source_hash,
                before_hash,
                after_hash,
                previous_backup_hash,
            });
        }
        let preview = SkillDeploymentPreview {
            token: token.clone(),
            operation: request.operation,
            library_id: Some(library_id),
            expires_at: Utc::now() + Duration::minutes(15),
            requires_home_approval: previews
                .iter()
                .any(|target| target.scope == SkillScope::Personal && target.conflicts.is_empty()),
            targets: previews,
        };
        let mut stored = self
            .previews
            .lock()
            .map_err(|_| anyhow::anyhow!("Skill deployment previews are unavailable"))?;
        stored.retain(|_, value| value.preview.expires_at > Utc::now());
        while stored.len() >= MAX_PREVIEWS {
            if let Some(oldest) = stored
                .iter()
                .min_by_key(|(_, value)| value.preview.expires_at)
                .map(|(key, _)| key.clone())
            {
                stored.remove(&oldest);
            }
        }
        stored.insert(
            token,
            PreparedDeployment {
                preview: preview.clone(),
                targets: prepared_targets,
                _temp: temp,
            },
        );
        Ok(preview)
    }

    pub fn read_preview_file(
        &self,
        token: &str,
        target_id: &str,
        path: &str,
    ) -> Result<SkillPreviewFile> {
        let previews = self
            .previews
            .lock()
            .map_err(|_| anyhow::anyhow!("Skill deployment previews are unavailable"))?;
        let preview = previews
            .get(token)
            .context("Skill deployment preview expired or does not exist")?;
        ensure!(
            preview.preview.expires_at > Utc::now(),
            "Skill deployment preview expired"
        );
        let target = preview
            .targets
            .iter()
            .find(|target| target.capability.id == target_id)
            .context("Preview target does not exist")?;
        preview_file(target.before.as_deref(), target.after.as_deref(), path)
    }

    pub fn apply(
        &self,
        token: &str,
        confirmed: bool,
        approve_home: bool,
        targets: &[SkillTargetCapability],
        workspaces: &[SkillWorkspace],
    ) -> Result<SkillDeploymentReport> {
        ensure!(confirmed, "Skill deployment requires explicit confirmation");
        validate_operation_id(token)?;
        let _guard = skill_write_lock()?;
        if let Some(journal) = self.load_journal(token)? {
            ensure!(
                !recovery_requires_home_approval(&journal) || approve_home,
                "Personal Skill deployment requires Agent Home approval"
            );
            if let Some(report) = journal.report.clone()
                && !journal.targets.iter().any(target_needs_recovery)
            {
                return Ok(report);
            }
            let scopes =
                self.authorized_scopes(&journal.targets, targets, workspaces, approve_home)?;
            let locked_scopes = scopes
                .iter()
                .map(|scope| platform_path::identity(scope))
                .collect();
            let (_scope_guard, scope_errors) = self.lock_scopes(scopes)?;
            return self.resume_journal_locked(
                &journal,
                targets,
                workspaces,
                &scope_errors,
                &locked_scopes,
                approve_home,
            );
        }
        let prepared = {
            let mut previews = self
                .previews
                .lock()
                .map_err(|_| anyhow::anyhow!("Skill deployment previews are unavailable"))?;
            let prepared = previews
                .get(token)
                .context("Skill deployment preview expired or does not exist")?;
            ensure!(
                prepared.preview.expires_at > Utc::now(),
                "Skill deployment preview expired"
            );
            ensure!(
                !prepared.preview.requires_home_approval || approve_home,
                "Personal Skill deployment requires Agent Home approval"
            );
            previews.remove(token).unwrap()
        };
        let mut scopes = vec![self.library_root.clone()];
        for (target, preview) in prepared.targets.iter().zip(&prepared.preview.targets) {
            if !preview.conflicts.is_empty() {
                continue;
            }
            if let Some(current) =
                current_frozen_capability(&target.capability, &target.capability.id, targets)
                && validate_capability(current, workspaces).is_ok()
                && ensure_target_safe(current, &target.after_record.target).is_ok()
            {
                scopes.push(current.scope_root.clone());
                if let Ok(projects) = associated_project_roots(
                    current,
                    &target.after_record.target,
                    workspaces,
                    &target.associated_projects,
                ) {
                    scopes.extend(projects);
                }
                if let Ok(personal) = agentkib_core::personal_skill_scope_roots(
                    std::slice::from_ref(&target.after_record.target),
                ) {
                    scopes.extend(personal);
                }
            }
        }
        let locked_scopes: BTreeSet<_> = scopes
            .iter()
            .map(|scope| platform_path::identity(scope))
            .collect();
        let (_scope_guard, scope_errors) = self.lock_scopes(scopes)?;
        let mut journal = OperationJournal {
            schema_version: 1,
            operation_id: token.into(),
            requires_home_approval: prepared.preview.requires_home_approval,
            targets: Vec::new(),
            report: None,
        };
        for (target, preview) in prepared.targets.iter().zip(&prepared.preview.targets) {
            let mut conflicts = preview.conflicts.clone();
            if let Some(error) =
                scope_errors.get(&platform_path::identity(&target.capability.scope_root))
            {
                conflicts.push(error.clone());
            }
            let associated_projects = if conflicts.is_empty() {
                match associated_project_roots(
                    &target.capability,
                    &target.after_record.target,
                    workspaces,
                    &target.associated_projects,
                ) {
                    Ok(roots) => roots,
                    Err(error) => {
                        conflicts.push(error.to_string());
                        target.associated_projects.clone()
                    }
                }
            } else {
                target.associated_projects.clone()
            };
            let mut journal_target = TargetJournal {
                target_id: target.capability.id.clone(),
                capability_ids: target.capability_ids.clone(),
                capability: target.capability.clone(),
                associated_projects,
                before_record: target.before_record.clone(),
                after_record: target.after_record.clone(),
                before_hash: target.before_hash.clone(),
                after_hash: target.after_hash.clone(),
                previous_backup_hash: target.previous_backup_hash.clone(),
                phase: "planned".into(),
                result: None,
            };
            let personal_scopes = match agentkib_core::personal_skill_scope_roots(
                std::slice::from_ref(&target.after_record.target),
            ) {
                Ok(roots) => roots,
                Err(error) => {
                    conflicts.push(error.to_string());
                    Vec::new()
                }
            };
            for project in journal_target
                .associated_projects
                .iter()
                .chain(&personal_scopes)
            {
                if !locked_scopes.contains(&platform_path::identity(project)) {
                    conflicts.push("Deployment project ownership scopes changed while acquiring locks; prepare it again".into());
                }
                if let Some(error) = scope_errors.get(&platform_path::identity(project)) {
                    conflicts.push(error.clone());
                }
            }
            if conflicts.is_empty()
                && let Err(error) = rebind_workspace_target(
                    &mut journal_target,
                    targets,
                    workspaces,
                    &self.library_root,
                )
            {
                conflicts.push(error.to_string());
            }
            // A different process may have started and interrupted an operation since preview.
            // Check under the scope locks, before our own journal can appear as pending.
            if conflicts.is_empty() && self.pending_target(&target.after_record.target)? {
                conflicts
                    .push("Target has an interrupted deployment that requires recovery".into());
            }
            if !conflicts.is_empty() {
                journal_target.result = Some(result_for(
                    &journal_target.target_id,
                    &journal_target.after_record,
                    false,
                    "conflict",
                    Some(conflicts.join("; ")),
                ));
            }
            journal.targets.push(journal_target);
        }
        self.save_journal(&journal)?;
        let mut warnings = Vec::new();
        for (index, prepared_target) in prepared.targets.iter().enumerate() {
            if journal.targets[index].result.is_some() {
                continue;
            }
            let outcome =
                self.apply_target(&mut journal, index, prepared_target, targets, workspaces);
            if outcome.is_ok()
                && let Some(error) = journal.targets[index]
                    .result
                    .as_ref()
                    .and_then(|result| result.error.as_ref())
            {
                warnings.push(error.clone());
            }
            if let Err(error) = outcome {
                let started = journal.targets[index].phase != "planned";
                let recovery = if !started {
                    Ok(())
                } else {
                    self.recover_target(
                        &journal.operation_id,
                        &journal.targets[index],
                        targets,
                        workspaces,
                    )
                };
                let (status, detail) = match recovery {
                    Ok(()) => ("failed", error.to_string()),
                    Err(recovery_error) => (
                        "recovery-required",
                        format!("{error}; recovery: {recovery_error}"),
                    ),
                };
                let target = &mut journal.targets[index];
                if status != "recovery-required" {
                    target.phase = status.into();
                }
                target.result = Some(result_for(
                    &target.target_id,
                    &target.after_record,
                    false,
                    status,
                    Some(detail),
                ));
                if status == "failed" && started {
                    if let Err(error) = self.finish_target_reservation(&mut journal, index) {
                        warnings.push(format!("Deployment was rolled back, but reservation cleanup is pending; retry this operation: {error}"));
                    }
                } else if let Err(error) = self.save_journal(&journal) {
                    warnings.push(format!("Could not persist a deployment result: {error}"));
                }
            }
        }
        let mut report = journal_report(&journal);
        report.warnings = warnings;
        journal.report = Some(report.clone());
        if let Err(error) = self.save_journal(&journal) {
            report.warnings.push(format!("Deployment results could not be persisted; native file outcomes are shown above: {error}"));
        }
        Ok(report)
    }

    fn apply_target(
        &self,
        journal: &mut OperationJournal,
        index: usize,
        prepared: &PreparedTarget,
        targets: &[SkillTargetCapability],
        workspaces: &[SkillWorkspace],
    ) -> Result<()> {
        let target = journal.targets[index].clone();
        if prepared.uses_library_source {
            self.ensure_current_source_library(&target.after_record)?;
        }
        validate_frozen_target(&target, targets, workspaces, &self.library_root)?;
        self.ensure_receipt_matches(&target)?;
        ensure!(
            directory_hash(&target.after_record.target)? == target.before_hash,
            "Deployment target changed after preview"
        );
        if let Some(source) = &prepared.source {
            ensure!(
                directory_hash(source)? == prepared.source_hash,
                "Library Skill or rollback package changed after preview"
            );
        }
        if let Some(after) = &prepared.after {
            ensure!(
                directory_hash(after)? == target.after_hash,
                "Prepared Skill package changed after preview"
            );
        }
        // Reserve ownership in the project before native files can become visible. The legacy
        // planner does not have access to this library's operation journal after a process crash.
        self.reserve_target(&target)?;
        journal.targets[index].phase = "reserved".into();
        self.save_journal(journal)?;
        let paths = operation_paths(
            &target.capability,
            &target.after_record.id,
            &journal.operation_id,
        )?;
        ensure_safe_directory(&target.capability.scope_root, &paths.operation)?;
        ensure_safe_directory(&target.capability.scope_root, &paths.backup)?;
        fs::create_dir_all(&target.capability.root)?;
        fs::create_dir_all(&paths.operation)?;
        ensure_same_filesystem(&target.capability.root, &paths.operation)?;
        if let Some(after) = &prepared.after {
            ensure!(
                !paths.incoming.exists(),
                "Deployment staging directory already exists"
            );
            copy_package(after, &paths.incoming)?;
            ensure!(
                directory_hash(&paths.incoming)? == target.after_hash,
                "Staged Skill package is inconsistent"
            );
        }
        journal.targets[index].phase = "staged".into();
        self.save_journal(journal)?;
        // Recheck after staging because copying may be slow and users can edit native files.
        validate_frozen_target(&target, targets, workspaces, &self.library_root)?;
        self.ensure_receipt_matches(&target)?;
        ensure!(
            directory_hash(&target.after_record.target)? == target.before_hash,
            "Deployment target changed while staging"
        );
        ensure!(
            directory_hash(&paths.backup)? == target.previous_backup_hash,
            "Deployment rollback package changed after preview"
        );
        fs::create_dir_all(&target.capability.root)?;
        if target.before_hash.is_some() {
            move_path(&target.after_record.target, &paths.before)?;
            ensure!(
                directory_hash(&paths.before)? == target.before_hash,
                "Deployment target changed during activation"
            );
        }
        journal.targets[index].phase = "backed-up".into();
        self.save_journal(journal)?;
        if target.after_hash.is_some() {
            move_path(&paths.incoming, &target.after_record.target)?;
        }
        journal.targets[index].phase = "activated".into();
        self.save_journal(journal)?;
        if target.before_hash.is_some() {
            if target.previous_backup_hash.is_some() {
                move_path(&paths.backup, &paths.prior_backup)?;
            }
            fs::create_dir_all(paths.backup.parent().context("Backup has no parent")?)?;
            move_path(&paths.before, &paths.backup)?;
        }
        journal.targets[index].phase = "backup-rotated".into();
        self.save_journal(journal)?;
        ensure!(
            directory_hash(&target.after_record.target)? == target.after_hash,
            "Deployed Skill changed before its receipt could be saved"
        );
        self.save_record(&target.after_record, target.before_record.as_ref())?;
        journal.targets[index].phase = "committed".into();
        journal.targets[index].result = Some(result_for(
            &target.target_id,
            &target.after_record,
            true,
            if target.after_record.status == "inactive" {
                "inactive"
            } else {
                "current"
            },
            None,
        ));
        if let Err(error) = self.finish_target_reservation(journal, index)
            && let Some(result) = &mut journal.targets[index].result
        {
            result.error = Some(format!(
                "Skill deployment completed, but reservation cleanup is pending; retry this operation: {error}"
            ));
        }
        // Once the receipt is durable, failures in bookkeeping must not roll back a completed copy.
        if self.save_journal(journal).is_ok() {
            let _ = fs::remove_dir_all(&paths.operation);
        }
        Ok(())
    }

    fn ensure_receipt_matches(&self, target: &TargetJournal) -> Result<()> {
        let records = read_skill_deployment_records(&self.record_path(&target.after_record))?;
        let current = records
            .iter()
            .find(|record| same_record_target(&record.target, &target.after_record.target));
        ensure!(
            serde_json::to_value(current)? == serde_json::to_value(target.before_record.as_ref())?,
            "Skill deployment ownership changed after preview"
        );
        Ok(())
    }

    fn reserve_target(&self, target: &TargetJournal) -> Result<()> {
        if target.capability.scope == SkillScope::Personal {
            agentkib_core::register_personal_skill_scope_library(
                &target.capability.scope_root,
                &self.library_root,
            )?;
            for project in &target.associated_projects {
                register_project_skill_library(project, &self.library_root)?;
            }
        }
        self.update_target_reservation(target, false)
    }

    fn release_target_reservation(&self, target: &TargetJournal) -> Result<()> {
        self.update_target_reservation(target, true)
    }

    fn update_target_reservation(&self, target: &TargetJournal, release: bool) -> Result<()> {
        let record = &target.after_record;
        let (root, path) = match record.scope {
            SkillScope::Workspace => (
                &record.scope_root,
                project_skill_reservation_path(&record.scope_root),
            ),
            SkillScope::Personal => (
                &self.library_root,
                personal_skill_reservation_path(&self.library_root),
            ),
        };
        let read_reservations = || match record.scope {
            SkillScope::Workspace => project_skill_reservations(&record.scope_root),
            SkillScope::Personal => personal_skill_reservations(&self.library_root),
        };
        ensure_safe_directory(root, path.parent().unwrap())?;
        read_reservations()?;
        let expected_hash = match fs::read(&path) {
            Ok(bytes) => Some(agentkib_core::hash_content(&bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        let mut records = read_reservations()?;
        if let Some(index) = records
            .iter()
            .position(|current| recorded_targets_overlap(&current.target, &record.target))
        {
            if release && records[index].operation_id != record.operation_id {
                // A terminal or never-started operation must not claim cleanup ownership of
                // a different operation that subsequently reserved the same native location.
                return Ok(());
            }
            ensure!(
                serde_json::to_value(&records[index])? == serde_json::to_value(record)?,
                "Skill deployment reservation was changed or belongs to another operation"
            );
            if !release {
                return Ok(());
            }
            records.remove(index);
        } else if release {
            return Ok(());
        } else {
            records.push(record.clone());
        }
        let bytes = encode_skill_deployment_records(&SkillDeploymentRecords {
            schema_version: 1,
            deployments: records,
        })?;
        fs::create_dir_all(path.parent().unwrap())?;
        atomic_write_checked(
            &path,
            &bytes,
            expected_hash
                .as_deref()
                .map(ExpectedFile::Sha256)
                .unwrap_or(ExpectedFile::Missing),
        )?;
        Ok(())
    }

    fn finish_target_reservation(
        &self,
        journal: &mut OperationJournal,
        index: usize,
    ) -> Result<()> {
        let target = &mut journal.targets[index];
        let result = target
            .result
            .as_ref()
            .context("Deployment result is missing")?;
        let terminal_phase = if result.success {
            "committed"
        } else {
            &result.status
        }
        .to_string();
        target.phase = if result.success {
            "committed-cleanup"
        } else {
            "compensated-cleanup"
        }
        .into();
        // Persist proof of completion before releasing ownership. If the process stops after
        // release, retry performs cleanup only and must never touch a newly reused native path.
        self.save_journal(journal)?;
        self.release_target_reservation(&journal.targets[index])?;
        if let Some(result) = &mut journal.targets[index].result
            && result.success
        {
            result.error = None;
        }
        journal.targets[index].phase = terminal_phase;
        self.save_journal(journal)
    }

    fn authorized_scopes(
        &self,
        journal_targets: &[TargetJournal],
        targets: &[SkillTargetCapability],
        workspaces: &[SkillWorkspace],
        approve_home: bool,
    ) -> Result<Vec<PathBuf>> {
        let mut scopes = vec![self.library_root.clone()];
        for target in journal_targets
            .iter()
            .filter(|target| target_needs_recovery(target))
        {
            if let Some(current) =
                current_frozen_capability(&target.capability, &target.capability.id, targets)
                && (current.scope != SkillScope::Personal || approve_home)
            {
                scopes.push(current.scope_root.clone());
                if let Ok(projects) = associated_project_roots(
                    current,
                    &target.after_record.target,
                    workspaces,
                    &target.associated_projects,
                ) {
                    scopes.extend(projects);
                }
                if let Ok(personal) = agentkib_core::personal_skill_scope_roots(
                    std::slice::from_ref(&target.after_record.target),
                ) {
                    scopes.extend(personal);
                }
            }
        }
        Ok(scopes)
    }

    fn record_path(&self, record: &SkillDeployment) -> PathBuf {
        match record.scope {
            SkillScope::Personal => personal_skill_record_path(&self.library_root),
            SkillScope::Workspace => project_skill_record_path(&record.scope_root),
        }
    }

    fn lock_scopes(&self, mut scopes: Vec<PathBuf>) -> Result<ScopeLockResult> {
        scopes.sort_by_key(|scope| platform_path::identity(scope));
        scopes.dedup_by(|left, right| platform_path::equivalent(left, right));
        let mut guards = Vec::new();
        let mut errors = BTreeMap::new();
        for scope in scopes {
            match skill_scope_locks(std::slice::from_ref(&scope)) {
                Ok(guard) => guards.push(guard),
                Err(error) if platform_path::equivalent(&scope, &self.library_root) => {
                    return Err(error);
                }
                Err(error) => {
                    errors.insert(platform_path::identity(&scope), error.to_string());
                }
            }
        }
        Ok((guards, errors))
    }

    fn save_record(
        &self,
        record: &SkillDeployment,
        expected: Option<&SkillDeployment>,
    ) -> Result<()> {
        let path = self.record_path(record);
        let root = match record.scope {
            SkillScope::Personal => &self.library_root,
            SkillScope::Workspace => &record.scope_root,
        };
        ensure_safe_directory(
            root,
            path.parent().context("Deployment records have no parent")?,
        )?;
        read_skill_deployment_records(&path)?;
        let expected_hash = fs::read(&path)
            .ok()
            .map(|bytes| agentkib_core::hash_content(&bytes));
        // Re-read after capturing the file fingerprint so a concurrent edit cannot be accepted
        // as the expected version while we overwrite records parsed before that edit.
        let mut records = read_skill_deployment_records(&path)?;
        let current = records
            .iter()
            .find(|value| same_record_target(&value.target, &record.target));
        ensure!(
            serde_json::to_value(current)? == serde_json::to_value(expected)?,
            "Skill deployment receipt changed before commit"
        );
        records.retain(|value| {
            value.id != record.id && !same_record_target(&value.target, &record.target)
        });
        ensure!(
            !records
                .iter()
                .any(|value| recorded_targets_overlap(&value.target, &record.target)),
            "Another deployment owns this physical target"
        );
        records.push(record.clone());
        let bytes = encode_skill_deployment_records(&SkillDeploymentRecords {
            schema_version: 1,
            deployments: records,
        })?;
        fs::create_dir_all(path.parent().unwrap())?;
        atomic_write_checked(
            &path,
            &bytes,
            expected_hash
                .as_deref()
                .map(ExpectedFile::Sha256)
                .unwrap_or(ExpectedFile::Missing),
        )?;
        Ok(())
    }

    fn records(&self, workspaces: &[SkillWorkspace]) -> Result<Vec<SkillDeployment>> {
        let mut records =
            read_skill_deployment_records(&personal_skill_record_path(&self.library_root))?;
        ensure!(
            records
                .iter()
                .all(|record| record.scope == SkillScope::Personal),
            "Personal Skill receipts contain workspace records"
        );
        let mut roots = BTreeSet::new();
        for workspace in workspaces {
            if roots.insert(platform_path::identity(&workspace.path)) {
                records.extend(agentkib_core::project_skill_deployments(&workspace.path)?);
            }
        }
        let mut ids = BTreeSet::new();
        let mut paths = BTreeSet::new();
        for record in &records {
            validate_operation_id(&record.id)?;
            ensure!(
                ids.insert(record.id.clone())
                    && paths.insert(platform_path::lexical_identity(&record.target)),
                "Duplicate Skill deployment ownership records"
            );
        }
        Ok(records)
    }

    fn pending_target(&self, path: &Path) -> Result<bool> {
        Ok(self.journals()?.iter().any(|journal| {
            journal.targets.iter().any(|target| {
                target_needs_recovery(target)
                    && same_record_target(&target.after_record.target, path)
            })
        }))
    }

    fn journal_path(&self, token: &str) -> Result<PathBuf> {
        validate_operation_id(token)?;
        Ok(self
            .library_root
            .join("deployment-operations")
            .join(format!("{token}.json")))
    }

    fn save_journal(&self, journal: &OperationJournal) -> Result<()> {
        let path = self.journal_path(&journal.operation_id)?;
        ensure_safe_directory(&self.library_root, path.parent().unwrap())?;
        fs::create_dir_all(path.parent().unwrap())?;
        atomic_write(&path, &serde_json::to_vec_pretty(journal)?)?;
        Ok(())
    }

    fn load_journal(&self, token: &str) -> Result<Option<OperationJournal>> {
        let path = self.journal_path(token)?;
        ensure_safe_directory(&self.library_root, path.parent().unwrap())?;
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        ensure!(
            metadata.is_file()
                && !platform_path::is_reparse_or_symlink(&path)?
                && metadata.len() <= MAX_JOURNAL_BYTES,
            "Skill operation journal is unsafe or too large"
        );
        let journal: OperationJournal = serde_json::from_slice(&fs::read(path)?)?;
        ensure!(
            journal.schema_version == 1 && journal.operation_id == token,
            "Skill operation journal is invalid"
        );
        ensure!(
            journal.targets.len() <= 64,
            "Skill operation journal has too many targets"
        );
        ensure!(
            journal
                .targets
                .iter()
                .all(|target| target.after_record.operation_id == token),
            "Skill journal receipt belongs to another operation"
        );
        Ok(Some(journal))
    }

    fn journals(&self) -> Result<Vec<OperationJournal>> {
        let directory = self.library_root.join("deployment-operations");
        ensure_safe_directory(&self.library_root, &directory)?;
        let entries = match fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };
        let mut journals = Vec::new();
        for entry in entries {
            let entry = entry?;
            let name = entry.file_name();
            let Some(token) = name.to_str().and_then(|value| value.strip_suffix(".json")) else {
                continue;
            };
            if let Some(journal) = self.load_journal(token)? {
                journals.push(journal);
            }
        }
        Ok(journals)
    }

    fn recover_journal(
        &self,
        journal: &mut OperationJournal,
        targets: &[SkillTargetCapability],
        workspaces: &[SkillWorkspace],
        scope_errors: &BTreeMap<String, String>,
        locked_scopes: &BTreeSet<String>,
    ) -> Result<()> {
        let mut warnings = Vec::new();
        for index in 0..journal.targets.len() {
            if !target_needs_recovery(&journal.targets[index]) {
                continue;
            }
            let mut target = journal.targets[index].clone();
            let associated = associated_project_roots(
                &target.capability,
                &target.after_record.target,
                workspaces,
                &target.associated_projects,
            );
            let mut association_error = match associated {
                Ok(roots) => {
                    target.associated_projects = roots;
                    None
                }
                Err(error) => Some(error),
            };
            let personal_scopes = match agentkib_core::personal_skill_scope_roots(
                std::slice::from_ref(&target.after_record.target),
            ) {
                Ok(roots) => roots,
                Err(error) => {
                    association_error = Some(error);
                    Vec::new()
                }
            };
            journal.targets[index].associated_projects = target.associated_projects.clone();
            let validation = if let Some(error) = association_error {
                Err(error)
            } else if target
                .associated_projects
                .iter()
                .chain(&personal_scopes)
                .any(|root| !locked_scopes.contains(&platform_path::identity(root)))
            {
                Err(anyhow::anyhow!(
                    "Deployment project ownership scopes changed while acquiring locks; retry recovery"
                ))
            } else if let Some(error) = std::iter::once(&target.capability.scope_root)
                .chain(&target.associated_projects)
                .chain(&personal_scopes)
                .find_map(|root| scope_errors.get(&platform_path::identity(root)))
            {
                Err(anyhow::anyhow!(error.clone()))
            } else if is_reservation_cleanup(&target) || has_no_native_writes(&target) {
                validate_frozen_identity(&target, targets, workspaces)
            } else {
                validate_frozen_target(&target, targets, workspaces, &self.library_root)
            };
            if let Err(error) = validation {
                if is_reservation_cleanup(&target) || has_no_native_writes(&target) {
                    warnings.push(format!(
                        "Reservation cleanup requires its original scope: {error}"
                    ));
                } else {
                    journal.targets[index].result = Some(result_for(
                        &target.target_id,
                        &target.after_record,
                        false,
                        "recovery-required",
                        Some(error.to_string()),
                    ));
                }
                if let Err(error) = self.save_journal(journal) {
                    warnings.push(format!("Could not persist recovery status: {error}"));
                }
                continue;
            }
            if has_no_native_writes(&target) {
                // Activation cannot start before the backed-up phase is durable. Planned and
                // reserved operations only need ownership cleanup; a later same-content native
                // installation is not proof that this operation created it.
                journal.targets[index].result = Some(result_for(
                    &target.target_id,
                    &target.after_record,
                    false,
                    "recovered",
                    Some("Operation stopped before changing native files; prepare it again".into()),
                ));
                if let Err(error) = self.finish_target_reservation(journal, index) {
                    warnings.push(format!(
                        "Reservation cleanup is pending; retry this operation: {error}"
                    ));
                }
                continue;
            }
            if is_reservation_cleanup(&target) {
                if let Err(error) = self.finish_target_reservation(journal, index) {
                    warnings.push(format!(
                        "Reservation cleanup is pending; retry this operation: {error}"
                    ));
                }
                continue;
            }
            let records =
                match read_skill_deployment_records(&self.record_path(&target.after_record)) {
                    Ok(records) => records,
                    Err(error) => {
                        journal.targets[index].result = Some(result_for(
                            &target.target_id,
                            &target.after_record,
                            false,
                            "recovery-required",
                            Some(error.to_string()),
                        ));
                        continue;
                    }
                };
            if records.iter().any(|record| {
                serde_json::to_value(record).ok() == serde_json::to_value(&target.after_record).ok()
            }) {
                journal.targets[index].phase = "committed".into();
                journal.targets[index].result = Some(result_for(
                    &target.target_id,
                    &target.after_record,
                    true,
                    if target.after_record.status == "inactive" {
                        "inactive"
                    } else {
                        "current"
                    },
                    None,
                ));
            } else {
                let (phase, detail) = match self.recover_target(
                    &journal.operation_id,
                    &target,
                    targets,
                    workspaces,
                ) {
                    Ok(()) => (
                        "recovered",
                        "Interrupted operation was rolled back; prepare it again".into(),
                    ),
                    Err(error) => ("recovery-required", error.to_string()),
                };
                if phase != "recovery-required" {
                    journal.targets[index].phase = phase.into();
                }
                journal.targets[index].result = Some(result_for(
                    &target.target_id,
                    &target.after_record,
                    false,
                    phase,
                    Some(detail),
                ));
            }
            if journal.targets[index]
                .result
                .as_ref()
                .is_some_and(|result| result.success || result.status == "recovered")
            {
                if let Err(error) = self.finish_target_reservation(journal, index) {
                    warnings.push(format!("Native operation is complete, but reservation cleanup is pending; retry this operation: {error}"));
                }
            } else if let Err(error) = self.save_journal(journal) {
                warnings.push(format!("Could not persist recovery status: {error}"));
            }
        }
        let mut report = journal_report(journal);
        report.warnings = warnings;
        journal.report = Some(report);
        if let Err(error) = self.save_journal(journal) {
            journal
                .report
                .as_mut()
                .unwrap()
                .warnings
                .push(format!("Recovery result could not be persisted: {error}"));
        }
        Ok(())
    }

    /// The journal inspected before waiting for OS locks can have been completed
    /// by another process. Reload it before making any recovery decision.
    fn resume_journal_locked(
        &self,
        snapshot: &OperationJournal,
        targets: &[SkillTargetCapability],
        workspaces: &[SkillWorkspace],
        scope_errors: &BTreeMap<String, String>,
        locked_scopes: &BTreeSet<String>,
        approve_home: bool,
    ) -> Result<SkillDeploymentReport> {
        let mut journal = self
            .load_journal(&snapshot.operation_id)?
            .context("Skill operation journal disappeared while acquiring its locks")?;
        ensure!(
            !recovery_requires_home_approval(&journal) || approve_home,
            "Personal Skill deployment requires Agent Home approval"
        );
        if let Some(report) = journal.report.clone()
            && !journal.targets.iter().any(target_needs_recovery)
        {
            return Ok(report);
        }
        let scope_ids = |journal: &OperationJournal| -> Result<BTreeSet<String>> {
            Ok(self
                .authorized_scopes(&journal.targets, targets, workspaces, approve_home)?
                .into_iter()
                .map(|path| platform_path::identity(&path))
                .collect::<BTreeSet<_>>())
        };
        ensure!(
            scope_ids(snapshot)? == scope_ids(&journal)?,
            "Skill recovery scopes changed while acquiring locks; retry the operation"
        );
        journal.report = None;
        self.recover_journal(
            &mut journal,
            targets,
            workspaces,
            scope_errors,
            locked_scopes,
        )?;
        journal
            .report
            .context("Skill deployment recovery did not produce a result")
    }

    fn recover_target(
        &self,
        token: &str,
        target: &TargetJournal,
        targets: &[SkillTargetCapability],
        workspaces: &[SkillWorkspace],
    ) -> Result<()> {
        if has_no_native_writes(target) {
            validate_frozen_identity(target, targets, workspaces)?;
            return Ok(());
        }
        validate_frozen_target(target, targets, workspaces, &self.library_root)?;
        self.ensure_receipt_matches(target)?;
        // Journals from before project reservations were introduced acquire their reservation
        // only on explicit recovery. Read-only discovery never migrates old operation state.
        self.reserve_target(target)?;
        let paths = operation_paths(&target.capability, &target.after_record.id, token)?;
        ensure_safe_directory(&target.capability.scope_root, &paths.operation)?;
        ensure_safe_directory(&target.capability.scope_root, &paths.backup)?;
        let native = &target.after_record.target;
        let actual = directory_hash(native)?;
        if actual != target.before_hash {
            if let Some(actual) = actual {
                ensure!(
                    target.phase != "staged"
                        && (target.phase != "recovery-required" || target.before_hash.is_some()),
                    "The journal does not prove this operation activated the native package; external files were preserved"
                );
                ensure!(
                    target.after_hash.as_deref() == Some(&actual),
                    "External changes at the deployment target were preserved"
                );
                ensure!(
                    directory_hash(&paths.incoming)?.is_none(),
                    "Both deployed and staged packages exist; recovery requires inspection"
                );
                if let Some(expected) = &target.before_hash {
                    ensure!(
                        directory_hash(&paths.before)?.as_ref() == Some(expected)
                            || directory_hash(&paths.backup)?.as_ref() == Some(expected),
                        "The original deployment package cannot be found; native files were preserved"
                    );
                }
                fs::create_dir_all(&paths.operation)?;
                move_path(native, &paths.incoming)?;
            }
            if let Some(expected) = &target.before_hash {
                let source = if directory_hash(&paths.before)?.as_ref() == Some(expected) {
                    &paths.before
                } else if directory_hash(&paths.backup)?.as_ref() == Some(expected) {
                    &paths.backup
                } else {
                    bail!(
                        "The original deployment package cannot be found; backup files were preserved"
                    );
                };
                move_path(source, native)?;
            }
        }
        ensure!(
            directory_hash(native)? == target.before_hash,
            "Original deployment could not be restored"
        );
        let mut backup_hash = directory_hash(&paths.backup)?;
        if backup_hash != target.previous_backup_hash
            && target.before_hash.is_some()
            && target.before_hash == target.after_hash
            && backup_hash == target.before_hash
        {
            // A no-content-change update can still rotate backups. The native
            // hash alone cannot distinguish its activated copy from the old one.
            // Preserve the recognized displaced package, then restore the prior
            // backup exactly as for an ordinary interrupted update.
            ensure!(
                directory_hash(&paths.before)?.is_none(),
                "Both original and rotated packages exist; recovery requires inspection"
            );
            if let Some(expected) = &target.previous_backup_hash {
                ensure!(
                    directory_hash(&paths.prior_backup)?.as_ref() == Some(expected),
                    "The previous rollback package cannot be found"
                );
            }
            fs::create_dir_all(&paths.operation)?;
            move_path(&paths.backup, &paths.before)?;
            backup_hash = None;
        }
        if backup_hash != target.previous_backup_hash {
            ensure!(
                backup_hash.is_none(),
                "Rollback backup changed externally; files were preserved"
            );
            if let Some(expected) = &target.previous_backup_hash {
                ensure!(
                    directory_hash(&paths.prior_backup)?.as_ref() == Some(expected),
                    "The previous rollback package cannot be found"
                );
                move_path(&paths.prior_backup, &paths.backup)?;
            }
        }
        Ok(())
    }
}

fn same_record_target(left: &Path, right: &Path) -> bool {
    platform_path::lexical_identity(left) == platform_path::lexical_identity(right)
}

fn same_deployment_identity(left: &SkillDeployment, right: &SkillDeployment) -> bool {
    left.id == right.id
        && left.library_id == right.library_id
        && match (&left.library_root, &right.library_root) {
            (Some(left), Some(right)) => platform_path::equivalent(left, right),
            (None, None) => true,
            _ => false,
        }
}

fn is_reservation_cleanup(target: &TargetJournal) -> bool {
    matches!(
        target.phase.as_str(),
        "committed-cleanup" | "compensated-cleanup"
    )
}

fn has_no_native_writes(target: &TargetJournal) -> bool {
    matches!(target.phase.as_str(), "planned" | "reserved")
        || target.phase == "staged" && target.before_hash.is_none()
}

fn target_needs_recovery(target: &TargetJournal) -> bool {
    target
        .result
        .as_ref()
        .is_none_or(|result| result.status == "recovery-required")
        || target.phase == "recovery-required"
        || is_reservation_cleanup(target)
}

fn recovery_requires_home_approval(journal: &OperationJournal) -> bool {
    // Skipped and completed personal targets do not authorize further Home writes. In
    // particular, a conflicted personal target can have been excluded from the preview's
    // approval requirement and have no receipt for the recovery UI to display.
    journal.targets.iter().any(|target| {
        target.capability.scope == SkillScope::Personal && target_needs_recovery(target)
    })
}

fn recorded_targets_overlap(left: &Path, right: &Path) -> bool {
    platform_path::lexical_starts_with(left, right)
        || platform_path::lexical_starts_with(right, left)
}

fn select_targets(
    request: &PrepareSkillDeploymentRequest,
    record: Option<&SkillDeployment>,
    targets: &[SkillTargetCapability],
) -> Result<Vec<SelectedTarget>> {
    let selected: Vec<_> = if !request.target_ids.is_empty() {
        request
            .target_ids
            .iter()
            .map(|id| {
                targets
                    .iter()
                    .find(|target| target.id == *id)
                    .context("Skill target is no longer available")
            })
            .collect::<Result<_>>()?
    } else if let Some(record) = record {
        targets
            .iter()
            .filter(|target| {
                target.scope == record.scope
                    && (target.workspace_id == record.workspace_id
                        || target.scope == SkillScope::Workspace
                            && target.workspace_id.is_some()
                            && record.workspace_id.is_some())
                    && platform_path::equivalent(&target.scope_root, &record.scope_root)
                    && record.agents.contains(&target.agent)
                    && record
                        .target
                        .parent()
                        .is_some_and(|path| platform_path::equivalent(&target.root, path))
            })
            .collect()
    } else {
        Vec::new()
    };
    let mut groups: BTreeMap<
        String,
        (
            SkillTargetCapability,
            Vec<String>,
            BTreeSet<agentkib_core::AgentKind>,
        ),
    > = BTreeMap::new();
    for target in selected {
        let entry = groups
            .entry(platform_path::identity(&target.root))
            .or_insert_with(|| (target.clone(), Vec::new(), BTreeSet::new()));
        ensure!(
            entry.0.scope == target.scope && entry.0.workspace_id == target.workspace_id,
            "One physical Skill target has conflicting scopes"
        );
        if !entry.1.contains(&target.id) {
            entry.1.push(target.id.clone());
        }
        entry.2.insert(target.agent);
        for agent in &target.visible_to {
            if !entry.0.visible_to.contains(agent) {
                entry.0.visible_to.push(*agent);
            }
        }
        entry.0.writable &= target.writable;
        entry.0.conditions.extend(
            target
                .conditions
                .iter()
                .filter(|condition| !entry.0.conditions.contains(condition))
                .cloned()
                .collect::<Vec<_>>(),
        );
    }
    Ok(groups
        .into_values()
        .map(|(capability, ids, agents)| (capability, ids, agents.into_iter().collect()))
        .collect())
}

fn validate_capability(
    target: &SkillTargetCapability,
    workspaces: &[SkillWorkspace],
) -> Result<()> {
    ensure!(
        target.writable,
        "{}",
        target
            .reason
            .as_deref()
            .unwrap_or("Skill target is not writable")
    );
    ensure!(
        agentkib_core::AgentKind::WRITABLE.contains(&target.agent),
        "Agent is read-only"
    );
    ensure!(
        target.root.is_absolute() && target.scope_root.is_absolute(),
        "Skill target paths must be absolute"
    );
    ensure!(
        platform_path::starts_with(&target.root, &target.scope_root)
            && !platform_path::equivalent(&target.root, &target.scope_root),
        "Skill directory must be inside its authorized scope"
    );
    if target.scope == SkillScope::Workspace {
        ensure!(
            workspaces.iter().any(
                |workspace| Some(&workspace.id) == target.workspace_id.as_ref()
                    && platform_path::equivalent(&workspace.path, &target.scope_root)
            ),
            "Skill workspace is no longer registered"
        );
    }
    Ok(())
}

fn current_frozen_capability<'a>(
    frozen: &SkillTargetCapability,
    id: &str,
    capabilities: &'a [SkillTargetCapability],
) -> Option<&'a SkillTargetCapability> {
    capabilities.iter().find(|current| {
        if current.scope != frozen.scope
            || !platform_path::equivalent(&current.root, &frozen.root)
            || !platform_path::equivalent(&current.scope_root, &frozen.scope_root)
            || id == frozen.id && current.agent != frozen.agent
        {
            return false;
        }
        if current.workspace_id == frozen.workspace_id {
            return current.id == id;
        }
        if frozen.scope != SkillScope::Workspace
            || frozen.workspace_id.is_none()
            || current.workspace_id.is_none()
        {
            return false;
        }
        if id == frozen.id {
            return true;
        }
        // A grouped preview stores all selected capability IDs but only its primary capability.
        // Reconstruct each secondary ID with the old registration ID, retaining its Agent and
        // physical directory rather than accepting any remaining Agent at a shared location.
        let identity_root = platform_path::canonicalize_allow_missing(&frozen.root)
            .unwrap_or_else(|_| frozen.root.clone());
        crate::targets::stable_id(
            "target",
            &format!(
                "{}:{:?}:{}:{}",
                current.agent.as_str(),
                frozen.scope,
                frozen.workspace_id.as_deref().unwrap_or("personal"),
                platform_path::identity(&identity_root)
            ),
        ) == id
    })
}

fn rebind_workspace_target(
    target: &mut TargetJournal,
    capabilities: &[SkillTargetCapability],
    workspaces: &[SkillWorkspace],
    library_root: &Path,
) -> Result<()> {
    validate_frozen_target(target, capabilities, workspaces, library_root)?;
    let current =
        current_frozen_capability(&target.capability, &target.capability.id, capabilities)
            .context("Skill target is no longer available")?;
    if target.capability.scope == SkillScope::Workspace
        && target.capability.workspace_id != current.workspace_id
    {
        let ids = target
            .capability_ids
            .iter()
            .map(|id| {
                current_frozen_capability(&target.capability, id, capabilities)
                    .map(|capability| capability.id.clone())
                    .context("Skill target is no longer available")
            })
            .collect::<Result<_>>()?;
        target.capability_ids = ids;
        target.capability.id = current.id.clone();
        target.capability.workspace_id = current.workspace_id.clone();
        target.after_record.workspace_id = current.workspace_id.clone();
        // Keep before_record byte-for-byte equivalent to the receipt reviewed earlier. Only a
        // successful activation writes after_record with the new workspace registration ID.
    }
    Ok(())
}

fn validate_frozen_target(
    target: &TargetJournal,
    capabilities: &[SkillTargetCapability],
    workspaces: &[SkillWorkspace],
    library_root: &Path,
) -> Result<()> {
    validate_frozen_identity(target, capabilities, workspaces)?;
    ensure_target_safe(&target.capability, &target.after_record.target)?;
    ensure_no_manifest_claim(
        &target.capability,
        &target.after_record.target,
        &target.associated_projects,
    )?;
    ensure_associated_ownership(
        library_root,
        &target.capability,
        &target.after_record.target,
        &target.associated_projects,
        target.before_record.as_ref(),
        Some(&target.after_record),
    )?;
    Ok(())
}

fn ensure_associated_ownership(
    library_root: &Path,
    capability: &SkillTargetCapability,
    target: &Path,
    projects: &[PathBuf],
    before: Option<&SkillDeployment>,
    after: Option<&SkillDeployment>,
) -> Result<()> {
    let before = before.map(serde_json::to_value).transpose()?;
    let after = after.map(serde_json::to_value).transpose()?;
    let mut records = Vec::new();
    if capability.scope == SkillScope::Personal {
        records.extend(agentkib_core::personal_skill_scope_ownership(
            &capability.scope_root,
            library_root,
        )?);
    } else {
        agentkib_core::ensure_workspace_skill_record_namespace(
            &capability.scope_root,
            library_root,
        )?;
    }
    for scope in agentkib_core::personal_skill_scope_roots(&[target.to_path_buf()])? {
        if capability.scope != SkillScope::Personal
            || !platform_path::equivalent(&scope, &capability.scope_root)
        {
            records.extend(agentkib_core::personal_skill_scope_ownership(
                &scope,
                library_root,
            )?);
        }
    }
    for project in std::iter::once(&capability.scope_root)
        .filter(|_| capability.scope == SkillScope::Workspace)
        .chain(projects)
    {
        records.extend(agentkib_core::project_skill_ownership_at_home(
            project,
            library_root,
        )?);
    }
    for record in records {
        if recorded_targets_overlap(&record.target, target) {
            let value = serde_json::to_value(&record)?;
            ensure!(
                before.as_ref() == Some(&value) || after.as_ref() == Some(&value),
                "Target is owned or reserved by another Skill deployment"
            );
        }
    }
    Ok(())
}

/// Include ancestor ownership scopes for nested projects and personal homes inside projects.
/// Keep frozen roots during recovery even after removal from the workspace inventory. Old
/// workspace journals with an empty scope list are expanded at execution without migration.
fn associated_project_roots(
    capability: &SkillTargetCapability,
    target: &Path,
    workspaces: &[SkillWorkspace],
    frozen: &[PathBuf],
) -> Result<Vec<PathBuf>> {
    let mut roots = frozen.to_vec();
    roots.extend(
        workspaces
            .iter()
            .filter(|workspace| {
                if capability.scope == SkillScope::Workspace {
                    platform_path::starts_with(target, &workspace.path)
                } else {
                    agentkib_core::skill_paths_overlap(target, &workspace.path)
                }
            })
            .map(|workspace| workspace.path.clone()),
    );
    if capability.scope == SkillScope::Workspace {
        roots.extend(agentkib_core::skill_ownership_scope_roots(
            &capability.scope_root,
            &[target.to_path_buf()],
        )?);
    } else {
        // A native home can be inside an unregistered workspace whose only marker is a
        // deployment receipt or reservation. Discover that owner without treating the
        // personal home itself (or its personal receipts) as a workspace.
        roots.extend(agentkib_core::skill_workspace_scope_roots(&[
            target.to_path_buf()
        ])?);
    }
    roots.sort_by_key(|root| platform_path::identity(root));
    roots.dedup_by(|left, right| platform_path::equivalent(left, right));
    for root in &roots {
        ensure!(
            root.is_absolute()
                && root.is_dir()
                && !root
                    .components()
                    .any(|part| matches!(part, std::path::Component::ParentDir))
                && recorded_targets_overlap(root, target),
            "Deployment ownership scope is unavailable or unrelated to its target"
        );
    }
    Ok(roots)
}

fn ensure_no_manifest_claim(
    capability: &SkillTargetCapability,
    target: &Path,
    associated_projects: &[PathBuf],
) -> Result<()> {
    if capability.scope == SkillScope::Workspace {
        ensure_skill_target_not_manifest_owned(&capability.scope_root, target)?;
    }
    for project in associated_projects {
        ensure_skill_target_not_manifest_owned(project, target)?;
    }
    Ok(())
}

fn validate_frozen_identity(
    target: &TargetJournal,
    capabilities: &[SkillTargetCapability],
    workspaces: &[SkillWorkspace],
) -> Result<()> {
    validate_operation_id(&target.after_record.id)?;
    validate_library_id(&target.after_record.library_id)?;
    validate_library_id(&target.after_record.package_name)?;
    for id in &target.capability_ids {
        let current = current_frozen_capability(&target.capability, id, capabilities)
            .context("Skill target is no longer available")?;
        validate_capability(current, workspaces)?;
    }
    ensure!(
        target.capability_ids.contains(&target.capability.id),
        "Skill operation has no authorized targets"
    );
    ensure!(
        platform_path::equivalent(
            &target.after_record.target,
            &target
                .capability
                .root
                .join(&target.after_record.package_name)
        ),
        "Skill receipt target does not match the native directory"
    );
    ensure!(
        target.after_record.scope == target.capability.scope
            && target.after_record.workspace_id == target.capability.workspace_id
            && platform_path::equivalent(
                &target.after_record.scope_root,
                &target.capability.scope_root
            ),
        "Skill receipt scope does not match its target"
    );
    Ok(())
}

fn ensure_target_safe(capability: &SkillTargetCapability, target: &Path) -> Result<()> {
    ensure_safe_directory(&capability.scope_root, target)
}

fn ensure_safe_directory(root: &Path, path: &Path) -> Result<()> {
    ensure!(
        root.is_absolute() && path.is_absolute(),
        "Skill paths must be absolute"
    );
    let relative = path
        .strip_prefix(root)
        .context("Skill path is outside its authorized root")?;
    let mut current = root.to_path_buf();
    for part in std::iter::once(None).chain(relative.components().map(Some)) {
        if let Some(part) = part {
            let std::path::Component::Normal(part) = part else {
                bail!("Skill path contains unsafe components");
            };
            current.push(part);
        }
        match fs::symlink_metadata(&current) {
            Ok(metadata) => ensure!(
                metadata.is_dir() && !platform_path::is_reparse_or_symlink(&current)?,
                "Skill directory is not a regular directory: {}",
                current.display()
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn ensure_regular_package(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    ensure!(
        metadata.is_dir() && !platform_path::is_reparse_or_symlink(path)?,
        "Skill package must be a regular directory"
    );
    // Check reparse directories before descending; a directory junction is not necessarily
    // represented as file_type().is_symlink() on Windows.
    for (index, entry) in walkdir::WalkDir::new(path)
        .follow_links(false)
        .into_iter()
        .enumerate()
    {
        ensure!(
            index < crate::MAX_SKILL_PACKAGE_ENTRIES,
            "Skill package contains more than 4096 entries"
        );
        let entry = entry?;
        ensure!(
            !platform_path::is_reparse_or_symlink(entry.path())?,
            "Skill packages cannot contain symbolic links or reparse points"
        );
    }
    Ok(())
}

fn directory_hash(path: &Path) -> Result<Option<String>> {
    match fs::symlink_metadata(path) {
        Ok(_) => {
            ensure_regular_package(path)?;
            Ok(Some(package_hash(path)?.0))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn operation_paths(
    capability: &SkillTargetCapability,
    id: &str,
    token: &str,
) -> Result<OperationPaths> {
    validate_operation_id(id)?;
    validate_operation_id(token)?;
    let state = capability
        .root
        .parent()
        .context("Skill target has no parent")?
        .join(".agentkib-skill-state");
    ensure!(
        platform_path::starts_with(&state, &capability.scope_root),
        "Skill staging directory is outside its scope"
    );
    let operation = state.join("operations").join(token).join(id);
    Ok(OperationPaths {
        incoming: operation.join("incoming"),
        before: operation.join("before"),
        prior_backup: operation.join("prior-backup"),
        backup: state.join("backups").join(id),
        operation,
    })
}

fn validate_operation_id(value: &str) -> Result<()> {
    let id = Uuid::parse_str(value).context("Invalid Skill deployment operation ID")?;
    ensure!(
        id.to_string() == value,
        "Skill deployment operation IDs must use canonical UUIDs"
    );
    Ok(())
}

#[cfg(unix)]
fn ensure_same_filesystem(native_root: &Path, staging: &Path) -> Result<()> {
    use std::os::unix::fs::MetadataExt;
    ensure!(
        fs::metadata(native_root)?.dev() == fs::metadata(staging)?.dev(),
        "Skill staging and target are on different filesystems; an atomic deployment is unavailable"
    );
    Ok(())
}

#[cfg(windows)]
fn ensure_same_filesystem(native_root: &Path, staging: &Path) -> Result<()> {
    use std::os::windows::fs::OpenOptionsExt;
    let volume = |path: &Path| -> Result<String> {
        // FILE_FLAG_BACKUP_SEMANTICS permits opening directories for volume identification.
        let file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(0x02000000)
            .open(path)?;
        let identity = agentkib_platform::fs::file_identity(&file)?;
        Ok(identity
            .split(':')
            .nth(1)
            .context("Directory volume identity is unavailable")?
            .to_string())
    };
    ensure!(
        volume(native_root)? == volume(staging)?,
        "Skill staging and target are on different volumes; an atomic deployment is unavailable"
    );
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn ensure_same_filesystem(_native_root: &Path, _staging: &Path) -> Result<()> {
    bail!("Atomic Skill deployment is unsupported on this platform")
}

fn result_for(
    target_id: &str,
    record: &SkillDeployment,
    success: bool,
    status: &str,
    error: Option<String>,
) -> SkillDeploymentResult {
    SkillDeploymentResult {
        target_id: target_id.into(),
        deployment_id: Some(record.id.clone()),
        path: record.target.clone(),
        success,
        status: status.into(),
        error,
    }
}

fn journal_report(journal: &OperationJournal) -> SkillDeploymentReport {
    SkillDeploymentReport {
        operation_id: journal.operation_id.clone(),
        results: journal
            .targets
            .iter()
            .map(|target| {
                target.result.clone().unwrap_or_else(|| {
                    result_for(
                        &target.target_id,
                        &target.after_record,
                        false,
                        "recovery-required",
                        Some("Operation result is not available".into()),
                    )
                })
            })
            .collect(),
        warnings: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agentkib_core::{AdapterState, AgentKind, Manifest, SkillDefinition, WorkspaceIdentity};

    struct Fixture {
        _temp: TempDir,
        library: PathBuf,
        workspace: SkillWorkspace,
        targets: Vec<SkillTargetCapability>,
        manager: DeploymentManager,
    }

    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let base = platform_path::canonicalize(temp.path()).unwrap();
            let library = base.join("library");
            let project = base.join("project");
            fs::create_dir_all(&project).unwrap();
            let workspace = SkillWorkspace {
                id: "workspace".into(),
                name: "Project".into(),
                path: project.clone(),
            };
            let mut targets = Vec::new();
            for (id, agent, relative) in [
                ("codex", AgentKind::Codex, ".agents/skills"),
                ("claude", AgentKind::ClaudeCode, ".claude/skills"),
            ] {
                targets.push(SkillTargetCapability {
                    id: id.into(),
                    agent,
                    scope: SkillScope::Workspace,
                    workspace_id: Some(workspace.id.clone()),
                    profile: None,
                    root: project.join(relative),
                    scope_root: project.clone(),
                    visible_to: vec![agent],
                    writable: true,
                    reason: None,
                    conditions: Vec::new(),
                });
            }
            write_package(&library.join("skills/reviewer"), "first");
            let manager = DeploymentManager::new(library.clone());
            Self {
                _temp: temp,
                library,
                workspace,
                targets,
                manager,
            }
        }

        fn workspaces(&self) -> Vec<SkillWorkspace> {
            vec![self.workspace.clone()]
        }

        fn refresh_registration(&mut self) {
            let capabilities = crate::targets::targets_with_environment(
                &self.workspaces(),
                &crate::targets::TargetEnvironment {
                    home: self.library.parent().unwrap().join("home"),
                    values: BTreeMap::new(),
                },
            )
            .unwrap();
            for target in &mut self.targets {
                let current = capabilities
                    .iter()
                    .find(|current| {
                        current.scope == target.scope
                            && current.agent == target.agent
                            && platform_path::equivalent(&current.root, &target.root)
                    })
                    .unwrap();
                target.id = current.id.clone();
                target.workspace_id = current.workspace_id.clone();
            }
        }

        fn reregister(&mut self) {
            self.workspace.id = Uuid::new_v4().to_string();
            self.refresh_registration();
        }

        fn prepare(
            &self,
            operation: SkillDeploymentOperation,
            deployment_id: Option<&str>,
            targets: &[&str],
        ) -> SkillDeploymentPreview {
            self.manager
                .prepare(
                    PrepareSkillDeploymentRequest {
                        operation,
                        library_id: (operation == SkillDeploymentOperation::Deploy)
                            .then(|| "reviewer".into()),
                        deployment_id: deployment_id.map(str::to_string),
                        target_ids: targets.iter().map(|id| id.to_string()).collect(),
                    },
                    &self.targets,
                    &self.workspaces(),
                )
                .unwrap()
        }

        fn apply(&self, preview: &SkillDeploymentPreview) -> SkillDeploymentReport {
            self.manager
                .apply(
                    &preview.token,
                    true,
                    true,
                    &self.targets,
                    &self.workspaces(),
                )
                .unwrap()
        }

        fn deploy(&self, targets: &[&str]) -> SkillDeploymentReport {
            self.apply(&self.prepare(SkillDeploymentOperation::Deploy, None, targets))
        }
    }

    fn write_package(root: &Path, body: &str) {
        fs::create_dir_all(root.join("assets")).unwrap();
        fs::create_dir_all(root.join("agents")).unwrap();
        fs::write(
            root.join("SKILL.md"),
            format!("---\nname: reviewer\ndescription: Test skill\n---\n{body}\n"),
        )
        .unwrap();
        fs::write(root.join("assets/picture.bin"), [0_u8, 255, 1, 0, 128]).unwrap();
        fs::write(
            root.join("agents/openai.yaml"),
            "interface:\n  display_name: Review\n",
        )
        .unwrap();
        fs::write(root.join("LICENSE"), "Example license").unwrap();
        fs::write(root.join("run.sh"), "#!/bin/sh\nexit 0\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(root.join("run.sh"), fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    fn interrupted_first_deployment(
        fixture: &Fixture,
        reserve: bool,
        activate: bool,
    ) -> OperationJournal {
        let preview = fixture.prepare(
            SkillDeploymentOperation::Deploy,
            None,
            &[&fixture.targets[0].id],
        );
        let previews = fixture.manager.previews.lock().unwrap();
        let prepared = &previews[&preview.token].targets[0];
        let journal = OperationJournal {
            schema_version: 1,
            operation_id: preview.token,
            requires_home_approval: false,
            targets: vec![TargetJournal {
                target_id: prepared.capability.id.clone(),
                capability_ids: prepared.capability_ids.clone(),
                capability: prepared.capability.clone(),
                associated_projects: prepared.associated_projects.clone(),
                before_record: prepared.before_record.clone(),
                after_record: prepared.after_record.clone(),
                before_hash: prepared.before_hash.clone(),
                after_hash: prepared.after_hash.clone(),
                previous_backup_hash: prepared.previous_backup_hash.clone(),
                phase: if activate { "activated" } else { "planned" }.into(),
                result: None,
            }],
            report: None,
        };
        // A reservation is made only after the production writer has acquired every
        // scope lock; these locks also establish each project's regular metadata directory.
        let _write_guard = reserve.then(|| skill_write_lock().unwrap());
        let _scope_guards = reserve.then(|| {
            let scopes = fixture
                .manager
                .authorized_scopes(
                    &journal.targets,
                    &fixture.targets,
                    &fixture.workspaces(),
                    true,
                )
                .unwrap();
            let (guards, errors) = fixture.manager.lock_scopes(scopes).unwrap();
            assert!(errors.is_empty(), "{errors:?}");
            guards
        });
        fixture.manager.save_journal(&journal).unwrap();
        if reserve {
            fixture.manager.reserve_target(&journal.targets[0]).unwrap();
        }
        if activate {
            copy_package(
                prepared.after.as_ref().unwrap(),
                &prepared.after_record.target,
            )
            .unwrap();
        }
        journal
    }

    fn personal_outside_project(fixture: &mut Fixture) {
        let home = fixture.library.parent().unwrap().join("native-home");
        fixture.targets.truncate(1);
        fixture.targets[0].scope = SkillScope::Personal;
        fixture.targets[0].workspace_id = None;
        fixture.targets[0].scope_root = home.clone();
        fixture.targets[0].root = home.join("skills");
    }

    #[test]
    fn personal_scope_reservations_block_another_library_before_and_after_preview() {
        for before_preview in [false, true] {
            let mut fixture = Fixture::new();
            personal_outside_project(&mut fixture);
            let other_root = fixture.library.parent().unwrap().join("other-library");
            write_package(&other_root.join("skills/reviewer"), "first");
            let other = DeploymentManager::new(other_root.clone());
            let preview = (!before_preview).then(|| {
                prepare_from(&other, &fixture, SkillDeploymentOperation::Deploy, None).unwrap()
            });
            let mut journal = interrupted_first_deployment(&fixture, true, false);
            journal.targets[0].phase = "reserved".into();
            fixture.manager.save_journal(&journal).unwrap();
            assert!(journal.targets[0].associated_projects.is_empty());
            let native = &journal.targets[0].after_record.target;
            let receipt = personal_skill_reservation_path(&fixture.library);
            let original = fs::read(&receipt).unwrap();
            let index = fixture.targets[0]
                .scope_root
                .join(".agentkib/skill-personal-library-roots.json");
            let original_index = fs::read(&index).unwrap();
            let preview = preview.unwrap_or_else(|| {
                prepare_from(&other, &fixture, SkillDeploymentOperation::Deploy, None).unwrap()
            });
            assert_eq!(preview.targets[0].conflicts.is_empty(), !before_preview);
            assert_eq!(fs::read(&index).unwrap(), original_index);
            let result = other
                .apply(&preview.token, true, true, &fixture.targets, &[])
                .unwrap();
            assert!(!result.results[0].success, "{:?}", result.results);
            assert!(
                result.results[0]
                    .error
                    .as_deref()
                    .unwrap()
                    .contains("owned or reserved")
            );
            assert!(!native.exists());
            assert!(!personal_skill_record_path(&other_root).exists());
            assert_eq!(fs::read(&receipt).unwrap(), original);
            let recovered = fixture
                .manager
                .apply(&journal.operation_id, true, true, &fixture.targets, &[])
                .unwrap();
            assert_eq!(recovered.results[0].status, "recovered");
            let next =
                prepare_from(&other, &fixture, SkillDeploymentOperation::Deploy, None).unwrap();
            assert!(
                other
                    .apply(&next.token, true, true, &fixture.targets, &[])
                    .unwrap()
                    .results[0]
                    .success
            );
            assert!(native.exists());
            let native_hash = directory_hash(native).unwrap();
            assert_eq!(
                fixture
                    .manager
                    .apply(&journal.operation_id, true, true, &fixture.targets, &[])
                    .unwrap()
                    .results[0]
                    .status,
                "recovered"
            );
            assert_eq!(directory_hash(native).unwrap(), native_hash);
        }
    }

    #[test]
    fn personal_deployments_respect_unregistered_ancestor_workspace_ownership() {
        for pending in [false, true] {
            for before_preview in [false, true] {
                let mut fixture = Fixture::new();
                fixture.targets = vec![fixture.targets[1].clone()];
                let mut personal = fixture.targets[0].clone();
                personal.id = "personal-claude".into();
                personal.scope = SkillScope::Personal;
                personal.workspace_id = None;
                personal.scope_root = fixture.workspace.path.join(".claude");
                let other_root = fixture.library.parent().unwrap().join("other-library");
                write_package(&other_root.join("skills/reviewer"), "first");
                let other = DeploymentManager::new(other_root.clone());
                let prepare = || {
                    other
                        .prepare(
                            PrepareSkillDeploymentRequest {
                                operation: SkillDeploymentOperation::Deploy,
                                library_id: Some("reviewer".into()),
                                deployment_id: None,
                                target_ids: vec![personal.id.clone()],
                            },
                            std::slice::from_ref(&personal),
                            &[],
                        )
                        .unwrap()
                };
                let preview = (!before_preview).then(prepare);
                let ownership = if pending {
                    let mut journal = interrupted_first_deployment(&fixture, true, false);
                    journal.targets[0].phase = "reserved".into();
                    fixture.manager.save_journal(&journal).unwrap();
                    project_skill_reservation_path(&fixture.workspace.path)
                } else {
                    let deployed = fixture.deploy(&["claude"]);
                    assert!(deployed.results[0].success);
                    let withdrawn = fixture.apply(&fixture.prepare(
                        SkillDeploymentOperation::Undeploy,
                        deployed.results[0].deployment_id.as_deref(),
                        &[],
                    ));
                    assert!(withdrawn.results[0].success);
                    project_skill_record_path(&fixture.workspace.path)
                };
                let original = fs::read(&ownership).unwrap();
                let project = &fixture.workspace.path;
                let lock = project.join(".agentkib/skill-write.lock");
                fs::remove_file(&lock).unwrap();
                assert!(!project.join(".git").exists());
                assert!(!project.join(".agentkib/manifest.yaml").exists());
                assert!(!project.join(".agentkib/skill-library-roots.json").exists());
                let preview = preview.unwrap_or_else(prepare);
                assert_eq!(preview.targets[0].conflicts.is_empty(), !before_preview);
                assert!(!lock.exists(), "Preview must not create scope locks");
                assert_eq!(fs::read(&ownership).unwrap(), original);
                let report = other
                    .apply(
                        &preview.token,
                        true,
                        true,
                        std::slice::from_ref(&personal),
                        &[],
                    )
                    .unwrap();
                assert!(!report.results[0].success, "{:?}", report.results);
                assert!(
                    report.results[0]
                        .error
                        .as_deref()
                        .unwrap()
                        .contains("owned or reserved")
                );
                assert!(!personal.root.join("reviewer").exists());
                assert!(!personal_skill_record_path(&other_root).exists());
                assert!(!project.join(".agentkib/skill-library-roots.json").exists());
                assert_eq!(fs::read(&ownership).unwrap(), original);
            }
        }
    }

    #[test]
    fn personal_deployment_cannot_block_recovery_of_an_unregistered_workspace_update() {
        let mut fixture = Fixture::new();
        fixture.targets = vec![fixture.targets[1].clone()];
        let deployed = fixture.deploy(&["claude"]);
        assert!(deployed.results[0].success);
        let id = deployed.results[0].deployment_id.as_deref().unwrap();
        let receipt = project_skill_record_path(&fixture.workspace.path);
        let original_receipt = fs::read(&receipt).unwrap();
        write_package(&fixture.library.join("skills/reviewer"), "second");
        let preview = fixture.prepare(SkillDeploymentOperation::Update, Some(id), &[]);
        let (native, original) = {
            let previews = fixture.manager.previews.lock().unwrap();
            let prepared = &previews[&preview.token].targets[0];
            let paths = operation_paths(&prepared.capability, id, &preview.token).unwrap();
            copy_package(prepared.after.as_ref().unwrap(), &paths.incoming).unwrap();
            let target = TargetJournal {
                target_id: prepared.capability.id.clone(),
                capability_ids: prepared.capability_ids.clone(),
                capability: prepared.capability.clone(),
                associated_projects: prepared.associated_projects.clone(),
                before_record: prepared.before_record.clone(),
                after_record: prepared.after_record.clone(),
                before_hash: prepared.before_hash.clone(),
                after_hash: prepared.after_hash.clone(),
                previous_backup_hash: prepared.previous_backup_hash.clone(),
                phase: "backed-up".into(),
                result: None,
            };
            fixture.manager.reserve_target(&target).unwrap();
            move_path(&prepared.after_record.target, &paths.before).unwrap();
            fixture
                .manager
                .save_journal(&OperationJournal {
                    schema_version: 1,
                    operation_id: preview.token.clone(),
                    requires_home_approval: false,
                    targets: vec![target],
                    report: None,
                })
                .unwrap();
            (
                prepared.after_record.target.clone(),
                prepared.before_hash.clone(),
            )
        };
        assert!(!native.exists());
        let mut personal = fixture.targets[0].clone();
        personal.id = "personal-claude".into();
        personal.scope = SkillScope::Personal;
        personal.workspace_id = None;
        personal.scope_root = fixture.workspace.path.join(".claude");
        let other_root = fixture.library.parent().unwrap().join("other-library");
        write_package(&other_root.join("skills/reviewer"), "second");
        let other = DeploymentManager::new(other_root.clone());
        let competing = other
            .prepare(
                PrepareSkillDeploymentRequest {
                    operation: SkillDeploymentOperation::Deploy,
                    library_id: Some("reviewer".into()),
                    deployment_id: None,
                    target_ids: vec![personal.id.clone()],
                },
                std::slice::from_ref(&personal),
                &[],
            )
            .unwrap();
        assert!(!competing.targets[0].conflicts.is_empty());
        let blocked = other
            .apply(
                &competing.token,
                true,
                true,
                std::slice::from_ref(&personal),
                &[],
            )
            .unwrap();
        assert!(!blocked.results[0].success);
        assert!(!native.exists());
        assert!(!personal_skill_record_path(&other_root).exists());
        let restarted = DeploymentManager::new(fixture.library.clone());
        let recovered = restarted
            .apply(
                &preview.token,
                true,
                false,
                &fixture.targets,
                &fixture.workspaces(),
            )
            .unwrap();
        assert_eq!(
            recovered.results[0].status, "recovered",
            "{:?}",
            recovered.results
        );
        assert_eq!(directory_hash(&native).unwrap(), original);
        assert_eq!(fs::read(receipt).unwrap(), original_receipt);
        assert!(
            project_skill_reservations(&fixture.workspace.path)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn preactivation_recovery_preserves_a_later_same_content_personal_deployment() {
        for phase in ["reserved", "staged"] {
            let mut fixture = Fixture::new();
            personal_outside_project(&mut fixture);
            let mut journal = interrupted_first_deployment(&fixture, true, false);
            journal.targets[0].phase = phase.into();
            fixture.manager.save_journal(&journal).unwrap();
            // Older journals did not establish a cross-library scope index. Reproduce that
            // durable state, then install through B exactly as the old implementation allowed.
            fs::remove_file(
                fixture.targets[0]
                    .scope_root
                    .join(".agentkib/skill-personal-library-roots.json"),
            )
            .unwrap();
            let other_root = fixture.library.parent().unwrap().join("other-library");
            write_package(&other_root.join("skills/reviewer"), "first");
            let other = DeploymentManager::new(other_root.clone());
            let preview =
                prepare_from(&other, &fixture, SkillDeploymentOperation::Deploy, None).unwrap();
            assert!(
                other
                    .apply(&preview.token, true, true, &fixture.targets, &[])
                    .unwrap()
                    .results[0]
                    .success
            );
            let native = &journal.targets[0].after_record.target;
            let current = directory_hash(native).unwrap();
            assert_eq!(current, journal.targets[0].after_hash);
            let receipt = personal_skill_record_path(&other_root);
            let original = fs::read(&receipt).unwrap();
            // Authorization loss must not discard the phase that proves no native writes ran.
            let denied = fixture
                .manager
                .apply(&journal.operation_id, true, true, &[], &[])
                .unwrap();
            assert!(!denied.warnings.is_empty());
            assert_eq!(
                fixture
                    .manager
                    .load_journal(&journal.operation_id)
                    .unwrap()
                    .unwrap()
                    .targets[0]
                    .phase,
                phase
            );
            let restarted = DeploymentManager::new(fixture.library.clone());
            let result = restarted
                .apply(&journal.operation_id, true, true, &fixture.targets, &[])
                .unwrap();
            assert_eq!(
                result.results[0].status, "recovered",
                "{:?}",
                result.results
            );
            assert_eq!(directory_hash(native).unwrap(), current);
            assert_eq!(fs::read(receipt).unwrap(), original);
            assert!(
                personal_skill_reservations(&fixture.library)
                    .unwrap()
                    .is_empty()
            );
        }
    }

    #[test]
    fn later_workspace_deployment_observes_and_locks_an_existing_personal_scope() {
        for before_preview in [false, true] {
            let mut fixture = Fixture::new();
            let workspace = fixture.workspace.clone();
            let workspace_target = fixture.targets[1].clone();
            personal_inside_project(&mut fixture);
            // The personal deployment predates discovery/registration of its ancestor project.
            fixture.workspace.path = fixture.library.parent().unwrap().join("unrelated-project");
            fs::create_dir(&fixture.workspace.path).unwrap();
            let other_root = fixture.library.parent().unwrap().join("other-library");
            write_package(&other_root.join("skills/reviewer"), "first");
            let other = DeploymentManager::new(other_root);
            let prepare = || {
                other
                    .prepare(
                        PrepareSkillDeploymentRequest {
                            operation: SkillDeploymentOperation::Deploy,
                            library_id: Some("reviewer".into()),
                            deployment_id: None,
                            target_ids: vec![workspace_target.id.clone()],
                        },
                        std::slice::from_ref(&workspace_target),
                        std::slice::from_ref(&workspace),
                    )
                    .unwrap()
            };
            let preview = (!before_preview).then(prepare);
            let mut journal = interrupted_first_deployment(&fixture, true, false);
            journal.targets[0].phase = "reserved".into();
            fixture.manager.save_journal(&journal).unwrap();
            assert!(journal.targets[0].associated_projects.is_empty());
            assert!(
                !workspace
                    .path
                    .join(".agentkib/skill-library-roots.json")
                    .exists()
            );
            let preview = preview.unwrap_or_else(prepare);
            assert_eq!(preview.targets[0].conflicts.is_empty(), !before_preview);
            let result = other
                .apply(
                    &preview.token,
                    true,
                    false,
                    std::slice::from_ref(&workspace_target),
                    std::slice::from_ref(&workspace),
                )
                .unwrap();
            assert!(!result.results[0].success);
            assert!(
                result.results[0]
                    .error
                    .as_deref()
                    .unwrap()
                    .contains("owned or reserved")
            );
            assert!(!workspace_target.root.join("reviewer").exists());
            assert!(!project_skill_record_path(&workspace.path).exists());
            // Once A releases its reservation, B still has to serialize on the indexed
            // personal scope, in addition to its own workspace lock.
            let recovered = fixture
                .manager
                .apply(&journal.operation_id, true, true, &fixture.targets, &[])
                .unwrap();
            assert_eq!(recovered.results[0].status, "recovered");
            let next = prepare();
            assert!(next.targets[0].conflicts.is_empty());
            let lock = fixture.targets[0]
                .scope_root
                .join(".agentkib/skill-write.lock");
            fs::remove_file(&lock).unwrap();
            fs::create_dir(&lock).unwrap();
            let blocked = other
                .apply(
                    &next.token,
                    true,
                    false,
                    std::slice::from_ref(&workspace_target),
                    std::slice::from_ref(&workspace),
                )
                .unwrap();
            assert!(!blocked.results[0].success);
            assert!(
                blocked.results[0]
                    .error
                    .as_deref()
                    .unwrap()
                    .contains("Skill write lock must be a regular file")
            );
            assert!(!workspace_target.root.join("reviewer").exists());
        }
    }

    #[test]
    fn staged_update_recovery_restores_a_package_moved_before_the_next_phase_was_saved() {
        let fixture = Fixture::new();
        let deployed = fixture.deploy(&["codex"]);
        let id = deployed.results[0].deployment_id.as_deref().unwrap();
        write_package(&fixture.library.join("skills/reviewer"), "second");
        let preview = fixture.prepare(SkillDeploymentOperation::Update, Some(id), &[]);
        let (native, original) = {
            let previews = fixture.manager.previews.lock().unwrap();
            let prepared = &previews[&preview.token].targets[0];
            let paths = operation_paths(&prepared.capability, id, &preview.token).unwrap();
            copy_package(prepared.after.as_ref().unwrap(), &paths.incoming).unwrap();
            let target = TargetJournal {
                target_id: prepared.capability.id.clone(),
                capability_ids: prepared.capability_ids.clone(),
                capability: prepared.capability.clone(),
                associated_projects: prepared.associated_projects.clone(),
                before_record: prepared.before_record.clone(),
                after_record: prepared.after_record.clone(),
                before_hash: prepared.before_hash.clone(),
                after_hash: prepared.after_hash.clone(),
                previous_backup_hash: prepared.previous_backup_hash.clone(),
                phase: "staged".into(),
                result: None,
            };
            fixture.manager.reserve_target(&target).unwrap();
            fixture
                .manager
                .save_journal(&OperationJournal {
                    schema_version: 1,
                    operation_id: preview.token.clone(),
                    requires_home_approval: false,
                    targets: vec![target],
                    report: None,
                })
                .unwrap();
            move_path(&prepared.after_record.target, &paths.before).unwrap();
            (
                prepared.after_record.target.clone(),
                prepared.before_hash.clone(),
            )
        };
        assert!(!native.exists());
        let restarted = DeploymentManager::new(fixture.library.clone());
        let result = restarted
            .apply(
                &preview.token,
                true,
                false,
                &fixture.targets,
                &fixture.workspaces(),
            )
            .unwrap();
        assert_eq!(
            result.results[0].status, "recovered",
            "{:?}",
            result.results
        );
        assert_eq!(directory_hash(&native).unwrap(), original);
    }

    #[test]
    fn first_deployment_reservation_survives_crashes_and_reregistration_until_recovery() {
        for activate in [false, true] {
            let mut fixture = Fixture::new();
            // planned + reservation covers a failure persisting the reserved journal phase.
            let journal = interrupted_first_deployment(&fixture, true, activate);
            let native = journal.targets[0].after_record.target.clone();
            let reservation_path = project_skill_reservation_path(&fixture.workspace.path);
            let reservation = fs::read(&reservation_path).unwrap();
            assert!(
                agentkib_core::is_project_skill_owned(&fixture.workspace.path, &native).unwrap()
            );
            assert!(!project_skill_record_path(&fixture.workspace.path).exists());
            fixture.reregister();
            let records = fixture.manager.list(&fixture.workspaces()).unwrap();
            assert_eq!(records.len(), 1);
            assert_eq!(records[0].status, "recovery-required");
            assert_eq!(records[0].workspace_id, Some(fixture.workspace.id.clone()));
            assert_eq!(fs::read(&reservation_path).unwrap(), reservation);
            let conflicting = fixture.prepare(
                SkillDeploymentOperation::Deploy,
                None,
                &[&fixture.targets[0].id],
            );
            assert!(!conflicting.targets[0].conflicts.is_empty());

            let restarted = DeploymentManager::new(fixture.library.clone());
            let report = restarted
                .apply(
                    &journal.operation_id,
                    true,
                    false,
                    &fixture.targets,
                    &fixture.workspaces(),
                )
                .unwrap();
            assert_eq!(report.results[0].status, "recovered", "{:?}", report);
            assert!(!native.exists());
            assert!(
                project_skill_reservations(&fixture.workspace.path)
                    .unwrap()
                    .is_empty()
            );
            assert!(
                !agentkib_core::is_project_skill_owned(&fixture.workspace.path, &native).unwrap()
            );
            assert_eq!(
                serde_json::to_value(
                    restarted
                        .apply(
                            &journal.operation_id,
                            true,
                            false,
                            &fixture.targets,
                            &fixture.workspaces()
                        )
                        .unwrap()
                )
                .unwrap(),
                serde_json::to_value(report).unwrap()
            );
            assert!(fixture.deploy(&[&fixture.targets[0].id]).results[0].success);
            assert!(
                project_skill_reservations(&fixture.workspace.path)
                    .unwrap()
                    .is_empty()
            );
        }
    }

    #[test]
    fn old_journal_gets_a_reservation_only_during_explicit_recovery_and_preserves_external_edits() {
        let fixture = Fixture::new();
        let journal = interrupted_first_deployment(&fixture, false, true);
        let native = &journal.targets[0].after_record.target;
        let original = fs::read(native.join("SKILL.md")).unwrap();
        let reservation_path = project_skill_reservation_path(&fixture.workspace.path);
        assert_eq!(
            fixture.manager.list(&fixture.workspaces()).unwrap()[0].status,
            "recovery-required"
        );
        assert!(!reservation_path.exists());
        fs::write(native.join("SKILL.md"), "external edit").unwrap();
        let failed = fixture
            .manager
            .apply(
                &journal.operation_id,
                true,
                false,
                &fixture.targets,
                &fixture.workspaces(),
            )
            .unwrap();
        assert_eq!(failed.results[0].status, "recovery-required");
        assert_eq!(
            project_skill_reservations(&fixture.workspace.path)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            fs::read_to_string(native.join("SKILL.md")).unwrap(),
            "external edit"
        );
        fs::write(native.join("SKILL.md"), original).unwrap();
        let report = fixture
            .manager
            .apply(
                &journal.operation_id,
                true,
                false,
                &fixture.targets,
                &fixture.workspaces(),
            )
            .unwrap();
        assert_eq!(report.results[0].status, "recovered");
        assert!(
            project_skill_reservations(&fixture.workspace.path)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn planned_recovery_preserves_later_legacy_claims_even_after_temporary_authorization_loss() {
        for reserve in [false, true] {
            for lose_authorization in [false, true] {
                let mut fixture = Fixture::new();
                let journal = interrupted_first_deployment(&fixture, reserve, false);
                let record = journal.targets[0].after_record.clone();
                assert!(!record.target.exists());
                if lose_authorization {
                    let unauthorized = fixture
                        .manager
                        .apply(&journal.operation_id, true, false, &[], &[])
                        .unwrap();
                    assert!(!unauthorized.warnings.is_empty());
                    let persisted = fixture
                        .manager
                        .load_journal(&journal.operation_id)
                        .unwrap()
                        .unwrap();
                    assert_eq!(persisted.targets[0].phase, "planned");
                    assert!(persisted.targets[0].result.is_none());
                }
                write_package(&record.target, "later legacy installation");
                manifest(
                    &fixture.workspace.path,
                    SkillDefinition {
                        name: "reviewer".into(),
                        path: ".agents/skills/reviewer".into(),
                        targets: vec![AgentKind::Codex],
                    },
                );
                let original = directory_hash(&record.target).unwrap();
                let manifest_path = agentkib_core::manifest_path(&fixture.workspace.path);
                let original_manifest = fs::read(&manifest_path).unwrap();
                fixture.reregister();
                let restarted = DeploymentManager::new(fixture.library.clone());
                let report = restarted
                    .apply(
                        &journal.operation_id,
                        true,
                        false,
                        &fixture.targets,
                        &fixture.workspaces(),
                    )
                    .unwrap();
                assert_eq!(report.results[0].status, "recovered");
                assert!(report.warnings.is_empty(), "{:?}", report.warnings);
                assert_eq!(directory_hash(&record.target).unwrap(), original);
                assert_eq!(fs::read(&manifest_path).unwrap(), original_manifest);
                assert!(
                    project_skill_reservations(&fixture.workspace.path)
                        .unwrap()
                        .is_empty()
                );
                assert!(!restarted.pending_target(&record.target).unwrap());
            }
        }
    }

    #[test]
    fn committed_cleanup_retries_without_losing_success_or_overwriting_changed_reservations() {
        let mut fixture = Fixture::new();
        let mut journal = interrupted_first_deployment(&fixture, true, true);
        let record = journal.targets[0].after_record.clone();
        fixture.manager.save_record(&record, None).unwrap();
        journal.targets[0].result = Some(result_for(
            &journal.targets[0].target_id,
            &record,
            true,
            "current",
            None,
        ));
        let reservation_path = project_skill_reservation_path(&fixture.workspace.path);
        let original = fs::read(&reservation_path).unwrap();
        let mut edited = record.clone();
        edited.diagnostics.push("external reservation edit".into());
        let edited = encode_skill_deployment_records(&SkillDeploymentRecords {
            schema_version: 1,
            deployments: vec![edited],
        })
        .unwrap();
        fs::write(&reservation_path, &edited).unwrap();
        assert!(
            fixture
                .manager
                .finish_target_reservation(&mut journal, 0)
                .is_err()
        );
        assert_eq!(journal.targets[0].phase, "committed-cleanup");
        assert!(journal.targets[0].result.as_ref().unwrap().success);
        assert_eq!(fs::read(&reservation_path).unwrap(), edited);
        journal.targets[0].result.as_mut().unwrap().error = Some(
            "Skill deployment completed, but reservation cleanup is pending; retry this operation"
                .into(),
        );
        journal.report = Some(journal_report(&journal));
        fixture.manager.save_journal(&journal).unwrap();
        let failed = fixture
            .manager
            .apply(
                &journal.operation_id,
                true,
                false,
                &fixture.targets,
                &fixture.workspaces(),
            )
            .unwrap();
        assert!(failed.results[0].success);
        assert!(!failed.warnings.is_empty());
        assert_eq!(fs::read(&reservation_path).unwrap(), edited);
        fs::write(&reservation_path, original).unwrap();
        fixture.reregister();
        fs::write(record.target.join("SKILL.md"), "later native edit").unwrap();
        let recovered = fixture
            .manager
            .apply(
                &journal.operation_id,
                true,
                false,
                &fixture.targets,
                &fixture.workspaces(),
            )
            .unwrap();
        assert!(recovered.results[0].success);
        assert!(recovered.results[0].error.is_none());
        assert!(recovered.warnings.is_empty());
        assert!(
            project_skill_reservations(&fixture.workspace.path)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            fs::read_to_string(record.target.join("SKILL.md")).unwrap(),
            "later native edit"
        );
    }

    #[test]
    fn compensated_cleanup_never_touches_a_reused_native_target() {
        for already_released in [false, true] {
            let mut fixture = Fixture::new();
            let mut journal = interrupted_first_deployment(&fixture, true, true);
            let record = journal.targets[0].after_record.clone();
            fixture
                .manager
                .recover_target(
                    &journal.operation_id,
                    &journal.targets[0],
                    &fixture.targets,
                    &fixture.workspaces(),
                )
                .unwrap();
            assert!(!record.target.exists());
            assert_eq!(
                project_skill_reservations(&fixture.workspace.path)
                    .unwrap()
                    .len(),
                1
            );
            journal.targets[0].phase = "compensated-cleanup".into();
            journal.targets[0].result = Some(result_for(
                &journal.targets[0].target_id,
                &record,
                false,
                "recovered",
                None,
            ));
            journal.report = Some(journal_report(&journal));
            fixture.manager.save_journal(&journal).unwrap();
            if already_released {
                fixture
                    .manager
                    .release_target_reservation(&journal.targets[0])
                    .unwrap();
            } else {
                assert!(
                    !fixture
                        .prepare(SkillDeploymentOperation::Deploy, None, &["codex"])
                        .targets[0]
                        .conflicts
                        .is_empty()
                );
            }
            // Simulate a later legacy claim after release, or a manual edit while cleanup is pending.
            write_package(&record.target, "later installation");
            manifest(
                &fixture.workspace.path,
                SkillDefinition {
                    name: "reviewer".into(),
                    path: ".agents/skills/reviewer".into(),
                    targets: vec![AgentKind::Codex],
                },
            );
            let native_hash = directory_hash(&record.target).unwrap();
            fixture.reregister();
            let restarted = DeploymentManager::new(fixture.library.clone());
            let report = restarted
                .apply(
                    &journal.operation_id,
                    true,
                    false,
                    &fixture.targets,
                    &fixture.workspaces(),
                )
                .unwrap();
            assert_eq!(report.results[0].status, "recovered");
            assert!(report.warnings.is_empty(), "{:?}", report.warnings);
            assert_eq!(directory_hash(&record.target).unwrap(), native_hash);
            assert!(
                project_skill_reservations(&fixture.workspace.path)
                    .unwrap()
                    .is_empty()
            );
            assert!(!restarted.pending_target(&record.target).unwrap());
        }
    }

    #[test]
    fn old_preview_does_not_bypass_an_interrupted_operation_from_another_manager() {
        for phase in ["planned", "staged", "recovery-required"] {
            let fixture = Fixture::new();
            let interrupted = fixture.prepare(SkillDeploymentOperation::Deploy, None, &["codex"]);
            let other = DeploymentManager::new(fixture.library.clone());
            let preview = other
                .prepare(
                    PrepareSkillDeploymentRequest {
                        operation: SkillDeploymentOperation::Deploy,
                        library_id: Some("reviewer".into()),
                        deployment_id: None,
                        target_ids: vec!["codex".into(), "claude".into()],
                    },
                    &fixture.targets,
                    &fixture.workspaces(),
                )
                .unwrap();
            assert!(
                preview
                    .targets
                    .iter()
                    .all(|target| target.conflicts.is_empty())
            );
            {
                let previews = fixture.manager.previews.lock().unwrap();
                let target = &previews[&interrupted.token].targets[0];
                if phase != "planned" {
                    let paths = operation_paths(
                        &target.capability,
                        &target.after_record.id,
                        &interrupted.token,
                    )
                    .unwrap();
                    copy_package(target.after.as_ref().unwrap(), &paths.incoming).unwrap();
                }
                let mut journal = OperationJournal {
                    schema_version: 1,
                    operation_id: interrupted.token.clone(),
                    requires_home_approval: false,
                    targets: vec![TargetJournal {
                        target_id: target.capability.id.clone(),
                        capability_ids: target.capability_ids.clone(),
                        capability: target.capability.clone(),
                        associated_projects: target.associated_projects.clone(),
                        before_record: target.before_record.clone(),
                        after_record: target.after_record.clone(),
                        before_hash: target.before_hash.clone(),
                        after_hash: target.after_hash.clone(),
                        previous_backup_hash: target.previous_backup_hash.clone(),
                        phase: phase.into(),
                        result: None,
                    }],
                    report: None,
                };
                if phase == "recovery-required" {
                    journal.report = Some(journal_report(&journal));
                }
                fixture.manager.save_journal(&journal).unwrap();
            }
            let interrupted_journal =
                fs::read(fixture.manager.journal_path(&interrupted.token).unwrap()).unwrap();
            let report = other
                .apply(
                    &preview.token,
                    true,
                    true,
                    &fixture.targets,
                    &fixture.workspaces(),
                )
                .unwrap();
            let blocked = report
                .results
                .iter()
                .find(|result| result.target_id == "codex")
                .unwrap();
            assert!(!blocked.success);
            assert_eq!(blocked.status, "conflict");
            assert!(
                blocked
                    .error
                    .as_deref()
                    .unwrap()
                    .contains("requires recovery")
            );
            assert!(
                report
                    .results
                    .iter()
                    .find(|result| result.target_id == "claude")
                    .unwrap()
                    .success
            );
            assert!(!fixture.targets[0].root.join("reviewer").exists());
            assert!(fixture.targets[1].root.join("reviewer").exists());
            assert_eq!(
                fs::read(fixture.manager.journal_path(&interrupted.token).unwrap()).unwrap(),
                interrupted_journal
            );

            let restarted = DeploymentManager::new(fixture.library.clone());
            let recovered = restarted
                .apply(
                    &interrupted.token,
                    true,
                    true,
                    &fixture.targets,
                    &fixture.workspaces(),
                )
                .unwrap();
            assert_eq!(
                recovered.results[0].status, "recovered",
                "{phase}: {:?}",
                recovered.results
            );
            assert!(
                !restarted
                    .pending_target(&fixture.targets[0].root.join("reviewer"))
                    .unwrap()
            );
            let retried = restarted
                .apply(
                    &preview.token,
                    true,
                    true,
                    &fixture.targets,
                    &fixture.workspaces(),
                )
                .unwrap();
            assert_eq!(
                serde_json::to_value(retried).unwrap(),
                serde_json::to_value(report).unwrap()
            );
            assert!(fixture.deploy(&["codex"]).results[0].success);
        }
    }

    #[test]
    fn receipt_count_limit_rolls_back_without_corrupting_existing_records() {
        let fixture = Fixture::new();
        let seed = fixture.prepare(SkillDeploymentOperation::Deploy, None, &["codex"]);
        let template = fixture.manager.previews.lock().unwrap()[&seed.token].targets[0]
            .after_record
            .clone();
        let records = SkillDeploymentRecords {
            schema_version: 1,
            deployments: (0..4096)
                .map(|index| {
                    let mut record = template.clone();
                    record.id = Uuid::new_v4().to_string();
                    record.target = fixture.targets[0].root.join(format!("old-{index}"));
                    record.status = "inactive".into();
                    record.package_hash.clear();
                    record.agents.clear();
                    record.visible_to.clear();
                    record
                })
                .collect(),
        };
        let original = serde_json::to_vec(&records).unwrap();
        let path = project_skill_record_path(&fixture.workspace.path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, &original).unwrap();
        assert_eq!(read_skill_deployment_records(&path).unwrap().len(), 4096);
        let preview = fixture.prepare(SkillDeploymentOperation::Deploy, None, &["codex"]);
        assert!(preview.targets[0].conflicts.is_empty());
        let report = fixture.apply(&preview);
        assert!(!report.results[0].success);
        assert_eq!(report.results[0].status, "failed");
        assert_eq!(
            report.results[0].error.as_deref(),
            Some("Too many Skill deployment records")
        );
        assert_eq!(fs::read(&path).unwrap(), original);
        assert_eq!(
            fixture.manager.list(&fixture.workspaces()).unwrap().len(),
            4096
        );
        let native = fixture.targets[0].root.join("reviewer");
        assert!(!native.exists());
        assert!(!fixture.manager.pending_target(&native).unwrap());
        assert_eq!(
            serde_json::to_value(fixture.apply(&preview)).unwrap(),
            serde_json::to_value(report).unwrap()
        );
    }

    #[test]
    fn receipt_size_limit_restores_the_native_package_and_previous_backup() {
        for operation in [
            SkillDeploymentOperation::Update,
            SkillDeploymentOperation::Undeploy,
        ] {
            let fixture = Fixture::new();
            let deployed = fixture.deploy(&["codex"]);
            let id = deployed.results[0].deployment_id.as_deref().unwrap();
            if operation == SkillDeploymentOperation::Undeploy {
                write_package(&fixture.library.join("skills/reviewer"), "second version");
                let update = fixture.prepare(SkillDeploymentOperation::Update, Some(id), &[]);
                assert!(fixture.apply(&update).results[0].success);
            }
            let path = project_skill_record_path(&fixture.workspace.path);
            let mut records = read_skill_deployment_records(&path).unwrap();
            let mut padding = records[0].clone();
            padding.id = Uuid::new_v4().to_string();
            padding.target = fixture.targets[0].root.join("inactive");
            padding.status = "inactive".into();
            padding.diagnostics = vec![String::new()];
            records.push(padding);
            let mut envelope = SkillDeploymentRecords {
                schema_version: 1,
                deployments: records,
            };
            let initial_size = encode_skill_deployment_records(&envelope).unwrap().len();
            envelope.deployments[1].diagnostics[0] = "x".repeat(4 * 1024 * 1024 - initial_size);
            let original = encode_skill_deployment_records(&envelope).unwrap();
            assert_eq!(original.len(), 4 * 1024 * 1024);
            fs::write(&path, &original).unwrap();
            assert_eq!(read_skill_deployment_records(&path).unwrap().len(), 2);

            let native = fixture.targets[0].root.join("reviewer");
            let original_hash = directory_hash(&native).unwrap();
            write_package(&fixture.library.join("skills/reviewer"), "updated");
            let preview = fixture.prepare(operation, Some(id), &[]);
            assert!(preview.targets[0].conflicts.is_empty());
            let backup = operation_paths(&fixture.targets[0], id, &preview.token)
                .unwrap()
                .backup;
            let original_backup_hash = directory_hash(&backup).unwrap();
            assert_eq!(
                original_backup_hash.is_some(),
                operation == SkillDeploymentOperation::Undeploy
            );
            let report = fixture.apply(&preview);
            assert!(!report.results[0].success);
            assert_eq!(report.results[0].status, "failed");
            assert_eq!(
                report.results[0].error.as_deref(),
                Some("Skill deployment records exceed the size limit")
            );
            assert_eq!(fs::read(&path).unwrap(), original);
            assert_eq!(directory_hash(&native).unwrap(), original_hash);
            assert_eq!(directory_hash(&backup).unwrap(), original_backup_hash);
            assert_eq!(
                fixture.manager.list(&fixture.workspaces()).unwrap().len(),
                2
            );
            assert!(!fixture.manager.pending_target(&native).unwrap());
            assert_eq!(
                serde_json::to_value(fixture.apply(&preview)).unwrap(),
                serde_json::to_value(report).unwrap()
            );
        }
    }

    #[test]
    fn full_package_deploy_update_rollback_undeploy_and_retry_are_durable() {
        let fixture = Fixture::new();
        let first_hash = package_hash(&fixture.library.join("skills/reviewer"))
            .unwrap()
            .0;
        let preview = fixture.prepare(SkillDeploymentOperation::Deploy, None, &["codex"]);
        let binary = fixture
            .manager
            .read_preview_file(&preview.token, "codex", "assets/picture.bin")
            .unwrap();
        assert!(binary.binary);
        assert!(binary.after.is_none());
        assert_eq!(binary.after_size, Some(5));
        let report = fixture.apply(&preview);
        assert!(report.results[0].success, "{:?}", report.results);
        let id = report.results[0].deployment_id.clone().unwrap();
        let target = fixture.targets[0].root.join("reviewer");
        assert_eq!(package_hash(&target).unwrap().0, first_hash);
        assert!(target.join("agents/openai.yaml").is_file());
        assert!(target.join("LICENSE").is_file());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_ne!(
                fs::metadata(target.join("run.sh"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o111,
                0
            );
        }
        let restarted = DeploymentManager::new(fixture.library.clone());
        assert!(
            restarted
                .apply(
                    &preview.token,
                    true,
                    true,
                    &fixture.targets,
                    &fixture.workspaces()
                )
                .unwrap()
                .results[0]
                .success
        );
        write_package(&fixture.library.join("skills/reviewer"), "second");
        let update =
            fixture.apply(&fixture.prepare(SkillDeploymentOperation::Update, Some(&id), &[]));
        assert!(update.results[0].success, "{:?}", update.results);
        assert_ne!(package_hash(&target).unwrap().0, first_hash);
        let rollback =
            fixture.apply(&fixture.prepare(SkillDeploymentOperation::Rollback, Some(&id), &[]));
        assert!(rollback.results[0].success, "{:?}", rollback.results);
        assert_eq!(package_hash(&target).unwrap().0, first_hash);
        let removal =
            fixture.apply(&fixture.prepare(SkillDeploymentOperation::Undeploy, Some(&id), &[]));
        assert!(removal.results[0].success, "{:?}", removal.results);
        assert!(!target.exists());
        assert!(
            !fixture
                .manager
                .has_active_deployments("reviewer", &[])
                .unwrap()
        );
        let restore =
            fixture.apply(&fixture.prepare(SkillDeploymentOperation::Rollback, Some(&id), &[]));
        assert!(restore.results[0].success, "{:?}", restore.results);
        assert_eq!(package_hash(&target).unwrap().0, first_hash);
    }

    #[test]
    fn reregistered_workspace_lifecycle_migrates_receipts_only_after_apply() {
        let mut fixture = Fixture::new();
        let first_hash = package_hash(&fixture.library.join("skills/reviewer"))
            .unwrap()
            .0;
        let deployed = fixture.deploy(&["codex"]);
        assert!(deployed.results[0].success);
        let id = deployed.results[0].deployment_id.as_deref().unwrap();
        write_package(&fixture.library.join("skills/reviewer"), "second");
        let second_hash = package_hash(&fixture.library.join("skills/reviewer"))
            .unwrap()
            .0;
        let path = project_skill_record_path(&fixture.workspace.path);
        let native = fixture.targets[0].root.join("reviewer");
        for (operation, expected) in [
            (SkillDeploymentOperation::Update, Some(second_hash)),
            (SkillDeploymentOperation::Rollback, Some(first_hash)),
            (SkillDeploymentOperation::Undeploy, None),
        ] {
            let original = fs::read(&path).unwrap();
            fixture.reregister();
            let records = fixture.manager.list(&fixture.workspaces()).unwrap();
            assert_eq!(
                records[0].workspace_id.as_deref(),
                Some(fixture.workspace.id.as_str())
            );
            let preview = fixture.prepare(operation, Some(id), &[]);
            assert!(preview.targets[0].conflicts.is_empty());
            assert_eq!(
                preview.targets[0].workspace_id,
                Some(fixture.workspace.id.clone())
            );
            assert_eq!(fs::read(&path).unwrap(), original);
            let applied = fixture.apply(&preview);
            assert!(applied.results[0].success, "{:?}", applied.results);
            assert_eq!(directory_hash(&native).unwrap(), expected);
            assert_eq!(
                read_skill_deployment_records(&path).unwrap()[0].workspace_id,
                Some(fixture.workspace.id.clone())
            );
        }
    }

    #[test]
    fn old_preview_rebinds_registration_without_accepting_receipt_drift() {
        for edit_receipt in [false, true] {
            let mut fixture = Fixture::new();
            let deployed = fixture.deploy(&["codex"]);
            assert!(deployed.results[0].success);
            let id = deployed.results[0].deployment_id.as_deref().unwrap();
            let native = fixture.targets[0].root.join("reviewer");
            let original_hash = directory_hash(&native).unwrap();
            write_package(&fixture.library.join("skills/reviewer"), "second");
            let preview = fixture.prepare(SkillDeploymentOperation::Update, Some(id), &[]);
            let receipt_path = project_skill_record_path(&fixture.workspace.path);
            let mut records = read_skill_deployment_records(&receipt_path).unwrap();
            fixture.reregister();
            if edit_receipt {
                records[0].diagnostics.push("external receipt edit".into());
                fs::write(
                    &receipt_path,
                    serde_json::to_vec(&SkillDeploymentRecords {
                        schema_version: 1,
                        deployments: records,
                    })
                    .unwrap(),
                )
                .unwrap();
            }
            let original_receipt = fs::read(&receipt_path).unwrap();
            let report = fixture.apply(&preview);
            assert_eq!(
                report.results[0].success, !edit_receipt,
                "{:?}",
                report.results
            );
            assert_eq!(report.results[0].target_id, preview.targets[0].target_id);
            if edit_receipt {
                assert_eq!(directory_hash(&native).unwrap(), original_hash);
                assert_eq!(fs::read(&receipt_path).unwrap(), original_receipt);
            } else {
                assert_ne!(directory_hash(&native).unwrap(), original_hash);
                assert_eq!(
                    read_skill_deployment_records(&receipt_path).unwrap()[0].workspace_id,
                    Some(fixture.workspace.id.clone())
                );
            }
        }
    }

    #[test]
    fn old_shared_preview_requires_every_selected_agent_after_reregistration() {
        for remove_secondary in [false, true] {
            let mut fixture = Fixture::new();
            let mut shared = fixture.targets[0].clone();
            shared.agent = AgentKind::Antigravity;
            fixture.targets.push(shared);
            fixture.refresh_registration();
            let ids = [fixture.targets[0].id.clone(), fixture.targets[2].id.clone()];
            let preview =
                fixture.prepare(SkillDeploymentOperation::Deploy, None, &[&ids[0], &ids[1]]);
            assert_eq!(preview.targets.len(), 1);
            fixture.reregister();
            if remove_secondary {
                fixture.targets.pop();
            }
            let report = fixture.apply(&preview);
            assert_eq!(
                report.results[0].success, !remove_secondary,
                "{:?}",
                report.results
            );
            let native = fixture.targets[0].root.join("reviewer");
            assert_eq!(native.exists(), !remove_secondary);
            if !remove_secondary {
                let records = fixture.manager.list(&fixture.workspaces()).unwrap();
                assert_eq!(
                    records[0].agents,
                    vec![AgentKind::Codex, AgentKind::Antigravity]
                );
                assert_eq!(records[0].workspace_id, Some(fixture.workspace.id.clone()));
            }
        }
    }

    #[test]
    fn registration_rebinding_rejects_changed_directories_agents_scopes_and_permissions() {
        for change in [
            "scope-root",
            "native-root",
            "agent",
            "scope",
            "writable",
            "registration",
        ] {
            let mut fixture = Fixture::new();
            let preview = fixture.prepare(SkillDeploymentOperation::Deploy, None, &["codex"]);
            let native = fixture.targets[0].root.join("reviewer");
            fixture.reregister();
            match change {
                "scope-root" => {
                    let other = fixture.library.parent().unwrap().join("other-project");
                    fs::create_dir_all(&other).unwrap();
                    fixture.workspace.path = other.clone();
                    fixture.targets[0].scope_root = other.clone();
                    fixture.targets[0].root = other.join(".agents/skills");
                }
                "native-root" => {
                    fixture.targets[0].root = fixture.workspace.path.join("other-skills");
                }
                "agent" => fixture.targets[0].agent = AgentKind::Antigravity,
                "scope" => {
                    fixture.targets[0].scope = SkillScope::Personal;
                    fixture.targets[0].workspace_id = None;
                }
                "writable" => {
                    fixture.targets[0].writable = false;
                    fixture.targets[0].reason = Some("Native configuration changed".into());
                }
                "registration" => fixture.workspace.id = "unrelated-workspace".into(),
                _ => unreachable!(),
            }
            let report = fixture
                .manager
                .apply(
                    &preview.token,
                    true,
                    false,
                    &fixture.targets,
                    &fixture.workspaces(),
                )
                .unwrap();
            assert!(!report.results[0].success, "{change}: {:?}", report.results);
            assert_eq!(report.results[0].status, "conflict", "{change}");
            assert!(!native.exists(), "{change}");
            assert!(
                !fixture.targets[0].root.join("reviewer").exists(),
                "{change}"
            );
        }
    }

    #[test]
    fn home_approval_does_not_consume_preview_or_touch_native_directory() {
        let mut fixture = Fixture::new();
        let home = fixture.library.parent().unwrap().join("native-home");
        fixture.targets[0].scope = SkillScope::Personal;
        fixture.targets[0].workspace_id = None;
        fixture.targets[0].scope_root = home.clone();
        fixture.targets[0].root = home.join("skills");
        let preview = fixture.prepare(SkillDeploymentOperation::Deploy, None, &["codex"]);
        assert!(preview.requires_home_approval);
        assert!(
            fixture
                .manager
                .apply(&preview.token, true, false, &fixture.targets, &[])
                .is_err()
        );
        assert!(!home.exists());
        assert!(
            fixture
                .manager
                .apply(&preview.token, true, true, &fixture.targets, &[])
                .unwrap()
                .results[0]
                .success
        );
    }

    #[test]
    fn mixed_scope_retry_and_recovery_do_not_require_approval_for_terminal_personal_targets() {
        for personal_conflict in [false, true] {
            let mut fixture = Fixture::new();
            let home = fixture.library.parent().unwrap().join("native-home");
            fixture.targets[1].scope = SkillScope::Personal;
            fixture.targets[1].workspace_id = None;
            fixture.targets[1].scope_root = home.clone();
            fixture.targets[1].root = home.join("skills");
            let personal = home.join("skills/reviewer");
            if personal_conflict {
                write_package(&personal, "external installation");
            }
            let preview =
                fixture.prepare(SkillDeploymentOperation::Deploy, None, &["codex", "claude"]);
            assert_eq!(preview.requires_home_approval, !personal_conflict);
            let report = fixture
                .manager
                .apply(
                    &preview.token,
                    true,
                    !personal_conflict,
                    &fixture.targets,
                    &fixture.workspaces(),
                )
                .unwrap();
            assert_eq!(
                report
                    .results
                    .iter()
                    .filter(|result| result.success)
                    .count(),
                if personal_conflict { 1 } else { 2 }
            );
            let personal_hash = directory_hash(&personal).unwrap();
            let restarted = DeploymentManager::new(fixture.library.clone());
            // Returning the durable report is read-only, even when the completed plan
            // originally required approval for a personal deployment.
            let retried = restarted
                .apply(
                    &preview.token,
                    true,
                    false,
                    &fixture.targets,
                    &fixture.workspaces(),
                )
                .unwrap();
            assert_eq!(
                serde_json::to_value(&retried).unwrap(),
                serde_json::to_value(&report).unwrap()
            );

            // Recreate the reachable crash state after the project package is activated,
            // before its receipt commits. The personal target has already reached a terminal state.
            let mut journal = restarted.load_journal(&preview.token).unwrap().unwrap();
            let project = journal
                .targets
                .iter_mut()
                .find(|target| target.capability.scope == SkillScope::Workspace)
                .unwrap();
            project.phase = "activated".into();
            project.result = None;
            let native = project.after_record.target.clone();
            restarted.reserve_target(project).unwrap();
            fs::remove_file(project_skill_record_path(&fixture.workspace.path)).unwrap();
            journal.report = None;
            restarted.save_journal(&journal).unwrap();
            if home.join(".agentkib").exists() {
                fs::remove_dir_all(home.join(".agentkib")).unwrap();
            }
            let scopes = restarted
                .authorized_scopes(
                    &journal.targets,
                    &fixture.targets,
                    &fixture.workspaces(),
                    true,
                )
                .unwrap();
            assert!(
                !scopes
                    .iter()
                    .any(|scope| platform_path::equivalent(scope, &home))
            );
            let recovered = restarted
                .apply(
                    &preview.token,
                    true,
                    false,
                    &fixture.targets,
                    &fixture.workspaces(),
                )
                .unwrap();
            assert_eq!(
                recovered
                    .results
                    .iter()
                    .find(|result| result.path == native)
                    .unwrap()
                    .status,
                "recovered"
            );
            assert!(recovered.warnings.is_empty());
            assert!(!native.exists());
            assert_eq!(directory_hash(&personal).unwrap(), personal_hash);
            assert!(!home.join(".agentkib").exists());
            assert!(
                project_skill_reservations(&fixture.workspace.path)
                    .unwrap()
                    .is_empty()
            );
        }
    }

    #[test]
    fn unfinished_personal_recovery_still_requires_home_approval_even_for_an_old_journal() {
        let mut fixture = Fixture::new();
        let home = fixture.library.parent().unwrap().join("native-home");
        fixture.targets[0].scope = SkillScope::Personal;
        fixture.targets[0].workspace_id = None;
        fixture.targets[0].scope_root = home.clone();
        fixture.targets[0].root = home.join("skills");
        let journal = interrupted_first_deployment(&fixture, false, true);
        assert!(!journal.requires_home_approval);
        let journal_path = fixture.manager.journal_path(&journal.operation_id).unwrap();
        let original_journal = fs::read(&journal_path).unwrap();
        let native = &journal.targets[0].after_record.target;
        let original = directory_hash(native).unwrap();
        let restarted = DeploymentManager::new(fixture.library.clone());
        assert!(
            restarted
                .apply(&journal.operation_id, true, false, &fixture.targets, &[])
                .is_err()
        );
        assert_eq!(fs::read(&journal_path).unwrap(), original_journal);
        assert_eq!(directory_hash(native).unwrap(), original);
        assert!(!home.join(".agentkib").exists());
        let recovered = restarted
            .apply(&journal.operation_id, true, true, &fixture.targets, &[])
            .unwrap();
        assert_eq!(recovered.results[0].status, "recovered");
        assert!(!native.exists());
    }

    #[test]
    fn external_conflict_does_not_block_an_independent_target() {
        let fixture = Fixture::new();
        let foreign = fixture.targets[1].root.join("reviewer");
        write_package(&foreign, "foreign");
        let hash = package_hash(&foreign).unwrap().0;
        let preview = fixture.prepare(SkillDeploymentOperation::Deploy, None, &["codex", "claude"]);
        assert_eq!(
            preview
                .targets
                .iter()
                .filter(|target| !target.conflicts.is_empty())
                .count(),
            1
        );
        let report = fixture.apply(&preview);
        assert_eq!(
            report
                .results
                .iter()
                .filter(|target| target.success)
                .count(),
            1
        );
        assert_eq!(package_hash(&foreign).unwrap().0, hash);
        assert!(fixture.targets[0].root.join("reviewer/SKILL.md").is_file());
    }

    #[test]
    fn source_and_native_edits_after_preview_are_preserved() {
        let fixture = Fixture::new();
        let preview = fixture.prepare(SkillDeploymentOperation::Deploy, None, &["codex"]);
        write_package(&fixture.library.join("skills/reviewer"), "source changed");
        let report = fixture.apply(&preview);
        assert!(!report.results[0].success);
        assert!(!fixture.targets[0].root.join("reviewer").exists());
        let deployed = fixture.deploy(&["codex"]);
        assert!(deployed.results[0].success);
        let id = deployed.results[0].deployment_id.as_deref().unwrap();
        let preview = fixture.prepare(SkillDeploymentOperation::Undeploy, Some(id), &[]);
        let native = fixture.targets[0].root.join("reviewer/SKILL.md");
        fs::write(&native, "external edit").unwrap();
        let report = fixture.apply(&preview);
        assert!(!report.results[0].success);
        assert_eq!(fs::read_to_string(native).unwrap(), "external edit");
    }

    #[test]
    fn shared_physical_target_is_written_once_and_retains_all_requested_agents() {
        let mut fixture = Fixture::new();
        let mut shared = fixture.targets[0].clone();
        shared.id = "antigravity".into();
        shared.agent = AgentKind::Antigravity;
        shared.visible_to = vec![AgentKind::Codex, AgentKind::Antigravity];
        fixture.targets.push(shared);
        let preview = fixture.prepare(
            SkillDeploymentOperation::Deploy,
            None,
            &["codex", "antigravity"],
        );
        assert_eq!(preview.targets.len(), 1);
        assert_eq!(preview.targets[0].agents.len(), 2);
        assert!(fixture.apply(&preview).results[0].success);
        let repeat = fixture.deploy(&["codex"]);
        assert!(repeat.results[0].success);
        let records = fixture.manager.list(&fixture.workspaces()).unwrap();
        assert_eq!(records.len(), 1);
        assert!(records[0].agents.contains(&AgentKind::Antigravity));
        assert!(
            fixture
                .manager
                .has_active_deployments("reviewer", &[])
                .unwrap()
        );
        assert_eq!(
            fixture.manager.list(&[]).unwrap()[0].status,
            "unregistered-workspace"
        );
    }

    fn manifest(project: &Path, skill: SkillDefinition) {
        let manifest = Manifest {
            schema_version: 2,
            workspace: WorkspaceIdentity {
                id: "workspace".into(),
                name: "Project".into(),
            },
            instructions: Default::default(),
            skills: vec![skill],
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
        };
        fs::create_dir_all(project.join(".agentkib")).unwrap();
        fs::write(
            agentkib_core::manifest_path(project),
            serde_yaml::to_string(&manifest).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn manifest_claims_before_and_after_preview_block_deployment() {
        let fixture = Fixture::new();
        let preview = fixture.prepare(SkillDeploymentOperation::Deploy, None, &["codex"]);
        manifest(
            &fixture.workspace.path,
            SkillDefinition {
                name: "reviewer".into(),
                path: "source/reviewer".into(),
                targets: vec![AgentKind::Codex],
            },
        );
        assert!(!fixture.apply(&preview).results[0].success);
        let fresh = fixture.prepare(SkillDeploymentOperation::Deploy, None, &["codex"]);
        assert!(!fresh.targets[0].conflicts.is_empty());
        assert!(!fixture.targets[0].root.join("reviewer").exists());
    }

    fn personal_inside_project(fixture: &mut Fixture) {
        fixture.targets.truncate(1);
        fixture.targets[0].agent = AgentKind::ClaudeCode;
        fixture.targets[0].scope = SkillScope::Personal;
        fixture.targets[0].workspace_id = None;
        fixture.targets[0].scope_root = fixture.workspace.path.join(".claude");
        fixture.targets[0].root = fixture.targets[0].scope_root.join("skills");
    }

    #[test]
    fn workspace_deployment_respects_other_libraries_personal_receipts_and_reservations() {
        for pending in [false, true] {
            for after_preview in [false, true] {
                let mut fixture = Fixture::new();
                let workspace_target = fixture.targets[1].clone();
                personal_inside_project(&mut fixture);
                let other_library = fixture.library.parent().unwrap().join("other-library");
                write_package(&other_library.join("skills/reviewer"), "other library");
                let other = DeploymentManager::new(other_library);
                let prepare = || {
                    other
                        .prepare(
                            PrepareSkillDeploymentRequest {
                                operation: SkillDeploymentOperation::Deploy,
                                library_id: Some("reviewer".into()),
                                deployment_id: None,
                                target_ids: vec![workspace_target.id.clone()],
                            },
                            std::slice::from_ref(&workspace_target),
                            &fixture.workspaces(),
                        )
                        .unwrap()
                };
                let preview = after_preview.then(prepare);
                if pending {
                    interrupted_first_deployment(&fixture, true, false);
                } else {
                    let deployed = fixture.deploy(&["codex"]);
                    assert!(deployed.results[0].success);
                    let withdraw = fixture.prepare(
                        SkillDeploymentOperation::Undeploy,
                        deployed.results[0].deployment_id.as_deref(),
                        &[],
                    );
                    assert!(fixture.apply(&withdraw).results[0].success);
                }
                let ownership_path = if pending {
                    personal_skill_reservation_path(&fixture.library)
                } else {
                    personal_skill_record_path(&fixture.library)
                };
                let ownership = fs::read(&ownership_path).unwrap();
                let preview = preview.unwrap_or_else(prepare);
                assert_eq!(preview.targets[0].conflicts.is_empty(), after_preview);
                let report = other
                    .apply(
                        &preview.token,
                        true,
                        false,
                        std::slice::from_ref(&workspace_target),
                        &fixture.workspaces(),
                    )
                    .unwrap();
                assert!(!report.results[0].success, "{pending} {after_preview}");
                assert!(
                    report.results[0]
                        .error
                        .as_deref()
                        .unwrap()
                        .contains("owned or reserved by another Skill deployment")
                );
                assert!(!workspace_target.root.join("reviewer").exists());
                assert!(!project_skill_record_path(&fixture.workspace.path).exists());
                assert_eq!(fs::read(ownership_path).unwrap(), ownership);
            }
        }
    }

    fn withdraw_from_another_library(fixture: &Fixture) -> SkillDeployment {
        let deployed = fixture.deploy(&["codex"]);
        assert!(deployed.results[0].success);
        let other = DeploymentManager::new(fixture.library.parent().unwrap().join("other-library"));
        let preview = other
            .prepare(
                PrepareSkillDeploymentRequest {
                    operation: SkillDeploymentOperation::Undeploy,
                    library_id: None,
                    deployment_id: deployed.results[0].deployment_id.clone(),
                    target_ids: Vec::new(),
                },
                &fixture.targets,
                &fixture.workspaces(),
            )
            .unwrap();
        let report = other
            .apply(
                &preview.token,
                true,
                false,
                &fixture.targets,
                &fixture.workspaces(),
            )
            .unwrap();
        assert!(report.results[0].success, "{:?}", report.results);
        agentkib_core::project_skill_deployments(&fixture.workspace.path)
            .unwrap()
            .remove(0)
    }

    fn prepare_from(
        manager: &DeploymentManager,
        fixture: &Fixture,
        operation: SkillDeploymentOperation,
        deployment_id: Option<&str>,
    ) -> Result<SkillDeploymentPreview> {
        manager.prepare(
            PrepareSkillDeploymentRequest {
                operation,
                library_id: (operation == SkillDeploymentOperation::Deploy)
                    .then(|| "reviewer".into()),
                deployment_id: deployment_id.map(str::to_string),
                target_ids: if operation == SkillDeploymentOperation::Deploy {
                    vec![fixture.targets[0].id.clone()]
                } else {
                    Vec::new()
                },
            },
            &fixture.targets,
            &fixture.workspaces(),
        )
    }

    #[test]
    fn same_name_packages_in_other_libraries_cannot_replace_a_deployment_source() {
        for contents in ["first", "different source"] {
            let fixture = Fixture::new();
            let deployed = fixture.deploy(&["codex"]);
            let id = deployed.results[0].deployment_id.as_deref().unwrap();
            let other_root = fixture.library.parent().unwrap().join("other-library");
            write_package(&other_root.join("skills/reviewer"), contents);
            let other = DeploymentManager::new(other_root);
            let receipt_path = project_skill_record_path(&fixture.workspace.path);
            let receipt = fs::read(&receipt_path).unwrap();
            let native = fixture.targets[0].root.join("reviewer");
            let original = directory_hash(&native).unwrap();
            assert_eq!(
                fixture.manager.list(&fixture.workspaces()).unwrap()[0].library_root,
                Some(fixture.library.clone())
            );
            assert!(
                prepare_from(&other, &fixture, SkillDeploymentOperation::Update, Some(id))
                    .unwrap_err()
                    .to_string()
                    .contains("another source library")
            );
            let preview =
                prepare_from(&other, &fixture, SkillDeploymentOperation::Deploy, None).unwrap();
            assert!(
                preview.targets[0]
                    .conflicts
                    .iter()
                    .any(|error| error.contains("another source library"))
            );
            let report = other
                .apply(
                    &preview.token,
                    true,
                    false,
                    &fixture.targets,
                    &fixture.workspaces(),
                )
                .unwrap();
            assert!(!report.results[0].success);
            assert_eq!(directory_hash(&native).unwrap(), original);
            assert_eq!(fs::read(&receipt_path).unwrap(), receipt);
            assert!(
                !other
                    .has_active_deployments("reviewer", &fixture.workspaces())
                    .unwrap()
            );
            write_package(
                &fixture.library.join("skills/reviewer"),
                "original source update",
            );
            let update = fixture.prepare(SkillDeploymentOperation::Update, Some(id), &[]);
            assert!(fixture.apply(&update).results[0].success);
            assert_eq!(
                directory_hash(&native).unwrap(),
                directory_hash(&fixture.library.join("skills/reviewer")).unwrap()
            );
        }
    }

    #[test]
    fn cross_library_withdrawal_and_rollback_preserve_source_identity() {
        let fixture = Fixture::new();
        let inactive = withdraw_from_another_library(&fixture);
        let other_root = fixture.library.parent().unwrap().join("other-library");
        write_package(&other_root.join("skills/reviewer"), "foreign package");
        let other = DeploymentManager::new(other_root);
        assert_eq!(inactive.library_root, Some(fixture.library.clone()));
        assert!(
            !fixture
                .manager
                .has_active_deployments("reviewer", &[])
                .unwrap()
        );
        assert!(!other.has_active_deployments("reviewer", &[]).unwrap());
        let replace =
            prepare_from(&other, &fixture, SkillDeploymentOperation::Deploy, None).unwrap();
        assert!(!replace.targets[0].conflicts.is_empty());
        let rollback = prepare_from(
            &other,
            &fixture,
            SkillDeploymentOperation::Rollback,
            Some(&inactive.id),
        )
        .unwrap();
        let report = other
            .apply(
                &rollback.token,
                true,
                false,
                &fixture.targets,
                &fixture.workspaces(),
            )
            .unwrap();
        assert!(report.results[0].success, "{:?}", report.results);
        let restored = other.list(&fixture.workspaces()).unwrap().remove(0);
        assert_eq!(restored.library_root, Some(fixture.library.clone()));
        assert_eq!(restored.package_hash, inactive.package_hash);
        assert!(
            fixture
                .manager
                .has_active_deployments("reviewer", &[])
                .unwrap()
        );
        assert!(
            !other
                .has_active_deployments("reviewer", &fixture.workspaces())
                .unwrap()
        );
        assert!(!other.has_active_deployments("reviewer", &[]).unwrap());
        // Reservations protect their source library, not the library that executed lifecycle work.
        fs::write(
            project_skill_reservation_path(&fixture.workspace.path),
            encode_skill_deployment_records(&SkillDeploymentRecords {
                schema_version: 1,
                deployments: vec![restored],
            })
            .unwrap(),
        )
        .unwrap();
        assert!(
            !other
                .has_active_deployments("reviewer", &fixture.workspaces())
                .unwrap()
        );
        assert!(
            fixture
                .manager
                .has_active_deployments("reviewer", &[])
                .unwrap()
        );
    }

    #[test]
    fn legacy_receipts_are_read_without_migration_and_cannot_acquire_a_source_by_name() {
        let fixture = Fixture::new();
        let deployed = fixture.deploy(&["codex"]);
        let receipt_path = project_skill_record_path(&fixture.workspace.path);
        let mut legacy = agentkib_core::project_skill_deployments(&fixture.workspace.path)
            .unwrap()
            .remove(0);
        legacy.library_root = None;
        let bytes = encode_skill_deployment_records(&SkillDeploymentRecords {
            schema_version: 1,
            deployments: vec![legacy.clone()],
        })
        .unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("library_root"));
        fs::write(&receipt_path, &bytes).unwrap();
        let mut old_journal = fixture
            .manager
            .load_journal(&deployed.operation_id)
            .unwrap()
            .unwrap();
        old_journal.targets[0].after_record.library_root = None;
        fixture.manager.save_journal(&old_journal).unwrap();
        let other_root = fixture.library.parent().unwrap().join("other-library");
        write_package(&other_root.join("skills/reviewer"), "first");
        let other = DeploymentManager::new(other_root);
        for manager in [&fixture.manager, &other] {
            assert!(
                manager.list(&fixture.workspaces()).unwrap()[0]
                    .library_root
                    .is_none()
            );
            assert_eq!(fs::read(&receipt_path).unwrap(), bytes);
            assert!(
                prepare_from(
                    manager,
                    &fixture,
                    SkillDeploymentOperation::Update,
                    Some(&legacy.id)
                )
                .unwrap_err()
                .to_string()
                .contains("no verified source library")
            );
            let preview =
                prepare_from(manager, &fixture, SkillDeploymentOperation::Deploy, None).unwrap();
            assert!(
                preview.targets[0]
                    .conflicts
                    .iter()
                    .any(|error| error.contains("no verified source library"))
            );
            assert!(
                manager
                    .has_active_deployments("reviewer", &fixture.workspaces())
                    .unwrap()
            );
        }
        for operation in [
            SkillDeploymentOperation::Undeploy,
            SkillDeploymentOperation::Rollback,
        ] {
            let preview = prepare_from(&other, &fixture, operation, Some(&legacy.id)).unwrap();
            let report = other
                .apply(
                    &preview.token,
                    true,
                    false,
                    &fixture.targets,
                    &fixture.workspaces(),
                )
                .unwrap();
            assert!(report.results[0].success, "{:?}", report.results);
            assert!(
                agentkib_core::project_skill_deployments(&fixture.workspace.path).unwrap()[0]
                    .library_root
                    .is_none()
            );
            assert!(
                !String::from_utf8_lossy(&fs::read(&receipt_path).unwrap())
                    .contains("library_root")
            );
        }
    }

    #[test]
    fn a_changed_source_binding_invalidates_an_already_prepared_update() {
        let fixture = Fixture::new();
        let deployed = fixture.deploy(&["codex"]);
        let update = fixture.prepare(
            SkillDeploymentOperation::Update,
            deployed.results[0].deployment_id.as_deref(),
            &[],
        );
        let path = project_skill_record_path(&fixture.workspace.path);
        let mut records =
            agentkib_core::project_skill_deployments(&fixture.workspace.path).unwrap();
        records[0].library_root = Some(fixture.library.parent().unwrap().join("other-library"));
        let bytes = encode_skill_deployment_records(&SkillDeploymentRecords {
            schema_version: 1,
            deployments: records,
        })
        .unwrap();
        fs::write(&path, &bytes).unwrap();
        let native = fixture.targets[0].root.join("reviewer");
        let original = directory_hash(&native).unwrap();
        assert!(!fixture.apply(&update).results[0].success);
        assert_eq!(directory_hash(&native).unwrap(), original);
        assert_eq!(fs::read(&path).unwrap(), bytes);
        assert!(
            fixture
                .manager
                .has_active_deployments("reviewer", &fixture.workspaces())
                .unwrap()
        );
    }

    #[test]
    fn legacy_journals_recover_without_a_source_binding_or_frozen_project_scopes() {
        let fixture = Fixture::new();
        let mut journal = interrupted_first_deployment(&fixture, true, true);
        journal.targets[0].after_record.library_root = None;
        journal.targets[0].associated_projects.clear();
        fixture.manager.save_journal(&journal).unwrap();
        fs::write(
            project_skill_reservation_path(&fixture.workspace.path),
            encode_skill_deployment_records(&SkillDeploymentRecords {
                schema_version: 1,
                deployments: vec![journal.targets[0].after_record.clone()],
            })
            .unwrap(),
        )
        .unwrap();
        let restarted = DeploymentManager::new(fixture.library.clone());
        let report = restarted
            .apply(
                &journal.operation_id,
                true,
                false,
                &fixture.targets,
                &fixture.workspaces(),
            )
            .unwrap();
        assert_eq!(
            report.results[0].status, "recovered",
            "{:?}",
            report.results
        );
        assert!(!fixture.targets[0].root.join("reviewer").exists());
        assert!(
            project_skill_reservations(&fixture.workspace.path)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn foreign_receipts_cannot_hide_the_original_librarys_pending_deployment() {
        let fixture = Fixture::new();
        let journal = interrupted_first_deployment(&fixture, false, false);
        let mut foreign = journal.targets[0].after_record.clone();
        foreign.library_root = Some(fixture.library.parent().unwrap().join("other-library"));
        foreign.status = "inactive".into();
        let bytes = encode_skill_deployment_records(&SkillDeploymentRecords {
            schema_version: 1,
            deployments: vec![foreign],
        })
        .unwrap();
        let receipt_path = project_skill_record_path(&fixture.workspace.path);
        fs::create_dir_all(receipt_path.parent().unwrap()).unwrap();
        fs::write(&receipt_path, &bytes).unwrap();
        assert!(
            fixture
                .manager
                .list(&fixture.workspaces())
                .unwrap()
                .iter()
                .any(
                    |record| record.library_root.as_ref() == Some(&fixture.library)
                        && record.status == "recovery-required"
                )
        );
        assert!(
            fixture
                .manager
                .has_active_deployments("reviewer", &fixture.workspaces())
                .unwrap()
        );
        assert_eq!(fs::read(receipt_path).unwrap(), bytes);
    }

    #[test]
    fn unregistered_history_reads_latest_receipts_before_library_removal_without_writing() {
        let fixture = Fixture::new();
        let current = withdraw_from_another_library(&fixture);
        assert_eq!(current.status, "inactive");
        let receipt_path = project_skill_record_path(&fixture.workspace.path);
        let receipt = fs::read(&receipt_path).unwrap();
        let reservation_path = project_skill_reservation_path(&fixture.workspace.path);
        let reservations = fs::read(&reservation_path).unwrap();
        let lock_path = fixture.workspace.path.join(".agentkib/skill-write.lock");
        fs::remove_file(&lock_path).unwrap();
        let listed = fixture.manager.list(&[]).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].status, "inactive");
        assert_eq!(listed[0].operation_id, current.operation_id);
        assert!(
            !fixture
                .manager
                .has_active_deployments("reviewer", &[])
                .unwrap()
        );
        assert!(!lock_path.exists());
        assert_eq!(fs::read(&receipt_path).unwrap(), receipt);
        assert_eq!(fs::read(&reservation_path).unwrap(), reservations);

        // A project lock is required even when it is no longer registered, and must be
        // acquired with the library lock before checking the receipt for removal.
        {
            let _write = skill_write_lock().unwrap();
            let _locks = fixture.manager.library_removal_locks("reviewer").unwrap();
            for root in [&fixture.library, &fixture.workspace.path] {
                let file = fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(root.join(".agentkib/skill-write.lock"))
                    .unwrap();
                assert!(file.try_lock().is_err());
            }
        }
        let hub =
            crate::SkillHub::new(fixture.library.clone(), fixture.library.join("cache")).unwrap();
        hub.uninstall("reviewer", true).unwrap();
        assert!(!fixture.library.join("skills/reviewer").exists());
        assert_eq!(fs::read(receipt_path).unwrap(), receipt);
        assert_eq!(fs::read(reservation_path).unwrap(), reservations);
    }

    #[test]
    fn library_removal_preserves_uncertain_or_reserved_historical_ownership() {
        for state in [
            "missing",
            "corrupt",
            "id",
            "library",
            "library-root",
            "pending",
            "project-missing",
        ] {
            let fixture = Fixture::new();
            let mut current = withdraw_from_another_library(&fixture);
            let receipt_path = project_skill_record_path(&fixture.workspace.path);
            match state {
                "missing" => fs::remove_file(&receipt_path).unwrap(),
                "corrupt" => fs::write(&receipt_path, "invalid receipt").unwrap(),
                "id" | "library" | "library-root" => {
                    if state == "id" {
                        current.id = Uuid::new_v4().to_string();
                    } else if state == "library" {
                        current.library_id = "another-source".into();
                    } else {
                        current.library_root =
                            Some(fixture.library.parent().unwrap().join("other-library"));
                    }
                    fs::write(
                        &receipt_path,
                        encode_skill_deployment_records(&SkillDeploymentRecords {
                            schema_version: 1,
                            deployments: vec![current],
                        })
                        .unwrap(),
                    )
                    .unwrap();
                }
                "pending" => {
                    current.operation_id = Uuid::new_v4().to_string();
                    fs::write(
                        project_skill_reservation_path(&fixture.workspace.path),
                        encode_skill_deployment_records(&SkillDeploymentRecords {
                            schema_version: 1,
                            deployments: vec![current],
                        })
                        .unwrap(),
                    )
                    .unwrap();
                }
                "project-missing" => fs::remove_dir_all(&fixture.workspace.path).unwrap(),
                _ => unreachable!(),
            }
            let receipt = fs::read(&receipt_path).ok();
            assert!(
                fixture
                    .manager
                    .has_active_deployments("reviewer", &[])
                    .unwrap_or(true),
                "{state}"
            );
            let hub = crate::SkillHub::new(fixture.library.clone(), fixture.library.join("cache"))
                .unwrap();
            assert!(hub.uninstall("reviewer", true).is_err(), "{state}");
            assert!(fixture.library.join("skills/reviewer").exists());
            assert_eq!(fs::read(&receipt_path).ok(), receipt);
            if state == "project-missing" {
                assert!(!fixture.workspace.path.exists());
            }
        }
    }

    #[test]
    fn personal_targets_check_ancestor_manifest_claims_before_and_after_preview() {
        for before_preview in [false, true] {
            for registered in [false, true] {
                let mut fixture = Fixture::new();
                personal_inside_project(&mut fixture);
                let workspaces = if registered {
                    fixture.workspaces()
                } else {
                    Vec::new()
                };
                let claim = || {
                    manifest(
                        &fixture.workspace.path,
                        SkillDefinition {
                            name: "reviewer".into(),
                            path: "legacy-source".into(),
                            targets: vec![AgentKind::ClaudeCode],
                        },
                    )
                };
                if before_preview {
                    claim();
                }
                let preview = fixture
                    .manager
                    .prepare(
                        PrepareSkillDeploymentRequest {
                            operation: SkillDeploymentOperation::Deploy,
                            library_id: Some("reviewer".into()),
                            deployment_id: None,
                            target_ids: vec!["codex".into()],
                        },
                        &fixture.targets,
                        &workspaces,
                    )
                    .unwrap();
                if !before_preview {
                    claim();
                }
                let report = fixture
                    .manager
                    .apply(&preview.token, true, true, &fixture.targets, &workspaces)
                    .unwrap();
                assert!(!report.results[0].success);
                assert!(
                    report.results[0]
                        .error
                        .as_deref()
                        .unwrap()
                        .contains("workspace manifest")
                );
                assert!(!fixture.targets[0].root.join("reviewer").exists());
            }
        }
    }

    fn move_fixture_workspace(fixture: &mut Fixture, nested: &Path) {
        fs::create_dir_all(nested).unwrap();
        for target in &mut fixture.targets {
            target.root = nested.join(target.root.strip_prefix(&fixture.workspace.path).unwrap());
            target.scope_root = nested.to_path_buf();
        }
        fixture.workspace.path = nested.to_path_buf();
    }

    #[test]
    fn nested_workspace_deployments_check_ancestor_manifest_before_and_after_preview() {
        for before_preview in [false, true] {
            let mut fixture = Fixture::new();
            let parent = fixture.workspace.path.clone();
            move_fixture_workspace(&mut fixture, &parent.join("source/nested"));
            let claim = || {
                manifest(
                    &parent,
                    SkillDefinition {
                        name: "outer-skill".into(),
                        path: "source".into(),
                        targets: vec![AgentKind::Codex],
                    },
                );
            };
            if before_preview {
                claim();
            }
            let preview = fixture.prepare(SkillDeploymentOperation::Deploy, None, &["codex"]);
            assert_eq!(preview.targets[0].conflicts.is_empty(), !before_preview);
            if !before_preview {
                claim();
            }
            let report = fixture.apply(&preview);
            assert!(!report.results[0].success);
            assert!(
                report.results[0]
                    .error
                    .as_deref()
                    .unwrap()
                    .contains("workspace manifest")
            );
            assert!(!fixture.targets[0].root.join("reviewer").exists());
        }
    }

    #[test]
    fn nested_workspace_deployments_check_ancestor_receipts_and_reservations() {
        for state in ["active", "inactive", "pending"] {
            let mut fixture = Fixture::new();
            if state == "pending" {
                interrupted_first_deployment(&fixture, true, false);
            } else {
                let deployed = fixture.deploy(&["codex"]);
                assert!(deployed.results[0].success);
                if state == "inactive" {
                    let withdraw = fixture.prepare(
                        SkillDeploymentOperation::Undeploy,
                        deployed.results[0].deployment_id.as_deref(),
                        &[],
                    );
                    assert!(fixture.apply(&withdraw).results[0].success);
                }
            }
            let outer = fixture.targets[0].root.join("reviewer");
            let receipt = if state == "pending" {
                project_skill_reservation_path(&fixture.workspace.path)
            } else {
                project_skill_record_path(&fixture.workspace.path)
            };
            let original = fs::read(&receipt).unwrap();
            move_fixture_workspace(&mut fixture, &outer.join("nested"));
            // Only the nested project remains registered; ownership must still reach its parent.
            let preview = fixture.prepare(SkillDeploymentOperation::Deploy, None, &["codex"]);
            assert!(
                preview.targets[0]
                    .conflicts
                    .iter()
                    .any(|error| error.contains("owned or reserved by another Skill deployment")),
                "{state}: {:?}",
                preview.targets
            );
            assert!(!fixture.apply(&preview).results[0].success);
            assert!(!fixture.targets[0].root.join("reviewer").exists());
            assert_eq!(fs::read(&receipt).unwrap(), original);
        }
    }

    #[test]
    fn nested_workspace_apply_locks_registered_and_marked_ancestors() {
        for registered in [false, true] {
            for lock_failure in [false, true] {
                let mut fixture = Fixture::new();
                let parent = fixture.workspace.clone();
                move_fixture_workspace(&mut fixture, &parent.path.join("nested"));
                let mut workspaces = fixture.workspaces();
                if registered {
                    let mut parent = parent.clone();
                    parent.id = "parent-workspace".into();
                    workspaces.push(parent);
                } else {
                    fs::create_dir(parent.path.join(".git")).unwrap();
                }
                let preview = fixture
                    .manager
                    .prepare(
                        PrepareSkillDeploymentRequest {
                            operation: SkillDeploymentOperation::Deploy,
                            library_id: Some("reviewer".into()),
                            deployment_id: None,
                            target_ids: vec!["codex".into()],
                        },
                        &fixture.targets,
                        &workspaces,
                    )
                    .unwrap();
                assert!(
                    preview.targets[0].conflicts.is_empty(),
                    "{:?}",
                    preview.targets
                );
                if lock_failure {
                    fs::create_dir_all(parent.path.join(".agentkib/skill-write.lock")).unwrap();
                }
                let report = fixture
                    .manager
                    .apply(&preview.token, true, false, &fixture.targets, &workspaces)
                    .unwrap();
                assert_eq!(
                    report.results[0].success, !lock_failure,
                    "{:?}",
                    report.results
                );
                assert_eq!(
                    fixture.targets[0].root.join("reviewer").exists(),
                    !lock_failure
                );
                if !lock_failure {
                    let journal = fixture
                        .manager
                        .load_journal(&preview.token)
                        .unwrap()
                        .unwrap();
                    assert!(
                        journal.targets[0]
                            .associated_projects
                            .contains(&parent.path)
                    );
                    assert!(parent.path.join(".agentkib/skill-write.lock").is_file());
                    assert!(
                        !parent
                            .path
                            .join(".agentkib/skill-library-roots.json")
                            .exists()
                    );
                }
            }
        }
    }

    #[test]
    fn legacy_nested_workspace_recovery_rediscovers_ancestor_locks() {
        let mut fixture = Fixture::new();
        let parent = fixture.workspace.path.clone();
        fs::create_dir(parent.join(".git")).unwrap();
        move_fixture_workspace(&mut fixture, &parent.join("nested"));
        let mut journal = interrupted_first_deployment(&fixture, true, true);
        journal.targets[0].associated_projects.clear();
        fixture.manager.save_journal(&journal).unwrap();
        let lock = parent.join(".agentkib/skill-write.lock");
        fs::remove_file(&lock).unwrap();
        fs::create_dir(&lock).unwrap();
        let native = fixture.targets[0].root.join("reviewer");
        let original = directory_hash(&native).unwrap();
        let report = fixture
            .manager
            .apply(
                &journal.operation_id,
                true,
                false,
                &fixture.targets,
                &fixture.workspaces(),
            )
            .unwrap();
        assert_eq!(report.results[0].status, "recovery-required");
        assert_eq!(directory_hash(&native).unwrap(), original);
        fs::remove_dir(&lock).unwrap();
        let report = fixture
            .manager
            .apply(
                &journal.operation_id,
                true,
                false,
                &fixture.targets,
                &fixture.workspaces(),
            )
            .unwrap();
        assert_eq!(
            report.results[0].status, "recovered",
            "{:?}",
            report.results
        );
        assert!(!native.exists());
    }

    #[test]
    fn personal_deployment_persists_project_ownership_and_honors_its_lock_failure() {
        for lock_failure in [false, true] {
            let mut fixture = Fixture::new();
            personal_inside_project(&mut fixture);
            let preview = fixture.prepare(SkillDeploymentOperation::Deploy, None, &["codex"]);
            let project = &fixture.workspace.path;
            if lock_failure {
                fs::create_dir_all(project.join(".agentkib/skill-write.lock")).unwrap();
            }
            let report = fixture.apply(&preview);
            assert_eq!(report.results[0].success, !lock_failure);
            let native = fixture.targets[0].root.join("reviewer");
            assert_eq!(native.exists(), !lock_failure);
            if !lock_failure {
                assert!(agentkib_core::is_project_skill_owned(project, &native).unwrap());
                assert!(!project_skill_record_path(project).exists());
                assert!(
                    personal_skill_reservations(&fixture.library)
                        .unwrap()
                        .is_empty()
                );
                assert!(personal_skill_record_path(&fixture.library).exists());
                let index = fs::read(project.join(".agentkib/skill-library-roots.json")).unwrap();
                let scope = fixture
                    .manager
                    .load_journal(&preview.token)
                    .unwrap()
                    .unwrap();
                assert_eq!(scope.targets[0].associated_projects, vec![project.clone()]);
                assert!(agentkib_core::is_project_skill_owned(project, &native).unwrap());
                assert_eq!(
                    fs::read(project.join(".agentkib/skill-library-roots.json")).unwrap(),
                    index
                );
            }
        }
    }

    #[test]
    fn personal_recovery_locks_a_new_unregistered_ancestor_workspace() {
        let mut fixture = Fixture::new();
        let workspace = fixture.workspace.clone();
        let workspace_target = fixture.targets[0].clone();
        personal_inside_project(&mut fixture);
        fixture.workspace.path = fixture.library.parent().unwrap().join("unrelated-project");
        fs::create_dir(&fixture.workspace.path).unwrap();
        let journal = interrupted_first_deployment(&fixture, true, true);
        assert!(journal.targets[0].associated_projects.is_empty());
        let native = &journal.targets[0].after_record.target;
        let original = directory_hash(native).unwrap();

        // A workspace receipt at a separate target becomes the ancestor's first marker.
        // Recovery must discover it even though the pending personal journal predates it.
        let other_root = fixture.library.parent().unwrap().join("other-library");
        write_package(&other_root.join("skills/reviewer"), "first");
        let other = DeploymentManager::new(other_root);
        let preview = other
            .prepare(
                PrepareSkillDeploymentRequest {
                    operation: SkillDeploymentOperation::Deploy,
                    library_id: Some("reviewer".into()),
                    deployment_id: None,
                    target_ids: vec![workspace_target.id.clone()],
                },
                std::slice::from_ref(&workspace_target),
                std::slice::from_ref(&workspace),
            )
            .unwrap();
        let deployed = other
            .apply(
                &preview.token,
                true,
                false,
                std::slice::from_ref(&workspace_target),
                std::slice::from_ref(&workspace),
            )
            .unwrap();
        assert!(deployed.results[0].success, "{:?}", deployed.results);
        let receipt = project_skill_record_path(&workspace.path);
        let original_receipt = fs::read(&receipt).unwrap();
        assert!(!workspace.path.join(".git").exists());
        assert!(!workspace.path.join(".agentkib/manifest.yaml").exists());
        assert!(
            !workspace
                .path
                .join(".agentkib/skill-library-roots.json")
                .exists()
        );
        let lock = workspace.path.join(".agentkib/skill-write.lock");
        fs::remove_file(&lock).unwrap();
        fs::create_dir(&lock).unwrap();
        let restarted = DeploymentManager::new(fixture.library.clone());
        let scopes = restarted
            .authorized_scopes(&journal.targets, &fixture.targets, &[], true)
            .unwrap();
        assert!(scopes.contains(&workspace.path));
        let blocked = restarted
            .apply(&journal.operation_id, true, true, &fixture.targets, &[])
            .unwrap();
        assert_eq!(blocked.results[0].status, "recovery-required");
        assert_eq!(directory_hash(native).unwrap(), original);
        assert_eq!(fs::read(&receipt).unwrap(), original_receipt);
        fs::remove_dir(&lock).unwrap();
        let recovered = restarted
            .apply(&journal.operation_id, true, true, &fixture.targets, &[])
            .unwrap();
        assert_eq!(
            recovered.results[0].status, "recovered",
            "{:?}",
            recovered.results
        );
        assert!(!native.exists());
        assert_eq!(fs::read(receipt).unwrap(), original_receipt);
        assert!(workspace_target.root.join("reviewer").exists());
    }

    #[test]
    fn personal_recovery_keeps_frozen_project_locks_after_unregistration() {
        let mut fixture = Fixture::new();
        personal_inside_project(&mut fixture);
        let journal = interrupted_first_deployment(&fixture, true, true);
        let project = &fixture.workspace.path;
        let native = fixture.targets[0].root.join("reviewer");
        assert!(agentkib_core::is_project_skill_owned(project, &native).unwrap());
        // The journal retains the association even if registration and the index disappear.
        fs::remove_file(project.join(".agentkib/skill-library-roots.json")).unwrap();
        let restarted = DeploymentManager::new(fixture.library.clone());
        let scopes = restarted
            .authorized_scopes(&journal.targets, &fixture.targets, &[], true)
            .unwrap();
        assert!(scopes.contains(project));
        let report = restarted
            .apply(&journal.operation_id, true, true, &fixture.targets, &[])
            .unwrap();
        assert_eq!(report.results[0].status, "recovered");
        assert!(!native.exists());
        assert!(project.join(".agentkib/skill-library-roots.json").exists());
        assert!(
            personal_skill_reservations(&fixture.library)
                .unwrap()
                .is_empty()
        );
        assert!(!agentkib_core::is_project_skill_owned(project, &native).unwrap());
    }

    #[test]
    fn raw_requests_cannot_mix_deployment_and_library_selectors() {
        let fixture = Fixture::new();
        assert!(
            fixture
                .manager
                .prepare(
                    PrepareSkillDeploymentRequest {
                        operation: SkillDeploymentOperation::Deploy,
                        library_id: Some("reviewer".into()),
                        deployment_id: Some(Uuid::new_v4().to_string()),
                        target_ids: vec!["codex".into()],
                    },
                    &fixture.targets,
                    &fixture.workspaces()
                )
                .is_err()
        );
    }

    #[test]
    fn expired_preview_cannot_create_a_native_directory() {
        let fixture = Fixture::new();
        let preview = fixture.prepare(SkillDeploymentOperation::Deploy, None, &["codex"]);
        fixture
            .manager
            .previews
            .lock()
            .unwrap()
            .get_mut(&preview.token)
            .unwrap()
            .preview
            .expires_at = Utc::now() - Duration::seconds(1);
        assert!(
            fixture
                .manager
                .apply(
                    &preview.token,
                    true,
                    true,
                    &fixture.targets,
                    &fixture.workspaces()
                )
                .is_err()
        );
        assert!(!fixture.targets[0].root.exists());
        assert!(
            !fixture
                .workspace
                .path
                .join(".agentkib/skill-write.lock")
                .exists()
        );
    }

    #[test]
    fn an_unwritable_target_does_not_prevent_other_targets_from_applying() {
        let mut fixture = Fixture::new();
        fixture.targets[1].writable = false;
        fixture.targets[1].reason = Some("Profile is unavailable".into());
        let preview = fixture.prepare(SkillDeploymentOperation::Deploy, None, &["codex", "claude"]);
        let report = fixture.apply(&preview);
        assert_eq!(
            report
                .results
                .iter()
                .filter(|result| result.success)
                .count(),
            1
        );
        assert!(fixture.targets[0].root.join("reviewer").is_dir());
        assert!(!fixture.targets[1].root.exists());
    }

    #[test]
    fn scope_lock_failure_after_preview_is_isolated_to_its_workspace() {
        let mut fixture = Fixture::new();
        let second = fixture.library.parent().unwrap().join("second-project");
        fs::create_dir_all(&second).unwrap();
        let second_workspace = SkillWorkspace {
            id: "second".into(),
            name: "Second".into(),
            path: second.clone(),
        };
        fixture.targets[1].workspace_id = Some(second_workspace.id.clone());
        fixture.targets[1].scope_root = second.clone();
        fixture.targets[1].root = second.join(".claude/skills");
        let workspaces = vec![fixture.workspace.clone(), second_workspace];
        let preview = fixture
            .manager
            .prepare(
                PrepareSkillDeploymentRequest {
                    operation: SkillDeploymentOperation::Deploy,
                    library_id: Some("reviewer".into()),
                    deployment_id: None,
                    target_ids: vec!["codex".into(), "claude".into()],
                },
                &fixture.targets,
                &workspaces,
            )
            .unwrap();
        fs::write(second.join(".agentkib"), "external file").unwrap();
        let report = fixture
            .manager
            .apply(&preview.token, true, true, &fixture.targets, &workspaces)
            .unwrap();
        assert_eq!(
            report
                .results
                .iter()
                .filter(|result| result.success)
                .count(),
            1
        );
        assert!(fixture.targets[0].root.join("reviewer").is_dir());
        assert!(!fixture.targets[1].root.exists());
        assert_eq!(
            fs::read_to_string(second.join(".agentkib")).unwrap(),
            "external file"
        );
    }

    #[test]
    fn undeployed_empty_target_can_switch_to_another_same_name_library_package() {
        let fixture = Fixture::new();
        let first = fixture.deploy(&["codex"]);
        let id = first.results[0].deployment_id.as_deref().unwrap();
        assert!(
            fixture
                .apply(&fixture.prepare(SkillDeploymentOperation::Undeploy, Some(id), &[]))
                .results[0]
                .success
        );
        write_package(
            &fixture.library.join("skills/another-source"),
            "from another source",
        );
        let preview = fixture
            .manager
            .prepare(
                PrepareSkillDeploymentRequest {
                    operation: SkillDeploymentOperation::Deploy,
                    library_id: Some("another-source".into()),
                    deployment_id: None,
                    target_ids: vec!["codex".into()],
                },
                &fixture.targets,
                &fixture.workspaces(),
            )
            .unwrap();
        assert!(
            preview.targets[0].conflicts.is_empty(),
            "{:?}",
            preview.targets[0].conflicts
        );
        let replacement = fixture.apply(&preview);
        assert!(replacement.results[0].success, "{:?}", replacement.results);
        let records = fixture.manager.list(&fixture.workspaces()).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].library_id, "another-source");
        assert!(records[0].previous_hash.is_none());
        assert!(
            !fixture
                .manager
                .has_active_deployments("reviewer", &[])
                .unwrap()
        );
        assert!(
            fixture
                .manager
                .has_active_deployments("another-source", &[])
                .unwrap()
        );
        let update = fixture.prepare(
            SkillDeploymentOperation::Update,
            replacement.results[0].deployment_id.as_deref(),
            &[],
        );
        assert!(update.targets[0].conflicts.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn staging_device_is_verified_without_cross_filesystem_copy_fallback() {
        use std::os::unix::fs::MetadataExt;
        let fixture = Fixture::new();
        assert!(ensure_same_filesystem(&fixture.library, &fixture.workspace.path).is_ok());
        let device = fs::metadata(&fixture.workspace.path).unwrap().dev();
        for candidate in [Path::new("/dev"), Path::new("/proc"), Path::new("/sys")] {
            if fs::metadata(candidate)
                .is_ok_and(|metadata| metadata.is_dir() && metadata.dev() != device)
            {
                assert!(ensure_same_filesystem(&fixture.workspace.path, candidate).is_err());
                return;
            }
        }
    }

    fn interrupt_after_activation(fixture: &Fixture, deployment_id: &str) -> (String, String) {
        let original_hash = package_hash(&fixture.targets[0].root.join("reviewer"))
            .unwrap()
            .0;
        write_package(
            &fixture.library.join("skills/reviewer"),
            "interrupted incoming",
        );
        let preview = fixture.prepare(SkillDeploymentOperation::Update, Some(deployment_id), &[]);
        let previews = fixture.manager.previews.lock().unwrap();
        let prepared = &previews[&preview.token].targets[0];
        let paths = operation_paths(
            &prepared.capability,
            &prepared.after_record.id,
            &preview.token,
        )
        .unwrap();
        fs::create_dir_all(&paths.operation).unwrap();
        copy_package(prepared.after.as_ref().unwrap(), &paths.incoming).unwrap();
        let target = TargetJournal {
            target_id: prepared.capability.id.clone(),
            capability_ids: prepared.capability_ids.clone(),
            capability: prepared.capability.clone(),
            associated_projects: prepared.associated_projects.clone(),
            before_record: prepared.before_record.clone(),
            after_record: prepared.after_record.clone(),
            before_hash: prepared.before_hash.clone(),
            after_hash: prepared.after_hash.clone(),
            previous_backup_hash: directory_hash(&paths.backup).unwrap(),
            phase: "activated".into(),
            result: None,
        };
        fixture
            .manager
            .save_journal(&OperationJournal {
                schema_version: 1,
                operation_id: preview.token.clone(),
                requires_home_approval: false,
                targets: vec![target],
                report: None,
            })
            .unwrap();
        move_path(&prepared.after_record.target, &paths.before).unwrap();
        move_path(&paths.incoming, &prepared.after_record.target).unwrap();
        (preview.token, original_hash)
    }

    #[test]
    fn unchanged_update_recovers_backup_rotation_with_or_without_a_previous_version() {
        for with_previous in [false, true] {
            // The crash may occur before or after the new phase reaches the journal.
            for persisted_phase in ["activated", "backup-rotated"] {
                let fixture = Fixture::new();
                let deployed = fixture.deploy(&["codex"]);
                let id = deployed.results[0].deployment_id.as_deref().unwrap();
                if with_previous {
                    write_package(&fixture.library.join("skills/reviewer"), "second");
                    let update = fixture.prepare(SkillDeploymentOperation::Update, Some(id), &[]);
                    assert!(fixture.apply(&update).results[0].success);
                }
                let native = fixture.targets[0].root.join("reviewer");
                let original = directory_hash(&native).unwrap();
                let preview = fixture.prepare(SkillDeploymentOperation::Update, Some(id), &[]);
                let (backup, previous_hash) = {
                    let previews = fixture.manager.previews.lock().unwrap();
                    let prepared = &previews[&preview.token].targets[0];
                    assert_eq!(prepared.before_hash, prepared.after_hash);
                    let paths = operation_paths(&prepared.capability, id, &preview.token).unwrap();
                    fs::create_dir_all(&paths.operation).unwrap();
                    copy_package(prepared.after.as_ref().unwrap(), &paths.incoming).unwrap();
                    let target = TargetJournal {
                        target_id: prepared.capability.id.clone(),
                        capability_ids: prepared.capability_ids.clone(),
                        capability: prepared.capability.clone(),
                        associated_projects: prepared.associated_projects.clone(),
                        before_record: prepared.before_record.clone(),
                        after_record: prepared.after_record.clone(),
                        before_hash: prepared.before_hash.clone(),
                        after_hash: prepared.after_hash.clone(),
                        previous_backup_hash: prepared.previous_backup_hash.clone(),
                        phase: persisted_phase.into(),
                        result: None,
                    };
                    fixture
                        .manager
                        .save_journal(&OperationJournal {
                            schema_version: 1,
                            operation_id: preview.token.clone(),
                            requires_home_approval: false,
                            targets: vec![target],
                            report: None,
                        })
                        .unwrap();
                    move_path(&native, &paths.before).unwrap();
                    move_path(&paths.incoming, &native).unwrap();
                    if prepared.previous_backup_hash.is_some() {
                        move_path(&paths.backup, &paths.prior_backup).unwrap();
                    }
                    fs::create_dir_all(paths.backup.parent().unwrap()).unwrap();
                    move_path(&paths.before, &paths.backup).unwrap();
                    (paths.backup, prepared.previous_backup_hash.clone())
                };
                let restarted = DeploymentManager::new(fixture.library.clone());
                let recovered = restarted
                    .apply(
                        &preview.token,
                        true,
                        true,
                        &fixture.targets,
                        &fixture.workspaces(),
                    )
                    .unwrap();
                assert_eq!(
                    recovered.results[0].status, "recovered",
                    "{with_previous} {persisted_phase}: {:?}",
                    recovered.results
                );
                assert_eq!(directory_hash(&native).unwrap(), original);
                assert_eq!(directory_hash(&backup).unwrap(), previous_hash);
                assert!(!restarted.pending_target(&native).unwrap());
                assert_eq!(
                    restarted
                        .apply(
                            &preview.token,
                            true,
                            true,
                            &fixture.targets,
                            &fixture.workspaces()
                        )
                        .unwrap()
                        .results[0]
                        .status,
                    "recovered"
                );
                let next = fixture.prepare(SkillDeploymentOperation::Update, Some(id), &[]);
                assert!(next.targets[0].conflicts.is_empty());
            }
        }
    }

    #[test]
    fn recovery_reloads_a_journal_completed_while_waiting_for_scope_locks() {
        let fixture = Fixture::new();
        let first = fixture.deploy(&["codex"]);
        let id = first.results[0].deployment_id.as_deref().unwrap();
        let mut stale = fixture
            .manager
            .load_journal(&first.operation_id)
            .unwrap()
            .unwrap();
        // This is what a second process read before waiting for the writer's OS lock.
        stale.report = None;
        stale.targets[0].phase = "backup-rotated".into();
        stale.targets[0].result = None;
        write_package(&fixture.library.join("skills/reviewer"), "newer operation");
        let update = fixture.prepare(SkillDeploymentOperation::Update, Some(id), &[]);
        assert!(fixture.apply(&update).results[0].success);
        let native = fixture.targets[0].root.join("reviewer");
        let current_hash = directory_hash(&native).unwrap();
        let journal_path = fixture.manager.journal_path(&first.operation_id).unwrap();
        let current_journal = fs::read(&journal_path).unwrap();
        let _guard = skill_write_lock().unwrap();
        let (_scope_guards, errors) = fixture
            .manager
            .lock_scopes(
                fixture
                    .manager
                    .authorized_scopes(
                        &stale.targets,
                        &fixture.targets,
                        &fixture.workspaces(),
                        true,
                    )
                    .unwrap(),
            )
            .unwrap();
        let report = fixture
            .manager
            .resume_journal_locked(
                &stale,
                &fixture.targets,
                &fixture.workspaces(),
                &errors,
                &[
                    platform_path::identity(&fixture.library),
                    platform_path::identity(&fixture.workspace.path),
                ]
                .into(),
                true,
            )
            .unwrap();
        assert_eq!(report.operation_id, first.operation_id);
        assert!(report.results[0].success);
        assert_eq!(fs::read(journal_path).unwrap(), current_journal);
        assert_eq!(directory_hash(&native).unwrap(), current_hash);
        assert!(!fixture.manager.pending_target(&native).unwrap());
    }

    #[test]
    fn inventory_uses_the_latest_pending_operation_without_changing_durable_receipts() {
        let fixture = Fixture::new();
        let installed = fixture.deploy(&["codex"]);
        let id = installed.results[0].deployment_id.as_deref().unwrap();
        let (token, _) = interrupt_after_activation(&fixture, id);
        let receipts = project_skill_record_path(&fixture.workspace.path);
        let original = fs::read(&receipts).unwrap();
        let mut later = fixture.manager.load_journal(&token).unwrap().unwrap();
        later.operation_id = Uuid::new_v4().to_string();
        later.targets[0].after_record.operation_id = later.operation_id.clone();
        later.targets[0].after_record.updated_at += Duration::seconds(1);
        fixture.manager.save_journal(&later).unwrap();
        let records = fixture.manager.list(&fixture.workspaces()).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].status, "recovery-required");
        assert_eq!(records[0].operation_id, later.operation_id);
        assert_eq!(fs::read(receipts).unwrap(), original);
    }

    #[test]
    fn interrupted_operation_is_observed_read_only_then_explicitly_recovered() {
        let fixture = Fixture::new();
        let installed = fixture.deploy(&["codex"]);
        let id = installed.results[0].deployment_id.as_deref().unwrap();
        let (token, original) = interrupt_after_activation(&fixture, id);
        let restarted = DeploymentManager::new(fixture.library.clone());
        let active_hash = package_hash(&fixture.targets[0].root.join("reviewer"))
            .unwrap()
            .0;
        assert_ne!(active_hash, original);
        assert_eq!(
            restarted.list(&fixture.workspaces()).unwrap()[0].status,
            "recovery-required"
        );
        assert_eq!(
            package_hash(&fixture.targets[0].root.join("reviewer"))
                .unwrap()
                .0,
            active_hash
        );
        let report = restarted
            .apply(&token, true, true, &fixture.targets, &fixture.workspaces())
            .unwrap();
        assert_eq!(report.results[0].status, "recovered");
        assert_eq!(
            package_hash(&fixture.targets[0].root.join("reviewer"))
                .unwrap()
                .0,
            original
        );
        assert_eq!(
            restarted
                .apply(&token, true, true, &fixture.targets, &fixture.workspaces())
                .unwrap()
                .results[0]
                .status,
            "recovered"
        );
    }

    #[test]
    fn pending_journal_recovers_after_reregistration_without_migrating_the_old_receipt() {
        let mut fixture = Fixture::new();
        let installed = fixture.deploy(&["codex"]);
        assert!(installed.results[0].success);
        let id = installed.results[0].deployment_id.as_deref().unwrap();
        let (token, original_hash) = interrupt_after_activation(&fixture, id);
        let native = fixture.targets[0].root.join("reviewer");
        let receipt_path = project_skill_record_path(&fixture.workspace.path);
        let original_receipt = fs::read(&receipt_path).unwrap();
        let journal_path = fixture.manager.journal_path(&token).unwrap();
        let original_journal = fs::read(&journal_path).unwrap();
        let active_hash = directory_hash(&native).unwrap();
        fixture.reregister();
        let restarted = DeploymentManager::new(fixture.library.clone());
        let records = restarted.list(&fixture.workspaces()).unwrap();
        assert_eq!(records[0].status, "recovery-required");
        assert_eq!(records[0].workspace_id, Some(fixture.workspace.id.clone()));
        assert_eq!(fs::read(&receipt_path).unwrap(), original_receipt);
        assert_eq!(fs::read(&journal_path).unwrap(), original_journal);
        assert_eq!(directory_hash(&native).unwrap(), active_hash);
        let report = restarted
            .apply(&token, true, false, &fixture.targets, &fixture.workspaces())
            .unwrap();
        assert_eq!(
            report.results[0].status, "recovered",
            "{:?}",
            report.results
        );
        assert_eq!(directory_hash(&native).unwrap(), Some(original_hash));
        assert_eq!(fs::read(&receipt_path).unwrap(), original_receipt);
        assert!(!restarted.pending_target(&native).unwrap());
        let preview = fixture.prepare(SkillDeploymentOperation::Update, Some(id), &[]);
        assert!(fixture.apply(&preview).results[0].success);
        assert_eq!(
            read_skill_deployment_records(&receipt_path).unwrap()[0].workspace_id,
            Some(fixture.workspace.id.clone())
        );
    }

    #[test]
    fn pending_journal_preserves_files_when_reregistered_target_is_unauthorized() {
        for change in ["scope-root", "agent", "writable", "receipt"] {
            let mut fixture = Fixture::new();
            let installed = fixture.deploy(&["codex"]);
            let id = installed.results[0].deployment_id.as_deref().unwrap();
            let (token, _) = interrupt_after_activation(&fixture, id);
            let native = fixture.targets[0].root.join("reviewer");
            let active_hash = directory_hash(&native).unwrap();
            let receipt_path = project_skill_record_path(&fixture.workspace.path);
            fixture.reregister();
            match change {
                "scope-root" => {
                    let other = fixture.library.parent().unwrap().join("other-project");
                    fs::create_dir_all(&other).unwrap();
                    fixture.workspace.path = other.clone();
                    fixture.targets[0].scope_root = other.clone();
                    fixture.targets[0].root = other.join(".agents/skills");
                }
                "agent" => fixture.targets[0].agent = AgentKind::Antigravity,
                "writable" => fixture.targets[0].writable = false,
                "receipt" => {
                    let mut records = read_skill_deployment_records(&receipt_path).unwrap();
                    records[0].diagnostics.push("external receipt edit".into());
                    fs::write(
                        &receipt_path,
                        serde_json::to_vec(&SkillDeploymentRecords {
                            schema_version: 1,
                            deployments: records,
                        })
                        .unwrap(),
                    )
                    .unwrap();
                }
                _ => unreachable!(),
            }
            let original_receipt = fs::read(&receipt_path).unwrap();
            let restarted = DeploymentManager::new(fixture.library.clone());
            let report = restarted
                .apply(&token, true, false, &fixture.targets, &fixture.workspaces())
                .unwrap();
            assert_eq!(
                report.results[0].status, "recovery-required",
                "{change}: {:?}",
                report.results
            );
            assert_eq!(directory_hash(&native).unwrap(), active_hash, "{change}");
            assert_eq!(
                fs::read(&receipt_path).unwrap(),
                original_receipt,
                "{change}"
            );
        }
    }

    #[test]
    fn failed_recovery_preserves_external_changes_and_can_be_retried() {
        let fixture = Fixture::new();
        let installed = fixture.deploy(&["codex"]);
        let id = installed.results[0].deployment_id.as_deref().unwrap();
        let (token, original) = interrupt_after_activation(&fixture, id);
        let native = fixture.targets[0].root.join("reviewer");
        let saved_incoming = fs::read(native.join("SKILL.md")).unwrap();
        fs::write(native.join("SKILL.md"), "external edit after crash").unwrap();
        let report = fixture
            .manager
            .apply(&token, true, true, &fixture.targets, &fixture.workspaces())
            .unwrap();
        assert_eq!(report.results[0].status, "recovery-required");
        assert_eq!(
            fs::read_to_string(native.join("SKILL.md")).unwrap(),
            "external edit after crash"
        );
        fs::write(native.join("SKILL.md"), saved_incoming).unwrap();
        let retried = fixture
            .manager
            .apply(&token, true, true, &fixture.targets, &fixture.workspaces())
            .unwrap();
        assert_eq!(retried.results[0].status, "recovered");
        assert_eq!(package_hash(&native).unwrap().0, original);
    }

    #[test]
    fn receipt_edits_after_preview_do_not_get_overwritten() {
        let fixture = Fixture::new();
        let installed = fixture.deploy(&["codex"]);
        let id = installed.results[0].deployment_id.as_deref().unwrap();
        let preview = fixture.prepare(SkillDeploymentOperation::Undeploy, Some(id), &[]);
        let path = project_skill_record_path(&fixture.workspace.path);
        let mut records = read_skill_deployment_records(&path).unwrap();
        records[0].diagnostics.push("external receipt edit".into());
        fs::write(
            &path,
            serde_json::to_vec(&SkillDeploymentRecords {
                schema_version: 1,
                deployments: records,
            })
            .unwrap(),
        )
        .unwrap();
        assert!(!fixture.apply(&preview).results[0].success);
        assert!(fixture.targets[0].root.join("reviewer").is_dir());
        assert_eq!(
            read_skill_deployment_records(&path).unwrap()[0].diagnostics[0],
            "external receipt edit"
        );
    }

    #[cfg(unix)]
    #[test]
    fn changed_target_symlink_is_not_followed_or_removed() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let preview = fixture.prepare(SkillDeploymentOperation::Deploy, None, &["codex"]);
        let outside = fixture.library.parent().unwrap().join("external");
        write_package(&outside, "external");
        fs::create_dir_all(&fixture.targets[0].root).unwrap();
        let target = fixture.targets[0].root.join("reviewer");
        symlink(&outside, &target).unwrap();
        assert!(!fixture.apply(&preview).results[0].success);
        assert!(
            fs::symlink_metadata(target)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert!(outside.join("SKILL.md").is_file());
    }
}
