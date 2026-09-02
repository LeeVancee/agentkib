/** @jsxImportSource octane */

import { useEffect, useRef } from "octane";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@octanejs/tanstack-query";
import { api } from "@/core/api";
import { desktopApi } from "@/core/desktop";
import type { InsightsQuery } from "@/core/types";

const queryDefaults = {
  retry: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
};

export const insightsKeys = {
  all: ["insights"] as const,
  view: (query: InsightsQuery) => [...insightsKeys.all, "view", query] as const,
  refreshJob: () => [...insightsKeys.all, "refresh-job"] as const,
};

export function useInsightsView(query: InsightsQuery) {
  return useQuery({
    ...queryDefaults,
    queryKey: insightsKeys.view(query),
    queryFn: () => api.insightsView(query),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

export function useInsightsRefreshJob() {
  const queryClient = useQueryClient();
  const query = useQuery({
    ...queryDefaults,
    queryKey: insightsKeys.refreshJob(),
    queryFn: async () => {
      const jobs = await api.refreshStatus();
      return jobs.find((job) => job.kind === "insights");
    },
    staleTime: 0,
    refetchInterval: (current) => {
      const state = current.state.data?.state;
      return state === "queued" || state === "running" ? 1_000 : false;
    },
  });
  const invalidatedRequest = useRef<string | undefined>(undefined);

  useEffect(() => {
    const job = query.data;
    if (job?.state !== "succeeded" || !job.request_id) return;
    if (invalidatedRequest.current === job.request_id) return;
    invalidatedRequest.current = job.request_id;
    void queryClient.invalidateQueries({ queryKey: insightsKeys.all });
  }, [query.data, queryClient]);

  return query;
}

export function useInsightsRefreshMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    ...queryDefaults,
    mutationFn: () => api.requestRefresh("insights", true),
    onSuccess: (receipt) => {
      queryClient.setQueryData(insightsKeys.refreshJob(), receipt.status);
      if (receipt.status.state === "succeeded") {
        void queryClient.invalidateQueries({ queryKey: insightsKeys.all });
      }
    },
  });
}

export function useInsightsQueryEvents() {
  const queryClient = useQueryClient();
  useEffect(() => {
    const unlisten = desktopApi().events.onRefreshState((status) => {
      if (status.kind !== "insights") return;
      queryClient.setQueryData(insightsKeys.refreshJob(), status);
      if (status.state === "succeeded") {
        void queryClient.invalidateQueries({ queryKey: insightsKeys.all });
      }
    });
    return unlisten;
  }, [queryClient]);
}
