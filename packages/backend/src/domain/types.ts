export type WorkspaceStatus = "healthy" | "attention";
export type AgentKind =
  | "codex"
  | "claude-code"
  | "cursor"
  | "open-claw"
  | "hermes"
  | "deepseek-harness";
export type AssetKind =
  | "instruction"
  | "skill"
  | "configuration"
  | "memory"
  | "hook"
  | "agent"
  | "connection";
export type MemoryStatus = "pending" | "approved" | "rejected" | "invalidated";
export type MemoryType =
  | "user_preference"
  | "project_fact"
  | "decision"
  | "constraint"
  | "failed_attempt"
  | "open_loop"
  | "task_state"
  | "agent_observation";

export interface Workspace {
  id: string;
  canonical_path: string;
  name: string;
  repository_group_id?: string;
  manifest_workspace_id?: string;
  status: WorkspaceStatus;
  asset_count: number;
  warning_count: number;
  last_active_at?: string;
  last_discovered_at: string;
  last_scanned_at?: string;
}
export interface ExcludedWorkspace {
  canonical_path: string;
  created_at: string;
}
export interface Memory {
  id: string;
  project_id: string;
  memory_type: MemoryType;
  content: string;
  status: MemoryStatus;
  source_agent?: string;
  source_thread?: string;
  source_reference?: string;
  created_at: string;
  approved_at?: string;
  invalidated_by?: string;
}
export interface AddWorkspaceInput {
  path: string;
  name?: string;
  status?: WorkspaceStatus;
}
export interface ProposeMemoryInput {
  project_id: string;
  memory_type: MemoryType;
  content: string;
  source_agent?: string;
  source_thread?: string;
  source_reference?: string;
}
export interface AgentDetection {
  agent: AgentKind;
  detected: boolean;
  asset_count: number;
  warnings: string[];
}
export interface AssetRecord {
  agent: AgentKind;
  kind: AssetKind;
  path: string;
  exists: boolean;
  size: number;
  summary: string;
  summary_key?: string;
  summary_params?: Record<string, string>;
}
export interface WorkspaceScan {
  root: string;
  manifest_exists: boolean;
  agents: AgentDetection[];
  assets: AssetRecord[];
  warnings: string[];
}
export interface SkillDefinition {
  name: string;
  path: string;
  targets: AgentKind[];
}
export interface ConnectionDefinition {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env: Record<string, string>;
  allow_tools: string[];
  targets: AgentKind[];
}
export interface Manifest {
  schema_version: number;
  workspace: { id: string; name: string };
  instructions: {
    shared: string;
    scoped: Array<{ path: string; content: string }>;
    platform_overrides: Partial<Record<AgentKind, string>>;
  };
  skills: SkillDefinition[];
  mcp: { config: string };
  connections: ConnectionDefinition[];
  memories: { require_approval: boolean };
  adapters: Partial<
    Record<AgentKind, { enabled: boolean; generated_hashes: Record<string, string> }>
  >;
}
export type DiscoveryEvidence = "session-cwd" | "configured-workspace" | "scan-marker" | "manual";
export interface DiscoveryCandidate {
  path: string;
  source_agent?: AgentKind;
  evidence: DiscoveryEvidence;
  session_count: number;
  display_name?: string;
}
export interface DiscoverySnapshot {
  candidates: DiscoveryCandidate[];
  errors: string[];
}
