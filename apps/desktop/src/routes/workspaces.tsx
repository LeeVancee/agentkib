import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { SelectControl } from "@/components/ui/select-control";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useAppDialogs } from "@/components/AppDialogProvider";
import { WorkspaceStoragePage } from "@/features/workspace/WorkspaceStoragePage";
import { WorkspacesSkeleton } from "@/features/workspace/WorkspaceSkeleton";
import { api } from "../core/api";
import { refreshGlobalState } from "../core/global-state";
import { groupCatalogAssets, workspaceAssetCounts } from "@/features/catalog/catalog";
import { formatRelativeTime, localizeMessage, tr } from "../core/i18n";
import { useAppStore } from "../stores/app-store";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import { ChevronRight, FolderGit2, MoreHorizontal, RefreshCw, Search, Trash2 } from "lucide-react";
import type { AgentKind, Manifest, RefreshJobStatus, WorkspaceSummary } from "../core/types";
import { cn } from "@/lib/utils";

type WorkspaceView = "list" | "storage";
type WorkspacesSearch = { workspaceView?: WorkspaceView };
const agentLabels: Record<AgentKind, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  cursor: "Cursor",
  "open-claw": "OpenClaw",
  hermes: "Hermes",
  "deepseek-harness": "DeepSeek Harness",
};

function WorkspacesRoute() {
  const navigate = useNavigate();
  const dialogs = useAppDialogs();
  const search = useSearch({ strict: false }) as WorkspacesSearch;
  const view = search.workspaceView ?? "list";
  const workspaces = useAppStore((state) => state.workspaces);
  const workspacesLoaded = useAppStore((state) => state.workspacesLoaded);
  const catalog = useAppStore((state) => state.catalog);
  const refreshJobs = useAppStore((state) => state.refreshJobs);
  const setRuntime = useAppStore((state) => state.setRuntime);
  const openRequest = useRef(0);
  const {
    setProject,
    setSelectedWorkspace,
    setScan,
    setManifest,
    setBaselineManifest,
    setChangeSet,
    setChangeSetOrigin,
    setHandoffLaunchRequest,
    setBusy,
    setMessage,
    workspaceDrafts,
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
    setBusy(true);
    setMessage("");
    try {
      const runtimePromise = useAppStore.getState().runtime
        ? Promise.resolve(useAppStore.getState().runtime)
        : api.runtime();
      const [nextScan, nextRuntime] = await Promise.all([api.scan(workspace.path), runtimePromise]);
      if (requestId !== openRequest.current) return;
      let nextManifest: Manifest | undefined;
      try {
        nextManifest = await api.manifest(workspace.path);
      } catch (error) {
        if (requestId === openRequest.current) setMessage(localizeMessage(error));
      }
      if (requestId !== openRequest.current) return;
      setChangeSet(undefined);
      setChangeSetOrigin("standard");
      setHandoffLaunchRequest(undefined);
      setProject(workspace.path);
      setScan(nextScan);
      setManifest(nextManifest ? (workspaceDrafts[workspace.id] ?? nextManifest) : undefined);
      setBaselineManifest(nextManifest ? JSON.stringify(nextManifest) : "");
      setRuntime(nextRuntime);
      setSelectedWorkspace(workspace);
      setBusy(false);
      await navigate({
        to: nextManifest ? "/workspace/$workspaceId" : "/workspace/$workspaceId/doctor",
        params: { workspaceId: workspace.id },
      });
    } catch (error) {
      if (requestId === openRequest.current) setMessage(localizeMessage(error));
    } finally {
      if (requestId === openRequest.current) setBusy(false);
    }
  };

  const addWorkspace = async () => {
    if (useWorkspaceStore.getState().applyingChanges) {
      await dialogs.notify(tr("dialog.quit.changesApplying"));
      return;
    }
    const selected = await api.pickDirectory(tr("dialog.addWorkspace"));
    if (typeof selected !== "string") return;
    try {
      if (useWorkspaceStore.getState().applyingChanges) {
        await dialogs.notify(tr("dialog.quit.changesApplying"));
        return;
      }
      setMessage("");
      const workspace = await api.addWorkspace(selected);
      await refreshGlobalState(useAppStore.getState().runtime);
      if (useWorkspaceStore.getState().applyingChanges) {
        await dialogs.notify(tr("dialog.quit.changesApplying"));
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
    try {
      await api.refreshWorkspace(id);
      await refreshGlobalState(useAppStore.getState().runtime);
    } catch (error) {
      setMessage(localizeMessage(error));
    }
  };

  const excludeWorkspace = async (id: string) => {
    if (
      !(await dialogs.confirm({ description: tr("workspace.ignoreConfirm"), tone: "destructive" }))
    )
      return;
    try {
      await api.excludeWorkspace(id);
      await refreshGlobalState(useAppStore.getState().runtime);
    } catch (error) {
      setMessage(localizeMessage(error));
    }
  };

  if (!workspacesLoaded) return <WorkspacesSkeleton view={view} />;

  return (
    <WorkspacesPage
      view={view}
      storageJob={storageJob}
      workspaces={workspaces}
      assetCounts={assetCounts}
      discoveryRefreshing={discoveryRefreshing}
      onAddWorkspace={() => void addWorkspace()}
      onViewChange={setView}
      onOpen={openWorkspace}
      onRefreshDiscovery={refreshDiscovery}
      onRefreshWorkspace={refreshWorkspace}
      onExclude={excludeWorkspace}
    />
  );
}

function WorkspacesPage({
  view,
  storageJob,
  workspaces,
  assetCounts,
  discoveryRefreshing,
  onAddWorkspace,
  onViewChange,
  onOpen,
  onRefreshDiscovery,
  onRefreshWorkspace,
  onExclude,
}: {
  view: WorkspaceView;
  storageJob?: RefreshJobStatus;
  workspaces: WorkspaceSummary[];
  assetCounts: Map<string, number>;
  discoveryRefreshing: boolean;
  onAddWorkspace: () => void;
  onViewChange: (view: WorkspaceView) => void;
  onOpen: (workspace: WorkspaceSummary) => Promise<void>;
  onRefreshDiscovery: () => Promise<void>;
  onRefreshWorkspace: (id: string) => Promise<void>;
  onExclude: (id: string) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | WorkspaceSummary["status"]>("all");
  const [agent, setAgent] = useState<"all" | AgentKind>("all");
  const filtered = workspaces.filter(
    (item) =>
      `${item.name} ${item.path}`.toLowerCase().includes(query.toLowerCase()) &&
      (status === "all" || item.status === status) &&
      (agent === "all" || item.sources.some((source) => source.agent === agent)),
  );
  const viewControls = (
    <div className="flex flex-wrap items-center gap-2">
      <ToggleGroup
        spacing={0}
        variant="default"
        size="sm"
        className="segmented-control shrink-0"
        value={[view]}
        onValueChange={(values) => {
          const value = values[0];
          if (value === "list" || value === "storage") onViewChange(value);
        }}
        aria-label={tr("workspace.viewLabel")}
      >
        <ToggleGroupItem
          value="list"
          className="segmented-control-item h-9 min-h-9 min-w-[68px] font-semibold"
        >
          {tr("workspace.view.list")}
        </ToggleGroupItem>
        <ToggleGroupItem
          value="storage"
          className="segmented-control-item h-9 min-h-9 min-w-[68px] font-semibold"
        >
          {tr("workspace.view.storage")}
        </ToggleGroupItem>
      </ToggleGroup>
      {view === "list" && (
        <Button className="h-9 rounded-lg px-3.5" onClick={onAddWorkspace}>
          <FolderGit2 size={15} />
          {tr("workspace.addManually")}
        </Button>
      )}
    </div>
  );
  const pageIntro = <section className="flex justify-end">{viewControls}</section>;
  const filterBar = (
    <Card className="overflow-hidden rounded-2xl border-border/70 bg-card shadow-sm">
      <CardContent className="grid gap-3 p-4 sm:p-5">
        <div className="grid gap-3 lg:grid-cols-[minmax(260px,1fr)_auto] lg:items-center">
          <div className="flex h-10 min-w-0 items-center gap-2 rounded-xl border border-input bg-background px-3 text-muted-foreground transition-[border-color,box-shadow] focus-within:border-primary/45 focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--primary)_10%,transparent)]">
            <Search size={16} />
            <Input
              className="!h-8 !border-0 !bg-transparent !px-0 !text-foreground !shadow-none placeholder:!text-muted-foreground focus-visible:!ring-0"
              aria-label={tr("workspace.searchPlaceholder")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={tr("workspace.searchPlaceholder")}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <SelectControl
              aria-label={tr("workspace.allAgents")}
              className="h-10 min-w-[146px] rounded-xl border-2 border-foreground/25 bg-card px-3 font-medium text-foreground shadow-xs hover:border-primary/65 hover:bg-muted/60 focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/20 max-[520px]:min-w-0 max-[520px]:flex-1"
              value={agent}
              onChange={(event) => setAgent(event.target.value as typeof agent)}
            >
              <option value="all">{tr("workspace.allAgents")}</option>
              {Object.entries(agentLabels).map(([value, label]) => (
                <option value={value} key={value}>
                  {label}
                </option>
              ))}
            </SelectControl>
            <SelectControl
              aria-label={tr("workspace.allStatuses")}
              className="h-10 min-w-[146px] rounded-xl border-2 border-foreground/25 bg-card px-3 font-medium text-foreground shadow-xs hover:border-primary/65 hover:bg-muted/60 focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/20 max-[520px]:min-w-0 max-[520px]:flex-1"
              value={status}
              onChange={(event) => setStatus(event.target.value as typeof status)}
            >
              <option value="all">{tr("workspace.allStatuses")}</option>
              <option value="healthy">{workspaceStatusLabel("healthy")}</option>
              <option value="attention">{workspaceStatusLabel("attention")}</option>
            </SelectControl>
            <Badge
              variant="secondary"
              className="h-8 rounded-lg px-2.5 text-xs tabular-nums text-muted-foreground"
            >
              {tr("workspace.resultCount", { count: filtered.length })}
            </Badge>
            <Button
              variant="outline"
              size="icon"
              className="size-10 rounded-xl"
              title={tr("workspace.refreshDiscovery")}
              aria-label={tr("workspace.refreshDiscovery")}
              aria-busy={discoveryRefreshing}
              onClick={() => void onRefreshDiscovery()}
              disabled={discoveryRefreshing}
            >
              <RefreshCw size={15} className={discoveryRefreshing ? "animate-spin" : ""} />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
  if (view === "storage")
    return (
      <div className="grid gap-5">
        {pageIntro}
        <WorkspaceStoragePage workspaces={workspaces} job={storageJob} />
      </div>
    );
  return (
    <div className="grid gap-4">
      {pageIntro}
      {filterBar}
      <Card className="overflow-hidden rounded-2xl border-border bg-card shadow-sm">
        <CardContent className="p-0">
          <Table className="min-w-[900px] border-separate border-spacing-0 [&_th]:h-[44px] [&_th]:bg-muted/25 [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-[.08em] [&_th]:text-muted-foreground [&_th]:whitespace-nowrap [&_th:first-child]:pl-5 [&_td]:h-[70px] [&_td]:text-sm [&_tr]:transition-colors">
            <TableHeader>
              <TableRow className="border-border-subtle hover:bg-transparent">
                <TableHead className="w-[44%]">{tr("workspace.projectColumn")}</TableHead>
                <TableHead>{tr("workspace.agentColumn")}</TableHead>
                <TableHead>{tr("workspace.assetsColumn")}</TableHead>
                <TableHead>{tr("workspace.activityColumn")}</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((workspace) => (
                <WorkspaceTableRow
                  key={workspace.id}
                  workspace={workspace}
                  assetCount={assetCounts.get(workspace.id)}
                  onOpen={onOpen}
                  onRefresh={onRefreshWorkspace}
                  onExclude={onExclude}
                />
              ))}
            </TableBody>
          </Table>
          {!filtered.length && (
            <WorkspaceEmptyState
              title={tr("workspace.noMatch")}
              text={tr("workspace.noMatchText")}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function WorkspaceTableRow({
  workspace,
  assetCount,
  onOpen,
  onRefresh,
  onExclude,
}: {
  workspace: WorkspaceSummary;
  assetCount?: number;
  onOpen: (workspace: WorkspaceSummary) => Promise<void>;
  onRefresh: (id: string) => Promise<void>;
  onExclude: (id: string) => Promise<void>;
}) {
  const sourceAgents = workspace.sources
    .map((source) => source.agent)
    .filter((value): value is AgentKind => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index);
  const agents =
    sourceAgents.map((value) => agentLabels[value]).join(" · ") ||
    (workspace.sources.length ? tr("workspace.source.scan") : tr("workspace.source.manual"));
  const count = assetCount ?? workspace.asset_count;
  return (
    <TableRow className="group transition-colors hover:bg-primary/[0.04] focus-within:bg-primary/[0.06]">
      <TableCell className="pl-[22px]">
        <Button
          variant="bare"
          size="content"
          className="group/project grid w-full grid-cols-[auto_minmax(0,1fr)] items-center justify-items-start gap-2.5 text-left"
          aria-label={`${workspace.name} · ${workspace.path}`}
          onClick={() => void onOpen(workspace)}
        >
          <span
            className="grid size-[34px] place-items-center rounded-[9px] border border-border/85 bg-primary/[0.07] text-muted-foreground transition-colors group-hover/project:border-primary/30 group-hover/project:bg-primary/[0.12] group-hover/project:text-foreground"
            aria-hidden="true"
          >
            <FolderGit2 size={16} />
          </span>
          <span className="grid min-w-0 justify-items-start gap-1">
            <strong className="text-[13px] font-semibold tracking-[-.01em] text-foreground">
              {workspace.name}
            </strong>
            <small
              className="block max-w-[min(520px,38vw)] truncate text-xs text-muted-foreground"
              title={workspace.path}
            >
              {workspace.path}
            </small>
          </span>
        </Button>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-1.5" aria-label={agents}>
          {sourceAgents.length ? (
            sourceAgents.map((value) => (
              <Badge
                className="rounded-[7px] border-0 bg-primary/[0.08] text-xs font-semibold text-foreground"
                variant="secondary"
                key={value}
              >
                {agentLabels[value]}
              </Badge>
            ))
          ) : (
            <Badge
              className="rounded-[7px] border-0 bg-primary/[0.08] text-xs font-semibold text-foreground"
              variant="secondary"
            >
              {agents}
            </Badge>
          )}
        </div>
      </TableCell>
      <TableCell>
        <strong className={cn("tabular-nums text-foreground", !count && "text-muted-foreground")}>
          {count}
        </strong>
      </TableCell>
      <TableCell className="text-muted-foreground">
        {workspace.last_active_at ? relativeTime(workspace.last_active_at) : tr("common.never")}
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-2">
          {workspace.status === "attention" && (
            <Badge className="mr-0.5" variant="destructive">
              {workspaceStatusLabel("attention")}
            </Badge>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger
              className="inline-flex size-9 items-center justify-center rounded-md border border-transparent text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title={tr("common.moreActions")}
              aria-label={`${workspace.name} · ${tr("common.moreActions")}`}
            >
              <MoreHorizontal size={15} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => void onRefresh(workspace.id)}>
                <RefreshCw size={13} />
                {tr("common.scan")}
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={() => void onExclude(workspace.id)}>
                <Trash2 size={13} />
                {tr("workspace.ignore")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <ChevronRight
            className="text-muted-foreground opacity-55 transition-[opacity,transform] group-hover:translate-x-0.5 group-hover:opacity-100"
            size={15}
          />
        </div>
      </TableCell>
    </TableRow>
  );
}

function WorkspaceEmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div className="grid min-h-[260px] place-content-center justify-items-center gap-1.5 p-[30px] text-center text-muted-foreground">
      <FolderGit2 size={28} className="mb-1.5" />
      <h3 className="m-0 text-[13px] font-semibold text-foreground">{title}</h3>
      <p className="m-0 max-w-[380px] leading-relaxed">{text}</p>
    </div>
  );
}
function workspaceStatusLabel(status: WorkspaceSummary["status"]) {
  return tr(`status.workspace.${status}`);
}
function relativeTime(value: string) {
  return formatRelativeTime(value);
}

export const Route = createFileRoute("/workspaces")({ component: WorkspacesRoute });
