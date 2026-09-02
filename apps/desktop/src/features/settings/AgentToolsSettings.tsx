import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Check,
  CircleAlert,
  CircleHelp,
  CircleMinus,
  Copy,
  Download,
  ExternalLink,
  Github,
  Info,
  LoaderCircle,
  PackageCheck,
  RefreshCw,
  ScrollText,
  ShieldAlert,
  TerminalSquare,
} from "lucide-react";

import { AgentIcon } from "@/features/agents/AgentIcon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppDialogs } from "@/components/AppDialogProvider";
import { api } from "@/core/api";
import { formatDateTime, localizeMessage, tr } from "@/core/i18n";
import type {
  AgentKind,
  AgentToolAction,
  AgentToolChannel,
  AgentToolEnvironment,
  AgentToolExecutionResult,
  AgentToolInstallation,
  AgentToolState,
  AgentToolStatus,
  AppUpdateInfo,
} from "@/core/types";
import { cn } from "@/lib/utils";
import { refreshAgentTools, useAgentTools } from "./agent-tools-query";
import { SettingsNotice } from "./components/SettingsLayout";

const PROJECT_URL = "https://github.com/starroyhq/agentkib";
const RELEASES_URL = `${PROJECT_URL}/releases`;
const MANAGED_AGENTS = new Set<AgentKind>([
  "codex",
  "claude-code",
  "cursor",
  "opencode",
  "open-claw",
  "hermes",
  "grok-build",
]);

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

const stateIcons: Record<AgentToolState, typeof Check> = {
  current: Check,
  "update-available": Download,
  uninstalled: CircleMinus,
  conflict: CircleAlert,
  unknown: CircleHelp,
};

export function AgentToolsSettings({
  currentVersion,
  updatesEnabled = true,
}: {
  currentVersion?: string;
  updatesEnabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const dialogs = useAppDialogs();
  const toolsQuery = useAgentTools();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const [conflictsOpen, setConflictsOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<AgentKind | "">("");
  const [copyNotice, setCopyNotice] = useState("");
  const [executingAgent, setExecutingAgent] = useState<AgentKind>();
  const executionLock = useRef(false);
  const tools = (toolsQuery.data?.tools ?? []).filter((tool) => MANAGED_AGENTS.has(tool.agent));
  const diagnostics = tools.filter(
    (tool) =>
      tool.state === "conflict" ||
      tool.state === "unknown" ||
      tool.warnings.includes("multiple-executables") ||
      tool.installations.some((installation) => !installation.runnable),
  );
  const upgrades = tools.flatMap((tool) =>
    tool.actions
      .filter((action) => action.kind === "update" && action.mode === "execute")
      .map((action) => ({ tool, action })),
  );
  const selectedTool = tools.find((tool) => tool.agent === selectedAgent);

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError("");
    try {
      await refreshAgentTools(queryClient);
    } catch (error) {
      setRefreshError(localizeMessage(error));
    } finally {
      setRefreshing(false);
    }
  };

  const copyCommand = async (command: string, message = tr("settings.tools.commandCopied")) => {
    try {
      if (!navigator.clipboard) throw new Error(tr("settings.tools.clipboardUnavailable"));
      await navigator.clipboard.writeText(command);
      setCopyNotice(message);
    } catch (error) {
      setCopyNotice(localizeMessage(error));
    }
  };

  const executeAction = async (
    tool: AgentToolStatus,
    action: AgentToolAction,
    confirm = true,
  ): Promise<AgentToolExecutionResult | undefined> => {
    if (executionLock.current) return undefined;
    executionLock.current = true;
    setExecutingAgent(tool.agent);
    try {
      const installation =
        tool.installations.find((candidate) => candidate.id === action.installation_id) ??
        primaryInstallation(tool);
      if (
        confirm &&
        !(await dialogs.confirm({
          title: tr("settings.tools.executeTitle"),
          description: tr("settings.tools.executeConfirm", {
            agent: agentLabels[tool.agent],
            channel: channelLabel(action.channel),
            current: tool.current_version ?? tr("common.unknown"),
            target: action.target_version ?? tr("common.unknown"),
            path: installation?.path ?? tr("settings.tools.executableMissing"),
            manager: action.manager_path ?? tr("settings.tools.managerMissing"),
            command: action.command ?? "—",
          }),
        }))
      ) {
        return undefined;
      }
      const result = await api.executeAgentTool(tool.agent, action.id);
      await refreshAgentTools(queryClient).catch(() => undefined);
      if (confirm) {
        await dialogs.notify({
          title: tr(`settings.tools.result.${result.status}`),
          description: executionResultDescription(result),
          tone: result.status === "succeeded" ? "default" : "warning",
        });
      }
      return result;
    } catch (error) {
      if (confirm) {
        await dialogs.notify({
          title: tr("settings.tools.result.failed"),
          description: localizeMessage(error),
          tone: "warning",
        });
      }
      return undefined;
    } finally {
      executionLock.current = false;
      setExecutingAgent(undefined);
    }
  };

  const executeBatch = async () => {
    if (!upgrades.length || executionLock.current) return;
    executionLock.current = true;
    try {
      if (
        !(await dialogs.confirm({
          title: tr("settings.tools.batchExecuteTitle"),
          description: tr("settings.tools.batchExecuteConfirm", { count: upgrades.length }),
        }))
      ) {
        return;
      }
      setBatchOpen(false);
      const results: AgentToolExecutionResult[] = [];
      let requestFailures = 0;
      for (const { tool, action } of upgrades) {
        setExecutingAgent(tool.agent);
        try {
          results.push(await api.executeAgentTool(tool.agent, action.id));
        } catch {
          requestFailures += 1;
        }
      }
      await refreshAgentTools(queryClient).catch(() => undefined);
      const succeeded = results.filter((result) => result.status === "succeeded").length;
      await dialogs.notify({
        title: tr("settings.tools.batchResultTitle"),
        description: tr("settings.tools.batchResult", {
          succeeded,
          failed: results.length - succeeded + requestFailures,
        }),
        tone: succeeded === upgrades.length ? "default" : "warning",
      });
    } finally {
      executionLock.current = false;
      setExecutingAgent(undefined);
    }
  };

  return (
    <div className="grid gap-3">
      <AppUpdateSetting currentVersion={currentVersion} updatesEnabled={updatesEnabled} />

      <section className="grid gap-3" aria-labelledby="agent-tools-heading">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h2 id="agent-tools-heading" className="font-heading text-lg font-semibold">
                {tr("settings.tools.localEnvironment")}
              </h2>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1 px-2 text-xs text-muted-foreground"
                onClick={() =>
                  void api.openExternal(`${PROJECT_URL}/blob/main/docs/DEVELOPMENT.md`)
                }
              >
                <Info size={14} />
                {tr("settings.tools.environmentHelp")}
              </Button>
            </div>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {toolsQuery.data?.latest_checked_at
                ? tr("settings.tools.lastChecked", {
                    time: formatDateTime(toolsQuery.data.latest_checked_at),
                  })
                : tr("settings.tools.environmentDescription")}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={!diagnostics.length || Boolean(executingAgent)}
              onClick={() => setConflictsOpen(true)}
            >
              <ShieldAlert size={15} />
              {tr("settings.tools.diagnoseInstallations", { count: diagnostics.length })}
            </Button>
            <Button
              variant="outline"
              disabled={refreshing || Boolean(executingAgent)}
              onClick={() => void refresh()}
            >
              <RefreshCw className={refreshing ? "animate-spin" : undefined} size={15} />
              {tr("settings.tools.detectAgain")}
            </Button>
          </div>
        </div>

        {(refreshError || toolsQuery.error) && (
          <SettingsNotice tone="error" inset={false} className="text-sm" role="alert">
            <CircleAlert size={16} className="mt-0.5" />
            {refreshError || localizeMessage(toolsQuery.error)}
          </SettingsNotice>
        )}
        {toolsQuery.data?.cache_status === "cached" && (
          <SettingsNotice tone="warning" inset={false} className="text-sm" role="status">
            <Info size={16} className="mt-0.5" />
            <span>
              {tr("settings.tools.usingCachedVersions")}
              {toolsQuery.data.errors.length > 0 && (
                <>
                  {" "}
                  {tr("settings.tools.partialSourceFailure", {
                    count: toolsQuery.data.errors.length,
                  })}
                </>
              )}
            </span>
          </SettingsNotice>
        )}
        {toolsQuery.data?.cache_status !== "cached" && Boolean(toolsQuery.data?.errors.length) && (
          <SettingsNotice tone="warning" inset={false} className="text-sm" role="status">
            <CircleAlert size={16} className="mt-0.5" />
            {tr("settings.tools.partialSourceFailure", {
              count: toolsQuery.data?.errors.length ?? 0,
            })}
          </SettingsNotice>
        )}

        {toolsQuery.isPending ? (
          <AgentToolsLoading />
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {tools.map((tool) => (
              <AgentToolCard
                key={tool.agent}
                tool={tool}
                onCopy={(command) => void copyCommand(command)}
                onExecute={(tool, action) => void executeAction(tool, action)}
                executing={Boolean(executingAgent)}
              />
            ))}
          </div>
        )}
      </section>

      <div className="grid gap-3 xl:grid-cols-2">
        <Card className="flex min-h-[136px] flex-col justify-between p-4 shadow-none">
          <div className="flex items-start gap-3">
            <PackageCheck size={20} className="mt-0.5" />
            <div>
              <h3 className="font-heading font-semibold">
                {tr("settings.tools.upgradeCount", { count: upgrades.length })}
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {tr("settings.tools.batchDescription")}
              </p>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <span className="flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-300">
              <ShieldAlert size={15} />
              {tr("settings.tools.safeExecutionOnly")}
            </span>
            <Button
              disabled={!upgrades.length || Boolean(executingAgent)}
              onClick={() => setBatchOpen(true)}
            >
              <ScrollText size={15} />
              {tr("settings.tools.reviewUpdates", { count: upgrades.length })}
            </Button>
          </div>
        </Card>

        <Card className="min-h-[136px] p-4 shadow-none">
          <div className="flex items-center justify-between gap-3">
            <h3 className="flex items-center gap-2 font-heading font-semibold">
              <TerminalSquare size={18} />
              {tr("settings.tools.manualCommand")}
            </h3>
            <Select
              value={selectedAgent || "none"}
              onValueChange={(value) =>
                setSelectedAgent(
                  value === "none" || value === null ? "" : (String(value) as AgentKind),
                )
              }
            >
              <SelectTrigger className="h-8 min-w-44" aria-label={tr("settings.tools.selectAgent")}>
                <SelectValue>
                  {selectedAgent ? agentLabels[selectedAgent] : tr("settings.tools.selectAgent")}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{tr("settings.tools.selectAgent")}</SelectItem>
                {tools.map((tool) => (
                  <SelectItem key={tool.agent} value={tool.agent}>
                    {agentLabels[tool.agent]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="mt-3 flex min-h-16 items-center justify-between gap-3 rounded-xl border bg-muted/35 px-3 py-2">
            {selectedTool?.actions[0]?.command ? (
              <>
                <code className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-xs">
                  {selectedTool.actions[0].command}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void copyCommand(selectedTool.actions[0]?.command ?? "")}
                >
                  <Copy size={14} />
                  {tr("common.copy")}
                </Button>
              </>
            ) : selectedTool ? (
              <Button
                variant="link"
                onClick={() => void api.openExternal(selectedTool.official_url)}
              >
                {tr("settings.tools.openDocumentation")}
                <ExternalLink size={14} />
              </Button>
            ) : (
              <span className="text-sm text-muted-foreground">
                {tr("settings.tools.selectAgentHint")}
              </span>
            )}
          </div>
          {copyNotice && <p className="mt-2 text-xs text-muted-foreground">{copyNotice}</p>}
        </Card>
      </div>

      <InstallationDiagnosticsDialog
        open={conflictsOpen}
        onOpenChange={setConflictsOpen}
        tools={diagnostics}
      />
      <BatchCommandsDialog
        open={batchOpen}
        onOpenChange={setBatchOpen}
        upgrades={upgrades}
        executing={Boolean(executingAgent)}
        onExecute={() => void executeBatch()}
      />
    </div>
  );
}

function AgentToolCard({
  tool,
  onCopy,
  onExecute,
  executing,
}: {
  tool: AgentToolStatus;
  onCopy: (command: string) => void;
  onExecute: (tool: AgentToolStatus, action: AgentToolAction) => void;
  executing: boolean;
}) {
  const [selectedActionId, setSelectedActionId] = useState(tool.actions[0]?.id ?? "");
  useEffect(() => {
    if (!tool.actions.some((action) => action.id === selectedActionId)) {
      setSelectedActionId(tool.actions[0]?.id ?? "");
    }
  }, [selectedActionId, tool.actions]);
  const action =
    tool.actions.find((candidate) => candidate.id === selectedActionId) ?? tool.actions[0];
  const StateIcon = stateIcons[tool.state];
  const hasMultipleInstallations = tool.warnings.includes("multiple-executables");
  const DetailIcon = hasMultipleInstallations ? CircleAlert : StateIcon;
  const stateClass = {
    current: "border-emerald-500/35 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300",
    "update-available": "border-amber-500/35 bg-amber-500/8 text-amber-700 dark:text-amber-300",
    uninstalled: "border-border bg-muted/50 text-muted-foreground",
    conflict: "border-destructive/35 bg-destructive/8 text-destructive",
    unknown: "border-border bg-muted/50 text-muted-foreground",
  }[tool.state];
  const installation = primaryInstallation(tool);
  const path = installation?.path;
  const actionLabel = !action
    ? tr("settings.tools.openDocumentation")
    : action.mode === "execute"
      ? tr(action.kind === "install" ? "settings.tools.installNow" : "settings.tools.updateNow")
      : action.mode === "copy-command"
        ? tr(
            action.kind === "install"
              ? "settings.tools.copyInstallCommand"
              : "settings.tools.copyUpdateCommand",
          )
        : tr("settings.tools.openDocumentation");

  return (
    <Card
      className={cn(
        "flex min-h-[178px] flex-col border p-3 shadow-none",
        tool.state === "conflict" && "border-destructive/45",
      )}
    >
      <div className="flex items-start justify-between gap-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 [&>div]:size-6 [&>div]:rounded-md [&>div]:p-0.5">
            <AgentIcon agent={tool.agent} />
          </span>
          <h3 className="truncate font-heading text-sm font-semibold">{agentLabels[tool.agent]}</h3>
        </div>
        <Badge className={cn("gap-1 border px-1.5", stateClass)} variant="outline">
          <StateIcon size={12} />
          {tr(`settings.tools.state.${tool.state}`)}
        </Badge>
      </div>

      <dl className="mt-2 grid gap-0.5 text-xs">
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">{tr("settings.tools.currentVersion")}</dt>
          <dd className="truncate font-medium">{tool.current_version ?? "—"}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">{tr("settings.tools.channelLatestVersion")}</dt>
          <dd className="truncate font-medium">
            {tool.recommended_version ?? tr("common.unknown")}
          </dd>
        </div>
        {tool.upstream_version && tool.upstream_version !== tool.latest_version && (
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">{tr("settings.tools.upstreamLatestVersion")}</dt>
            <dd className="truncate font-medium">{tool.upstream_version}</dd>
          </div>
        )}
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">{tr("settings.tools.channel")}</dt>
          <dd className="truncate">
            {channelLabel(action?.channel ?? tool.channel)}
            {installation && ` · ${environmentLabel(installation.environment)}`}
          </dd>
        </div>
      </dl>
      {tool.actions.length > 1 && (
        <Select
          value={action?.id ?? ""}
          onValueChange={(value) => {
            if (value !== null) setSelectedActionId(String(value));
          }}
        >
          <SelectTrigger
            size="sm"
            className="mt-1 h-7 w-full text-xs"
            aria-label={tr("settings.tools.selectChannel")}
          >
            <SelectValue>{channelLabel(action?.channel ?? tool.channel)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {tool.actions.map((candidate) => (
              <SelectItem key={candidate.id} value={candidate.id}>
                {channelLabel(candidate.channel)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground" title={path}>
        {path ?? tr("settings.tools.executableMissing")}
      </p>
      <p
        className={cn(
          "mt-1 flex min-h-4 items-start gap-1 text-[11px]",
          tool.state === "conflict"
            ? "text-destructive"
            : hasMultipleInstallations
              ? "text-amber-700 dark:text-amber-300"
              : tool.state === "current"
                ? "text-emerald-700 dark:text-emerald-300"
                : "text-muted-foreground",
        )}
      >
        <DetailIcon size={12} className="mt-0.5" />
        {toolWarning(tool)}
      </p>
      <div className="mt-auto flex justify-end pt-1">
        <Button
          size="sm"
          className="h-7 px-2 text-xs"
          variant={tool.state === "current" ? "outline" : "default"}
          disabled={executing}
          onClick={() => {
            if (!action) return void api.openExternal(tool.official_url);
            if (action.mode === "execute") onExecute(tool, action);
            else if (action.mode === "copy-command" && action.command) onCopy(action.command);
            else void api.openExternal(action.url ?? tool.official_url);
          }}
        >
          {executing ? (
            <LoaderCircle className="animate-spin" size={13} />
          ) : action?.mode === "execute" ? (
            <Download size={13} />
          ) : action?.mode === "copy-command" ? (
            <Copy size={13} />
          ) : (
            <ExternalLink size={13} />
          )}
          {actionLabel}
        </Button>
      </div>
    </Card>
  );
}

function AppUpdateSetting({
  currentVersion,
  updatesEnabled = true,
}: {
  currentVersion?: string;
  updatesEnabled?: boolean;
}) {
  const dialogs = useAppDialogs();
  const [status, setStatus] = useState<
    "idle" | "checking" | "up-to-date" | "available" | "downloading" | "failed"
  >("idle");
  const [update, setUpdate] = useState<AppUpdateInfo>();
  const [error, setError] = useState("");
  const [downloaded, setDownloaded] = useState(0);
  const [contentLength, setContentLength] = useState<number>();
  const busy = status === "checking" || status === "downloading";
  const progress = contentLength
    ? Math.min(100, Math.round((downloaded / contentLength) * 100))
    : 0;

  const check = async () => {
    if (busy || !updatesEnabled) return;
    setStatus("checking");
    setError("");
    setUpdate(undefined);
    try {
      const available = await api.checkAppUpdate();
      setUpdate(available);
      setStatus(available ? "available" : "up-to-date");
    } catch (reason) {
      setError(localizeMessage(reason));
      setStatus("failed");
    }
  };

  const install = async () => {
    if (!update || busy) return;
    if (update.install_mode === "manual") {
      try {
        await api.openExternal(update.release_url);
      } catch (reason) {
        setError(localizeMessage(reason));
        setStatus("failed");
      }
      return;
    }
    if (
      !(await dialogs.confirm({
        title: tr("settings.updateInstallTitle"),
        description: tr("settings.updateInstallConfirm", { version: update.version }),
      }))
    )
      return;
    setStatus("downloading");
    setError("");
    setDownloaded(0);
    setContentLength(undefined);
    try {
      await api.installAppUpdate(update.version, (event) => {
        if (event.event === "started") setContentLength(event.data.content_length);
        if (event.event === "progress") {
          setDownloaded(event.data.downloaded);
          setContentLength(event.data.content_length);
        }
      });
      setStatus("up-to-date");
    } catch (reason) {
      setError(localizeMessage(reason));
      setStatus("failed");
    }
  };

  const description = useMemo(() => {
    if (!updatesEnabled) return tr("settings.updateUnavailableInDevelopment");
    if (status === "checking") return tr("settings.updateChecking");
    if (status === "up-to-date")
      return tr("settings.updateUpToDate", { version: currentVersion ?? "—" });
    if (status === "available" && update)
      return tr("settings.updateAvailable", {
        current: update.current_version,
        version: update.version,
      });
    if (status === "downloading")
      return contentLength
        ? tr("settings.updateDownloadingProgress", { progress })
        : tr("settings.updateDownloading");
    if (status === "failed") return error;
    return tr("settings.updateCurrentVersion", { version: currentVersion ?? "—" });
  }, [contentLength, currentVersion, error, progress, status, update, updatesEnabled]);

  return (
    <Card className="overflow-hidden p-4 shadow-none">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-xl border bg-background">
            <PackageCheck size={22} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-heading text-lg font-semibold">
                AgentKib {currentVersion ? `v${currentVersion}` : ""}
              </h2>
              <Badge
                variant="outline"
                className={cn(
                  "gap-1",
                  status === "failed"
                    ? "border-destructive/30 text-destructive"
                    : "border-emerald-500/30 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300",
                )}
              >
                {status === "failed" ? <CircleAlert size={12} /> : <Check size={12} />}
                {tr(`settings.tools.appState.${status}`)}
              </Badge>
            </div>
            <p
              className={cn(
                "mt-1 text-sm text-muted-foreground",
                status === "failed" && "text-destructive",
              )}
            >
              {description}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void api.openExternal(PROJECT_URL)}>
            <Github size={15} /> GitHub
          </Button>
          <Button variant="outline" onClick={() => void api.openExternal(RELEASES_URL)}>
            <ScrollText size={15} />
            {tr("settings.tools.releaseNotes")}
          </Button>
          {status === "available" && update ? (
            <Button disabled={busy} onClick={() => void install()}>
              {update.install_mode === "manual" ? (
                <ExternalLink size={15} />
              ) : (
                <Download size={15} />
              )}
              {tr(
                update.install_mode === "manual"
                  ? "settings.updateOpenRelease"
                  : "settings.updateDownloadInstall",
              )}
            </Button>
          ) : (
            <Button disabled={busy || !updatesEnabled} onClick={() => void check()}>
              <RefreshCw className={busy ? "animate-spin" : undefined} size={15} />
              {tr(status === "failed" ? "settings.updateRetry" : "settings.checkForUpdates")}
            </Button>
          )}
        </div>
      </div>
      {status === "downloading" && (
        <div
          className="mt-4 h-1 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuenow={progress}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="h-full bg-primary transition-[width]" style={{ width: `${progress}%` }} />
        </div>
      )}
      {update?.notes && status !== "failed" && (
        <div className="mt-3 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          <strong className="mb-1 block text-foreground">{tr("settings.updateNotes")}</strong>
          <span className="whitespace-pre-wrap break-words">{update.notes}</span>
        </div>
      )}
    </Card>
  );
}

function InstallationDiagnosticsDialog({
  open,
  onOpenChange,
  tools,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tools: AgentToolStatus[];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{tr("settings.tools.diagnosticsTitle")}</DialogTitle>
          <DialogDescription>{tr("settings.tools.diagnosticsDescription")}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[55vh] space-y-3 overflow-auto">
          {tools.length ? (
            tools.map((tool) => (
              <div key={tool.agent} className="rounded-xl border p-3">
                <strong>{agentLabels[tool.agent]}</strong>
                <ul className="mt-2 space-y-2 text-xs text-muted-foreground">
                  {tool.installations.map((installation) => (
                    <li key={installation.id} className="rounded-lg bg-muted/45 p-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="outline">
                          {installation.runnable
                            ? tr("settings.tools.runnable")
                            : tr("settings.tools.notRunnable")}
                        </Badge>
                        {installation.is_path_default && (
                          <Badge variant="outline">{tr("settings.tools.pathDefault")}</Badge>
                        )}
                        <span>
                          {channelLabel(installation.channel)} ·{" "}
                          {environmentLabel(installation.environment)}
                        </span>
                        <span>{installation.version ?? tr("common.unknown")}</span>
                      </div>
                      <p className="mt-1 break-all font-mono">{installation.path}</p>
                      {installation.resolved_path !== installation.path && (
                        <p className="mt-1 break-all font-mono">
                          {tr("settings.tools.resolvedPath", {
                            path: installation.resolved_path,
                          })}
                        </p>
                      )}
                      {installation.manager_path && (
                        <p className="mt-1 break-all font-mono">
                          {tr("settings.tools.managerPath", {
                            path: installation.manager_path,
                          })}
                        </p>
                      )}
                      {installation.error && (
                        <p className="mt-1 break-words text-destructive">{installation.error}</p>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">{tr("settings.tools.noDiagnostics")}</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function BatchCommandsDialog({
  open,
  onOpenChange,
  upgrades,
  executing,
  onExecute,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  upgrades: Array<{ tool: AgentToolStatus; action: AgentToolAction }>;
  executing: boolean;
  onExecute: () => void;
}) {
  const commands = upgrades
    .map(
      ({ tool, action }) =>
        `# ${agentLabels[tool.agent]} · ${channelLabel(action.channel)}\n${action.command}`,
    )
    .join("\n\n");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{tr("settings.tools.batchExecuteTitle")}</DialogTitle>
          <DialogDescription>{tr("settings.tools.batchExecuteDescription")}</DialogDescription>
        </DialogHeader>
        <pre className="max-h-[55vh] overflow-auto rounded-xl border bg-muted/50 p-3 text-xs whitespace-pre-wrap">
          {commands}
        </pre>
        <DialogFooter>
          <Button disabled={!commands || executing} onClick={onExecute}>
            {executing ? (
              <LoaderCircle className="animate-spin" size={15} />
            ) : (
              <Download size={15} />
            )}
            {tr("settings.tools.executeAllUpdates")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AgentToolsLoading() {
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4" aria-label={tr("common.loading")}>
      {Array.from({ length: 7 }, (_, index) => (
        <div key={index} className="h-[178px] animate-pulse rounded-xl border bg-muted/35" />
      ))}
    </div>
  );
}

function channelLabel(channel: AgentToolChannel) {
  return tr(`settings.tools.channel.${channel}`);
}

function environmentLabel(environment: AgentToolEnvironment) {
  return tr(`settings.tools.environment.${environment}`);
}

function primaryInstallation(tool: AgentToolStatus): AgentToolInstallation | undefined {
  return (
    tool.installations.find((installation) => installation.is_path_default) ??
    (tool.installations.length === 1 ? tool.installations[0] : undefined)
  );
}

function executionResultDescription(result: AgentToolExecutionResult) {
  const versionChange =
    result.before_version || result.after_version
      ? tr("settings.tools.versionChange", {
          before: result.before_version ?? tr("common.unknown"),
          after: result.after_version ?? tr("common.unknown"),
        })
      : "";
  return [versionChange, result.output || tr("settings.tools.noCommandOutput")]
    .filter(Boolean)
    .join("\n");
}

function toolWarning(tool: AgentToolStatus) {
  if (tool.state === "conflict")
    return tr("settings.tools.multipleExecutables", { count: tool.installations.length });
  if (tool.warnings.includes("multiple-executables"))
    return tr("settings.tools.multipleInstallationsNotice", { count: tool.installations.length });
  if (tool.state === "current") return tr("settings.tools.noIssues");
  if (tool.state === "update-available") return tr("settings.tools.updateSuggested");
  if (tool.state === "uninstalled") return tr("settings.tools.executableMissing");
  if (tool.warnings.includes("channel-unverified")) return tr("settings.tools.channelUnverified");
  if (tool.warnings.includes("installation-not-runnable"))
    return tr("settings.tools.installationNotRunnable");
  if (tool.warnings.includes("version-unavailable")) return tr("settings.tools.versionUnavailable");
  if (tool.warnings.includes("version-uncomparable"))
    return tr("settings.tools.versionUncomparable");
  return tr("settings.tools.latestUnavailable");
}

export { AppUpdateSetting };
