import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  createFileRoute,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import {
  Bot,
  Boxes,
  Clock3,
  Code2,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  GitCompareArrows,
  LayoutDashboard,
  MessageSquareText,
  ShieldCheck,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  WorkspaceAssetsSkeleton,
  WorkspaceChangesSkeleton,
  WorkspaceContextSkeleton,
  WorkspaceDoctorSkeleton,
  WorkspaceGitSkeleton,
  WorkspaceLayoutSkeleton,
  WorkspaceOverviewSkeleton,
  WorkspaceSessionsSkeleton,
  WorkspaceSummaryStripSkeleton,
} from "@/features/workspace/WorkspaceSkeleton";
import { useAppDialogs } from "@/components/AppDialogProvider";
import { useAppStore } from "../../../stores/app-store";
import { homeKeys, useHomeWorkspaces } from "@/features/home/home-query";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import { api } from "../../../core/api";
import { formatRelativeTime, localizeMessage, tr } from "../../../core/i18n";
import { cn } from "@/lib/utils";
import type { Manifest, WorkspaceScan, WorkspaceSummary } from "../../../core/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { WorkspaceOpenWith } from "@/features/workspace/WorkspaceOpenWith";
import { Copy, MoreHorizontal, RefreshCw } from "lucide-react";
function WorkspaceActions({
  workspace,
  onError,
  onScan,
  busy,
  onReview,
  reviewDisabled,
}: {
  workspace: WorkspaceSummary;
  onError: (message: string) => void;
  onScan: () => void | Promise<void>;
  busy: boolean;
  onReview: () => void | Promise<void>;
  reviewDisabled: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5 md:gap-2">
      {workspace.status === "attention" && (
        <Badge variant="outline" className="mr-1 border-amber-500/30 bg-amber-500/5 text-amber-700">
          {workspaceStatusLabel("attention")}
        </Badge>
      )}
      <WorkspaceOpenWith workspace={workspace} onError={onError} />
      <DropdownMenu>
        <DropdownMenuTrigger
          className="inline-flex size-9 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title={tr("common.moreActions")}
          aria-label={tr("common.moreActions")}
        >
          <MoreHorizontal size={16} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => void navigator.clipboard?.writeText(workspace.path)}>
            <Copy size={13} />
            {tr("workspace.copyPath")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        variant="outline"
        size="icon"
        className="size-9 rounded-lg"
        title={tr("common.scan")}
        aria-label={tr("common.scan")}
        onClick={() => void onScan()}
        disabled={busy}
      >
        <RefreshCw size={15} className={busy ? "animate-spin" : ""} />
      </Button>
      <Button
        className="h-9 rounded-lg px-3"
        onClick={() => void onReview()}
        disabled={reviewDisabled}
      >
        <GitCompareArrows size={15} />
        {tr("workspace.reviewChanges")}
      </Button>
    </div>
  );
}

function workspaceStatusLabel(status: WorkspaceSummary["status"]) {
  return tr(`status.workspace.${status}`);
}

function WorkspaceSummaryStrip({
  workspace,
  scan,
}: {
  workspace: WorkspaceSummary;
  scan: WorkspaceScan;
}) {
  const metrics = [
    { label: tr("common.assets"), value: workspace.asset_count, icon: Boxes },
    {
      label: tr("nav.agents"),
      value: scan.agents.filter((agent) => agent.detected).length,
      icon: Bot,
    },
    { label: tr("workspace.discoverySources"), value: workspace.sources.length, icon: GitBranch },
    {
      label: tr("workspace.lastScanLabel"),
      value: workspace.last_scanned_at
        ? formatRelativeTime(workspace.last_scanned_at)
        : tr("common.never"),
      icon: Clock3,
    },
  ];
  return (
    <div className="grid grid-cols-4 gap-3 max-[800px]:grid-cols-2">
      {metrics.map(({ label, value, icon: Icon }) => (
        <div
          className="flex min-h-[76px] items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-[0_8px_24px_-20px_rgba(15,23,42,.45)]"
          key={label}
        >
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/8 text-primary">
            <Icon size={17} />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-xs font-medium text-muted-foreground">
              {label}
            </span>
            <strong className="mt-1 block truncate text-lg font-semibold tabular-nums tracking-[-.02em]">
              {value}
            </strong>
          </span>
        </div>
      ))}
    </div>
  );
}

type Page = "overview" | "sessions" | "git" | "assets" | "context" | "doctor" | "changes";
const workspaceTabs = [
  ["overview", "nav.overview", LayoutDashboard],
  ["sessions", "nav.sessions", MessageSquareText],
  ["git", "nav.git", GitCommitHorizontal],
  ["assets", "nav.assets", Boxes],
  ["context", "nav.context", Code2],
  ["doctor", "nav.doctor", ShieldCheck],
  ["changes", "nav.changes", GitCompareArrows],
] as const;
function WorkspaceLayout() {
  const dialogs = useAppDialogs();
  const navigate = useNavigate();
  const location = useLocation();
  const { workspaceId } = useParams({ from: "/workspace/$workspaceId" });
  const setRuntime = useAppStore((state) => state.setRuntime);
  const workspaceState = useWorkspaceStore();
  const queryClient = useQueryClient();
  const { data: workspaces = [], isPending: workspacesPending } = useHomeWorkspaces();
  const workspace = workspaces.find((item) => item.id === workspaceId);
  const {
    project,
    selectedWorkspace,
    scan,
    manifest,
    changeSet,
    baselineManifest,
    busy,
    setScan,
    setManifest,
    setChangeSet,
    setChangeSetOrigin,
    setHandoffLaunchRequest,
    setBaselineManifest,
    workspaceDrafts,
    setBusy,
    setMessage,
  } = workspaceState;
  const currentPage = getPage(location.pathname);
  const activeWorkspace =
    workspace ?? (selectedWorkspace?.id === workspaceId ? selectedWorkspace : undefined);
  const hasUnsavedDraft = Boolean(
    manifest && baselineManifest && JSON.stringify(manifest) !== baselineManifest,
  );
  const operationRequest = useRef(0);
  const loadStartedWorkspace = useRef<string | undefined>(undefined);

  useEffect(() => {
    operationRequest.current += 1;
    loadStartedWorkspace.current = undefined;
    return () => {
      operationRequest.current += 1;
    };
  }, [workspaceId]);

  const loadWorkspace = async (draft?: Manifest) => {
    if (!project) return;
    const requestId = ++operationRequest.current;
    const targetProject = project;
    const isCurrentRequest = () =>
      requestId === operationRequest.current &&
      useWorkspaceStore.getState().selectedWorkspace?.id === workspaceId &&
      useWorkspaceStore.getState().project === targetProject;
    setBusy(true);
    setMessage("");
    try {
      const [scanResult, manifestResult, runtimeResult] = await Promise.allSettled([
        api.scan(targetProject),
        api.manifest(targetProject),
        api.runtime(),
      ]);
      if (!isCurrentRequest()) return;
      if (scanResult.status === "rejected") throw scanResult.reason;
      if (runtimeResult.status === "rejected") throw runtimeResult.reason;
      const nextScan = scanResult.value;
      const nextManifest = manifestResult.status === "fulfilled" ? manifestResult.value : undefined;
      const resolvedManifest = draft ?? nextManifest;
      if (manifestResult.status === "rejected") setMessage(localizeMessage(manifestResult.reason));
      setScan(nextScan);
      setManifest(resolvedManifest);
      setBaselineManifest(nextManifest ? JSON.stringify(nextManifest) : "");
      setRuntime(runtimeResult.value);
      await queryClient.invalidateQueries({ queryKey: homeKeys.workspaces() });
      if (!resolvedManifest && currentPage !== "doctor") {
        void navigate({
          to: "/workspace/$workspaceId/doctor",
          params: { workspaceId },
        });
      }
    } catch (error) {
      if (isCurrentRequest()) setMessage(localizeMessage(error));
    } finally {
      if (isCurrentRequest()) setBusy(false);
    }
  };

  useEffect(() => {
    if (
      !activeWorkspace ||
      !project ||
      project !== activeWorkspace.path ||
      (scan && manifest) ||
      loadStartedWorkspace.current === workspaceId
    )
      return;
    loadStartedWorkspace.current = workspaceId;
    void loadWorkspace(workspaceDrafts[workspaceId]);
  }, [activeWorkspace, manifest, project, scan, workspaceDrafts, workspaceId]);

  const plan = async (includeHome = false) => {
    if (!project || !manifest) return;
    const requestId = ++operationRequest.current;
    const targetProject = project;
    const targetManifest = manifest;
    const isCurrentRequest = () =>
      requestId === operationRequest.current &&
      useWorkspaceStore.getState().selectedWorkspace?.id === workspaceId &&
      useWorkspaceStore.getState().project === targetProject;
    setBusy(true);
    setMessage("");
    try {
      const nextChangeSet = await api.plan(targetProject, targetManifest, includeHome);
      if (!isCurrentRequest()) return;
      setChangeSet(nextChangeSet);
      setChangeSetOrigin("standard");
      setHandoffLaunchRequest(undefined);
      navigateWorkspace("changes");
    } catch (error) {
      if (isCurrentRequest()) setMessage(localizeMessage(error));
    } finally {
      if (isCurrentRequest()) setBusy(false);
    }
  };

  const navigateWorkspace = (page: Page) => {
    if (useWorkspaceStore.getState().applyingChanges) {
      void dialogs.notify(tr("dialog.quit.changesApplying"));
      return;
    }
    const path =
      page === "overview" ? "/workspace/$workspaceId" : `/workspace/$workspaceId/${page}`;
    void navigate({
      to: path as never,
      params: { workspaceId } as never,
      search: (current) =>
        ({ ...current, ...(page === "git" ? {} : { gitSubview: undefined }) }) as never,
    });
  };

  if (!activeWorkspace) {
    return !workspacesPending ? (
      <div className="grid h-full min-h-[240px] place-items-center p-8 text-sm text-muted-foreground">
        {tr("common.notFound")}
      </div>
    ) : (
      <WorkspaceLayoutSkeleton />
    );
  }
  return (
    <div className="grid gap-4 pt-5">
      <section className="flex min-h-[86px] flex-col gap-4 rounded-2xl border border-border/70 bg-card px-5 py-4 shadow-sm md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-foreground text-background">
            <FolderGit2 size={21} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-lg font-semibold tracking-tight text-foreground">
                {activeWorkspace.name}
              </h1>
              <Badge variant={activeWorkspace.status === "attention" ? "destructive" : "secondary"}>
                {workspaceStatusLabel(activeWorkspace.status)}
              </Badge>
            </div>
            <code className="mt-1 block truncate text-xs text-muted-foreground">
              {activeWorkspace.path}
            </code>
          </div>
        </div>
        <WorkspaceActions
          workspace={activeWorkspace}
          onError={setMessage}
          onScan={() => loadWorkspace(manifest)}
          busy={busy}
          onReview={() => plan(false)}
          reviewDisabled={busy || !hasUnsavedDraft}
        />
      </section>
      {scan ? (
        <WorkspaceSummaryStrip workspace={activeWorkspace} scan={scan} />
      ) : (
        <WorkspaceSummaryStripSkeleton />
      )}
      <nav aria-label={activeWorkspace.name}>
        <Tabs value={currentPage} onValueChange={(value) => navigateWorkspace(value as Page)}>
          <TabsList className="segmented-control w-full justify-start" variant="default">
            {workspaceTabs.map(([id, label, Icon]) => (
              <TabsTrigger
                className="segmented-control-item h-9 min-h-9 flex-none px-3 text-xs sm:text-sm"
                key={id}
                value={id}
              >
                <Icon size={15} />
                {tr(label)}
                {id === "changes" && changeSet?.changes.length ? (
                  <em>{changeSet.changes.length}</em>
                ) : null}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </nav>
      <section className={cn("min-w-0", currentPage === "git" && "min-h-[calc(100vh-170px)]")}>
        {busy || (currentPage !== "doctor" && (!scan || !manifest)) ? (
          <WorkspacePageSkeleton page={currentPage} />
        ) : (
          <Outlet />
        )}
      </section>
    </div>
  );
}

function getPage(pathname: string): Page {
  const value = pathname.split("/").filter(Boolean).at(-1);
  return value === "sessions" ||
    value === "git" ||
    value === "assets" ||
    value === "context" ||
    value === "doctor" ||
    value === "changes"
    ? value
    : "overview";
}

function WorkspacePageSkeleton({ page }: { page: Page }) {
  switch (page) {
    case "assets":
      return <WorkspaceAssetsSkeleton />;
    case "changes":
      return <WorkspaceChangesSkeleton />;
    case "context":
      return <WorkspaceContextSkeleton />;
    case "doctor":
      return <WorkspaceDoctorSkeleton />;
    case "git":
      return <WorkspaceGitSkeleton />;
    case "sessions":
      return <WorkspaceSessionsSkeleton />;
    default:
      return <WorkspaceOverviewSkeleton />;
  }
}

export const Route = createFileRoute("/workspace/$workspaceId")({ component: WorkspaceLayout });
