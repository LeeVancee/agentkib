import { z } from "zod";

export const BackendErrorCode = z.enum([
  "VALIDATION",
  "NOT_FOUND",
  "PERMISSION",
  "CONFLICT",
  "IO",
  "CANCELLED",
  "TIMEOUT",
  "INTERNAL",
]);

export const BackendErrorDetails = z.record(z.string(), z.unknown());
export const BackendErrorShape = z.object({
  code: BackendErrorCode,
  message: z.string(),
  details: BackendErrorDetails.optional(),
});
export type BackendErrorShape = z.infer<typeof BackendErrorShape>;

export const WorkerRequest = z.object({
  id: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export const WorkerResponse = z.discriminatedUnion("ok", [
  z.object({ id: z.string().min(1), ok: z.literal(true), result: z.unknown() }),
  z.object({ id: z.string().min(1), ok: z.literal(false), error: BackendErrorShape }),
]);
export const WorkerNotification = z.object({
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export type WorkerRequest = z.infer<typeof WorkerRequest>;
export type WorkerResponse = z.infer<typeof WorkerResponse>;
export type WorkerNotification = z.infer<typeof WorkerNotification>;

export class BackendError extends Error {
  readonly code: BackendErrorShape["code"];
  readonly details?: Record<string, unknown>;

  constructor(error: BackendErrorShape) {
    super(error.message);
    this.name = "BackendError";
    this.code = error.code;
    this.details = error.details;
  }

  toJSON(): BackendErrorShape {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
    };
  }

  static from(
    error: unknown,
    fallback = "Backend operation failed",
    redact?: (message: string) => string,
  ): BackendError {
    if (error instanceof BackendError) return error;
    if (error instanceof Error)
      return new BackendError({ code: "INTERNAL", message: redact?.(error.message) || fallback });
    return new BackendError({ code: "INTERNAL", message: fallback });
  }
}

export function backendError(
  code: BackendErrorShape["code"],
  message: string,
  details?: Record<string, unknown>,
): BackendError {
  return new BackendError({ code, message, ...(details ? { details } : {}) });
}
