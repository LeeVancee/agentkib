use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{self, BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use agentkib_conversations::{provider, providers};
use agentkib_core::{AgentKind, McpNetworkSettings};
use agentkib_discovery::discover as discover_local_workspaces;
use agentkib_insights::{InsightsCollectionPolicy, InsightsQuery, collect_git, collect_usage};
use agentkib_platform::path as platform_path;
use agentkib_platform::process::{ProcessTree, configure_process_group};
use agentkib_protocol::{
    ADD_SCAN_ROOT_METHOD, ADD_WORKSPACE_METHOD, CANCEL_STORAGE_METHOD, EXCLUDE_WORKSPACE_METHOD,
    GIT_COMMIT_FILES_METHOD, GIT_DIFF_METHOD, HANDSHAKE_METHOD, HandshakeRequest, HandshakeResult,
    INSIGHTS_STATUS_METHOD, INSIGHTS_SUMMARY_METHOD, INSIGHTS_VIEW_METHOD, LIST_ACTIVITY_METHOD,
    LIST_AGENT_INSTALLATIONS_METHOD, LIST_EXCLUDED_WORKSPACES_METHOD, LIST_GLOBAL_MEMORIES_METHOD,
    LIST_REMOTE_GATEWAYS_METHOD, LIST_SCAN_ROOTS_METHOD, LIST_WORKSPACES_METHOD,
    PREPARE_MANIFEST_METHOD, PROTOCOL_VERSION, QUOTA_COLLECTOR_STATUS_METHOD,
    QUOTA_PREFERENCES_METHOD, QUOTA_SNAPSHOT_METHOD, REFRESH_DISCOVERY_METHOD,
    REFRESH_INSIGHTS_METHOD, REFRESH_QUOTA_METHOD, REFRESH_STATUS_METHOD, REFRESH_STORAGE_METHOD,
    REFRESH_WORKSPACE_METHOD, REFRESH_WORKSPACE_SESSIONS_METHOD, REMOVE_SCAN_ROOT_METHOD,
    RESOLVE_CONTEXT_METHOD, RESOLVE_STORAGE_PATH_METHOD, RESTORE_EXCLUDED_WORKSPACE_METHOD,
    RUNTIME_INFO_METHOD, RpcRequest, RpcResponse, RuntimePeer, SCAN_WORKSPACE_METHOD,
    SEARCH_CATALOG_ASSETS_METHOD, SESSION_EVENTS_METHOD, SET_QUOTA_AUTO_REFRESH_METHOD,
    SET_QUOTA_PREFERENCES_METHOD, SET_QUOTA_PROMPT_SEEN_METHOD, SHUTDOWN_METHOD,
    STORAGE_CHILDREN_METHOD, STORAGE_OVERVIEW_METHOD, UPDATE_ONBOARDING_METHOD,
    WORKSPACE_DOCTOR_REPORT_METHOD, WORKSPACE_DOCTOR_SUMMARIES_METHOD,
    WORKSPACE_GIT_HISTORY_METHOD, WORKSPACE_GIT_SUMMARY_METHOD, WORKSPACE_SESSION_STATUS_METHOD,
    WORKSPACE_SESSIONS_METHOD,
};
use agentkib_quota::{
    CollectorCapabilities, DashboardCliCollector, QuotaBackend, QuotaCollector, QuotaCommandOutput,
    QuotaCommandRunner, QuotaSnapshot,
};
use agentkib_storage::{
    HardLinkSet, StorageNode, StorageOverview, StorageWorkspace,
    scan_workspace as scan_workspace_storage, scan_workspace_children,
};
use agentkib_store::Store;
use chrono::Utc;
use serde::{Deserialize, Serialize};
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
        WORKSPACE_SESSIONS_METHOD => command_response(request, workspace_sessions),
        WORKSPACE_SESSION_STATUS_METHOD => command_response(request, workspace_session_status),
        REFRESH_WORKSPACE_SESSIONS_METHOD => command_response(request, refresh_workspace_sessions),
        SESSION_EVENTS_METHOD => command_response(request, session_events),
        RUNTIME_INFO_METHOD => command_response(request, runtime_info),
        LIST_WORKSPACES_METHOD => command_response(request, list_workspaces),
        LIST_AGENT_INSTALLATIONS_METHOD => command_response(request, list_agent_installations),
        SEARCH_CATALOG_ASSETS_METHOD => command_response(request, search_catalog_assets),
        LIST_GLOBAL_MEMORIES_METHOD => command_response(request, list_global_memories),
        LIST_ACTIVITY_METHOD => command_response(request, list_activity),
        LIST_SCAN_ROOTS_METHOD => command_response(request, list_scan_roots),
        ADD_SCAN_ROOT_METHOD => command_response(request, add_scan_root),
        REMOVE_SCAN_ROOT_METHOD => command_response(request, remove_scan_root),
        REFRESH_DISCOVERY_METHOD => command_response(request, refresh_discovery),
        LIST_EXCLUDED_WORKSPACES_METHOD => command_response(request, list_excluded_workspaces),
        LIST_REMOTE_GATEWAYS_METHOD => command_response(request, list_remote_gateways),
        WORKSPACE_DOCTOR_SUMMARIES_METHOD => command_response(request, workspace_doctor_summaries),
        INSIGHTS_VIEW_METHOD => command_response(request, insights_view),
        REFRESH_INSIGHTS_METHOD => command_response(request, refresh_insights),
        INSIGHTS_SUMMARY_METHOD => command_response(request, insights_summary),
        INSIGHTS_STATUS_METHOD => command_response(request, insights_status),
        QUOTA_COLLECTOR_STATUS_METHOD => command_response(request, quota_collector_status),
        QUOTA_SNAPSHOT_METHOD => command_response(request, quota_snapshot),
        QUOTA_PREFERENCES_METHOD => command_response(request, quota_preferences),
        SET_QUOTA_PREFERENCES_METHOD => command_response(request, set_quota_preferences),
        REFRESH_QUOTA_METHOD => command_response(request, refresh_quota),
        SET_QUOTA_AUTO_REFRESH_METHOD => command_response(request, set_quota_auto_refresh),
        SET_QUOTA_PROMPT_SEEN_METHOD => command_response(request, set_quota_prompt_seen),
        STORAGE_OVERVIEW_METHOD => command_response(request, storage_overview),
        STORAGE_CHILDREN_METHOD => command_response(request, storage_children),
        REFRESH_STORAGE_METHOD => command_response(request, refresh_storage),
        RESOLVE_STORAGE_PATH_METHOD => command_response(request, resolve_storage_path),
        CANCEL_STORAGE_METHOD => command_response(request, cancel_storage),
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
struct WorkspaceSessionRequest {
    workspace_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RefreshWorkspaceSessionsRequest {
    workspace_id: String,
    #[serde(default)]
    force: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionEventsRequest {
    session_id: String,
    cursor: Option<String>,
    limit: Option<usize>,
}

fn workspace_sessions(
    request: WorkspaceSessionRequest,
) -> anyhow::Result<Vec<agentkib_conversations::ConversationSessionSummary>> {
    Store::open_default()?.list_conversation_sessions(&request.workspace_id)
}

fn workspace_session_status(
    request: WorkspaceSessionRequest,
) -> anyhow::Result<Vec<agentkib_conversations::ConversationIndexStatus>> {
    Store::open_default()?.conversation_index_status(&request.workspace_id)
}

fn refresh_workspace_sessions(
    request: RefreshWorkspaceSessionsRequest,
) -> anyhow::Result<Vec<agentkib_conversations::ConversationSessionSummary>> {
    let store = Store::open_default()?;
    if !request.force {
        let statuses = store.conversation_index_status(&request.workspace_id)?;
        if statuses.len() == 2
            && statuses.iter().all(|status| {
                status.freshness == agentkib_conversations::SessionIndexFreshness::Fresh
            })
        {
            return store.list_conversation_sessions(&request.workspace_id);
        }
    }
    let workspace = store.workspace_path(&request.workspace_id)?;
    for source in providers() {
        let agent = source.agent();
        match source.list_sessions(&workspace) {
            Ok(sessions) => {
                store.sync_conversation_sessions(&request.workspace_id, agent, &sessions)?;
            }
            Err(_) => store.record_conversation_index_failure(
                &request.workspace_id,
                agent,
                "errors.conversations.sourceUnavailable",
                "Conversation source could not be read",
            )?,
        }
    }
    store.list_conversation_sessions(&request.workspace_id)
}

fn session_events(
    request: SessionEventsRequest,
) -> anyhow::Result<agentkib_conversations::ConversationEventPage> {
    let store = Store::open_default()?;
    let session = store
        .get_conversation_session(&request.session_id)?
        .ok_or_else(|| anyhow::anyhow!("Conversation metadata is no longer available"))?;
    let workspace = store.workspace_path(&session.workspace_id)?;
    let source = provider(session.agent)
        .ok_or_else(|| anyhow::anyhow!("Conversation provider is unavailable"))?;
    let native = source
        .list_sessions(&workspace)?
        .into_iter()
        .find(|candidate| {
            store
                .conversation_id(session.agent, &candidate.native_ref)
                .is_ok_and(|id| id == request.session_id)
        })
        .ok_or_else(|| anyhow::anyhow!("Conversation transcript is no longer available"))?;
    source.read_events(
        &native.native_ref,
        request.cursor.as_deref(),
        request.limit.unwrap_or(100),
    )
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

fn load_preferences_root(data_dir: &Path) -> Value {
    fs::read_to_string(data_dir.join("preferences.json"))
        .ok()
        .and_then(|contents| serde_json::from_str::<Value>(&contents).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}

fn save_preferences_root(data_dir: &Path, root: &Value) -> anyhow::Result<()> {
    fs::create_dir_all(data_dir)?;
    fs::write(
        data_dir.join("preferences.json"),
        format!("{}\n", serde_json::to_string_pretty(root)?),
    )?;
    Ok(())
}

fn runtime_info(_: EmptyRequest) -> anyhow::Result<Value> {
    let data_dir = agentkib_store::default_data_dir()?;
    let preferences = load_preferences_root(&data_dir);
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
        "quota_auto_refresh_enabled": preferences
            .get("quota_auto_refresh_enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        "quota_auto_refresh_prompt_seen": preferences
            .get("quota_auto_refresh_prompt_seen")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        "onboarding": onboarding_state(&data_dir),
    }))
}

#[derive(Deserialize)]
struct EmptyRequest {}

fn update_onboarding(request: UpdateOnboardingRequest) -> anyhow::Result<Value> {
    let data_dir = agentkib_store::default_data_dir()?;
    let mut root = load_preferences_root(&data_dir);
    let mut preferences = load_onboarding_preferences(&data_dir);
    apply_onboarding_event(&mut preferences, request.event);
    root["onboarding"] = serde_json::to_value(preferences)?;
    save_preferences_root(&data_dir, &root)?;
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddScanRootRequest {
    path: String,
    max_depth: usize,
}

fn add_scan_root(request: AddScanRootRequest) -> anyhow::Result<agentkib_core::ScanRoot> {
    Store::open_default()?.add_scan_root(Path::new(&request.path), request.max_depth)
}

fn remove_scan_root(request: WorkspaceIdRequest) -> anyhow::Result<()> {
    Store::open_default()?.remove_scan_root(&request.id)
}

fn refresh_discovery(_: EmptyRequest) -> anyhow::Result<RefreshReceipt> {
    let queued_at = Utc::now();
    let started_at = Utc::now();
    let roots = Store::open_default()?
        .list_scan_roots()?
        .into_iter()
        .filter(|root| root.enabled)
        .map(|root| (root.path, root.max_depth))
        .collect::<Vec<_>>();
    let snapshot = discover_local_workspaces(&roots);
    Store::open_default()?.sync_discovery(
        &snapshot.candidates,
        &snapshot.installations,
        &snapshot.home_assets,
        started_at,
        &snapshot.errors,
    )?;
    Ok(completed_refresh_receipt(
        "discovery",
        queued_at,
        started_at,
    ))
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

#[derive(Serialize)]
struct InsightsView {
    summary: agentkib_insights::InsightsSummary,
    heatmap: Vec<agentkib_insights::HeatmapPoint>,
    agents: Vec<agentkib_insights::AgentUsageBreakdown>,
    models: Vec<agentkib_insights::ModelUsageBreakdown>,
    workspaces: Vec<agentkib_insights::WorkspaceUsageBreakdown>,
    repositories: Vec<agentkib_insights::RepositoryCommitBreakdown>,
    achievements: Vec<agentkib_insights::Achievement>,
    status: agentkib_insights::InsightsStatus,
}

#[derive(Serialize)]
struct RefreshReceipt {
    kind: &'static str,
    disposition: &'static str,
    request_id: String,
    status: RefreshJobStatus,
}

#[derive(Serialize)]
struct RefreshJobStatus {
    kind: &'static str,
    state: &'static str,
    request_id: String,
    queued_at: chrono::DateTime<Utc>,
    started_at: chrono::DateTime<Utc>,
    finished_at: chrono::DateTime<Utc>,
    progress_current: u64,
    progress_total: u64,
    error: Option<String>,
    next_allowed_at: Option<chrono::DateTime<Utc>>,
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

fn insights_view(request: InsightsRequest) -> anyhow::Result<InsightsView> {
    let store = Store::open_default()?;
    Ok(InsightsView {
        summary: store.insights_summary(&request.query)?,
        heatmap: store.insights_heatmap(&request.query)?,
        agents: store.agent_usage_breakdown(&request.query)?,
        models: store.model_usage_breakdown(&request.query)?,
        workspaces: store.workspace_usage_breakdown(&request.query)?,
        repositories: store.repository_commit_breakdown(&request.query)?,
        achievements: store.list_achievements()?,
        status: store.insights_status(false)?,
    })
}

fn refresh_insights(_: EmptyRequest) -> anyhow::Result<RefreshReceipt> {
    let queued_at = Utc::now();
    let request_id = format!("{}-electron", queued_at.timestamp_millis());
    let started_at = Utc::now();
    let store = Store::open_default()?;
    let workspaces = store.list_workspaces()?;
    let fingerprints = store.insight_git_fingerprints()?;
    let usage_cursors = store.insight_usage_cursors()?;
    drop(store);

    let parallelism = std::thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(2);
    let policy = InsightsCollectionPolicy::for_parallelism(parallelism, true);
    let usage = collect_usage(&usage_cursors, policy);
    let repositories = collect_git(&workspaces, &fingerprints, policy);
    Store::open_default()?.sync_insights(&usage, &repositories)?;

    Ok(completed_refresh_receipt_with_id(
        "insights", request_id, queued_at, started_at,
    ))
}

fn completed_refresh_receipt(
    kind: &'static str,
    queued_at: chrono::DateTime<Utc>,
    started_at: chrono::DateTime<Utc>,
) -> RefreshReceipt {
    let request_id = format!("{}-electron", queued_at.timestamp_millis());
    completed_refresh_receipt_with_id(kind, request_id, queued_at, started_at)
}

fn completed_refresh_receipt_with_id(
    kind: &'static str,
    request_id: String,
    queued_at: chrono::DateTime<Utc>,
    started_at: chrono::DateTime<Utc>,
) -> RefreshReceipt {
    RefreshReceipt {
        kind,
        disposition: "queued",
        request_id: request_id.clone(),
        status: RefreshJobStatus {
            kind,
            state: "succeeded",
            request_id,
            queued_at,
            started_at,
            finished_at: Utc::now(),
            progress_current: 1,
            progress_total: 1,
            error: None,
            next_allowed_at: None,
        },
    }
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
        quota_platform_supported(),
        quota_sidecar_path().is_some(),
        "automatic".to_owned(),
        false,
    )
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
struct QuotaWindowSelector {
    provider_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    account_id: Option<String>,
    kind: String,
    label: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct QuotaPreferences {
    #[serde(default)]
    hidden_providers: Vec<String>,
    #[serde(default)]
    hidden_windows: Vec<QuotaWindowSelector>,
}

#[derive(Deserialize)]
struct SetQuotaPreferencesRequest {
    preferences: QuotaPreferences,
}

#[derive(Deserialize)]
struct BoolRequest {
    #[serde(alias = "enabled", alias = "seen")]
    value: bool,
}

fn quota_snapshot(_: EmptyRequest) -> anyhow::Result<Option<QuotaSnapshot>> {
    Store::open_default()?.quota_snapshot()
}

fn quota_preferences(_: EmptyRequest) -> anyhow::Result<QuotaPreferences> {
    let data_dir = agentkib_store::default_data_dir()?;
    Ok(load_preferences_root(&data_dir)
        .get("quota_popover")
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default())
}

fn set_quota_preferences(request: SetQuotaPreferencesRequest) -> anyhow::Result<QuotaPreferences> {
    let mut preferences = request.preferences;
    preferences
        .hidden_providers
        .retain(|value| !value.trim().is_empty());
    preferences.hidden_providers.sort();
    preferences.hidden_providers.dedup();
    preferences.hidden_windows.retain(|value| {
        !value.provider_id.trim().is_empty()
            && !value.kind.trim().is_empty()
            && !value.label.trim().is_empty()
    });
    preferences.hidden_windows.sort();
    preferences.hidden_windows.dedup();
    let data_dir = agentkib_store::default_data_dir()?;
    let mut root = load_preferences_root(&data_dir);
    root["quota_popover"] = serde_json::to_value(&preferences)?;
    save_preferences_root(&data_dir, &root)?;
    Ok(preferences)
}

fn set_quota_auto_refresh(request: BoolRequest) -> anyhow::Result<Value> {
    update_quota_boolean("quota_auto_refresh_enabled", request.value, true)
}

fn set_quota_prompt_seen(request: BoolRequest) -> anyhow::Result<Value> {
    update_quota_boolean("quota_auto_refresh_prompt_seen", request.value, false)
}

fn update_quota_boolean(key: &str, value: bool, mark_seen: bool) -> anyhow::Result<Value> {
    let data_dir = agentkib_store::default_data_dir()?;
    let mut root = load_preferences_root(&data_dir);
    root[key] = Value::Bool(value);
    if mark_seen {
        root["quota_auto_refresh_prompt_seen"] = Value::Bool(true);
    }
    save_preferences_root(&data_dir, &root)?;
    runtime_info(EmptyRequest {})
}

fn quota_platform_supported() -> bool {
    cfg!(any(target_os = "macos", target_os = "linux"))
        || cfg!(all(target_os = "windows", target_arch = "x86_64"))
}

fn quota_sidecar_path() -> Option<PathBuf> {
    std::env::var_os("AGENTKIB_QUOTA_SIDECAR")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .or_else(|| {
            std::env::current_exe()
                .ok()?
                .parent()
                .map(|path| {
                    path.join(if cfg!(target_os = "windows") {
                        "agentkib-quota-sidecar.exe"
                    } else {
                        "agentkib-quota-sidecar"
                    })
                })
                .filter(|path| path.is_file())
        })
}

#[derive(Clone)]
struct LocalQuotaRunner {
    executable: PathBuf,
}

impl QuotaCommandRunner for LocalQuotaRunner {
    fn run(
        &self,
        args: &[String],
        env: &BTreeMap<String, String>,
        timeout: Duration,
    ) -> anyhow::Result<QuotaCommandOutput> {
        let mut command = Command::new(&self.executable);
        command
            .args(args)
            .envs(env)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        configure_process_group(&mut command);
        let mut child = command.spawn()?;
        let tree = ProcessTree::attach(&child)?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow::anyhow!("quota stdout unavailable"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| anyhow::anyhow!("quota stderr unavailable"))?;
        let stdout_reader = std::thread::spawn(move || read_quota_output(stdout));
        let stderr_reader = std::thread::spawn(move || read_quota_output(stderr));
        let started = Instant::now();
        let success = loop {
            if started.elapsed() >= timeout {
                let _ = tree.terminate();
                let _ = child.wait();
                anyhow::bail!("quota collector timed out");
            }
            if let Some(status) = child.try_wait()? {
                break status.success();
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        Ok(QuotaCommandOutput {
            stdout: stdout_reader
                .join()
                .map_err(|_| anyhow::anyhow!("quota stdout reader panicked"))??,
            stderr: stderr_reader
                .join()
                .map_err(|_| anyhow::anyhow!("quota stderr reader panicked"))??,
            success,
        })
    }
}

fn read_quota_output(mut reader: impl Read) -> anyhow::Result<Vec<u8>> {
    const LIMIT: u64 = 2 * 1024 * 1024;
    let mut output = Vec::new();
    reader.by_ref().take(LIMIT + 1).read_to_end(&mut output)?;
    if output.len() as u64 > LIMIT {
        anyhow::bail!("quota collector output exceeded limit");
    }
    Ok(output)
}

fn refresh_quota(_: EmptyRequest) -> anyhow::Result<RefreshReceipt> {
    let queued_at = Utc::now();
    let started_at = Utc::now();
    let backend = if cfg!(target_os = "windows") {
        QuotaBackend::WinCodexBar
    } else {
        QuotaBackend::CodexBarCli
    };
    let executable = quota_sidecar_path()
        .ok_or_else(|| anyhow::anyhow!("quota collector sidecar is unavailable"))?;
    let collector = DashboardCliCollector::new(
        backend,
        LocalQuotaRunner { executable },
        BTreeMap::new(),
        CollectorCapabilities {
            platform_supported: quota_platform_supported(),
            sidecar_available: true,
            multi_account: true,
            credits: true,
        },
    );
    match collector.collect(Duration::from_secs(35)) {
        Ok(snapshot) => Store::open_default()?.save_quota_snapshot(&snapshot)?,
        Err(error) => {
            Store::open_default()?.record_quota_failure(
                backend,
                "errors.quotaUnavailable",
                Some(&error.to_string()),
            )?;
            return Err(error);
        }
    }
    Ok(completed_refresh_receipt("quota", queued_at, started_at))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoragePathRequest {
    workspace_id: String,
    relative_path: String,
}

fn storage_overview(_: EmptyRequest) -> anyhow::Result<StorageOverview> {
    Store::open_default()?.storage_overview()
}

fn checked_storage_path(
    request: &StoragePathRequest,
) -> anyhow::Result<(agentkib_core::WorkspaceSummary, PathBuf, PathBuf)> {
    let relative = PathBuf::from(&request.relative_path);
    if relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        anyhow::bail!("storage path must be relative to its workspace");
    }
    let workspace = Store::open_default()?
        .get_workspace(&request.workspace_id)?
        .ok_or_else(|| anyhow::anyhow!("workspace not found"))?;
    let root = platform_path::canonicalize(&workspace.path)?;
    let target = platform_path::canonicalize(&root.join(relative))?;
    if !platform_path::starts_with(&target, &root) || !target.is_dir() {
        anyhow::bail!("storage path is outside the workspace or is not a directory");
    }
    Ok((workspace, root, target))
}

fn storage_children(request: StoragePathRequest) -> anyhow::Result<StorageNode> {
    let (workspace, root, target) = checked_storage_path(&request)?;
    let relative = target.strip_prefix(&root)?.to_path_buf();
    let workspaces = Store::open_default()?.list_workspaces()?;
    let excluded = workspaces
        .iter()
        .filter(|candidate| {
            candidate.id != workspace.id && platform_path::starts_with(&candidate.path, &target)
        })
        .map(|candidate| candidate.path.clone())
        .collect::<Vec<_>>();
    let source = StorageWorkspace {
        id: workspace.id,
        name: workspace.name,
        path: root,
    };
    Ok(scan_workspace_children(
        &source,
        &relative,
        &excluded,
        &mut HardLinkSet::default(),
        || false,
    )
    .node)
}

fn resolve_storage_path(request: StoragePathRequest) -> anyhow::Result<PathBuf> {
    let (_, _, target) = checked_storage_path(&request)?;
    Ok(target)
}

fn refresh_storage(_: EmptyRequest) -> anyhow::Result<RefreshReceipt> {
    let queued_at = Utc::now();
    let started_at = Utc::now();
    let mut workspaces = Store::open_default()?.list_workspaces()?;
    workspaces.sort_by(|left, right| left.path.cmp(&right.path));
    let roots = workspaces
        .iter()
        .map(|workspace| workspace.path.clone())
        .collect::<Vec<_>>();
    let mut hard_links = HardLinkSet::default();
    for workspace in workspaces {
        if workspace.path.parent().is_none()
            || dirs::home_dir()
                .is_some_and(|home| platform_path::equivalent(&workspace.path, &home))
        {
            Store::open_default()?.record_workspace_storage_failure(
                &workspace.id,
                Utc::now(),
                "storage.scanTooBroad",
                None,
            )?;
            continue;
        }
        let excluded = roots
            .iter()
            .filter(|path| {
                !platform_path::equivalent(path, &workspace.path)
                    && platform_path::starts_with(path, &workspace.path)
            })
            .cloned()
            .collect::<Vec<_>>();
        let source = StorageWorkspace {
            id: workspace.id.clone(),
            name: workspace.name,
            path: workspace.path,
        };
        let scan = scan_workspace_storage(&source, &excluded, &mut hard_links, || false);
        if scan.storage.last_success_at.is_some() {
            Store::open_default()?.save_workspace_storage(&scan.storage)?;
        } else {
            Store::open_default()?.record_workspace_storage_failure(
                &workspace.id,
                scan.storage.last_attempt_at,
                scan.storage
                    .error_key
                    .as_deref()
                    .unwrap_or("storage.scanUnavailable"),
                scan.storage.error_detail.as_deref(),
            )?;
        }
    }
    Ok(completed_refresh_receipt("storage", queued_at, started_at))
}

fn cancel_storage(_: EmptyRequest) -> anyhow::Result<bool> {
    Ok(false)
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
