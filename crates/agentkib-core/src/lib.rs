mod changeset;
mod context;
mod doctor;
mod manifest;
mod model;
mod path_policy;
mod scanner;
mod skill;

pub use changeset::{ApplyOptions, apply_changeset, hash_content};
pub use context::{
    opencode_managed_config_path, opencode_managed_instruction_is_registered, resolve_context,
};
pub use doctor::{diagnose_workspace, diagnose_workspace_with_mcp_error};
pub use manifest::{load_manifest, manifest_path, validate_manifest};
pub use model::*;
pub use path_policy::{canonical_project, ensure_allowed_target};
pub use scanner::scan_workspace;
pub use skill::{SkillPackage, inspect_skill_entrypoint, is_readable_skill_file};

pub fn validate_workspace(project: &std::path::Path) -> anyhow::Result<WorkspaceValidation> {
    let scan = scan_workspace(project)?;
    Ok(WorkspaceValidation {
        valid: scan.warnings.is_empty(),
        warnings: scan.warnings,
    })
}
