import { createHash } from "node:crypto";
import {
  HISTORY_REFERENCE_LIMIT,
  HISTORY_REFERENCE_BYTES,
  formatHistoryReferences,
  type HistoryLocation,
  type HistoryReference,
  type ResolvedHistoryReference,
} from "@agentkib/runtime-protocol";

const fields = ["sessionId", "recordId", "chunkId", "sourceRevision"];
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_history_reference");
  return value as Record<string, unknown>;
}
function identity(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 256 ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  )
    throw new Error("invalid_history_reference");
  return value;
}
export function historyLocation(value: unknown): HistoryLocation {
  const input = object(value);
  if (Object.keys(input).some((key) => !fields.includes(key)))
    throw new Error("invalid_history_location");
  return {
    sessionId: identity(input.sessionId),
    recordId: identity(input.recordId),
    chunkId: identity(input.chunkId),
    sourceRevision: identity(input.sourceRevision),
  };
}
export function historyReferences(value: unknown): HistoryReference[] {
  if (!Array.isArray(value) || value.length > HISTORY_REFERENCE_LIMIT)
    throw new Error("invalid_history_references");
  return value.map((item) => {
    const input = object(item);
    if (
      Object.keys(input).some((key) => ![...fields, "start", "end", "contentHash"].includes(key)) ||
      !Number.isSafeInteger(input.start) ||
      !Number.isSafeInteger(input.end) ||
      Number(input.start) < 0 ||
      Number(input.end) <= Number(input.start) ||
      typeof input.contentHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(input.contentHash)
    )
      throw new Error("invalid_history_reference");
    return {
      sessionId: identity(input.sessionId),
      recordId: identity(input.recordId),
      chunkId: identity(input.chunkId),
      sourceRevision: identity(input.sourceRevision),
      start: Number(input.start),
      end: Number(input.end),
      contentHash: input.contentHash,
    };
  });
}
export function historyText(
  text: string,
  references: readonly HistoryReference[],
  resolved: readonly ResolvedHistoryReference[],
): string {
  if (
    !Array.isArray(resolved) ||
    references.length !== resolved.length ||
    resolved.some(
      (item, index) =>
        JSON.stringify(historyReferences([item.reference])[0]) !==
          JSON.stringify(references[index]) || typeof item.content !== "string",
    ) ||
    Buffer.byteLength(resolved.map((item) => item.content).join(""), "utf8") >
      HISTORY_REFERENCE_BYTES
  )
    throw new Error("invalid_history_resolution");
  const result = [text.trim(), formatHistoryReferences(resolved)].filter(Boolean).join("\n\n");
  if (result.length > 16_000 || Buffer.byteLength(result, "utf8") > 16_384)
    throw new Error("invalid_text");
  return result;
}
/** Hash the reviewed input, independently of later source availability or expanded text. */
export function historyInputHash(body: Record<string, unknown>, operation: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        operation,
        sessionId: body.sessionId,
        expectedRevision: body.expectedRevision,
        text: body.text ?? "",
        historyReferences: historyReferences(body.historyReferences ?? []),
        attachmentIds: body.attachmentIds ?? [],
        resourceIds: body.resourceIds ?? [],
        turnId: body.turnId ?? null,
        queuedSubmissionId: body.queuedSubmissionId ?? null,
      }),
    )
    .digest("hex");
}
