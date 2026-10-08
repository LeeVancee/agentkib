/** Additive history-search contract shared by the host and both conversation clients. */
export const HISTORY_SEARCH_METHODS = {
  query: "sessions.searchContent",
  locate: "sessions.locateContent",
  references: "sessions.resolveHistoryReferences",
  status: "sessions.contentSearchStatus",
  configure: "sessions.setContentSearchEnabled",
  clear: "sessions.clearContentSearch",
  refresh: "sessions.refreshContentSearch",
  cancel: "sessions.cancelContentSearch",
} as const;

export const HISTORY_REFERENCE_LIMIT = 5;
export const HISTORY_REFERENCE_BYTES = 8 * 1024;
export type HistoryRecordKind = "user" | "assistant" | "tool-input" | "tool-output";
export interface HistoryLocation {
  sessionId: string;
  recordId: string;
  chunkId: string;
  sourceRevision: string;
}
export interface HistoryReference extends HistoryLocation {
  /** UTF-16 offsets into the exact, sanitized chunk returned by locate. */
  start: number;
  end: number;
  contentHash: string;
}
export interface HistorySearchQuery {
  query: string;
  workspaceIds?: string[];
  agents?: string[];
  kinds?: HistoryRecordKind[];
  archived?: boolean;
  cursor?: string;
  limit?: number;
}
export interface HistoryCoverage {
  total: number;
  ready: number;
  building: number;
  partial: number;
  stale: number;
  unavailable: number;
  limitations: string[];
}
export interface HistorySearchStatus {
  enabled: boolean;
  generation: string;
  bytes: number;
  limitBytes: number;
  budgetExceeded: boolean;
  coverage: HistoryCoverage;
  sources?: Array<{
    agent: string;
    body: "supported" | "partial" | "unavailable";
    tools: "supported" | "partial" | "unsupported" | "unavailable";
    coverage: HistoryCoverage;
  }>;
}
export interface HistorySearchHit {
  location: HistoryLocation;
  workspaceId: string;
  agent: string;
  title: string | null;
  timestamp: string | null;
  kind: HistoryRecordKind;
  toolName: string | null;
  snippet: string;
  /** UTF-16 offsets in snippet, not offsets in the source history. */
  matchRanges: Array<[number, number]>;
  stale: boolean;
  indexedAt?: string;
}
export interface HistorySearchResult {
  hits: HistorySearchHit[];
  nextCursor: string | null;
  status: HistorySearchStatus;
  limited: boolean;
}
export interface HistoryLocatedRecord {
  location: HistoryLocation;
  workspaceId: string;
  agent: string;
  title: string | null;
  timestamp: string | null;
  kind: HistoryRecordKind;
  toolName: string | null;
  content: string;
  contentHash: string;
  before: HistoryLocation | null;
  after: HistoryLocation | null;
}
export interface ResolvedHistoryReference {
  reference: HistoryReference;
  title: string | null;
  agent: string;
  kind: HistoryRecordKind;
  toolName: string | null;
  content: string;
}
function historySearchCasePoint(point: string): string {
  // Lowercase each character independently so an identical substring does not
  // change with its neighbours; final and ordinary sigma share the same case.
  return point.toLowerCase().replaceAll("ς", "σ");
}
/** Context-independent casing shared by FTS candidates and exact match checks. */
export function normalizeHistorySearchText(content: string): string {
  return Array.from(content, historySearchCasePoint).join("");
}
/** Match case variants while retaining original UTF-16 spans, even for expansions. */
export function literalHistoryMatchRanges(content: string, query: string): Array<[number, number]> {
  const needle = normalizeHistorySearchText(query);
  if (!needle) return [];
  const parts: string[] = [];
  const starts: number[] = [],
    ends: number[] = [];
  let offset = 0;
  for (const point of content) {
    const folded = historySearchCasePoint(point);
    parts.push(folded);
    for (let index = 0; index < folded.length; index++) {
      starts.push(offset);
      ends.push(offset + point.length);
    }
    offset += point.length;
  }
  const folded = parts.join("");
  const matches: Array<[number, number]> = [];
  for (let at = 0; matches.length < 100;) {
    const found = folded.indexOf(needle, at);
    if (found < 0) break;
    matches.push([starts[found]!, ends[found + needle.length - 1]!]);
    at = found + needle.length;
  }
  return matches;
}
export function formatHistoryReferences(references: readonly ResolvedHistoryReference[]): string {
  return references
    .map(({ title, agent, kind, toolName, content }) => {
      const source = [title || "Untitled", agent, kind, toolName].filter(Boolean).join(" · ");
      return `[History reference: ${source.replace(/[\r\n]/g, " ")}]\n${content}\n[/History reference]`;
    })
    .join("\n\n");
}
