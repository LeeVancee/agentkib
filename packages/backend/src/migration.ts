import { RUNTIME_METHODS } from "@agentkib/runtime-protocol";

export const BACKEND_INITIALIZE = "backend.initialize";
export const BACKEND_PREFERENCES = "backend.preferences";
export const TYPESCRIPT_READ_METHODS = new Set<string>([
  RUNTIME_METHODS.listWorkspaces,
  RUNTIME_METHODS.listActivity,
  RUNTIME_METHODS.listScanRoots,
  RUNTIME_METHODS.listExcludedWorkspaces,
]);
export const TYPESCRIPT_PREFERENCE_METHODS = new Set<string>([
  RUNTIME_METHODS.setCloseBehavior,
  RUNTIME_METHODS.setLocale,
  RUNTIME_METHODS.setThemePreference,
  RUNTIME_METHODS.setAccentThemePreference,
  RUNTIME_METHODS.setSidebarWidthPreference,
  RUNTIME_METHODS.setAppIconPreference,
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
