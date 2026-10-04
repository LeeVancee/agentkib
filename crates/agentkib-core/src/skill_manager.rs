use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::{AgentKind, SkillSource};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SkillScope {
    Personal,
    Workspace,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillWorkspace {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillTargetCapability {
    pub id: String,
    pub agent: AgentKind,
    pub scope: SkillScope,
    pub workspace_id: Option<String>,
    pub profile: Option<String>,
    /// Native skills directory. Requests refer to its ID, never a client-supplied path.
    pub root: PathBuf,
    pub scope_root: PathBuf,
    pub visible_to: Vec<AgentKind>,
    pub writable: bool,
    pub reason: Option<String>,
    #[serde(default)]
    pub conditions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillObservation {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
    pub resolved_path: Option<PathBuf>,
    pub scope: SkillScope,
    pub workspace_id: Option<String>,
    pub agents: Vec<AgentKind>,
    pub kind: String,
    pub status: String,
    pub owner: String,
    pub library_id: Option<String>,
    pub diagnostics: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SkillInventory {
    pub observations: Vec<SkillObservation>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillPackageFile {
    /// Package-relative path; a trailing slash denotes a directory with no file contents.
    pub path: String,
    pub size: u64,
    pub sha256: String,
    pub executable: bool,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillDetail {
    pub library_id: Option<String>,
    pub observation_id: Option<String>,
    pub name: String,
    pub description: String,
    pub source: Option<SkillSource>,
    #[serde(default)]
    pub local_source: Option<PathBuf>,
    #[serde(default)]
    pub local_resolved_path: Option<PathBuf>,
    pub files: Vec<SkillPackageFile>,
    #[serde(default)]
    pub previous_files: Vec<SkillPackageFile>,
    pub total_size: u64,
    pub diagnostics: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SkillPreviewFile {
    pub path: String,
    pub before: Option<String>,
    pub after: Option<String>,
    pub binary: bool,
    pub truncated: bool,
    pub before_size: Option<u64>,
    pub after_size: Option<u64>,
    pub before_sha256: Option<String>,
    pub after_sha256: Option<String>,
    pub before_executable: Option<bool>,
    pub after_executable: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SkillDeploymentOperation {
    Deploy,
    Update,
    Undeploy,
    Rollback,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrepareSkillDeploymentRequest {
    pub operation: SkillDeploymentOperation,
    pub library_id: Option<String>,
    pub deployment_id: Option<String>,
    #[serde(default)]
    pub target_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillDeployment {
    pub id: String,
    pub library_id: String,
    /// Canonical source library identity. Legacy receipts have no verified source binding.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub library_root: Option<PathBuf>,
    pub package_name: String,
    pub package_hash: String,
    pub scope: SkillScope,
    pub workspace_id: Option<String>,
    pub scope_root: PathBuf,
    pub target: PathBuf,
    pub agents: Vec<AgentKind>,
    pub visible_to: Vec<AgentKind>,
    pub status: String,
    #[serde(default)]
    pub diagnostics: Vec<String>,
    pub previous_hash: Option<String>,
    pub operation_id: String,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillDeploymentTargetPreview {
    pub target_id: String,
    pub deployment_id: Option<String>,
    pub path: PathBuf,
    pub scope: SkillScope,
    pub workspace_id: Option<String>,
    pub agents: Vec<AgentKind>,
    pub visible_to: Vec<AgentKind>,
    pub added: Vec<String>,
    pub modified: Vec<String>,
    pub removed: Vec<String>,
    pub conflicts: Vec<String>,
    pub conditions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillDeploymentPreview {
    pub token: String,
    pub operation: SkillDeploymentOperation,
    pub library_id: Option<String>,
    pub expires_at: DateTime<Utc>,
    pub requires_home_approval: bool,
    pub targets: Vec<SkillDeploymentTargetPreview>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillDeploymentResult {
    pub target_id: String,
    pub deployment_id: Option<String>,
    pub path: PathBuf,
    pub success: bool,
    pub status: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillDeploymentReport {
    pub operation_id: String,
    pub results: Vec<SkillDeploymentResult>,
    pub warnings: Vec<String>,
}
