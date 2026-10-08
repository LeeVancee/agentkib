import type { HistoryRecordKind } from "@agentkib/runtime-protocol";
import { jsonTimestamp } from "./session-history";
import { compactJson } from "./session-document-providers";
import { HistorySourceSnapshotError, type HistorySourceSink } from "./history-search-source-types";

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
/** A failed whole snapshot has no safe replacement, unlike a missing individual record. */
export async function readSourceSnapshot<T>(
  sink: HistorySourceSink,
  read: () => T | Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    sink.checkpoint();
    const message = error instanceof Error ? error.message : "";
    const bounded =
      /^(?:OpenCode export|Antigravity ACP (?:replay|parsed tool)|Cursor (?:IDE )?(?:blob|graph|root)|OpenClaw history).*exceeds\b/.test(
        message,
      ) ||
      /^Cursor protobuf field limit exceeded$/.test(message) ||
      / output exceeds the \d+-byte limit$/.test(message);
    if (!bounded && !(error instanceof SyntaxError)) throw error;
    throw new HistorySourceSnapshotError(bounded ? "source-byte-limit" : "damaged-record");
  }
}
const excluded = new Set([
  "image",
  "image_url",
  "input_image",
  "document",
  "file",
  "input_file",
  "image_link",
  "audio",
  "input_audio",
  "video",
  "resource",
  "resource_link",
  "thinking",
  "reasoning",
  "redacted_thinking",
]);

/** Only explicit text blocks are read from rich content; attachment payloads are never decoded. */
export function contentText(value: unknown, sink: HistorySourceSink): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (!Array.isArray(value)) {
    const part = object(value);
    if (excluded.has(String(part.type))) return "";
    if (["text", "input_text", "output_text"].includes(String(part.type))) {
      if (typeof part.text === "string") return part.text;
      sink.limit("damaged-tool-output");
      return "";
    }
    return compactJson(value);
  }
  return value
    .flatMap((item) => {
      const part = object(item);
      if (["text", "input_text", "output_text"].includes(String(part.type))) {
        if (typeof part.text === "string") return [part.text];
        sink.limit("damaged-tool-output");
        return [];
      }
      if (excluded.has(String(part.type))) return [];
      sink.limit("unsupported-content-block");
      return [];
    })
    .join("\n");
}

export async function emitMessage(
  value: Record<string, unknown>,
  key: string,
  sink: HistorySourceSink,
  fallbackRole?: string,
  excludeText?: (value: string) => boolean,
): Promise<void> {
  const message =
    value.message !== null && typeof value.message === "object" ? object(value.message) : value;
  const role = text(message.role) ?? text(message.speaker) ?? fallbackRole;
  if (["reasoning", "thinking", "system", "internal", "session_meta"].includes(role ?? "")) return;
  if (!["user", "assistant", "tool", "tool_result", "toolResult"].includes(role ?? "")) {
    sink.limit("unsupported-message-role");
    return;
  }
  if (
    message.active === false ||
    message.active === 0 ||
    value.active === false ||
    value.active === 0
  )
    return;
  if (
    [message, value].some(
      (row) =>
        row.compacted === true ||
        row.compacted === 1 ||
        row._compressed_summary === true ||
        row._compressed_summary === 1,
    )
  ) {
    sink.limit("compacted-history");
    return;
  }
  const timestamp = jsonTimestamp(value.timestamp ?? message.timestamp ?? message.created_at);
  const emit = async (
    recordId: string,
    kind: HistoryRecordKind,
    content: string,
    toolName: string | null = null,
  ) => {
    if (!content.trim()) return;
    await sink.emit({ recordId, kind, content, toolName, timestamp });
  };
  const call = async (raw: unknown, index: number) => {
    const item = object(raw),
      fn = item.function == null ? item : object(item.function);
    const id = text(item.id) ?? text(item.call_id) ?? `${key}:${index}`;
    const input = fn.arguments ?? fn.input;
    if (input === undefined || typeof fn.name !== "string") {
      sink.limit("unsupported-tool-input");
      return;
    }
    await emit(`call:${id}:input`, "tool-input", compactJson(input), fn.name);
  };
  const content = message.content ?? message.text;
  // Assistant messages can contain only tool calls or excluded reasoning/attachments.
  // An absent body without those structures must not certify complete text coverage.
  if (
    ["user", "assistant"].includes(role!) &&
    content == null &&
    !(
      role === "assistant" &&
      ((Array.isArray(message.tool_calls) && message.tool_calls.length > 0) ||
        (Array.isArray(message.images) && message.images.length > 0) ||
        ["reasoning", "reasoning_content", "reasoning_details", "codex_reasoning_items"].some(
          (name) => message[name] != null,
        ))
    )
  )
    sink.limit("damaged-record");
  if (["tool", "tool_result", "toolResult"].includes(role!)) {
    const id = text(message.tool_call_id) ?? text(message.toolCallId) ?? key;
    await emit(
      `call:${id}:output`,
      "tool-output",
      contentText(content, sink),
      text(message.tool_name) ?? text(message.toolName) ?? text(message.name),
    );
  } else if (typeof content === "string") {
    if (!excludeText?.(content)) await emit(`${key}:text`, role as "user" | "assistant", content);
  } else if (Array.isArray(content)) {
    for (const [index, raw] of content.entries()) {
      const part = object(raw),
        kind = String(part.type);
      if (["text", "input_text", "output_text"].includes(kind)) {
        if (typeof part.text === "string") {
          // Rich-text exclusions are provider-specific; other agents can store these tags literally.
          if (!excludeText?.(part.text))
            await emit(`${key}:text:${index}`, role as "user" | "assistant", part.text);
        } else sink.limit("damaged-text-block");
      } else if (["toolCall", "tool_use", "toolUse"].includes(kind)) await call(part, index);
      else if (["tool_result", "toolResult"].includes(kind)) {
        const id =
          text(part.tool_use_id) ??
          text(part.toolCallId) ??
          text(part.tool_call_id) ??
          `${key}:${index}`;
        await emit(
          `call:${id}:output`,
          "tool-output",
          contentText(part.content ?? part.output, sink),
          text(part.name),
        );
      } else if (!excluded.has(kind)) sink.limit("unsupported-content-block");
    }
  } else if (content != null) sink.limit("unsupported-message-content");
  if (Array.isArray(message.tool_calls))
    for (const [index, item] of message.tool_calls.entries()) await call(item, index);
  else if (message.tool_calls != null) sink.limit("unsupported-tool-input");
}
