import type { RuntimeHandshakeResult } from "./generated/runtime-protocol";
import type {
  AgentKind,
  AppMenuCommandRequest,
  AppNavigationRequest,
  AppUpdateInfo,
  AppUpdateProgress,
  Achievement,
  AgentUsageBreakdown,
  ChangeSet,
  CatalogAsset,
  ContextDoctorSummary,
  ContextPreview,
  ExcludedWorkspace,
  EffectiveTheme,
  InsightsQuery,
  InsightsStatus,
  Manifest,
  MemoryRecord,
  OnboardingEvent,
  ObsidianIntegration,
  QuotaCollectorStatus,
  QuotaPopoverPreferences,
  QuotaSnapshot,
  RefreshJobStatus,
  RefreshReceipt,
  ScanRoot,
  StorageNode,
  StorageOverview,
  WorkspaceScan,
  WorkspaceSummary,
  AgentInstallation,
  ActivityRecord,
  GitCommitPage,
  GitDiff,
  GitDiffRequest,
  GitFileChange,
  GitHistoryQuery,
  GitWorkspaceSummary,
  ConversationEventPage,
  ConversationIndexStatus,
  ConversationSessionSummary,
  SessionHandoffRequest,
  SessionHandoffPreparation,
  SessionHandoffDraft,
  SessionHandoffLaunchRequest,
  HandoffContinuationResult,
  HandoffFormat,
  HandoffLaunchReceipt,
  PlannedSessionHandoff,
  RuntimeInfo,
  InsightsSummary,
  InsightsView,
  ContextDoctorReport,
  WorkspaceOpener,
  AppIconPreference,
  CloseBehavior,
  LocalePreference,
  McpHubStatus,
  McpInstallation,
  McpInstallResult,
  McpMigrationCandidate,
  McpOAuthStart,
  McpRegistryEntry,
  McpRuntimeStatus,
  McpServerConfig,
  McpToolDescriptor,
  RemoteGatewayInput,
  RemoteGatewaySummary,
  ObsidianWorkspaceLink,
  GitIdentitySummary,
} from "../src/core/types";

export type DesktopEventUnsubscribe = () => void;

export interface DesktopApi {
  platform: NodeJS.Platform;
  events: {
    onQuitRequested(listener: () => void): DesktopEventUnsubscribe;
    onThemeChanged(listener: (theme: EffectiveTheme) => void): DesktopEventUnsubscribe;
    onRefreshState(listener: (status: RefreshJobStatus) => void): DesktopEventUnsubscribe;
    onQuotaUpdated(listener: (snapshot: QuotaSnapshot) => void): DesktopEventUnsubscribe;
    onNavigate(listener: (request: AppNavigationRequest) => void): DesktopEventUnsubscribe;
    onMenuCommand(listener: (request: AppMenuCommandRequest) => void): DesktopEventUnsubscribe;
  };
  runtime: {
    handshake(): Promise<RuntimeHandshakeResult>;
  };
  updates: {
    check(): Promise<AppUpdateInfo | undefined>;
    install(version: string, onEvent: (event: AppUpdateProgress) => void): Promise<void>;
  };
  changes: {
    plan(project: string, manifest: Manifest, includeHome: boolean): Promise<ChangeSet>;
    apply(changeSet: ChangeSet, approveHome: boolean): Promise<unknown>;
  };
  memories: {
    list(project: string, status?: string): Promise<MemoryRecord[]>;
    search(project: string, query: string, limit?: number): Promise<MemoryRecord[]>;
    propose(project: string, proposal: unknown): Promise<MemoryRecord>;
    review(id: string, status: string, editedContent?: string): Promise<MemoryRecord>;
  };
  sessions: {
    clearIndex(workspaceId?: string): Promise<void>;
    setIndexEnabled(enabled: boolean): Promise<RuntimeInfo>;
  };
  mcp: {
    hubStatus(): Promise<McpHubStatus>;
    updateNetwork(settings: unknown): Promise<McpHubStatus>;
    listServers(project?: string): Promise<McpServerConfig[]>;
    getServer(serverId: string, project?: string): Promise<McpServerConfig | undefined>;
    saveServer(server: McpServerConfig, project?: string): Promise<McpServerConfig>;
    saveLocalValues(
      serverId: string,
      env: Record<string, string>,
      headers: Record<string, string>,
      project?: string,
    ): Promise<void>;
    removeServer(serverId: string, project?: string): Promise<void>;
    probeRuntime(serverId: string, project?: string): Promise<McpToolDescriptor[]>;
    startOAuth(serverId: string, project?: string): Promise<McpOAuthStart>;
    runtimes(): Promise<McpRuntimeStatus[]>;
    restartRuntime(serverId: string, project?: string): Promise<McpToolDescriptor[]>;
    stopRuntime(serverId?: string): Promise<void>;
    searchRegistry(query: string): Promise<McpRegistryEntry[]>;
    refreshRegistry(query: string): Promise<McpRegistryEntry[]>;
    install(entry: McpRegistryEntry, project?: string): Promise<McpInstallResult>;
    update(
      installationId: string,
      entry: McpRegistryEntry,
      project?: string,
    ): Promise<McpInstallResult>;
    installations(): Promise<McpInstallation[]>;
    uninstall(installationId: string): Promise<void>;
    scanNative(project?: string): Promise<McpMigrationCandidate[]>;
    planMigration(project: string, candidateIds: string[]): Promise<ChangeSet>;
  };
  insights: {
    heatmap(query: InsightsQuery): Promise<import("../src/core/types").HeatmapPoint[]>;
    agentUsage(query: InsightsQuery): Promise<AgentUsageBreakdown[]>;
    modelUsage(query: InsightsQuery): Promise<import("../src/core/types").ModelUsageBreakdown[]>;
    workspaceUsage(
      query: InsightsQuery,
    ): Promise<import("../src/core/types").WorkspaceUsageBreakdown[]>;
    repositoryCommits(
      query: InsightsQuery,
    ): Promise<import("../src/core/types").RepositoryCommitBreakdown[]>;
    achievements(): Promise<Achievement[]>;
    gitIdentities(): Promise<GitIdentitySummary[]>;
    addGitIdentityAlias(email: string): Promise<GitIdentitySummary>;
    setGitIdentityEnabled(id: string, enabled: boolean): Promise<void>;
  };
  workspace: {
    scan(project: string): Promise<WorkspaceScan>;
    prepareManifest(project: string): Promise<Manifest>;
    resolveContext(project: string, cwd: string, agent: AgentKind): Promise<ContextPreview>;
    add(path: string): Promise<WorkspaceSummary>;
    refresh(id: string): Promise<WorkspaceSummary>;
    exclude(id: string): Promise<void>;
    restoreExcluded(path: string): Promise<void>;
    doctorReport(id: string): Promise<ContextDoctorReport>;
    gitSummary(id: string): Promise<GitWorkspaceSummary | undefined>;
    gitHistory(id: string, query: GitHistoryQuery): Promise<GitCommitPage | undefined>;
    gitCommitFiles(id: string, oid: string): Promise<GitFileChange[] | undefined>;
    gitDiff(id: string, request: GitDiffRequest): Promise<GitDiff | undefined>;
    sessions(id: string): Promise<ConversationSessionSummary[]>;
    sessionStatus(id: string): Promise<ConversationIndexStatus[]>;
    refreshSessions(id: string, force?: boolean): Promise<ConversationSessionSummary[]>;
    sessionEvents(id: string, cursor?: string, limit?: number): Promise<ConversationEventPage>;
    prepareHandoff(request: SessionHandoffRequest): Promise<SessionHandoffPreparation>;
    summarizeHandoff(request: SessionHandoffRequest): Promise<SessionHandoffDraft>;
    sanitizeHandoff(format: HandoffFormat, editedContent: string): Promise<string>;
    planHandoff(
      workspaceId: string,
      filename: string,
      format: HandoffFormat,
      editedContent: string,
      targetAgent: AgentKind,
    ): Promise<PlannedSessionHandoff>;
    continueHandoff(
      changeSet: ChangeSet,
      launchRequest: SessionHandoffLaunchRequest,
    ): Promise<HandoffContinuationResult>;
    launchHandoff(launchRequest: SessionHandoffLaunchRequest): Promise<HandoffLaunchReceipt>;
    openers(id: string): Promise<WorkspaceOpener[]>;
    open(id: string, openerId?: string): Promise<void>;
    doctorSummaries(workspaceIds: string[]): Promise<ContextDoctorSummary[]>;
  };
  shell: {
    openDirectory(title?: string): Promise<string | undefined>;
    openExternal(url: string): Promise<void>;
    openFilesAndFoldersSettings(): Promise<void>;
    openQuotaDashboard(request: AppNavigationRequest): Promise<void>;
    hideWindow(): Promise<void>;
    quit(): Promise<void>;
  };
  settings: {
    setCloseBehavior(value?: CloseBehavior): Promise<void>;
    setLocale(preference: LocalePreference): Promise<RuntimeInfo>;
    setThemePreference(preference: "system" | "light" | "dark"): Promise<RuntimeInfo>;
    setAppIconPreference(preference: AppIconPreference): Promise<RuntimeInfo>;
  };
  home: {
    runtime(): Promise<RuntimeInfo>;
    workspaces(): Promise<WorkspaceSummary[]>;
    agentInstallations(): Promise<AgentInstallation[]>;
    catalogAssets(input: {
      query?: string;
      agent?: AgentKind;
      workspaceId?: string;
      limit?: number;
    }): Promise<CatalogAsset[]>;
    globalMemories(status?: string): Promise<MemoryRecord[]>;
    activity(limit?: number): Promise<ActivityRecord[]>;
    scanRoots(): Promise<ScanRoot[]>;
    addScanRoot(path: string, maxDepth: number): Promise<ScanRoot>;
    removeScanRoot(id: string): Promise<void>;
    refreshDiscovery(): Promise<RefreshReceipt>;
    discoveryReport(): Promise<import("../src/core/types").DiscoveryReport | undefined>;
    excludedWorkspaces(): Promise<ExcludedWorkspace[]>;
    remoteGateways(): Promise<RemoteGatewaySummary[]>;
    saveRemoteGateway(input: RemoteGatewayInput): Promise<RemoteGatewaySummary>;
    refreshRemoteGateway(id: string): Promise<RemoteGatewaySummary>;
    removeRemoteGateway(id: string): Promise<void>;
    insightsView(query: InsightsQuery): Promise<InsightsView>;
    refreshInsights(): Promise<RefreshReceipt>;
    insightsSummary(query: InsightsQuery): Promise<InsightsSummary>;
    insightsStatus(): Promise<InsightsStatus>;
    quotaCollectorStatus(): Promise<QuotaCollectorStatus>;
    quotaSnapshot(): Promise<QuotaSnapshot | undefined>;
    quotaPreferences(): Promise<QuotaPopoverPreferences>;
    setQuotaPreferences(preferences: QuotaPopoverPreferences): Promise<QuotaPopoverPreferences>;
    refreshQuota(): Promise<RefreshReceipt>;
    setQuotaAutoRefresh(enabled: boolean): Promise<RuntimeInfo>;
    setQuotaPromptSeen(seen: boolean): Promise<RuntimeInfo>;
    refreshStatus(): Promise<RefreshJobStatus[]>;
    storageOverview(): Promise<StorageOverview>;
    storageChildren(workspaceId: string, relativePath: string): Promise<StorageNode>;
    refreshStorage(): Promise<RefreshReceipt>;
    openStoragePath(workspaceId: string, relativePath: string): Promise<void>;
    cancelStorage(): Promise<boolean>;
    updateOnboarding(event: OnboardingEvent): Promise<RuntimeInfo>;
    obsidianIntegration(): Promise<ObsidianIntegration>;
    addObsidianVault(path: string): Promise<ObsidianIntegration>;
    linkWorkspaceToObsidian(
      workspaceId: string,
      vaultPath: string,
      relativeTarget?: string,
    ): Promise<ObsidianWorkspaceLink>;
    unlinkWorkspaceFromObsidian(workspaceId: string): Promise<void>;
    openObsidian(): Promise<void>;
    openWorkspaceInObsidian(workspaceId: string): Promise<void>;
  };
}
