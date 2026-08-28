use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 1;
pub const HANDSHAKE_METHOD: &str = "agentkib.handshake";
pub const SHUTDOWN_METHOD: &str = "agentkib.shutdown";
pub const SCAN_WORKSPACE_METHOD: &str = "workspace.scan";
pub const PREPARE_MANIFEST_METHOD: &str = "workspace.prepareManifest";
pub const RESOLVE_CONTEXT_METHOD: &str = "workspace.resolveContext";
pub const ADD_WORKSPACE_METHOD: &str = "workspace.add";
pub const REFRESH_WORKSPACE_METHOD: &str = "workspace.refresh";
pub const EXCLUDE_WORKSPACE_METHOD: &str = "workspace.exclude";
pub const RESTORE_EXCLUDED_WORKSPACE_METHOD: &str = "workspace.restoreExcluded";
pub const WORKSPACE_DOCTOR_REPORT_METHOD: &str = "workspace.doctorReport";
pub const WORKSPACE_GIT_SUMMARY_METHOD: &str = "workspace.gitSummary";
pub const WORKSPACE_GIT_HISTORY_METHOD: &str = "workspace.gitHistory";
pub const GIT_COMMIT_FILES_METHOD: &str = "workspace.gitCommitFiles";
pub const GIT_DIFF_METHOD: &str = "workspace.gitDiff";
pub const WORKSPACE_SESSIONS_METHOD: &str = "workspace.sessions";
pub const WORKSPACE_SESSION_STATUS_METHOD: &str = "workspace.sessionStatus";
pub const REFRESH_WORKSPACE_SESSIONS_METHOD: &str = "workspace.refreshSessions";
pub const SESSION_EVENTS_METHOD: &str = "session.events";
pub const RUNTIME_INFO_METHOD: &str = "runtime.info";
pub const LIST_WORKSPACES_METHOD: &str = "workspaces.list";
pub const LIST_AGENT_INSTALLATIONS_METHOD: &str = "agents.listInstallations";
pub const SEARCH_CATALOG_ASSETS_METHOD: &str = "catalog.searchAssets";
pub const LIST_GLOBAL_MEMORIES_METHOD: &str = "memories.listGlobal";
pub const LIST_ACTIVITY_METHOD: &str = "activity.list";
pub const LIST_SCAN_ROOTS_METHOD: &str = "discovery.listScanRoots";
pub const ADD_SCAN_ROOT_METHOD: &str = "discovery.addScanRoot";
pub const REMOVE_SCAN_ROOT_METHOD: &str = "discovery.removeScanRoot";
pub const REFRESH_DISCOVERY_METHOD: &str = "discovery.refresh";
pub const LIST_EXCLUDED_WORKSPACES_METHOD: &str = "discovery.listExcludedWorkspaces";
pub const LIST_REMOTE_GATEWAYS_METHOD: &str = "gateways.list";
pub const WORKSPACE_DOCTOR_SUMMARIES_METHOD: &str = "workspace.doctorSummaries";
pub const INSIGHTS_VIEW_METHOD: &str = "insights.view";
pub const REFRESH_INSIGHTS_METHOD: &str = "insights.refresh";
pub const INSIGHTS_SUMMARY_METHOD: &str = "insights.summary";
pub const INSIGHTS_STATUS_METHOD: &str = "insights.status";
pub const QUOTA_COLLECTOR_STATUS_METHOD: &str = "quota.collectorStatus";
pub const QUOTA_SNAPSHOT_METHOD: &str = "quota.snapshot";
pub const QUOTA_PREFERENCES_METHOD: &str = "quota.preferences";
pub const SET_QUOTA_PREFERENCES_METHOD: &str = "quota.setPreferences";
pub const REFRESH_QUOTA_METHOD: &str = "quota.refresh";
pub const SET_QUOTA_AUTO_REFRESH_METHOD: &str = "quota.setAutoRefresh";
pub const SET_QUOTA_PROMPT_SEEN_METHOD: &str = "quota.setPromptSeen";
pub const REFRESH_STATUS_METHOD: &str = "refresh.status";
pub const STORAGE_OVERVIEW_METHOD: &str = "storage.overview";
pub const STORAGE_CHILDREN_METHOD: &str = "storage.children";
pub const REFRESH_STORAGE_METHOD: &str = "storage.refresh";
pub const RESOLVE_STORAGE_PATH_METHOD: &str = "storage.resolvePath";
pub const CANCEL_STORAGE_METHOD: &str = "storage.cancel";
pub const UPDATE_ONBOARDING_METHOD: &str = "onboarding.update";

#[derive(Debug, Deserialize)]
pub struct RpcRequest {
    pub jsonrpc: String,
    pub id: Value,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Serialize)]
pub struct RpcResponse {
    pub jsonrpc: &'static str,
    pub id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

impl RpcResponse {
    pub fn success(id: Value, result: Value) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn error(id: Value, code: i32, message: impl Into<String>, data: Option<Value>) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(RpcError {
                code,
                message: message.into(),
                data,
            }),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandshakeRequest {
    pub protocol_version: u32,
    pub client: RuntimePeer,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandshakeResult {
    pub protocol_version: u32,
    pub runtime: RuntimePeer,
    pub pid: u32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RuntimePeer {
    pub name: String,
    pub version: String,
}

pub fn typescript_bindings() -> String {
    format!(
        r#"// This file is generated by `pnpm protocol:generate`. Do not edit it by hand.

export const PROTOCOL_VERSION = {PROTOCOL_VERSION} as const;
export const RUNTIME_METHODS = {{
  handshake: "{HANDSHAKE_METHOD}",
  shutdown: "{SHUTDOWN_METHOD}",
  scanWorkspace: "{SCAN_WORKSPACE_METHOD}",
  prepareManifest: "{PREPARE_MANIFEST_METHOD}",
  resolveContext: "{RESOLVE_CONTEXT_METHOD}",
  addWorkspace: "{ADD_WORKSPACE_METHOD}",
  refreshWorkspace: "{REFRESH_WORKSPACE_METHOD}",
  excludeWorkspace: "{EXCLUDE_WORKSPACE_METHOD}",
  restoreExcludedWorkspace: "{RESTORE_EXCLUDED_WORKSPACE_METHOD}",
  workspaceDoctorReport: "{WORKSPACE_DOCTOR_REPORT_METHOD}",
  workspaceGitSummary: "{WORKSPACE_GIT_SUMMARY_METHOD}",
  workspaceGitHistory: "{WORKSPACE_GIT_HISTORY_METHOD}",
  gitCommitFiles: "{GIT_COMMIT_FILES_METHOD}",
  gitDiff: "{GIT_DIFF_METHOD}",
  workspaceSessions: "{WORKSPACE_SESSIONS_METHOD}",
  workspaceSessionStatus: "{WORKSPACE_SESSION_STATUS_METHOD}",
  refreshWorkspaceSessions: "{REFRESH_WORKSPACE_SESSIONS_METHOD}",
  sessionEvents: "{SESSION_EVENTS_METHOD}",
  runtimeInfo: "{RUNTIME_INFO_METHOD}",
  listWorkspaces: "{LIST_WORKSPACES_METHOD}",
  listAgentInstallations: "{LIST_AGENT_INSTALLATIONS_METHOD}",
  searchCatalogAssets: "{SEARCH_CATALOG_ASSETS_METHOD}",
  listGlobalMemories: "{LIST_GLOBAL_MEMORIES_METHOD}",
  listActivity: "{LIST_ACTIVITY_METHOD}",
  listScanRoots: "{LIST_SCAN_ROOTS_METHOD}",
  addScanRoot: "{ADD_SCAN_ROOT_METHOD}",
  removeScanRoot: "{REMOVE_SCAN_ROOT_METHOD}",
  refreshDiscovery: "{REFRESH_DISCOVERY_METHOD}",
  listExcludedWorkspaces: "{LIST_EXCLUDED_WORKSPACES_METHOD}",
  listRemoteGateways: "{LIST_REMOTE_GATEWAYS_METHOD}",
  workspaceDoctorSummaries: "{WORKSPACE_DOCTOR_SUMMARIES_METHOD}",
  insightsView: "{INSIGHTS_VIEW_METHOD}",
  refreshInsights: "{REFRESH_INSIGHTS_METHOD}",
  insightsSummary: "{INSIGHTS_SUMMARY_METHOD}",
  insightsStatus: "{INSIGHTS_STATUS_METHOD}",
  quotaCollectorStatus: "{QUOTA_COLLECTOR_STATUS_METHOD}",
  quotaSnapshot: "{QUOTA_SNAPSHOT_METHOD}",
  quotaPreferences: "{QUOTA_PREFERENCES_METHOD}",
  setQuotaPreferences: "{SET_QUOTA_PREFERENCES_METHOD}",
  refreshQuota: "{REFRESH_QUOTA_METHOD}",
  setQuotaAutoRefresh: "{SET_QUOTA_AUTO_REFRESH_METHOD}",
  setQuotaPromptSeen: "{SET_QUOTA_PROMPT_SEEN_METHOD}",
  refreshStatus: "{REFRESH_STATUS_METHOD}",
  storageOverview: "{STORAGE_OVERVIEW_METHOD}",
  storageChildren: "{STORAGE_CHILDREN_METHOD}",
  refreshStorage: "{REFRESH_STORAGE_METHOD}",
  resolveStoragePath: "{RESOLVE_STORAGE_PATH_METHOD}",
  cancelStorage: "{CANCEL_STORAGE_METHOD}",
  updateOnboarding: "{UPDATE_ONBOARDING_METHOD}",
}} as const;

export interface RuntimePeer {{
  name: string;
  version: string;
}}

export interface RuntimeHandshakeRequest {{
  protocolVersion: typeof PROTOCOL_VERSION;
  client: RuntimePeer;
}}

export interface RuntimeHandshakeResult {{
  protocolVersion: typeof PROTOCOL_VERSION;
  runtime: RuntimePeer;
  pid: number;
}}

export interface RuntimeRpcError {{
  code: number;
  message: string;
  data?: unknown;
}}
"#
    )
}
