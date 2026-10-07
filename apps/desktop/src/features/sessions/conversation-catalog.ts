/** @jsxImportSource octane */

import { useEffect } from "octane";
import { create } from "@octanejs/zustand";
import type { ConversationCatalog } from "@agentkib/web-client";
import { createConversationStore, type SessionStreamEvent } from "@agentkib/conversation-state";
import {
  createDesktopConversationAdapter,
  desktopConversationRequest,
  hasDesktopConversation,
} from "@/core/conversation-bridge";
import type { ConversationSessionSummary } from "@/core/types";

interface ConversationCatalogState {
  sessions: ConversationSessionSummary[];
  ready: boolean;
  error?: unknown;
}

const useConversationCatalogStore = create<ConversationCatalogState>(() => ({
  sessions: [],
  ready: false,
}));
let generation = 0;
let invalidation = 0;
let pending: Promise<ConversationSessionSummary[]> | undefined;
let observationError: unknown;
let retryObservation: (() => void) | undefined;
let catalogObservers = 0;
let stopCatalogObservation: (() => void) | undefined;
const emptySessions: ConversationSessionSummary[] = [];

function resetConversationCatalog() {
  generation += 1;
  pending = undefined;
  observationError = undefined;
  const current = useConversationCatalogStore.getState();
  if (current.sessions.length || current.error)
    useConversationCatalogStore.setState({
      sessions: emptySessions,
      ready: true,
      error: undefined,
    });
}

export function refreshConversationCatalog(): Promise<ConversationSessionSummary[]> {
  if (!hasDesktopConversation()) return Promise.resolve([]);
  retryObservation?.();
  invalidation++;
  if (pending) return pending;
  const request = generation;
  const task = (async () => {
    while (true) {
      const version = invalidation;
      const catalog = await desktopConversationRequest<ConversationCatalog>("catalog");
      const sessions: ConversationSessionSummary[] = catalog.sessions.map((session) => ({
        ...session,
        indexedSessionIds:
          session.indexedSessionIds ??
          (session.indexedSessionId ? [session.indexedSessionId] : undefined),
        created_at: session.created_at ?? undefined,
        git_branch: session.git_branch ?? undefined,
        forked_from_session_id: session.forked_from_session_id ?? undefined,
        spawned_by_session_id: session.spawned_by_session_id ?? undefined,
      }));
      if (generation !== request) return sessions;
      if (version === invalidation) {
        // A successful one-off read does not prove the live subscription recovered.
        useConversationCatalogStore.setState({ sessions, ready: true, error: observationError });
        return sessions;
      }
      // A create/fork or invalidation arrived during this fetch. Its caller must
      // receive the fresh catalog, not the response captured before the mutation.
    }
  })()
    .catch((error: unknown) => {
      if (generation === request) useConversationCatalogStore.setState({ ready: true, error });
      throw error;
    })
    .finally(() => {
      if (pending === task) pending = undefined;
    });
  pending = task;
  return task;
}

function releaseCatalogObserver() {
  catalogObservers -= 1;
  if (catalogObservers > 0) return;
  stopCatalogObservation?.();
  stopCatalogObservation = undefined;
  resetConversationCatalog();
}

/** Includes managed tasks before they have appeared in the native history index. */
export function useConversationCatalog(enabled: boolean) {
  const state = useConversationCatalogStore();
  useEffect(() => {
    if (!enabled || !hasDesktopConversation()) {
      if (catalogObservers === 0) resetConversationCatalog();
      return;
    }
    catalogObservers += 1;
    if (catalogObservers > 1) return releaseCatalogObserver;
    observationError = undefined;
    useConversationCatalogStore.setState({ ready: false, error: undefined });
    void refreshConversationCatalog().catch(() => {});
    const store = createConversationStore("");
    let closed = false;
    let resyncing = false;
    let exhausted = false;
    let resets = 0;
    let stop: (() => void) | undefined;
    const resync = (error: unknown) => {
      resyncing = true;
      queueMicrotask(() => {
        if (closed) return;
        stop?.();
        resets += 1;
        if (resets > 3) {
          exhausted = true;
          observationError = error;
          useConversationCatalogStore.setState({ error });
          return;
        }
        store.reset();
        resyncing = false;
        connect();
      });
    };
    const connect = () => {
      stop = createDesktopConversationAdapter().stream("", {
        open: () => {},
        error: (error) => {
          if (closed) return;
          observationError = error;
          useConversationCatalogStore.setState({ error });
        },
        event: (type, data) => {
          if (closed || resyncing) return false;
          if (type === "session-ready") {
            try {
              const ready = JSON.parse(data) as { cursor?: string };
              const state = store.getSnapshot();
              if (state.cursor && state.cursor === ready.cursor && !state.resyncRequired) {
                resets = 0;
                if (useConversationCatalogStore.getState().error === observationError)
                  useConversationCatalogStore.setState({ error: undefined });
                observationError = undefined;
              }
            } catch {
              // Invalid readiness never resets the consecutive failure limit.
            }
            return false;
          }
          if (type !== "session-event") return false;
          let event: SessionStreamEvent;
          let previous = store.getSnapshot();
          let state = previous;
          try {
            event = JSON.parse(data) as SessionStreamEvent;
            previous = store.getSnapshot();
            state = store.dispatch(event);
          } catch (error) {
            resync(error);
            return false;
          }
          if (state.resyncRequired) {
            resync(new Error("catalog-resync-required"));
            return false;
          }
          if (
            state !== previous &&
            (event.type === "snapshot" ||
              (event.type === "invalidate" && event.payload.domains.includes("catalog")))
          )
            void refreshConversationCatalog().catch(() => {});
          return state.cursor ?? false;
        },
      });
    };
    const retry = () => {
      if (closed || !exhausted) return;
      exhausted = false;
      resyncing = false;
      resets = 0;
      store.reset();
      connect();
    };
    retryObservation = retry;
    connect();
    stopCatalogObservation = () => {
      closed = true;
      if (retryObservation === retry) retryObservation = undefined;
      stop?.();
    };
    return releaseCatalogObserver;
  }, [enabled]);
  return {
    ...state,
    sessions: enabled ? state.sessions : emptySessions,
    ready: !enabled || !hasDesktopConversation() || state.ready,
  };
}
