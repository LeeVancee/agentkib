import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  WebClient,
  ApiError,
  type Access,
  type ConversationEventPage,
  type Live,
} from "@agentkib/web-client";
import { createConversationStore, type SessionStreamEvent } from "@agentkib/conversation-state";
import { api } from "@/core/api";
import {
  createDesktopConversationAdapter,
  hasDesktopConversation,
} from "@/core/conversation-bridge";
import { useSessionLive } from "../../../../web/src/features/sessions/use-session-live";
import { subscribeSessionInvalidation } from "../../../../web/src/features/sessions/session-events";
import type { NativeCoverage } from "../../../../web/src/features/sessions/session-model";

type Setter<T> = Dispatch<SetStateAction<T>>;

export function isClaudeReadBusy(error: unknown): boolean {
  return error instanceof ApiError
    ? error.code === "operation_busy"
    : error instanceof Error && /(?:^|:\s*)operation_busy$/.test(error.message);
}

/** Observe the shared stream while preserving the legacy local owner's control and receipt path. */
export function useClaudeSessionObservation({
  sessionId,
  generation,
  setLive,
  setHistory,
  setOnline,
  setError,
  refreshMetadata,
  refreshCapabilities,
  hasPending,
}: {
  sessionId: string;
  generation: RefObject<number>;
  setLive: Setter<Live | undefined>;
  setHistory: Setter<ConversationEventPage | undefined>;
  setOnline: Setter<boolean>;
  setError: Setter<string>;
  refreshMetadata: () => void;
  refreshCapabilities: () => void;
  hasPending: (sessionId: string) => boolean;
}) {
  const [client] = useState(() => {
    const adapter = createDesktopConversationAdapter();
    return new WebClient(
      undefined,
      { type: "same-origin" },
      {
        ...adapter,
        async request<Result>(path: string, body?: unknown, signal?: AbortSignal) {
          signal?.throwIfAborted();
          const [operation, query] = path.split("?");
          if (operation === "access" && body === undefined)
            return adapter.request<Result>(path, body, signal);
          // Only observation reads pass through this client. Commands and uploads
          // retain api.claudeRequest and its existing local-owner attachment scope.
          if (body !== undefined || !["live", "events"].includes(operation))
            throw new Error("unsupported_claude_observation");
          try {
            const result = await api.claudeRequest({
              operation,
              ...Object.fromEntries(new URLSearchParams(query)),
            });
            signal?.throwIfAborted();
            return result as Result;
          } catch (error) {
            if (isClaudeReadBusy(error))
              throw new ApiError(409, "operation_busy", "not-dispatched");
            throw error;
          }
        },
      },
    );
  });
  const [access, setAccess] = useState<Access>();
  const accessRef = useRef(access);
  const selection = useRef(sessionId);
  const streamReady = useRef(false);
  const controlReconciliationPending = useRef(false);
  const liveDelivery = useRef(0);
  const nativeCoverage = useRef<NativeCoverage>({
    items: [],
    authoritativeTurnIds: [],
    removedTurnIds: [],
  });
  const readinessEpoch = useRef(0);
  const refreshRequired = useRef(false);
  const refreshWake = useRef(0);
  const deferredRead = useRef(false);
  const [controlReady, setControlReady] = useState(false);
  const [catalogObservation, setCatalogObservation] = useState({ ready: false, error: "" });
  const [streamEpoch, setStreamEpoch] = useState(0);
  useEffect(() => {
    selection.current = sessionId;
    nativeCoverage.current = { items: [], authoritativeTurnIds: [], removedTurnIds: [] };
    deferredRead.current = false;
    refreshRequired.current = false;
  }, [sessionId]);
  useEffect(() => {
    accessRef.current = access;
  }, [access]);
  const fail = useCallback(
    (error: unknown, expected?: number) => {
      const expectedGeneration = expected ?? generation.current;
      if (generation.current !== expectedGeneration) return;
      setOnline(false);
      setControlReady(false);
      setError(error instanceof Error ? error.message : "connection_failed");
    },
    [generation, setOnline, setError],
  );
  const clear = useCallback(() => {
    setOnline(false);
    setControlReady(false);
  }, [setOnline]);
  useEffect(() => {
    if (!hasDesktopConversation()) return;
    let active = true;
    void client
      .access()
      .then((value) => {
        if (active) setAccess(value);
      })
      .catch((error: unknown) => {
        if (active) fail(error);
      });
    return () => {
      active = false;
    };
  }, [client, fail, streamEpoch]);
  const setStreamError = useCallback<Setter<boolean>>(
    (error) => {
      if (error === true) setError("connection_failed");
    },
    [setError],
  );
  // An admission-busy read waits for settlement, catalog or reconnection events.
  const readBusy = useCallback(
    (wake: number, expected?: number) => {
      const expectedGeneration = expected ?? generation.current;
      if (expectedGeneration !== generation.current) return;
      deferredRead.current = true;
      refreshRequired.current = true;
      setControlReady(false);
      // Settlement may already have arrived while the admission error was in flight.
      if (wake !== refreshWake.current) refreshMetadata();
    },
    [generation, refreshMetadata],
  );
  useSessionLive({
    streamReady,
    controlReconciliationPending,
    nativeCoverage,
    access,
    selected: sessionId,
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
    setError: setStreamError,
    hasDurablePending: hasPending,
    readinessEpoch,
    refreshRequired,
    setControlReady,
    setAccess,
    setPage: setHistory,
    streamEpoch,
    liveDelivery,
  });
  useEffect(
    () =>
      subscribeSessionInvalidation(client, (id, domains) => {
        if (id && id !== sessionId) return;
        if (domains.some((domain) => ["receipts", "ownership"].includes(domain))) refreshMetadata();
        if (domains.includes("capabilities")) refreshCapabilities();
      }),
    [client, sessionId, refreshMetadata, refreshCapabilities],
  );
  useEffect(() => {
    setCatalogObservation({ ready: false, error: "" });
    if (access?.status !== "approved" || access.protocolVersion !== 2) return;
    let closed = false;
    let resetPending = false;
    let resets = 0;
    let recoveryRequired = false;
    let connectionEpoch = 0;
    let stop: (() => void) | undefined;
    const store = createConversationStore<Live>("");
    const catalogFailed = (error: unknown) => {
      if (closed) return;
      recoveryRequired = true;
      // Directory failures must not overwrite the detailed stream's readiness.
      setCatalogObservation({
        ready: false,
        error: (error instanceof Error && error.message) || "connection_failed",
      });
    };
    const connect = () => {
      connectionEpoch = connectionEpoch + 1;
      const connection = connectionEpoch;
      const active = () => !closed && connection === connectionEpoch;
      stop = client.stream("", {
        open: () => {},
        error: (error) => {
          if (active()) catalogFailed(error);
        },
        event(type, data) {
          if (!active() || resetPending) return false;
          if (type === "control-changed") {
            try {
              const event = JSON.parse(data) as { sessionId?: string };
              refreshWake.current++;
              if (deferredRead.current || !event.sessionId || event.sessionId === sessionId)
                refreshMetadata();
            } catch {
              return false;
            }
            return false;
          }
          if (type === "session-ready") {
            try {
              const state = store.getSnapshot();
              if (
                state.cursor &&
                state.cursor === JSON.parse(data).cursor &&
                !state.resyncRequired
              ) {
                resets = 0;
                setCatalogObservation({ ready: true, error: "" });
                if (recoveryRequired) {
                  recoveryRequired = false;
                  // Empty replay can still have missed non-replayed receipts.
                  refreshWake.current++;
                  refreshMetadata();
                }
                return state.cursor;
              }
            } catch {
              /* Invalid readiness cannot complete recovery. */
            }
            return false;
          }
          if (type !== "session-event") return false;
          try {
            const event = JSON.parse(data) as SessionStreamEvent<Live>;
            const before = store.getSnapshot();
            const next = store.dispatch(event);
            if (next.resyncRequired) {
              catalogFailed(new Error("catalog_resync_required"));
              resetPending = true;
              connectionEpoch = connectionEpoch + 1;
              queueMicrotask(() => {
                if (closed) return;
                stop?.();
                resets = resets + 1;
                if (resets > 3) return;
                store.reset();
                resetPending = false;
                connect();
              });
              return false;
            }
            if (
              next !== before &&
              (event.type === "snapshot" ||
                (event.type === "invalidate" && event.payload.domains.includes("catalog")))
            ) {
              refreshWake.current++;
              refreshMetadata();
            }
            return next.cursor ?? false;
          } catch (error) {
            catalogFailed(error);
            resetPending = true;
            connectionEpoch = connectionEpoch + 1;
            queueMicrotask(() => {
              if (closed) return;
              stop?.();
              resets = resets + 1;
              if (resets > 3) return;
              store.reset();
              resetPending = false;
              connect();
            });
            return false;
          }
        },
      });
    };
    connect();
    return () => {
      closed = true;
      stop?.();
    };
  }, [client, sessionId, refreshMetadata, streamEpoch, access?.status, access?.protocolVersion]);
  const retry = useCallback(() => setStreamEpoch((value) => value + 1), []);
  const completeDeferredRead = useCallback(() => {
    if (!deferredRead.current) return;
    deferredRead.current = false;
    refreshRequired.current = false;
    setStreamEpoch((value) => value + 1);
  }, []);
  return {
    liveDelivery,
    nativeCoverage,
    catalogReady:
      !hasDesktopConversation() ||
      (access?.status === "approved" && access.protocolVersion === 2 && catalogObservation.ready),
    catalogError: catalogObservation.error,
    controlReady:
      !hasDesktopConversation() || (access?.protocolVersion === 2 && (!sessionId || controlReady)),
    retry,
    refreshWake,
    deferredRead,
    deferRead: readBusy,
    completeDeferredRead,
  };
}
