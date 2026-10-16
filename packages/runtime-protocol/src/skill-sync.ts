/** Stable Skill synchronization contract shared by the backend and desktop. */
export type SkillSyncOperation = "adopt" | "pull" | "push" | "fork" | "detach" | "restore" | "bind";
export type SkillSyncResolution = "library" | "deployment";
export type SkillSyncComparison = "candidate" | "base-library" | "base-target";
export interface PrepareSkillSyncRequest {
  operation: SkillSyncOperation;
  deployment_id?: string;
  observation_id?: string;
  library_id?: string;
  resolution?: SkillSyncResolution;
}

export interface SkillSyncDeploymentPolicy {
  mode: "manual" | "follow" | "pinned";
  approve_home: boolean;
  owner_key: string;
  target_key: string;
}
export interface SkillSyncLibraryPolicy {
  mode: "manual" | "check" | "auto_update";
  owner_key?: string;
  source_key?: string;
}
export interface SkillSyncPolicy {
  schema_version: 1;
  revision: number;
  enabled: boolean;
  interval_hours: number;
  default_mode: "check" | "manual";
  libraries: Record<string, SkillSyncLibraryPolicy>;
  deployments: Record<string, SkillSyncDeploymentPolicy>;
  updated_at: string | null;
}
export interface SaveSkillSyncPolicyRequest {
  policy: SkillSyncPolicy;
  revision: number;
  approve_home?: boolean;
}

export interface SkillSyncTargetPreview {
  base_library?: { added: string[]; modified: string[]; removed: string[] };
  base_target?: { added: string[]; modified: string[]; removed: string[] };
  deployment_id?: string | null;
  target_id?: string;
  path: string;
  base_hash: string | null;
  library_hash: string | null;
  target_hash: string | null;
  state: string;
  added: string[];
  modified: string[];
  removed: string[];
  conflicts: string[];
}
export interface SkillSyncPreview {
  token: string;
  operation: SkillSyncOperation;
  requires_home_approval: boolean;
  library_id: string | null;
  targets: SkillSyncTargetPreview[];
  expires_at: string;
}
export interface SkillSyncResult {
  success: boolean;
  status: string;
  error?: string | null;
  library_id?: string | null;
  deployment_id?: string | null;
  path?: string;
}
export interface SkillSyncReport {
  operation_id: string;
  results: SkillSyncResult[];
  warnings: string[];
}
export interface SkillSyncRun extends SkillSyncReport {
  started_at: string;
  finished_at: string | null;
  trigger: "manual" | "automatic" | "recovery";
}
export interface SkillSyncRuns {
  runs: SkillSyncRun[];
}
export interface SkillSyncCoordinatorState {
  state: "idle" | "running" | "succeeded" | "failed";
  checked_at?: string;
  error?: string;
}

export type SkillSynchronizationState =
  | "current"
  | "outgoing"
  | "incoming"
  | "converged"
  | "conflict"
  | "missing"
  | "blocked"
  | "unverified";
export interface SkillSyncLibraryState {
  can_auto_update: boolean;
  library_id: string;
  display_name: string;
  hash: string | null;
  observed_hash: string | null;
  upstream_base_hash: string | null;
  locally_customized: boolean;
  owner_key: string;
  source_key: string;
  valid: boolean;
  diagnostics: string[];
  policy: SkillSyncLibraryPolicy | null;
}
export interface SkillSyncDeploymentState {
  lifecycle_status?: "active" | "inactive";
  origin?: "agentkib" | "adopted" | "legacy-unknown";
  adopted_at?: string;
  adoption_operation_id?: string;
  id: string;
  library_id: string;
  package_name: string;
  display_name?: string;
  target: string;
  scope: "personal" | "workspace";
  status: string;
  base_hash: string | null;
  library_hash: string | null;
  target_hash: string | null;
  sync_state: SkillSynchronizationState;
  owner_key: string;
  target_key: string;
  baseline_available: boolean;
  diagnostics: string[];
  policy: SkillSyncDeploymentPolicy | null;
}
export interface SkillSyncObservation {
  id: string;
  name: string;
  path: string;
  scope: "personal" | "workspace";
  owner: string;
  can_adopt: boolean;
  target_id?: string;
}
export interface SkillSyncState {
  library: SkillSyncLibraryState[];
  deployments: SkillSyncDeploymentState[];
  observations: SkillSyncObservation[];
  warnings: string[];
}
