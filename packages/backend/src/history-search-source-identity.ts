import { sanitizeSessionText } from "./session-handoff";
import {
  HISTORY_SEARCH_SANITIZER_VERSION,
  type HistorySourceInput,
} from "./history-search-source-types";
import type { NativeSession } from "./session-store";

/**
 * The identity string every cached generation and locator of a source is bound to. A change here
 * rebuilds the old generations and invalidates their locators. A parser change that concerns a
 * single agent adds a key for that agent only, so other agents keep their caches.
 */
export function historySourceIdentity(
  input: Pick<HistorySourceInput, "sessionId" | "summary" | "profiles">,
  nativeEvidence: string,
  resolved: { workspace: string; native: Pick<NativeSession, "native_ref"> },
): string {
  return JSON.stringify({
    // Parser/redaction changes must rebuild old cache generations and invalidate locators.
    version: 7,
    sanitizerVersion: HISTORY_SEARCH_SANITIZER_VERSION,
    sessionId: input.sessionId,
    agent: input.summary.agent,
    // Labels are part of the reviewed send text, even when native message bytes are unchanged.
    title:
      input.summary.title === null ? null : sanitizeSessionText(input.summary.title, { value: 0 }),
    // The directory summary may lag behind independent native metadata/WAL updates.
    nativeEvidence,
    workspaceId: input.summary.workspace_id,
    workspace: resolved.workspace,
    native: resolved.native.native_ref,
    profiles: input.profiles,
    // Rebuild Claude generations with boundary-relative lineage versions and pre-boundary ancestry.
    ...(input.summary.agent === "claude-code" ? { claudeLineage: 3 } : {}),
  });
}
