import { useQuery, type QueryClient } from "@tanstack/react-query";
import { api } from "@/core/api";
import type { AgentToolSnapshot } from "@/core/types";

export const agentToolsKey = ["settings", "agent-tools"] as const;

let activeRefresh: Promise<AgentToolSnapshot> | undefined;
let activeRefreshIsForced = false;
let executionGate:
  | {
      promise: Promise<void>;
      release: () => void;
    }
  | undefined;

async function requestAgentTools(force: boolean): Promise<AgentToolSnapshot> {
  if (activeRefresh) {
    if (!force || activeRefreshIsForced) return activeRefresh;
    try {
      await activeRefresh;
    } catch {
      // A forced retry should still run after an automatic detection failure.
    }
    return requestAgentTools(true);
  }
  if (executionGate) {
    await executionGate.promise;
    return requestAgentTools(force);
  }

  const request = api.agentTools(force);
  activeRefresh = request;
  activeRefreshIsForced = force;
  try {
    return await request;
  } finally {
    if (activeRefresh === request) {
      activeRefresh = undefined;
      activeRefreshIsForced = false;
    }
  }
}

export async function acquireAgentToolsExecution(): Promise<(() => void) | undefined> {
  if (executionGate) return undefined;

  let releaseGate: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const gate = {
    promise,
    release: () => {
      if (executionGate !== gate) return;
      executionGate = undefined;
      releaseGate?.();
    },
  };
  executionGate = gate;

  try {
    await activeRefresh;
  } catch {
    // Execution revalidates its action, so a failed status refresh does not block it.
  }
  return gate.release;
}

export function useAgentTools() {
  return useQuery({
    queryKey: agentToolsKey,
    queryFn: () => requestAgentTools(false),
    staleTime: 30_000,
    retry: false,
  });
}

export async function refreshAgentTools(queryClient: QueryClient) {
  const snapshot = await requestAgentTools(true);
  queryClient.setQueryData(agentToolsKey, snapshot);
  return snapshot;
}
