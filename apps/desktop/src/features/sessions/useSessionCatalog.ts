/** @jsxImportSource octane */

import { useI18n } from "@/core/useI18n";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "octane";
import { api } from "@/core/api";
import type {
  ConversationIndexStatus,
  ConversationSessionSummary,
  WorkspaceSummary,
} from "@/core/types";
import { homeKeys, useOptionalQueryClient } from "@/features/home/home-query.tsrx";
import { sortSessions } from "./session-catalog";

const statusKey = (workspaceId: string) => [...homeKeys.continuations(workspaceId), "status"];

// Keep the limiter outside the hook. A workspace change or leaving/re-entering
// the page must not start four new calls while obsolete desktop RPCs still run.
function createQueue() {
  let active = 0;
  const pending: Array<() => void> = [];
  const drain = () => {
    while (active < 4 && pending.length) pending.shift()?.();
  };
  return (task: () => Promise<void>) =>
    new Promise<void>((resolve) => {
      pending.push(() => {
        active += 1;
        void task().finally(() => {
          active -= 1;
          resolve();
          drain();
        });
      });
      drain();
    });
}

const catalogQueue = createQueue();

interface CatalogState {
  key: string;
  enabled: boolean;
  sessions: Record<string, ConversationSessionSummary[]>;
  statuses: Record<string, ConversationIndexStatus[]>;
  errors: Record<string, unknown>;
  loading: boolean;
  refreshing: boolean;
  ready: boolean;
}

export function useSessionCatalog(workspaces: WorkspaceSummary[], enabled: boolean) {
  const { localizeMessage } = useI18n();
  const queryClient = useOptionalQueryClient();
  const key = JSON.stringify([...new Set(workspaces.map((workspace) => workspace.id))].sort());
  const ids = useMemo(() => JSON.parse(key) as string[], [key]);
  const queue = catalogQueue;
  const generation = useRef(0);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const getInitialState = () => {
    const cachedSessions = Object.fromEntries(
      ids.map((id) => [
        id,
        queryClient.getQueryData<ConversationSessionSummary[]>(homeKeys.continuations(id)) ?? [],
      ]),
    );
    const cachedStatuses = Object.fromEntries(
      ids.map((id) => [
        id,
        queryClient.getQueryData<ConversationIndexStatus[]>(statusKey(id)) ?? [],
      ]),
    );
    return {
      key,
      enabled,
      sessions: enabled ? cachedSessions : {},
      statuses: enabled ? cachedStatuses : {},
      errors: {},
      loading:
        enabled &&
        ids.some((id) => queryClient.getQueryData(homeKeys.continuations(id)) === undefined),
      refreshing: false,
      ready: !enabled || ids.length === 0,
    } satisfies CatalogState;
  };
  const [state, setState] = useState<CatalogState>(getInitialState);

  useLayoutEffect(() => {
    const currentGeneration = ++generation.current;
    const current = () => generation.current === currentGeneration;
    const cachedSessions = Object.fromEntries(
      ids.map((id) => [
        id,
        queryClient.getQueryData<ConversationSessionSummary[]>(homeKeys.continuations(id)) ?? [],
      ]),
    );
    const cachedStatuses = Object.fromEntries(
      ids.map((id) => [
        id,
        queryClient.getQueryData<ConversationIndexStatus[]>(statusKey(id)) ?? [],
      ]),
    );
    const initialState = {
      key,
      enabled,
      sessions: enabled ? cachedSessions : {},
      statuses: enabled ? cachedStatuses : {},
      errors: {},
      loading:
        enabled &&
        ids.some((id) => queryClient.getQueryData(homeKeys.continuations(id)) === undefined),
      refreshing: false,
      ready: !enabled || ids.length === 0,
    } satisfies CatalogState;
    void Promise.resolve().then(() => {
      if (current()) setState(initialState);
    });

    const writeError = (id: string, error: unknown) => {
      if (!current()) return;
      setState((previous) => ({
        ...previous,
        errors: { ...previous.errors, [id]: error },
      }));
    };
    const loadWorkspace = async (id: string, refresh: boolean, force: boolean) => {
      if (!current()) return;
      try {
        const sessions = await (refresh
          ? api.refreshWorkspaceSessions(id, force)
          : api.workspaceSessions(id));
        if (!current()) return;
        queryClient.setQueryData(homeKeys.continuations(id), sessions);
        setState((previous) => ({
          ...previous,
          sessions: { ...previous.sessions, [id]: sessions },
        }));
      } catch (error) {
        writeError(id, error);
      }
      if (!current()) return;
      try {
        const statuses = await api.workspaceSessionStatus(id);
        if (!current()) return;
        queryClient.setQueryData(statusKey(id), statuses);
        setState((previous) => ({
          ...previous,
          statuses: { ...previous.statuses, [id]: statuses },
        }));
      } catch (error) {
        writeError(id, error);
      }
    };

    let activeRefresh: Promise<void> | undefined;
    let initializing = true;
    const runRefresh = (force: boolean): Promise<void> => {
      if (!enabled || !current() || !ids.length) return Promise.resolve();
      if (activeRefresh) return activeRefresh;
      setState((previous) => ({ ...previous, refreshing: true, errors: {} }));
      activeRefresh = Promise.all(
        ids.map((id) => queue(() => loadWorkspace(id, true, force))),
      ).then(() => {
        activeRefresh = undefined;
        if (current()) {
          setState((previous) => ({ ...previous, refreshing: false, ready: true }));
        }
      });
      return activeRefresh;
    };
    refreshRef.current = () => {
      if (initializing) return Promise.resolve();
      return runRefresh(true);
    };
    if (enabled && ids.length) {
      void Promise.all(ids.map((id) => queue(() => loadWorkspace(id, false, false)))).then(
        async () => {
          if (!current()) return;
          setState((previous) => ({ ...previous, loading: false }));
          initializing = false;
          await runRefresh(false);
        },
      );
    } else {
      initializing = false;
    }
    return () => {
      generation.current += 1;
      refreshRef.current = async () => {};
    };
  }, [enabled, ids, key, queryClient, queue]);

  const refresh = useCallback(() => refreshRef.current(), []);
  // A just-enabled render must not treat the previous disabled empty/ready state
  // as an authoritative result before the new loading effect has committed.
  const visible = enabled && state.enabled && state.key === key;
  const sessions = useMemo(
    () => (visible ? sortSessions(ids.flatMap((id) => state.sessions[id] ?? [])) : []),
    [visible, ids, state.sessions],
  );
  const statuses = useMemo(
    () => (visible ? ids.flatMap((id) => state.statuses[id] ?? []) : []),
    [visible, ids, state.statuses],
  );
  return {
    sessions,
    statuses,
    errors: visible
      ? Object.fromEntries(
          Object.entries(state.errors).map(([id, error]) => [id, localizeMessage(error)]),
        )
      : {},
    loading: enabled && (!visible || state.loading),
    refreshing: visible && state.refreshing,
    ready: !enabled || (visible && state.ready),
    refresh,
  };
}
/** @jsxImportSource octane */
