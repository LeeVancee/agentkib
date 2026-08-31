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
  const ordered: Array<{ line: number; event: ConversationEvent }> = [];
  const primaryMessages = new Set<string>();
  const fallbackMessages: Array<{ line: number; event: ConversationEvent }> = [];
  const tools = new Map<string, { line: number; event: ConversationEvent }>();
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (Buffer.byteLength(line) > 4 * 1024 * 1024) {
      warnings.push(`oversized transcript line ${index + 1}`);
      continue;
    }
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (agent === "codex") {
        const parsed = parseCodexEvent(
          value,
          index,
          ordered,
          fallbackMessages,
          primaryMessages,
          tools,
        );
        if (!parsed) {
          const legacyRole = typeof value.role === "string" ? value.role : "";
          const legacyContent =
            typeof value.content === "string"
              ? value.content
              : typeof value.message === "string"
                ? value.message
                : undefined;
          if (legacyContent)
            ordered.push({
              line: index,
              event: messageEvent(
                String(value.id ?? index),
                legacyRole.includes("user")
                  ? "user-message"
                  : legacyRole.includes("tool")
                    ? "tool-summary"
                    : "agent-message",
                typeof value.timestamp === "string" ? value.timestamp : undefined,
                legacyContent ?? "",
                0,
              ),
            });
        }
        continue;
      }
      const parsed = parseClaudeEvent(value, index);
      const legacyRole =
        typeof value.role === "string"
          ? value.role
          : typeof value.type === "string"
            ? value.type
            : "";
      const legacyContent =
        typeof value.content === "string"
          ? value.content
          : typeof value.message === "string"
            ? value.message
            : undefined;
      const compatible =
        parsed ??
        (legacyContent || legacyRole
          ? messageEvent(
              String(value.id ?? index),
              legacyRole.includes("user")
                ? "user-message"
                : legacyRole.includes("tool")
                  ? "tool-summary"
                  : "agent-message",
              typeof value.timestamp === "string" ? value.timestamp : undefined,
              legacyContent ?? "",
              0,
            )
          : undefined);
      if (compatible) ordered.push({ line: index, event: compatible });
    } catch {
      warnings.push(`damaged transcript line ${index + 1}`);
    }
  }
  for (const value of fallbackMessages) {
    const content = value.event.content?.trim() ?? "";
    const key = `${value.event.kind}:${content}`;
    if (content && !primaryMessages.has(key)) ordered.push(value);
  }
  for (const tool of tools.values()) ordered.push(tool);
  ordered.sort((a, b) => a.line - b.line);
  events.push(...ordered.map((value) => value.event));
  const boundary = Math.min(events.length, cursor ?? events.length);
  const start = Math.max(0, boundary - Math.min(500, Math.max(1, limit)));
  return {
    events: events.slice(start, boundary),
    next_cursor: start > 0 ? String(start) : undefined,
    warnings,
  };
}

function parseCodexEvent(
  value: Record<string, unknown>,
  index: number,
  output: Array<{ line: number; event: ConversationEvent }>,
  fallback: Array<{ line: number; event: ConversationEvent }>,
  primaryMessages: Set<string>,
  tools: Map<string, { line: number; event: ConversationEvent }>,
): boolean {
  const payload = asRecord(value.payload);
  const type = typeof value.type === "string" ? value.type : "";
  const payloadType = typeof payload?.type === "string" ? payload.type : "";
  const timestamp = typeof value.timestamp === "string" ? value.timestamp : undefined;
  if (
    type === "event_msg" &&
    payloadType === "user_message" &&
    typeof payload?.message === "string"
  ) {
    const event = messageEvent(
      String(value.id ?? index),
      "user-message",
      timestamp,
      payload.message,
      countAttachments(payload),
    );
    primaryMessages.add(messageKey(event.kind, event.content ?? ""));
    output.push({ line: index, event });
    return true;
  }
  if (
    type === "event_msg" &&
    payloadType === "agent_message" &&
    typeof payload?.message === "string"
  ) {
    const event = messageEvent(
      String(value.id ?? index),
      "agent-message",
      timestamp,
      payload.message,
      0,
    );
    primaryMessages.add(messageKey(event.kind, event.content ?? ""));
    output.push({ line: index, event });
    return true;
  }
  if (
    type === "response_item" &&
    payloadType === "message" &&
    (payload?.role === "user" || payload?.role === "assistant")
  ) {
    const content = contentText(payload.content);
    if (content)
      fallback.push({
        line: index,
        event: messageEvent(
          String(value.id ?? index),
          payload.role === "user" ? "user-message" : "agent-message",
          timestamp,
          content,
          0,
        ),
      });
    return true;
  }
  if (
    type === "response_item" &&
    ["function_call", "custom_tool_call", "web_search_call"].includes(payloadType)
  ) {
    const key =
      typeof payload?.call_id === "string" && payload.call_id
        ? payload.call_id
        : `${payloadType}:${index}`;
    upsertTool(
      tools,
      key,
      index,
      String(value.id ?? index),
      timestamp,
      typeof payload?.name === "string" ? payload.name : payloadType,
      typeof payload?.status === "string" ? payload.status : undefined,
    );
    return true;
  }
  if (
    type === "response_item" &&
    ["function_call_output", "custom_tool_call_output"].includes(payloadType)
  ) {
    const key = typeof payload?.call_id === "string" ? payload.call_id : "";
    const tool = tools.get(key);
    if (tool) tool.event.tool_status = "completed";
    return true;
  }
  if (type === "event_msg" && ["exec_command_end", "patch_apply_end"].includes(payloadType)) {
    const key =
      typeof payload?.call_id === "string" && payload.call_id
        ? payload.call_id
        : `${payloadType}:${index}`;
    upsertTool(
      tools,
      key,
      index,
      String(value.id ?? index),
      timestamp,
      payloadType === "patch_apply_end" ? "apply_patch" : "shell",
      typeof payload?.status === "string"
        ? payload.status
        : typeof payload?.success === "boolean"
          ? payload.success
            ? "completed"
            : "failed"
          : undefined,
      typeof payload?.duration === "number" ? Math.max(0, payload.duration * 1000) : undefined,
    );
    return true;
  }
  return false;
}

function messageKey(kind: ConversationEvent["kind"], content: string): string {
  return `${kind}:${content.trim()}`;
}

function upsertTool(
  tools: Map<string, { line: number; event: ConversationEvent }>,
  key: string,
  line: number,
  id: string,
  timestamp: string | undefined,
  name: string,
  status: string | undefined,
  duration_ms?: number,
): void {
  const existing = tools.get(key);
  if (existing) {
    if (status) existing.event.tool_status = status;
    if (duration_ms !== undefined) existing.event.duration_ms = duration_ms;
    return;
  }
  tools.set(key, {
    line,
    event: toolEvent(id, timestamp, name, status, duration_ms),
  });
}

function parseClaudeEvent(
  value: Record<string, unknown>,
  index: number,
): ConversationEvent | undefined {
  const type = typeof value.type === "string" ? value.type : "";
  if (type !== "user" && type !== "assistant") return undefined;
  const message = asRecord(value.message);
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const content = contentText(message?.content ?? value.content);
  const timestamp = typeof value.timestamp === "string" ? value.timestamp : undefined;
  const tool = blocks.find((block) => asRecord(block)?.type === "tool_use") as
    | Record<string, unknown>
    | undefined;
  if (tool)
    return toolEvent(
      String(value.id ?? index),
      timestamp,
      typeof tool.name === "string" ? tool.name : "tool",
      "started",
    );
  const toolResult = blocks.some((block) => asRecord(block)?.type === "tool_result");
  if (toolResult) return toolEvent(String(value.id ?? index), timestamp, "tool", "completed");
  if (!content) return undefined;
  return messageEvent(
    String(value.id ?? index),
    type === "user" ? "user-message" : "agent-message",
    timestamp,
    content,
    0,
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function contentText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const text = value
    .flatMap((item) => {
      const block = asRecord(item);
      if (!block) return [];
      if (typeof block.text === "string") return [block.text];
      if (typeof block.content === "string") return [block.content];
      return [];
    })
    .join("\n")
    .trim();
  return text || undefined;
}
function countAttachments(value: Record<string, unknown>): number {
  return Array.isArray(value.images) ? value.images.length : 0;
}
function messageEvent(
  id: string,
  kind: ConversationEvent["kind"],
  timestamp: string | undefined,
  content: string,
  attachment_count: number,
): ConversationEvent {
  return { id, kind, timestamp, content, attachment_count, truncated: false };
}
function toolEvent(
  id: string,
  timestamp: string | undefined,
  tool_name: string,
  tool_status: string | undefined,
  duration_ms?: number,
): ConversationEvent {
  return {
    id,
    kind: "tool-summary",
    timestamp,
    tool_name,
    tool_status,
    duration_ms,
    attachment_count: 0,
    truncated: false,
  };
}
