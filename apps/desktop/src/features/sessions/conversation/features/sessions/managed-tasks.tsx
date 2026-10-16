import { managedText } from "./managed-copy";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useSessionNavigate } from "./session-navigation";
import { subscribeSessionInvalidation } from "./session-events";
import { Plus } from "lucide-react";
import {
  ApiError,
  isLegacyPreparedReceipt,
  type ManagedAgent,
  type ManagedOptions,
  type ClaudePermissionMode,
} from "@agentkib/web-client";
import { Button } from "@/components/ui/button";
import { NativeCheckbox } from "@/components/ui/native-checkbox";
import { NativeSelect } from "@/components/ui/native-select";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useSession } from "./session-context";
import { canConfirmClaudeHandoff, claudeHandoffBlockReason } from "./claude-handoff";
import { managedControlCopy, type ManagedControlBlockReason } from "./managed-control-copy";
import { catalogCopy } from "../catalog/catalog-copy";
import { sessionAgentCopy } from "./session-agent-copy";
import {
  forgetPending,
  pendingScope,
  readPending,
  rememberPending,
  type PendingControl,
} from "./pending-controls";

type Options = ManagedOptions;

export function ManagedTasks({
  create = false,
  active,
  renderContent,
  onClose,
  onDismiss,
  initialOpen = false,
  showTrigger = true,
}: {
  create?: boolean;
  active?: boolean;
  renderContent?: (content: ReactNode) => ReactNode;
  onClose?: () => void;
  onDismiss?: () => void;
  initialOpen?: boolean;
  showTrigger?: boolean;
}) {
  const session = useSession();
  const { client, origin, access, current, live, selected, refresh, locale } = session;
  const [localOpen, setLocalOpen] = useState(initialOpen);
  const open = renderContent ? !!active : localOpen;
  function setOpen(value: boolean) {
    setLocalOpen(value);
    if (!value && renderContent) onClose?.();
  }
  const [createAgent, setCreateAgent] = useState<ManagedAgent>("codex");
  const agent: ManagedAgent = create
    ? createAgent
    : current?.agent === "claude-code"
      ? "claude-code"
      : "codex";
  const [handoffFingerprint, setHandoffFingerprint] = useState<string>();
  const [handoffInspectPending, setHandoffInspectPending] = useState(false);
  const controlHintId = useId();
  const [options, setOptions] = useState<Options>();
  const [workspaceId, setWorkspaceId] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [permissionMode, setPermissionMode] = useState<ClaudePermissionMode | "">("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [pending, setPending] = useState<PendingControl>();
  const scope =
    access?.status === "approved" && access.device?.id
      ? pendingScope(origin, access.device.id)
      : undefined;
  const flight = useRef(false);
  const epoch = useRef(0);
  const navigate = useSessionNavigate();
  useEffect(() => {
    // A panel closing only hides controls; it must not invalidate an in-flight
    // command or prevent its unknown outcome from entering receipt reconciliation.
    epoch.current++;
    return () => {
      epoch.current++;
    };
  }, [
    scope,
    selected,
    create,
    agent,
    client,
    access?.bootId,
    access?.device?.manage,
    access?.experimentalEnabled,
  ]);
  useEffect(() => {
    setPending(undefined);
    setUncertain(false);
    if (!scope) return;
    try {
      const entry = readPending(scope).find((value) =>
        create
          ? value.kind === "create" && (value.agent ?? "codex") === agent
          : value.sessionId === selected && ["adopt", "release", "reconcile"].includes(value.kind),
      );
      setPending(entry);
      setUncertain(!!entry);
    } catch {
      setUncertain(true);
      setError(
        managedText(
          locale,
          "Cannot read the saved request identity.",
          "无法读取已保存的请求标识。",
        ),
      );
    }
  }, [scope, selected, create, agent, locale]);
  useEffect(() => {
    if (
      !scope ||
      !pending ||
      access?.status !== "approved" ||
      !access.device?.manage ||
      !access.experimentalEnabled
    )
      return;
    let cancelled = false;
    let checking = false;
    let dirty = false;
    const checkOnce = async () => {
      const generation = epoch.current;
      try {
        const result = await client.receipt(pending.requestId);
        if (
          cancelled ||
          !result.found ||
          result.requestId !== pending.requestId ||
          (!isLegacyPreparedReceipt(result, pending.requestId) &&
            (result.recovery !== undefined ||
              (pending.sessionId && result.sessionId !== pending.sessionId) ||
              result.operation !== pending.kind ||
              result.status === "unknown"))
        )
          return false;
        if (result.status !== "accepted" && result.status !== "not-dispatched") return false;
        forgetPending(scope, pending.requestId);
        setPending(undefined);
        setUncertain(false);
        setError(
          result.status === "not-dispatched"
            ? managedText(locale, "The request was not dispatched.", "该请求未发送到执行端。")
            : "",
        );
        await refresh(true);
        if (generation !== epoch.current) return true;
        if (result.status === "accepted") {
          setOpen(false);
          if (pending.kind === "create")
            void navigate({ to: "/sessions/$sessionId", params: { sessionId: result.sessionId } });
        }
        return true;
      } catch {
        /* Keep the saved identity and never retry the command itself. */
        return false;
      }
    };
    const check = async () => {
      if (checking) {
        dirty = true;
        return;
      }
      checking = true;
      try {
        do {
          dirty = false;
          if (await checkOnce()) break;
        } while (dirty && !cancelled);
      } finally {
        checking = false;
      }
    };
    void check();
    const unsubscribe = subscribeSessionInvalidation(client, (id, domains) => {
      if (
        (!id || id === selected) &&
        domains.some((domain) => ["receipts", "ownership"].includes(domain))
      )
        void check();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [
    scope,
    pending,
    access?.status,
    access?.bootId,
    access?.device?.manage,
    access?.experimentalEnabled,
    client,
    refresh,
    navigate,
    locale,
  ]);
  useEffect(() => {
    setConfirmed(false);
    setHandoffFingerprint(undefined);
    setHandoffInspectPending(false);
    setError("");
    if (!open || !access?.device?.manage || !access.experimentalEnabled) return;
    const abort = new AbortController();
    setOptions(undefined);
    void client
      .request<Options>(
        agent === "codex" ? "managed/options" : "managed/options?agent=claude-code",
        undefined,
        abort.signal,
      )
      .then((value) => {
        if (abort.signal.aborted) return;
        setOptions(value);
        setWorkspaceId(value.workspaces[0]?.id ?? "");
        setModel("");
        setEffort("");
        setPermissionMode("");
      })
      .catch((e: unknown) => {
        if (!abort.signal.aborted) setError(e instanceof ApiError ? e.code : "connection_failed");
      });
    if (!create && agent === "claude-code") {
      setHandoffInspectPending(true);
      void client
        .managedInspect(selected, agent, abort.signal)
        .then((value) => {
          if (!abort.signal.aborted && value.sessionId === selected)
            setHandoffFingerprint(value.handoffFingerprint);
        })
        .catch((e: unknown) => {
          if (!abort.signal.aborted) setError(e instanceof ApiError ? e.code : "connection_failed");
        })
        .finally(() => {
          if (!abort.signal.aborted) setHandoffInspectPending(false);
        });
    }
    return () => {
      abort.abort();
    };
  }, [
    open,
    agent,
    create,
    client,
    selected,
    access?.bootId,
    access?.device?.id,
    access?.device?.manage,
    access?.experimentalEnabled,
  ]);
  useEffect(() => {
    // An initial create request may arrive before the trusted access read finishes.
    if (access && (!access.device?.manage || !access.experimentalEnabled)) setLocalOpen(false);
  }, [access?.status, access?.device?.manage, access?.experimentalEnabled]);
  if (
    !access?.device?.manage ||
    !access.experimentalEnabled ||
    (!create && current?.agent !== "codex" && current?.agent !== "claude-code")
  )
    return renderContent ? renderContent(null) : null;
  const managed =
    live?.executionMode === "codex-managed" ||
    (live?.executionMode === "claude-managed" && live.status !== "released");
  const claudeBlockReason =
    !managed && agent === "claude-code" ? claudeHandoffBlockReason(session) : undefined;
  const controlBlockReason: ManagedControlBlockReason | undefined = busy
    ? "processing"
    : uncertain
      ? "uncertain"
      : live?.activity === "compacting"
        ? "compacting"
        : !options?.available
          ? "tool"
          : claudeBlockReason
            ? claudeBlockReason
            : !managed && !confirmed
              ? "confirmation"
              : !managed && agent === "claude-code" && !handoffFingerprint
                ? handoffInspectPending
                  ? "fingerprintLoading"
                  : "fingerprintUnavailable"
                : undefined;
  async function run(operation: "create" | "adopt" | "release" | "reconcile") {
    if (
      flight.current ||
      (operation === "adopt" && agent === "claude-code" && !canConfirmClaudeHandoff(session)) ||
      (live?.activity === "compacting" && (operation === "adopt" || operation === "release")) ||
      (uncertain && operation !== "reconcile") ||
      (operation === "adopt" && (!confirmed || (agent === "claude-code" && !handoffFingerprint)))
    )
      return;
    flight.current = true;
    setBusy(true);
    setError("");
    const generation = epoch.current;
    const requestId = crypto.randomUUID();
    const entry: PendingControl = {
      requestId,
      kind: operation,
      agent,
      ...(operation === "create" ? { workspaceId } : { sessionId: selected }),
    };
    try {
      try {
        if (!scope) throw new Error("missing_device_scope");
        rememberPending(scope, entry);
      } catch {
        throw new ApiError(409, "pending_storage_unavailable", "not-dispatched");
      }
      const result = await client.request<{ sessionId?: string; reconciled?: boolean }>(
        `managed/${operation}`,
        {
          ...(agent === "claude-code" ? { agent } : {}),
          bootId: access!.bootId,
          requestId,
          ...(operation === "release" ? { expectedRevision: live?.revision } : {}),
          ...(operation === "create"
            ? {
                workspaceId,
                ...(model ? { model } : {}),
                ...(effort ? { effort } : {}),
                ...(agent === "claude-code" && permissionMode ? { permissionMode } : {}),
              }
            : { sessionId: selected }),
          ...(operation === "adopt"
            ? {
                handoffConfirmed: confirmed,
                ...(agent === "claude-code" ? { handoffFingerprint } : {}),
              }
            : {}),
        },
      );
      if (scope) forgetPending(scope, requestId);
      if (generation !== epoch.current) return;
      setPending(undefined);
      if (operation === "reconcile" && result.reconciled !== true) {
        setUncertain(true);

        setError(
          managedText(
            locale,
            "The previous outcome is still unknown. No command was replayed.",
            "仍无法确认上次执行结果，没有重新发送命令。",
          ),
        );
        return;
      }
      await refresh(true);
      if (generation !== epoch.current) return;
      setOpen(false);
      setUncertain(false);

      if (operation === "create" && result.sessionId)
        void navigate({ to: "/sessions/$sessionId", params: { sessionId: result.sessionId } });
    } catch (e) {
      if (scope && e instanceof ApiError && e.controlOutcome === "not-dispatched") {
        try {
          forgetPending(scope, requestId);
        } catch {
          /* Preserve storage if unavailable. */
        }
      } else if (generation === epoch.current) setPending(entry);
      if (
        generation === epoch.current &&
        (!(e instanceof ApiError) || e.controlOutcome !== "not-dispatched")
      ) {
        setUncertain(true);
      }
      if (generation === epoch.current)
        setError(
          e instanceof ApiError
            ? `${e.code}${e.controlOutcome === "unknown" ? managedText(locale, ": refresh and check the outcome; do not repeat the operation", "：请刷新检查结果，勿重复操作") : ""}`
            : managedText(
                locale,
                "Connection lost. Verify the task list before retrying.",
                "连接中断，请先检查任务列表再重试。",
              ),
        );
    } finally {
      flight.current = false;
      setBusy(false);
    }
  }
  const content = (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {managedText(
          locale,
          "AgentKib must stay running on the host (the computer running the Agent). Tasks use workspace access and request approval when needed.",
          "AgentKib 需要在主机（运行 Agent 的电脑）上保持运行。任务使用工作区权限，需要审批时等待你的确认。",
        )}
      </p>
      {create && (
        <label>
          {managedText(locale, "Agent", "执行工具")}
          <NativeSelect
            className="mt-2 w-full rounded border bg-background p-2"
            value={agent}
            disabled={busy || uncertain}
            onChange={(event) => setCreateAgent(event.target.value as ManagedAgent)}
          >
            <option value="codex">Codex</option>
            <option value="claude-code">Claude Code</option>
          </NativeSelect>
        </label>
      )}
      {error && (
        <p role="alert" className="break-words text-sm text-destructive">
          {error}
        </p>
      )}
      {uncertain && (
        <div className="space-y-2 rounded border p-3 text-sm">
          <p>
            {managedText(
              locale,
              "The previous outcome is unconfirmed. Wait for the saved request's status before another operation.",
              "上次操作结果尚未确认。请等待系统确认已保存的请求，再执行新的操作。",
            )}
          </p>
          <p>
            {managedText(
              locale,
              "The saved request status is checked automatically. Refreshing does not run the operation again.",
              "正在自动查询已保存请求的处理状态；刷新不会重新执行操作。",
            )}
          </p>
        </div>
      )}
      {!options ? (
        <p role="status">{managedText(locale, "Loading…", "正在读取…")}</p>
      ) : (
        <>
          {!options.available && (
            <p role="status">
              {options.reason || managedText(locale, "Agent unavailable", "执行工具暂不可用")}
            </p>
          )}
          {create ? (
            <>
              <label>
                {managedText(locale, "Workspace", "工作区")}
                <NativeSelect
                  className="mt-2 w-full rounded border bg-background p-2"
                  value={workspaceId}
                  onChange={(e) => setWorkspaceId(e.target.value)}
                >
                  {options.workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              {!options.workspaces.length && (
                <p>
                  {managedText(
                    locale,
                    "Authorize a workspace in desktop Web settings first.",
                    "请先在桌面 Web 设置中授权工作区。",
                  )}
                </p>
              )}
              {(agent === "codex" || !!options.models?.length) && (
                <>
                  {agent === "codex" && (
                    <p className="text-xs text-muted-foreground">
                      {catalogCopy[locale].codexContextNote}
                    </p>
                  )}
                  <label>
                    {managedText(locale, "Model", "模型")}
                    <NativeSelect
                      className="mt-2 w-full rounded border bg-background p-2"
                      value={model}
                      onChange={(e) => {
                        setModel(e.target.value);
                        setEffort("");
                      }}
                    >
                      <option value="">{managedText(locale, "Host default", "主机默认")}</option>
                      {options.models?.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name || m.id}
                        </option>
                      ))}
                    </NativeSelect>
                  </label>
                  {!!options.models?.find((m) => m.id === model)?.efforts?.length && (
                    <label>
                      {managedText(locale, "Reasoning effort", "思考强度")}
                      <NativeSelect
                        className="mt-2 w-full rounded border bg-background p-2"
                        value={effort}
                        onChange={(e) => setEffort(e.target.value)}
                      >
                        <option value="">{managedText(locale, "Default", "默认")}</option>
                        {options.models
                          .find((m) => m.id === model)!
                          .efforts!.map((value) => (
                            <option key={value}>{value}</option>
                          ))}
                      </NativeSelect>
                    </label>
                  )}
                </>
              )}
              {agent === "claude-code" && !!options.permissionModes?.length && (
                <label>
                  {sessionAgentCopy[locale].permission}
                  <NativeSelect
                    className="mt-2 w-full rounded border bg-background p-2"
                    value={permissionMode}
                    onChange={(event) =>
                      setPermissionMode(event.target.value as ClaudePermissionMode | "")
                    }
                  >
                    <option value="">{managedText(locale, "Host default", "主机默认")}</option>
                    {options.permissionModes
                      .filter((item) => ["default", "plan", "acceptEdits"].includes(item.id))
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                  </NativeSelect>
                </label>
              )}
              {agent === "claude-code" && (
                <p className="text-xs text-muted-foreground">
                  {managedText(
                    locale,
                    "Uses the host Claude Code model and tool permissions by default. Creating a task does not start a model request.",
                    "默认沿用主机 Claude Code 的模型与工具权限。创建任务不会调用模型。",
                  )}
                </p>
              )}
              <Button
                disabled={busy || uncertain || !options.available || !workspaceId}
                onClick={() => void run("create")}
              >
                {managedText(locale, "Create", "创建")}
              </Button>
            </>
          ) : (
            <>
              <p>
                {managed
                  ? managedText(
                      locale,
                      "This session has been handed over to AgentKib",
                      "此会话已交给 AgentKib",
                    )
                  : managedText(
                      locale,
                      "This session has not been handed over to AgentKib",
                      "此会话尚未交给 AgentKib",
                    )}
              </p>
              {!managed && live?.executionMode !== "claude-follower" && (
                <label className="flex items-start gap-2 text-sm">
                  <NativeCheckbox
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  {managedText(
                    locale,
                    "I have stopped the turn, handled pending requests and background commands, and closed the original execution client. Continue with the same session ID.",
                    "我已结束当前轮次、处理待审批事项和后台命令，并关闭原执行客户端。使用原会话 ID 继续。",
                  )}
                </label>
              )}
              {live?.executionMode !== "claude-follower" && (
                <>
                  <Button
                    aria-describedby={controlBlockReason ? controlHintId : undefined}
                    disabled={
                      busy ||
                      uncertain ||
                      live?.activity === "compacting" ||
                      !options.available ||
                      (!managed && agent === "claude-code" && !canConfirmClaudeHandoff(session)) ||
                      (!managed && (!confirmed || (agent === "claude-code" && !handoffFingerprint)))
                    }
                    onClick={() => void run(managed ? "release" : "adopt")}
                  >
                    {managed
                      ? managedText(locale, "Return to original client", "交还原客户端")
                      : managedText(locale, "Hand over to AgentKib", "交给 AgentKib")}
                  </Button>
                  {controlBlockReason && (
                    <p id={controlHintId} role="status" className="text-sm text-muted-foreground">
                      {managedControlCopy[locale][controlBlockReason]}
                    </p>
                  )}
                </>
              )}
              {managed && (
                <Button variant="outline" disabled={busy} onClick={() => void run("reconcile")}>
                  {managedText(locale, "Check previous outcome", "检查上次操作结果")}
                </Button>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
  if (renderContent) return renderContent(content);
  return (
    <>
      {showTrigger && (
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
          {create && <Plus size={16} />}
          {create
            ? managedText(locale, "New task", "新建任务")
            : managedText(locale, "Execution management", "执行管理")}
        </Button>
      )}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) {
            setOpen(value);
            if (!value) onDismiss?.();
          }
        }}
      >
        <DialogContent>
          <DialogTitle>
            {create
              ? managedText(locale, "New task", "新建任务")
              : managedText(locale, "Execution management", "执行管理")}
          </DialogTitle>
          {content}
        </DialogContent>
      </Dialog>
    </>
  );
}
