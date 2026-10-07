import { useEffect, useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useI18n } from "@/core/useI18n";
import { api } from "@/core/api";
import { groupCatalogAssets } from "@/features/catalog/catalog";
import { queryDefaults, useOptionalQueryClient } from "@/features/home/home-query";

export const SEARCH_ASSET_LIMIT = 500;
export function useSearchAssets(query: string, open: boolean) {
  const { localizeMessage } = useI18n();
  const term = query.trim();
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(term), 250);
    return () => clearTimeout(timer);
  }, [term]);
  const client = useOptionalQueryClient();
  const observerId = useId();
  const result = useQuery(
    {
      ...queryDefaults,
      queryKey: ["asset-search", observerId, term, SEARCH_ASSET_LIMIT, open],
      queryFn: async ({ signal }) => {
        const records = await api.catalogAssets(term, undefined, undefined, SEARCH_ASSET_LIMIT);
        signal.throwIfAborted();
        return records;
      },
      staleTime: 0,
      gcTime: 0,
      enabled: open && !!term && term === debounced,
    },
    client,
  );
  const visible = open && !!term;
  return {
    assets: visible ? groupCatalogAssets((result.data ?? []).slice(0, SEARCH_ASSET_LIMIT)) : [],
    loading: visible && (term !== debounced || result.isPending || result.isFetching),
    error: visible && !result.isFetching && result.error ? localizeMessage(result.error) : "",
    limited: visible && (result.data?.length ?? 0) >= SEARCH_ASSET_LIMIT,
    retry: () => {
      if (visible) void result.refetch({ cancelRefetch: false });
    },
  };
}
