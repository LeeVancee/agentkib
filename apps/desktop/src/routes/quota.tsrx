/** @jsxImportSource octane */

import { lazy, Suspense } from "octane";
import { QuotaSkeleton } from "@/features/quota/QuotaSkeleton";
import { createFileRoute, useSearch } from "@octanejs/tanstack-router";
import { useAppStore } from "../stores/app-store";
import type { QuotaWindowSelector } from "../core/types";

const QuotaPageLazy = lazy(() =>
  import("@/features/quota/QuotaPage").then(({ QuotaPage }) => ({ default: QuotaPage })),
);

type QuotaSearch = { quotaProvider?: string; quotaWindow?: QuotaWindowSelector };

function QuotaRoute() {
  const search = useSearch({ strict: false }) as QuotaSearch;
  const configurePopoverRequest = useAppStore((state) => state.quotaConfigureRequest);

  return (
    <Suspense fallback={<QuotaSkeleton />}>
      <QuotaPageLazy
        initialProvider={search.quotaProvider}
        initialWindow={search.quotaWindow}
        configurePopoverRequest={configurePopoverRequest}
      />
    </Suspense>
  );
}

export const Route = createFileRoute("/quota")({ component: QuotaRoute });
