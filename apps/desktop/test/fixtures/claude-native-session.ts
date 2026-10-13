import { randomUUID } from "node:crypto";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Hand-built Claude Code transcript records. They imitate the record structure only (type names
 * and field names); every value is synthetic.
 */
const stamp = "2026-10-13T00:00:00.000Z";

export function userRecord(sessionId: string, extra: Record<string, unknown> = {}) {
  return {
    parentUuid: null,
    isSidechain: false,
    userType: "external",
    cwd: "/synthetic/project",
    sessionId,
    version: "2.1.296",
    type: "user",
    message: { role: "user", content: "synthetic prompt" },
    uuid: randomUUID(),
    timestamp: stamp,
    ...extra,
  };
}

export function assistantRecord(
  sessionId: string,
  parentUuid: string | null,
  extra: Record<string, unknown> = {},
) {
  return {
    parentUuid,
    isSidechain: false,
    userType: "external",
    cwd: "/synthetic/project",
    sessionId,
    version: "2.1.296",
    type: "assistant",
    message: {
      id: "msg_synthetic",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "synthetic reply" }],
    },
    uuid: randomUUID(),
    timestamp: stamp,
    ...extra,
  };
}

/** One record of every metadata type observed in current Claude Code transcripts. */
export function metadataRecords(sessionId: string): Record<string, unknown>[] {
  return [
    { type: "mode", mode: "normal", sessionId },
    { type: "permission-mode", permissionMode: "default", sessionId },
    { type: "ai-title", aiTitle: "Synthetic title", sessionId },
    { type: "custom-title", customTitle: "Synthetic title", sessionId },
    { type: "agent-name", agentName: "synthetic", sessionId },
    { type: "queue-operation", operation: "enqueue", timestamp: stamp, sessionId },
    {
      type: "file-history-snapshot",
      messageId: randomUUID(),
      snapshot: { trackedFileBackups: {}, timestamp: stamp },
      isSnapshotUpdate: false,
    },
    { type: "last-prompt", lastPrompt: "synthetic", leafUuid: randomUUID(), sessionId },
    {
      type: "system",
      subtype: "informational",
      content: "synthetic",
      uuid: randomUUID(),
      parentUuid: null,
      sessionId,
      timestamp: stamp,
    },
    {
      type: "attachment",
      attachment: { type: "synthetic" },
      uuid: randomUUID(),
      parentUuid: null,
      sessionId,
      timestamp: stamp,
    },
  ];
}

export const jsonl = (records: readonly unknown[]) =>
  records.map((record) => JSON.stringify(record)).join("\n") + "\n";

/** Write one transcript and optionally pin its modification time (seconds since the epoch). */
export function writeTranscript(
  directory: string,
  content: string | Buffer,
  options: { name?: string; modified?: number } = {},
): string {
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, options.name ?? `${randomUUID()}.jsonl`);
  writeFileSync(file, content);
  if (options.modified !== undefined) utimesSync(file, options.modified, options.modified);
  return file;
}
