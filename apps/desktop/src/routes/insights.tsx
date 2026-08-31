import { lazy, Suspense, useState } from "react";
import { CircleAlert, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { InsightsSkeleton } from "@/features/insights/InsightsSkeleton";
import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { localizeMessage, tr } from "../core/i18n";
import type { InsightsSection } from "@/features/insights/InsightsPage";
import { useHomeWorkspaces } from "@/features/home/home-query";
import {
  useInsightsRefreshJob,
  useInsightsRefreshMutation,
} from "@/features/insights/insights-query";

const InsightsPageLazy = lazy(() =>
  import("@/features/insights/InsightsPage").then(({ InsightsPage }) => ({
    default: InsightsPage,
  })),
);

type InsightsSearch = { insightsSection?: InsightsSection };

function InsightsRoute() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as InsightsSearch;
  const section = search.insightsSection ?? "overview";
  const workspacesQuery = useHomeWorkspaces();
  const refreshJobQuery = useInsightsRefreshJob();
  const refreshMutation = useInsightsRefreshMutation();
  const [refreshError, setRefreshError] = useState("");
  const workspaces = workspacesQuery.data ?? [];
  const refreshJob = refreshJobQuery.data;
  const refreshing =
    refreshMutation.isPending || refreshJob?.state === "queued" || refreshJob?.state === "running";

  const setSection = (nextSection: InsightsSection) => {
    void navigate({
      to: "/insights",
      search: (current) => ({ ...current, insightsSection: nextSection }) as never,
    });
  };

  const refresh = async () => {
    setRefreshError("");
    try {
      await refreshMutation.mutateAsync();
    } catch (error) {
      setRefreshError(localizeMessage(error));
    }
  };

  return (
    <div className="relative grid gap-5 pb-8" data-view={section}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 w-fit max-w-[calc(100%-3rem)] overflow-hidden">
          <Tabs
            value={section}
            onValueChange={(value) => setSection(value as InsightsSection)}
            className="min-w-0"
          >
            <TabsList
              className="segmented-control !h-auto w-fit max-w-full justify-start"
              variant="default"
              aria-label={tr("nav.insights")}
            >
              {["overview", "tokens", "commits", "milestones", "sources"].map((value) => (
                <TabsTrigger
                  className="segmented-control-item h-9 min-h-9 flex-none px-3"
                  key={value}
                  value={value}
                >
                  {tr(`insights.section.${value}`)}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
        <Button
          variant="outline"
          size="icon"
          className="size-10 shrink-0 rounded-xl"
          aria-label={tr("insights.refresh")}
          title={tr("insights.refresh")}
          onClick={() => void refresh()}
          disabled={refreshing}
        >
          <RefreshCw size={15} className={refreshing ? "animate-spin" : ""} />
        </Button>
      </div>
      {refreshError && (
        <div className="flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <CircleAlert size={16} />
          {refreshError}
        </div>
      )}
      <Suspense fallback={<InsightsSkeleton section={section} />}>
        <InsightsPageLazy section={section} workspaces={workspaces} />
      </Suspense>
    </div>
  );
}

export const Route = createFileRoute("/insights")({ component: InsightsRoute });
