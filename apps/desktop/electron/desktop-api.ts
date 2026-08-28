import type { RuntimeHandshakeResult } from "./generated/runtime-protocol";

export interface DesktopApi {
  platform: NodeJS.Platform;
  runtime: {
    handshake(): Promise<RuntimeHandshakeResult>;
  };
  updates: {
    check(): Promise<unknown>;
    install(version: string, onEvent: (event: unknown) => void): Promise<unknown>;
  };
  changes: {
    plan(project: string, manifest: unknown, includeHome: boolean): Promise<unknown>;
    apply(changeSet: unknown, approveHome: boolean): Promise<unknown>;
  };
  memories: {
    list(project: string, status?: string): Promise<unknown>;
    search(project: string, query: string, limit?: number): Promise<unknown>;
    propose(project: string, proposal: unknown): Promise<unknown>;
    review(id: string, status: string, editedContent?: string): Promise<unknown>;
  };
  sessions: {
    clearIndex(workspaceId?: string): Promise<unknown>;
    setIndexEnabled(enabled: boolean): Promise<unknown>;
  };
  mcp: {
    hubStatus(): Promise<unknown>;
    updateNetwork(settings: unknown): Promise<unknown>;
    listServers(project?: string): Promise<unknown>;
    getServer(serverId: string, project?: string): Promise<unknown>;
    saveServer(server: unknown, project?: string): Promise<unknown>;
    saveLocalValues(
      serverId: string,
      env: Record<string, string>,
      headers: Record<string, string>,
      project?: string,
    ): Promise<unknown>;
    removeServer(serverId: string, project?: string): Promise<unknown>;
    probeRuntime(serverId: string, project?: string): Promise<unknown>;
    startOAuth(serverId: string, project?: string): Promise<unknown>;
    runtimes(): Promise<unknown>;
    restartRuntime(serverId: string, project?: string): Promise<unknown>;
    stopRuntime(serverId?: string): Promise<unknown>;
    searchRegistry(query: string): Promise<unknown>;
    refreshRegistry(query: string): Promise<unknown>;
    install(entry: unknown, project?: string): Promise<unknown>;
    update(installationId: string, entry: unknown, project?: string): Promise<unknown>;
    installations(): Promise<unknown>;
    uninstall(installationId: string): Promise<unknown>;
    scanNative(project?: string): Promise<unknown>;
    planMigration(project: string, candidateIds: string[]): Promise<unknown>;
  };
  insights: {
    heatmap(query: unknown): Promise<unknown>;
    agentUsage(query: unknown): Promise<unknown>;
    modelUsage(query: unknown): Promise<unknown>;
    workspaceUsage(query: unknown): Promise<unknown>;
    repositoryCommits(query: unknown): Promise<unknown>;
    achievements(): Promise<unknown>;
    gitIdentities(): Promise<unknown>;
    addGitIdentityAlias(email: string): Promise<unknown>;
    setGitIdentityEnabled(id: string, enabled: boolean): Promise<unknown>;
  };
  workspace: {
    scan(project: string): Promise<unknown>;
    prepareManifest(project: string): Promise<unknown>;
    resolveContext(project: string, cwd: string, agent: string): Promise<unknown>;
    add(path: string): Promise<unknown>;
    refresh(id: string): Promise<unknown>;
    exclude(id: string): Promise<unknown>;
    restoreExcluded(path: string): Promise<unknown>;
    doctorReport(id: string): Promise<unknown>;
    gitSummary(id: string): Promise<unknown>;
    gitHistory(id: string, query: unknown): Promise<unknown>;
    gitCommitFiles(id: string, oid: string): Promise<unknown>;
    gitDiff(id: string, request: unknown): Promise<unknown>;
    sessions(id: string): Promise<unknown>;
    sessionStatus(id: string): Promise<unknown>;
    refreshSessions(id: string, force?: boolean): Promise<unknown>;
    sessionEvents(id: string, cursor?: string, limit?: number): Promise<unknown>;
    prepareHandoff(request: unknown): Promise<unknown>;
    summarizeHandoff(request: unknown): Promise<unknown>;
    sanitizeHandoff(format: string, editedContent: string): Promise<unknown>;
    planHandoff(
      workspaceId: string,
      filename: string,
      format: string,
      editedContent: string,
      targetAgent: string,
    ): Promise<unknown>;
    continueHandoff(changeSet: unknown, launchRequest: unknown): Promise<unknown>;
    launchHandoff(launchRequest: unknown): Promise<unknown>;
    openers(id: string): Promise<unknown>;
    open(id: string, openerId?: string): Promise<unknown>;
    doctorSummaries(workspaceIds: string[]): Promise<unknown>;
  };
  shell: {
    openDirectory(title?: string): Promise<string | undefined>;
    openExternal(url: string): Promise<void>;
    openFilesAndFoldersSettings(): Promise<unknown>;
    quit(): Promise<unknown>;
  };
  settings: {
    setCloseBehavior(value?: string): Promise<unknown>;
    setLocale(preference: string): Promise<unknown>;
    setThemePreference(preference: string): Promise<unknown>;
    setAppIconPreference(preference: string): Promise<unknown>;
  };
  home: {
    runtime(): Promise<unknown>;
    workspaces(): Promise<unknown>;
    agentInstallations(): Promise<unknown>;
    catalogAssets(input: unknown): Promise<unknown>;
    globalMemories(status?: string): Promise<unknown>;
    activity(limit?: number): Promise<unknown>;
    scanRoots(): Promise<unknown>;
    addScanRoot(path: string, maxDepth: number): Promise<unknown>;
    removeScanRoot(id: string): Promise<unknown>;
    refreshDiscovery(): Promise<unknown>;
    excludedWorkspaces(): Promise<unknown>;
    remoteGateways(): Promise<unknown>;
    saveRemoteGateway(input: unknown): Promise<unknown>;
    refreshRemoteGateway(id: string): Promise<unknown>;
    removeRemoteGateway(id: string): Promise<unknown>;
    insightsView(query: unknown): Promise<unknown>;
    refreshInsights(): Promise<unknown>;
    insightsSummary(query: unknown): Promise<unknown>;
    insightsStatus(): Promise<unknown>;
    quotaCollectorStatus(): Promise<unknown>;
    quotaSnapshot(): Promise<unknown>;
    quotaPreferences(): Promise<unknown>;
    setQuotaPreferences(preferences: unknown): Promise<unknown>;
    refreshQuota(): Promise<unknown>;
    setQuotaAutoRefresh(enabled: boolean): Promise<unknown>;
    setQuotaPromptSeen(seen: boolean): Promise<unknown>;
    refreshStatus(): Promise<unknown>;
    storageOverview(): Promise<unknown>;
    storageChildren(workspaceId: string, relativePath: string): Promise<unknown>;
    refreshStorage(): Promise<unknown>;
    openStoragePath(workspaceId: string, relativePath: string): Promise<unknown>;
    cancelStorage(): Promise<unknown>;
    updateOnboarding(event: unknown): Promise<unknown>;
    obsidianIntegration(): Promise<unknown>;
    addObsidianVault(path: string): Promise<unknown>;
    linkWorkspaceToObsidian(
      workspaceId: string,
      vaultPath: string,
      relativeTarget?: string,
    ): Promise<unknown>;
    unlinkWorkspaceFromObsidian(workspaceId: string): Promise<unknown>;
    openObsidian(): Promise<unknown>;
    openWorkspaceInObsidian(workspaceId: string): Promise<unknown>;
  };
}
