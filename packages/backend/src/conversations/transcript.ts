import { lstat, readFile } from "node:fs/promises";
import { backendError } from "../contracts.js";
import type { AgentKind, ConversationEvent, ConversationEventPage } from "./types.js";
const MAX = 256 * 1024 * 1024;
export async function parseTranscript(
  file: string,
  agent: AgentKind,
  cursor: number | undefined = undefined,
  limit = 300,
): Promise<ConversationEventPage> {
  let metadata;
  try {
    metadata = await lstat(file);
  } catch (error) {
    throw backendError(
      (error as NodeJS.ErrnoException).code === "EACCES" ? "PERMISSION" : "NOT_FOUND",
      "Conversation transcript is not available",
    );
  }
  if (!metadata.isFile())
    throw backendError("VALIDATION", "Conversation transcript must be a regular file");
  if (metadata.size > MAX)
    throw backendError("VALIDATION", "Conversation transcript exceeds the 256 MiB read limit");
  const lines = (await readFile(file, "utf8")).split(/\r?\n/).filter(Boolean),
    events: ConversationEvent[] = [],
    warnings: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (Buffer.byteLength(line) > 4 * 1024 * 1024) {
      warnings.push(`oversized transcript line ${index + 1}`);
      continue;
    }
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      const parsed = agent === "codex" ? parseCodexEvent(value, index) : parseClaudeEvent(value, index);
      const legacyRole = typeof value.role === "string" ? value.role : typeof value.type === "string" ? value.type : "";
      const legacyContent = typeof value.content === "string" ? value.content : typeof value.message === "string" ? value.message : undefined;
      const compatible = parsed ?? (legacyContent || legacyRole ? messageEvent(String(value.id ?? index), legacyRole.includes("user") ? "user-message" : legacyRole.includes("tool") ? "tool-summary" : "agent-message", typeof value.timestamp === "string" ? value.timestamp : undefined, legacyContent ?? "", 0) : undefined);
      if (compatible) events.push(compatible);
    } catch {
      warnings.push(`damaged transcript line ${index + 1}`);
    }
  }
  const boundary = Math.min(events.length, cursor ?? events.length);
  const start = Math.max(0, boundary - Math.min(500, Math.max(1, limit)));
  return {
    events: events.slice(start, boundary),
    next_cursor: start > 0 ? String(start) : undefined,
    warnings,
  };
}

function parseCodexEvent(value: Record<string, unknown>, index: number): ConversationEvent | undefined {
  const payload = asRecord(value.payload);
  const type = typeof value.type === "string" ? value.type : "";
  const payloadType = typeof payload?.type === "string" ? payload.type : "";
  const timestamp = typeof value.timestamp === "string" ? value.timestamp : undefined;
  if (type === "event_msg" && payloadType === "user_message" && typeof payload?.message === "string")
    return messageEvent(String(value.id ?? index), "user-message", timestamp, payload.message, countAttachments(payload));
  if (type === "event_msg" && payloadType === "agent_message" && typeof payload?.message === "string")
    return messageEvent(String(value.id ?? index), "agent-message", timestamp, payload.message, 0);
  if (type === "response_item" && payloadType === "message" && (payload?.role === "user" || payload?.role === "assistant")) {
    const content = contentText(payload.content);
    if (content) return messageEvent(String(value.id ?? index), payload.role === "user" ? "user-message" : "agent-message", timestamp, content, 0);
  }
  if (type === "response_item" && ["function_call", "custom_tool_call", "web_search_call"].includes(payloadType))
    return toolEvent(String(value.id ?? index), timestamp, typeof payload?.name === "string" ? payload.name : payloadType, typeof payload?.status === "string" ? payload.status : undefined);
  if (type === "event_msg" && ["exec_command_end", "patch_apply_end"].includes(payloadType))
    return toolEvent(String(value.id ?? index), timestamp, payloadType === "patch_apply_end" ? "apply_patch" : "shell", typeof payload?.status === "string" ? payload.status : undefined);
  return undefined;
}

function parseClaudeEvent(value: Record<string, unknown>, index: number): ConversationEvent | undefined {
  const type = typeof value.type === "string" ? value.type : "";
  if (type !== "user" && type !== "assistant") return undefined;
  const message = asRecord(value.message);
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const content = contentText(message?.content ?? value.content);
  const timestamp = typeof value.timestamp === "string" ? value.timestamp : undefined;
  const tool = blocks.find((block) => asRecord(block)?.type === "tool_use") as Record<string, unknown> | undefined;
  if (tool) return toolEvent(String(value.id ?? index), timestamp, typeof tool.name === "string" ? tool.name : "tool", "started");
  const toolResult = blocks.some((block) => asRecord(block)?.type === "tool_result");
  if (toolResult) return toolEvent(String(value.id ?? index), timestamp, "tool", "completed");
  if (!content) return undefined;
  return messageEvent(String(value.id ?? index), type === "user" ? "user-message" : "agent-message", timestamp, content, 0);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function contentText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const text = value.flatMap((item) => {
    const block = asRecord(item);
    if (!block) return [];
    if (typeof block.text === "string") return [block.text];
    if (typeof block.content === "string") return [block.content];
    return [];
  }).join("\n").trim();
  return text || undefined;
}
function countAttachments(value: Record<string, unknown>): number {
  return Array.isArray(value.images) ? value.images.length : 0;
}
function messageEvent(id: string, kind: ConversationEvent["kind"], timestamp: string | undefined, content: string, attachment_count: number): ConversationEvent {
  return { id, kind, timestamp, content, attachment_count, truncated: false };
}
function toolEvent(id: string, timestamp: string | undefined, tool_name: string, tool_status: string | undefined): ConversationEvent {
  return { id, kind: "tool-summary", timestamp, tool_name, tool_status, attachment_count: 0, truncated: false };
}
