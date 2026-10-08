import { useId } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/core/api";
import { queryDefaults, useOptionalQueryClient } from "@/features/home/home-query";
import { sessionKeys } from "./session-query";

export function useSessionSourceCapability(sessionId?: string, revision = 0) {
  const client = useOptionalQueryClient();
  const observerId = useId();
  const result = useQuery(
    {
      ...queryDefaults,
      queryKey: [...sessionKeys.capability(sessionId ?? "", revision), observerId],
      queryFn: () => api.sessionSourceCapability(sessionId!),
      enabled: !!sessionId,
      staleTime: 0,
      gcTime: 0,
    },
    client,
  );
  if (!sessionId || result.isFetching) return undefined;
  if (result.error)
    return {
      status: "unavailable" as const,
      reason: result.error instanceof Error ? result.error.message : String(result.error),
    };
  return result.data;
}
