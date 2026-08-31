import { create } from "zustand";
import type {
  ActivityRecord,
  AgentInstallation,
  AppMenuCommandRequest,
  AppNavigationRequest,
  CatalogAsset,
  ContextDoctorSummary,
  DiscoveryReport,
  ExcludedWorkspace,
  InsightsStatus,
  InsightsSummary,
  RefreshJobStatus,
  RemoteGatewaySummary,
  RuntimeInfo,
  ScanRoot,
  WorkspaceSummary,
} from "../core/types";

type Updater<T> = T | ((current: T) => T);

interface AppState {
  sidebarCollapsed: boolean;
  runtime?: RuntimeInfo;
  workspaces: WorkspaceSummary[];
  workspacesLoaded: boolean;
  installations: AgentInstallation[];
  doctorSummaries: Record<string, ContextDoctorSummary>;
  catalog: CatalogAsset[];
  globalMemories: import("../core/types").MemoryRecord[];
  activity: ActivityRecord[];
  scanRoots: ScanRoot[];
  excluded: ExcludedWorkspace[];
  discovery?: DiscoveryReport;
  remoteGateways: RemoteGatewaySummary[];
  insightsSummary?: InsightsSummary;
  insightsStatus?: InsightsStatus;
  navigationRequest?: AppNavigationRequest;
  menuCommand?: AppMenuCommandRequest;
  refreshJobs: RefreshJobStatus[];
  quotaConfigureRequest: number;
  globalError?: string;
}

interface AppActions {
  reset: () => void;
  setSidebarCollapsed: (value: Updater<boolean>) => void;
  setRuntime: (value: Updater<RuntimeInfo | undefined>) => void;
  setWorkspaces: (value: Updater<WorkspaceSummary[]>) => void;
  setWorkspacesLoaded: (value: Updater<boolean>) => void;
  setInstallations: (value: Updater<AgentInstallation[]>) => void;
  setDoctorSummaries: (value: Updater<Record<string, ContextDoctorSummary>>) => void;
  setCatalog: (value: Updater<CatalogAsset[]>) => void;
  setGlobalMemories: (value: Updater<import("../core/types").MemoryRecord[]>) => void;
  setActivity: (value: Updater<ActivityRecord[]>) => void;
  setScanRoots: (value: Updater<ScanRoot[]>) => void;
  setExcluded: (value: Updater<ExcludedWorkspace[]>) => void;
  setDiscovery: (value: Updater<DiscoveryReport | undefined>) => void;
  setRemoteGateways: (value: Updater<RemoteGatewaySummary[]>) => void;
  setInsightsSummary: (value: Updater<InsightsSummary | undefined>) => void;
  setInsightsStatus: (value: Updater<InsightsStatus | undefined>) => void;
  setNavigationRequest: (value: Updater<AppNavigationRequest | undefined>) => void;
  setMenuCommand: (value: Updater<AppMenuCommandRequest | undefined>) => void;
  setRefreshJobs: (value: Updater<RefreshJobStatus[]>) => void;
  setQuotaConfigureRequest: (value: Updater<number>) => void;
  setGlobalError: (value: Updater<string | undefined>) => void;
}

const resolve = <T>(value: Updater<T>, current: T): T =>
  typeof value === "function" ? (value as (current: T) => T)(current) : value;

const SIDEBAR_COLLAPSED_STORAGE_KEY = "agentkib.sidebar-collapsed";

function initialSidebarCollapsed() {
  try {
    return typeof localStorage?.getItem === "function"
      ? localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true"
      : false;
  } catch {
    return false;
  }
}

function persistSidebarCollapsed(value: boolean) {
  try {
    if (typeof localStorage?.setItem === "function") {
      localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(value));
    }
  } catch {
    // Persisting this UI preference is best-effort in restricted webviews.
  }
}

export const useAppStore = create<AppState & AppActions>((set) => ({
  sidebarCollapsed: initialSidebarCollapsed(),
  workspaces: [],
  workspacesLoaded: false,
  installations: [],
  doctorSummaries: {},
  catalog: [],
  globalMemories: [],
  activity: [],
  scanRoots: [],
  excluded: [],
  remoteGateways: [],
  refreshJobs: [],
  quotaConfigureRequest: 0,
  reset: () =>
    set({
      sidebarCollapsed: false,
      runtime: undefined,
      workspaces: [],
      workspacesLoaded: false,
      installations: [],
      doctorSummaries: {},
      catalog: [],
      globalMemories: [],
      activity: [],
      scanRoots: [],
      excluded: [],
      discovery: undefined,
      remoteGateways: [],
      insightsSummary: undefined,
      insightsStatus: undefined,
      navigationRequest: undefined,
      menuCommand: undefined,
      refreshJobs: [],
      quotaConfigureRequest: 0,
      globalError: undefined,
    }),
  setSidebarCollapsed: (value) =>
    set((state) => {
      const next = resolve(value, state.sidebarCollapsed);
      persistSidebarCollapsed(next);
      return { sidebarCollapsed: next };
    }),
  setRuntime: (value) => set((state) => ({ runtime: resolve(value, state.runtime) })),
  setWorkspaces: (value) => set((state) => ({ workspaces: resolve(value, state.workspaces) })),
  setWorkspacesLoaded: (value) =>
    set((state) => ({ workspacesLoaded: resolve(value, state.workspacesLoaded) })),
  setInstallations: (value) =>
    set((state) => ({ installations: resolve(value, state.installations) })),
  setDoctorSummaries: (value) =>
    set((state) => ({ doctorSummaries: resolve(value, state.doctorSummaries) })),
  setCatalog: (value) => set((state) => ({ catalog: resolve(value, state.catalog) })),
  setGlobalMemories: (value) =>
    set((state) => ({ globalMemories: resolve(value, state.globalMemories) })),
  setActivity: (value) => set((state) => ({ activity: resolve(value, state.activity) })),
  setScanRoots: (value) => set((state) => ({ scanRoots: resolve(value, state.scanRoots) })),
  setExcluded: (value) => set((state) => ({ excluded: resolve(value, state.excluded) })),
  setDiscovery: (value) => set((state) => ({ discovery: resolve(value, state.discovery) })),
  setRemoteGateways: (value) =>
    set((state) => ({ remoteGateways: resolve(value, state.remoteGateways) })),
  setInsightsSummary: (value) =>
    set((state) => ({ insightsSummary: resolve(value, state.insightsSummary) })),
  setInsightsStatus: (value) =>
    set((state) => ({ insightsStatus: resolve(value, state.insightsStatus) })),
  setNavigationRequest: (value) =>
    set((state) => ({ navigationRequest: resolve(value, state.navigationRequest) })),
  setMenuCommand: (value) => set((state) => ({ menuCommand: resolve(value, state.menuCommand) })),
  setRefreshJobs: (value) => set((state) => ({ refreshJobs: resolve(value, state.refreshJobs) })),
  setQuotaConfigureRequest: (value) =>
    set((state) => ({ quotaConfigureRequest: resolve(value, state.quotaConfigureRequest) })),
  setGlobalError: (value) => set((state) => ({ globalError: resolve(value, state.globalError) })),
}));
