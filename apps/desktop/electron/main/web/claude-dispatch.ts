import { RuntimeRequestError } from "../runtime-host";

/** Admission rejection is about this attempt, not necessarily the original request ID. */
export async function dispatchClaude(
  invoke: (params: unknown) => Promise<unknown>,
  receipt: (params: { requestId: string; deviceId: string }) => Promise<unknown>,
  params: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await invoke(params);
  } catch (error) {
    if (
      !(error instanceof RuntimeRequestError) ||
      error.code !== -32000 ||
      error.message !== "web-busy"
    )
      throw error;
    if (typeof params.requestId !== "string" || typeof params.deviceId !== "string") throw error;
    // This read is serialized after previously admitted work. A duplicate that
    // lost admission must not release references held by its original execution.
    const prior = await receipt({ requestId: params.requestId, deviceId: params.deviceId });
    if (
      !prior ||
      typeof prior !== "object" ||
      !("found" in prior) ||
      prior.found !== false ||
      !("requestId" in prior) ||
      prior.requestId !== params.requestId
    )
      throw error;
    return {
      accepted: false,
      completed: false,
      controlOutcome: "not-dispatched",
      requestId: params.requestId,
      sessionId: params.sessionId,
      runtimeBootId: params.runtimeBootId,
      reason: "web-busy",
      error: "web-busy",
    };
  }
}
