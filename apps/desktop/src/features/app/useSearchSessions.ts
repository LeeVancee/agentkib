/** @jsxImportSource octane */

import { useI18n } from "@/core/useI18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "octane";
import type { QueryClient } from "@octanejs/tanstack-query";
import { api } from "@/core/api";
import type { ConversationSessionSummary, WorkspaceSummary } from "@/core/types";
import { homeKeys, queryDefaults, useOptionalQueryClient } from "@/features/home/home-query.tsrx";
import { sortSessions } from "@/features/sessions/session-catalog";

type Sessions = ConversationSessionSummary[];
interface PendingRead {
  consumers: Set<() => boolean>;
  promise: Promise<Sessions | undefined>;
}

// The queue survives dialog unmounts: closing and reopening search must not
// create another four RPCs while the previous desktop calls are still running.
let activeReads = 0;
const queue: Array<() => void> = [];
const pendingByClient = new WeakMap<QueryClient, Map<string, PendingRead>>();

function drain() {
  while (activeReads < 4 && queue.length) queue.shift()?.();
}

function readStoredSessions(client: QueryClient, id: string, current: () => boolean) {
  let pending = pendingByClient.get(client);
  if (!pending) {
    pending = new Map();
    pendingByClient.set(client, pending);
  }
  const existing = pending.get(id);
  if (existing) {
    existing.consumers.add(current);
    return existing.promise;
  }
  const consumers = new Set([current]);
  const promise = new Promise<Sessions | undefined>((resolve, reject) => {
    queue.push(() => {
      if (![...consumers].some((isCurrent) => isCurrent())) {
        resolve(undefined);
        return;
      }
      activeReads += 1;
      // This endpoint only reads indexed records. Search never triggers discovery
      // or refreshWorkspaceSessions, nor reads conversation event contents.
      void api
        .workspaceSessions(id)
        .then(resolve, reject)
        .finally(() => {
          activeReads -= 1;
          drain();
        });
    });
  });
  pending.set(id, { consumers, promise });
  void promise.then(
    () => pending.delete(id),
    () => pending.delete(id),
  );
  drain();
  return promise;
}

interface SearchSessionState {
  key: string;
  enabled: boolean;
  sessions: Record<string, Sessions>;
  errors: Record<string, unknown>;
  loading: boolean;
}

export function useSearchSessions(workspaces: WorkspaceSummary[], enabled: boolean) {
  const { localizeMessage } = useI18n();
  const client = useOptionalQueryClient();
  const key = JSON.stringify([...new Set(workspaces.map(({ id }) => id))].sort());
  const ids = useMemo(() => JSON.parse(key) as string[], [key]);
  const generation = useRef(0);
  const retryRef = useRef<() => Promise<void>>(async () => {});
  const [state, setState] = useState<SearchSessionState>({
    key,
    enabled: false,
    sessions: {},
    errors: {},
    loading: false,
  });

  useEffect(() => {
    const run = ++generation.current;
    const current = () => generation.current === run;
    const cached = enabled
      ? Object.fromEntries(
          ids.map((id) => [id, client.getQueryData<Sessions>(homeKeys.continuations(id)) ?? []]),
        )
      : {};
    void Promise.resolve().then(() => {
      setState({ key, enabled, sessions: cached, errors: {}, loading: enabled && ids.length > 0 });
    });
    const failed = new Set<string>();
    let operation: Promise<void> | undefined;

    const load = async (id: string, force: boolean) => {
      const queryKey = homeKeys.continuations(id);
      const cachedData = client.getQueryData<Sessions>(queryKey);
      const queryState = client.getQueryState(queryKey);
      if (
        !force &&
        cachedData !== undefined &&
        !queryState?.isInvalidated &&
        Date.now() - (queryState?.dataUpdatedAt ?? 0) < queryDefaults.staleTime
      )
        return;
      try {
        const records = await readStoredSessions(client, id, current);
        if (!current() || records === undefined) return;
        // A session-page refresh may have completed while our older read was
        // pending. Keep that newer shared snapshot instead of overwriting it.
        const latest = client.getQueryData<Sessions>(queryKey);
        const sessions = latest !== cachedData && latest !== undefined ? latest : records;
        if (sessions === records) client.setQueryData(queryKey, records);
        failed.delete(id);
        setState((previous) => {
          const errors = { ...previous.errors };
          delete errors[id];
          return { ...previous, sessions: { ...previous.sessions, [id]: sessions }, errors };
        });
      } catch (error) {
        if (!current()) return;
        failed.add(id);
        setState((previous) => ({
          ...previous,
          errors: { ...previous.errors, [id]: error },
        }));
      }
    };
    const loadMany = (targets: string[], force: boolean): Promise<void> => {
      if (!enabled || !current() || !targets.length) return Promise.resolve();
      if (operation) return operation;
      void Promise.resolve().then(() => {
        if (current()) setState((previous) => ({ ...previous, loading: true }));
      });
      operation = Promise.all(targets.map((id) => load(id, force))).then(() => {
        operation = undefined;
        if (current()) setState((previous) => ({ ...previous, loading: false }));
      });
      return operation;
    };
    retryRef.current = () => loadMany([...failed], true);
    if (enabled && ids.length) void loadMany(ids, false);
    return () => {
      generation.current += 1;
      retryRef.current = async () => {};
    };
  }, [client, enabled, ids, key]);

  const visible = enabled && state.enabled && state.key === key;
  const sessions = useMemo(
    () => (visible ? sortSessions(ids.flatMap((id) => state.sessions[id] ?? [])) : []),
    [ids, state.sessions, visible],
  );
  const retry = useCallback(() => retryRef.current(), []);
  return {
    sessions,
    errors: visible
      ? Object.fromEntries(
          Object.entries(state.errors).map(([id, error]) => [id, localizeMessage(error)]),
        )
      : {},
    loading: enabled && ids.length > 0 && (!visible || state.loading),
    retry,
  };
}
/** @jsxImportSource octane */
