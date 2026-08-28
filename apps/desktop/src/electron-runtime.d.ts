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
  OnboardingEvent,
  ObsidianIntegration,
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
  ContextDoctorReport,
  WorkspaceOpener,
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
    add(path: string): Promise<WorkspaceSummary>;
    refresh(id: string): Promise<WorkspaceSummary>;
    exclude(id: string): Promise<void>;
    restoreExcluded(path: string): Promise<void>;
    doctorReport(id: string): Promise<ContextDoctorReport>;
    openers(id: string): Promise<WorkspaceOpener[]>;
    open(id: string, openerId?: string): Promise<void>;
    doctorSummaries(workspaceIds: string[]): Promise<ContextDoctorSummary[]>;
  };
  shell: {
    openDirectory(title?: string): Promise<string | undefined>;
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
    updateOnboarding(event: OnboardingEvent): Promise<RuntimeInfo>;
    obsidianIntegration(): Promise<ObsidianIntegration>;
  };
}

declare global {
  interface Window {
    agentkibDesktop?: AgentKibDesktopApi;
  }
}

export {};
