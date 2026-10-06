import {
  createConversationStore,
  mergeConversationItems,
  type SessionStreamEvent,
} from "@agentkib/conversation-state";
import {
  forgetPending,
  pendingScope,
  readPending,
  rememberPending,
  type PendingControl,
} from "./pending-controls";
import { blockedWhileCompacting } from "./session-activity";
import { contextUsageCopy } from "./context-usage-copy";
import { useSessionLive } from "./use-session-live";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type SetStateAction,
} from "react";
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
import { displaySessionTitle, isSessionVisible } from "@agentkib/session-catalog";
import { answerRequestBody, interactionCopy } from "../interactions/question-form";
import type { CatalogWorkspace } from "../catalog/session-catalog";
import { catalogCopy } from "../catalog/catalog-copy";
import { dictionaries, type Locale } from "../../i18n";
import { unavailableReasonText } from "../../live-status";
import {
  isValidMessage,
  mergeLatestPage,
  mergeOrderedPersistedHistory,
  removePersistedOverlays,
  mergeNativeCoverage,
  beginHistoryRead,
  failHistoryRead,
  completeHistoryRead,
  hasAppliedNewerHistory,
  type NativeCoverage,
} from "./session-model";
import {
  applyHistoryPagination,
  beginHistoryPagination,
  createHistoryPagination,
  historyPaginationCursor,
  recordLatestHistoryPage,
} from "./history-pagination";
import { useAppearance } from "../preferences/use-appearance";
import { publishSessionInvalidation, subscribeSessionInvalidation } from "./session-events";
export function useSessionController({
  origin: legacyOrigin = "",
  connection,
  disconnect,
  initialLocale = "zh-CN",
  initialTheme = "system",
  client: providedClient,
  embedded = false,
}: {
  origin?: string;
  connection?: WebConnection;
  disconnect?: () => void;
  initialLocale?: Locale;
  initialTheme?: string;
  client?: WebClient;
  embedded?: boolean;
}) {
  const [capabilities, setCapabilities] = useState<CodexCapabilities>();
  const [capabilitiesEpoch, setCapabilitiesEpoch] = useState(0);
  const [client] = useState(
    () => providedClient ?? new WebClient(undefined, connection ?? legacyOrigin),
  );
  const [streamEpoch, setStreamEpoch] = useState(0);
  const [usageEpoch, setUsageEpoch] = useState("");
  const [liveContentVersion, setLiveContentVersion] = useState(0);
  const [catalogObservationFailed, setCatalogObservationFailed] = useState(false);
  const retryCatalogObservation = useRef<(() => void) | undefined>(undefined);
  const liveDelivery = useRef(0);
  const streamReady = useRef(false);
  const controlReconciliationPending = useRef(false);
  const nativeCoverage = useRef<NativeCoverage>({
    items: [],
    authoritativeTurnIds: [],
    removedTurnIds: [],
  });
  const origin = client.origin;
  const isLan = client.connection.type === "lan-http";
  const [locale, setLocale] = useState<Locale>(initialLocale),
    [theme, setTheme] = useState(initialTheme),
    [accent, setAccent] = useState("blue");
  const t = dictionaries[locale];
  const c = catalogCopy[locale];
  const [access, setAccess] = useState<Access>(),
    [sessions, setSessions] = useState<ConversationSessionSummary[]>([]),
    [excludedSessionIds, setExcludedSessionIds] = useState<ReadonlySet<string>>(new Set()),
    [catalogNotice, setCatalogNotice] = useState(false),
    [workspaces, setWorkspaces] = useState<CatalogWorkspace[]>(),
    [selected, setSelected] = useState(""),
    [page, publishPage] = useState<ConversationEventPage>(),
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
  const pageValue = useRef<ConversationEventPage | undefined>(undefined);
  const setPage = useCallback((update: SetStateAction<ConversationEventPage | undefined>) => {
    // History and pagination are one accepted projection. Resolve updates once
    // against the latest page, before publishing React state; React may replay
    // state updaters, which must not consume pagination tickets or reset coverage.
    const next = typeof update === "function" ? update(pageValue.current) : update;
    pageValue.current = next;
    publishPage(next);
  }, []);
  const shownInteractions = useRef(new Set<string>());
  const catalogSessions = useRef<ConversationSessionSummary[]>([]);
  const excludedIds = useRef<ReadonlySet<string>>(new Set());
  // Manual refresh and catalog notifications share this order. An older
  // response cannot undo a newer directory classification or dispatch guard.
  const catalogReadOrder = useRef(0);
  const readableSessionIds = useRef(new Set<string>());
  useEffect(() => {
    const readable = sessions.filter((session) => session.availability === "readable");
    readableSessionIds.current = new Set(readable.map((session) => session.id));
    setPendingSessions((previous) => {
      // These are derived interaction badges, separate from durable unknown
      // command receipts. Missing summaries retain only still-readable entries.
      const next: Record<string, boolean> = {};
      for (const session of readable) {
        const pending = session.pendingInteraction ?? previous[session.id];
        if (typeof pending === "boolean") next[session.id] = pending;
      }
      return next;
    });
  }, [sessions]);
  const receipt = useRef<
    { sessionId: string; requestId: string; turnId?: string; observedActive: boolean } | undefined
  >(undefined);
  const [pendingSessions, setPendingSessions] = useState<Record<string, boolean>>({});
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
  const refreshWake = useRef(0);
  const readContention = useRef({ version: 0, wake: 0 });
  const refreshFlight = useRef<{ generation: number; readiness: number } | undefined>(undefined);
  const deferredRefresh = useRef<
    | {
        generation: number;
        readiness: number;
        sessionId: string;
        resume: () => void;
      }
    | undefined
  >(undefined);
  const resumeDeferredRefresh = useCallback(() => {
    const pending = deferredRefresh.current;
    if (!pending) return;
    deferredRefresh.current = undefined;
    if (
      pending.generation === generation.current &&
      pending.readiness === readinessEpoch.current &&
      pending.sessionId === selection.current &&
      accessRef.current?.status === "approved" &&
      accessRef.current.protocolVersion === 2
    )
      pending.resume();
  }, []);
  const wakeDeferredRefresh = useCallback(() => {
    refreshWake.current++;
    resumeDeferredRefresh();
  }, [resumeDeferredRefresh]);
  const uncertainOutcomes = useRef(new Set<string>());
  const accessEpoch = useRef(0);
  const accessFlight = useRef<Promise<Access | undefined> | undefined>(undefined);
  useAppearance(locale, theme, accent, !embedded);
  const clear = useCallback(() => {
    generation.current++;
    readinessEpoch.current++;
    selection.current = "";
    setSelected("");
    setSessions([]);
    catalogSessions.current = [];
    excludedIds.current = new Set();
    setExcludedSessionIds(excludedIds.current);
    setCatalogNotice(false);
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
    setCode("");
    setName("");
    setOnline(false);
    setControlReady(false);
    setCatalogObservationFailed(false);
    streamReady.current = false;
    nativeCoverage.current = { items: [], authoritativeTurnIds: [], removedTurnIds: [] };
    refreshRequired.current = false;
    manualRefreshRequired.current = false;
    deferredRefresh.current = undefined;
    uncertainOutcomes.current.clear();
    durableScope.current = undefined;
    durablePending.current = [];
  }, [setPage]);
  const leaveSession = useCallback(() => {
    generation.current++;
    readinessEpoch.current++;
    selection.current = "";
    deferredRefresh.current = undefined;
    streamReady.current = false;
    setSelected("");
    setPage(undefined);
    setLive(undefined);
    setCapabilities(undefined);
    setModal(undefined);
    setControlReady(false);
    setOnline(false);
  }, [setPage]);
  const acceptCatalog = useCallback(
    (records: ConversationSessionSummary[]) => {
      const excluded = new Set(
        records.filter((record) => !isSessionVisible(record)).map((s) => s.id),
      );
      const visible = records.filter(isSessionVisible);
      // Update the dispatch guard before publishing React state. A callback from
      // the previous render must not reopen a record the new catalog excludes.
      excludedIds.current = excluded;
      catalogSessions.current = visible;
      setExcludedSessionIds(excluded);
      setSessions(visible);
      if (excluded.has(selection.current)) {
        leaveSession();
        setCatalogNotice(true);
      }
    },
    [leaveSession],
  );
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
  const readHistory = useCallback(
    async (id: string, g: number, historyCacheEpoch: string | undefined, cursor?: string) => {
      if (excludedIds.current.has(id)) return undefined;
      const attempt = beginHistoryRead(nativeCoverage.current);
      try {
        return { type: "page" as const, page: await client.events(id, cursor), attempt };
      } catch (error) {
        if (
          g === generation.current &&
          selection.current === id &&
          historyCacheEpoch === nativeCoverage.current.historyCacheEpoch
        ) {
          // Handle history separately from the concurrent live read, including
          // a late history failure after Promise.all has already rejected.
          if (error instanceof DOMException && error.name === "AbortError") return undefined;
          // Return contention separately so a concurrent real live-read failure
          // is still observed before the caller schedules read recovery.
          if (error instanceof ApiError && error.code === "operation_busy")
            return { type: "busy" as const, error };
          if (failHistoryRead(nativeCoverage.current, attempt)) {
            setError(true);
            fail(error, g);
          } else if (hasAppliedNewerHistory(nativeCoverage.current, attempt)) {
            // A newer applied history read already satisfied this refresh. Keep
            // its completion distinct from an unresolved or out-of-scope failure.
            return { type: "superseded" as const, attempt };
          }
        }
        return undefined;
      }
    },
    [client, fail],
  );
  const syncAccess = useCallback(
    (stillCurrent?: () => boolean) => {
      const g = generation.current;
      const epoch = ++accessEpoch.current;
      const flight = (async () => {
        let next: Access;
        try {
          next = await client.access();
        } catch (error) {
          if (g !== generation.current) return;
          if (epoch !== accessEpoch.current) return accessFlight.current;
          if (stillCurrent && !stillCurrent()) return;
          throw error;
        }
        if (g !== generation.current) return;
        // A notification may require a newer access read while a full refresh is
        // pending. Its callers must finish using that accepted read, not abandon
        // the refresh and leave its control fence set indefinitely.
        if (epoch !== accessEpoch.current) return accessFlight.current;
        if (stillCurrent && !stillCurrent()) return;
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
      })();
      accessFlight.current = flight;
      return flight;
    },
    [clear, client, origin, isLan],
  );
  const reconcilePending = useCallback(
    async (sessionId?: string) => {
      const scope = durableScope.current;
      if (!scope) return;
      const epoch = readinessEpoch.current;
      // Read again so other components sharing this tab's scope see the same fence.
      durablePending.current = readPending(scope);
      const pending = durablePending.current.filter(
        (entry) =>
          !["create", "adopt", "release", "reconcile"].includes(entry.kind) &&
          (!sessionId || entry.sessionId === sessionId),
      );
      let resolvedSelected: string | undefined;
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
        uncertainOutcomes.current.delete(entry.sessionId ?? "");
        if (entry.sessionId === selection.current) {
          resolvedSelected = entry.sessionId;
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
      else if (
        resolvedSelected === selection.current &&
        epoch === readinessEpoch.current &&
        accessRef.current?.protocolVersion === 2
      ) {
        refreshRequired.current = uncertainOutcomes.current.has(selection.current);
        setControlReady(
          streamReady.current && !controlReconciliationPending.current && !refreshRequired.current,
        );
      }
    },
    [client, hasDurablePending],
  );
  const refresh = useCallback(
    async function refreshCurrent(manual = false, preserveHistory = false): Promise<void> {
      if (manual) {
        retryCatalogObservation.current?.();
        setCapabilitiesEpoch((value) => value + 1);
      }
      let g = generation.current;
      const epoch = ++readinessEpoch.current;
      const wake = refreshWake.current;
      const contention = readContention.current.version;
      const flight = { generation: g, readiness: epoch };
      refreshFlight.current = flight;
      deferredRefresh.current = undefined;
      // Concurrent access notifications share their latest accepted read with
      // this refresh; the full refresh still owns clearing this control fence.
      refreshRequired.current = true;
      if (manual) manualRefreshRequired.current = true;
      setError(!!nativeCoverage.current.historyRecoveryFailed);
      setControlReady(false);
      let historyScope: { epoch?: string } | undefined;
      try {
        const next = await syncAccess();
        if (
          !next &&
          g === generation.current &&
          epoch === readinessEpoch.current &&
          accessRef.current?.status === "approved"
        ) {
          // A newer catalog access read may have been discarded with its stream.
          // This refresh still owns its fence: complete it with a fresh read.
          await refreshCurrent(manual, preserveHistory);
          return;
        }
        if (next?.status !== "approved") return;
        g = generation.current;
        flight.generation = g;
        await reconcilePending(selection.current || undefined);
        if (g !== generation.current) return;
        const catalogOrder = ++catalogReadOrder.current;
        const catalog = await client.catalog();
        if (g !== generation.current) return;
        if (contention !== readContention.current.version)
          throw new ApiError(409, "operation_busy");
        if (catalogOrder === catalogReadOrder.current) {
          if (!catalog.indexEnabled) {
            clear();
            setIndexEnabled(false);
            return;
          }
          setIndexEnabled(true);
          acceptCatalog(catalog.sessions);
          setWorkspaces(catalog.workspaces);
        }
        // The full refresh still owns calibrating selected history and control
        // readiness when a notification superseded only its catalog response.
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
          const delivered = liveDelivery.current;
          const historyCacheEpoch = nativeCoverage.current.historyCacheEpoch;
          historyScope = { epoch: historyCacheEpoch };
          const [historyRead, state] = await Promise.all([
            readHistory(id, g, historyCacheEpoch),
            client.live(id),
          ]);
          if (g !== generation.current || selection.current !== id) return;
          if (historyCacheEpoch !== nativeCoverage.current.historyCacheEpoch) {
            // A replaced cache requires a new calibration, never completion
            // using the old scope's live response or history. Only the refresh
            // still owning this fence may restart; newer controls remain fenced.
            if (epoch === readinessEpoch.current)
              await refreshCurrent(
                manual,
                preserveHistory || contention !== readContention.current.version,
              );
            return;
          }
          // A sibling read saw newer admission contention. Its busy response
          // cannot cancel recovery, but this older idle projection is not proof
          // that the command has settled either.
          if (contention !== readContention.current.version)
            throw new ApiError(409, "operation_busy");
          if (!historyRead) return;
          if (historyRead.type === "busy") throw historyRead.error;
          if (
            historyRead.type === "superseded" &&
            (epoch !== readinessEpoch.current ||
              !hasAppliedNewerHistory(nativeCoverage.current, historyRead.attempt))
          )
            return;
          if (historyRead.type === "page") {
            const { page: history, attempt } = historyRead;
            const coverage = nativeCoverage.current;
            completeHistoryRead(nativeCoverage.current, attempt);
            setError(!!nativeCoverage.current.historyRecoveryFailed);
            setPage((previous) => {
              // A newer latest read owns its whole projection, not only its
              // cursor. A newer earlier-page read does not supersede this latest.
              if ((coverage.historyPagination?.latestReadOrder ?? 0) > attempt.id) return previous;
              // Admission contention does not invalidate loaded history. A
              // bounded latest page can begin with a history-only tool result,
              // so a missing overlap cannot justify dropping earlier pages.
              const merged = preserveHistory
                ? {
                    ...history,
                    events: mergeOrderedPersistedHistory(
                      previous?.events ?? [],
                      history.events,
                      coverage.historyPagination?.persisted.size ? "latest" : "older",
                      nativeCoverage.current.preserveItemsOutsideCoverage,
                    ),
                    warnings: [...new Set([...(previous?.warnings ?? []), ...history.warnings])],
                  }
                : mergeLatestPage(previous, history);
              // A read started before a native update must not replace its newer
              // item content or drop a reply appended while that read was pending.
              const result =
                delivered !== liveDelivery.current && previous
                  ? {
                      ...merged,
                      events: mergeConversationItems(
                        merged.events,
                        removePersistedOverlays(
                          previous.events,
                          history.events,
                          nativeCoverage.current.preserveItemsOutsideCoverage,
                        ),
                      ),
                    }
                  : {
                      ...merged,
                      events: mergeConversationItems(
                        merged.events,
                        removePersistedOverlays(
                          previous?.events.filter((item) => item.ephemeral) ?? [],
                          history.events,
                          nativeCoverage.current.preserveItemsOutsideCoverage,
                        ),
                      ),
                    };
              const retainedIds = new Set(result.events.map((item) => item.id));
              // Keep the old continuation when its displayed raw rows survive.
              // A disjoint/empty refresh can still replace static history, but
              // it must discard coverage for rows it removed at the same time.
              if (
                previous?.events.some(
                  (item) =>
                    coverage.historyPagination?.persisted.has(item.id) && !retainedIds.has(item.id),
                )
              )
                coverage.historyPagination = createHistoryPagination();
              const pagination = (coverage.historyPagination ??= createHistoryPagination());
              const nextCursor = recordLatestHistoryPage(pagination, history, attempt.id);
              return {
                ...result,
                next_cursor: nextCursor,
                events: mergeNativeCoverage(result.events, nativeCoverage.current),
              };
            });
          }
          if (
            historyRead.type === "page" &&
            isLan &&
            viewport &&
            anchorId &&
            anchorTop !== undefined
          )
            requestAnimationFrame(() => {
              if (g !== generation.current || selection.current !== id) return;
              const node = Array.from(
                viewport.querySelectorAll<HTMLElement>("[data-event-id]"),
              ).find((node) => node.dataset.eventId === anchorId);
              if (node) viewport.scrollTop += node.getBoundingClientRect().top - anchorTop;
            });
          if (delivered === liveDelivery.current) setLive(state);
          if (manual && next.protocolVersion === 2) setStreamEpoch((value) => value + 1);
        }
        setOnline(true);
        if (epoch === readinessEpoch.current) {
          if (manualRefreshRequired.current && !hasDurablePending(selection.current))
            uncertainOutcomes.current.delete(selection.current);
          setControlReady(
            streamReady.current &&
              !controlReconciliationPending.current &&
              next.protocolVersion === 2 &&
              !uncertainOutcomes.current.has(selection.current) &&
              !hasDurablePending(selection.current),
          );
          refreshRequired.current = uncertainOutcomes.current.has(selection.current);
          manualRefreshRequired.current = false;
        }
      } catch (e) {
        if (!historyScope || historyScope.epoch === nativeCoverage.current.historyCacheEpoch) {
          if (e instanceof ApiError && e.code === "operation_busy") {
            if (g !== generation.current || epoch !== readinessEpoch.current) return;
            // Only retry this read, under the fence it originally acquired. A
            // newer selection, refresh or uncertain control cancels its recovery.
            deferredRefresh.current = {
              generation: g,
              readiness: epoch,
              sessionId: selection.current,
              resume: () => void refreshCurrent(manual, true),
            };
            // Settlement may already have arrived while the busy response was
            // in transit. Consume that wakeup once; a repeated busy waits again.
            if (
              wake !== refreshWake.current ||
              (contention !== readContention.current.version &&
                readContention.current.wake !== refreshWake.current)
            )
              resumeDeferredRefresh();
          } else fail(e, g);
        } else if (g === generation.current && epoch === readinessEpoch.current)
          await refreshCurrent(
            manual,
            preserveHistory ||
              contention !== readContention.current.version ||
              (e instanceof ApiError && e.code === "operation_busy"),
          );
      } finally {
        if (refreshFlight.current === flight) refreshFlight.current = undefined;
      }
    },
    [
      syncAccess,
      fail,
      clear,
      client,
      isLan,
      reconcilePending,
      hasDurablePending,
      readHistory,
      resumeDeferredRefresh,
      setPage,
      acceptCatalog,
    ],
  );
  const readBusy = useCallback(
    (wake: number, g = generation.current) => {
      if (g !== generation.current || accessRef.current?.status !== "approved") return;
      readContention.current = { version: readContention.current.version + 1, wake };
      refreshRequired.current = true;
      setControlReady(false);
      const pending = deferredRefresh.current;
      if (pending?.generation === g && pending.readiness === readinessEpoch.current) {
        if (wake !== refreshWake.current) resumeDeferredRefresh();
        return;
      }
      const flight = refreshFlight.current;
      if (flight?.generation === g && flight.readiness === readinessEpoch.current) return;
      // A late busy response may arrive after settlement and a newer complete
      // read. Recover with a fresh read; repeated contention waits for an event.
      void refresh(false, true);
    },
    [refresh, resumeDeferredRefresh],
  );
  useEffect(() => {
    void refresh();
    return () => {
      generation.current++;
      deferredRefresh.current = undefined;
    };
  }, [refresh]);
  useEffect(() => {
    if (access?.status !== "pending") return;
    // Pending pairing precedes authenticated subscriptions. This checks only
    // the grant transition; conversation state always arrives as native events.
    const timer = setInterval(
      () =>
        void syncAccess()
          .then((next) => {
            if (next?.status === "approved") void refresh();
          })
          .catch((error) => fail(error)),
      4000,
    );
    return () => clearInterval(timer);
  }, [access?.status, syncAccess, refresh, fail]);
  useEffect(() => {
    if (access?.status !== "approved" || access.protocolVersion !== 2) return;
    const store = createConversationStore<Live>("");
    let closed = false;
    let resetPending = false;
    let exhausted = false;
    let resets = 0;
    let connectionEpoch = 0;
    let closeStream: (() => void) | undefined;
    const current = () =>
      !closed &&
      accessRef.current?.status === "approved" &&
      accessRef.current.protocolVersion === 2 &&
      accessRef.current.bootId === access.bootId &&
      accessRef.current.device?.id === access.device?.id;
    const resync = () => {
      if (!current() || resetPending || exhausted) return;
      resetPending = true;
      // Invalidate callbacks and pending reads before the adapter can deliver
      // more bootstrap events or readiness for this rejected stream.
      connectionEpoch++;
      queueMicrotask(() => {
        if (!current()) return;
        closeStream?.();
        closeStream = undefined;
        if (++resets > 3) {
          exhausted = true;
          setCatalogObservationFailed(true);
          return;
        }
        store.reset();
        resetPending = false;
        connect();
      });
    };
    const connect = () => {
      const connection = ++connectionEpoch;
      const active = () =>
        current() && connection === connectionEpoch && !resetPending && !exhausted;
      // A replacement subscription owns its read queue, so a stalled old read
      // cannot delay the new baseline or overwrite its catalog when it resolves.
      let flight = false;
      let dirty = false;
      let retryAfterControl = false;
      const retryInvalidated = (g: number) => {
        if (
          !active() ||
          g === generation.current ||
          accessRef.current?.status !== "approved" ||
          accessRef.current.protocolVersion !== 2
        )
          return false;
        // Navigation invalidates reads, but does not consume a global catalog
        // notification. Re-read under the current generation and authorization.
        dirty = true;
        return true;
      };
      const update = async () => {
        if (!active()) return;
        if (flight) {
          dirty = true;
          return;
        }
        flight = true;
        do {
          dirty = false;
          let g = generation.current;
          try {
            const next = await syncAccess(active);
            if (!active()) break;
            if (!next) {
              if (retryInvalidated(g)) continue;
              break;
            }
            if (
              next.status !== "approved" ||
              accessRef.current?.status !== "approved" ||
              accessRef.current.protocolVersion !== 2
            )
              break;
            if (next !== accessRef.current) {
              dirty = true;
              continue;
            }
            // An accepted access response may clear the old runtime boot itself.
            // syncAccess rejects superseded reads; protect subsequent reads using
            // the generation belonging to this newly accepted access instead.
            g = generation.current;
            const catalogOrder = ++catalogReadOrder.current;
            const catalog = await client.catalog();
            if (!active()) break;
            if (g !== generation.current) {
              if (retryInvalidated(g)) continue;
              break;
            }
            if (catalogOrder !== catalogReadOrder.current) {
              dirty = true;
              continue;
            }
            if (!catalog.indexEnabled) {
              clear();
              setIndexEnabled(false);
              break;
            }
            setIndexEnabled(true);
            acceptCatalog(catalog.sessions);
            setWorkspaces(catalog.workspaces);
            await reconcilePending();
            retryAfterControl = false;
            if (active() && g === generation.current)
              // Management receipts have their own consumer, including creation
              // without a selected session. Reconnects must reconcile those too.
              publishSessionInvalidation(client, "", ["receipts"]);
          } catch (error) {
            if (active() && !retryInvalidated(g)) {
              // Read contention is not an uncertain command outcome. Wait for a
              // settlement/catalog event without fencing the selected conversation.
              if (error instanceof ApiError && error.code === "operation_busy")
                retryAfterControl = true;
              else fail(error, g);
            }
          }
        } while (dirty && active());
        flight = false;
      };
      closeStream = client.stream("", {
        open: () => {
          if (!active()) return;
          wakeDeferredRefresh();
          void update();
        },
        error: (error) => {
          if (!active()) return;
          if (error instanceof ApiError && error.code === "incompatible_protocol")
            setIncompatible(true);
          // Native EventSource does not expose HTTP 401/403. Recheck access on
          // failed reconnect so an expired grant clears the retained private view.
          else void update();
        },
        event: (type, data) => {
          if (!active()) return false;
          if (type === "access-ended") {
            fail(new ApiError(401, "access_ended"));
            return;
          }
          if (type === "control-changed") {
            try {
              const changed = JSON.parse(data) as { sessionId?: string };
              wakeDeferredRefresh();
              // Settlement can arrive before the busy response. Mark an in-flight
              // read dirty as well so that notification is not consumed too early.
              if (retryAfterControl || flight) void update();
              if (!selection.current || changed.sessionId !== selection.current)
                publishSessionInvalidation(client, "", ["receipts"]);
            } catch {
              setError(true);
            }
            return;
          }
          if (type === "session-ready") {
            try {
              const ready = JSON.parse(data) as { cursor?: string };
              const state = store.getSnapshot();
              if (state.cursor && state.cursor === ready.cursor && !state.resyncRequired) {
                // A baseline alone cannot reset the failure limit: replay may
                // still contain a gap before the adapter announces readiness.
                resets = 0;
                setCatalogObservationFailed(false);
              }
            } catch {
              // Malformed readiness never proves observation has recovered.
            }
            return false;
          }
          if (["catalog-invalidated", "access-changed"].includes(type)) {
            wakeDeferredRefresh();
            void update();
            return false;
          }
          if (type !== "session-event") return false;
          try {
            const event = JSON.parse(data) as SessionStreamEvent<Live>;
            if (event.sessionId !== "") return false;
            const previous = store.getSnapshot();
            const state = store.dispatch(event);
            if (state.resyncRequired) {
              resync();
              return false;
            }
            const advanced =
              state.cursor !== previous.cursor ||
              state.seq !== previous.seq ||
              state.epoch !== previous.epoch ||
              state.runtimeBootId !== previous.runtimeBootId;
            if (advanced) {
              wakeDeferredRefresh();
              if (
                event.type === "snapshot" ||
                (event.type === "invalidate" && event.payload.domains.includes("catalog"))
              )
                void update();
              if (event.type === "invalidate")
                publishSessionInvalidation(client, "", event.payload.domains);
            }
            // IPC ACKs are cumulative and may safely repeat the accepted cursor.
            // Rejected gaps and resync markers never acknowledge received data.
            return state.cursor ?? false;
          } catch {
            resync();
            return false;
          }
        },
      });
    };
    const retry = () => {
      if (!current() || !exhausted) return;
      exhausted = false;
      resetPending = false;
      resets = 0;
      store.reset();
      connect();
    };
    retryCatalogObservation.current = retry;
    connect();
    return () => {
      closed = true;
      if (retryCatalogObservation.current === retry) retryCatalogObservation.current = undefined;
      closeStream?.();
    };
  }, [
    access?.status,
    access?.protocolVersion,
    access?.bootId,
    access?.device?.id,
    client,
    syncAccess,
    reconcilePending,
    clear,
    fail,
    wakeDeferredRefresh,
    acceptCatalog,
  ]);
  useEffect(
    () =>
      subscribeSessionInvalidation(client, (id, domains) => {
        if (id && id !== selection.current) return;
        if (domains.some((domain) => ["capabilities", "settings", "ownership"].includes(domain)))
          setCapabilitiesEpoch((value) => value + 1);
        if (domains.includes("receipts"))
          void reconcilePending(id || undefined).catch((error) => fail(error));
      }),
    [client, reconcilePending, fail],
  );
  useSessionLive({
    setLiveContentVersion,
    setUsageEpoch,
    streamReady,
    controlReconciliationPending,
    nativeCoverage,
    streamEpoch,
    liveDelivery,
    access,
    selected,
    selection,
    generation,
    client,
    fail,
    readBusy,
    refreshWake,
    clear,
    accessRef,
    setLive,
    setOnline,
    setError,
    hasDurablePending,
    readinessEpoch,
    refreshRequired,
    setControlReady,
    setAccess,
    setPage,
  });
  const choose = useCallback(
    async (id: string) => {
      if (excludedIds.current.has(id)) {
        if (selection.current) leaveSession();
        setCatalogNotice(true);
        return;
      }
      if (selection.current === id) return;
      if (catalogSessions.current.find((session) => session.id === id)?.availability !== "readable")
        return;
      generation.current++;
      readinessEpoch.current++;
      // The new selection owns its baseline read. An obsolete refresh cannot
      // keep it fenced, while unknown outcomes remain attached to their session.
      refreshRequired.current = uncertainOutcomes.current.has(id);
      manualRefreshRequired.current = false;
      selection.current = id;
      setSelected(id);
      setPage(undefined);
      setLive(undefined);
      setModal(undefined);
      setMessage("");
      setNotice(undefined);
      setCatalogNotice(false);
      setOnline(false);
      setControlReady(false);
      streamReady.current = false;
      nativeCoverage.current = { items: [], authoritativeTurnIds: [], removedTurnIds: [] };
      setError(false);
      const g = generation.current;
      const wake = refreshWake.current;
      let historyScope: { epoch?: string } | undefined;
      try {
        await reconcilePending(id);
        if (g !== generation.current) return;
        const delivered = liveDelivery.current;
        const historyCacheEpoch = nativeCoverage.current.historyCacheEpoch;
        historyScope = { epoch: historyCacheEpoch };
        const [historyRead, state] = await Promise.all([
          readHistory(id, g, historyCacheEpoch),
          client.live(id),
        ]);
        if (historyRead?.type === "busy") {
          readBusy(wake, g);
          return;
        }
        if (!historyRead || historyRead.type !== "page" || g !== generation.current) return;
        const { page: history, attempt } = historyRead;
        if (historyCacheEpoch === nativeCoverage.current.historyCacheEpoch) {
          const pagination = (nativeCoverage.current.historyPagination ??=
            createHistoryPagination());
          const nextCursor = recordLatestHistoryPage(pagination, history, attempt.id);
          completeHistoryRead(nativeCoverage.current, attempt);
          setError(!!nativeCoverage.current.historyRecoveryFailed);
          setPage((previous) => ({
            ...history,
            next_cursor: nextCursor,
            events: mergeNativeCoverage(
              mergeConversationItems(
                mergeOrderedPersistedHistory(
                  previous?.events ?? [],
                  history.events,
                  "older",
                  nativeCoverage.current.preserveItemsOutsideCoverage,
                ),
                removePersistedOverlays(
                  previous?.events ?? [],
                  history.events,
                  nativeCoverage.current.preserveItemsOutsideCoverage,
                ),
              ),
              nativeCoverage.current,
            ),
          }));
        }
        if (delivered === liveDelivery.current) setLive(state);
        setOnline(true);
        setControlReady(
          streamReady.current &&
            !controlReconciliationPending.current &&
            accessRef.current?.protocolVersion === 2 &&
            !refreshRequired.current &&
            !uncertainOutcomes.current.has(id) &&
            !hasDurablePending(id),
        );
      } catch (e) {
        if (!historyScope || historyScope.epoch === nativeCoverage.current.historyCacheEpoch) {
          if (e instanceof ApiError && e.code === "operation_busy") readBusy(wake, g);
          else fail(e, g);
        }
      }
    },
    [
      client,
      fail,
      reconcilePending,
      hasDurablePending,
      readHistory,
      readBusy,
      setPage,
      leaveSession,
    ],
  );
  async function post(path: string, body: unknown) {
    if (mutating.current) return;
    mutating.current = true;
    setBusy(true);
    setError(!!nativeCoverage.current.historyRecoveryFailed);
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
    const pagination = nativeCoverage.current.historyPagination;
    const ticket = pagination && beginHistoryPagination(pagination, page.next_cursor);
    if (!ticket) return;
    setBusy(true);
    const id = selected,
      g = generation.current;
    const viewport = scroll.current;
    const anchor = viewport?.querySelector<HTMLElement>("[data-event-id]");
    const top = anchor?.getBoundingClientRect().top;
    const anchorId = anchor?.dataset.eventId;
    const historyCacheEpoch = nativeCoverage.current.historyCacheEpoch;
    const wake = refreshWake.current;
    try {
      const historyRead = await readHistory(id, g, historyCacheEpoch, page.next_cursor);
      if (historyRead?.type === "busy") {
        readBusy(wake, g);
        return;
      }
      if (
        !historyRead ||
        historyRead.type !== "page" ||
        g !== generation.current ||
        selection.current !== id ||
        historyCacheEpoch !== nativeCoverage.current.historyCacheEpoch
      )
        return;
      const { page: older, attempt } = historyRead;
      if (
        nativeCoverage.current.historyPagination !== pagination ||
        !applyHistoryPagination(pagination, ticket, older)
      )
        return;
      const nextCursor = historyPaginationCursor(pagination);
      const hadHistoryError = nativeCoverage.current.historyRecoveryFailed;
      completeHistoryRead(nativeCoverage.current, attempt);
      if (hadHistoryError) setError(!!nativeCoverage.current.historyRecoveryFailed);
      setPage((current) =>
        current
          ? {
              events: mergeNativeCoverage(
                mergeConversationItems(
                  mergeOrderedPersistedHistory(
                    current.events,
                    older.events,
                    "older",
                    nativeCoverage.current.preserveItemsOutsideCoverage,
                    ticket.beforeItemIds,
                    ticket.afterItemIds,
                  ),
                  removePersistedOverlays(
                    current.events,
                    older.events,
                    nativeCoverage.current.preserveItemsOutsideCoverage,
                  ),
                ),
                nativeCoverage.current,
              ),
              next_cursor: nextCursor,
              warnings: [...new Set([...older.warnings, ...current.warnings])],
            }
          : {
              ...older,
              next_cursor: nextCursor,
              events: mergeNativeCoverage(older.events, nativeCoverage.current),
            },
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
    // A retained stream may still deliver after its catalog entry disappears.
    // It cannot recreate a badge outside the current readable directory.
    if (readableSessionIds.current.has(selected))
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
    if (
      !selected ||
      access?.status !== "approved" ||
      (selectedAgent !== "codex" && selectedAgent !== "claude-code")
    )
      return;
    const abort = new AbortController();
    void client
      .sessionCapabilities(selected, selectedAgent, abort.signal)
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
      excludedIds.current.has(selected) ||
      selection.current !== selected ||
      !access ||
      !live ||
      (action !== "inspect" && action !== "resume" && (!online || !controlReady)) ||
      capabilities?.sessionId !== selected ||
      !capabilities?.features[action]?.available ||
      (live.activity === "compacting" && blockedWhileCompacting(action)) ||
      (action !== "inspect" &&
        (uncertainOutcomes.current.has(selected) || hasDurablePending(selected)))
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
          uncertainOutcomes.current.add(id);
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
      excludedIds.current.has(selected) ||
      selection.current !== selected ||
      hasDurablePending(selected)
    )
      return;
    const text = message.trim();
    if (
      kind === "send" &&
      (live.activity === "compacting" || !isValidMessage(message, !!extra?.attachmentIds?.length))
    )
      return;
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
    const needsDurableReceipt =
      ["codex", "claude-code"].includes(
        sessions.find((session) => session.id === id)?.agent ?? "",
      ) ||
      live.executionMode === "claude-managed" ||
      live.executionMode?.startsWith("codex-");
    const scope = needsDurableReceipt ? durableScope.current : undefined;
    try {
      if (needsDurableReceipt) {
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
            uncertainOutcomes.current.add(id);
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
    access?.protocolVersion === 2 &&
    !!access?.experimentalEnabled &&
    !!access.device?.send &&
    !!live?.sendEnabled &&
    live.status === "idle" &&
    live.activity !== "compacting";
  const canStop =
    controlReady &&
    online &&
    !busy &&
    access?.protocolVersion === 2 &&
    !!access?.experimentalEnabled &&
    !!access.device?.send &&
    live?.stopEnabled === true &&
    !!live.turnId;
  const liveText =
    live?.reason === "control-outcome-unconfirmed"
      ? t.controlUnconfirmed
      : live?.activity === "compacting"
        ? contextUsageCopy[locale].compacting
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
  return {
    usageEpoch,
    liveContentVersion,
    client,
    embedded,
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
    excludedSessionIds,
    catalogNotice,
    workspaces,
    selected,
    page,
    live,
    online,
    controlReady,
    indexEnabled,
    busy,
    error: error || catalogObservationFailed,
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
