import type { RuntimeHandshakeResult } from "./generated/runtime-protocol";

export interface DesktopApi {
  platform: NodeJS.Platform;
  runtime: {
    handshake(): Promise<RuntimeHandshakeResult>;
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
    openers(id: string): Promise<unknown>;
    open(id: string, openerId?: string): Promise<unknown>;
    doctorSummaries(workspaceIds: string[]): Promise<unknown>;
  };
  shell: {
    openDirectory(title?: string): Promise<string | undefined>;
  };
  home: {
    runtime(): Promise<unknown>;
    workspaces(): Promise<unknown>;
    agentInstallations(): Promise<unknown>;
    catalogAssets(input: unknown): Promise<unknown>;
    globalMemories(status?: string): Promise<unknown>;
    activity(limit?: number): Promise<unknown>;
    scanRoots(): Promise<unknown>;
    excludedWorkspaces(): Promise<unknown>;
    remoteGateways(): Promise<unknown>;
    insightsSummary(query: unknown): Promise<unknown>;
    insightsStatus(): Promise<unknown>;
    quotaCollectorStatus(): Promise<unknown>;
    refreshStatus(): Promise<unknown>;
    updateOnboarding(event: unknown): Promise<unknown>;
    obsidianIntegration(): Promise<unknown>;
  };
}
