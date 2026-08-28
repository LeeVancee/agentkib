import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { GlobalHome } from "@/features/home/GlobalHome";
import { HomeSkeleton } from "@/features/home/HomeSkeleton";
import { api } from "../core/api";
import { groupCatalogAssets, workspaceAssetCounts } from "@/features/catalog/catalog";
import { useAppStore } from "../stores/app-store";
import type { WorkspaceSummary } from "../core/types";

function HomeRoute() {
  const navigate = useNavigate();
  const {
    workspaces,
    doctorSummaries,
    installations,
    globalMemories,
    discovery,
    activity,
    insightsSummary,
    catalog,
    workspacesLoaded,
    runtime,
    setRuntime,
  } = useAppStore();
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
  if (!workspacesLoaded) return <HomeSkeleton />;
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
      runtime={runtime}
      onRuntimeChanged={setRuntime}
    />
  );
}

export const Route = createFileRoute("/")({ component: HomeRoute });
