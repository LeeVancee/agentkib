import { useI18n } from "@/core/useI18n";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useMutation, useQueries } from "@tanstack/react-query";
import { api } from "@/core/api";
import type { WorkspaceSummary } from "@/core/types";
import { homeKeys, useOptionalQueryClient } from "@/features/home/home-query";
import { sortSessions } from "./session-catalog";
import { queuedSessionRead, sessionListOptions, sessionStatusOptions } from "./session-query";

export function useSessionCatalog(
  workspaces: WorkspaceSummary[],
  enabled: boolean,
  afterRefresh?: () => Promise<unknown>,
) {
  const { localizeMessage } = useI18n();
  const client = useOptionalQueryClient();
  const key = JSON.stringify([...new Set(workspaces.map(({ id }) => id))].sort());
  const ids = useMemo(() => JSON.parse(key) as string[], [key]);
  const observedIds = enabled ? ids : [];
  const { results: lists, sessions } = useQueries(
    {
      queries: observedIds.map((id) => sessionListOptions(client, id)),
      combine: (results) => ({
        results,
        sessions: sortSessions(results.flatMap((query) => query.data ?? [])),
      }),
    },
    client,
  );
  const statuses = useQueries(
    { queries: observedIds.map((id) => sessionStatusOptions(client, id)) },
    client,
  );
  const controller = useRef<AbortController | undefined>(undefined);
  const operation = useRef<Promise<void> | undefined>(undefined);
  // Scanning updates the persistent index. Keep it a mutation, separate from
  // the read-only queries shared with search and the home page.
  const performSync = useCallback(
    async ({
      signal,
      force,
      initial,
    }: {
      signal: AbortSignal;
      force: boolean;
      initial: boolean;
      key: string;
    }) => {
      if (initial)
        await Promise.allSettled(
          ids.flatMap((id) => [
            client.fetchQuery({ ...sessionListOptions(client, id), staleTime: 0 }),
            client.fetchQuery({ ...sessionStatusOptions(client, id), staleTime: 0 }),
          ]),
        );
      signal.throwIfAborted();
      const errors: Record<string, unknown> = {};
      await Promise.all(
        ids.map(async (id) => {
          try {
            const sessions = await queuedSessionRead(client, `scan:${id}:${force}`, signal, () =>
              api.refreshWorkspaceSessions(id, force),
            );
            signal.throwIfAborted();
            await client.cancelQueries({ queryKey: homeKeys.continuations(id), exact: true });
            signal.throwIfAborted();
            client.setQueryData(homeKeys.continuations(id), sessions);
          } catch (error) {
            if (!signal.aborted) errors[id] = error;
          }
          if (signal.aborted) return;
          try {
            await client.fetchQuery({ ...sessionStatusOptions(client, id), staleTime: 0 });
          } catch (error) {
            if (!signal.aborted) errors[id] = error;
          }
        }),
      );
      signal.throwIfAborted();
      await afterRefresh?.();
      signal.throwIfAborted();
      return errors;
    },
    [ids, client, afterRefresh],
  );
  const sync = useMutation(
    {
      networkMode: "always",
      mutationFn: ({
        request,
      }: {
        request: Promise<Record<string, unknown>>;
        signal: AbortSignal;
        key: string;
        initial: boolean;
      }) => request,
    },
    client,
  );
  const mutateAsync = sync.mutateAsync;
  useEffect(() => {
    const current = new AbortController();
    controller.current = current;
    if (enabled && ids.length) {
      const task = mutateAsync({
        signal: current.signal,
        key,
        initial: true,
        request: performSync({ signal: current.signal, force: false, initial: true, key }),
      }).then(
        () => {},
        () => {},
      );
      operation.current = task;
      void task.finally(() => {
        if (operation.current === task) operation.current = undefined;
      });
    }
    return () => {
      current.abort();
      operation.current = undefined;
    };
  }, [enabled, ids, key, mutateAsync, performSync]);
  const errors: Record<string, string> = {};
  for (const [index, id] of observedIds.entries()) {
    const error =
      (sync.variables?.key === key && !sync.isPending ? sync.data?.[id] : undefined) ??
      statuses[index]?.error ??
      lists[index]?.error;
    if (error) errors[id] = localizeMessage(error);
  }
  const refresh = useCallback((): Promise<void> => {
    if (!enabled || !ids.length || !controller.current || controller.current.signal.aborted)
      return Promise.resolve();
    if (operation.current) return operation.current;
    const task = mutateAsync({
      signal: controller.current.signal,
      key,
      initial: false,
      request: performSync({ signal: controller.current.signal, force: true, initial: false, key }),
    }).then(
      () => {},
      () => {},
    );
    operation.current = task;
    void task.finally(() => {
      if (operation.current === task) operation.current = undefined;
    });
    return task;
  }, [enabled, ids, key, mutateAsync, performSync]);
  return {
    sessions,
    statuses: statuses.flatMap((query) => query.data ?? []),
    errors,
    errorUpdatedAt: Math.max(
      0,
      ...lists.map((query) => query.errorUpdatedAt),
      ...statuses.map((query) => query.errorUpdatedAt),
      sync.variables?.key === key && Object.keys(sync.data ?? {}).length ? sync.submittedAt : 0,
    ),
    loading: enabled && lists.some((query) => query.isPending && query.isFetching),
    refreshing: enabled && sync.variables?.key === key && sync.isPending,
    ready:
      !enabled ||
      !ids.length ||
      (sync.variables?.key === key &&
        !sync.variables.signal.aborted &&
        (!sync.variables.initial || sync.isSuccess || sync.isError)),
    refresh,
  };
}
