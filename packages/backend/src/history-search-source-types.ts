import type { HistoryRecordKind } from "@agentkib/runtime-protocol";
import type { CursorBridgeContext } from "./cursor-bridge";
import type { SessionStore } from "./session-store";

/** A whole snapshot failed; it must not replace a previously committed generation. */
export class HistorySourceSnapshotError extends Error {
  constructor(readonly limitation: "damaged-record" | "source-byte-limit") {
    super("history-source-unavailable");
  }
}

/** Internal worker evidence, never a path or a caller-provided source identity. */
export class HistorySourceInvalidatedError extends Error {
  constructor(
    readonly sessionId: string,
    reason: "history-source-owner-changed" | "history-source-redaction-failed",
  ) {
    super(reason);
  }
}

/** Private identity evidence; never accepted from search/reference RPC callers. */
export interface OpenClawHistorySourceBinding {
  home: string;
  agentId: string;
  sessionId: string;
  cwd: string;
}
export interface HistorySourceInput {
  sessionId: string;
  summary: NonNullable<ReturnType<SessionStore["get"]>>;
  workspacePath: string;
  environment: NodeJS.ProcessEnv;
  profiles: CursorBridgeContext["profile"][];
  identitySalt: string;
  openClawBinding?: OpenClawHistorySourceBinding;
}
export interface HistorySourceRecord {
  recordId: string;
  ordinal: number;
  kind: HistoryRecordKind;
  toolName: string | null;
  timestamp: string | null;
  content: string;
}
export interface HistorySourceResult {
  sourceRevision: string;
  recordCount: number;
  limitations: string[];
  status: "ready" | "partial";
  openClawBinding?: OpenClawHistorySourceBinding;
}
/** Internal readers emit complete, unredacted text; the common sink sanitizes before delivery. */
export interface HistorySourceSink {
  emit(record: Omit<HistorySourceRecord, "ordinal">): Promise<void>;
  fingerprint(value: string | Uint8Array): void;
  limit(code: string): void;
  checkpoint(): void;
}
