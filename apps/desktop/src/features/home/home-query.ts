import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/core/api";
import { desktopApi } from "@/core/desktop";

const queryDefaults = {
  retry: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  staleTime: 30_000,
};

export const homeKeys = {
  all: ["home"] as const,
  workspaces: () => [...homeKeys.all, "workspaces"] as const,
  doctorSummaries: (workspaceIds: string[]) =>
    [...homeKeys.all, "doctor-summaries", workspaceIds] as const,
  installations: () => [...homeKeys.all, "installations"] as const,
  catalog: () => [...homeKeys.all, "catalog"] as const,
  memories: () => [...homeKeys.all, "memories"] as const,
  activity: () => [...homeKeys.all, "activity"] as const,
  discovery: () => [...homeKeys.all, "discovery"] as const,
  insightsSummary: () => [...homeKeys.all, "insights-summary"] as const,
};

export function useHomeWorkspaces() {
  return useQuery({
    ...queryDefaults,
    queryKey: homeKeys.workspaces(),
    queryFn: () => api.workspaces(),
  });
}

export function useHomeDoctorSummaries(workspaceIds: string[]) {
  return useQuery({
    ...queryDefaults,
    queryKey: homeKeys.doctorSummaries(workspaceIds),
    queryFn: async () => {
      if (!workspaceIds.length) return {};
      const summaries = await api.workspaceDoctorSummaries(workspaceIds);
      return Object.fromEntries(summaries.map((summary) => [summary.workspace_id, summary]));
    },
  });
}

export function useHomeInstallations() {
  return useQuery({
    ...queryDefaults,
    queryKey: homeKeys.installations(),
    queryFn: () => api.agentInstallations(),
  });
}

export function useHomeCatalog() {
  return useQuery({
    ...queryDefaults,
    queryKey: homeKeys.catalog(),
    queryFn: () => api.catalogAssets(),
  });
}

export function useHomeMemories() {
  return useQuery({
    ...queryDefaults,
    queryKey: homeKeys.memories(),
    queryFn: () => api.globalMemories(),
  });
}

export function useHomeActivity() {
  return useQuery({
    ...queryDefaults,
    queryKey: homeKeys.activity(),
    queryFn: () => api.activity(),
  });
}

export function useHomeDiscovery() {
  return useQuery({
    ...queryDefaults,
    queryKey: homeKeys.discovery(),
    queryFn: () => api.discoveryReport(),
  });
}

export function useHomeInsightsSummary() {
  return useQuery({
    ...queryDefaults,
    queryKey: homeKeys.insightsSummary(),
    queryFn: () => api.insightsSummary(),
  });
}

export function useHomeQueryEvents() {
  const queryClient = useQueryClient();
  useEffect(() => {
    const unlisten = desktopApi().events.onRefreshState((status) => {
      if (status.state !== "succeeded") return;
      if (status.kind === "discovery" || status.kind === "insights") {
        void queryClient.invalidateQueries({ queryKey: homeKeys.all });
      }
    });
    return unlisten;
  }, [queryClient]);
}
