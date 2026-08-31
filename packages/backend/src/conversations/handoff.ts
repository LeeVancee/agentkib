import type {
  ConversationSessionSummary,
  HandoffContext,
  SessionHandoffPreparation,
  SessionHandoffRequest,
  SessionHandoffDraft,
} from "./types.js";
import { backendError } from "../contracts.js";
const MAX_MESSAGES = 200,
  MAX_BYTES = 512 * 1024;
export function sanitizeHandoffContent(
  input: string,
  home?: string,
): { content: string; redaction_count: number } {
  let redaction_count = 0;
  let content = input;
  const patterns = [
    /\b(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]+)\b/g,
    /(?i:password|token|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/g,
  ];
  for (const pattern of patterns)
    content = content.replace(pattern, () => {
      redaction_count++;
      return "[REDACTED]";
    });
  if (home && content.includes(home)) {
    content = content.split(home).join("[HOME]");
    redaction_count++;
  }
  return { content, redaction_count };
}
export function prepareHandoff(
  source: ConversationSessionSummary,
  request: SessionHandoffRequest,
  context: HandoffContext,
  home?: string,
): SessionHandoffPreparation {
  if (source.id !== request.session_id)
    throw backendError("VALIDATION", "Conversation session does not match the handoff request");
  if (source.availability !== "readable")
    throw backendError("NOT_FOUND", "Conversation transcript is not available");
  const sanitized = context.messages.map((message) => {
    const result = sanitizeHandoffContent(message.content ?? "", home);
    return { message, ...result };
  });
  const summary = context.compact_summary
    ? sanitizeHandoffContent(context.compact_summary, home)
    : undefined;
  if (!sanitized.length && !summary?.content)
    throw backendError("VALIDATION", "Conversation does not contain readable messages");
  const estimated_bytes = sanitized.reduce(
    (sum, value) => sum + Buffer.byteLength(value.content),
    Buffer.byteLength(summary?.content ?? ""),
  );
  if (sanitized.length > MAX_MESSAGES)
    return {
      status: "summary-required",
      source_agent: source.agent,
      message_count: sanitized.length,
      estimated_bytes,
      reason: "message-limit",
    };
  if (estimated_bytes > MAX_BYTES)
    return {
      status: "summary-required",
      source_agent: source.agent,
      message_count: sanitized.length,
      estimated_bytes,
      reason: "byte-limit",
    };
  const redaction_count = sanitized.reduce(
    (sum, value) => sum + value.redaction_count,
    summary?.redaction_count ?? 0,
  );
  const generated = new Date();
  const filename = `handoff-${source.agent}-${request.target_agent}-${generated.toISOString().replace(/[:.]/g, "-")}.${request.format === "json" ? "json" : "md"}`;
  const payload = {
    session_id: source.id,
    source_agent: source.agent,
    target_agent: request.target_agent,
    messages: sanitized.map((value) => ({ ...value.message, content: value.content })),
    compact_summary: summary?.content,
  };
  const content =
    request.format === "json"
      ? JSON.stringify(payload, null, 2)
      : `# Agent handoff\n\nSource: ${source.agent}\nTarget: ${request.target_agent}\n\n${summary?.content ? `## Summary\n\n${summary.content}\n\n` : ""}${payload.messages.map((message) => `### ${message.kind}\n\n${message.content ?? ""}`).join("\n\n")}`;
  if (Buffer.byteLength(content) > MAX_BYTES)
    return {
      status: "summary-required",
      source_agent: source.agent,
      message_count: sanitized.length,
      estimated_bytes: Buffer.byteLength(content),
      reason: "byte-limit",
    };
  const draft: SessionHandoffDraft = {
    filename,
    format: request.format,
    content,
    redaction_count,
    included_message_count: sanitized.length,
    omitted_tool_count: context.omitted_tool_count,
    context_source: context.compact_summary ? "native-compaction" : "full-transcript",
    warnings: context.warnings,
  };
  return { status: "ready", draft };
}
