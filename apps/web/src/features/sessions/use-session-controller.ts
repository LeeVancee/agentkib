import {
  forgetPending,
  pendingScope,
  readPending,
  rememberPending,
  type PendingControl,
} from "./pending-controls";
import { useSessionLive } from "./use-session-live";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  ApiError,
  isLegacyPreparedReceipt,
  WebClient,
  type Access,
  type WebConnection,
  type CodexCapabilities,
  type CodexAction,
  type CodexActionBody,
  type Approval,
  type ConversationEvent,
  type ConversationEventPage,
  type ConversationSessionSummary,
  type Decision,
  type Live,
  type UserQuestionRequest,
} from "@agentkib/web-client";
import { displaySessionTitle } from "@agentkib/session-catalog";
import { answerRequestBody, interactionCopy } from "@/features/interactions/question-form";
import type { CatalogWorkspace } from "@/features/catalog/session-catalog";
import { catalogCopy } from "@/features/catalog/catalog-copy";
import { dictionaries, type Locale } from "@/i18n";
import { unavailableReasonText } from "@/live-status";
import { isValidMessage, mergeLatestPage } from "./session-model";
import { useAppearance } from "@/features/preferences/use-appearance";
export function useSessionController({
  origin: legacyOrigin = "",
  connection,
  disconnect,
  initialLocale = "zh-CN",
  initialTheme = "system",
}: {
  origin?: string;
  connection?: WebConnection;
  disconnect?: () => void;
  initialLocale?: Locale;
  initialTheme?: string;
}) {
  const [capabilities, setCapabilities] = useState<CodexCapabilities>();
  const [capabilitiesEpoch, setCapabilitiesEpoch] = useState(0);
  const [client] = useState(() => new WebClient(undefined, connection ?? legacyOrigin));
  const origin = client.origin;
  const isLan = client.connection.type === "lan-http";
  const [locale, setLocale] = useState<Locale>(initialLocale),
    [theme, setTheme] = useState(initialTheme),
    [accent, setAccent] = useState("blue");
  const t = dictionaries[locale];
  const c = catalogCopy[locale];
  const [access, setAccess] = useState<Access>(),
    [sessions, setSessions] = useState<ConversationSessionSummary[]>([]),
    [workspaces, setWorkspaces] = useState<CatalogWorkspace[]>(),
    [selected, setSelected] = useState(""),
    [page, setPage] = useState<ConversationEventPage>(),
    [live, setLive] = useState<Live>(),
    [online, setOnline] = useState(false),
    [controlReady, setControlReady] = useState(false),
    [indexEnabled, setIndexEnabled] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(false),
    [incompatible, setIncompatible] = useState(false),
    [notice, setNotice] = useState<"accepted" | "uncertain" | "notDispatched">(),
    [code, setCode] = useState(""),
    [name, setName] = useState(""),
    [message, setMessage] = useState(""),
    [modal, setModal] = useState<
      "preferences" | "metadata" | ConversationEvent | Approval | UserQuestionRequest
    >();
  const shownInteractions = useRef(new Set<string>());
  const receipt = useRef<
    { sessionId: string; requestId: string; turnId?: string; observedActive: boolean } | undefined
  >(undefined);
  const [pendingSessions, setPendingSessions] = useState<Record<string, boolean>>({});
  const watchedSessions = useRef(new Set<string>());
  const watchEpoch = useRef(0);
  const generation = useRef(0),
    selection = useRef(""),
    accessRef = useRef<Access | undefined>(undefined),
    scroll = useRef<HTMLElement>(null),
    mutating = useRef(false);
  const durableScope = useRef<string | undefined>(undefined);
  const durablePending = useRef<PendingControl[]>([]);
  const hasDurablePending = useCallback(
    (id: string) => durablePending.current.some((pending) => pending.sessionId === id),
    [],
  );
  const refreshRequired = useRef(false);
  const manualRefreshRequired = useRef(false);
  const readinessEpoch = useRef(0);
  const uncertainOutcome = useRef(false);
  const accessEpoch = useRef(0);
  useAppearance(locale, theme, accent);
  const clear = useCallback(() => {
    generation.current++;
    readinessEpoch.current++;
    selection.current = "";
    setSelected("");
    setSessions([]);
    setWorkspaces(undefined);
    setPage(undefined);
    setLive(undefined);
    setCapabilities(undefined);
    setModal(undefined);
    setMessage("");
    setNotice(undefined);
    shownInteractions.current.clear();
    receipt.current = undefined;
    setPendingSessions({});
    watchedSessions.current.clear();
    watchEpoch.current++;
    setCode("");
    setName("");
    setOnline(false);
    setControlReady(false);
    refreshRequired.current = false;
    manualRefreshRequired.current = false;
    uncertainOutcome.current = false;
    durableScope.current = undefined;
    durablePending.current = [];
  }, []);
  const fail = useCallback(
    (e: unknown, g = generation.current) => {
      if (g !== generation.current) return;
      readinessEpoch.current++;
      if (e instanceof ApiError && e.code === "access_ended") {
        if (isLan) client.reset();
        clear();
        const ended: Access = {
          status: "ended",
          csrfToken: "",
          bootId: "",
          experimentalEnabled: false,
        };
        accessRef.current = ended;
        setAccess(ended);
      } else if (e instanceof ApiError && e.code === "operation_busy") {
        // Reservation contention says nothing about connectivity. Keep readable
        // history, but require fresh access and live state before another control.
        refreshRequired.current = true;
        setControlReady(false);
      } else if (!(e instanceof DOMException && e.name === "AbortError")) {
        if (e instanceof ApiError && e.code === "incompatible_protocol") setIncompatible(true);
        setControlReady(false);
        setError(true);
        setOnline(false);
      }
    },
    [clear, client, isLan],
  );
  const syncAccess = useCallback(async () => {
    const g = generation.current;
    const epoch = ++accessEpoch.current;
    const next = await client.access();
    if (g !== generation.current || epoch !== accessEpoch.current) return;
    const old = accessRef.current;
    if (
      old?.status === "approved" &&
      (next.status !== "approved" ||
        old.bootId !== next.bootId ||
        old.device?.id !== next.device?.id)
    )
      clear();
    if (next.status === "approved" && next.device?.id) {
      const scope = pendingScope(origin, next.device.id);
      if (durableScope.current !== scope) {
        const pending = readPending(scope);
        durableScope.current = scope;
        durablePending.current = pending;
      }
    }
    accessRef.current = next;
    if (isLan && next.status === "ended") client.reset();
    setAccess(next);
    return next;
  }, [clear, client, origin, isLan]);
  const reconcilePending = useCallback(
    async (sessionId?: string) => {
      const scope = durableScope.current;
      if (!scope) return;
      // Read again so other components sharing this tab's scope see the same fence.
      durablePending.current = readPending(scope);
      const pending = durablePending.current.filter(
        (entry) =>
          !["create", "adopt", "release", "reconcile"].includes(entry.kind) &&
          (!sessionId || entry.sessionId === sessionId),
      );
      for (const entry of pending) {
        const result = await client.receipt(entry.requestId);
        if (scope !== durableScope.current) return;
        if (
          !result.found ||
          result.requestId !== entry.requestId ||
          (!isLegacyPreparedReceipt(result, entry.requestId) &&
            (result.recovery !== undefined ||
              (entry.sessionId && result.sessionId !== entry.sessionId) ||
              result.operation !== entry.kind ||
              result.status === "unknown"))
        )
          continue;
        if (result.status !== "accepted" && result.status !== "not-dispatched") continue;
        forgetPending(scope, entry.requestId);
        durablePending.current = readPending(scope);
        if (entry.sessionId === selection.current) {
          uncertainOutcome.current = false;
          setNotice(result.status === "accepted" ? "accepted" : "notDispatched");
          // A receipt confirms admission, never resolves or removes native approvals.
          if (result.status === "accepted")
            receipt.current = {
              sessionId: result.sessionId,
              requestId: entry.requestId,
              turnId: result.turnId ?? undefined,
              observedActive: entry.kind !== "send",
            };
        }
      }
      if (hasDurablePending(selection.current)) setNotice("uncertain");
    },
    [client, hasDurablePending],
  );
  const refresh = useCallback(
    async (manual = false) => {
      if (manual) setCapabilitiesEpoch((value) => value + 1);
      let g = generation.current;
      const epoch = ++readinessEpoch.current;
      // A newer access request can supersede this one. Keep the full refresh
      // pending so polling can finish it, including an explicit manual retry.
      refreshRequired.current = true;
      if (manual) manualRefreshRequired.current = true;
      setError(false);
      setControlReady(false);
      try {
        const next = await syncAccess();
        if (next?.status !== "approved") return;
        g = generation.current;
        await reconcilePending(selection.current || undefined);
        if (g !== generation.current) return;
        const catalog = await client.catalog();
        if (g !== generation.current) return;
        if (!catalog.indexEnabled) {
          clear();
          setIndexEnabled(false);
          return;
        }
        setIndexEnabled(true);
        setSessions(catalog.sessions);
        setWorkspaces(catalog.workspaces);
        const id = selection.current;
        if (id) {
          const viewport = scroll.current;
          const anchor =
            viewport &&
            Array.from(viewport.querySelectorAll<HTMLElement>("[data-event-id]")).find(
              (node) => node.getBoundingClientRect().bottom >= viewport.getBoundingClientRect().top,
            );
          const anchorId = anchor?.dataset.eventId;
          const anchorTop = anchor?.getBoundingClientRect().top;
          const [history, state] = await Promise.all([client.events(id), client.live(id)]);
          if (g !== generation.current || selection.current !== id) return;
          setPage((previous) => (isLan ? mergeLatestPage(previous, history) : history));
          if (isLan && viewport && anchorId && anchorTop !== undefined)
            requestAnimationFrame(() => {
              if (g !== generation.current || selection.current !== id) return;
              const node = Array.from(
                viewport.querySelectorAll<HTMLElement>("[data-event-id]"),
              ).find((node) => node.dataset.eventId === anchorId);
              if (node) viewport.scrollTop += node.getBoundingClientRect().top - anchorTop;
            });
          setLive(state);
        }
        setOnline(true);
        if (epoch === readinessEpoch.current) {
          if (manualRefreshRequired.current && !hasDurablePending(selection.current))
            uncertainOutcome.current = false;
          setControlReady(!uncertainOutcome.current && !hasDurablePending(selection.current));
          refreshRequired.current = false;
          manualRefreshRequired.current = false;
        }
      } catch (e) {
        fail(e, g);
      }
    },
    [syncAccess, fail, clear, client, isLan, reconcilePending, hasDurablePending],
  );
  useEffect(() => {
    void refresh();
    let polling = false;
    const timer = setInterval(() => void refreshAccessOnly(), 4000);
    async function refreshAccessOnly() {
      if (isLan && accessRef.current?.status === "ended") return;
      if (polling) return;
      polling = true;
      let g = generation.current;
      try {
        const before = accessRef.current?.status;
        const next = await syncAccess();
        g = generation.current;
        if (
          next?.status === "approved" &&
          (refreshRequired.current || hasDurablePending(selection.current))
        ) {
          await refresh();
          return;
        }
        if (next?.status === "approved" && before !== "approved") void refresh();
        else if (next?.status === "approved") {
          const g = generation.current;
          const catalog = await client.catalog();
          if (g !== generation.current) return;
          if (!catalog.indexEnabled) {
            clear();
            setIndexEnabled(false);
          } else {
            setIndexEnabled(true);
            setSessions(catalog.sessions);
            setWorkspaces(catalog.workspaces);
          }
        }
      } catch (e) {
        fail(e, g);
      } finally {
        polling = false;
      }
    }
    return () => {
      clearInterval(timer);
      generation.current++;
    };
  }, [refresh, syncAccess, fail, clear, client, origin, isLan, hasDurablePending]);
  useSessionLive({
    sessions,
    setPendingSessions,
    watchedSessions,
    watchEpoch,
    access,
    selected,
    selection,
    generation,
    client,
    fail,
    clear,
    accessRef,
    syncAccess,
    setLive,
    setOnline,
    setError,
    refresh,
    hasDurablePending,
    readinessEpoch,
    refreshRequired,
    setControlReady,
    setAccess,
    online,
    live,
    setPage,
  });
  const choose = useCallback(
    async (id: string) => {
      if (selection.current === id) return;
      if (sessions.find((session) => session.id === id)?.availability !== "readable") return;
      watchedSessions.current.add(id);
      generation.current++;
      selection.current = id;
      setSelected(id);
      setPage(undefined);
      setLive(undefined);
      setModal(undefined);
      setMessage("");
      setNotice(undefined);
      setOnline(false);
      setControlReady(false);
      setError(false);
      const g = generation.current;
      try {
        await reconcilePending(id);
        if (g !== generation.current) return;
        const [history, state] = await Promise.all([client.events(id), client.live(id)]);
        if (g !== generation.current) return;
        setPage(history);
        setLive(state);
        setOnline(true);
        setControlReady(
          !refreshRequired.current && !uncertainOutcome.current && !hasDurablePending(id),
        );
        scroll.current?.scrollTo?.({ top: 0 });
      } catch (e) {
        fail(e, g);
      }
    },
    [sessions, client, fail, reconcilePending, hasDurablePending],
  );
  async function post(path: string, body: unknown) {
    if (mutating.current) return;
    mutating.current = true;
    setBusy(true);
    setError(false);
    const g = generation.current;
    try {
      await client.request(path, body);
      if (g !== generation.current) return;
      await refresh();
    } catch (e) {
      fail(e, g);
    } finally {
      mutating.current = false;
      setBusy(false);
    }
  }
  async function pair(e: FormEvent) {
    e.preventDefault();
    await post("pair", { code, name: name.trim() || "Web" });
    setCode("");
  }
  async function earlier() {
    if (!page?.next_cursor || busy) return;
    setBusy(true);
    const id = selected,
      g = generation.current;
    const viewport = scroll.current;
    const anchor = viewport?.querySelector<HTMLElement>("[data-event-id]");
    const top = anchor?.getBoundingClientRect().top;
    const anchorId = anchor?.dataset.eventId;
    try {
      const older = await client.events(id, page.next_cursor);
      if (g !== generation.current || selection.current !== id) return;
      setPage((current) =>
        current
          ? {
              events: [...older.events, ...current.events].filter(
                (e, i, a) => a.findIndex((x) => x.id === e.id) === i,
              ),
              next_cursor: older.next_cursor,
              warnings: [...new Set([...older.warnings, ...current.warnings])],
            }
          : older,
      );
      requestAnimationFrame(() => {
        if (anchorId && top !== undefined && viewport) {
          const node = Array.from(viewport.querySelectorAll<HTMLElement>("[data-event-id]")).find(
            (n) => n.dataset.eventId === anchorId,
          );
          if (node) viewport.scrollTop += node.getBoundingClientRect().top - top;
        }
      });
    } catch (e) {
      fail(e, g);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!live || live.sessionId !== selected) return;
    setPendingSessions((previous) => ({
      ...previous,
      [selected]: live.approvals.length > 0 || !!live.questions?.length,
    }));
    const pendingReceipt = receipt.current;
    if (notice !== "accepted" || !pendingReceipt || pendingReceipt.sessionId !== selected) return;
    if (
      [
        "running",
        "awaiting-approval",
        "waiting-approval",
        "awaiting-input",
        "waiting-input",
      ].includes(live.status) &&
      live.turnId
    ) {
      if (!pendingReceipt.turnId || pendingReceipt.turnId === live.turnId) {
        pendingReceipt.turnId = live.turnId;
        pendingReceipt.observedActive = true;
      }
    } else if (
      live.status === "idle" &&
      pendingReceipt.observedActive &&
      (!live.turnId || live.turnId === pendingReceipt.turnId)
    ) {
      receipt.current = undefined;
      setNotice(undefined);
    }
  }, [live, selected, notice]);
  useEffect(() => {
    if (!online || !controlReady || !live || modal) return;
    const pending = [...live.approvals, ...(live.questions ?? [])].find((request) => {
      const key = `${selected}:${request.turnId}:${request.requestId}:${"questions" in request ? "question" : "approval"}`;
      const permitted =
        access?.experimentalEnabled &&
        ("questions" in request ? access.device?.send : access.device?.approve);
      return request.supported && permitted && !shownInteractions.current.has(key);
    });
    if (pending) {
      shownInteractions.current.add(
        `${selected}:${pending.turnId}:${pending.requestId}:${"questions" in pending ? "question" : "approval"}`,
      );
      setModal(pending);
    }
  }, [live, selected, online, controlReady, modal, access]);
  const selectedAgent = sessions.find((item) => item.id === selected)?.agent;
  const hasSupportedApproval = live?.approvals.some((item) => item.supported) ?? false;
  const hasSupportedQuestion = live?.questions?.some((item) => item.supported) ?? false;
  useEffect(() => {
    setCapabilities(undefined);
    if (!selected || access?.status !== "approved" || selectedAgent !== "codex") return;
    const abort = new AbortController();
    void client
      .codexCapabilities(selected, abort.signal)
      .then((result) => {
        if (!abort.signal.aborted && result.sessionId === selected && result.features)
          setCapabilities(result);
      })
      .catch(() => {
        /* Older hosts keep their basic text controls; advanced actions fail closed. */
      });
    return () => abort.abort();
  }, [
    client,
    selected,
    selectedAgent,
    capabilitiesEpoch,
    access?.bootId,
    access?.status,
    access?.experimentalEnabled,
    access?.device?.id,
    access?.device?.send,
    access?.device?.approve,
    access?.device?.manage,
    access?.device?.attachments,
    access?.device?.advancedControl,
    access?.device?.organize,
    access?.device?.settings,
    access?.device?.extendedApproval,
    live?.status,
    live?.reason,
    live?.executionMode,
    live?.sendEnabled,
    live?.stopEnabled,
    hasSupportedApproval,
    hasSupportedQuestion,
  ]);
  async function codexAction(
    action: CodexAction,
    fields: Omit<
      Partial<CodexActionBody>,
      "requestId" | "bootId" | "sessionId" | "expectedRevision"
    > = {},
  ) {
    if (
      mutating.current ||
      !access ||
      !live ||
      (action !== "inspect" && action !== "resume" && (!online || !controlReady)) ||
      capabilities?.sessionId !== selected ||
      !capabilities?.features[action]?.available ||
      (action !== "inspect" && (uncertainOutcome.current || hasDurablePending(selected)))
    )
      return;
    const scope = durableScope.current;
    if (!scope) return;
    mutating.current = true;
    setBusy(true);
    setNotice(undefined);
    const requestId = crypto.randomUUID();
    const id = selected;
    const g = generation.current;
    if (action === "inspect") {
      try {
        const result = await client.codexAction(action, {
          sessionId: id,
          bootId: access.bootId,
          expectedRevision: live.revision ?? 0,
          requestId,
        });
        if (generation.current !== g) return;
        await refresh(true);
        return result;
      } catch {
        if (generation.current === g) setError(true);
        return;
      } finally {
        mutating.current = false;
        setBusy(false);
      }
    }
    try {
      try {
        rememberPending(scope, { requestId, sessionId: id, kind: action });
        durablePending.current = readPending(scope);
      } catch {
        throw new ApiError(409, "pending_storage_unavailable", "not-dispatched");
      }
      const result = await client.codexAction(action, {
        ...fields,
        sessionId: id,
        bootId: access.bootId,
        expectedRevision: live.revision ?? 0,
        requestId,
      });
      forgetPending(scope, requestId);
      if (durableScope.current === scope) durablePending.current = readPending(scope);
      if (generation.current !== g) return;
      setNotice("accepted");
      await refresh(true);
      return result;
    } catch (error) {
      if (error instanceof ApiError && error.controlOutcome === "not-dispatched") {
        forgetPending(scope, requestId);
        if (durableScope.current === scope) durablePending.current = readPending(scope);
      }
      if (generation.current === g) {
        setNotice(
          error instanceof ApiError && error.controlOutcome === "not-dispatched"
            ? "notDispatched"
            : "uncertain",
        );
        setControlReady(false);
        refreshRequired.current = true;
        if (!(error instanceof ApiError) || error.controlOutcome !== "not-dispatched")
          uncertainOutcome.current = true;
        await refresh(true);
      }
      return undefined;
    } finally {
      mutating.current = false;
      setBusy(false);
    }
  }
  async function control(
    kind: "send" | "stop" | "approve" | "answer",
    approval?: Approval,
    decision?: Decision,
    question?: UserQuestionRequest,
    answers?: Record<string, string[]>,
    extra?: { attachmentIds?: string[]; resourceIds?: string[]; nativeDecision?: unknown },
  ) {
    if (
      mutating.current ||
      !access ||
      !live ||
      !online ||
      !controlReady ||
      hasDurablePending(selected)
    )
      return;
    const text = message.trim();
    if (kind === "send" && !isValidMessage(message, !!extra?.attachmentIds?.length)) return;
    if (
      extra?.attachmentIds?.length &&
      (!access.device?.attachments || !capabilities?.features.attachments?.available)
    )
      return;
    if (
      extra?.resourceIds?.length &&
      (access.device?.accessMode !== "full" ||
        !(capabilities?.features as Record<string, { available?: boolean } | undefined> | undefined)
          ?.context?.available)
    )
      return;
    if (
      extra?.nativeDecision !== undefined &&
      (!access.device?.extendedApproval ||
        !approval?.decisionOptions?.some(
          (option) => JSON.stringify(option.decision) === JSON.stringify(extra.nativeDecision),
        ))
    )
      return;
    if (
      kind === "stop" &&
      (!access.experimentalEnabled ||
        !access.device?.send ||
        live.stopEnabled !== true ||
        !live.turnId)
    )
      return;
    if (
      kind === "answer" &&
      (!question ||
        !access.experimentalEnabled ||
        !access.device?.send ||
        !question.supported ||
        !live.questions?.some((current) => JSON.stringify(current) === JSON.stringify(question)))
    )
      return;
    // A stable request ID does not mean the command/scope shown in an open
    // dialog is still current. Require the exact reviewed projection.
    if (
      kind === "approve" &&
      (!approval ||
        !live.approvals.some((current) => JSON.stringify(current) === JSON.stringify(approval)))
    )
      return;
    mutating.current = true;
    setBusy(true);
    setNotice(undefined);
    readinessEpoch.current++;
    manualRefreshRequired.current = false;
    const g = generation.current,
      id = selected;
    const requestId = crypto.randomUUID();
    const isCodex =
      sessions.find((session) => session.id === id)?.agent === "codex" ||
      live.executionMode?.startsWith("codex-");
    const scope = isCodex ? durableScope.current : undefined;
    try {
      if (isCodex) {
        try {
          if (!scope) throw new Error("missing_device_scope");
          rememberPending(scope, { requestId, sessionId: id, kind });
          durablePending.current = readPending(scope);
        } catch {
          throw new ApiError(409, "pending_storage_unavailable", "not-dispatched");
        }
      }
      await client.request(kind, {
        sessionId: id,
        requestId,
        bootId: access.bootId,
        expectedRevision: live.revision,
        ...(kind === "send"
          ? {
              text,
              ...(extra?.attachmentIds?.length ? { attachmentIds: extra.attachmentIds } : {}),
              ...(extra?.resourceIds?.length ? { resourceIds: extra.resourceIds } : {}),
            }
          : kind === "stop"
            ? { turnId: live.turnId }
            : kind === "approve"
              ? {
                  turnId: approval!.turnId,
                  approvalId: approval!.requestId,
                  ...(extra?.nativeDecision !== undefined
                    ? { nativeDecision: extra.nativeDecision }
                    : { decision }),
                }
              : answerRequestBody(
                  question!,
                  answers!,
                  { sessionId: id, bootId: access.bootId, expectedRevision: live.revision },
                  requestId,
                )),
      });
      if (scope) {
        forgetPending(scope, requestId);
        if (durableScope.current === scope) durablePending.current = readPending(scope);
      }
      if (g !== generation.current) return;
      receipt.current = {
        sessionId: id,
        requestId,
        turnId:
          kind === "send"
            ? undefined
            : kind === "stop"
              ? live.turnId
              : kind === "answer"
                ? question!.turnId
                : approval!.turnId,
        // A current native interaction already establishes an active turn,
        // even if the owner uses an unfamiliar waiting-status label.
        observedActive: kind !== "send",
      };
      setNotice("accepted");
      if (kind === "send") setMessage("");
      setModal(undefined);
      await refresh();
      return true;
    } catch (e) {
      if (scope && e instanceof ApiError && e.controlOutcome === "not-dispatched") {
        try {
          forgetPending(scope, requestId);
          if (durableScope.current === scope) durablePending.current = readPending(scope);
        } catch {
          /* Keep the durable fence if browser storage could not be updated. */
        }
      }
      if (g === generation.current) {
        if (e instanceof ApiError && e.code === "access_ended") {
          fail(e, g);
        } else {
          setControlReady(false);
          refreshRequired.current = true;
          if (e instanceof ApiError && e.controlOutcome === "not-dispatched") {
            setNotice("notDispatched");
            await refresh();
          } else {
            // A refresh clicked while this request was pending cannot acknowledge
            // an uncertain outcome that has only just arrived.
            manualRefreshRequired.current = false;
            uncertainOutcome.current = true;
            setNotice("uncertain");
            setOnline(false);
            fail(e, g);
          }
        }
      }
    } finally {
      mutating.current = false;
      setBusy(false);
    }
  }
  const current = sessions.find((s) => s.id === selected);
  const currentWorkspace = workspaces?.find((w) => w.id === current?.workspace_id);
  const currentTitle = displaySessionTitle(current?.title, t.untitled);
  const formatCatalogTime = (value?: string | null) =>
    value && Number.isFinite(Date.parse(value))
      ? new Date(value).toLocaleString(locale)
      : c.unknown;
  const sourceTitle = (id: string) => {
    const source = sessions.find((s) => s.id === id);
    return source ? displaySessionTitle(source.title, t.untitled) : id;
  };
  const canSend =
    controlReady &&
    online &&
    !busy &&
    !!access?.experimentalEnabled &&
    !!access.device?.send &&
    !!live?.sendEnabled &&
    live.status === "idle";
  const canStop =
    controlReady &&
    online &&
    !busy &&
    !!access?.experimentalEnabled &&
    !!access.device?.send &&
    live?.stopEnabled === true &&
    !!live.turnId;
  const liveText =
    live?.reason === "control-outcome-unconfirmed"
      ? t.controlUnconfirmed
      : live?.status === "idle"
        ? t.idle
        : live?.questions?.length
          ? interactionCopy[locale].title
          : live?.status === "running"
            ? t.running
            : live?.status === "awaiting-approval" || live?.status === "waiting-approval"
              ? t.approval
              : live?.reason
                ? unavailableReasonText(live.reason, t)
                : t.unknown;
  const leaveSession = useCallback(() => {
    generation.current++;
    selection.current = "";
    setSelected("");
    setPage(undefined);
    setLive(undefined);
    setCapabilities(undefined);
    setModal(undefined);
  }, []);
  return {
    client,
    capabilities,
    codexAction,
    origin,
    connection: client.connection,
    disconnect,
    locale,
    setLocale,
    theme,
    setTheme,
    accent,
    setAccent,
    t,
    c,
    access,
    sessions,
    workspaces,
    selected,
    page,
    live,
    online,
    controlReady,
    indexEnabled,
    busy,
    error,
    incompatible,
    setIncompatible,
    notice,
    code,
    setCode,
    name,
    setName,
    message,
    setMessage,
    modal,
    setModal,
    pendingSessions,
    scroll,
    refresh,
    choose,
    post,
    pair,
    earlier,
    control,
    current,
    currentWorkspace,
    currentTitle,
    formatCatalogTime,
    sourceTitle,
    canSend,
    canStop,
    liveText,
    leaveSession,
  };
}
export type SessionController = ReturnType<typeof useSessionController>;
export type SessionOptions = Parameters<typeof useSessionController>[0];
