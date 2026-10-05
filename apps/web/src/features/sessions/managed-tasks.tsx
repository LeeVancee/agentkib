import { managedText } from "./managed-copy";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSessionNavigate } from "./session-navigation";
import { subscribeSessionInvalidation } from "./session-events";
import { Plus } from "lucide-react";
import { ApiError, isLegacyPreparedReceipt } from "@agentkib/web-client";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "../../components/ui/dialog";
import { useSession } from "./session-context";
import { catalogCopy } from "../catalog/catalog-copy";
import {
  forgetPending,
  pendingScope,
  readPending,
  rememberPending,
  type PendingControl,
} from "./pending-controls";

type Options = {
  available: boolean;
  reason?: string;
  models?: { id: string; name?: string; efforts?: string[] }[];
  workspaces: { id: string; name: string }[];
};

export function ManagedTasks({
  create = false,
  active,
  renderContent,
  onClose,
  onDismiss,
  initialOpen = false,
}: {
  create?: boolean;
  active?: boolean;
  renderContent?: (content: ReactNode) => ReactNode;
  onClose?: () => void;
  onDismiss?: () => void;
  initialOpen?: boolean;
}) {
  const { client, origin, access, current, live, selected, refresh, locale } = useSession();
  const [localOpen, setLocalOpen] = useState(initialOpen);
  const open = renderContent ? !!active : localOpen;
  function setOpen(value: boolean) {
    setLocalOpen(value);
    if (!value && renderContent) onClose?.();
  }
  const [options, setOptions] = useState<Options>();
  const [workspaceId, setWorkspaceId] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
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
          ? value.kind === "create"
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
  }, [scope, selected, create, locale]);
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
    setError("");
    if (!open || !access?.device?.manage || !access.experimentalEnabled) return;
    const abort = new AbortController();
    setOptions(undefined);
    void client
      .request<Options>("managed/options", undefined, abort.signal)
      .then((value) => {
        if (abort.signal.aborted) return;
        setOptions(value);
        setWorkspaceId(value.workspaces[0]?.id ?? "");
        setModel("");
        setEffort("");
      })
      .catch((e: unknown) => {
        if (!abort.signal.aborted) setError(e instanceof ApiError ? e.code : "connection_failed");
      });
    return () => {
      abort.abort();
    };
  }, [
    open,
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
    (!create && current?.agent !== "codex")
  )
    return renderContent ? renderContent(null) : null;
  const managed = live?.executionMode === "codex-managed";
  async function run(operation: "create" | "adopt" | "release" | "reconcile") {
    if (flight.current || (uncertain && operation !== "reconcile")) return;
    flight.current = true;
    setBusy(true);
    setError("");
    const generation = epoch.current;
    const requestId = crypto.randomUUID();
    const entry: PendingControl = {
      requestId,
      kind: operation,
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
          bootId: access!.bootId,
          requestId,
          ...(operation === "create"
            ? { workspaceId, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
            : { sessionId: selected }),
          ...(operation === "adopt" ? { handoffConfirmed: confirmed } : {}),
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
            ? `${e.code}${e.controlOutcome === "unknown" ? managedText(locale, ": refresh and verify before trying again", "：请刷新核对，勿直接重复操作") : ""}`
            : managedText(
                locale,
                "Connection lost. Verify the task list before retrying.",
                "连接中断，请先核对任务列表再重试。",
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
          "AgentKib must stay running. Tasks use workspace access and request approval when needed.",
          "AgentKib 需要保持后台运行。任务使用工作区权限，需要审批时等待你的确认。",
        )}
      </p>
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
              "A previous result is unknown. Wait for its saved receipt before another operation.",
              "上次结果尚未确认，请等待已保存的请求回执后再执行新的操作。",
            )}
          </p>
          <p>
            {managedText(
              locale,
              "The saved request is checked automatically. Refreshing cannot authorize a replay.",
              "正在自动查询已保存的请求回执；刷新不会授权重新执行。",
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
              {options.reason || managedText(locale, "Codex unavailable", "Codex 暂不可用")}
            </p>
          )}
          {create ? (
            <>
              <label>
                {managedText(locale, "Workspace", "工作区")}
                <select
                  className="mt-2 w-full rounded border bg-background p-2"
                  value={workspaceId}
                  onChange={(e) => setWorkspaceId(e.target.value)}
                >
                  {options.workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
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
              <p className="text-xs text-muted-foreground">
                {catalogCopy[locale].codexContextNote}
              </p>
              <label>
                {managedText(locale, "Model", "模型")}
                <select
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
                </select>
              </label>
              {!!options.models?.find((m) => m.id === model)?.efforts?.length && (
                <label>
                  {managedText(locale, "Reasoning effort", "思考强度")}
                  <select
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
                  </select>
                </label>
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
                  ? managedText(locale, "Execution belongs to AgentKib", "当前由 AgentKib 执行")
                  : managedText(
                      locale,
                      "Execution belongs to the original Codex client",
                      "当前由原 Codex 客户端执行",
                    )}
              </p>
              {!managed && (
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  {managedText(
                    locale,
                    "I have stopped the turn, handled pending requests and background commands, and closed the original execution client. Continue with the same task ID.",
                    "我已结束当前轮次、处理待审批事项和后台命令，并关闭原执行客户端。使用原任务 ID 继续。",
                  )}
                </label>
              )}
              <Button
                disabled={busy || uncertain || !options.available || (!managed && !confirmed)}
                onClick={() => void run(managed ? "release" : "adopt")}
              >
                {managed
                  ? managedText(locale, "Release to original client", "释放给原客户端")
                  : managedText(locale, "Hand over to AgentKib", "交给 AgentKib")}
              </Button>
              {managed && (
                <Button variant="outline" disabled={busy} onClick={() => void run("reconcile")}>
                  {managedText(locale, "Verify previous outcome", "核对上次执行结果")}
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
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        {create && <Plus size={16} />}
        {create
          ? managedText(locale, "New Codex task", "新建 Codex 任务")
          : managedText(locale, "Execution", "执行管理")}
      </Button>
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
              ? managedText(locale, "New Codex task", "新建 Codex 任务")
              : managedText(locale, "Execution ownership", "执行归属")}
          </DialogTitle>
          {content}
        </DialogContent>
      </Dialog>
    </>
  );
}
