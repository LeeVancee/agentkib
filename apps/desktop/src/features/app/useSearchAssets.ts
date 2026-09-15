/** @jsxImportSource octane */

import { useI18n } from "@/core/useI18n";
import { useEffect, useRef, useState } from "octane";
import { api } from "@/core/api";
import { groupCatalogAssets, type CatalogAssetGroup } from "@/features/catalog/catalog";

export const SEARCH_ASSET_LIMIT = 500;
export function useSearchAssets(query: string, open: boolean) {
  const { localizeMessage } = useI18n();
  const term = query.trim();
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const [state, setState] = useState({
    term: "",
    loading: false,
    assets: [] as CatalogAssetGroup[],
    error: "" as unknown,
    limited: false,
  });
  useEffect(() => {
    const request = ++generation.current;
    if (!open || !term) return;
    void Promise.resolve().then(() => {
      setState({ term, loading: true, assets: [], error: "", limited: false });
    });
    const timer = setTimeout(() => {
      void api
        .catalogAssets(term, undefined, undefined, SEARCH_ASSET_LIMIT)
        .then((records) => {
          if (request !== generation.current) return;
          setState({
            term,
            loading: false,
            assets: groupCatalogAssets(records.slice(0, SEARCH_ASSET_LIMIT)),
            error: "",
            limited: records.length >= SEARCH_ASSET_LIMIT,
          });
        })
        .catch((error: unknown) => {
          if (request === generation.current)
            setState({
              term,
              loading: false,
              assets: [],
              error,
              limited: false,
            });
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      generation.current += 1;
    };
  }, [term, open, revision]);
  const visible = open && Boolean(term) && state.term === term;
  return {
    assets: visible ? state.assets : [],
    loading: open && Boolean(term) && (!visible || state.loading),
    error: visible && state.error ? localizeMessage(state.error) : "",
    limited: visible && state.limited,
    retry: () => {
      setState({ term, loading: true, assets: [], error: "", limited: false });
      setRevision((value) => value + 1);
    },
  };
}
/** @jsxImportSource octane */
