import { useId } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useI18n } from "@/core/useI18n";
import { api } from "@/core/api";
import { readRemoteHistory } from "@/features/remote/remote-catalog-store";
import { queryDefaults, useOptionalQueryClient } from "@/features/home/home-query";
import type { ConversationEvent, ConversationSessionSummary } from "@/core/types";
import { sessionKeys } from "./session-query";

export function useSessionHistory(
  session: ConversationSessionSummary | undefined,
  enabled: boolean,
  revision = 0,
) {
  const { localizeMessage } = useI18n();
  const client = useOptionalQueryClient();
  const observerId = useId();
  const sessionId = enabled && session?.availability === "readable" ? session.id : "";
  const queryKey = [
    ...sessionKeys.history(
      session?.workspace_id ?? "",
      sessionId,
      session?.remote ? [session.remote.host_id, session.remote.original_id] : null,
      revision,
    ),
    observerId,
  ];
  const query = useInfiniteQuery(
    {
      ...queryDefaults,
      queryKey,
      queryFn: async ({ pageParam, signal }) => {
        const page = session?.remote
          ? await (pageParam ? readRemoteHistory(session, pageParam) : readRemoteHistory(session))
          : await (pageParam
              ? api.sessionEvents(sessionId, pageParam)
              : api.sessionEvents(sessionId));
        signal.throwIfAborted();
        return page;
      },
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (page) => page.next_cursor ?? undefined,
      enabled: !!sessionId,
      staleTime: Infinity,
      gcTime: 0,
    },
    client,
  );
  const pages = sessionId ? (query.data?.pages ?? []) : [];
  const seen = new Set<string>();
  const events: ConversationEvent[] = [...pages]
    .reverse()
    .flatMap((page) => page.events)
    .filter((event) => {
      if (seen.has(event.id)) return false;
      seen.add(event.id);
      return true;
    });
  const warnings = [
    ...new Set(
      pages.flatMap((page, index) =>
        page.warnings.filter(
          (warning) => warning !== "TRANSCRIPT_SCAN_BUDGET" || index === pages.length - 1,
        ),
      ),
    ),
  ];
  const rawError = sessionId && !query.isFetching ? query.error : null;
  return {
    key: sessionId ? JSON.stringify([session?.workspace_id, sessionId, revision]) : "",
    events,
    warnings,
    loading: !!sessionId && query.isPending,
    loadingEarlier: !!sessionId && query.isFetchingNextPage,
    nextCursor: pages.at(-1)?.next_cursor,
    rawError: rawError ?? "",
    error: rawError ? localizeMessage(rawError) : "",
    loadEarlier: async () => {
      const state = client.getQueryState(queryKey);
      if (
        !sessionId ||
        !state ||
        state.fetchStatus !== "idle" ||
        !query.hasNextPage ||
        client.getQueryCache().find({ queryKey, exact: true })?.getObserversCount() === 0
      )
        return;
      await query.fetchNextPage({ cancelRefetch: false });
    },
    retry: async () => {
      if (
        !sessionId ||
        client.getQueryState(queryKey)?.fetchStatus !== "idle" ||
        client.getQueryCache().find({ queryKey, exact: true })?.getObserversCount() === 0
      )
        return;
      await client.resetQueries({ queryKey, exact: true });
    },
  };
}
