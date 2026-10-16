import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { sessionDocument, type DocumentOptions, type SessionDocument } from "./session-model";
import { sanitizeSessionText } from "./session-handoff";
import { jsonTimestamp } from "./session-history";
import { messageText, type ConversationEventPage } from "./session-events";
import type { SessionAgent } from "./session-readers";
import { isReparseOrSymlink } from "./native-files";
import { stringifyAcpJson } from "./acp-json";

const MAX_TRANSCRIPT_BYTES = 256 * 1024 * 1024;
const MAX_LINE_BYTES = 4 * 1024 * 1024;
type RecordLine = { line: number; value: Record<string, any> };
type LossCode = SessionDocument["losses"][number]["code"];
type Turn = SessionDocument["turns"][number];
export interface DocumentSource {
  workspace_id: string;
  agent: SessionAgent;
  title: string | null;
  created_at: string | null;
  updated_at: string | null;
  git_branch: string | null;
}

/** Build an importable text document from providers whose public event reader is authoritative. */
export async function readEventDocument(
  source: DocumentSource,
  readPage: (cursor: string | null, limit: number) => Promise<ConversationEventPage>,
): Promise<SessionDocument> {
  const pages: SessionDocument["turns"][] = [];
  const losses = new Map<LossCode, number>();
  const warnings = new Set<string>();
  let cursor: string | null = null;
  for (let pageNumber = 0; pageNumber < 1000; pageNumber++) {
    const page = await readPage(cursor, 100);
    const turns: SessionDocument["turns"] = [];
    for (const warning of page.warnings) warnings.add(warning);
    for (const event of page.events) {
      const blocks: SessionDocument["turns"][number]["blocks"] = [];
      if (event.kind === "tool-summary") {
        const callId = `event-tool-${event.id}`;
        if (event.tool_status === "running") {
          blocks.push({
            type: "tool-call",
            call_id: callId,
            name: event.tool_name ?? "tool",
            input: "",
          });
        } else {
          blocks.push({
            type: "tool-result",
            call_id: callId,
            output: event.content ?? "",
            is_error: event.tool_status === "failed",
          });
        }
      } else if (event.content !== null) {
        blocks.push({ type: "text", text: event.content });
      }
      for (let index = 0; index < event.attachment_count; index++)
        blocks.push({ type: "attachment", kind: "image", media_type: "application/octet-stream" });
      if (blocks.length)
        turns.push({
          id: event.id,
          role: event.kind === "user-message" ? "user" : "assistant",
          timestamp: event.timestamp,
          blocks,
        });
      if (event.truncated) loss(losses, "source-content-truncated");
    }
    pages.push(turns);
    if (page.next_cursor === null) break;
    if (pageNumber === 999) throw new Error("Conversation exceeds the native import page limit");
    if (page.next_cursor === cursor) throw new Error("Conversation event cursor did not advance");
    cursor = page.next_cursor;
  }
  for (const warning of warnings) {
    if (warning === "TRANSCRIPT_DAMAGED_LINES") loss(losses, "damaged-record");
    else if (warning === "TRANSCRIPT_OVERSIZED_LINES") loss(losses, "source-content-truncated");
    else if (warning === "TRANSCRIPT_SCAN_BUDGET")
      throw new Error("Conversation exceeds the native import scan limit");
  }
  return finishDocument(source, pages.reverse().flat(), losses);
}

function records(file: string): { rows: RecordLine[]; damaged: number; truncated: number } {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || isReparseOrSymlink(file, metadata))
    throw new Error("Unsafe history source");
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > MAX_TRANSCRIPT_BYTES)
      throw new Error("Transcript exceeds the 256 MiB read limit");
    const bytes = readFileSync(fd);
    if (bytes.length > MAX_TRANSCRIPT_BYTES)
      throw new Error("Transcript exceeds the 256 MiB read limit");
    const rows: RecordLine[] = [];
    let damaged = 0;
    let truncated = 0;
    let start = 0;
    let line = 0;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const parseLine = (end: number, hasNewline: boolean) => {
      line++;
      const record = bytes.subarray(start, end);
      if (record.length + Number(hasNewline) > MAX_LINE_BYTES) {
        truncated++;
        return;
      }
      try {
        const value: unknown = JSON.parse(decoder.decode(record));
        if (value !== null && typeof value === "object" && !Array.isArray(value))
          rows.push({ line, value: value as Record<string, any> });
        else damaged++;
      } catch {
        damaged++;
      }
    };
    for (let index = 0; index < bytes.length; index++) {
      if (bytes[index] !== 10) continue;
      parseLine(index, true);
      start = index + 1;
    }
    if (start < bytes.length) parseLine(bytes.length, false);
    return { rows, damaged, truncated };
  } finally {
    closeSync(fd);
  }
}

function get(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function compactJson(value: unknown): string {
  if (typeof value === "string") return value;
  return stringifyAcpJson(value);
}

function loss(losses: Map<LossCode, number>, code: LossCode, count = 1): void {
  if (count > 0) losses.set(code, (losses.get(code) ?? 0) + count);
}

/** Records reachable from one root through `parentUuid`; the root may be a compaction boundary. */
export interface LineageSegment {
  /** Always disjoint from every other segment of the same lineage. */
  uuids: Set<string>;
  /** The occurrences whose parent pointers built this segment, not every row sharing a uuid. */
  lines: Set<number>;
  /** The `compact_boundary` record at the root of this segment, or null at the start of the file. */
  boundary: RecordLine | null;
}
export interface Lineage {
  /** Oldest first; the last one is the segment the leaf belongs to. */
  segments: LineageSegment[];
  /** Earlier history is missing or its traversal limit was reached, so the lineage is incomplete. */
  unlinked: boolean;
}
const MAX_LINEAGE_SEGMENTS = 1024;
// Repeatedly retained chains can otherwise cost records × compactions, even in a small file.
const MAX_HISTORICAL_LINEAGE_VISITS = 250_000;
interface LineageBudget {
  remaining: number;
  exhausted: boolean;
}

/** The last record index strictly before this line in an ordered snapshot. */
function lastIndexBefore(versions: RecordLine[], before: number): number {
  let low = 0;
  let high = versions.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (versions[middle]!.line < before) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

/** The last version of a UUID strictly before this compaction, never a later rewrite. */
function occurrenceBefore(versions: RecordLine[] | undefined, before: number): RecordLine | null {
  return versions?.[lastIndexBefore(versions, before)] ?? null;
}

/**
 * Walk one historical snapshot. A UUID already emitted by a newer segment can still carry an
 * older parent here, so output deduplication must not stop traversal. Cycles within this snapshot
 * remain invalid; absent parents leave an explicitly incomplete fragment.
 */
function walkFrom(
  start: string,
  occurrences: Map<string, RecordLine[]>,
  before: number,
  budget: LineageBudget,
): { rows: RecordLine[]; root: RecordLine; missingParent: boolean } | null {
  let cursor = start;
  const rows: RecordLine[] = [];
  const visited = new Set<string>();
  for (;;) {
    if (budget.remaining === 0) {
      budget.exhausted = true;
      return null;
    }
    budget.remaining--;
    if (visited.has(cursor)) return null;
    const current = occurrenceBefore(occurrences.get(cursor), before);
    if (!current) return rows.length ? { rows, root: rows.at(-1)!, missingParent: true } : null;
    visited.add(cursor);
    rows.push(current);
    const parent = current.value.parentUuid;
    if (typeof parent !== "string" || !parent) return { rows, root: current, missingParent: false };
    cursor = parent;
  }
}

/**
 * Prefer the first complete pre-boundary chain, falling back to the preserved head or the first
 * readable incomplete fragment. Neither a candidate nor its ancestors may come from the future.
 */
function linkEarlier(
  boundary: RecordLine,
  occurrences: Map<string, RecordLine[]>,
  budget: LineageBudget,
): ReturnType<typeof walkFrom> {
  const candidates = new Set<unknown>([
    boundary.value.logicalParentUuid,
    get(boundary.value, "compactMetadata", "preservedSegment", "headUuid"),
  ]);
  let partial: ReturnType<typeof walkFrom> = null;
  for (const start of candidates) {
    if (typeof start !== "string") continue;
    const found = walkFrom(start, occurrences, boundary.line, budget);
    // Discard this unfinished candidate; only previously accepted segments are trusted.
    if (budget.exhausted) return null;
    if (found && !found.missingParent) return found;
    partial ??= found;
  }
  return partial;
}

/**
 * The active chain keeps the last occurrence of each UUID. At each compaction, reconstruct the
 * chain as it existed just before that boundary. Retained records may have been rewritten across
 * several compactions: each snapshot needs its own versions, including intermediate ones.
 * UUIDs belong to their newest accepted segment only, but their older versions still link ancestry.
 * Returns null when there is no leaf, so callers keep treating the file as unfiltered.
 */
export function claudeLineage(rows: RecordLine[], includeSidechain: boolean): Lineage | null {
  const occurrences = new Map<string, RecordLine[]>();
  const lastRecords = new Map<string, RecordLine>();
  let lastLeaf: string | undefined;
  for (const row of rows) {
    const { value } = row;
    if (typeof value.uuid !== "string") continue;
    const versions = occurrences.get(value.uuid) ?? [];
    versions.push(row);
    occurrences.set(value.uuid, versions);
    lastRecords.set(value.uuid, row);
    if (
      ["user", "assistant"].includes(value.type) &&
      (includeSidechain || value.isSidechain !== true)
    )
      lastLeaf = value.uuid;
  }
  let explicitLeaf: string | undefined;
  for (let index = rows.length - 1; index >= 0; index--) {
    const leaf = rows[index]!.value.leafUuid;
    if (
      typeof leaf === "string" &&
      lastRecords.has(leaf) &&
      (includeSidechain || lastRecords.get(leaf)!.value.isSidechain !== true)
    ) {
      explicitLeaf = leaf;
      break;
    }
  }
  let current = explicitLeaf ?? lastLeaf;
  if (!current) return null;
  const newest = new Set<string>();
  const newestLines = new Set<number>();
  let root: RecordLine | null = null;
  while (!newest.has(current)) {
    newest.add(current);
    const record = lastRecords.get(current);
    if (record) newestLines.add(record.line);
    const parent = record?.value.parentUuid;
    if (typeof parent !== "string" || !parent) {
      root = record ?? null;
      break;
    }
    current = parent;
  }
  const segments: LineageSegment[] = [{ uuids: newest, lines: newestLines, boundary: null }];
  const visited = new Set(newest);
  // Share the budget across boundaries and failed logical-parent/preserved-head attempts.
  // The latest active chain above retains its existing behavior independently of this limit.
  const budget: LineageBudget = { remaining: MAX_HISTORICAL_LINEAGE_VISITS, exhausted: false };
  let oldest = { segment: segments[0]!, root };
  let unlinked = false;
  while (oldest.root !== null) {
    const boundary = oldest.root;
    if (boundary.value.type !== "system" || boundary.value.subtype !== "compact_boundary") break;
    oldest.segment.boundary = boundary;
    const earlier =
      segments.length < MAX_LINEAGE_SEGMENTS ? linkEarlier(boundary, occurrences, budget) : null;
    if (!earlier) {
      unlinked = true;
      break;
    }
    const segment: LineageSegment = { uuids: new Set(), lines: new Set(), boundary: null };
    for (const row of earlier.rows) {
      const id = row.value.uuid as string;
      if (visited.has(id)) continue;
      visited.add(id);
      segment.uuids.add(id);
      segment.lines.add(row.line);
    }
    segments.push(segment);
    if (earlier.missingParent) {
      unlinked = true;
      break;
    }
    oldest = { segment, root: earlier.root };
  }
  return { segments: segments.reverse(), unlinked };
}

/** The chain `parentUuid` alone reaches from the leaf: the newest segment of the lineage. */
export function claudeActiveChain(
  rows: RecordLine[],
  includeSidechain: boolean,
): Set<string> | null {
  return claudeLineage(rows, includeSidechain)?.segments.at(-1)?.uuids ?? null;
}

export function finishDocument(
  source: DocumentSource,
  turns: SessionDocument["turns"],
  losses: Map<LossCode, number>,
): SessionDocument {
  const redactions = { value: 0 };
  for (const turn of turns)
    for (const block of turn.blocks) {
      if (block.type === "text") block.text = sanitizeSessionText(block.text, redactions);
      else if (block.type === "tool-call")
        block.input = sanitizeSessionText(block.input, redactions);
      else if (block.type === "tool-result")
        block.output = sanitizeSessionText(block.output, redactions);
      else {
        if (block.filename) block.filename = sanitizeSessionText(block.filename, redactions);
        if (block.inline_base64 && textualMediaType(block.media_type)) {
          try {
            const bytes = Buffer.from(block.inline_base64, "base64");
            if (
              bytes.toString("base64").replace(/=+$/, "") === block.inline_base64.replace(/=+$/, "")
            ) {
              const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
              block.inline_base64 = Buffer.from(
                sanitizeSessionText(text, redactions),
                "utf8",
              ).toString("base64");
            }
          } catch {
            // Invalid or binary attachments remain unchanged, matching the native parser.
          }
        }
      }
    }
  if (!turns.length) throw new Error("Conversation does not contain readable original records");
  return sessionDocument.parse({
    schema_version: 1,
    source: {
      agent: source.agent,
      workspace_id: source.workspace_id,
      title: source.title === null ? null : sanitizeSessionText(source.title, redactions),
      created_at: source.created_at,
      updated_at: source.updated_at,
      git_branch:
        source.git_branch === null ? null : sanitizeSessionText(source.git_branch, redactions),
    },
    turns,
    losses: [
      "damaged-record",
      "orphan-tool-result",
      "unsupported-attachment",
      "external-attachment",
      "reasoning-excluded",
      "source-content-truncated",
      "compacted-history",
      "compaction-link-unavailable",
    ].flatMap((code) =>
      losses.get(code as LossCode) ? [{ code, count: losses.get(code as LossCode) }] : [],
    ),
    redaction_count: redactions.value,
  });
}

function textualMediaType(mediaType: string): boolean {
  const value = mediaType.split(";")[0]!.trim().toLowerCase();
  return (
    value.startsWith("text/") ||
    ["application/json", "application/xml", "application/javascript"].includes(value) ||
    value.endsWith("+json") ||
    value.endsWith("+xml")
  );
}

/**
 * Convert one conversation record into a timeline entry. `knownCalls` is the caller's record of
 * tool calls seen so far (a result without one is an orphan) and `losses` collects what the
 * conversion drops; pass scratch copies when only the number of entries matters.
 */
export function rowTurn(
  { line, value }: RecordLine,
  knownCalls: Set<string>,
  losses: Map<LossCode, number>,
): Turn | null {
  const role = value.type === "assistant" ? "assistant" : "user";
  const content = get(value, "message", "content");
  if (content === undefined) return null;
  const blocks: Turn["blocks"] = [];
  const values = Array.isArray(content) ? content : [];
  if (typeof content === "string" && !isClaudeEcho(content) && content.trim())
    blocks.push({ type: "text", text: content });
  for (const block of values) {
    switch (block?.type) {
      case "text":
        if (typeof block.text === "string" && !isClaudeEcho(block.text) && block.text.trim())
          blocks.push({ type: "text", text: block.text });
        break;
      case "tool_use": {
        const callId = typeof block.id === "string" ? block.id : "missing-call-id";
        knownCalls.add(callId);
        blocks.push({
          type: "tool-call",
          call_id: callId,
          name: typeof block.name === "string" ? block.name : "tool",
          input: block.input === undefined ? "" : compactJson(block.input),
        });
        break;
      }
      case "tool_result": {
        const callId =
          typeof block.tool_use_id === "string" ? block.tool_use_id : "missing-call-id";
        if (!knownCalls.has(callId)) loss(losses, "orphan-tool-result");
        blocks.push({
          type: "tool-result",
          call_id: callId,
          output: block.content === undefined ? "" : compactJson(block.content),
          is_error: block.is_error === true,
        });
        break;
      }
      case "image":
      case "document": {
        const base64 = get(block, "source", "type") === "base64";
        const data = get(block, "source", "data");
        if (base64 && typeof data === "string" && data.trim())
          blocks.push({
            type: "attachment",
            kind: block.type === "document" ? "document" : "image",
            media_type:
              typeof get(block, "source", "media_type") === "string"
                ? (get(block, "source", "media_type") as string)
                : "application/octet-stream",
            filename: typeof block.name === "string" ? block.name : undefined,
            inline_base64: data,
          });
        else loss(losses, "external-attachment");
        break;
      }
      case "thinking":
      case "redacted_thinking":
        loss(losses, "reasoning-excluded");
        break;
      default:
        if (block?.type) loss(losses, "unsupported-attachment");
    }
  }
  return blocks.length
    ? { id: `turn-${line}`, role, timestamp: jsonTimestamp(value.timestamp), blocks }
    : null;
}

// Fixed English annotations. Claude Code stores the summary as a user record and every target
// format only has user/assistant roles, so the text itself must say the user did not write it.
const SUMMARY_NOTICE =
  "[AgentKib: context summary generated by Claude Code when it compacted this conversation. It summarizes earlier turns and is not a message written by the user.]";

/** Prefer the segment's selected summary, then a direct child in the same boundary snapshot. */
function findSummary(
  segmentRows: RecordLine[],
  boundary: RecordLine,
  rows: RecordLine[],
  before: number,
  includeSidechain: boolean,
): RecordLine | null {
  const id = boundary.value.uuid;
  if (typeof id !== "string" || !id) return null;
  const isSummary = ({ line, value }: RecordLine) =>
    line > boundary.line &&
    line < before &&
    typeof value.uuid === "string" &&
    value.uuid.length > 0 &&
    value.type === "user" &&
    value.isCompactSummary === true &&
    (includeSidechain || value.isSidechain !== true);
  const inside = segmentRows.find(isSummary);
  if (inside) return inside;
  const seen = new Set<string>();
  let selected: RecordLine | null = null;
  // Read newest first so a later non-summary, sidechain or reparented version also supersedes
  // an old summary. The window excludes other occurrences of this boundary and future rewrites.
  for (let index = lastIndexBefore(rows, before); index >= 0; index--) {
    const row = rows[index]!;
    if (row.line <= boundary.line) break;
    const uuid = row.value.uuid;
    if (typeof uuid !== "string" || !uuid || seen.has(uuid)) continue;
    seen.add(uuid);
    if (isSummary(row) && row.value.parentUuid === id) selected = row;
  }
  return selected;
}

function summaryTurn({ line, value }: RecordLine): Turn | null {
  const content = get(value, "message", "content");
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .flatMap((block) =>
              block?.type === "text" && typeof block.text === "string" ? [block.text] : [],
            )
            .join("\n")
        : "";
  if (!text.trim()) return null;
  return {
    id: `summary-${line}`,
    role: "user",
    kind: "context-summary",
    timestamp: jsonTimestamp(value.timestamp),
    blocks: [{ type: "text", text: `${SUMMARY_NOTICE}\n\n${text}` }],
  };
}

function boundaryTurn(
  { line, value }: RecordLine,
  index: number,
  total: number,
  state: "summarized" | "without-summary" | "unlinked",
): Turn {
  const trigger = get(value, "compactMetadata", "trigger");
  const named = trigger === "auto" || trigger === "manual" ? `, trigger: ${trigger}` : "";
  const text =
    state === "unlinked"
      ? `[AgentKib: Claude Code compacted the conversation here (compaction ${index} of ${total}). Earlier history before this point could not be located in the transcript and is not included.]`
      : `[AgentKib: Claude Code compacted the conversation here (compaction ${index} of ${total}${named}). Messages above are the original earlier history; ${
          state === "summarized"
            ? "the context summary below is what Claude carried forward"
            : "no context summary was found in the transcript"
        }.]`;
  return {
    id: `boundary-${line}`,
    role: "user",
    kind: "compaction-boundary",
    timestamp: jsonTimestamp(value.timestamp),
    blocks: [{ type: "text", text }],
  };
}

export function readClaudeDocument(
  source: DocumentSource,
  file: string,
  includeSidechain: boolean,
  options: DocumentOptions = {},
): SessionDocument {
  const snapshot = records(file);
  const lineage = claudeLineage(snapshot.rows, includeSidechain);
  const turns: Turn[] = [];
  const losses = new Map<LossCode, number>();
  loss(losses, "damaged-record", snapshot.damaged);
  loss(losses, "source-content-truncated", snapshot.truncated);
  const conversational = ({ value }: RecordLine) =>
    (includeSidechain || value.isSidechain !== true) &&
    ["user", "assistant"].includes(value.type) &&
    value.isCompactSummary !== true;
  const knownCalls = new Set<string>();
  const emit = (row: RecordLine) => {
    if (!conversational(row)) return;
    const turn = rowTurn(row, knownCalls, losses);
    if (turn) turns.push(turn);
  };
  if (!lineage?.segments.some((segment) => segment.boundary)) {
    // Never compacted, or the active chain does not cross a boundary: the former single chain.
    const chain = lineage?.segments[0]?.uuids;
    for (const row of snapshot.rows) {
      if (chain && (typeof row.value.uuid !== "string" || !chain.has(row.value.uuid))) continue;
      emit(row);
    }
    return finishDocument(source, turns, losses);
  }
  const owner = new Map<number, number>();
  for (const [index, segment] of lineage.segments.entries())
    for (const line of segment.lines) owner.set(line, index);
  const buckets: RecordLine[][] = lineage.segments.map(() => []);
  for (const row of snapshot.rows) {
    const index = owner.get(row.line);
    if (index !== undefined) buckets[index]!.push(row);
  }
  const withHistory = options.includePreCompactionHistory === true;
  const newest = lineage.segments.length - 1;
  const total = lineage.segments.filter((segment) => segment.boundary).length;
  let counted = 0;
  let ordinal = 0;
  for (const [index, segment] of lineage.segments.entries()) {
    const rows = buckets[index]!;
    if (!withHistory && index < newest) {
      // Not part of the document: count its timeline entries with scratch state so the real
      // document's tool-call bookkeeping and losses are not touched.
      const scratchCalls = new Set<string>();
      const scratchLosses = new Map<LossCode, number>();
      for (const row of rows)
        if (conversational(row) && rowTurn(row, scratchCalls, scratchLosses)) counted++;
      continue;
    }
    if (segment.boundary) {
      ordinal++;
      const summarized = findSummary(
        rows,
        segment.boundary,
        snapshot.rows,
        lineage.segments[index + 1]?.boundary?.line ?? Infinity,
        includeSidechain,
      );
      const summary = summarized ? summaryTurn(summarized) : null;
      if (withHistory)
        turns.push(
          boundaryTurn(
            segment.boundary,
            ordinal,
            total,
            lineage.unlinked && index === 0
              ? "unlinked"
              : summary
                ? "summarized"
                : "without-summary",
          ),
        );
      if (summary) turns.push(summary);
    }
    for (const row of rows) emit(row);
  }
  loss(losses, "compacted-history", counted);
  if (lineage.unlinked) loss(losses, "compaction-link-unavailable");
  return finishDocument(source, turns, losses);
}

export function looksLikeInternalContext(text: string): boolean {
  const trimmed = text.replace(/^\p{White_Space}+/u, "");
  return [
    "<path>",
    "<content>",
    "<recommended_plugins>",
    "<available_skills>",
    "<app-context>",
    "<skills_instructions>",
    "<environment_context>",
    "# AGENTS.md instructions",
  ].some((prefix) => trimmed.startsWith(prefix));
}

function injectedCodexContext(rows: RecordLine[]): Set<number> {
  const byTurn = new Map<string, Array<{ line: number; context: boolean }>>();
  for (const { line, value } of rows) {
    if (
      value.type !== "response_item" ||
      get(value, "payload", "type") !== "message" ||
      get(value, "payload", "role") !== "user"
    )
      continue;
    const turnId = get(value, "payload", "internal_chat_message_metadata_passthrough", "turn_id");
    const content = get(value, "payload", "content");
    if (typeof turnId !== "string") continue;
    const isContext =
      Array.isArray(content) &&
      content.length > 0 &&
      content.every(
        (block) =>
          ["text", "input_text"].includes(block?.type) &&
          typeof block?.text === "string" &&
          looksLikeInternalContext(block.text),
      );
    const messages = byTurn.get(turnId) ?? [];
    messages.push({ line, context: isContext });
    byTurn.set(turnId, messages);
  }
  return new Set(
    [...byTurn.values()].flatMap((messages) =>
      messages.some((message) => !message.context)
        ? messages.filter((message) => message.context).map((message) => message.line)
        : [],
    ),
  );
}

function codexAttachmentBlocks(
  value: Record<string, any>,
  losses: Map<LossCode, number>,
): Array<{ identity: string; block: SessionDocument["turns"][number]["blocks"][number] }> {
  const candidates: Array<{ kind: "image" | "document"; value: unknown; filename?: string }> = [];
  if (Array.isArray(get(value, "payload", "images")))
    for (const image of get(value, "payload", "images") as unknown[])
      candidates.push({ kind: "image", value: image });
  const content = get(value, "payload", "content");
  if (Array.isArray(content))
    for (const block of content) {
      if (["input_image", "image"].includes(block?.type)) {
        const image = block.image_url ?? block.url;
        if (image === undefined) loss(losses, "unsupported-attachment");
        else candidates.push({ kind: "image", value: image });
      } else if (["input_file", "file"].includes(block?.type)) {
        if (block.file_data === undefined) loss(losses, "external-attachment");
        else
          candidates.push({
            kind: "document",
            value: block.file_data,
            filename: typeof block.filename === "string" ? block.filename : undefined,
          });
      }
    }
  const output: Array<{
    identity: string;
    block: SessionDocument["turns"][number]["blocks"][number];
  }> = [];
  for (const candidate of candidates) {
    const raw = typeof candidate.value === "string" ? candidate.value : get(candidate.value, "url");
    const parsed = typeof raw === "string" ? /^data:([^;,]+);base64,(.*)$/s.exec(raw) : null;
    if (!parsed) {
      loss(losses, "external-attachment");
      continue;
    }
    const mediaType = parsed[1]!;
    const data = parsed[2]!;
    output.push({
      identity: `${candidate.kind === "image" ? "Image" : "Document"}:${mediaType}:${data}`,
      block: {
        type: "attachment",
        kind: candidate.kind,
        media_type: mediaType,
        ...(candidate.filename ? { filename: candidate.filename } : {}),
        inline_base64: data,
      },
    });
  }
  const localImages = get(value, "payload", "local_images");
  if (Array.isArray(localImages)) loss(losses, "external-attachment", localImages.length);
  return output;
}

export function matchedFallbackOccurrences(
  primary: Map<string, number[]>,
  fallback: Array<{ key: string; line: number; index: [number, number] }>,
): Set<string> {
  const fallbackByKey = new Map<string, Array<{ line: number; index: [number, number] }>>();
  for (const item of fallback) {
    const candidates = fallbackByKey.get(item.key) ?? [];
    candidates.push({ line: item.line, index: item.index });
    fallbackByKey.set(item.key, candidates);
  }
  const matched = new Set<string>();
  for (const [key, primaryLines] of primary) {
    const candidates = fallbackByKey.get(key);
    if (!candidates) continue;
    for (const primaryLine of primaryLines) {
      if (!candidates.length) break;
      let nearest = 0;
      for (let index = 1; index < candidates.length; index++) {
        const current = candidates[index]!,
          best = candidates[nearest]!;
        if (
          Math.abs(primaryLine - current.line) < Math.abs(primaryLine - best.line) ||
          (Math.abs(primaryLine - current.line) === Math.abs(primaryLine - best.line) &&
            current.line < best.line)
        )
          nearest = index;
      }
      const [candidate] = candidates.splice(nearest, 1);
      matched.add(`${candidate!.index[0]}:${candidate!.index[1]}`);
    }
  }
  return matched;
}

export function readCodexDocument(source: DocumentSource, file: string): SessionDocument {
  const snapshot = records(file);
  const excluded = injectedCodexContext(snapshot.rows);
  const turns: SessionDocument["turns"] = [];
  const fallbackMessages: Array<{
    line: number;
    role: "user" | "assistant";
    timestamp: string | null;
    text: string;
  }> = [];
  const fallbackAttachments: Array<{
    line: number;
    role: "user" | "assistant";
    timestamp: string | null;
    blocks: Array<{ identity: string; block: SessionDocument["turns"][number]["blocks"][number] }>;
  }> = [];
  const primaryMessages = new Map<string, number[]>();
  const primaryAttachments = new Map<string, number[]>();
  const knownCalls = new Set<string>();
  const losses = new Map<LossCode, number>();
  loss(losses, "damaged-record", snapshot.damaged);
  loss(losses, "source-content-truncated", snapshot.truncated);
  for (const { line, value } of snapshot.rows) {
    const time = jsonTimestamp(value.timestamp);
    const type = typeof value.type === "string" ? value.type : null;
    const payloadType = get(value, "payload", "type");
    if (type === "event_msg" && ["user_message", "agent_message"].includes(String(payloadType))) {
      const role = payloadType === "user_message" ? "user" : "assistant";
      const blocks: SessionDocument["turns"][number]["blocks"] = [];
      const content = get(value, "payload", "message");
      if (typeof content === "string" && content.trim()) {
        const key = `${role}:${content.trim()}`;
        const lines = primaryMessages.get(key) ?? [];
        lines.push(line);
        primaryMessages.set(key, lines);
        blocks.push({ type: "text", text: content });
      }
      for (const attachment of codexAttachmentBlocks(value, losses)) {
        const lines = primaryAttachments.get(attachment.identity) ?? [];
        lines.push(line);
        primaryAttachments.set(attachment.identity, lines);
        blocks.push(attachment.block);
      }
      if (blocks.length) turns.push({ id: `turn-${line}`, role, timestamp: time, blocks });
      continue;
    }
    if (type !== "response_item") continue;
    if (payloadType === "message") {
      const role = get(value, "payload", "role");
      if (role !== "user" && role !== "assistant") continue;
      if (role === "user" && excluded.has(line)) continue;
      const text = messageText(get(value, "payload", "content"));
      if (text?.trim()) fallbackMessages.push({ line, role, timestamp: time, text });
      const attachments = codexAttachmentBlocks(value, losses);
      if (attachments.length)
        fallbackAttachments.push({ line, role, timestamp: time, blocks: attachments });
    } else if (["function_call", "custom_tool_call"].includes(String(payloadType))) {
      const callId =
        typeof get(value, "payload", "call_id") === "string"
          ? (get(value, "payload", "call_id") as string)
          : "missing-call-id";
      const name =
        typeof get(value, "payload", "name") === "string"
          ? (get(value, "payload", "name") as string)
          : "tool";
      knownCalls.add(callId);
      const input = get(value, "payload", "arguments") ?? get(value, "payload", "input");
      turns.push({
        id: `turn-${line}-tool-call`,
        role: "assistant",
        timestamp: time,
        blocks: [
          {
            type: "tool-call",
            call_id: callId,
            name,
            input: input === undefined ? "" : compactJson(input),
          },
        ],
      });
    } else if (["function_call_output", "custom_tool_call_output"].includes(String(payloadType))) {
      const callId =
        typeof get(value, "payload", "call_id") === "string"
          ? (get(value, "payload", "call_id") as string)
          : "missing-call-id";
      if (!knownCalls.has(callId)) loss(losses, "orphan-tool-result");
      const output = get(value, "payload", "output");
      turns.push({
        id: `turn-${line}-tool-result`,
        role: "tool",
        timestamp: time,
        blocks: [
          {
            type: "tool-result",
            call_id: callId,
            output: output === undefined ? "" : compactJson(output),
            is_error: get(value, "payload", "is_error") === true,
          },
        ],
      });
    } else if (payloadType === "reasoning") loss(losses, "reasoning-excluded");
  }
  const matchedMessages = matchedFallbackOccurrences(
    primaryMessages,
    fallbackMessages.map((item, index) => ({
      key: `${item.role}:${item.text.trim()}`,
      line: item.line,
      index: [index, 0] as [number, number],
    })),
  );
  fallbackMessages.forEach((message, index) => {
    if (!matchedMessages.has(`${index}:0`))
      turns.push({
        id: `turn-${message.line}`,
        role: message.role,
        timestamp: message.timestamp,
        blocks: [{ type: "text", text: message.text }],
      });
  });
  const matchedAttachments = matchedFallbackOccurrences(
    primaryAttachments,
    fallbackAttachments.flatMap((item, turnIndex) =>
      item.blocks.map((block, blockIndex) => ({
        key: block.identity,
        line: item.line,
        index: [turnIndex, blockIndex] as [number, number],
      })),
    ),
  );
  fallbackAttachments.forEach((item, turnIndex) => {
    const blocks = item.blocks
      .filter((_, blockIndex) => !matchedAttachments.has(`${turnIndex}:${blockIndex}`))
      .map(({ block }) => block);
    if (blocks.length)
      turns.push({
        id: `turn-${item.line}-attachment`,
        role: item.role,
        timestamp: item.timestamp,
        blocks,
      });
  });
  turns.sort(
    (a, b) =>
      Number(a.id.match(/^turn-(\d+)/)?.[1] ?? Number.MAX_SAFE_INTEGER) -
      Number(b.id.match(/^turn-(\d+)/)?.[1] ?? Number.MAX_SAFE_INTEGER),
  );
  return finishDocument(source, turns, losses);
}

export function isClaudeEcho(value: string): boolean {
  const text = value.trimStart();
  return ["<local-command-", "<command-name>", "<command-message>"].some((prefix) =>
    text.startsWith(prefix),
  );
}
