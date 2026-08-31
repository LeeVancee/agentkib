import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { GlobalHome } from "@/features/home/GlobalHome";
import { HomeSkeleton } from "@/features/home/HomeSkeleton";
import { api } from "../core/api";
import { groupCatalogAssets, workspaceAssetCounts } from "@/features/catalog/catalog";
import { useAppStore } from "../stores/app-store";
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
  const workspaces = workspacesQuery.data ?? [];
  const doctorSummariesQuery = useHomeDoctorSummaries(workspaces.map((workspace) => workspace.id));
  const installationsQuery = useHomeInstallations();
  const memoriesQuery = useHomeMemories();
  const discoveryQuery = useHomeDiscovery();
  const activityQuery = useHomeActivity();
  const insightsQuery = useHomeInsightsSummary();
  const catalogQuery = useHomeCatalog();
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
