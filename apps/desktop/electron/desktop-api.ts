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
    doctorSummaries(workspaceIds: string[]): Promise<unknown>;
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
  };
}
