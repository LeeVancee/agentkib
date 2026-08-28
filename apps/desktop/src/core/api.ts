import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  Achievement,
  ActivityRecord,
  AgentInstallation,
  AgentKind,
  AgentUsageBreakdown,
  AppIconPreference,
  AppUpdateInfo,
  AppUpdateProgress,
  CatalogAsset,
  ChangeSet,
  CloseBehavior,
  ContextDoctorReport,
  ContextDoctorSummary,
  ContextPreview,
  ConversationEventPage,
  ConversationIndexStatus,
  ConversationSessionSummary,
  ExcludedWorkspace,
  GitCommitPage,
  GitDiff,
  GitDiffRequest,
  GitFileChange,
  GitHistoryQuery,
  GitIdentitySummary,
  GitWorkspaceSummary,
  HandoffContinuationResult,
  HandoffFormat,
  HandoffLaunchReceipt,
  HeatmapPoint,
  InsightsQuery,
  InsightsStatus,
  InsightsSummary,
  InsightsView,
  LocalePreference,
  Manifest,
  McpHubStatus,
  McpInstallation,
  McpInstallResult,
  McpMigrationCandidate,
  McpNetworkSettings,
  McpOAuthStart,
  McpRegistryEntry,
  McpRuntimeStatus,
  McpServerConfig,
  McpToolDescriptor,
  MemoryRecord,
  MemoryStatus,
  MemoryType,
  ModelUsageBreakdown,
  ObsidianIntegration,
  ObsidianWorkspaceLink,
  OnboardingEvent,
  PlannedSessionHandoff,
  QuotaCollectorStatus,
  QuotaPopoverPreferences,
  QuotaSnapshot,
  QuotaWindowSelector,
  RefreshJobStatus,
  RefreshKind,
  RefreshReceipt,
  RemoteGatewayInput,
  RemoteGatewaySummary,
  RepositoryCommitBreakdown,
  RuntimeInfo,
  ScanRoot,
  SessionHandoffDraft,
  SessionHandoffLaunchRequest,
  SessionHandoffPreparation,
  SessionHandoffRequest,
  StorageNode,
  StorageOverview,
  ThemePreference,
  WorkspaceOpener,
  WorkspaceScan,
  WorkspaceSummary,
  WorkspaceUsageBreakdown,
} from "./types";

const DOCTOR_SUMMARY_BATCH_LIMIT = 100;

export const api = {
  scan: (project: string) => invoke<WorkspaceScan>("scan_workspace", { project }),
  manifest: async (project: string) => {
    const manifest = await invoke<Manifest>("prepare_manifest", { project });
    // Empty legacy connections are omitted from manifest serialization.
    // Keep the React model total at the IPC boundary without writing the field back to disk.
    return { ...manifest, connections: manifest.connections ?? [] };
  },
  plan: (project: string, manifest: Manifest, includeHome: boolean) =>
    invoke<ChangeSet>("plan_changes", { project, manifest, includeHome }),
  apply: (changeSet: ChangeSet, approveHome: boolean) =>
    invoke("apply_changes", { changeSet, approveHome }),
  context: (project: string, cwd: string, agent: AgentKind) =>
    invoke<ContextPreview>("resolve_context", { project, cwd, agent }),
  memories: (project: string, status?: MemoryStatus) =>
    invoke<MemoryRecord[]>("list_memories", { project, status }),
  searchMemories: (project: string, query: string, limit = 50) =>
    invoke<MemoryRecord[]>("search_memories", { project, query, limit }),
  proposeMemory: (project: string, content: string, memoryType: MemoryType) =>
    invoke<MemoryRecord>("propose_memory", {
      project,
      proposal: {
        project_id: "",
        memory_type: memoryType,
        content,
        source_agent: "agentkib-desktop",
      },
    }),
  reviewMemory: (id: string, status: MemoryStatus, editedContent?: string) =>
    invoke<MemoryRecord>("review_memory", { id, status, editedContent }),
  runtime: () => electronDesktopApi()?.home.runtime() ?? invoke<RuntimeInfo>("runtime_info"),
  updateOnboarding: (event: OnboardingEvent) => invoke<RuntimeInfo>("update_onboarding", { event }),
  openFilesAndFoldersSettings: () => invoke<void>("open_files_and_folders_settings"),
  quitApp: () => invoke<void>("quit_app"),
  setCloseBehavior: (behavior?: CloseBehavior) =>
    invoke<void>("set_close_behavior", { behavior: behavior ?? null }),
  setLocale: (preference: LocalePreference) => invoke<RuntimeInfo>("set_locale", { preference }),
  setThemePreference: (preference: ThemePreference) =>
    invoke<RuntimeInfo>("set_theme_preference", { preference }),
  setAppIconPreference: (preference: AppIconPreference) =>
    invoke<RuntimeInfo>("set_app_icon_preference", { preference }),
  checkAppUpdate: () => invoke<AppUpdateInfo | undefined>("check_app_update"),
  installAppUpdate: (version: string, onEvent: (event: AppUpdateProgress) => void) => {
    const channel = new Channel<AppUpdateProgress>();
    channel.onmessage = onEvent;
    return invoke<void>("install_app_update", { version, onEvent: channel });
  },
  mcpHubStatus: () => invoke<McpHubStatus>("get_mcp_hub_status"),
  updateMcpNetwork: (settings: McpNetworkSettings) =>
    invoke<McpHubStatus>("update_mcp_network_settings", { settings }),
  mcpServers: (project?: string) => invoke<McpServerConfig[]>("list_mcp_servers", { project }),
  mcpServer: (serverId: string, project?: string) =>
    invoke<McpServerConfig | undefined>("get_mcp_server", { serverId, project }),
  saveMcpServer: (server: McpServerConfig, project?: string) =>
    invoke<McpServerConfig>("save_mcp_server", { server, project }),
  saveMcpLocalValues: (
    serverId: string,
    env: Record<string, string>,
    headers: Record<string, string>,
    project?: string,
  ) => invoke<void>("save_mcp_local_values", { serverId, env, headers, project }),
  removeMcpServer: (serverId: string, project?: string) =>
    invoke<void>("remove_mcp_server", { serverId, project }),
  probeMcpRuntime: (serverId: string, project?: string) =>
    invoke<McpToolDescriptor[]>("probe_mcp_runtime", { serverId, project }),
  startMcpOAuth: (serverId: string, project?: string) =>
    invoke<McpOAuthStart>("start_mcp_oauth", { serverId, project }),
  mcpRuntimes: () => invoke<McpRuntimeStatus[]>("list_mcp_runtimes"),
  restartMcpRuntime: (serverId: string, project?: string) =>
    invoke<McpToolDescriptor[]>("restart_mcp_runtime", { serverId, project }),
  stopMcpRuntime: (serverId?: string) => invoke<void>("stop_mcp_runtime", { serverId }),
  searchMcpRegistry: (query: string) =>
    invoke<McpRegistryEntry[]>("search_mcp_registry", { query }),
  refreshMcpRegistry: (query: string) =>
    invoke<McpRegistryEntry[]>("refresh_mcp_registry", { query }),
  installMcp: (entry: McpRegistryEntry, project?: string) =>
    invoke<McpInstallResult>("install_mcp", { entry, project, confirmed: true }),
  updateMcp: (installationId: string, entry: McpRegistryEntry, project?: string) =>
    invoke<McpInstallResult>("update_mcp", { installationId, entry, project, confirmed: true }),
  mcpInstallations: () => invoke<McpInstallation[]>("list_mcp_installations"),
  uninstallMcp: (installationId: string) =>
    invoke<void>("uninstall_mcp", { installationId, confirmed: true }),
  nativeMcpCandidates: (project?: string) =>
    invoke<McpMigrationCandidate[]>("scan_native_mcp_candidates", { project }),
  planMcpMigration: (project: string, candidateIds: string[]) =>
    invoke<ChangeSet>("plan_mcp_migration", { project, candidateIds }),
  requestRefresh: (kind: RefreshKind, force = false) =>
    invoke<RefreshReceipt>("request_refresh", { kind, force }),
  refreshStatus: () =>
    electronDesktopApi()?.home.refreshStatus() ?? invoke<RefreshJobStatus[]>("get_refresh_status"),
  storageOverview: () => invoke<StorageOverview>("get_storage_overview"),
  workspaceStorageChildren: (workspaceId: string, relativePath: string) =>
    invoke<StorageNode>("get_workspace_storage_children", { workspaceId, relativePath }),
  openWorkspaceStoragePath: (workspaceId: string, relativePath: string) =>
    invoke<void>("open_workspace_storage_path", { workspaceId, relativePath }),
  cancelStorageScan: () => invoke<boolean>("cancel_storage_scan"),
  discoverWorkspaces: () => invoke<RefreshReceipt>("discover_workspaces"),
  workspaces: () =>
    electronDesktopApi()?.home.workspaces() ?? invoke<WorkspaceSummary[]>("list_workspaces"),
  workspace: (id: string) => invoke<WorkspaceSummary | undefined>("get_workspace", { id }),
  workspaceGitSummary: (workspaceId: string) =>
    invoke<GitWorkspaceSummary | undefined>("get_workspace_git_summary", { workspaceId }),
  workspaceGitHistory: (workspaceId: string, query: GitHistoryQuery = {}) =>
    invoke<GitCommitPage | undefined>("list_workspace_git_history", { workspaceId, query }),
  gitCommitFiles: (workspaceId: string, oid: string) =>
    invoke<GitFileChange[] | undefined>("list_git_commit_files", { workspaceId, oid }),
  gitDiff: (workspaceId: string, request: GitDiffRequest) =>
    invoke<GitDiff | undefined>("get_git_diff", { workspaceId, request }),
  workspaceOpeners: (workspaceId: string) =>
    invoke<WorkspaceOpener[]>("list_workspace_openers", { workspaceId }),
  openWorkspaceWithApp: (workspaceId: string, openerId?: string) =>
    invoke<void>("open_workspace_with_app", { workspaceId, openerId }),
  workspaceSessions: (workspaceId: string) =>
    invoke<ConversationSessionSummary[]>("list_workspace_sessions", { workspaceId }),
  refreshWorkspaceSessions: (workspaceId: string, force = false) =>
    invoke<ConversationSessionSummary[]>("refresh_workspace_sessions", { workspaceId, force }),
  sessionEvents: (sessionId: string, cursor?: string, limit = 100) =>
    invoke<ConversationEventPage>("read_session_events", { sessionId, cursor, limit }),
  prepareSessionHandoff: (request: SessionHandoffRequest) =>
    invoke<SessionHandoffPreparation>("prepare_session_handoff", { request }),
  summarizeSessionHandoff: (request: SessionHandoffRequest) =>
    invoke<SessionHandoffDraft>("summarize_session_handoff", { request }),
  sanitizeSessionHandoff: (format: HandoffFormat, editedContent: string) =>
    invoke<string>("sanitize_session_handoff", { format, editedContent }),
  planSessionHandoff: (
    workspaceId: string,
    filename: string,
    format: HandoffFormat,
    editedContent: string,
    targetAgent: AgentKind,
  ) =>
    invoke<PlannedSessionHandoff>("plan_session_handoff", {
      workspaceId,
      filename,
      format,
      editedContent,
      targetAgent,
    }),
  continueSessionHandoff: (changeSet: ChangeSet, launchRequest: SessionHandoffLaunchRequest) =>
    invoke<HandoffContinuationResult>("continue_session_handoff", { changeSet, launchRequest }),
  launchSessionHandoff: (launchRequest: SessionHandoffLaunchRequest) =>
    invoke<HandoffLaunchReceipt>("launch_session_handoff", { launchRequest }),
  workspaceSessionStatus: (workspaceId: string) =>
    invoke<ConversationIndexStatus[]>("get_workspace_session_status", { workspaceId }),
  clearSessionIndex: (workspaceId?: string) => invoke<void>("clear_session_index", { workspaceId }),
  setSessionIndexEnabled: (enabled: boolean) =>
    invoke<RuntimeInfo>("set_session_index_enabled", { enabled }),
  setQuotaAutoRefreshEnabled: (enabled: boolean) =>
    invoke<RuntimeInfo>("set_quota_auto_refresh_enabled", { enabled }),
  setQuotaAutoRefreshPromptSeen: (seen: boolean) =>
    invoke<RuntimeInfo>("set_quota_auto_refresh_prompt_seen", { seen }),
  addWorkspace: (path: string) => invoke<WorkspaceSummary>("add_workspace", { path }),
  refreshWorkspace: (id: string) => invoke<WorkspaceSummary>("refresh_workspace", { id }),
  excludeWorkspace: (id: string) => invoke<void>("exclude_workspace", { id }),
  excludedWorkspaces: () => invoke<ExcludedWorkspace[]>("list_excluded_workspaces"),
  restoreExcludedWorkspace: (path: string) => invoke<void>("restore_excluded_workspace", { path }),
  obsidianIntegration: () => invoke<ObsidianIntegration>("get_obsidian_integration"),
  addObsidianVault: (path: string) => invoke<ObsidianIntegration>("add_obsidian_vault", { path }),
  linkWorkspaceToObsidian: (workspaceId: string, vaultPath: string, relativeTarget?: string) =>
    invoke<ObsidianWorkspaceLink>("link_workspace_to_obsidian", {
      workspaceId,
      vaultPath,
      relativeTarget: relativeTarget?.trim() || null,
    }),
  unlinkWorkspaceFromObsidian: (workspaceId: string) =>
    invoke<void>("unlink_workspace_from_obsidian", { workspaceId }),
  openObsidian: () => invoke<void>("open_obsidian"),
  openWorkspaceInObsidian: (workspaceId: string) =>
    invoke<void>("open_workspace_in_obsidian", { workspaceId }),
  remoteGateways: () => invoke<RemoteGatewaySummary[]>("list_remote_gateways"),
  saveRemoteGateway: (input: RemoteGatewayInput) =>
    invoke<RemoteGatewaySummary>("save_remote_gateway", { input }),
  refreshRemoteGateway: (id: string) =>
    invoke<RemoteGatewaySummary>("refresh_remote_gateway", { id }),
  removeRemoteGateway: (id: string) => invoke<void>("remove_remote_gateway", { id }),
  scanRoots: () => invoke<ScanRoot[]>("list_scan_roots"),
  addScanRoot: (path: string, maxDepth = 5) =>
    invoke<ScanRoot>("add_scan_root", { path, maxDepth }),
  removeScanRoot: (id: string) => invoke<void>("remove_scan_root", { id }),
  agentInstallations: () => invoke<AgentInstallation[]>("list_agent_installations"),
  workspaceDoctorReport: (workspaceId: string) =>
    invoke<ContextDoctorReport>("get_workspace_doctor_report", { workspaceId }),
  workspaceDoctorSummaries: async (workspaceIds: string[]) => {
    const summaries: ContextDoctorSummary[] = [];
    for (let offset = 0; offset < workspaceIds.length; offset += DOCTOR_SUMMARY_BATCH_LIMIT) {
      const batch = workspaceIds.slice(offset, offset + DOCTOR_SUMMARY_BATCH_LIMIT);
      summaries.push(
        ...(await (electronDesktopApi()?.workspace.doctorSummaries(batch) ??
          invoke<ContextDoctorSummary[]>("get_workspace_doctor_summaries", {
            workspaceIds: batch,
          }))),
      );
    }
    return summaries;
  },
  catalogAssets: (query = "", agent?: AgentKind, workspaceId?: string, limit = 500) =>
    electronDesktopApi()?.home.catalogAssets({ query, agent, workspaceId, limit }) ??
    invoke<CatalogAsset[]>("search_catalog_assets", { query, agent, workspaceId, limit }),
  globalMemories: (status?: MemoryStatus) =>
    electronDesktopApi()?.home.globalMemories(status) ??
    invoke<MemoryRecord[]>("list_global_memories", { status }),
  activity: (limit = 200) =>
    electronDesktopApi()?.home.activity(limit) ??
    invoke<ActivityRecord[]>("list_activity", { limit }),
  refreshInsights: () => invoke<RefreshReceipt>("refresh_insights"),
  insightsView: (query: InsightsQuery = {}) => invoke<InsightsView>("get_insights_view", { query }),
  insightsSummary: (query: InsightsQuery = {}) =>
    electronDesktopApi()?.home.insightsSummary(query) ??
    invoke<InsightsSummary>("get_insights_summary", { query }),
  insightsHeatmap: (query: InsightsQuery = {}) =>
    invoke<HeatmapPoint[]>("get_insights_heatmap", { query }),
  agentUsageBreakdown: (query: InsightsQuery = {}) =>
    invoke<AgentUsageBreakdown[]>("get_agent_usage_breakdown", { query }),
  modelUsageBreakdown: (query: InsightsQuery = {}) =>
    invoke<ModelUsageBreakdown[]>("get_model_usage_breakdown", { query }),
  workspaceUsageBreakdown: (query: InsightsQuery = {}) =>
    invoke<WorkspaceUsageBreakdown[]>("get_workspace_usage_breakdown", { query }),
  repositoryCommitBreakdown: (query: InsightsQuery = {}) =>
    invoke<RepositoryCommitBreakdown[]>("get_repository_commit_breakdown", { query }),
  achievements: () => invoke<Achievement[]>("list_achievements"),
  insightsStatus: () =>
    electronDesktopApi()?.home.insightsStatus() ?? invoke<InsightsStatus>("get_insights_status"),
  gitIdentities: () => invoke<GitIdentitySummary[]>("list_git_identities"),
  addGitIdentityAlias: (email: string) =>
    invoke<GitIdentitySummary>("add_git_identity_alias", { email }),
  setGitIdentityEnabled: (id: string, enabled: boolean) =>
    invoke<void>("set_git_identity_enabled", { id, enabled }),
  quotaSnapshot: () => invoke<QuotaSnapshot | undefined>("get_quota_snapshot"),
  refreshQuota: () => invoke<RefreshReceipt>("refresh_quota"),
  quotaCollectorStatus: () =>
    electronDesktopApi()?.home.quotaCollectorStatus() ??
    invoke<QuotaCollectorStatus>("get_quota_collector_status"),
  quotaPopoverPreferences: () => invoke<QuotaPopoverPreferences>("get_quota_popover_preferences"),
  setQuotaPopoverPreferences: (preferences: QuotaPopoverPreferences) =>
    invoke<QuotaPopoverPreferences>("set_quota_popover_preferences", { preferences }),
  openQuotaDashboard: (provider?: string, window?: QuotaWindowSelector, configurePopover = false) =>
    invoke<void>("open_quota_dashboard", { provider, window, configurePopover }),
};
