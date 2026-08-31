import { useEffect, useRef } from "react";
import {
  createFileRoute,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import {
  Award,
  Bot,
  Boxes,
  Clock3,
  Code2,
  FolderGit2,
  Gauge,
  GitBranch,
  GitCommitHorizontal,
  GitCompareArrows,
  Home,
  LayoutDashboard,
  Library,
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
} from "@/features/workspace/WorkspaceSkeleton";
import { AppSidebar, type SidebarEntry } from "@/components/AppSidebar";
import { AppShellHeader } from "@/features/app/AppShell";
import { useAppDialogs } from "@/components/AppDialogProvider";
import { WindowToolbar } from "@/components/WindowToolbar";
import { useAppStore } from "../../../stores/app-store";
import { useHomeMemories, useHomeWorkspaces } from "@/features/home/home-query";
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
      value: workspace.last_active_at
        ? formatRelativeTime(workspace.last_active_at)
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

type GlobalPage = "home" | "workspaces" | "catalog" | "agents" | "quota" | "insights";
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
const globalNav: SidebarEntry<GlobalPage>[] = [
  { id: "home", label: "nav.home", icon: Home, shortcut: "navigate-home" },
  {
    id: "workspaces",
    label: "nav.workspaces",
    icon: FolderGit2,
    shortcut: "navigate-workspaces",
  },
  { id: "catalog", label: "nav.assets", icon: Library, shortcut: "navigate-catalog" },
  { id: "agents", label: "nav.agents", icon: Bot, shortcut: "navigate-agents" },
  { id: "quota", label: "nav.quota", icon: Gauge, shortcut: "navigate-quota" },
  { id: "insights", label: "nav.insights", icon: Award, shortcut: "navigate-insights" },
];

function WorkspaceLayout() {
  const dialogs = useAppDialogs();
  const navigate = useNavigate();
  const location = useLocation();
  const { workspaceId } = useParams({ from: "/workspace/$workspaceId" });
  const app = useAppStore();
  const workspaceState = useWorkspaceStore();
  const { data: workspaces = [], isPending: workspacesPending } = useHomeWorkspaces();
  const { data: globalMemories = [] } = useHomeMemories();
  const workspace = workspaces.find((item) => item.id === workspaceId);
  const { setRuntime } = app;
  const {
    project,
    selectedWorkspace,
    scan,
    manifest,
    changeSet,
    baselineManifest,
    busy,
    message,
    setScan,
    setManifest,
    setChangeSet,
    setChangeSetOrigin,
    setHandoffLaunchRequest,
    setBaselineManifest,
    setWorkspaceDrafts,
    setBusy,
    setMessage,
    resetWorkspace,
  } = workspaceState;
  const currentPage = getPage(location.pathname);
  const activeWorkspace =
    workspace ??
    (workspacesPending && selectedWorkspace?.id === workspaceId ? selectedWorkspace : undefined);
  const hasUnsavedDraft = Boolean(
    manifest && baselineManifest && JSON.stringify(manifest) !== baselineManifest,
  );
  const operationRequest = useRef(0);

  useEffect(() => {
    operationRequest.current += 1;
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
      const [nextScan, nextManifest, nextRuntime] = await Promise.all([
        api.scan(targetProject),
        api.manifest(targetProject),
        api.runtime(),
      ]);
      if (!isCurrentRequest()) return;
      setScan(nextScan);
      setManifest(draft ?? nextManifest);
      setBaselineManifest(JSON.stringify(nextManifest));
      setRuntime(nextRuntime);
    } catch (error) {
      if (isCurrentRequest()) setMessage(localizeMessage(error));
    } finally {
      if (isCurrentRequest()) setBusy(false);
    }
  };

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

  const leaveWorkspace = async (next: () => void) => {
    if (useWorkspaceStore.getState().applyingChanges) {
      await dialogs.notify(tr("dialog.quit.changesApplying"));
      return;
    }
    if (
      hasUnsavedDraft &&
      !(await dialogs.confirm({
        description: tr("workspace.leaveDraftConfirm"),
        tone: "destructive",
      }))
    )
      return;
    if (useWorkspaceStore.getState().applyingChanges) {
      await dialogs.notify(tr("dialog.quit.changesApplying"));
      return;
    }
    setWorkspaceDrafts((drafts) => {
      const nextDrafts = { ...drafts };
      delete nextDrafts[workspaceId];
      return nextDrafts;
    });
    resetWorkspace();
    next();
  };

  const navigateGlobal = (page: GlobalPage) => {
    void leaveWorkspace(() => navigate({ to: (page === "home" ? "/" : `/${page}`) as never }));
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

  const navigation = globalNav.map((entry) =>
    entry.id === "catalog"
      ? { ...entry, badge: globalMemories.filter((item) => item.status === "pending").length }
      : entry,
  );
  const sidebarCollapsed = app.sidebarCollapsed;
  const shellClass = cn(
    "group app-shell !grid !h-full !w-full !min-h-0 !overflow-hidden",
    sidebarCollapsed && "app-shell-sidebar-collapsed",
  );
  const mainClass =
    "app-shell-main !col-start-2 !row-start-3 !flex !min-h-0 !min-w-0 !h-full !flex-col !overflow-hidden !text-sm";
  const contentClass =
    "content !mx-auto !max-w-[1540px] !px-7 !pb-10 !pt-[22px] max-[900px]:!px-[18px]";

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
    <div className={shellClass}>
      <WindowToolbar />
      <AppShellHeader />
      <AppSidebar
        active="workspaces"
        collapsed={sidebarCollapsed}
        entries={navigation}
        onNavigate={navigateGlobal}
        onSettings={() => {
          if (useWorkspaceStore.getState().applyingChanges) {
            void dialogs.notify(tr("dialog.quit.changesApplying"));
            return;
          }
          void navigate({
            to: "/settings",
            search: (current) => ({ ...current, settingsSection: "general" }) as never,
          });
        }}
        onBrandClick={() => navigateGlobal("home")}
      />
      <main className={mainClass}>
        <div className="page-scroll-container min-h-0 flex-1">
          {message && (
            <div className="mx-7 mt-3 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {message}
            </div>
          )}
          <div className={cn(contentClass, "grid gap-4 pt-5")}>
            <section className="flex flex-col gap-4 rounded-2xl border border-border/70 bg-card px-5 py-4 shadow-sm md:flex-row md:items-center md:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-foreground text-background">
                  <FolderGit2 size={21} />
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h1 className="truncate text-lg font-semibold tracking-tight text-foreground">
                      {activeWorkspace.name}
                    </h1>
                    <Badge
                      variant={activeWorkspace.status === "attention" ? "destructive" : "secondary"}
                    >
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
            {scan && <WorkspaceSummaryStrip workspace={activeWorkspace} scan={scan} />}
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
            <section
              className={cn("min-w-0", currentPage === "git" && "min-h-[calc(100vh-170px)]")}
            >
              {busy || (currentPage !== "doctor" && (!scan || !manifest)) ? (
                <WorkspacePageSkeleton page={currentPage} />
              ) : (
                <Outlet />
              )}
            </section>
          </div>
        </div>
      </main>
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
