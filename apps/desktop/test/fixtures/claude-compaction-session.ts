/**
 * Hand-built Claude Code transcript records for compacted sessions. They imitate the record
 * structure only (type names, field names and pointer relations); every value is synthetic.
 */
const stamp = "2026-10-13T00:00:00.000Z";
const sessionId = "00000000-0000-4000-8000-0000000000aa";

const envelope = (uuid: string, parentUuid: string | null) => ({
  parentUuid,
  isSidechain: false,
  userType: "external",
  cwd: "/synthetic/project",
  sessionId,
  version: "2.1.296",
  uuid,
  timestamp: stamp,
});

export function user(uuid: string, parentUuid: string | null, text: string) {
  return { ...envelope(uuid, parentUuid), type: "user", message: { role: "user", content: text } };
}

export function assistant(uuid: string, parentUuid: string | null, text: string) {
  return {
    ...envelope(uuid, parentUuid),
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

/** The compaction summary is stored as a user record flagged `isCompactSummary`. */
export function summary(uuid: string, parentUuid: string | null, text: string) {
  return {
    ...user(uuid, parentUuid, text),
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
  };
}

export function attachment(uuid: string, parentUuid: string | null) {
  return {
    ...envelope(uuid, parentUuid),
    type: "attachment",
    attachment: { type: "synthetic" },
  };
}

export interface BoundaryOptions {
  /** Pointer to the last record before compaction; omitted when `undefined`. */
  logicalParentUuid?: string;
  trigger?: "auto" | "manual";
  /** Preserved-segment pointers; the whole object is omitted when none is given. */
  head?: string;
  anchor?: string;
  tail?: string;
}

/** `compact_boundary` has no `parentUuid`; `logicalParentUuid` points to the pre-compaction side. */
export function boundary(uuid: string, options: BoundaryOptions = {}) {
  const preserved =
    options.head === undefined && options.anchor === undefined && options.tail === undefined
      ? {}
      : {
          preservedSegment: {
            ...(options.head === undefined ? {} : { headUuid: options.head }),
            ...(options.anchor === undefined ? {} : { anchorUuid: options.anchor }),
            ...(options.tail === undefined ? {} : { tailUuid: options.tail }),
          },
        };
  return {
    ...envelope(uuid, null),
    type: "system",
    subtype: "compact_boundary",
    content: "Conversation compacted",
    isMeta: false,
    level: "info",
    ...(options.logicalParentUuid === undefined
      ? {}
      : { logicalParentUuid: options.logicalParentUuid }),
    compactMetadata: {
      ...(options.trigger === undefined ? {} : { trigger: options.trigger }),
      preTokens: 1,
      ...preserved,
    },
  };
}

export const lastPrompt = (leafUuid: string) => ({
  type: "last-prompt",
  lastPrompt: "synthetic",
  leafUuid,
  sessionId,
});

export const SUMMARY_TEXT = "SUMMARY-BODY the earlier work was condensed into this note.";

/**
 * The scenario from the specification: A→B→C, a boundary whose `logicalParentUuid` is C, the
 * summary, then D→E.
 */
export function specificationSession() {
  return [
    user("a", null, "alpha-question"),
    assistant("b", "a", "bravo-answer"),
    user("c", "b", "charlie-question"),
    boundary("bd", { logicalParentUuid: "c", trigger: "auto" }),
    summary("sm", "bd", SUMMARY_TEXT),
    assistant("d", "sm", "delta-answer"),
    user("e", "d", "echo-question"),
  ];
}

/**
 * The preserved-segment form: the boundary's `logicalParentUuid` (T) is written after the
 * boundary and its parent chain leads back through the summary, so only `headUuid` (C) reaches the
 * earlier history.
 */
export function preservedSegmentSession() {
  return [
    user("a", null, "alpha-question"),
    assistant("b", "a", "bravo-answer"),
    user("c", "b", "charlie-question"),
    boundary("bd", {
      logicalParentUuid: "t",
      trigger: "auto",
      head: "c",
      anchor: "sm",
      tail: "t",
    }),
    summary("sm", "bd", SUMMARY_TEXT),
    assistant("t", "sm", "tail-answer"),
    user("d", "t", "delta-question"),
    assistant("e", "d", "echo-answer"),
  ];
}

/**
 * Three compactions in one file. The uuid `a1` appears twice with different parents: its first
 * row sits in the second segment, its last row points at a summary of the newest segment (as a
 * rewritten copy would). Following "last occurrence" parents from the second segment therefore
 * runs into the newest segment and stops; "first occurrence" parents reach the start of the file.
 * The stray copy has no content, so it never becomes a timeline entry of its own.
 */
export function duplicateUuidSession() {
  return [
    user("a0", null, "zero-a"),
    assistant("b0", "a0", "zero-b"),
    boundary("bd1", { logicalParentUuid: "b0", trigger: "auto" }),
    summary("s1", "bd1", "SUMMARY-ONE"),
    user("a1", "s1", "one-a"),
    assistant("b1", "a1", "one-b"),
    boundary("bd2", { logicalParentUuid: "b1", trigger: "manual" }),
    summary("s2", "bd2", "SUMMARY-TWO"),
    user("a2", "s2", "two-a"),
    assistant("b2", "a2", "two-b"),
    boundary("bd3", { logicalParentUuid: "b2", trigger: "auto" }),
    summary("s3", "bd3", "SUMMARY-THREE"),
    { ...user("a1", "s3", ""), message: { role: "user", content: [] } },
    user("a3", "s3", "three-a"),
    assistant("b3", "a3", "three-b"),
  ];
}

/** Two compactions: [a b] bd1 s1 [c d] bd2 s2 [e f]. */
export function twoCompactionSession() {
  return [
    user("a", null, "alpha-question"),
    assistant("b", "a", "bravo-answer"),
    boundary("bd1", { logicalParentUuid: "b", trigger: "auto" }),
    summary("s1", "bd1", "SUMMARY-ONE"),
    user("c", "s1", "charlie-question"),
    assistant("d", "c", "delta-answer"),
    boundary("bd2", { logicalParentUuid: "d", trigger: "manual" }),
    summary("s2", "bd2", "SUMMARY-TWO"),
    user("e", "s2", "echo-question"),
    assistant("f", "e", "foxtrot-answer"),
  ];
}

export const jsonlLines = (records: readonly unknown[]) =>
  records.map((record) => JSON.stringify(record)).join("\n") + "\n";
