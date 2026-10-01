/** @jsxImportSource octane */

import { useEffect, useMemo, useState } from "octane";
import { api } from "@/core/api";
import type { ContinuationCapability } from "@/core/types";

/** Identity-tagged results cannot enable the next session while its check is pending. */
export function useSessionSourceCapability(sessionId?: string, revision = 0) {
  const request = useMemo(() => ({ sessionId, revision }), [sessionId, revision]);
  const [result, setResult] = useState<{
    request: typeof request;
    capability: ContinuationCapability;
  }>();
  useEffect(() => {
    let active = true;
    const { sessionId } = request;
    if (sessionId) {
      void Promise.resolve()
        .then(() => api.sessionSourceCapability(sessionId))
        .then(
          (capability) => {
            if (active) setResult({ request, capability });
          },
          (error: unknown) => {
            if (active)
              setResult({
                request,
                capability: {
                  status: "unavailable",
                  reason: error instanceof Error ? error.message : String(error),
                },
              });
          },
        );
    }
    return () => {
      active = false;
    };
  }, [request]);
  return result?.request === request ? result.capability : undefined;
}
