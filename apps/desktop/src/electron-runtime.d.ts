import type { RuntimeHandshakeResult } from "../electron/generated/runtime-protocol";
import type {
  AgentKind,
  CatalogAsset,
  ContextDoctorSummary,
  ContextPreview,
  ExcludedWorkspace,
  InsightsQuery,
  InsightsStatus,
  Manifest,
  MemoryRecord,
  QuotaCollectorStatus,
  RefreshJobStatus,
  RemoteGatewaySummary,
  ScanRoot,
  WorkspaceScan,
  WorkspaceSummary,
  AgentInstallation,
  ActivityRecord,
  RuntimeInfo,
  InsightsSummary,
} from "./core/types";

interface AgentKibDesktopApi {
  platform: NodeJS.Platform;
  runtime: {
    handshake(): Promise<RuntimeHandshakeResult>;
  };
  workspace: {
    scan(project: string): Promise<WorkspaceScan>;
    prepareManifest(project: string): Promise<Manifest>;
    resolveContext(project: string, cwd: string, agent: AgentKind): Promise<ContextPreview>;
    doctorSummaries(workspaceIds: string[]): Promise<ContextDoctorSummary[]>;
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
    excludedWorkspaces(): Promise<ExcludedWorkspace[]>;
    remoteGateways(): Promise<RemoteGatewaySummary[]>;
    insightsSummary(query: InsightsQuery): Promise<InsightsSummary>;
    insightsStatus(): Promise<InsightsStatus>;
    quotaCollectorStatus(): Promise<QuotaCollectorStatus>;
    refreshStatus(): Promise<RefreshJobStatus[]>;
  };
}

declare global {
  interface Window {
    agentkibDesktop?: AgentKibDesktopApi;
  }
}

export {};
