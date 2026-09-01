import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef } from "react";
import { useQueries } from "@tanstack/react-query";
import { GlobalHome } from "@/features/home/GlobalHome";
import { HomeSkeleton } from "@/features/home/HomeSkeleton";
import { api } from "../core/api";
import { groupCatalogAssets, workspaceAssetCounts } from "@/features/catalog/catalog";
import { useAppStore } from "../stores/app-store";
import { desktopApi } from "../core/desktop";
import { homeBenchmarkOutcome } from "../features/home/home-benchmark";
import { selectRecentContinuations } from "../features/home/home-continuations";
import type { WorkspaceSummary } from "../core/types";
import {
  useHomeActivity,
  useHomeCatalog,
  useHomeDiscovery,
  useHomeDoctorSummaries,
  useHomeInsightsSummary,
  useHomeInstallations,
  useHomeMemories,
  useHomeWorkspaces,
} from "@/features/home/home-query";

function HomeRoute() {
  const navigate = useNavigate();
  const runtime = useAppStore((state) => state.runtime);
  const setRuntime = useAppStore((state) => state.setRuntime);
  const workspacesQuery = useHomeWorkspaces();
  const workspaces = useMemo(() => workspacesQuery.data ?? [], [workspacesQuery.data]);
  const continuationWorkspaces = useMemo(
    () =>
      [...workspaces].sort((left, right) =>
        (right.last_active_at ?? "").localeCompare(left.last_active_at ?? ""),
      ),
    [workspaces],
  );
  const continuationQueries = useQueries({
    queries: continuationWorkspaces.map((workspace) => ({
      queryKey: ["home", "continuations", workspace.id],
      queryFn: () => api.workspaceSessions(workspace.id),
      staleTime: 60_000,
    })),
  });
  const recentContinuations = selectRecentContinuations(
    continuationWorkspaces,
    continuationQueries.map((query) => query.data),
  );
  const doctorSummariesQuery = useHomeDoctorSummaries(workspaces.map((workspace) => workspace.id));
  const installationsQuery = useHomeInstallations();
  const memoriesQuery = useHomeMemories();
  const discoveryQuery = useHomeDiscovery();
  const activityQuery = useHomeActivity();
  const insightsQuery = useHomeInsightsSummary();
  const catalogQuery = useHomeCatalog();
  const benchmarkReported = useRef(false);
  useEffect(() => {
    if (benchmarkReported.current) return;
    const queries = [
      workspacesQuery,
      doctorSummariesQuery,
      installationsQuery,
      memoriesQuery,
      discoveryQuery,
      activityQuery,
      insightsQuery,
      catalogQuery,
    ];
    if (!runtime) return;
    const outcome = homeBenchmarkOutcome(queries);
    if (outcome === "pending") return;
    benchmarkReported.current = true;
    void desktopApi()
      .benchmark.mark(outcome === "ready" ? "home-data-ready" : "home-data-failed")
      .catch(() => undefined);
  }, [
    activityQuery,
    catalogQuery,
    discoveryQuery,
    doctorSummariesQuery,
    insightsQuery,
    installationsQuery,
    memoriesQuery,
    runtime,
    workspacesQuery,
  ]);
  const doctorSummaries = doctorSummariesQuery.data ?? {};
  const installations = installationsQuery.data ?? [];
  const globalMemories = memoriesQuery.data ?? [];
  const discovery = discoveryQuery.data;
  const activity = activityQuery.data ?? [];
  const insightsSummary = insightsQuery.data;
  const catalog = catalogQuery.data ?? [];
  const groupedCatalog = groupCatalogAssets(catalog);
  const assetCounts = workspaceAssetCounts(groupedCatalog);
  const openWorkspace = async (workspace: WorkspaceSummary, page = "overview") => {
    const path =
      page === "overview" ? "/workspace/$workspaceId" : "/workspace/$workspaceId/" + page;
    await navigate({ to: path as never, params: { workspaceId: workspace.id } as never });
  };
  const addScanRoot = async () => {
    const selected = await api.pickDirectory();
    if (typeof selected === "string") {
      await api.addScanRoot(selected, 5);
      await api.requestRefresh("discovery", true);
    }
  };
  if (workspacesQuery.isPending) return <HomeSkeleton />;
  return (
    <GlobalHome
      workspaces={workspaces}
      doctorSummaries={doctorSummaries}
      installations={installations}
      memories={globalMemories}
      discovery={discovery}
      activity={activity}
      insights={insightsSummary}
      uniqueAssetCount={groupedCatalog.filter((asset) => asset.scope === "workspace").length}
      assetCounts={assetCounts}
      onShowInsights={() => void navigate({ to: "/insights" })}
      onShowWorkspaces={() => void navigate({ to: "/workspaces" })}
      onShowAgents={() => void navigate({ to: "/agents" })}
      recentContinuations={recentContinuations}
      onContinue={(workspace) => openWorkspace(workspace, "sessions")}
      onOpen={openWorkspace}
      onOpenDoctor={(workspace) => openWorkspace(workspace, "doctor")}
      onOpenAssets={(section) =>
        void navigate({ to: "/catalog", search: { assetSection: section } as never })
      }
      onAddRoot={addScanRoot}
      onRefresh={() => {
        void Promise.all([
          api.requestRefresh("discovery", true),
          api.requestRefresh("insights", true),
        ]);
      }}
      runtime={runtime}
      onRuntimeChanged={setRuntime}
    />
  );
}

export const Route = createFileRoute("/")({ component: HomeRoute });
