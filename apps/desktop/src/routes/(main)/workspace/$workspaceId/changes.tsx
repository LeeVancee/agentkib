import { fileName, shortPath } from "@/lib/path-display";
import { useI18n } from "@/core/useI18n";
import { createFileRoute, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { WorkspaceChangesSkeleton } from "@/features/workspace/WorkspaceSkeleton";
import { api } from "@/core/api";
import { useWorkspaceStore, type ChangeSetOrigin } from "@/features/workspace/workspace-store";
import {
  changesReturnPage,
  hasActiveChangesFlow,
  type WorkspaceFlowPage,
} from "@/features/workspace/workspace-flow";
import { homeKeys } from "@/features/home/home-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Brain,
  Check,
  CircleAlert,
  ExternalLink,
  FileCode2,
  GitCompareArrows,
  LoaderCircle,
  ShieldCheck,
} from "lucide-react";
import { cn } from "cn";
import { withAsyncCleanup } from "@/lib/utils";
import { WorkspaceChangeDiff as Diff } from "@/features/workspace/WorkspaceChangeDiff";
import type { ChangeSet, SessionHandoffLaunchRequest } from "@/core/types";
import { AGENT_LABELS as agentLabels } from "@/core/agents";
import { isClaudeGlobalConfig } from "@/core/claude-global-config";
function Empty({
  icon: Icon,
  title,
  text,
  compact = false,
}: {
  icon: typeof Brain;
  title: string;
  text: string;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "grid min-h-[260px] place-content-center justify-items-center gap-1.5 p-[30px] text-center text-muted-foreground",
        compact &&
          "min-h-[92px] grid-cols-[auto_minmax(0,auto)] items-center gap-x-2.5 gap-y-1 p-4 text-left",
      )}
    >
      <Icon className={compact ? "row-span-2" : "mb-1.5"} size={28} />
      <h3 className="m-0 text-[13px] font-semibold text-foreground">{title}</h3>
      {text && <p className="m-0 max-w-[380px] leading-relaxed">{text}</p>}
    </div>
  );
}
export function Changes({
  changeSet,
  origin,
  homeIncluded = false,
  launchRequest,
  onPlanHome,
  onApplied,
  onLaunchCompleted,
  onRejected,
  onApplyingChange,
}: {
  changeSet?: ChangeSet;
  origin: ChangeSetOrigin;
  homeIncluded?: boolean;
  launchRequest?: SessionHandoffLaunchRequest;
  onPlanHome: () => void | Promise<void>;
  onApplied: (
    keepLaunchRequest?: boolean,
    result?: { applied: string[]; backup_dir: string },
  ) => void | Promise<void>;
  onLaunchCompleted: () => void;
  onRejected: () => void;
  onApplyingChange: (applying: boolean) => void;
}) {
  const { localizeMessage, tr } = useI18n();
  const workspaceBusy = useWorkspaceStore((state) => state.busy);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const [planningHome, setPlanningHome] = useState(false);
  const [error, setError] = useState("");
  const [homeApproved, setHomeApproved] = useState(false);
  const [appliedLaunchFailure, setAppliedLaunchFailure] = useState("");
  const applying = useRef(false);
  const planning = useRef(false);
  const active = useRef(true);
  const hasChanges = Boolean(changeSet?.changes.length);
  const selectedIndex = changeSet?.changes[selected] ? selected : 0;
  const change = changeSet?.changes[selectedIndex];
  const launchSupported = launchRequest?.capabilities?.interactive_launch.status === "supported";
  const isNativeImport = launchRequest?.mode === "native-import";
  const canApplyAndContinue = Boolean(launchRequest && (launchSupported || isNativeImport));
  const targetAgentName = launchRequest ? agentLabels[launchRequest.target_agent] : "";
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (changeSet) {
      setAppliedLaunchFailure("");
      setSelected(0);
      setHomeApproved(false);
    }
  }, [changeSet?.id]);
  const runLocked = async (operation: () => Promise<void>) => {
    if (applying.current || planning.current || useWorkspaceStore.getState().busy) return;
    applying.current = true;
    setBusy(true);
    setError("");
    onApplyingChange(true);
    await withAsyncCleanup(
      async () => {
        try {
          await operation();
        } catch (value) {
          if (active.current) setError(localizeMessage(value));
        }
      },
      () => {
        applying.current = false;
        onApplyingChange(false);
        if (active.current) setBusy(false);
      },
    );
  };
  if (!changeSet && launchRequest)
    return (
      <Card className="rounded-xl border border-border bg-card shadow-sm grid items-center gap-4 p-5 md:grid-cols-[auto_minmax(0,1fr)_auto]">
        <CircleAlert size={24} />
        <div>
          <h2>{tr(isNativeImport ? "handoff.importNeedsCheck" : "handoff.savedLaunchFailed")}</h2>
          <p>{error || appliedLaunchFailure || tr("overview.pendingHandoffRecoveryText")}</p>
          <code>
            {launchRequest.mode === "native-import"
              ? launchRequest.operation_id
              : launchRequest.mode === "native-session"
                ? shortPath(launchRequest.target_path)
                : `.agentkib/handoffs/${launchRequest.filename}`}
          </code>
        </div>
        <Button
          className="bg-primary text-primary-foreground hover:bg-primary/90"
          disabled={busy || workspaceBusy}
          onClick={() =>
            void runLocked(async () => {
              await api.launchSessionHandoff(launchRequest);
              if (!active.current) return;
              setAppliedLaunchFailure("");
              onLaunchCompleted();
            })
          }
        >
          <ExternalLink size={15} />
          {tr(
            busy
              ? "handoff.opening"
              : isNativeImport
                ? "handoff.recovery.check"
                : "handoff.retryOpen",
            { agent: targetAgentName },
          )}
        </Button>
      </Card>
    );
  if (!changeSet)
    return (
      <Empty
        compact
        icon={GitCompareArrows}
        title={tr("changes.empty")}
        text={tr("changes.emptyText")}
      />
    );
  const apply = async () => {
    if (!hasChanges) return;
    await runLocked(async () => {
      const result = await api.apply(
        changeSet,
        homeApproved,
        launchRequest?.mode === "native-import" ? launchRequest : undefined,
      );
      const report = result && typeof result === "object" ? result : undefined;
      // A missing report must not turn a completed write into a retryable failure.
      const applied =
        report &&
        "applied" in report &&
        Array.isArray(report.applied) &&
        report.applied.every((target): target is string => typeof target === "string")
          ? report.applied
          : changeSet.changes.map((change) => change.target);
      const backupDir =
        report && "backup_dir" in report && typeof report.backup_dir === "string"
          ? report.backup_dir
          : "";
      if (active.current) await onApplied(false, { applied, backup_dir: backupDir });
    });
  };
  const applyAndContinue = async () => {
    if (!hasChanges || !launchRequest || !canApplyAndContinue) return;
    await runLocked(async () => {
      let result;
      try {
        result = await api.continueSessionHandoff(changeSet, launchRequest, homeApproved);
      } catch (reason) {
        if (launchRequest.mode !== "native-import") throw reason;
        // A transport failure cannot tell us whether the external CLI wrote.
        // Retain the operation for reconciliation instead of submitting again.
        if (active.current) {
          setAppliedLaunchFailure(localizeMessage(reason));
          await onApplied(true);
        }
        return;
      }
      if (!active.current) return;
      const appliedReport = {
        applied: changeSet.changes.map((change) => change.target),
        backup_dir: "",
      };
      if (result.status === "launched") {
        await onApplied(false, appliedReport);
      } else {
        setAppliedLaunchFailure(localizeMessage(result.error));
        if (result.status === "applied-launch-failed") await onApplied(true, appliedReport);
        else await onApplied(true);
      }
    });
  };
  const planHome = async () => {
    if (applying.current || planning.current || useWorkspaceStore.getState().busy) return;
    planning.current = true;
    setPlanningHome(true);
    setError("");
    await withAsyncCleanup(
      async () => {
        try {
          await onPlanHome();
        } catch (value) {
          if (active.current) setError(localizeMessage(value));
        }
      },
      () => {
        planning.current = false;
        if (active.current) setPlanningHome(false);
      },
    );
  };
  const disabled =
    busy ||
    workspaceBusy ||
    planningHome ||
    !changeSet.changes.length ||
    (changeSet.requires_home_approval && !homeApproved);
  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(240px,.35fr)_minmax(0,1fr)]">
      <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-4">
          <div>
            <h2>{tr("changes.title")}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{tr("changes.explanation")}</p>
            <p>
              {changeSet.changes.length} {tr("common.files")}
            </p>
          </div>
        </div>
        {hasChanges && origin === "handoff" && (
          <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-700">
            <CircleAlert size={14} />
            {tr(isNativeImport ? "handoff.nativeImportWarning" : "handoff.changeSetWarning")}
          </div>
        )}
        {changeSet.changes.some(isClaudeGlobalConfig) && (
          <div
            role="note"
            className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-700"
          >
            <CircleAlert size={14} className="mt-0.5 shrink-0" />
            {tr("changes.claudeGlobalConfigWarning")}
          </div>
        )}
        {changeSet.changes.map((file, index) => (
          <Button
            variant="bare"
            size="content"
            key={file.target}
            className={index === selectedIndex ? "bg-muted text-foreground" : ""}
            onClick={() => setSelected(index)}
          >
            <FileCode2 size={16} />
            <div>
              <strong>{fileName(file.target)}</strong>
              <span>{shortPath(file.target)}</span>
            </div>
            <span
              className={cn(
                "inline-flex items-center rounded-md px-2 py-1 text-xs font-medium",
                file.risk === "high"
                  ? "text-destructive"
                  : file.risk === "medium"
                    ? "text-amber-700"
                    : "text-muted-foreground",
              )}
            >
              {tr(`status.risk.${file.risk}`)}
            </span>
          </Button>
        ))}
        {origin === "standard" && (
          <div className="grid gap-2 border-t border-border p-4">
            <p>{tr("changes.homeQuestion")}</p>
            <Button
              className="border border-transparent bg-transparent text-foreground hover:bg-muted"
              onClick={() => void planHome()}
              disabled={busy || planningHome || workspaceBusy || homeIncluded}
              aria-busy={planningHome}
            >
              {planningHome && <LoaderCircle size={14} className="animate-spin" />}
              {tr(homeIncluded ? "changes.homeIncluded" : "changes.includeHome")}
            </Button>
          </div>
        )}
        {hasChanges && changeSet.requires_home_approval && (
          <Label className="flex items-center gap-2 border-t border-border p-4 text-xs text-muted-foreground">
            <Checkbox checked={homeApproved} onCheckedChange={setHomeApproved} />
            {tr(isNativeImport ? "handoff.nativeImportApproval" : "changes.homeApproval")}
          </Label>
        )}
      </div>
      <div className="rounded-xl border border-border bg-card shadow-sm min-w-0">
        {change ? (
          <>
            <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-4">
              <div>
                <h2>{fileName(change.target)}</h2>
                <p>
                  {change.target} · {tr(`status.scope.${change.scope}`)}
                </p>
              </div>
              <span
                className={cn(
                  "inline-flex items-center rounded-md px-2 py-1 text-xs font-medium",
                  change.risk === "high"
                    ? "text-destructive"
                    : change.risk === "medium"
                      ? "text-amber-700"
                      : "text-muted-foreground",
                )}
              >
                {tr(`status.risk.${change.risk}`)}
              </span>
            </div>
            <Diff before={change.before} after={change.after} />
          </>
        ) : (
          <Empty
            icon={Check}
            title={tr("changes.noFileChanges")}
            text={tr("changes.noFileChangesText")}
          />
        )}
        {error && (
          <div
            role="alert"
            className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border p-4">
          {hasChanges && (
            <div>
              <ShieldCheck size={17} />
              <span>{tr("changes.hashValidation")}</span>
            </div>
          )}
          <div className="">
            <Button
              className="border border-transparent bg-transparent text-foreground hover:bg-muted"
              onClick={() => {
                if (!applying.current && !planning.current && !useWorkspaceStore.getState().busy)
                  onRejected();
              }}
              disabled={busy || planningHome || workspaceBusy}
            >
              {tr(hasChanges ? "changes.reject" : "common.back")}
            </Button>
            {hasChanges && origin === "handoff" && launchSupported && !isNativeImport && (
              <Button
                className="border border-transparent bg-transparent text-foreground hover:bg-muted"
                onClick={() => void apply()}
                disabled={disabled}
              >
                {tr("handoff.applyOnly")}
              </Button>
            )}
            {hasChanges && (
              <Button
                className="bg-primary text-primary-foreground hover:bg-primary/90"
                onClick={() =>
                  void (origin === "handoff" && canApplyAndContinue ? applyAndContinue() : apply())
                }
                disabled={disabled}
              >
                {origin === "handoff" && canApplyAndContinue ? (
                  <>
                    <ExternalLink size={15} />
                    {tr(busy ? "changes.applying" : "handoff.applyAndContinue", {
                      agent: targetAgentName,
                    })}
                  </>
                ) : (
                  tr(busy ? "changes.applying" : "changes.apply", {
                    count: changeSet.changes.length,
                  })
                )}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function WorkspaceChangesRoute() {
  const { localizeMessage, tr } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { workspaceId } = useParams({ from: "/(main)/workspace/$workspaceId/changes" });
  const search = useSearch({ strict: false });
  const {
    project,
    changeSet,
    changeSetManifest,
    changeSetIncludesHome,
    changeSetOrigin,
    handoffLaunchRequest,
    manifest,
    setChangeSet,
    setHandoffLaunchRequest,
    setApplyingChanges,
    setScan,
    acceptAppliedManifest,
    setProject,
    setMessage,
    setAppliedChanges,
  } = useWorkspaceStore();
  const homePlanRequest = useRef(0);
  const reloadRequest = useRef(0);
  const activeFlow = hasActiveChangesFlow(changeSet, handoffLaunchRequest);
  const [enteredWithActiveFlow] = useState(activeFlow);
  const navigateTo = useCallback(
    (page: WorkspaceFlowPage, verification = false) => {
      const to =
        page === "overview" ? "/workspace/$workspaceId" : `/workspace/$workspaceId/${page}`;
      void navigate({
        to: to as never,
        params: { workspaceId } as never,
        replace: true,
        search:
          page === "doctor" && verification
            ? (current) => ({ ...current, doctorVerification: "applied" }) as never
            : undefined,
      });
    },
    [navigate, workspaceId],
  );
  const navigateToContinuation = useCallback(
    (autoPrepare: boolean) => {
      void navigate({
        to: "/workspace/$workspaceId/sessions",
        params: { workspaceId },
        replace: true,
        search: (current) => ({
          ...current,
          handoffSession: search.handoffSession,
          handoffTarget: search.handoffTarget,
          handoffBudget: search.handoffBudget,
          handoffFormat: search.handoffFormat,
          handoffSurface: search.handoffSurface,
          handoffBinding: search.handoffBinding,
          handoffPreCompaction: search.handoffPreCompaction,
          handoffResume: autoPrepare ? ("recheck" as const) : ("return" as const),
        }),
      });
    },
    [
      navigate,
      search.handoffBudget,
      search.handoffFormat,
      search.handoffSurface,
      search.handoffBinding,
      search.handoffPreCompaction,
      search.handoffSession,
      search.handoffTarget,
      workspaceId,
    ],
  );
  useEffect(
    () => () => {
      homePlanRequest.current += 1;
      reloadRequest.current += 1;
    },
    [workspaceId],
  );
  useEffect(() => {
    if (project && !enteredWithActiveFlow) navigateTo("overview");
  }, [enteredWithActiveFlow, navigateTo, project]);
  if (!project) return <WorkspaceChangesSkeleton />;
  if (!enteredWithActiveFlow) return <WorkspaceChangesSkeleton />;
  const planHome = async () => {
    if (!manifest || !changeSet) return;
    const requestId = ++homePlanRequest.current;
    const targetProject = project;
    const targetManifest = manifest;
    const targetChangeSetId = changeSet.id;
    const isCurrentRequest = () =>
      requestId === homePlanRequest.current &&
      useWorkspaceStore.getState().selectedWorkspace?.id === workspaceId &&
      useWorkspaceStore.getState().project === targetProject &&
      useWorkspaceStore.getState().changeSet?.id === targetChangeSetId &&
      JSON.stringify(useWorkspaceStore.getState().manifest) === JSON.stringify(targetManifest);
    const nextChangeSet = await api.plan(targetProject, targetManifest, true);
    if (isCurrentRequest()) setChangeSet(nextChangeSet, targetManifest, true);
    else if (useWorkspaceStore.getState().project === targetProject)
      throw new Error(tr("workspace.planSuperseded"));
  };
  const reload = async (plannedManifest?: string, draftAtApply?: string) => {
    const requestId = ++reloadRequest.current;
    const targetProject = project;
    const isCurrentRequest = () =>
      requestId === reloadRequest.current &&
      useWorkspaceStore.getState().selectedWorkspace?.id === workspaceId &&
      useWorkspaceStore.getState().project === targetProject;
    const [scan, manifest, runtime] = await Promise.all([
      api.scan(targetProject),
      api.manifest(targetProject),
      api.runtime(),
    ]);
    if (!isCurrentRequest()) return undefined;
    setProject(targetProject);
    setScan(scan);
    acceptAppliedManifest(manifest, plannedManifest, draftAtApply);
    return runtime;
  };
  return (
    <Changes
      changeSet={changeSet}
      origin={changeSetOrigin}
      homeIncluded={changeSetIncludesHome}
      launchRequest={handoffLaunchRequest}
      onPlanHome={planHome}
      onApplied={async (keepLaunchRequest, result) => {
        const targetProject = project;
        const appliedDoctorRepair = changeSetOrigin === "doctor";
        const appliedHandoffSetup = changeSetOrigin === "handoff-setup";
        const returnPage = changesReturnPage(changeSetOrigin);
        if (result && changeSet) {
          setAppliedChanges({
            workspaceId,
            project: targetProject,
            changeSet,
            applied: result.applied,
            backupDir: result.backup_dir,
            origin: changeSetOrigin,
          });
        }
        setChangeSet(undefined);
        if (!keepLaunchRequest) setHandoffLaunchRequest(undefined);
        if (appliedDoctorRepair) {
          try {
            await api.updateOnboarding({ event: "repair-applied", workspace_id: workspaceId });
          } catch (error) {
            setMessage(localizeMessage(error));
          }
        }
        await withAsyncCleanup(
          async () => {
            try {
              const runtime = await reload(changeSetManifest, JSON.stringify(manifest));
              if (runtime) await queryClient.invalidateQueries({ queryKey: homeKeys.all });
            } catch (error) {
              if (
                useWorkspaceStore.getState().selectedWorkspace?.id === workspaceId &&
                useWorkspaceStore.getState().project === targetProject
              )
                setMessage(localizeMessage(error));
            }
          },
          () => {
            if (!keepLaunchRequest) {
              if (appliedHandoffSetup) navigateToContinuation(true);
              else navigateTo(returnPage, appliedDoctorRepair);
            }
          },
        );
      }}
      onLaunchCompleted={() => {
        setHandoffLaunchRequest(undefined);
        navigateTo("sessions");
      }}
      onRejected={() => {
        const returnPage = changesReturnPage(changeSetOrigin);
        setChangeSet(undefined);
        setHandoffLaunchRequest(undefined);
        if (changeSetOrigin === "handoff-setup") navigateToContinuation(false);
        else navigateTo(returnPage);
      }}
      onApplyingChange={setApplyingChanges}
    />
  );
}

export const Route = createFileRoute("/(main)/workspace/$workspaceId/changes")({
  staticData: { appRoute: { kind: "workspace", page: "changes" } },
  component: WorkspaceChangesRoute,
});
