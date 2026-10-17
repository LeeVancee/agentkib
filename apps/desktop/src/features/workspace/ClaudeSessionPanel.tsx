import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  Approval,
  ControlReceipt,
  ConversationCatalog,
  ConversationEventPage,
  Live,
  ManagedActionResult,
  ManagedInspection,
  ManagedOptions,
  SessionCapabilities,
  UploadedAttachment,
  UserQuestionRequest,
} from "../../../../../packages/web-client/src/index";
import {
  ContextUsageIndicator,
  useObservedContextUsage,
} from "@/features/sessions/conversation/features/sessions/context-usage";
import { codexReason } from "@/features/sessions/conversation/features/sessions/codex-copy";
import { claudeConnectionCopy } from "@/features/sessions/conversation/features/sessions/claude-connection-copy";
import { contextUsageCopy } from "@/features/sessions/conversation/features/sessions/context-usage-copy";
import { PermissionModeNotice } from "@/features/sessions/conversation/features/sessions/permission-mode-notice";
import { ClaudeFilesPanel } from "./ClaudeFilesPanel";
import { api } from "@/core/api";
import { hasDesktopConversation } from "@/core/conversation-bridge";
import { useI18n } from "@/core/useI18n";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { MarkdownContent } from "@/components/MarkdownContent";
import { isClaudeReadBusy, useClaudeSessionObservation } from "./useClaudeSessionObservation";
import { mergeNativeCoverage, mergeOrderedPersistedHistory } from "@agentkib/conversation-state";

type Pending = { requestId: string; operation: string; sessionId?: string; workspaceId: string };
type Interaction = Approval | UserQuestionRequest;
const pendingKey = (workspaceId: string) => `agentkib:claude-owner-pending:v1:${workspaceId}`;
function readPending(workspaceId: string): Pending | undefined {
  const raw = localStorage.getItem(pendingKey(workspaceId));
  if (!raw) return;
  const value: unknown = JSON.parse(raw);
  if (
    !value ||
    typeof value !== "object" ||
    !("requestId" in value) ||
    typeof value.requestId !== "string" ||
    !/^[a-f0-9-]{36}$/i.test(value.requestId) ||
    !("operation" in value) ||
    typeof value.operation !== "string" ||
    !["create", "adopt", "release", "reconcile", "send", "stop", "approve", "answer"].includes(
      value.operation,
    ) ||
    !("workspaceId" in value) ||
    value.workspaceId !== workspaceId ||
    (value.operation !== "create" &&
      (!("sessionId" in value) ||
        typeof value.sessionId !== "string" ||
        !value.sessionId ||
        value.sessionId.length > 256))
  )
    throw new Error("pending_control_storage_invalid");
  return value as Pending;
}
function forgetPending(workspaceId: string, requestId: string) {
  if (readPending(workspaceId)?.requestId === requestId)
    localStorage.removeItem(pendingKey(workspaceId));
}
async function request<T>(operation: string, body: Record<string, unknown> = {}): Promise<T> {
  return (await api.claudeRequest({ operation, ...body })) as T;
}

function TechnicalDetails({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <Collapsible className="text-xs">
      <CollapsibleTrigger className="cursor-pointer text-left underline underline-offset-2">
        {label}
      </CollapsibleTrigger>
      <CollapsibleContent keepMounted>
        <pre className="whitespace-pre-wrap">{value}</pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Desktop uses the same owner service and receipts as Web; no CLI lives in the renderer. */
export function ClaudeSessionPanel({
  workspaceId,
  initialSessionId,
  onClose,
}: {
  workspaceId: string;
  initialSessionId?: string;
  onClose: () => void;
}) {
  const { locale } = useI18n();
  const connectionCopy = claudeConnectionCopy[locale];
  const text = (zh: string, en: string, tw: string, ja: string) =>
    ({ "zh-CN": zh, "en-US": en, "zh-TW": tw, "ja-JP": ja })[locale];
  const detailsLabel = text("技术详情", "Technical details", "技術詳情", "技術的な詳細");
  const explainError = (reason: string) => {
    const normalized = reason.replaceAll("_", "-");
    const messages: Record<string, string> = {
      "attachment-limit": text(
        "最多添加 10 个附件，请移除后重试。",
        "Choose at most 10 attachments. Remove one and retry.",
        "最多新增 10 個附件，請移除後重試。",
        "添付は 10 件までです。削除して再試行してください。",
      ),
      "attachment-too-large": text(
        "附件不能超过 25 MB，请选择较小的文件。",
        "Attachments must be at most 25 MB. Choose a smaller file.",
        "附件不能超過 25 MB，請選擇較小的檔案。",
        "添付は 25 MB 以下にしてください。小さいファイルを選択してください。",
      ),
      "upload-failed": text(
        "附件上传失败，请重新选择文件。",
        "The attachment upload failed. Choose the file again.",
        "附件上傳失敗，請重新選擇檔案。",
        "添付をアップロードできませんでした。ファイルを選び直してください。",
      ),
      "inspect-failed": text(
        "无法检查原客户端状态，请检查原终端后重试。",
        "Could not inspect the original client. Check the terminal and retry.",
        "無法檢查原客戶端狀態，請檢查原終端機後重試。",
        "元のクライアントの状態を確認できません。ターミナルを確認して再試行してください。",
      ),
      "connection-failed": text(
        "连接失败，请检查原终端并刷新。",
        "The connection failed. Check the original terminal and refresh.",
        "連線失敗，請檢查原終端機並重新整理。",
        "接続できませんでした。元のターミナルを確認して更新してください。",
      ),
      "claude-session-unavailable": text(
        "此 Claude 会话暂不可用，请检查原终端并刷新。",
        "This Claude session is unavailable. Check the original terminal and refresh.",
        "此 Claude 對話暫時無法使用，請檢查原終端機並重新整理。",
        "この Claude 会話を利用できません。元のターミナルを確認して更新してください。",
      ),
    };
    if (messages[normalized]) return { text: messages[normalized], technical: reason };
    const mapped = codexReason(locale, normalized);
    return mapped.technical === normalized
      ? {
          text: text(
            "操作未完成，请刷新状态后重试。",
            "The operation could not be completed. Refresh the state before retrying.",
            "操作未完成，請重新整理狀態後重試。",
            "操作を完了できませんでした。状態を更新してから再試行してください。",
          ),
          technical: reason,
        }
      : { ...mapped, technical: mapped.technical ?? reason };
  };
  const [filesOpen, setFilesOpen] = useState(false);
  const [sessionId, setSessionId] = useState(initialSessionId ?? "");
  const [observedSessionId, setObservedSessionId] = useState("");
  const [catalog, setCatalog] = useState<ConversationCatalog>();
  const [options, setOptions] = useState<ManagedOptions>();
  const [live, setLive] = useState<Live>();
  const stoppedReason = live?.reason ? explainError(live.reason) : undefined;
  const [capabilities, setCapabilities] = useState<SessionCapabilities>();
  const [history, setHistory] = useState<ConversationEventPage>();
  const [inspection, setInspection] = useState<ManagedInspection>();
  const [confirmed, setConfirmed] = useState(false);
  const inspectionReleased = live?.status === "released";
  const [inspectionSource, setInspectionSource] = useState({
    workspaceId,
    sessionId,
    executionMode: live?.executionMode,
    connectionGeneration: live?.connectionGeneration,
    released: inspectionReleased,
  });
  if (
    inspectionSource.workspaceId !== workspaceId ||
    inspectionSource.sessionId !== sessionId ||
    inspectionSource.executionMode !== live?.executionMode ||
    inspectionSource.connectionGeneration !== live?.connectionGeneration ||
    inspectionSource.released !== inspectionReleased
  ) {
    setInspectionSource({
      workspaceId,
      sessionId,
      executionMode: live?.executionMode,
      connectionGeneration: live?.connectionGeneration,
      released: inspectionReleased,
    });
    setInspection(undefined);
    setConfirmed(false);
  }
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState<Pending>();
  const [storageBlocked, setStorageBlocked] = useState(false);
  const [interaction, setInteraction] = useState<Interaction>();
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const epoch = useRef(0),
    inspectionRequest = useRef(0),
    flight = useRef(false),
    loading = useRef(false);
  const liveRef = useRef(live);
  useEffect(() => {
    liveRef.current = live;
  }, [live]);
  useLayoutEffect(() => {
    // A source inspected before terminal ownership changed needs a new proof.
    // Keep this separate from the history stream's session generation.
    inspectionRequest.current++;
  }, [workspaceId, sessionId, live?.executionMode, live?.connectionGeneration, inspectionReleased]);
  const shown = useRef(new Set<string>());
  const refreshRef = useRef<(details?: boolean) => Promise<void>>(async () => {});
  const queuedRefresh = useRef<boolean | undefined>(undefined);
  const refreshNeedsDetails = useRef(false);
  useEffect(() => {
    epoch.current++;
    setFilesOpen(false);
    setLive(undefined);
    setObservedSessionId("");
    setCapabilities(undefined);
    setHistory(undefined);
    setInspection(undefined);
    setConfirmed(false);
    setDraft("");
    setAttachments([]);
    setInteraction(undefined);
    setAnswers({});
    setCustom({});
    setConnected(false);
    setRefreshError("");
    refreshNeedsDetails.current = false;
    setError("");
    void refreshRef.current();
    return () => {
      epoch.current++;
      queuedRefresh.current = undefined;
    };
  }, [workspaceId, sessionId]);
  const refreshMetadata = useCallback(() => {
    void refreshRef.current(false);
  }, []);
  const hasPending = useCallback(() => {
    try {
      return !!readPending(workspaceId);
    } catch {
      return true;
    }
  }, [workspaceId]);
  const {
    liveDelivery,
    usageEpoch,
    nativeCoverage,
    catalogReady,
    catalogError,
    controlReady,
    retry,
    deferredRead,
    deferRead,
    refreshWake,
    completeDeferredRead,
  } = useClaudeSessionObservation({
    sessionId: observedSessionId,
    generation: epoch,
    setLive,
    setHistory,
    setOnline: setConnected,
    setError,
    refreshMetadata,
    refreshCapabilities: refreshMetadata,
    hasPending,
  });
  const online = connected && catalogReady && !refreshError;
  const displayError = error || refreshError || catalogError;
  const errorCopy = displayError ? explainError(displayError) : undefined;
  const optionsReason =
    !options?.available && options?.reason ? explainError(options.reason) : undefined;
  const compacting = live?.activity === "compacting";
  const usageView = useObservedContextUsage({
    selected: sessionId,
    scope: `${sessionId}\0${workspaceId}\0${usageEpoch}`,
    live,
    online,
    authorized: true,
  });

  const refresh = useCallback(
    async (details = true) => {
      details = details || deferredRead.current || refreshNeedsDetails.current;
      if (loading.current) {
        queuedRefresh.current = queuedRefresh.current === true || details;
        return;
      }
      const finishRefresh = () => {
        loading.current = false;
        if (queuedRefresh.current !== undefined) {
          const queuedDetails = queuedRefresh.current;
          queuedRefresh.current = undefined;
          void refreshRef.current(queuedDetails);
        }
      };
      loading.current = true;
      const generation = epoch.current;
      const delivery = liveDelivery.current;
      const wake = refreshWake.current;
      try {
        const saved = readPending(workspaceId);
        let nextPending = saved;
        if (saved) {
          const receipt = await request<ControlReceipt>("receipt", { requestId: saved.requestId });
          if (generation !== epoch.current) {
            finishRefresh();
            return;
          }
          if (
            receipt.found &&
            receipt.requestId === saved.requestId &&
            receipt.operation === saved.operation &&
            (!saved.sessionId || saved.sessionId === receipt.sessionId) &&
            (receipt.status === "accepted" || receipt.status === "not-dispatched")
          ) {
            forgetPending(workspaceId, saved.requestId);
            nextPending = readPending(workspaceId);
            if (!nextPending) retry();
            if (receipt.status === "accepted" && saved.operation === "create")
              setSessionId(receipt.sessionId);
            if (
              receipt.status === "accepted" &&
              saved.operation === "send" &&
              saved.sessionId === sessionId
            ) {
              setDraft("");
              setAttachments([]);
            }
          }
        }
        const [nextOptions, nextCatalog] = await Promise.all([
          request<ManagedOptions>("options"),
          request<ConversationCatalog>("catalog"),
        ]);
        if (generation !== epoch.current) {
          finishRefresh();
          return;
        }
        setPending(nextPending);
        setOptions(nextOptions);
        setCatalog(nextCatalog);
        if (sessionId) {
          // Workspace history uses the index ID, while control uses the managed
          // identity. Resolve only an exact, unique mapping in this workspace.
          const localSessions = nextCatalog.sessions.filter(
            (row) => row.workspace_id === workspaceId && row.agent === "claude-code",
          );
          if (!localSessions.some((row) => row.id === sessionId)) {
            const matches = localSessions.filter(
              (row) =>
                row.indexedSessionId === sessionId || row.indexedSessionIds?.includes(sessionId),
            );
            if (matches.length === 1) {
              setSessionId(matches[0].id);
              finishRefresh();
              return;
            }
            refreshNeedsDetails.current = refreshNeedsDetails.current || details;
            setRefreshError("claude_session_unavailable");
            if (!sessionId || !hasDesktopConversation()) setConnected(false);
            try {
              readPending(workspaceId);
            } catch {
              setStorageBlocked(true);
            }
            finishRefresh();
            return;
          }
          setObservedSessionId(sessionId);
          // Native state changes invalidate metadata even when history stays current.
          // Keep dynamic capabilities in the same serialized refresh and busy recovery.
          const [nextCaps, nextLive, nextHistory] = await Promise.all([
            request<SessionCapabilities>("capabilities", { sessionId }),
            details ? request<Live>("live", { sessionId }) : undefined,
            details ? request<ConversationEventPage>("events", { sessionId }) : undefined,
          ]);
          if (generation !== epoch.current) {
            finishRefresh();
            return;
          }
          setCapabilities(nextCaps);
          if (nextLive && nextHistory) {
            if (delivery === liveDelivery.current) setLive(nextLive);
            setHistory((old) => ({
              ...nextHistory,
              events: mergeNativeCoverage(
                mergeOrderedPersistedHistory(
                  old?.events ?? [],
                  nextHistory.events,
                  old ? "latest" : "older",
                ),
                nativeCoverage.current,
              ),
            }));
          }
        }
        // Reads and the stream recover independently: neither can clear the
        // other's failure and reopen controls before both are healthy.
        setRefreshError("");
        refreshNeedsDetails.current = false;
        if (!sessionId || !hasDesktopConversation()) setConnected(true);
        setStorageBlocked(false);
        if (details) completeDeferredRead();
      } catch (e) {
        if (generation !== epoch.current) {
          finishRefresh();
          return;
        }
        if (isClaudeReadBusy(e)) {
          deferRead(wake, generation);
          finishRefresh();
          return;
        }
        // A metadata-only success cannot recover an unread history/live page.
        refreshNeedsDetails.current = refreshNeedsDetails.current || details;
        setRefreshError((e instanceof Error && e.message) || "connection_failed");
        if (!sessionId || !hasDesktopConversation()) setConnected(false);
        try {
          readPending(workspaceId);
        } catch {
          setStorageBlocked(true);
        }
      }
      finishRefresh();
    },
    [
      workspaceId,
      sessionId,
      liveDelivery,
      nativeCoverage,
      retry,
      deferredRead,
      deferRead,
      refreshWake,
      completeDeferredRead,
    ],
  );
  useLayoutEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);
  useEffect(() => {
    if (!online || interaction || !live) return;
    const next = [...live.approvals, ...(live.questions ?? [])].find(
      (item) =>
        item.supported && !shown.current.has(`${sessionId}:${item.turnId}:${item.requestId}`),
    );
    if (next) {
      shown.current.add(`${sessionId}:${next.turnId}:${next.requestId}`);
      setInteraction(next);
      setAnswers({});
      setCustom({});
    }
  }, [live, interaction, online, sessionId]);

  async function mutate(operation: string, body: Record<string, unknown> = {}) {
    if (
      flight.current ||
      pending ||
      storageBlocked ||
      !online ||
      !controlReady ||
      (liveRef.current?.executionMode === "claude-follower" &&
        ["adopt", "release"].includes(operation)) ||
      (compacting && ["send", "adopt", "release"].includes(operation))
    )
      return;
    flight.current = true;
    setBusy(true);
    setError("");
    const generation = epoch.current;
    const entry: Pending = {
      requestId: crypto.randomUUID(),
      operation,
      workspaceId,
      ...(operation !== "create" && sessionId ? { sessionId } : {}),
    };
    try {
      // Persist identity before IPC. An ambiguous failure is reconciled, never replayed.
      if (readPending(workspaceId)) {
        if (generation === epoch.current) setError("control_outcome_unconfirmed");
      } else {
        localStorage.setItem(pendingKey(workspaceId), JSON.stringify(entry));
        setPending(entry);
        const result = await request<
          ManagedActionResult & { controlOutcome?: string; error?: string }
        >(operation, { ...entry, ...body, expectedRevision: live?.revision });
        if (
          (result.accepted !== true && result.reconciled !== true) ||
          (result.sessionId && operation !== "create" && result.sessionId !== sessionId)
        ) {
          if (result.controlOutcome === "not-dispatched") {
            forgetPending(workspaceId, entry.requestId);
            if (generation === epoch.current) setPending(undefined);
          }
          if (generation === epoch.current) setError(result.error || "control_outcome_unconfirmed");
        } else {
          forgetPending(workspaceId, entry.requestId);
          if (generation === epoch.current) {
            setPending(undefined);
            setInteraction(undefined);
            if (operation === "create" && result.sessionId) setSessionId(result.sessionId);
            if (operation === "send") {
              setDraft("");
              setAttachments([]);
            }
            setInspection(undefined);
            setConfirmed(false);
            await refresh();
            if (generation === epoch.current) retry();
          }
        }
      }
    } catch (e) {
      if (generation === epoch.current)
        setError(e instanceof Error ? e.message : "control_outcome_unconfirmed");
    }
    flight.current = false;
    setBusy(false);
  }
  async function inspect() {
    if (
      flight.current ||
      blocked ||
      compacting ||
      hasPending() ||
      liveRef.current?.executionMode === "claude-follower"
    )
      return;
    flight.current = true;
    setBusy(true);
    setError("");
    const generation = epoch.current;
    const requestId = ++inspectionRequest.current;
    const isCurrentInspection = () =>
      generation === epoch.current &&
      requestId === inspectionRequest.current &&
      liveRef.current?.executionMode !== "claude-follower";
    setConfirmed(false);
    setInspection(undefined);
    try {
      const next = await request<ManagedInspection>("inspect", { sessionId });
      if (isCurrentInspection() && next.sessionId === sessionId) setInspection(next);
    } catch (e) {
      if (isCurrentInspection()) setError(e instanceof Error ? e.message : "inspect_failed");
    } finally {
      flight.current = false;
      setBusy(false);
    }
  }
  async function upload(files: File[]) {
    if (
      flight.current ||
      pending ||
      !online ||
      !controlReady ||
      capabilities?.features.attachments?.available !== true
    )
      return;
    flight.current = true;
    setBusy(true);
    const generation = epoch.current;
    try {
      if (attachments.length + files.length > 10) {
        if (generation === epoch.current) setError("attachment_limit");
      } else {
        for (const file of files) {
          if (file.size > 25 * 1024 * 1024) {
            if (generation === epoch.current) setError("attachment_too_large");
            break;
          }
          const item = await request<UploadedAttachment>("upload", {
            sessionId,
            name: file.name,
            mime: file.type || "application/octet-stream",
            bytes: new Uint8Array(await file.arrayBuffer()),
          });
          if (generation !== epoch.current) break;
          setAttachments((old) => [...old, item]);
        }
      }
    } catch (e) {
      if (generation === epoch.current) setError(e instanceof Error ? e.message : "upload_failed");
    }
    flight.current = false;
    setBusy(false);
  }
  const filesAvailable =
    online &&
    capabilities?.sessionId === sessionId &&
    capabilities.features.files?.available === true;
  const statusLabels: Record<string, string> = {
    idle: text("空闲", "Idle", "閒置", "待機中"),
    starting: text("正在启动", "Starting", "正在啟動", "起動中"),
    running: text("执行中", "Running", "執行中", "実行中"),
    "waiting-approval": text("等待审批", "Awaiting approval", "等待審批", "承認待ち"),
    "waiting-input": text("等待回答", "Awaiting answer", "等待回答", "回答待ち"),
    "awaiting-approval": text("等待审批", "Awaiting approval", "等待審批", "承認待ち"),
    "awaiting-input": text("等待回答", "Awaiting answer", "等待回答", "回答待ち"),
    "outcome-unknown": text("结果待核对", "Outcome unknown", "結果待核對", "結果の確認が必要"),
    released: text("已交还", "Returned", "已交還", "返却済み"),
    failed: text("执行失败", "Failed", "執行失敗", "実行に失敗"),
    unavailable: text("不可用", "Unavailable", "無法使用", "利用できません"),
    readonly: text("只读", "Read only", "唯讀", "閲覧のみ"),
  };
  const managed = live?.executionMode === "claude-managed" && live.status !== "released";
  const blocked =
    busy ||
    !!pending ||
    storageBlocked ||
    !online ||
    !controlReady ||
    sessionId !== observedSessionId;
  const interactionCurrent =
    !!interaction &&
    interaction.supported &&
    online &&
    [...(live?.approvals ?? []), ...(live?.questions ?? [])].some(
      (item) => JSON.stringify(item) === JSON.stringify(interaction),
    );
  const questionAnswers =
    interaction && "questions" in interaction
      ? Object.fromEntries(
          interaction.questions.map((q) => [
            q.id,
            [
              ...(answers[q.id] ?? []),
              ...(q.allowCustom && custom[q.id]?.trim() ? [custom[q.id].trim()] : []),
            ],
          ]),
        )
      : {};
  const validAnswers =
    interaction &&
    "questions" in interaction &&
    interaction.questions.every(
      (q) =>
        (questionAnswers[q.id]?.length ?? 0) > 0 &&
        (q.multiSelect || questionAnswers[q.id].length === 1),
    ) &&
    JSON.stringify(questionAnswers).length <= 16384;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogTitle>Claude Code</DialogTitle>
        <p className="text-xs text-muted-foreground">
          {text(
            "沿用主机 CLI 的模型和工具权限。关闭窗口不会停止执行；退出 AgentKib 会停止自有进程。",
            "Uses the host CLI model and tool permissions. Closing this panel does not stop execution; quitting AgentKib stops owned processes.",
            "沿用主機 CLI 的模型與工具權限。關閉視窗不會停止執行；結束 AgentKib 會停止自有行程。",
            "ホスト CLI のモデルとツール権限を使用します。このパネルを閉じても実行は停止しません。AgentKib を終了すると、AgentKib が所有するプロセスが停止します。",
          )}
        </p>
        <div className="flex gap-2">
          <Button
            disabled={blocked || !options?.available}
            onClick={() => void mutate("create", { workspaceId })}
          >
            {text(
              "新建 Claude 任务",
              "New Claude task",
              "新增 Claude 任務",
              "Claude タスクを新規作成",
            )}
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              retry();
              void refresh();
            }}
          >
            {text("刷新", "Refresh", "重新整理", "更新")}
          </Button>
        </div>
        {(live?.model || live?.cliVersion || options?.cliVersion) && (
          <p className="text-xs">
            {[live?.model, live?.cliVersion || options?.cliVersion].filter(Boolean).join(" · ")}
          </p>
        )}
        <PermissionModeNotice permission={live?.permission} locale={locale} />
        {optionsReason && (
          <div role="status">
            <p>{optionsReason.text}</p>
            <TechnicalDetails label={detailsLabel} value={optionsReason.technical} />
          </div>
        )}
        <label>
          {text("会话", "Session", "對話", "会話")}
          <Select
            value={sessionId}
            disabled={busy}
            onValueChange={(value) => setSessionId(value ?? "")}
          >
            <SelectTrigger aria-label={text("会话", "Session", "對話", "会話")} className="w-full">
              <SelectValue
                placeholder={text("选择会话", "Choose a session", "選擇對話", "会話を選択")}
              >
                {sessionId
                  ? catalog?.sessions.find((item) => item.id === sessionId)?.title || "Claude Code"
                  : text("选择会话", "Choose a session", "選擇對話", "会話を選択")}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>{text("会话", "Session", "對話", "会話")}</SelectLabel>
                {catalog?.sessions
                  .filter((item) => item.workspace_id === workspaceId)
                  .map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.title || "Claude Code"}
                    </SelectItem>
                  ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </label>
        {errorCopy && (
          <div role="alert" className="text-destructive break-words">
            <p>{errorCopy.text}</p>
            <TechnicalDetails label={detailsLabel} value={errorCopy.technical} />
          </div>
        )}
        {pending && (
          <p role="status">
            {text(
              "结果待核对，正在查询原请求回执；不会自动重发。",
              "Outcome unknown. Checking the original receipt; no command will be replayed.",
              "結果待核對，正在查詢原請求回執；不會自動重送。",
              "結果を確認中です。元のリクエストの受領記録を照会しています。コマンドは再送しません。",
            )}
          </p>
        )}
        {sessionId && (
          <>
            <p role="status">
              {live?.status === "idle" && live.lastOutcome === "cancelled"
                ? text("已取消", "Cancelled", "已取消", "キャンセル済み")
                : live?.status
                  ? statusLabels[live.status] ||
                    text("状态待核对", "State unavailable", "狀態待核對", "状態を確認できません")
                  : text("正在读取", "Loading", "正在讀取", "読み込み中")}
              {stoppedReason ? ` · ${stoppedReason.text}` : ""}
            </p>
            {stoppedReason?.technical && (
              <TechnicalDetails label={detailsLabel} value={stoppedReason.technical} />
            )}
            {filesAvailable && (
              <div className="space-y-2">
                <Button
                  variant="outline"
                  aria-expanded={filesOpen}
                  onClick={() => setFilesOpen((open) => !open)}
                >
                  {text("文件与产物", "Files and artifacts", "檔案與產物", "ファイルと成果物")}
                </Button>
                {filesOpen && <ClaudeFilesPanel key={sessionId} sessionId={sessionId} />}
              </div>
            )}
            {live?.executionMode === "claude-follower" ? (
              <div role="status" className="space-y-1 text-sm text-muted-foreground">
                <p>{connectionCopy.disconnectFirst}</p>
                <p>
                  {text(
                    `请关闭此面板，在会话页选择“${connectionCopy.manage}”，然后选择“${connectionCopy.disconnect}”。`,
                    `Close this panel, choose “${connectionCopy.manage}” on the session page, then choose “${connectionCopy.disconnect}”.`,
                    `請關閉此面板，在對話頁面選擇「${connectionCopy.manage}」，然後選擇「${connectionCopy.disconnect}」。`,
                    `このパネルを閉じ、会話ページで「${connectionCopy.manage}」、次に「${connectionCopy.disconnect}」を選択してください。`,
                  )}
                </p>
              </div>
            ) : !managed ? (
              <div className="space-y-2">
                <Button
                  variant={inspection?.handoffFingerprint ? "outline" : "default"}
                  disabled={blocked || compacting}
                  onClick={() => void inspect()}
                >
                  {inspection?.handoffFingerprint
                    ? text(
                        "重新检查原会话",
                        "Recheck original session",
                        "重新檢查原對話",
                        "元の会話を再確認",
                      )
                    : text(
                        "交给 AgentKib",
                        "Hand over to AgentKib",
                        "交給 AgentKib",
                        "AgentKib に引き渡す",
                      )}
                </Button>
                {inspection?.handoffFingerprint && (
                  <>
                    <label className="flex gap-2">
                      <Checkbox
                        checked={confirmed}
                        onCheckedChange={(checked) => setConfirmed(checked)}
                      />
                      {text(
                        "我已停止原终端和其他客户端，按原 UUID 继续。",
                        "I have stopped the original terminal and other clients. Continue the same UUID.",
                        "我已停止原終端機與其他客戶端，使用原 UUID 繼續。",
                        "元のターミナルと他のクライアントを停止しました。同じ UUID で続けます。",
                      )}
                    </label>
                    <Button
                      disabled={blocked || compacting || !confirmed}
                      onClick={() =>
                        void mutate("adopt", {
                          handoffConfirmed: true,
                          handoffFingerprint: inspection.handoffFingerprint,
                        })
                      }
                    >
                      {text(
                        "交给 AgentKib",
                        "Hand over to AgentKib",
                        "交給 AgentKib",
                        "AgentKib に引き渡す",
                      )}
                    </Button>
                  </>
                )}
              </div>
            ) : (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  disabled={blocked || compacting}
                  onClick={() => void mutate("release")}
                >
                  {text(
                    "交还原客户端",
                    "Return to original client",
                    "交還原客戶端",
                    "元のクライアントに戻す",
                  )}
                </Button>
                <Button
                  variant="outline"
                  disabled={blocked}
                  onClick={() => void mutate("reconcile")}
                >
                  {text("核对执行结果", "Reconcile outcome", "核對執行結果", "実行結果を確認")}
                </Button>
              </div>
            )}
            <div
              className="max-h-80 overflow-y-auto space-y-3"
              aria-label={text("会话历史", "History", "對話歷史", "会話履歴")}
            >
              {history?.events.map((event) => (
                <article key={event.id}>
                  <strong className="text-xs">
                    {event.kind === "user-message"
                      ? text("你", "You", "你", "あなた")
                      : event.tool_name || "Claude"}
                  </strong>
                  <MarkdownContent content={event.content ?? event.tool_status ?? ""} />
                </article>
              ))}
              {live?.status !== "idle" &&
                live?.streamText &&
                !(
                  live.turnId &&
                  history?.events.some(
                    (event) => event.kind === "agent-message" && event.turn_id === live.turnId,
                  )
                ) && <MarkdownContent content={live.streamText} />}
              {history?.warnings.map((warning) => (
                <p key={warning} role="status">
                  {warning}
                </p>
              ))}
            </div>
            {[...(live?.approvals ?? []), ...(live?.questions ?? [])].map((item) => (
              <Button
                key={item.requestId}
                variant="outline"
                onClick={() => {
                  setInteraction(item);
                  setAnswers({});
                  setCustom({});
                }}
              >
                {"questions" in item
                  ? text("回答问题", "Answer question", "回答問題", "質問に回答")
                  : text("处理审批", "Review approval", "處理審批", "承認内容を確認")}
              </Button>
            ))}
            {interaction && (
              <section className="rounded border p-3 space-y-2">
                <Button variant="ghost" onClick={() => setInteraction(undefined)}>
                  {text("收起", "Dismiss", "收合", "閉じる")}
                </Button>
                {!interactionCurrent && (
                  <p role="status">
                    {text(
                      "表单已失效，请刷新。",
                      "This form is no longer current. Refresh.",
                      "表單已失效，請重新整理。",
                      "このフォームは無効です。更新してください。",
                    )}
                  </p>
                )}
                {"questions" in interaction ? (
                  <>
                    {interaction.questions.map((q) => (
                      <fieldset key={q.id} disabled={blocked || !interactionCurrent}>
                        <legend>{q.question}</legend>
                        {q.options.map((option) => (
                          <label key={option.label} className="flex gap-2">
                            <Checkbox
                              name={q.id}
                              checked={(answers[q.id] ?? []).includes(option.label)}
                              onCheckedChange={(checked) => {
                                if (!q.multiSelect) setCustom((old) => ({ ...old, [q.id]: "" }));
                                setAnswers((old) => ({
                                  ...old,
                                  [q.id]: q.multiSelect
                                    ? checked
                                      ? [...(old[q.id] ?? []), option.label]
                                      : (old[q.id] ?? []).filter((x) => x !== option.label)
                                    : [option.label],
                                }));
                              }}
                            />
                            {option.label}
                            {option.description ? ` — ${option.description}` : ""}
                          </label>
                        ))}
                        {q.allowCustom && (
                          <Input
                            aria-label={`${q.question} ${text("自定义回答", "Custom answer", "自訂回答", "自由回答")}`}
                            type={q.isSecret || q.secret ? "password" : "text"}
                            maxLength={4096}
                            value={custom[q.id] ?? ""}
                            onChange={(event) => {
                              setCustom((old) => ({ ...old, [q.id]: event.target.value }));
                              if (!q.multiSelect) setAnswers((old) => ({ ...old, [q.id]: [] }));
                            }}
                          />
                        )}
                      </fieldset>
                    ))}
                    <Button
                      disabled={blocked || !interactionCurrent || !validAnswers}
                      onClick={() => {
                        if (
                          liveRef.current &&
                          [...(liveRef.current.questions ?? [])].some(
                            (item) => JSON.stringify(item) === JSON.stringify(interaction),
                          )
                        )
                          void mutate("answer", {
                            turnId: interaction.turnId,
                            questionId: interaction.requestId,
                            answers: questionAnswers,
                          });
                      }}
                    >
                      {text("提交回答", "Submit answers", "提交回答", "回答を送信")}
                    </Button>
                  </>
                ) : (
                  <>
                    <pre className="overflow-auto text-xs">
                      {JSON.stringify(interaction.input ?? interaction.toolCall ?? {}, null, 2)}
                    </pre>
                    {["allow", "deny"]
                      .filter(
                        (decision) =>
                          interaction.supported &&
                          interaction.availableDecisions.includes(decision),
                      )
                      .map((decision) => (
                        <Button
                          key={decision}
                          disabled={blocked || !interactionCurrent}
                          onClick={() => {
                            if (
                              liveRef.current?.approvals.some(
                                (item) => JSON.stringify(item) === JSON.stringify(interaction),
                              )
                            )
                              void mutate("approve", {
                                turnId: interaction.turnId,
                                approvalId: interaction.requestId,
                                decision,
                              });
                          }}
                        >
                          {decision === "allow"
                            ? text("允许", "Allow", "允許", "許可")
                            : text("拒绝", "Deny", "拒絕", "拒否")}
                        </Button>
                      ))}
                  </>
                )}
              </section>
            )}
            <label>
              {text("消息", "Message", "訊息", "メッセージ")}
              <Textarea
                value={draft}
                maxLength={16384}
                disabled={blocked}
                onChange={(event) => setDraft(event.target.value)}
              />
            </label>
            <label>
              {text(
                "添加图片或文件",
                "Add images or files",
                "新增圖片或檔案",
                "画像やファイルを追加",
              )}
              <Input
                type="file"
                multiple
                disabled={blocked || !capabilities?.features.attachments?.available}
                onChange={(event) => {
                  void upload(Array.from(event.target.files ?? []));
                  event.target.value = "";
                }}
              />
            </label>
            {attachments.map((item) => (
              <div key={item.id} className="flex gap-2">
                {item.name}
                <Button
                  variant="ghost"
                  disabled={blocked}
                  onClick={async () => {
                    const generation = epoch.current;
                    try {
                      await request("remove-attachment", {
                        sessionId,
                        attachmentId: item.id,
                        version: item.version,
                      });
                      if (generation === epoch.current)
                        setAttachments((old) => old.filter((value) => value.id !== item.id));
                    } catch (e) {
                      if (generation === epoch.current)
                        setError(e instanceof Error ? e.message : "remove_failed");
                    }
                  }}
                >
                  {text("移除", "Remove", "移除", "削除")}
                </Button>
              </div>
            ))}
            {compacting && (
              <p role="status" className="text-xs text-muted-foreground">
                {contextUsageCopy[locale].compactingDetail}
              </p>
            )}
            <div className="flex gap-2">
              <ContextUsageIndicator
                scope={`${sessionId}\0${workspaceId}\0${usageEpoch}`}
                locale={locale}
                online={online}
                view={usageView}
              />
              <Button
                disabled={
                  blocked ||
                  compacting ||
                  !live?.sendEnabled ||
                  live.status !== "idle" ||
                  (!draft.trim() && !attachments.length)
                }
                onClick={() =>
                  void mutate("send", {
                    text: draft.trim(),
                    attachmentIds: attachments.map((item) => item.id),
                  })
                }
              >
                {text("发送", "Send", "傳送", "送信")}
              </Button>
              <Button
                variant="destructive"
                disabled={blocked || !live?.stopEnabled || !live.turnId}
                onClick={() => void mutate("stop", { turnId: live?.turnId })}
              >
                {text("停止", "Stop", "停止", "停止")}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
