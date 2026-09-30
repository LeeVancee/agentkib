import { RUNTIME_METHODS } from "@agentkib/runtime-protocol";

export const BACKEND_INITIALIZE = "backend.initialize";
export const BACKEND_PREFERENCES = "backend.preferences";
export const BACKEND_PLAN_WORKSPACE = "backend.planWorkspace";
export const BACKEND_PLAN_DISCOVERY = "backend.planDiscovery";
export const NATIVE_CONTEXT = "backend.nativeContext";
export const NATIVE_DISCOVERY = "backend.nativeDiscovery";
export const NATIVE_SCAN_ROOT_DISCOVERY = "backend.nativeScanRootDiscovery";
export const NATIVE_CONFIGURED_DISCOVERY = "backend.nativeConfiguredDiscovery";
export const NATIVE_INSPECT = "backend.nativeInspect";
export const BACKEND_INSPECT = "backend.inspectWorkspaces";
export const NATIVE_REMOTE_SESSION_INDEX_CHANGED = "backend.remoteSessionIndexChanged";
export const TYPESCRIPT_READ_METHODS = new Set<string>([
  RUNTIME_METHODS.listWorkspaces,
  RUNTIME_METHODS.listActivity,
  RUNTIME_METHODS.listScanRoots,
  RUNTIME_METHODS.listExcludedWorkspaces,
  RUNTIME_METHODS.discoveryReport,
  RUNTIME_METHODS.quotaPreferences,
]);
export const TYPESCRIPT_PREFERENCE_METHODS = new Set<string>([
  RUNTIME_METHODS.setCloseBehavior,
  RUNTIME_METHODS.setLocale,
  RUNTIME_METHODS.setThemePreference,
  RUNTIME_METHODS.setAccentThemePreference,
  RUNTIME_METHODS.setSidebarWidthPreference,
  RUNTIME_METHODS.setAppIconPreference,
  RUNTIME_METHODS.setSessionIndexEnabled,
  RUNTIME_METHODS.setQuotaAutoRefresh,
  RUNTIME_METHODS.setLocalAutoRefresh,
  RUNTIME_METHODS.setQuotaPromptSeen,
  RUNTIME_METHODS.updateOnboarding,
]);

export const TYPESCRIPT_WORKSPACE_METHODS = new Set<string>([
  RUNTIME_METHODS.addWorkspace,
  RUNTIME_METHODS.refreshWorkspace,
  RUNTIME_METHODS.excludeWorkspace,
  RUNTIME_METHODS.restoreExcludedWorkspace,
  RUNTIME_METHODS.addScanRoot,
  RUNTIME_METHODS.removeScanRoot,
  RUNTIME_METHODS.refreshDiscovery,
]);

/** All current runtime entry points that can mutate preferences.json. */
export const PREFERENCE_WRITE_METHODS = new Set<string>([
  ...TYPESCRIPT_PREFERENCE_METHODS,
  RUNTIME_METHODS.setSessionIndexEnabled,
  RUNTIME_METHODS.setQuotaPreferences,
  RUNTIME_METHODS.setQuotaAutoRefresh,
  RUNTIME_METHODS.setLocalAutoRefresh,
  RUNTIME_METHODS.setQuotaPromptSeen,
  RUNTIME_METHODS.updateOnboarding,
  RUNTIME_METHODS.openWorkspaceWithApp,
  RUNTIME_METHODS.updateMcpNetwork,
]);

export type {
  NativeContext,
  WorkspacePlan,
  InspectedWorkspace,
  DiscoverySnapshot,
  DiscoveryPlan,
} from "./workspaces";

export const TYPESCRIPT_GIT_METHODS = new Set<string>([
  RUNTIME_METHODS.workspaceGitSummary,
  RUNTIME_METHODS.workspaceGitHistory,
  RUNTIME_METHODS.gitCommitFiles,
  RUNTIME_METHODS.gitDiff,
]);

export const TYPESCRIPT_CATALOG_METHODS = new Set<string>([
  RUNTIME_METHODS.listAgentInstallations,
  RUNTIME_METHODS.searchCatalogAssets,
  RUNTIME_METHODS.listGlobalMemories,
  RUNTIME_METHODS.listMemories,
  RUNTIME_METHODS.searchMemories,
  RUNTIME_METHODS.proposeMemory,
  RUNTIME_METHODS.reviewMemory,
]);

export const TYPESCRIPT_ASSET_METHODS = new Set<string>([
  RUNTIME_METHODS.scanWorkspace,
  RUNTIME_METHODS.prepareManifest,
  RUNTIME_METHODS.resolveContext,
  RUNTIME_METHODS.workspaceDoctorReport,
  RUNTIME_METHODS.workspaceDoctorSummaries,
  RUNTIME_METHODS.planChanges,
  RUNTIME_METHODS.applyChanges,
]);

export const TYPESCRIPT_INSIGHT_METHODS = new Set<string>([
  RUNTIME_METHODS.insightsSummary,
  RUNTIME_METHODS.insightsHeatmap,
  RUNTIME_METHODS.agentUsageBreakdown,
  RUNTIME_METHODS.modelUsageBreakdown,
  RUNTIME_METHODS.workspaceUsageBreakdown,
  RUNTIME_METHODS.repositoryCommitBreakdown,
  RUNTIME_METHODS.achievements,
  RUNTIME_METHODS.gitIdentities,
  RUNTIME_METHODS.addGitIdentityAlias,
  RUNTIME_METHODS.setGitIdentityEnabled,
  RUNTIME_METHODS.insightsView,
  RUNTIME_METHODS.insightsStatus,
]);

export const TYPESCRIPT_SESSION_READ_METHODS = new Set<string>([
  RUNTIME_METHODS.workspaceSessions,
  RUNTIME_METHODS.workspaceSessionStatus,
  RUNTIME_METHODS.sessionEvents,
]);

export const TYPESCRIPT_SESSION_INDEX_METHODS = new Set<string>([
  RUNTIME_METHODS.refreshWorkspaceSessions,
  RUNTIME_METHODS.clearSessionIndex,
]);
