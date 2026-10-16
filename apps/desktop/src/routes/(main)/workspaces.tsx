import { useI18n } from "@/core/useI18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useAppDialogs } from "@/components/AppDialogProvider";
import { Button } from "@/components/ui/button";
import { WorkspacesSkeleton } from "@/features/workspace/WorkspaceSkeleton";
import { WorkspacesLoadError, WorkspacesPage } from "@/features/workspace/WorkspacesPage";
import { api } from "@/core/api";
import { groupCatalogAssets, workspaceAssetCounts } from "@/features/catalog/catalog";
import { tr } from "@/core/i18n";
import {
  homeKeys,
  useHomeCatalog,
  useHomeDiscovery,
  useHomeRefreshJobs,
  useHomeWorkspaces,
} from "@/features/home/home-query";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import type { WorkspaceView } from "@/features/workspace/workspace-page-types";
import type { WorkspaceSummary } from "@/core/types";
import { useAppStore } from "@/stores/app-store";

type WorkspacesSearch = { workspaceView?: WorkspaceView };

function WorkspacesRoute() {
  const { localizeMessage } = useI18n();
  const navigate = useNavigate();
  const dialogs = useAppDialogs();
  const favoriteWorkspaceIds = useAppStore((state) => state.favoriteWorkspaceIds);
  const toggleFavoriteWorkspace = useAppStore((state) => state.toggleFavoriteWorkspace);
  const queryClient = useQueryClient();
  const search = useSearch({ strict: false }) as WorkspacesSearch;
  const view = search.workspaceView ?? "list";
  const workspacesQuery = useHomeWorkspaces();
  const workspaces = workspacesQuery.data ?? [];
  const { data: discovery } = useHomeDiscovery();
  const catalogQuery = useHomeCatalog();
  const catalog = catalogQuery.data ?? [];
  const { data: refreshJobs = [] } = useHomeRefreshJobs();
  const [refreshingWorkspaceIds, setRefreshingWorkspaceIds] = useState<string[]>([]);
  const openRequest = useRef(0);
  const retryPending = useRef(false);
  const {
    setProject,
    setSelectedWorkspace,
    setScan,
    setManifest,
    setBaselineManifest,
    setChangeSet,
    setChangeSetOrigin,
    setHandoffLaunchRequest,
    setMessage,
  } = useWorkspaceStore();
  const assetCounts = useMemo(() => workspaceAssetCounts(groupCatalogAssets(catalog)), [catalog]);
  const discoveryRefreshing = refreshJobs.some(
    (job) => job.kind === "discovery" && (job.state === "queued" || job.state === "running"),
  );
  const storageJob = refreshJobs.find((job) => job.kind === "storage");

  useEffect(
    () => () => {
      openRequest.current += 1;
    },
    [],
  );

  const setView = (nextView: WorkspaceView) => {
    void navigate({
      to: "/workspaces",
      search: (current) => ({ ...current, workspaceView: nextView }) as never,
    });
  };

  const openWorkspace = async (workspace: WorkspaceSummary) => {
    const requestId = ++openRequest.current;
    setMessage("");
    if (requestId !== openRequest.current) return;
    setChangeSet(undefined);
    setChangeSetOrigin("standard");
    setHandoffLaunchRequest(undefined);
    setProject(workspace.path);
    setScan(undefined);
    setManifest(undefined);
    setBaselineManifest("");
    setSelectedWorkspace(workspace);
    await navigate({
      to: "/workspace/$workspaceId",
      params: { workspaceId: workspace.id },
    });
  };

  const addWorkspace = async () => {
    if (useWorkspaceStore.getState().applyingChanges) {
      await dialogs.notify(tr("workspace.changesApplying"));
      return;
    }
    const selected = await api.pickDirectory(tr("dialog.addWorkspace"));
    if (typeof selected !== "string") return;
    try {
      if (useWorkspaceStore.getState().applyingChanges) {
        await dialogs.notify(tr("workspace.changesApplying"));
        return;
      }
      setMessage("");
      const workspace = await api.addWorkspace(selected);
      await queryClient.invalidateQueries({ queryKey: homeKeys.all });
      if (useWorkspaceStore.getState().applyingChanges) {
        await dialogs.notify(tr("workspace.changesApplying"));
        return;
      }
      await openWorkspace(workspace);
    } catch (error) {
      setMessage(localizeMessage(error));
    }
  };

  const refreshDiscovery = async () => {
    try {
      await api.requestRefresh("discovery", true);
    } catch (error) {
      setMessage(localizeMessage(error));
    }
  };

  const refreshWorkspace = async (id: string) => {
    setRefreshingWorkspaceIds((current) => (current.includes(id) ? current : [...current, id]));
    try {
      await api.refreshWorkspace(id);
      await queryClient.invalidateQueries({ queryKey: homeKeys.workspaces() });
    } catch (error) {
      setMessage(localizeMessage(error));
    } finally {
      setRefreshingWorkspaceIds((current) => current.filter((workspaceId) => workspaceId !== id));
    }
  };

  const excludeWorkspace = async (id: string) => {
    if (
      !(await dialogs.confirm({ description: tr("workspace.ignoreConfirm"), tone: "destructive" }))
    ) {
      return;
    }
    try {
      await api.excludeWorkspace(id);
      await queryClient.invalidateQueries({ queryKey: homeKeys.all });
    } catch (error) {
      setMessage(localizeMessage(error));
    }
  };

  const failed = [
    { labelKey: "query.workspaces", query: workspacesQuery },
    { labelKey: "query.catalog", query: catalogQuery },
  ].filter(({ query }) => query.isError);
  const retryFailed = async () => {
    if (retryPending.current) return;
    retryPending.current = true;
    try {
      await Promise.allSettled(failed.map(({ query }) => query.refetch()));
    } finally {
      retryPending.current = false;
    }
  };
  if (workspacesQuery.isError && workspacesQuery.data === undefined) {
    return (
      <WorkspacesLoadError
        retrying={workspacesQuery.isFetching}
        onRetry={() => void retryFailed()}
      />
    );
  }
  if (workspacesQuery.isPending && workspacesQuery.data === undefined)
    return <WorkspacesSkeleton view={view} />;

  return (
    <div className="grid gap-4">
      {failed.length > 0 && (
        <section
          role="alert"
          className="grid gap-3 rounded-xl border border-destructive/30 bg-card p-5"
        >
          <h2 className="text-base font-semibold">{tr("query.loadFailed")}</h2>
          <p className="text-sm text-muted-foreground">
            {tr(
              failed.some(({ query }) => query.data === undefined)
                ? "query.initialUnavailable"
                : "query.staleData",
            )}
          </p>
          <ul className="list-inside list-disc text-sm">
            {failed.map(({ labelKey }) => (
              <li key={labelKey}>{tr(labelKey)}</li>
            ))}
          </ul>
          <Button
            className="justify-self-start"
            disabled={failed.some(({ query }) => query.isFetching)}
            onClick={() => void retryFailed()}
          >
            {tr("runtime.retry")}
          </Button>
        </section>
      )}
      <WorkspacesPage
        view={view}
        storageJob={storageJob}
        workspaces={workspaces}
        favoriteWorkspaceIds={favoriteWorkspaceIds}
        onToggleFavorite={toggleFavoriteWorkspace}
        discovery={discovery}
        assetCounts={assetCounts}
        catalogPending={catalogQuery.isPending}
        catalogError={catalogQuery.isError && catalogQuery.data === undefined}
        discoveryRefreshing={discoveryRefreshing}
        refreshingWorkspaceIds={refreshingWorkspaceIds}
        onAddWorkspace={() => void addWorkspace()}
        onViewChange={setView}
        onOpen={openWorkspace}
        onRefreshDiscovery={() => void refreshDiscovery()}
        onOpenDiscoveryDetails={() =>
          void navigate({
            to: "/settings",
            search: { settingsSection: "discovery", settingsTarget: "discovery-status" },
          })
        }
        onRefreshWorkspace={refreshWorkspace}
        onExclude={excludeWorkspace}
      />
    </div>
  );
}

export { discoveryStatusSummary } from "@/features/workspace/WorkspacesPage";

export const Route = createFileRoute("/(main)/workspaces")({
  staticData: { appRoute: { kind: "global", page: "workspaces" } },
  component: WorkspacesRoute,
});
