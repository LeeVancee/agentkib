import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { isReparseOrSymlink } from "./native-files";
import { messageText } from "./session-events";
import { jsonTimestamp } from "./session-history";
import {
  claudeActiveChain,
  compactJson,
  isClaudeEcho,
  looksLikeInternalContext,
  matchedFallbackOccurrences,
} from "./session-document-providers";
import { contentText, emitMessage, object, text } from "./history-search-source-records";
import type { HistorySourceSink } from "./history-search-source-types";

const MAX_BYTES = 256 * 1024 * 1024;
const MAX_LINE = 4 * 1024 * 1024;
const MAX_RECORDS = 100_000;
type Row = { line: number; offset: number; value: Record<string, unknown> };

/** A bounded line buffer, not UI pages: accepted records retain all text beyond 256 KiB. */
async function lines(
  file: string,
  sink: HistorySourceSink,
  consume: (row: Row) => Promise<void> | void,
): Promise<string> {
  const entry = lstatSync(file);
  if (!entry.isFile() || isReparseOrSymlink(file, entry)) throw new Error("history-source-unsafe");
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new Error("history-source-unsafe");
    const maximum = Number(before.size > BigInt(MAX_BYTES) ? BigInt(MAX_BYTES) : before.size);
    if (before.size > BigInt(MAX_BYTES)) sink.limit("source-byte-limit");
    const hash = createHash("sha256").update(
      `${before.dev}:${before.ino}:${before.size}:${before.mtimeNs}`,
    );
    const fragments: Buffer[] = [];
    let size = 0,
      offset = 0,
      line = 0,
      oversized = false;
    const finish = async () => {
      sink.checkpoint();
      line++;
      const start = offset;
      offset += size + 1;
      if (oversized) sink.limit("source-record-limit");
      else if (line > MAX_RECORDS) sink.limit("source-record-count-limit");
      else {
        const bytes = Buffer.concat(fragments, size);
        if (bytes.some((byte) => ![9, 10, 13, 32].includes(byte))) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
          } catch {
            sink.limit("damaged-record");
          }
          if (parsed !== undefined) {
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
              sink.limit("damaged-record");
            else await consume({ line, offset: start, value: parsed as Record<string, unknown> });
          }
        }
      }
      sink.checkpoint();
      fragments.length = 0;
      size = 0;
      oversized = false;
    };
    // This function alone owns fd. Async stream destruction could close it again after
    // finally has released it and another request has reused the descriptor number.
    let position = 0;
    while (position < maximum) {
      sink.checkpoint();
      // Keep each buffer immutable while fragments from its unfinished line are retained.
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximum - position));
      const length = readSync(fd, chunk, 0, chunk.length, position);
      if (length === 0) throw new Error("history-source-changed");
      position += length;
      const buffer = chunk.subarray(0, length);
      hash.update(buffer);
      let start = 0;
      while (start < buffer.length) {
        const newline = buffer.indexOf(10, start),
          end = newline < 0 ? buffer.length : newline;
        const part = buffer.subarray(start, end);
        size += part.length;
        if (size > MAX_LINE) {
          oversized = true;
          fragments.length = 0;
        }
        if (!oversized) fragments.push(part);
        if (newline < 0) break;
        await finish();
        start = newline + 1;
      }
    }
    if (size) {
      if (before.size > BigInt(MAX_BYTES)) sink.limit("source-record-limit");
      else await finish();
    }
    const after = fstatSync(fd, { bigint: true }),
      current = lstatSync(file, { bigint: true });
    if (
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      isReparseOrSymlink(file, current)
    )
      throw new Error("history-source-changed");
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

export async function readJsonlSearchSource(
  file: string,
  format: string,
  sink: HistorySourceSink,
): Promise<void> {
  const primary = new Map<string, number[]>();
  const fallback: Array<{ key: string; line: number; index: [number, number] }> = [];
  const context = new Map<string, Array<{ line: number; internal: boolean }>>();
  const parents: Array<{ line: number; value: Record<string, unknown> }> = [];
  const messageKey = (role: string, value: string) =>
    `${role}:${createHash("sha256").update(value.trim()).digest("hex")}`;
  let legacyBranch = false;
  const first = await lines(file, sink, ({ line, value }) => {
    if (format === "claude-code") {
      const { uuid, parentUuid, leafUuid, type, isSidechain } = value;
      parents.push({ line, value: { uuid, parentUuid, leafUuid, type, isSidechain } });
    }
    if (format === "open-claw" && ["reset", "leaf", "compaction"].includes(String(value.type)))
      legacyBranch = true;
    if (format !== "codex") return;
    const payload = object(value.payload);
    if (
      value.type === "event_msg" &&
      ["user_message", "agent_message"].includes(String(payload.type)) &&
      typeof payload.message === "string"
    ) {
      const key = messageKey(
        payload.type === "user_message" ? "user" : "assistant",
        payload.message,
      );
      const existing = primary.get(key) ?? [];
      existing.push(line);
      primary.set(key, existing);
    }
    if (
      value.type === "response_item" &&
      payload.type === "message" &&
      ["user", "assistant"].includes(String(payload.role))
    ) {
      const content = messageText(payload.content);
      if (content?.trim())
        fallback.push({ key: messageKey(String(payload.role), content), line, index: [line, 0] });
      const turn = object(payload.internal_chat_message_metadata_passthrough).turn_id;
      if (payload.role === "user" && typeof turn === "string") {
        const blocks = Array.isArray(payload.content) ? payload.content : [];
        const internal =
          blocks.length > 0 &&
          blocks.every((raw) => {
            const item = object(raw);
            return (
              ["text", "input_text"].includes(String(item.type)) &&
              typeof item.text === "string" &&
              looksLikeInternalContext(item.text)
            );
          });
        const rows = context.get(turn) ?? [];
        rows.push({ line, internal });
        context.set(turn, rows);
      }
    }
  });
  const excluded = new Set(
    [...context.values()].flatMap((items) =>
      items.some((item) => !item.internal)
        ? items.filter((item) => item.internal).map((item) => item.line)
        : [],
    ),
  );
  const mirrors = matchedFallbackOccurrences(
    primary,
    fallback.filter((item) => !excluded.has(item.line)),
  );
  const chain = format === "claude-code" ? claudeActiveChain(parents, false) : null;
  // Legacy branch controls lack SQLite's verified active projection. Do not index siblings as active history.
  if (legacyBranch) sink.limit("legacy-branch-history");
  const second = await lines(file, sink, async ({ line, offset, value }) => {
    sink.checkpoint();
    if (legacyBranch) return;
    const key = text(value.uuid) ?? text(value.id) ?? `byte:${offset}`;
    if (format === "codex") {
      const payload = object(value.payload),
        timestamp = jsonTimestamp(value.timestamp);
      if (
        value.type === "event_msg" &&
        ["user_message", "agent_message"].includes(String(payload.type))
      ) {
        if (typeof payload.message === "string")
          await sink.emit({
            recordId: `${key}:text`,
            kind: payload.type === "user_message" ? "user" : "assistant",
            content: payload.message,
            toolName: null,
            timestamp,
          });
        else sink.limit("damaged-record");
      } else if (value.type === "response_item") {
        if (payload.type === "message") {
          if (!excluded.has(line) && !mirrors.has(`${line}:0`)) {
            if (
              ["user", "assistant"].includes(String(payload.role)) &&
              payload.content == null &&
              payload.text == null &&
              payload.tool_calls == null
            )
              sink.limit("damaged-record");
            await emitMessage({ ...payload, timestamp: value.timestamp }, key, sink);
          }
        } else if (["function_call", "custom_tool_call"].includes(String(payload.type))) {
          const input = payload.arguments ?? payload.input;
          if (input === undefined || typeof payload.name !== "string") {
            sink.limit("unsupported-tool-input");
            return;
          }
          const id = text(payload.call_id) ?? key;
          await sink.emit({
            recordId: `call:${id}:input`,
            kind: "tool-input",
            content: compactJson(input),
            toolName: text(payload.name),
            timestamp,
          });
        } else if (
          ["function_call_output", "custom_tool_call_output"].includes(String(payload.type))
        ) {
          if (payload.output === undefined) {
            sink.limit("damaged-tool-output");
            return;
          }
          const id = text(payload.call_id) ?? key;
          await sink.emit({
            recordId: `call:${id}:output`,
            kind: "tool-output",
            content: contentText(payload.output, sink),
            toolName: null,
            timestamp,
          });
        } else if (!["reasoning", "compaction", "ghost_snapshot"].includes(String(payload.type))) {
          // Known reasoning/internal state stays excluded; unfamiliar history is an explicit omission.
          sink.limit(
            /(?:_call|_call_output)$/.test(String(payload.type))
              ? "unsupported-tool-record"
              : "unsupported-response-item",
          );
        }
      }
      return;
    }
    if (format === "claude-code") {
      if (
        value.isSidechain === true ||
        value.isCompactSummary === true ||
        (chain && (!text(value.uuid) || !chain.has(String(value.uuid))))
      )
        return;
      if (!["user", "assistant"].includes(String(value.type))) return;
      await emitMessage(value, key, sink, String(value.type), isClaudeEcho);
      return;
    }
    if (
      [
        "session",
        "init",
        "system",
        "internal",
        "reasoning",
        "thinking",
        "redacted_thinking",
        "session_info",
        "model_change",
        "thinking_level_change",
        "label",
        "custom",
      ].includes(String(value.type))
    )
      return;
    if (format === "grok-build" && value.type === "backend_tool_call") {
      sink.limit("unsupported-tool-record");
      return;
    }
    await emitMessage(
      value,
      key,
      sink,
      format === "grok-build" ? (text(value.type) ?? undefined) : undefined,
    );
  });
  if (first !== second) throw new Error("history-source-changed");
  sink.fingerprint(first);
}
