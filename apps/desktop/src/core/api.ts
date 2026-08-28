import { Channel, invoke } from "@tauri-apps/api/core";
import { open as tauriOpen } from "@tauri-apps/plugin-dialog";
import { openUrl as tauriOpenUrl } from "@tauri-apps/plugin-opener";
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

function electronDesktopApi() {
  return typeof window === "undefined" ? undefined : window.agentkibDesktop;
}

export const api = {
  scan: (project: string) =>
    electronDesktopApi()?.workspace.scan(project) ??
    invoke<WorkspaceScan>("scan_workspace", { project }),
  manifest: async (project: string) => {
    const manifest = await (electronDesktopApi()?.workspace.prepareManifest(project) ??
      invoke<Manifest>("prepare_manifest", { project }));
    // Empty legacy connections are omitted from manifest serialization.
    // Keep the React model total at the IPC boundary without writing the field back to disk.
    return { ...manifest, connections: manifest.connections ?? [] };
  },
  plan: (project: string, manifest: Manifest, includeHome: boolean) =>
    electronDesktopApi()?.changes.plan(project, manifest, includeHome) ??
    invoke<ChangeSet>("plan_changes", { project, manifest, includeHome }),
  apply: (changeSet: ChangeSet, approveHome: boolean) =>
    electronDesktopApi()?.changes.apply(changeSet, approveHome) ??
    invoke("apply_changes", { changeSet, approveHome }),
  context: (project: string, cwd: string, agent: AgentKind) =>
    electronDesktopApi()?.workspace.resolveContext(project, cwd, agent) ??
    invoke<ContextPreview>("resolve_context", { project, cwd, agent }),
  pickDirectory: async (title?: string) => {
    const selected = await (electronDesktopApi()?.shell.openDirectory(title) ??
      tauriOpen({ directory: true, multiple: false, title }));
    return typeof selected === "string" ? selected : undefined;
  },
  memories: (project: string, status?: MemoryStatus) =>
    electronDesktopApi()?.memories.list(project, status) ??
    invoke<MemoryRecord[]>("list_memories", { project, status }),
  searchMemories: (project: string, query: string, limit = 50) =>
    electronDesktopApi()?.memories.search(project, query, limit) ??
    invoke<MemoryRecord[]>("search_memories", { project, query, limit }),
  proposeMemory: (project: string, content: string, memoryType: MemoryType) =>
    electronDesktopApi()?.memories.propose(project, {
      project_id: "",
      memory_type: memoryType,
      content,
      source_agent: "agentkib-desktop",
    }) ??
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
    electronDesktopApi()?.memories.review(id, status, editedContent) ??
    invoke<MemoryRecord>("review_memory", { id, status, editedContent }),
  runtime: () => electronDesktopApi()?.home.runtime() ?? invoke<RuntimeInfo>("runtime_info"),
  updateOnboarding: (event: OnboardingEvent) =>
    electronDesktopApi()?.home.updateOnboarding(event) ??
    invoke<RuntimeInfo>("update_onboarding", { event }),
  openFilesAndFoldersSettings: () =>
    electronDesktopApi()?.shell.openFilesAndFoldersSettings() ??
    invoke<void>("open_files_and_folders_settings"),
  openExternal: (url: string) => electronDesktopApi()?.shell.openExternal(url) ?? tauriOpenUrl(url),
  quitApp: () => electronDesktopApi()?.shell.quit() ?? invoke<void>("quit_app"),
  setCloseBehavior: (behavior?: CloseBehavior) =>
    electronDesktopApi()?.settings.setCloseBehavior(behavior) ??
    invoke<void>("set_close_behavior", { behavior: behavior ?? null }),
  setLocale: (preference: LocalePreference) =>
    electronDesktopApi()?.settings.setLocale(preference) ??
    invoke<RuntimeInfo>("set_locale", { preference }),
  setThemePreference: (preference: ThemePreference) =>
    electronDesktopApi()?.settings.setThemePreference(preference) ??
    invoke<RuntimeInfo>("set_theme_preference", { preference }),
  setAppIconPreference: (preference: AppIconPreference) =>
    electronDesktopApi()?.settings.setAppIconPreference(preference) ??
    invoke<RuntimeInfo>("set_app_icon_preference", { preference }),
  checkAppUpdate: () =>
    electronDesktopApi()?.updates.check() ?? invoke<AppUpdateInfo | undefined>("check_app_update"),
  installAppUpdate: (version: string, onEvent: (event: AppUpdateProgress) => void) => {
    const desktop = electronDesktopApi();
    if (desktop) return desktop.updates.install(version, onEvent);
    const channel = new Channel<AppUpdateProgress>();
    channel.onmessage = onEvent;
    return invoke<void>("install_app_update", { version, onEvent: channel });
  },
  mcpHubStatus: () =>
    electronDesktopApi()?.mcp.hubStatus() ?? invoke<McpHubStatus>("get_mcp_hub_status"),
  updateMcpNetwork: (settings: McpNetworkSettings) =>
    electronDesktopApi()?.mcp.updateNetwork(settings) ??
    invoke<McpHubStatus>("update_mcp_network_settings", { settings }),
  mcpServers: (project?: string) =>
    electronDesktopApi()?.mcp.listServers(project) ??
    invoke<McpServerConfig[]>("list_mcp_servers", { project }),
  mcpServer: (serverId: string, project?: string) =>
    electronDesktopApi()?.mcp.getServer(serverId, project) ??
    invoke<McpServerConfig | undefined>("get_mcp_server", { serverId, project }),
  saveMcpServer: (server: McpServerConfig, project?: string) =>
    electronDesktopApi()?.mcp.saveServer(server, project) ??
    invoke<McpServerConfig>("save_mcp_server", { server, project }),
  saveMcpLocalValues: (
    serverId: string,
    env: Record<string, string>,
    headers: Record<string, string>,
    project?: string,
  ) =>
    electronDesktopApi()?.mcp.saveLocalValues(serverId, env, headers, project) ??
    invoke<void>("save_mcp_local_values", { serverId, env, headers, project }),
  removeMcpServer: (serverId: string, project?: string) =>
    electronDesktopApi()?.mcp.removeServer(serverId, project) ??
    invoke<void>("remove_mcp_server", { serverId, project }),
  probeMcpRuntime: (serverId: string, project?: string) =>
    electronDesktopApi()?.mcp.probeRuntime(serverId, project) ??
    invoke<McpToolDescriptor[]>("probe_mcp_runtime", { serverId, project }),
  startMcpOAuth: (serverId: string, project?: string) =>
    electronDesktopApi()?.mcp.startOAuth(serverId, project) ??
    invoke<McpOAuthStart>("start_mcp_oauth", { serverId, project }),
  mcpRuntimes: () =>
    electronDesktopApi()?.mcp.runtimes() ?? invoke<McpRuntimeStatus[]>("list_mcp_runtimes"),
  restartMcpRuntime: (serverId: string, project?: string) =>
    electronDesktopApi()?.mcp.restartRuntime(serverId, project) ??
    invoke<McpToolDescriptor[]>("restart_mcp_runtime", { serverId, project }),
  stopMcpRuntime: (serverId?: string) =>
    electronDesktopApi()?.mcp.stopRuntime(serverId) ??
    invoke<void>("stop_mcp_runtime", { serverId }),
  searchMcpRegistry: (query: string) =>
    electronDesktopApi()?.mcp.searchRegistry(query) ??
    invoke<McpRegistryEntry[]>("search_mcp_registry", { query }),
  refreshMcpRegistry: (query: string) =>
    electronDesktopApi()?.mcp.refreshRegistry(query) ??
    invoke<McpRegistryEntry[]>("refresh_mcp_registry", { query }),
  installMcp: (entry: McpRegistryEntry, project?: string) =>
    electronDesktopApi()?.mcp.install(entry, project) ??
    invoke<McpInstallResult>("install_mcp", { entry, project, confirmed: true }),
  updateMcp: (installationId: string, entry: McpRegistryEntry, project?: string) =>
    electronDesktopApi()?.mcp.update(installationId, entry, project) ??
    invoke<McpInstallResult>("update_mcp", { installationId, entry, project, confirmed: true }),
  mcpInstallations: () =>
    electronDesktopApi()?.mcp.installations() ??
    invoke<McpInstallation[]>("list_mcp_installations"),
  uninstallMcp: (installationId: string) =>
    electronDesktopApi()?.mcp.uninstall(installationId) ??
    invoke<void>("uninstall_mcp", { installationId, confirmed: true }),
  nativeMcpCandidates: (project?: string) =>
    electronDesktopApi()?.mcp.scanNative(project) ??
    invoke<McpMigrationCandidate[]>("scan_native_mcp_candidates", { project }),
  planMcpMigration: (project: string, candidateIds: string[]) =>
    electronDesktopApi()?.mcp.planMigration(project, candidateIds) ??
    invoke<ChangeSet>("plan_mcp_migration", { project, candidateIds }),
  requestRefresh: async (kind: RefreshKind, force = false) => {
    const electron = electronDesktopApi();
    let receipt: RefreshReceipt;
    if (electron && kind === "discovery") receipt = await electron.home.refreshDiscovery();
    else if (electron && kind === "insights") receipt = await electron.home.refreshInsights();
    else if (electron && kind === "quota") receipt = await electron.home.refreshQuota();
    else if (electron && kind === "storage") receipt = await electron.home.refreshStorage();
    else receipt = await invoke<RefreshReceipt>("request_refresh", { kind, force });
    if (electron) {
      globalThis.window.dispatchEvent(
        new CustomEvent<RefreshJobStatus>("agentkib:electron-refresh-state", {
          detail: receipt.status,
        }),
      );
    }
    return receipt;
  },
  refreshStatus: () =>
    electronDesktopApi()?.home.refreshStatus() ?? invoke<RefreshJobStatus[]>("get_refresh_status"),
  storageOverview: () =>
    electronDesktopApi()?.home.storageOverview() ?? invoke<StorageOverview>("get_storage_overview"),
  workspaceStorageChildren: (workspaceId: string, relativePath: string) =>
    electronDesktopApi()?.home.storageChildren(workspaceId, relativePath) ??
    invoke<StorageNode>("get_workspace_storage_children", { workspaceId, relativePath }),
  openWorkspaceStoragePath: (workspaceId: string, relativePath: string) =>
    electronDesktopApi()?.home.openStoragePath(workspaceId, relativePath) ??
    invoke<void>("open_workspace_storage_path", { workspaceId, relativePath }),
  cancelStorageScan: () =>
    electronDesktopApi()?.home.cancelStorage() ?? invoke<boolean>("cancel_storage_scan"),
  discoverWorkspaces: () =>
    electronDesktopApi()?.home.refreshDiscovery() ?? invoke<RefreshReceipt>("discover_workspaces"),
  workspaces: () =>
    electronDesktopApi()?.home.workspaces() ?? invoke<WorkspaceSummary[]>("list_workspaces"),
  workspace: async (id: string) => {
    const desktop = electronDesktopApi();
    if (desktop) {
      const workspaces = await desktop.home.workspaces();
      return workspaces.find((workspace) => workspace.id === id);
    }
    return invoke<WorkspaceSummary | undefined>("get_workspace", { id });
  },
  workspaceGitSummary: (workspaceId: string) =>
    electronDesktopApi()?.workspace.gitSummary(workspaceId) ??
    invoke<GitWorkspaceSummary | undefined>("get_workspace_git_summary", { workspaceId }),
  workspaceGitHistory: (workspaceId: string, query: GitHistoryQuery = {}) =>
    electronDesktopApi()?.workspace.gitHistory(workspaceId, query) ??
    invoke<GitCommitPage | undefined>("list_workspace_git_history", { workspaceId, query }),
  gitCommitFiles: (workspaceId: string, oid: string) =>
    electronDesktopApi()?.workspace.gitCommitFiles(workspaceId, oid) ??
    invoke<GitFileChange[] | undefined>("list_git_commit_files", { workspaceId, oid }),
  gitDiff: (workspaceId: string, request: GitDiffRequest) =>
    electronDesktopApi()?.workspace.gitDiff(workspaceId, request) ??
    invoke<GitDiff | undefined>("get_git_diff", { workspaceId, request }),
  workspaceOpeners: (workspaceId: string) =>
    electronDesktopApi()?.workspace.openers(workspaceId) ??
    invoke<WorkspaceOpener[]>("list_workspace_openers", { workspaceId }),
  openWorkspaceWithApp: (workspaceId: string, openerId?: string) =>
    electronDesktopApi()?.workspace.open(workspaceId, openerId) ??
    invoke<void>("open_workspace_with_app", { workspaceId, openerId }),
  workspaceSessions: (workspaceId: string) =>
    electronDesktopApi()?.workspace.sessions(workspaceId) ??
    invoke<ConversationSessionSummary[]>("list_workspace_sessions", { workspaceId }),
  refreshWorkspaceSessions: (workspaceId: string, force = false) =>
    electronDesktopApi()?.workspace.refreshSessions(workspaceId, force) ??
    invoke<ConversationSessionSummary[]>("refresh_workspace_sessions", { workspaceId, force }),
  sessionEvents: (sessionId: string, cursor?: string, limit = 100) =>
    electronDesktopApi()?.workspace.sessionEvents(sessionId, cursor, limit) ??
    invoke<ConversationEventPage>("read_session_events", { sessionId, cursor, limit }),
  prepareSessionHandoff: (request: SessionHandoffRequest) =>
    electronDesktopApi()?.workspace.prepareHandoff(request) ??
    invoke<SessionHandoffPreparation>("prepare_session_handoff", { request }),
  summarizeSessionHandoff: (request: SessionHandoffRequest) =>
    electronDesktopApi()?.workspace.summarizeHandoff(request) ??
    invoke<SessionHandoffDraft>("summarize_session_handoff", { request }),
  sanitizeSessionHandoff: (format: HandoffFormat, editedContent: string) =>
    electronDesktopApi()?.workspace.sanitizeHandoff(format, editedContent) ??
    invoke<string>("sanitize_session_handoff", { format, editedContent }),
  planSessionHandoff: (
    workspaceId: string,
    filename: string,
    format: HandoffFormat,
    editedContent: string,
    targetAgent: AgentKind,
  ) =>
    electronDesktopApi()?.workspace.planHandoff(
      workspaceId,
      filename,
      format,
      editedContent,
      targetAgent,
    ) ??
    invoke<PlannedSessionHandoff>("plan_session_handoff", {
      workspaceId,
      filename,
      format,
      editedContent,
      targetAgent,
    }),
  continueSessionHandoff: (changeSet: ChangeSet, launchRequest: SessionHandoffLaunchRequest) =>
    electronDesktopApi()?.workspace.continueHandoff(changeSet, launchRequest) ??
    invoke<HandoffContinuationResult>("continue_session_handoff", { changeSet, launchRequest }),
  launchSessionHandoff: (launchRequest: SessionHandoffLaunchRequest) =>
    electronDesktopApi()?.workspace.launchHandoff(launchRequest) ??
    invoke<HandoffLaunchReceipt>("launch_session_handoff", { launchRequest }),
  workspaceSessionStatus: (workspaceId: string) =>
    electronDesktopApi()?.workspace.sessionStatus(workspaceId) ??
    invoke<ConversationIndexStatus[]>("get_workspace_session_status", { workspaceId }),
  clearSessionIndex: (workspaceId?: string) =>
    electronDesktopApi()?.sessions.clearIndex(workspaceId) ??
    invoke<void>("clear_session_index", { workspaceId }),
  setSessionIndexEnabled: (enabled: boolean) =>
    electronDesktopApi()?.sessions.setIndexEnabled(enabled) ??
    invoke<RuntimeInfo>("set_session_index_enabled", { enabled }),
  setQuotaAutoRefreshEnabled: (enabled: boolean) =>
    electronDesktopApi()?.home.setQuotaAutoRefresh(enabled) ??
    invoke<RuntimeInfo>("set_quota_auto_refresh_enabled", { enabled }),
  setQuotaAutoRefreshPromptSeen: (seen: boolean) =>
    electronDesktopApi()?.home.setQuotaPromptSeen(seen) ??
    invoke<RuntimeInfo>("set_quota_auto_refresh_prompt_seen", { seen }),
  addWorkspace: (path: string) =>
    electronDesktopApi()?.workspace.add(path) ??
    invoke<WorkspaceSummary>("add_workspace", { path }),
  refreshWorkspace: (id: string) =>
    electronDesktopApi()?.workspace.refresh(id) ??
    invoke<WorkspaceSummary>("refresh_workspace", { id }),
  excludeWorkspace: (id: string) =>
    electronDesktopApi()?.workspace.exclude(id) ?? invoke<void>("exclude_workspace", { id }),
  excludedWorkspaces: () =>
    electronDesktopApi()?.home.excludedWorkspaces() ??
    invoke<ExcludedWorkspace[]>("list_excluded_workspaces"),
  restoreExcludedWorkspace: (path: string) =>
    electronDesktopApi()?.workspace.restoreExcluded(path) ??
    invoke<void>("restore_excluded_workspace", { path }),
  obsidianIntegration: () =>
    electronDesktopApi()?.home.obsidianIntegration() ??
    invoke<ObsidianIntegration>("get_obsidian_integration"),
  addObsidianVault: (path: string) =>
    electronDesktopApi()?.home.addObsidianVault(path) ??
    invoke<ObsidianIntegration>("add_obsidian_vault", { path }),
  linkWorkspaceToObsidian: (workspaceId: string, vaultPath: string, relativeTarget?: string) =>
    electronDesktopApi()?.home.linkWorkspaceToObsidian(workspaceId, vaultPath, relativeTarget) ??
    invoke<ObsidianWorkspaceLink>("link_workspace_to_obsidian", {
      workspaceId,
      vaultPath,
      relativeTarget: relativeTarget?.trim() || null,
    }),
  unlinkWorkspaceFromObsidian: (workspaceId: string) =>
    electronDesktopApi()?.home.unlinkWorkspaceFromObsidian(workspaceId) ??
    invoke<void>("unlink_workspace_from_obsidian", { workspaceId }),
  openObsidian: () => electronDesktopApi()?.home.openObsidian() ?? invoke<void>("open_obsidian"),
  openWorkspaceInObsidian: (workspaceId: string) =>
    electronDesktopApi()?.home.openWorkspaceInObsidian(workspaceId) ??
    invoke<void>("open_workspace_in_obsidian", { workspaceId }),
  remoteGateways: () =>
    electronDesktopApi()?.home.remoteGateways() ??
    invoke<RemoteGatewaySummary[]>("list_remote_gateways"),
  saveRemoteGateway: (input: RemoteGatewayInput) =>
    electronDesktopApi()?.home.saveRemoteGateway(input) ??
    invoke<RemoteGatewaySummary>("save_remote_gateway", { input }),
  refreshRemoteGateway: (id: string) =>
    electronDesktopApi()?.home.refreshRemoteGateway(id) ??
    invoke<RemoteGatewaySummary>("refresh_remote_gateway", { id }),
  removeRemoteGateway: (id: string) =>
    electronDesktopApi()?.home.removeRemoteGateway(id) ??
    invoke<void>("remove_remote_gateway", { id }),
  scanRoots: () => electronDesktopApi()?.home.scanRoots() ?? invoke<ScanRoot[]>("list_scan_roots"),
  addScanRoot: (path: string, maxDepth = 5) =>
    electronDesktopApi()?.home.addScanRoot(path, maxDepth) ??
    invoke<ScanRoot>("add_scan_root", { path, maxDepth }),
  removeScanRoot: (id: string) =>
    electronDesktopApi()?.home.removeScanRoot(id) ?? invoke<void>("remove_scan_root", { id }),
  agentInstallations: () =>
    electronDesktopApi()?.home.agentInstallations() ??
    invoke<AgentInstallation[]>("list_agent_installations"),
  workspaceDoctorReport: (workspaceId: string) =>
    electronDesktopApi()?.workspace.doctorReport(workspaceId) ??
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
  refreshInsights: () =>
    electronDesktopApi()?.home.refreshInsights() ?? invoke<RefreshReceipt>("refresh_insights"),
  insightsView: (query: InsightsQuery = {}) =>
    electronDesktopApi()?.home.insightsView(query) ??
    invoke<InsightsView>("get_insights_view", { query }),
  insightsSummary: (query: InsightsQuery = {}) =>
    electronDesktopApi()?.home.insightsSummary(query) ??
    invoke<InsightsSummary>("get_insights_summary", { query }),
  insightsHeatmap: (query: InsightsQuery = {}) =>
    electronDesktopApi()?.insights.heatmap(query) ??
    invoke<HeatmapPoint[]>("get_insights_heatmap", { query }),
  agentUsageBreakdown: (query: InsightsQuery = {}) =>
    electronDesktopApi()?.insights.agentUsage(query) ??
    invoke<AgentUsageBreakdown[]>("get_agent_usage_breakdown", { query }),
  modelUsageBreakdown: (query: InsightsQuery = {}) =>
    electronDesktopApi()?.insights.modelUsage(query) ??
    invoke<ModelUsageBreakdown[]>("get_model_usage_breakdown", { query }),
  workspaceUsageBreakdown: (query: InsightsQuery = {}) =>
    electronDesktopApi()?.insights.workspaceUsage(query) ??
    invoke<WorkspaceUsageBreakdown[]>("get_workspace_usage_breakdown", { query }),
  repositoryCommitBreakdown: (query: InsightsQuery = {}) =>
    electronDesktopApi()?.insights.repositoryCommits(query) ??
    invoke<RepositoryCommitBreakdown[]>("get_repository_commit_breakdown", { query }),
  achievements: () =>
    electronDesktopApi()?.insights.achievements() ?? invoke<Achievement[]>("list_achievements"),
  insightsStatus: () =>
    electronDesktopApi()?.home.insightsStatus() ?? invoke<InsightsStatus>("get_insights_status"),
  gitIdentities: () =>
    electronDesktopApi()?.insights.gitIdentities() ??
    invoke<GitIdentitySummary[]>("list_git_identities"),
  addGitIdentityAlias: (email: string) =>
    electronDesktopApi()?.insights.addGitIdentityAlias(email) ??
    invoke<GitIdentitySummary>("add_git_identity_alias", { email }),
  setGitIdentityEnabled: (id: string, enabled: boolean) =>
    electronDesktopApi()?.insights.setGitIdentityEnabled(id, enabled) ??
    invoke<void>("set_git_identity_enabled", { id, enabled }),
  quotaSnapshot: () =>
    electronDesktopApi()?.home.quotaSnapshot() ??
    invoke<QuotaSnapshot | undefined>("get_quota_snapshot"),
  refreshQuota: () =>
    electronDesktopApi()?.home.refreshQuota() ?? invoke<RefreshReceipt>("refresh_quota"),
  quotaCollectorStatus: () =>
    electronDesktopApi()?.home.quotaCollectorStatus() ??
    invoke<QuotaCollectorStatus>("get_quota_collector_status"),
  quotaPopoverPreferences: () =>
    electronDesktopApi()?.home.quotaPreferences() ??
    invoke<QuotaPopoverPreferences>("get_quota_popover_preferences"),
  setQuotaPopoverPreferences: (preferences: QuotaPopoverPreferences) =>
    electronDesktopApi()?.home.setQuotaPreferences(preferences) ??
    invoke<QuotaPopoverPreferences>("set_quota_popover_preferences", { preferences }),
  openQuotaDashboard: (
    provider?: string,
    window?: QuotaWindowSelector,
    configurePopover = false,
  ) => {
    if (electronDesktopApi()) {
      globalThis.window.dispatchEvent(
        new CustomEvent("agentkib:electron-navigate", {
          detail: {
            page: "quota",
            provider,
            window,
            configure_popover: configurePopover,
          },
        }),
      );
      return Promise.resolve();
    }
    return invoke<void>("open_quota_dashboard", { provider, window, configurePopover });
  },
};
