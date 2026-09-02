import { useQuery, type QueryClient } from "@tanstack/react-query";
import { api } from "@/core/api";

export const agentToolsKey = ["settings", "agent-tools"] as const;

export function useAgentTools() {
  return useQuery({
    queryKey: agentToolsKey,
    queryFn: () => api.agentTools(false),
    staleTime: 30_000,
    retry: false,
  });
}

export async function refreshAgentTools(queryClient: QueryClient) {
  const snapshot = await api.agentTools(true);
  queryClient.setQueryData(agentToolsKey, snapshot);
  return snapshot;
}
