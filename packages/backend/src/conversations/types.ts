import type { AgentKind } from "../domain/types.js";
export type { AgentKind } from "../domain/types.js";
export type SessionAvailability = "readable" | "metadata-only";
export type SessionIndexFreshness = "fresh" | "stale" | "unavailable";
export type ConversationEventKind = "user-message" | "agent-message" | "tool-summary";
export interface ConversationSessionSummary {
  id: string;
  workspace_id: string;
  agent: AgentKind;
  title?: string;
  created_at?: string;
  updated_at?: string;
  message_count?: number;
  git_branch?: string;
  archived: boolean;
  sidechain: boolean;
  availability: SessionAvailability;
  native_ref?: string;
}
export interface ConversationEvent {
  id: string;
  kind: ConversationEventKind;
  timestamp?: string;
  content?: string;
  tool_name?: string;
  tool_status?: string;
  duration_ms?: number;
  attachment_count: number;
  truncated: boolean;
}
export interface ConversationEventPage {
  events: ConversationEvent[];
  next_cursor?: string;
  warnings: string[];
}
export interface ConversationIndexStatus {
  workspace_id: string;
  agent: AgentKind;
  freshness: SessionIndexFreshness;
  session_count: number;
  last_attempt_at?: string;
  last_success_at?: string;
  error_key?: string;
  error_detail?: string;
}
export type HandoffFormat = "markdown" | "json";
export interface SessionHandoffRequest {
  session_id: string;
  target_agent: AgentKind;
  format: HandoffFormat;
}
export interface HandoffContext {
  compact_summary?: string;
  messages: ConversationEvent[];
  omitted_tool_count: number;
  warnings: string[];
}
export interface SessionHandoffDraft {
  filename: string;
  format: HandoffFormat;
  content: string;
  redaction_count: number;
  included_message_count: number;
  omitted_tool_count: number;
  context_source: "native-compaction" | "full-transcript";
  warnings: string[];
}
export type SessionHandoffPreparation =
  | { status: "ready"; draft: SessionHandoffDraft }
  | {
      status: "summary-required";
      source_agent: AgentKind;
      message_count: number;
      estimated_bytes: number;
      reason: "message-limit" | "byte-limit";
    };
