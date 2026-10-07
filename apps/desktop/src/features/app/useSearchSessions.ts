import { useQueries } from "@tanstack/react-query";
import { useI18n } from "@/core/useI18n";
import type { WorkspaceSummary } from "@/core/types";
import { useOptionalQueryClient } from "@/features/home/home-query";
import { sortSessions } from "@/features/sessions/session-catalog";
import { sessionListOptions } from "@/features/sessions/session-query";

export function useSearchSessions(workspaces: WorkspaceSummary[], enabled: boolean) {
  const { localizeMessage } = useI18n();
  const client = useOptionalQueryClient();
  const ids = enabled ? [...new Set(workspaces.map(({ id }) => id))].sort() : [];
  const queries = useQueries({ queries: ids.map((id) => sessionListOptions(client, id)) }, client);
  return {
    sessions: sortSessions(queries.flatMap((query) => query.data ?? [])),
    errors: Object.fromEntries(
      queries.flatMap((query, index) =>
        query.error ? [[ids[index], localizeMessage(query.error)]] : [],
      ),
    ),
    loading: queries.some((query) => query.isFetching || query.isPending),
    retry: async () => {
      await Promise.all(
        queries
          .filter((query) => query.isError)
          .map((query) => query.refetch({ cancelRefetch: false })),
      );
    },
  };
}
