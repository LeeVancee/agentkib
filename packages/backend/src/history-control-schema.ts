import { z } from "zod";

const identity = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => [...value].every((character) => character.charCodeAt(0) >= 32));
export const historyReferenceSchema = z
  .object({
    sessionId: identity,
    recordId: identity,
    chunkId: identity,
    sourceRevision: identity,
    start: z.number().safe().int().nonnegative(),
    end: z.number().safe().int().positive(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .refine((value) => value.end > value.start);

export function validHistoryControl(value: {
  operation: string;
  historyReferences?: unknown;
  historyInputHash?: unknown;
}) {
  if (value.historyReferences === undefined && value.historyInputHash === undefined) return true;
  return (
    ["send", "steer", "queue-add"].includes(value.operation) &&
    z.array(historyReferenceSchema).max(5).safeParse(value.historyReferences).success &&
    typeof value.historyInputHash === "string" &&
    /^[a-f0-9]{64}$/.test(value.historyInputHash)
  );
}
