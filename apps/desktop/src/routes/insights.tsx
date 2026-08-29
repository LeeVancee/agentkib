import { lazy, Suspense, useState } from "react";
import { CircleAlert, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { InsightsSkeleton } from "@/features/insights/InsightsSkeleton";
import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { useAppStore } from "../stores/app-store";
import { api } from "../core/api";
import { localizeMessage, tr } from "../core/i18n";
import type { InsightsSection } from "@/features/insights/InsightsPage";

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
  const workspaces = useAppStore((state) => state.workspaces);
  const refreshJobs = useAppStore((state) => state.refreshJobs);
  const setInsightsSummary = useAppStore((state) => state.setInsightsSummary);
  const [refreshError, setRefreshError] = useState("");
  const [refreshPending, setRefreshPending] = useState(false);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const refreshing =
    refreshPending ||
    refreshJobs.some(
      (job) => job.kind === "insights" && (job.state === "queued" || job.state === "running"),
    );

  const setSection = (nextSection: InsightsSection) => {
    void navigate({
      to: "/insights",
      search: (current) => ({ ...current, insightsSection: nextSection }) as never,
    });
  };

  const refresh = async () => {
    setRefreshError("");
    setRefreshPending(true);
    try {
      const receipt = await api.requestRefresh("insights", true);
      if (receipt.status.state === "succeeded") {
        setRefreshRevision((value) => value + 1);
      }
    } catch (error) {
      setRefreshError(localizeMessage(error));
    } finally {
      setRefreshPending(false);
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
      <Suspense fallback={<InsightsSkeleton />}>
        <InsightsPageLazy
          section={section}
          workspaces={workspaces}
          onSummary={setInsightsSummary}
          refreshRevision={refreshRevision}
        />
      </Suspense>
    </div>
  );
}

export const Route = createFileRoute("/insights")({ component: InsightsRoute });
