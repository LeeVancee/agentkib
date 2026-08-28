use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{self, BufRead, Write};
use std::path::Path;

use agentkib_core::{AgentKind, McpNetworkSettings};
use agentkib_insights::InsightsQuery;
use agentkib_protocol::{
    ADD_WORKSPACE_METHOD, EXCLUDE_WORKSPACE_METHOD, GIT_COMMIT_FILES_METHOD, GIT_DIFF_METHOD,
    HANDSHAKE_METHOD, HandshakeRequest, HandshakeResult, INSIGHTS_STATUS_METHOD,
    INSIGHTS_SUMMARY_METHOD, LIST_ACTIVITY_METHOD, LIST_AGENT_INSTALLATIONS_METHOD,
    LIST_EXCLUDED_WORKSPACES_METHOD, LIST_GLOBAL_MEMORIES_METHOD, LIST_REMOTE_GATEWAYS_METHOD,
    LIST_SCAN_ROOTS_METHOD, LIST_WORKSPACES_METHOD, PREPARE_MANIFEST_METHOD, PROTOCOL_VERSION,
    QUOTA_COLLECTOR_STATUS_METHOD, REFRESH_STATUS_METHOD, REFRESH_WORKSPACE_METHOD,
    RESOLVE_CONTEXT_METHOD, RESTORE_EXCLUDED_WORKSPACE_METHOD, RUNTIME_INFO_METHOD, RpcRequest,
    RpcResponse, RuntimePeer, SCAN_WORKSPACE_METHOD, SEARCH_CATALOG_ASSETS_METHOD, SHUTDOWN_METHOD,
    UPDATE_ONBOARDING_METHOD, WORKSPACE_DOCTOR_REPORT_METHOD, WORKSPACE_DOCTOR_SUMMARIES_METHOD,
    WORKSPACE_GIT_HISTORY_METHOD, WORKSPACE_GIT_SUMMARY_METHOD,
};
use agentkib_quota::QuotaBackend;
use agentkib_store::Store;
use chrono::Utc;
use serde::Deserialize;
use serde_json::{Value, json};

fn main() {
    if let Err(error) = run() {
        eprintln!("agentkib runtime failed: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();

    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }

        let (response, should_shutdown) = match serde_json::from_str::<RpcRequest>(&line) {
            Ok(request) => handle_request(request),
            Err(error) => (
                RpcResponse::error(
                    Value::Null,
                    -32700,
                    "Parse error",
                    Some(json!({ "detail": error.to_string() })),
                ),
                false,
            ),
        };

        serde_json::to_writer(&mut stdout, &response)?;
        stdout.write_all(b"\n")?;
        stdout.flush()?;

        if should_shutdown {
            break;
        }
    }

    Ok(())
}

fn handle_request(request: RpcRequest) -> (RpcResponse, bool) {
    if request.jsonrpc != "2.0" {
        return (
            RpcResponse::error(request.id, -32600, "Invalid JSON-RPC version", None),
            false,
        );
    }

    match request.method.as_str() {
        HANDSHAKE_METHOD => handle_handshake(request),
        SHUTDOWN_METHOD => (RpcResponse::success(request.id, Value::Null), true),
        SCAN_WORKSPACE_METHOD => command_response(request, scan_workspace),
        PREPARE_MANIFEST_METHOD => command_response(request, prepare_manifest),
        RESOLVE_CONTEXT_METHOD => command_response(request, resolve_context),
        ADD_WORKSPACE_METHOD => command_response(request, add_workspace),
        REFRESH_WORKSPACE_METHOD => command_response(request, refresh_workspace),
        EXCLUDE_WORKSPACE_METHOD => command_response(request, exclude_workspace),
        RESTORE_EXCLUDED_WORKSPACE_METHOD => command_response(request, restore_excluded_workspace),
        WORKSPACE_DOCTOR_REPORT_METHOD => command_response(request, get_workspace_doctor_report),
        WORKSPACE_GIT_SUMMARY_METHOD => command_response(request, workspace_git_summary),
        WORKSPACE_GIT_HISTORY_METHOD => command_response(request, workspace_git_history),
        GIT_COMMIT_FILES_METHOD => command_response(request, git_commit_files),
        GIT_DIFF_METHOD => command_response(request, git_diff),
        RUNTIME_INFO_METHOD => command_response(request, runtime_info),
        LIST_WORKSPACES_METHOD => command_response(request, list_workspaces),
        LIST_AGENT_INSTALLATIONS_METHOD => command_response(request, list_agent_installations),
        SEARCH_CATALOG_ASSETS_METHOD => command_response(request, search_catalog_assets),
        LIST_GLOBAL_MEMORIES_METHOD => command_response(request, list_global_memories),
        LIST_ACTIVITY_METHOD => command_response(request, list_activity),
        LIST_SCAN_ROOTS_METHOD => command_response(request, list_scan_roots),
        LIST_EXCLUDED_WORKSPACES_METHOD => command_response(request, list_excluded_workspaces),
        LIST_REMOTE_GATEWAYS_METHOD => command_response(request, list_remote_gateways),
        WORKSPACE_DOCTOR_SUMMARIES_METHOD => command_response(request, workspace_doctor_summaries),
        INSIGHTS_SUMMARY_METHOD => command_response(request, insights_summary),
        INSIGHTS_STATUS_METHOD => command_response(request, insights_status),
        QUOTA_COLLECTOR_STATUS_METHOD => command_response(request, quota_collector_status),
        REFRESH_STATUS_METHOD => command_response(request, refresh_status),
        UPDATE_ONBOARDING_METHOD => command_response(request, update_onboarding),
        _ => (
            RpcResponse::error(
                request.id,
                -32601,
                format!("Unknown method: {}", request.method),
                None,
            ),
            false,
        ),
    }
}

fn command_response<TParams, TResult>(
    request: RpcRequest,
    command: impl FnOnce(TParams) -> anyhow::Result<TResult>,
) -> (RpcResponse, bool)
where
    TParams: for<'de> Deserialize<'de>,
    TResult: serde::Serialize,
{
    let params = match serde_json::from_value(request.params) {
        Ok(params) => params,
        Err(error) => {
            return (
                RpcResponse::error(
                    request.id,
                    -32602,
                    "Invalid method parameters",
                    Some(json!({ "detail": error.to_string() })),
                ),
                false,
            );
        }
    };

    match command(params).and_then(|result| serde_json::to_value(result).map_err(Into::into)) {
        Ok(result) => (RpcResponse::success(request.id, result), false),
        Err(error) => (
            RpcResponse::error(
                request.id,
                -32000,
                "AgentKib command failed",
                Some(json!({ "detail": format!("{error:#}") })),
            ),
            false,
        ),
    }
}

#[derive(Deserialize)]
struct ProjectRequest {
    project: String,
}

fn scan_workspace(request: ProjectRequest) -> anyhow::Result<agentkib_core::WorkspaceScan> {
    agentkib_core::scan_workspace(Path::new(&request.project))
}

fn prepare_manifest(request: ProjectRequest) -> anyhow::Result<agentkib_core::Manifest> {
    let project = Path::new(&request.project);
    if agentkib_core::manifest_path(project).is_file() {
        agentkib_core::load_manifest(project)
    } else {
        agentkib_adapters::default_manifest(project)
    }
}

#[derive(Deserialize)]
struct ResolveContextRequest {
    project: String,
    cwd: String,
    agent: agentkib_core::AgentKind,
}

fn resolve_context(
    request: ResolveContextRequest,
) -> anyhow::Result<agentkib_core::ContextPreview> {
    let project = Path::new(&request.project);
    let manifest = agentkib_core::load_manifest(project).ok();
    let memories = if let (Some(manifest), Ok(store)) = (manifest.as_ref(), Store::open_default()) {
        store
            .list_memories(
                &manifest.workspace.id,
                Some(agentkib_core::MemoryStatus::Approved),
            )
            .unwrap_or_default()
            .into_iter()
            .map(|value| value.content)
            .collect()
    } else {
        Vec::new()
    };
    let mut preview = agentkib_core::resolve_context(
        project,
        Path::new(&request.cwd),
        request.agent,
        manifest.as_ref(),
        memories,
    )?;
    preview.visible_connections =
        agentkib_mcp::config::load_visible_servers(Some(project), request.agent)?
            .into_iter()
            .map(|server| server.name)
            .collect();
    Ok(preview)
}

#[derive(Deserialize)]
struct WorkspacePathRequest {
    path: String,
}

#[derive(Deserialize)]
struct WorkspaceIdRequest {
    id: String,
}

fn add_workspace(request: WorkspacePathRequest) -> anyhow::Result<agentkib_core::WorkspaceSummary> {
    Store::open_default()?.add_workspace(Path::new(&request.path))
}

fn refresh_workspace(
    request: WorkspaceIdRequest,
) -> anyhow::Result<agentkib_core::WorkspaceSummary> {
    Store::open_default()?.refresh_workspace(&request.id)
}

fn exclude_workspace(request: WorkspaceIdRequest) -> anyhow::Result<()> {
    Store::open_default()?.exclude_workspace(&request.id)
}

fn restore_excluded_workspace(request: WorkspacePathRequest) -> anyhow::Result<()> {
    Store::open_default()?.restore_excluded_workspace(Path::new(&request.path))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceGitHistoryRequest {
    workspace_id: String,
    #[serde(default)]
    query: agentkib_git::GitHistoryQuery,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitCommitFilesRequest {
    workspace_id: String,
    oid: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitDiffRequest {
    workspace_id: String,
    request: agentkib_git::GitDiffRequest,
}

fn workspace_git_summary(
    request: WorkspaceIdRequest,
) -> anyhow::Result<Option<agentkib_git::GitWorkspaceSummary>> {
    let path = Store::open_default()?.workspace_path(&request.id)?;
    agentkib_git::workspace_summary(&path)
}

fn workspace_git_history(
    request: WorkspaceGitHistoryRequest,
) -> anyhow::Result<Option<agentkib_git::GitCommitPage>> {
    let path = Store::open_default()?.workspace_path(&request.workspace_id)?;
    agentkib_git::history(&path, &request.query)
}

fn git_commit_files(
    request: GitCommitFilesRequest,
) -> anyhow::Result<Option<Vec<agentkib_git::GitFileChange>>> {
    let path = Store::open_default()?.workspace_path(&request.workspace_id)?;
    agentkib_git::commit_files(&path, &request.oid)
}

fn git_diff(request: GitDiffRequest) -> anyhow::Result<Option<agentkib_git::GitDiff>> {
    let path = Store::open_default()?.workspace_path(&request.workspace_id)?;
    agentkib_git::diff(&path, &request.request)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogAssetsRequest {
    #[serde(default)]
    query: String,
    agent: Option<AgentKind>,
    workspace_id: Option<String>,
    #[serde(default = "default_catalog_limit")]
    limit: usize,
}

fn default_catalog_limit() -> usize {
    500
}

const ONBOARDING_VERSION: u32 = 1;

#[derive(Debug, Default, Deserialize, serde::Serialize)]
struct OnboardingPreferences {
    #[serde(default)]
    acknowledged_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    workspace_id: Option<String>,
    #[serde(default)]
    doctor_completed: bool,
    #[serde(default)]
    repairable_count: usize,
    #[serde(default)]
    repair_applied: bool,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "event", rename_all = "kebab-case")]
enum OnboardingEvent {
    DoctorCompleted {
        workspace_id: String,
        repairable_count: usize,
    },
    RepairApplied {
        workspace_id: String,
    },
    Dismissed,
    Restarted,
}

#[derive(Deserialize)]
struct UpdateOnboardingRequest {
    event: OnboardingEvent,
}

fn apply_onboarding_event(preferences: &mut OnboardingPreferences, event: OnboardingEvent) {
    match event {
        OnboardingEvent::DoctorCompleted {
            workspace_id,
            repairable_count,
        } => {
            if preferences.workspace_id.as_deref() != Some(workspace_id.as_str()) {
                preferences.repair_applied = false;
            }
            preferences.workspace_id = Some(workspace_id);
            preferences.doctor_completed = true;
            preferences.repairable_count = repairable_count;
            if repairable_count == 0 {
                preferences.acknowledged_version = ONBOARDING_VERSION;
            }
        }
        OnboardingEvent::RepairApplied { workspace_id } => {
            preferences.workspace_id = Some(workspace_id);
            preferences.repair_applied = true;
        }
        OnboardingEvent::Dismissed => {
            preferences.acknowledged_version = ONBOARDING_VERSION;
        }
        OnboardingEvent::Restarted => {
            *preferences = OnboardingPreferences::default();
        }
    }
}

fn load_onboarding_preferences(data_dir: &Path) -> OnboardingPreferences {
    let path = data_dir.join("preferences.json");
    let Ok(contents) = fs::read_to_string(path) else {
        return OnboardingPreferences::default();
    };
    serde_json::from_str::<Value>(&contents)
        .ok()
        .and_then(|root| root.get("onboarding").cloned())
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}

fn onboarding_state(data_dir: &Path) -> Value {
    let preferences = load_onboarding_preferences(data_dir);
    json!({
        "version": ONBOARDING_VERSION,
        "acknowledged_version": preferences.acknowledged_version,
        "workspace_id": preferences.workspace_id,
        "doctor_completed": preferences.doctor_completed,
        "repairable_count": preferences.repairable_count,
        "repair_applied": preferences.repair_applied,
    })
}

fn runtime_info(_: EmptyRequest) -> anyhow::Result<Value> {
    let data_dir = agentkib_store::default_data_dir()?;
    let network = McpNetworkSettings::default();
    let development = std::env::var("AGENTKIB_APP_FLAVOR").as_deref() == Ok("ai.agentkib.dev");
    let locale = std::env::var("AGENTKIB_LOCALE").unwrap_or_else(|_| "en-US".to_owned());
    let effective_theme =
        std::env::var("AGENTKIB_SYSTEM_THEME").unwrap_or_else(|_| "light".to_owned());
    let home = dirs::home_dir();

    Ok(json!({
        "app_name": if development { "AgentKib Dev" } else { "AgentKib" },
        "app_version": env!("CARGO_PKG_VERSION"),
        "app_channel": if development { "development" } else { "stable" },
        "updates_enabled": !development,
        "data_dir": data_dir,
        "database_path": data_dir.join("agentkib.db"),
        "mcp_package_root": agentkib_mcp::installation_root()?,
        "mcp_hub": {
            "running": false,
            "bind_address": "127.0.0.1",
            "port": network.port,
            "lan_enabled": network.lan_enabled,
            "accessible_addresses": [],
            "runtime_count": 0,
            "error_count": 0,
        },
        "mcp_network": network,
        "openclaw_config": home.as_ref().map(|path| path.join(".openclaw/openclaw.json")),
        "hermes_config": home.map(|path| path.join(".hermes/config.yaml")),
        "close_behavior": null,
        "locale_preference": "system",
        "effective_locale": locale,
        "theme_preference": "system",
        "effective_theme": effective_theme,
        "app_icon_preference": "white",
        "tray_available": false,
        "session_index_enabled": true,
        "quota_auto_refresh_enabled": false,
        "quota_auto_refresh_prompt_seen": false,
        "onboarding": onboarding_state(&data_dir),
    }))
}

#[derive(Deserialize)]
struct EmptyRequest {}

fn update_onboarding(request: UpdateOnboardingRequest) -> anyhow::Result<Value> {
    let data_dir = agentkib_store::default_data_dir()?;
    fs::create_dir_all(&data_dir)?;
    let path = data_dir.join("preferences.json");
    let mut root = fs::read_to_string(&path)
        .ok()
        .and_then(|contents| serde_json::from_str::<Value>(&contents).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    let mut preferences = load_onboarding_preferences(&data_dir);
    apply_onboarding_event(&mut preferences, request.event);
    root["onboarding"] = serde_json::to_value(preferences)?;
    fs::write(path, format!("{}\n", serde_json::to_string_pretty(&root)?))?;
    runtime_info(EmptyRequest {})
}

fn list_workspaces(_: EmptyRequest) -> anyhow::Result<Vec<agentkib_core::WorkspaceSummary>> {
    Store::open_default()?.list_workspaces()
}

fn list_agent_installations(
    _: EmptyRequest,
) -> anyhow::Result<Vec<agentkib_core::AgentInstallation>> {
    Store::open_default()?.list_agent_installations()
}

fn search_catalog_assets(
    request: CatalogAssetsRequest,
) -> anyhow::Result<Vec<agentkib_core::CatalogAsset>> {
    Store::open_default()?.search_catalog_assets(
        &request.query,
        request.agent,
        request.workspace_id.as_deref(),
        request.limit,
    )
}

#[derive(Deserialize)]
struct MemoryListRequest {
    status: Option<agentkib_core::MemoryStatus>,
}

fn list_global_memories(
    request: MemoryListRequest,
) -> anyhow::Result<Vec<agentkib_core::MemoryRecord>> {
    Store::open_default()?.list_global_memories(request.status)
}

#[derive(Deserialize)]
struct LimitRequest {
    #[serde(default = "default_activity_limit")]
    limit: usize,
}

fn default_activity_limit() -> usize {
    200
}

fn list_activity(request: LimitRequest) -> anyhow::Result<Vec<agentkib_core::ActivityRecord>> {
    Store::open_default()?.list_activity(request.limit)
}

fn list_scan_roots(_: EmptyRequest) -> anyhow::Result<Vec<agentkib_core::ScanRoot>> {
    Store::open_default()?.list_scan_roots()
}

fn list_excluded_workspaces(
    _: EmptyRequest,
) -> anyhow::Result<Vec<agentkib_core::ExcludedWorkspace>> {
    Store::open_default()?.list_excluded_workspaces()
}

fn list_remote_gateways(
    _: EmptyRequest,
) -> anyhow::Result<Vec<agentkib_gateways::RemoteGatewaySummary>> {
    let path = agentkib_gateways::default_registry_path(&agentkib_store::default_data_dir()?);
    agentkib_gateways::list(&path)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceDoctorRequest {
    workspace_ids: Vec<String>,
}

fn workspace_doctor_summaries(
    request: WorkspaceDoctorRequest,
) -> anyhow::Result<Vec<agentkib_core::ContextDoctorSummary>> {
    if request.workspace_ids.len() > 100 {
        anyhow::bail!("workspace doctor accepts at most 100 workspaces")
    }
    Ok(request
        .workspace_ids
        .iter()
        .map(|workspace_id| {
            workspace_doctor_report(workspace_id)
                .map(|report| report.summary)
                .unwrap_or_else(|_| unavailable_doctor_summary(workspace_id))
        })
        .collect())
}

fn get_workspace_doctor_report(
    request: WorkspaceIdRequest,
) -> anyhow::Result<agentkib_core::ContextDoctorReport> {
    workspace_doctor_report(&request.id)
}

fn workspace_doctor_report(
    workspace_id: &str,
) -> anyhow::Result<agentkib_core::ContextDoctorReport> {
    let store = Store::open_default()?;
    let project = store.workspace_path(workspace_id)?;
    let installed_agents = store
        .list_agent_installations()?
        .into_iter()
        .filter(|installation| installation.installed)
        .map(|installation| installation.agent)
        .collect::<BTreeSet<_>>();
    let (effective_servers, mcp_load_error) =
        match agentkib_mcp::config::load_effective_config(Some(&project)) {
            Ok(config) => (config.servers, None),
            Err(error) => (Vec::new(), Some(error.to_string())),
        };
    let visible_connections = AgentKind::ALL
        .into_iter()
        .map(|agent| {
            let names = effective_servers
                .iter()
                .filter(|server| {
                    server.enabled && (server.targets.is_empty() || server.targets.contains(&agent))
                })
                .map(|server| server.name.clone())
                .collect();
            (agent, names)
        })
        .collect::<BTreeMap<_, Vec<_>>>();
    agentkib_core::diagnose_workspace_with_mcp_error(
        &project,
        workspace_id,
        &installed_agents,
        &visible_connections,
        mcp_load_error.as_deref(),
    )
}

fn unavailable_doctor_summary(workspace_id: &str) -> agentkib_core::ContextDoctorSummary {
    agentkib_core::ContextDoctorSummary {
        workspace_id: workspace_id.to_owned(),
        error_count: 1,
        warning_count: 0,
        info_count: 0,
        repairable_count: 0,
        checked_at: Utc::now(),
    }
}

#[derive(Deserialize)]
struct InsightsRequest {
    #[serde(default = "default_insights_query")]
    query: InsightsQuery,
}

fn default_insights_query() -> InsightsQuery {
    InsightsQuery {
        from: None,
        to: None,
        agent: None,
        workspace_id: None,
        repository_group_id: None,
    }
}

fn insights_summary(
    request: InsightsRequest,
) -> anyhow::Result<agentkib_insights::InsightsSummary> {
    Store::open_default()?.insights_summary(&request.query)
}

fn insights_status(_: EmptyRequest) -> anyhow::Result<agentkib_insights::InsightsStatus> {
    Store::open_default()?.insights_status(false)
}

fn quota_collector_status(_: EmptyRequest) -> anyhow::Result<agentkib_quota::QuotaCollectorStatus> {
    let backend = if cfg!(target_os = "windows") {
        QuotaBackend::WinCodexBar
    } else {
        QuotaBackend::CodexBarCli
    };
    Store::open_default()?.quota_collector_status(
        backend,
        true,
        false,
        "unavailable".to_owned(),
        false,
    )
}

fn refresh_status(_: EmptyRequest) -> anyhow::Result<Vec<Value>> {
    Ok(Vec::new())
}

fn handle_handshake(request: RpcRequest) -> (RpcResponse, bool) {
    let handshake = match serde_json::from_value::<HandshakeRequest>(request.params) {
        Ok(handshake) => handshake,
        Err(error) => {
            return (
                RpcResponse::error(
                    request.id,
                    -32602,
                    "Invalid handshake parameters",
                    Some(json!({ "detail": error.to_string() })),
                ),
                false,
            );
        }
    };

    if handshake.protocol_version != PROTOCOL_VERSION {
        return (
            RpcResponse::error(
                request.id,
                -32001,
                "Incompatible protocol version",
                Some(json!({
                    "expected": PROTOCOL_VERSION,
                    "received": handshake.protocol_version,
                    "client": handshake.client,
                })),
            ),
            false,
        );
    }

    let result = HandshakeResult {
        protocol_version: PROTOCOL_VERSION,
        runtime: RuntimePeer {
            name: "agentkib-runtime".to_owned(),
            version: env!("CARGO_PKG_VERSION").to_owned(),
        },
        pid: std::process::id(),
    };

    (
        RpcResponse::success(
            request.id,
            serde_json::to_value(result).expect("handshake result must serialize"),
        ),
        false,
    )
}
