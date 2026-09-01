import {
  Brain,
  Check,
  CircleAlert,
  FileText,
  FolderGit2,
  History,
  Plus,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { formatDateTime, formatRelativeTime, tr } from "@/core/i18n";
import type {
  ActivityRecord,
  AgentInstallation,
  AgentKind,
  ContextDoctorSummary,
  DiscoveryReport,
  InsightsSummary,
  MemoryRecord,
  RuntimeInfo,
  WorkspaceSummary,
} from "@/core/types";
import { GettingStartedCard } from "./GettingStartedCard";

export type AssetSection = "instructions" | "skills" | "mcp" | "memory" | "other";
export interface RecentContinuation {
  workspace: WorkspaceSummary;
  sessionCount: number;
  agents: AgentKind[];
}

const agentLabels: Record<AgentKind, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  cursor: "Cursor",
  opencode: "OpenCode",
  "open-claw": "OpenClaw",
  hermes: "Hermes",
  "grok-build": "Grok Build",
  "deepseek-harness": "DeepSeek Harness",
};

export function GlobalHome({
  workspaces,
  doctorSummaries,
  installations,
  memories,
  discovery,
  activity,
  uniqueAssetCount,
  assetCounts,
  onShowInsights,
  onShowWorkspaces,
  onShowAgents,
  recentContinuations = [],
  onContinue,
  onOpen,
  onOpenDoctor,
  onOpenAssets,
  onAddRoot,
  onRefresh,
  runtime,
  onRuntimeChanged,
}: {
  workspaces: WorkspaceSummary[];
  doctorSummaries: Record<string, ContextDoctorSummary>;
  installations: AgentInstallation[];
  memories: MemoryRecord[];
  discovery?: DiscoveryReport;
  activity: ActivityRecord[];
  insights?: InsightsSummary;
  uniqueAssetCount: number;
  assetCounts: Map<string, number>;
  onShowInsights: () => void;
  onShowWorkspaces: () => void;
  onShowAgents: () => void;
  recentContinuations?: RecentContinuation[];
  onContinue?: (workspace: WorkspaceSummary) => Promise<void>;
  onOpen: (workspace: WorkspaceSummary) => Promise<void>;
  onOpenDoctor: (workspace: WorkspaceSummary) => Promise<void>;
  onOpenAssets: (section: AssetSection) => void;
  onAddRoot: () => Promise<void>;
  onRefresh: () => void;
  runtime?: RuntimeInfo;
  onRuntimeChanged: (runtime: RuntimeInfo) => void;
}) {
  const attention = workspaces.filter(
    (item) =>
      item.status === "attention" ||
      (doctorSummaries[item.id]?.error_count ?? 0) +
        (doctorSummaries[item.id]?.warning_count ?? 0) >
        0,
  );
  const pending = memories.filter((item) => item.status === "pending").length;
  const doctorIssueCount = Object.values(doctorSummaries).reduce(
    (total, summary) => total + summary.error_count + summary.warning_count,
    0,
  );
  const legacyAttentionCount = attention.filter(
    (workspace) => !doctorSummaries[workspace.id],
  ).length;
  const issueCount = doctorIssueCount + legacyAttentionCount + pending;
  const installedAgentCount = installations.filter((item) => item.installed).length;
  const metrics = [
    { label: tr("home.workspaceMetric"), value: workspaces.length, onClick: onShowWorkspaces },
    { label: tr("home.installedAgents"), value: installedAgentCount, onClick: onShowAgents },
    {
      label: tr("home.assetMetric"),
      value: uniqueAssetCount,
      onClick: () => onOpenAssets("instructions"),
    },
  ];

  return (
    <div className="grid gap-6">
      {!workspaces.length && (
        <GettingStartedCard
          onboarding={runtime?.onboarding}
          workspaces={workspaces}
          doctorSummaries={doctorSummaries}
          onRuntimeChanged={onRuntimeChanged}
          onAddRoot={onAddRoot}
          onOpenDoctor={onOpenDoctor}
        />
      )}

      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[2rem] font-semibold tracking-[-.04em]">{tr("home.todayTitle")}</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">{tr("home.todaySubtitle")}</p>
        </div>
        <Button className="gap-2" onClick={onRefresh}>
          <RefreshCw size={15} />
          {tr("common.refresh")}
        </Button>
      </header>

      <div className="flex min-h-14 flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-border bg-muted/55 px-5 py-3 text-sm">
        <Button
          variant="link"
          className="h-auto gap-2 p-0 font-semibold text-primary"
          onClick={onShowWorkspaces}
        >
          <CircleAlert size={16} />
          {tr("home.issueSummary", { count: issueCount })}
        </Button>
        {metrics.map(({ label, value, onClick }) => (
          <Button
            key={label}
            variant="bare"
            size="content"
            className="h-auto gap-1.5 p-0 text-sm hover:text-foreground"
            onClick={onClick}
          >
            <strong className="tabular-nums">{value}</strong>
            <span className="text-muted-foreground">{label}</span>
          </Button>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">
          {discovery
            ? tr("home.updated", { time: relativeTime(discovery.finished_at) })
            : tr("home.discovering")}
        </span>
      </div>

      {!workspaces.length ? (
        <Card className="grid min-h-[260px] place-content-center justify-items-center gap-3 rounded-xl border-dashed bg-card p-8 text-center shadow-none">
          <span className="grid size-12 place-items-center rounded-xl bg-primary/8 text-primary">
            <FolderGit2 size={24} />
          </span>
          <h2 className="text-lg font-semibold tracking-[-.02em]">{tr("home.emptyTitle")}</h2>
          <p className="max-w-md text-sm leading-6 text-muted-foreground">{tr("home.emptyText")}</p>
          <Button onClick={() => void onAddRoot()}>{tr("home.addScanRoot")}</Button>
        </Card>
      ) : (
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="grid gap-6">
            <Card className="overflow-hidden rounded-xl border-border bg-card shadow-none">
              <CardHeader className="flex flex-row items-center justify-between gap-3 border-b border-border px-5 py-4">
                <div>
                  <h2 className="text-base font-semibold">{tr("home.continueWork")}</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {tr("home.continueWorkDetail")}
                  </p>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                {recentContinuations.length ? (
                  recentContinuations.map((item) => (
                    <Button
                      key={item.workspace.id}
                      variant="bare"
                      size="content"
                      className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-5 py-4 text-left last:border-b-0 hover:bg-muted/40"
                      onClick={() => void (onContinue ?? onOpen)(item.workspace)}
                    >
                      <span className="min-w-0">
                        <strong className="block truncate text-sm">{item.workspace.name}</strong>
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {tr("home.continueWorkMeta", {
                            count: item.sessionCount,
                            agents: item.agents.map((agent) => agentLabels[agent]).join(" · "),
                          })}
                        </span>
                      </span>
                      <span className="text-xs font-medium text-blue-600">
                        {tr("home.continue")}
                      </span>
                    </Button>
                  ))
                ) : (
                  <div className="px-5 py-6 text-sm text-muted-foreground">
                    {tr("home.noContinuations")}
                  </div>
                )}
              </CardContent>
            </Card>
            <Card className="overflow-hidden rounded-xl border-border bg-card shadow-none">
              <CardHeader className="flex flex-row items-center justify-between gap-3 border-b border-border px-5 py-4">
                <h2 className="text-base font-semibold">{tr("home.pendingTasks")}</h2>
                <span className="text-sm tabular-nums text-muted-foreground">
                  {tr("home.itemCount", { count: issueCount })}
                </span>
              </CardHeader>
              <CardContent className="p-0">
                {issueCount > 0 ? (
                  <div className="grid divide-y divide-border">
                    {attention.slice(0, 4).map((workspace) => {
                      const doctorCount =
                        (doctorSummaries[workspace.id]?.error_count ?? 0) +
                        (doctorSummaries[workspace.id]?.warning_count ?? 0);
                      return (
                        <Button
                          variant="bare"
                          size="content"
                          className="flex min-h-[74px] items-center gap-3 px-5 py-3.5 text-left hover:bg-muted/45"
                          key={workspace.id}
                          onClick={() => void onOpenDoctor(workspace)}
                        >
                          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                            <CircleAlert size={16} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <strong className="block truncate text-sm">{workspace.name}</strong>
                            <small className="mt-0.5 block text-xs text-muted-foreground">
                              {tr("home.workspaceWarnings", {
                                count: doctorCount || workspace.warning_count,
                              })}
                            </small>
                          </span>
                          <span className="rounded-lg border border-border px-3 py-2 text-xs font-semibold">
                            {tr("home.fixNow")}
                          </span>
                        </Button>
                      );
                    })}
                    {pending > 0 && (
                      <Button
                        variant="bare"
                        size="content"
                        className="flex min-h-[74px] items-center gap-3 px-5 py-3.5 text-left hover:bg-muted/45"
                        onClick={() => onOpenAssets("memory")}
                      >
                        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-amber-500/10 text-amber-700">
                          <Brain size={15} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <strong className="block truncate text-sm">
                            {tr("home.pendingMemory")}
                          </strong>
                          <small className="mt-0.5 block text-xs text-muted-foreground">
                            {tr("home.pendingMemoryDetail", { count: pending })}
                          </small>
                        </span>
                        <span className="rounded-lg border border-border px-3 py-2 text-xs font-semibold">
                          {tr("home.reviewNow")}
                        </span>
                      </Button>
                    )}
                  </div>
                ) : (
                  <div className="flex min-h-28 items-center gap-3 px-5 py-5">
                    <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-emerald-500/10 text-emerald-700">
                      <Check size={18} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <strong className="block text-sm">{tr("home.allClear")}</strong>
                      <small className="mt-1 block text-xs text-muted-foreground">
                        {tr("home.allClearDescription")}
                      </small>
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void onOpenDoctor(workspaces[0])}
                    >
                      <ShieldCheck size={14} />
                      {tr("home.openDoctor")}
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>

            <section>
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-base font-semibold">{tr("home.recentActivity")}</h2>
                <Button
                  variant="link"
                  className="h-auto p-0 text-xs text-primary"
                  onClick={onShowInsights}
                >
                  {tr("home.viewAll")}
                </Button>
              </div>
              {activity.length > 0 ? (
                <div className="grid divide-y divide-border">
                  {activity.slice(0, 3).map((item) => (
                    <ActivityRow key={item.id} record={item} />
                  ))}
                </div>
              ) : (
                <div className="flex items-start gap-3 py-4">
                  <History size={16} className="mt-0.5 text-muted-foreground" />
                  <span>
                    <strong className="block text-sm">{tr("home.noImportantActivity")}</strong>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {tr("home.noImportantActivityText")}
                    </p>
                  </span>
                </div>
              )}
            </section>
          </div>

          <Card className="overflow-hidden rounded-xl border-border bg-card shadow-none">
            <CardHeader className="flex flex-row items-center justify-between border-b border-border px-5 py-4">
              <h2 className="text-base font-semibold">{tr("home.recentWorkspaces")}</h2>
              <Button
                variant="link"
                className="h-auto p-0 text-xs text-primary"
                onClick={onShowWorkspaces}
              >
                {tr("home.viewAll")}
              </Button>
            </CardHeader>
            <CardContent className="p-0">
              {workspaces.slice(0, 3).map((workspace) => (
                <WorkspaceRow
                  key={workspace.id}
                  workspace={workspace}
                  assetCount={assetCounts.get(workspace.id)}
                  onOpen={onOpen}
                />
              ))}
              <div className="border-t border-border px-5 py-4">
                <Button size="sm" className="gap-1.5" onClick={() => void onAddRoot()}>
                  <Plus size={14} />
                  {tr("home.createWorkspace")}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

function WorkspaceRow({
  workspace,
  assetCount,
  onOpen,
}: {
  workspace: WorkspaceSummary;
  assetCount?: number;
  onOpen: (workspace: WorkspaceSummary) => Promise<void>;
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
    <Button
      variant="bare"
      size="content"
      className="group grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-5 py-4 text-left last:border-b-0 hover:bg-muted/40"
      onClick={() => void onOpen(workspace)}
    >
      <div className="grid size-9 place-items-center rounded-lg text-emerald-700">
        <FolderGit2 size={19} />
      </div>
      <div className="min-w-0">
        <strong className="block truncate text-sm font-semibold">{workspace.name}</strong>
        <small className="mt-1 block truncate text-xs text-muted-foreground" title={workspace.path}>
          {workspace.path}
        </small>
        <span className="mt-1 block truncate text-xs text-muted-foreground">
          {agents} · {tr("workspace.assetCount", { count })}
        </span>
      </div>
      {workspace.status === "attention" ? (
        <Badge variant="secondary" className="gap-1 bg-primary/10 text-primary">
          <CircleAlert size={13} />
          {workspaceStatusLabel("attention")}
        </Badge>
      ) : (
        <Badge variant="secondary" className="gap-1 bg-emerald-500/10 text-emerald-700">
          <Check size={13} />
          {workspaceStatusLabel("healthy")}
        </Badge>
      )}
    </Button>
  );
}

function ActivityRow({ record }: { record: ActivityRecord }) {
  return (
    <div className="grid min-h-12 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 py-2 text-sm">
      <FileText size={16} className="text-muted-foreground" />
      <div className="min-w-0">
        <strong className="block truncate text-sm font-medium">
          {tr(`activity.action.${record.action}`, { defaultValue: record.action })}
        </strong>
        <small
          className="mt-0.5 block truncate text-xs text-muted-foreground"
          title={record.detail}
        >
          {record.detail}
        </small>
      </div>
      <time className="whitespace-nowrap text-xs text-muted-foreground">
        {formatDateTime(record.created_at)}
      </time>
    </div>
  );
}

function workspaceStatusLabel(status: WorkspaceSummary["status"]) {
  return tr(`status.workspace.${status}`);
}

function relativeTime(value: string) {
  return formatRelativeTime(value);
}
