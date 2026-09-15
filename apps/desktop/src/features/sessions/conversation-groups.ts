import type { ConversationEvent } from "@/core/types";

/**
 * The renderer can be built while talking to an older runtime which does not
 * include turn metadata yet. Keep the compatibility shape local instead of
 * widening the shared protocol type in this feature.
 */
export type ConversationMessagePhase = "commentary" | "final_answer";

export type ConversationEventWithTurn = ConversationEvent & {
  turn_id?: string | null;
  message_phase?: ConversationMessagePhase | null;
};

export interface ConversationTranscriptSegment {
  key: string;
  kind: "event" | "process";
  events: ConversationEventWithTurn[];
  collapsible: boolean;
  defaultOpen: boolean;
  toolCount: number;
  failedToolCount: number;
}

export interface ConversationTurnGroup {
  key: string;
  turnId?: string;
  events: ConversationEventWithTurn[];
  segments: ConversationTranscriptSegment[];
  complete: boolean;
  truncated: boolean;
  timestamp?: string;
}

export interface ConversationGroupingOptions {
  /**
   * History warnings can indicate omitted records. Treating the whole window
   * as incomplete avoids presenting a process as a confidently complete turn.
   */
  incomplete?: boolean;
}

/** Return a turn id only when it is a usable, explicit identity. */
export function reliableTurnId(event: ConversationEvent): string | undefined {
  const value = (event as ConversationEventWithTurn).turn_id;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

export function isFailedToolEvent(event: ConversationEvent): boolean {
  if (event.kind !== "tool-summary") return false;
  const status = event.tool_status?.trim().toLowerCase();
  return status === "failed" || status === "failure" || status === "error" || status === "errored";
}

function eventWithTurn(event: ConversationEvent): ConversationEventWithTurn {
  return event as ConversationEventWithTurn;
}

function isCommentary(event: ConversationEventWithTurn) {
  return event.kind === "agent-message" && event.message_phase === "commentary";
}

function hasExplicitFinal(events: ConversationEventWithTurn[]) {
  return events.some(
    (event) => event.kind === "agent-message" && event.message_phase === "final_answer",
  );
}

function isProcessEvent(event: ConversationEventWithTurn, complete: boolean) {
  // In an incomplete turn, commentary remains readable in place. Only a
  // contiguous run made solely of tools is safe to fold.
  return event.kind === "tool-summary" || (complete && isCommentary(event));
}

function segmentKey(groupKey: string, events: ConversationEventWithTurn[], index: number) {
  const lastId = events.at(-1)?.id || `index-${index}`;
  return `${groupKey}:segment:${lastId}`;
}

function createSegment(
  groupKey: string,
  events: ConversationEventWithTurn[],
  complete: boolean,
  index: number,
): ConversationTranscriptSegment {
  const toolCount = events.filter((event) => event.kind === "tool-summary").length;
  const failedToolCount = events.filter(isFailedToolEvent).length;
  const process = events.length > 0 && isProcessEvent(events[0], complete);

  return {
    key: segmentKey(groupKey, events, index),
    kind: process ? "process" : "event",
    events,
    collapsible: process,
    // A failed tool is actionable evidence, so expose its process by default.
    defaultOpen: !process || failedToolCount > 0,
    toolCount,
    failedToolCount,
  };
}

function createSegments(
  groupKey: string,
  events: ConversationEventWithTurn[],
  complete: boolean,
): ConversationTranscriptSegment[] {
  const segments: ConversationTranscriptSegment[] = [];
  let index = 0;
  while (index < events.length) {
    const first = events[index];
    const process = isProcessEvent(first, complete);
    const segmentEvents = [first];
    index += 1;
    if (process) {
      while (index < events.length && isProcessEvent(events[index], complete)) {
        segmentEvents.push(events[index]);
        index += 1;
      }
    }
    // Incomplete commentary and all unclassified正文 stay as individual rows;
    // only the process runs above become disclosures.
    segments.push(createSegment(groupKey, segmentEvents, complete, segments.length));
  }
  return segments;
}

function createGroup(
  turnId: string | undefined,
  events: ConversationEventWithTurn[],
  index: number,
  forceIncomplete: boolean,
): ConversationTurnGroup {
  const truncated = events.some((event) => event.truncated);
  const complete =
    !forceIncomplete &&
    Boolean(turnId) &&
    !truncated &&
    events[0]?.kind === "user-message" &&
    hasExplicitFinal(events);
  // The last event is used as the stable anchor because history pagination
  // prepends older records. Duplicate turn ids in separate runs still get
  // distinct anchors and are never merged.
  const lastId = events.at(-1)?.id || `index-${index}`;
  const key = turnId ? `turn:${turnId}:end:${lastId}` : `event:${lastId}`;

  return {
    key,
    turnId,
    events,
    segments: createSegments(key, events, complete),
    complete,
    truncated,
    timestamp: events.find((event) => event.timestamp)?.timestamp,
  };
}

/**
 * Group only contiguous events carrying the same reliable turn id.
 *
 * Consecutive events without a turn id form a legacy fallback group. This
 * keeps old tool runs foldable without guessing a turn boundary, and it
 * prevents a repeated id separated by an unannotated event from being merged.
 */
export function groupConversationEvents(
  events: ConversationEvent[],
  options: ConversationGroupingOptions = {},
): ConversationTurnGroup[] {
  const groups: ConversationTurnGroup[] = [];
  let currentTurnId: string | undefined;
  let currentEvents: ConversationEventWithTurn[] = [];

  const flush = () => {
    if (!currentEvents.length) return;
    groups.push(
      createGroup(currentTurnId, currentEvents, groups.length, options.incomplete === true),
    );
    currentEvents = [];
    currentTurnId = undefined;
  };

  events.forEach((event) => {
    const turnId = reliableTurnId(event);
    if (!turnId) {
      if (currentEvents.length && currentTurnId !== undefined) flush();
      currentTurnId = undefined;
      currentEvents.push(eventWithTurn(event));
      return;
    }
    if (currentEvents.length && currentTurnId !== turnId) flush();
    currentTurnId = turnId;
    currentEvents.push(eventWithTurn(event));
  });
  flush();
  return groups;
}

// Naming this operation in terms of turns is useful to callers that do not
// care about the transcript rendering details.
export const groupConversationTurns = groupConversationEvents;
