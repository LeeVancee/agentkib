//! Desktop-only Skill management RPCs. Native paths are resolved on the host.

use std::sync::OnceLock;

use agentkib_core::{
    PrepareSkillDeploymentRequest, SkillDeployment, SkillDetail, SkillInventory,
    SkillOperationPreview, SkillPreviewFile, SkillTargetCapability, SkillWorkspace,
};
use agentkib_protocol::{
    APPLY_SKILL_DEPLOYMENT_METHOD, LIST_SKILL_DEPLOYMENTS_METHOD, PREPARE_SKILL_DEPLOYMENT_METHOD,
    PREPARE_SKILL_IMPORT_METHOD, READ_SKILL_DETAIL_FILE_METHOD, READ_SKILL_PREVIEW_FILE_METHOD,
    RpcRequest, RpcResponse, SKILL_DETAIL_METHOD, SKILL_INVENTORY_METHOD, SKILL_TARGETS_METHOD,
};
use agentkib_skills::DeploymentManager;
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};

use crate::{EmptyRequest, Store, command_response, complete_skill_mutation, skill_hub};

static DEPLOYMENTS: OnceLock<DeploymentManager> = OnceLock::new();

pub(super) const METHODS: &[&str] = &[
    SKILL_INVENTORY_METHOD,
    SKILL_TARGETS_METHOD,
    SKILL_DETAIL_METHOD,
    READ_SKILL_DETAIL_FILE_METHOD,
    PREPARE_SKILL_IMPORT_METHOD,
    READ_SKILL_PREVIEW_FILE_METHOD,
    LIST_SKILL_DEPLOYMENTS_METHOD,
    PREPARE_SKILL_DEPLOYMENT_METHOD,
    APPLY_SKILL_DEPLOYMENT_METHOD,
];

pub(super) fn is_method(method: &str) -> bool {
    METHODS.contains(&method)
}

fn manager() -> Result<&'static DeploymentManager> {
    let root = skill_hub()?.root().to_path_buf();
    Ok(DEPLOYMENTS.get_or_init(|| DeploymentManager::new(root)))
}

fn workspaces() -> Result<Vec<SkillWorkspace>> {
    Ok(Store::open_default()?
        .list_workspaces()?
        .into_iter()
        .map(|workspace| SkillWorkspace {
            id: workspace.id,
            name: workspace.name,
            path: workspace.path,
        })
        .collect())
}

pub(super) fn execute(request: RpcRequest) -> RpcResponse {
    match request.method.as_str() {
        SKILL_INVENTORY_METHOD => command_response(request, inventory).0,
        SKILL_TARGETS_METHOD => command_response(request, targets).0,
        SKILL_DETAIL_METHOD => command_response(request, detail).0,
        READ_SKILL_DETAIL_FILE_METHOD => command_response(request, read_detail).0,
        PREPARE_SKILL_IMPORT_METHOD => command_response(request, prepare_import).0,
        READ_SKILL_PREVIEW_FILE_METHOD => command_response(request, read_preview).0,
        LIST_SKILL_DEPLOYMENTS_METHOD => command_response(request, list_deployments).0,
        PREPARE_SKILL_DEPLOYMENT_METHOD => {
            command_response(request, |params: PrepareSkillDeploymentRequest| {
                let workspaces = workspaces()?;
                let targets = agentkib_skills::skill_targets(&workspaces)?;
                manager()?.prepare(params, &targets, &workspaces)
            })
            .0
        }
        APPLY_SKILL_DEPLOYMENT_METHOD => command_response(request, apply_deployment).0,
        _ => RpcResponse::error(request.id, -32601, "Unknown Skill manager method", None),
    }
}

fn inventory(_: EmptyRequest) -> Result<SkillInventory> {
    let workspaces = workspaces()?;
    let mut inventory = skill_hub()?.inventory(&workspaces)?;
    match manager()?.list(&workspaces) {
        Ok(deployments) => {
            for observation in &mut inventory.observations {
                if let Some(deployment) = deployments.iter().find(|deployment| {
                    deployment.status != "inactive"
                        && agentkib_platform::path::lexical_identity(&deployment.target)
                            == agentkib_platform::path::lexical_identity(&observation.path)
                }) {
                    observation.owner = "agentkib".into();
                    observation.library_id =
                        source_is_current_library(deployment, skill_hub()?.root())
                            .then(|| deployment.library_id.clone());
                    // Native visibility and deployment integrity are independent. The latter
                    // is already returned by listDeployments, including drift and recovery.
                    observation
                        .diagnostics
                        .extend(deployment.diagnostics.clone());
                }
            }
        }
        Err(error) => inventory.warnings.push(error.to_string()),
    }
    Ok(inventory)
}

fn targets(_: EmptyRequest) -> Result<Vec<SkillTargetCapability>> {
    agentkib_skills::skill_targets(&workspaces()?)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DetailRequest {
    library_id: Option<String>,
    observation_id: Option<String>,
}

fn validate_detail_ids(library_id: Option<&str>, observation_id: Option<&str>) -> Result<()> {
    ensure!(
        library_id.is_some() != observation_id.is_some(),
        "Choose exactly one library or observation ID"
    );
    ensure!(
        library_id
            .or(observation_id)
            .is_some_and(|id| !id.is_empty() && id.len() <= 512),
        "Invalid Skill identity"
    );
    Ok(())
}

fn detail(params: DetailRequest) -> Result<SkillDetail> {
    validate_detail_ids(
        params.library_id.as_deref(),
        params.observation_id.as_deref(),
    )?;
    skill_hub()?.get_detail(
        params.library_id.as_deref(),
        params.observation_id.as_deref(),
        &workspaces()?,
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DetailFileRequest {
    library_id: Option<String>,
    observation_id: Option<String>,
    path: String,
}

fn read_detail(params: DetailFileRequest) -> Result<SkillPreviewFile> {
    validate_detail_ids(
        params.library_id.as_deref(),
        params.observation_id.as_deref(),
    )?;
    skill_hub()?.read_detail_file(
        params.library_id.as_deref(),
        params.observation_id.as_deref(),
        &params.path,
        &workspaces()?,
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ImportRequest {
    observation_id: String,
}

fn prepare_import(params: ImportRequest) -> Result<SkillOperationPreview> {
    skill_hub()?.prepare_import(&params.observation_id, &workspaces()?)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PreviewFileRequest {
    token: String,
    path: String,
    target_id: Option<String>,
}

fn read_preview(params: PreviewFileRequest) -> Result<SkillPreviewFile> {
    match params.target_id {
        Some(target_id) => manager()?.read_preview_file(&params.token, &target_id, &params.path),
        None => skill_hub()?.read_preview_file(&params.token, &params.path),
    }
}

#[derive(Serialize)]
struct SkillDeploymentView {
    #[serde(flatten)]
    deployment: SkillDeployment,
    source_is_current_library: bool,
}

fn source_is_current_library(deployment: &SkillDeployment, library: &std::path::Path) -> bool {
    deployment
        .library_root
        .as_ref()
        .is_some_and(|root| agentkib_platform::path::equivalent(root, library))
}

fn list_deployments(_: EmptyRequest) -> Result<Vec<SkillDeploymentView>> {
    let workspaces = workspaces()?;
    let library = skill_hub()?.root();
    let deployments = manager()?.list(&workspaces)?;
    let inventory = skill_hub()?.inventory(&workspaces);
    Ok(deployments
        .into_iter()
        .map(|mut deployment| {
            refresh_deployment_visibility(&mut deployment, &inventory);
            SkillDeploymentView {
                source_is_current_library: source_is_current_library(&deployment, library),
                deployment,
            }
        })
        .collect())
}

fn refresh_deployment_visibility(
    deployment: &mut SkillDeployment,
    inventory: &Result<SkillInventory>,
) {
    // Receipts preserve the reviewed operation and its requested Agents. Native
    // readers are a current observation, so never reuse the receipt's old list.
    deployment.visible_to.clear();
    if deployment.status == "inactive" {
        return;
    }
    let inventory = match inventory {
        Ok(inventory) => inventory,
        Err(error) => {
            deployment.diagnostics.push(format!(
                "Native visibility is unverified because the Skill inventory could not be read: {error}"
            ));
            return;
        }
    };
    let target = agentkib_platform::path::lexical_identity(&deployment.target);
    let mut observed = false;
    for observation in &inventory.observations {
        // An alias pointing to this physical deployment shares its contents but
        // retains its own ownership. Do not follow a replaced deployment link to
        // an unrelated package and accidentally adopt that package's readers.
        if agentkib_platform::path::lexical_identity(&observation.path) != target
            && !observation.resolved_path.as_ref().is_some_and(|resolved| {
                agentkib_platform::path::lexical_identity(resolved) == target
            })
        {
            continue;
        }
        deployment
            .diagnostics
            .extend(observation.diagnostics.iter().cloned());
        if matches!(
            observation.status.as_str(),
            "broken-link" | "link-loop" | "invalid"
        ) {
            continue;
        }
        observed = true;
        deployment.visible_to.extend(&observation.agents);
    }
    if !observed {
        deployment.diagnostics.push(
            "Native visibility is unverified: this deployment has no current readable Skill observation"
                .into(),
        );
        deployment
            .diagnostics
            .extend(inventory.warnings.iter().cloned());
    }
    deployment.visible_to.sort_by_key(|agent| agent.as_str());
    deployment.visible_to.dedup();
    deployment.diagnostics.sort();
    deployment.diagnostics.dedup();
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ApplyRequest {
    token: String,
    confirmed: bool,
    #[serde(default)]
    approve_home: bool,
}

fn apply_deployment(params: ApplyRequest) -> Result<agentkib_core::SkillDeploymentReport> {
    let workspaces = workspaces()?;
    let targets = agentkib_skills::skill_targets(&workspaces)?;
    let mut report = manager()?.apply(
        &params.token,
        params.confirmed,
        params.approve_home,
        &targets,
        &workspaces,
    )?;
    // Recovery can remove an activated copy or restore its previous version while
    // the requested deployment still reports failure. Its filesystem changes need
    // the same derived-index refresh and audit as a completed deployment.
    if report
        .results
        .iter()
        .any(|result| result.success || result.status == "recovered")
    {
        report.warnings.extend(complete_skill_mutation(
            "skill.deployment",
            &report.operation_id,
        ));
    }
    Ok(report)
}

pub(super) fn ensure_library_removable(library_id: &str) -> Result<()> {
    ensure!(
        !manager()?.has_active_deployments(library_id, &workspaces()?)?,
        "This Skill still has active deployments; remove those deployments first"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use agentkib_core::{AgentKind, SkillObservation, SkillScope};

    fn deployment() -> SkillDeployment {
        SkillDeployment {
            id: "deployment".into(),
            library_id: "reviewer".into(),
            library_root: Some("/library".into()),
            package_name: "reviewer".into(),
            package_hash: "hash".into(),
            scope: SkillScope::Personal,
            workspace_id: None,
            scope_root: "/home".into(),
            target: "/home/.claude/skills/reviewer".into(),
            agents: vec![AgentKind::ClaudeCode],
            visible_to: vec![AgentKind::ClaudeCode, AgentKind::OpenCode],
            status: "current".into(),
            diagnostics: Vec::new(),
            previous_hash: None,
            operation_id: "operation".into(),
            updated_at: chrono::Utc::now(),
        }
    }

    fn observation(path: &str, agents: Vec<AgentKind>) -> SkillObservation {
        SkillObservation {
            id: path.into(),
            name: "reviewer".into(),
            path: path.into(),
            resolved_path: Some(path.into()),
            scope: SkillScope::Personal,
            workspace_id: None,
            agents,
            kind: "directory".into(),
            status: "observed".into(),
            owner: "external".into(),
            library_id: None,
            diagnostics: Vec::new(),
        }
    }

    #[test]
    fn deployment_view_uses_current_readers_without_changing_requested_agents() {
        let original = deployment();
        let mut view = original.clone();
        let mut observed = observation(
            view.target.to_str().unwrap(),
            vec![AgentKind::ClaudeCode, AgentKind::Cursor],
        );
        observed.diagnostics = vec!["OpenCode compatibility is disabled".into()];
        refresh_deployment_visibility(
            &mut view,
            &Ok(SkillInventory {
                observations: vec![observed],
                warnings: Vec::new(),
            }),
        );
        assert_eq!(
            view.visible_to,
            vec![AgentKind::ClaudeCode, AgentKind::Cursor]
        );
        assert_eq!(view.agents, original.agents);
        assert_eq!(view.status, "current");
        assert!(
            view.diagnostics
                .iter()
                .any(|value| value.contains("disabled"))
        );
        assert!(original.visible_to.contains(&AgentKind::OpenCode));
    }

    #[test]
    fn deployment_view_preserves_known_empty_native_readers() {
        let mut view = deployment();
        let mut observed = observation(view.target.to_str().unwrap(), Vec::new());
        observed.status = "native-restricted".into();
        observed.diagnostics = vec!["Compatible source is disabled".into()];
        refresh_deployment_visibility(
            &mut view,
            &Ok(SkillInventory {
                observations: vec![observed],
                warnings: Vec::new(),
            }),
        );
        assert!(view.visible_to.is_empty());
        assert_eq!(view.diagnostics, ["Compatible source is disabled"]);
    }

    #[test]
    fn deployment_view_merges_physical_alias_readers_without_claiming_other_packages() {
        let mut view = deployment();
        let direct = observation(view.target.to_str().unwrap(), vec![AgentKind::ClaudeCode]);
        let mut alias = observation("/project/.agents/skills/reviewer", vec![AgentKind::Codex]);
        alias.resolved_path = Some(view.target.clone());
        let unrelated = observation("/external/reviewer", vec![AgentKind::OpenCode]);
        refresh_deployment_visibility(
            &mut view,
            &Ok(SkillInventory {
                observations: vec![direct.clone(), direct, alias, unrelated],
                warnings: Vec::new(),
            }),
        );
        assert_eq!(
            view.visible_to,
            vec![AgentKind::ClaudeCode, AgentKind::Codex]
        );
        assert_eq!(view.agents, [AgentKind::ClaudeCode]);
    }

    #[test]
    fn deployment_view_marks_missing_or_unreadable_observations_unverified() {
        let mut broken = observation("/home/.claude/skills/reviewer", vec![AgentKind::ClaudeCode]);
        broken.resolved_path = None;
        broken.status = "broken-link".into();
        for inventory in [
            Ok(SkillInventory::default()),
            Ok(SkillInventory {
                observations: vec![broken],
                warnings: Vec::new(),
            }),
            Err(anyhow::anyhow!("Native configuration is unavailable")),
        ] {
            let mut view = deployment();
            refresh_deployment_visibility(&mut view, &inventory);
            assert!(view.visible_to.is_empty());
            assert_eq!(view.status, "current");
            assert!(
                view.diagnostics
                    .iter()
                    .any(|value| value.contains("unverified"))
            );
        }
    }

    #[test]
    fn inactive_deployment_view_does_not_claim_readers_of_a_new_external_installation() {
        let mut view = deployment();
        view.status = "inactive".into();
        let observed = observation(view.target.to_str().unwrap(), vec![AgentKind::ClaudeCode]);
        refresh_deployment_visibility(
            &mut view,
            &Ok(SkillInventory {
                observations: vec![observed],
                warnings: Vec::new(),
            }),
        );
        assert!(view.visible_to.is_empty());
        assert_eq!(view.status, "inactive");
        assert_eq!(view.agents, [AgentKind::ClaudeCode]);
    }

    #[test]
    fn detail_requests_require_one_identity_and_reject_extra_paths() {
        assert!(validate_detail_ids(Some("library"), None).is_ok());
        assert!(validate_detail_ids(None, Some("observation")).is_ok());
        assert!(validate_detail_ids(None, None).is_err());
        assert!(validate_detail_ids(Some("a"), Some("b")).is_err());
        assert!(validate_detail_ids(Some(""), None).is_err());
        assert!(
            serde_json::from_value::<DetailRequest>(serde_json::json!({
                "library_id": "a", "path": "/unrelated"
            }))
            .is_err()
        );
    }

    #[test]
    fn deployment_apply_requires_confirmation_without_implicit_home_approval() {
        let request: ApplyRequest = serde_json::from_value(serde_json::json!({
            "token": "preview", "confirmed": true
        }))
        .unwrap();
        assert!(!request.approve_home);
        assert!(
            serde_json::from_value::<ApplyRequest>(serde_json::json!({
                "token": "preview"
            }))
            .is_err()
        );
        assert!(!is_method("skills.arbitrary"));
    }
}
