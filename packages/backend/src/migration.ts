import { RUNTIME_METHODS } from "@agentkib/runtime-protocol";

export const BACKEND_INITIALIZE = "backend.initialize";
export const BACKEND_PREFERENCES = "backend.preferences";
export const BACKEND_PLAN_WORKSPACE = "backend.planWorkspace";
export const BACKEND_PLAN_DISCOVERY = "backend.planDiscovery";
export const NATIVE_CONTEXT = "backend.nativeContext";
export const NATIVE_DISCOVERY = "backend.nativeDiscovery";
export const NATIVE_INSPECT = "backend.nativeInspect";
export const NATIVE_SESSION_INDEX_CHANGED = "backend.sessionIndexChanged";
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
