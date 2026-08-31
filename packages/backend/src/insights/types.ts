import type { AgentKind } from "../domain/types.js";
export type UsageQuality = "exact" | "estimated" | "incomplete";
export type DatePrecision = "exact" | "day" | "aggregate";
export interface UsageCapabilities {
  token_breakdown: boolean;
  daily_activity: boolean;
  workspace_mapping: boolean;
}
export interface GitIdentityCandidate {
  email: string;
  label: string;
  source: string;
}
export interface GitCommitRecord {
  hash: string;
  authored_at: string;
  author_email: string;
}
export interface GitRepositorySnapshot {
  repository_group_id: string;
  path: string;
  fingerprint: string;
  changed: boolean;
  commits: GitCommitRecord[];
  identities: GitIdentityCandidate[];
  error?: string;
}
export interface InsightsQuery {
  from?: string;
  to?: string;
  agent?: AgentKind;
  workspace_id?: string;
  repository_group_id?: string;
}
export interface InsightsSummary {
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_tokens: number;
  reasoning_tokens: number;
  session_count: number;
  my_commits: number;
  all_commits: number;
  attributed_commits: number;
  active_days: number;
  current_streak: number;
  longest_streak: number;
  quality: UsageQuality;
  coverage_from?: string;
  coverage_to?: string;
  refreshed_at?: string;
}
export interface HeatmapPoint {
  date: string;
  tokens: number;
  my_commits: number;
  all_commits: number;
  attributed_commits: number;
  sessions: number;
  quality: UsageQuality;
}
