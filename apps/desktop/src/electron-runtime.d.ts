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
  GitCommitPage,
  GitDiff,
  GitDiffRequest,
  GitFileChange,
  GitHistoryQuery,
  GitWorkspaceSummary,
  ConversationEventPage,
  ConversationIndexStatus,
  ConversationSessionSummary,
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
    gitSummary(id: string): Promise<GitWorkspaceSummary | undefined>;
    gitHistory(id: string, query: GitHistoryQuery): Promise<GitCommitPage | undefined>;
    gitCommitFiles(id: string, oid: string): Promise<GitFileChange[] | undefined>;
    gitDiff(id: string, request: GitDiffRequest): Promise<GitDiff | undefined>;
    sessions(id: string): Promise<ConversationSessionSummary[]>;
    sessionStatus(id: string): Promise<ConversationIndexStatus[]>;
    refreshSessions(id: string, force?: boolean): Promise<ConversationSessionSummary[]>;
    sessionEvents(id: string, cursor?: string, limit?: number): Promise<ConversationEventPage>;
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
