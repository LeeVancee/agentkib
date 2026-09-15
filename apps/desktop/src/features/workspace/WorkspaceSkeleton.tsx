/** @jsxImportSource octane */

import { useI18n } from "@/core/useI18n";
import {
  SkeletonListRows,
  SkeletonMetricCard,
  SkeletonPage,
  SkeletonPanel,
  SkeletonPanelHeader,
  SkeletonTable,
  SkeletonText,
  SkeletonToolbar,
} from "@/components/ui/skeleton-layouts";
import { Skeleton } from "@/components/ui/skeleton";

export function WorkspaceLayoutSkeleton() {
  const { tr } = useI18n();
  return (
    <SkeletonPage className="gap-4 pt-5" label={`${tr("common.loading")} ${tr("nav.workspaces")}`}>
      <SkeletonPanel className="flex min-h-[86px] items-center justify-between gap-4 px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <Skeleton className="size-11 shrink-0 rounded-xl" />
          <div className="grid min-w-0 gap-2">
            <SkeletonText className="h-5 w-44" />
            <SkeletonText className="h-3 w-64" />
          </div>
        </div>
        <div className="flex gap-2">
          <Skeleton className="size-9 rounded-lg" />
          <Skeleton className="h-9 w-28 rounded-lg" />
        </div>
      </SkeletonPanel>
      <div className="grid grid-cols-4 gap-3 max-[900px]:grid-cols-2">
        {Array.from({ length: 4 }, (_, index) => (
          <SkeletonMetricCard key={index} />
        ))}
      </div>
      <div className="flex gap-2 overflow-hidden">
        {Array.from({ length: 6 }, (_, index) => (
          <SkeletonText className="h-9 w-24 shrink-0 rounded-lg" key={index} />
        ))}
      </div>
      <SkeletonPanel>
        <SkeletonPanelHeader />
        <SkeletonListRows count={5} />
      </SkeletonPanel>
    </SkeletonPage>
  );
}

export function WorkspaceSummaryStripSkeleton() {
  return (
    <div className="grid grid-cols-4 gap-3 max-[800px]:grid-cols-2">
      {Array.from({ length: 4 }, (_, index) => (
        <SkeletonMetricCard className="min-h-[76px] py-3" key={index} />
      ))}
    </div>
  );
}

export function WorkspaceOverviewSkeleton() {
  const { tr } = useI18n();
  return (
    <SkeletonPage label={`${tr("common.loading")} ${tr("nav.overview")}`}>
      <div className="grid gap-4 lg:grid-cols-2">
        <SkeletonPanel>
          <SkeletonPanelHeader />
          <SkeletonListRows count={5} compact />
        </SkeletonPanel>
        <SkeletonPanel>
          <SkeletonPanelHeader />
          <SkeletonListRows count={5} compact />
        </SkeletonPanel>
      </div>
      <SkeletonPanel>
        <SkeletonPanelHeader />
        <SkeletonListRows count={4} compact />
      </SkeletonPanel>
    </SkeletonPage>
  );
}

export function WorkspaceAssetsSkeleton() {
  const { tr } = useI18n();
  return (
    <SkeletonPage label={`${tr("common.loading")} ${tr("nav.assets")}`}>
      <SkeletonToolbar />
      <SkeletonPanel>
        <div className="border-b border-border/70 px-4 py-3">
          <div className="flex gap-2">
            {Array.from({ length: 4 }, (_, index) => (
              <SkeletonText className="h-9 w-24 rounded-lg" key={index} />
            ))}
          </div>
        </div>
        <SkeletonListRows count={5} />
      </SkeletonPanel>
    </SkeletonPage>
  );
}

export function WorkspaceChangesSkeleton() {
  const { tr } = useI18n();
  return (
    <SkeletonPage label={`${tr("common.loading")} ${tr("nav.changes")}`}>
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(240px,.35fr)_minmax(0,1fr)]">
        <SkeletonPanel>
          <SkeletonPanelHeader />
          <SkeletonListRows count={5} compact />
        </SkeletonPanel>
        <SkeletonPanel className="min-h-[360px]">
          <SkeletonPanelHeader />
          <div className="grid gap-2 p-5">
            {Array.from({ length: 10 }, (_, index) => (
              <SkeletonText className="h-3 w-full" key={index} />
            ))}
          </div>
        </SkeletonPanel>
      </div>
    </SkeletonPage>
  );
}

export function WorkspaceContextSkeleton() {
  const { tr } = useI18n();
  return (
    <SkeletonPage label={`${tr("common.loading")} ${tr("nav.context")}`}>
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(260px,.35fr)_minmax(0,1fr)]">
        <SkeletonPanel>
          <SkeletonPanelHeader />
          <div className="grid gap-4 p-4">
            <Skeleton className="h-10 w-full rounded-lg" />
            <Skeleton className="h-10 w-full rounded-lg" />
            <Skeleton className="h-9 w-24 rounded-lg" />
            <SkeletonListRows count={3} compact />
          </div>
        </SkeletonPanel>
        <SkeletonPanel className="min-h-[420px]">
          <SkeletonPanelHeader />
          <div className="grid gap-3 p-5">
            {Array.from({ length: 9 }, (_, index) => (
              <SkeletonText className="h-3 w-full" key={index} />
            ))}
          </div>
        </SkeletonPanel>
      </div>
    </SkeletonPage>
  );
}

export function WorkspaceGitSkeleton() {
  const { tr } = useI18n();
  return (
    <SkeletonPage label={`${tr("common.loading")} ${tr("nav.git")}`}>
      <SkeletonToolbar />
      <SkeletonTable rows={5} columns={4} />
    </SkeletonPage>
  );
}

export function WorkspaceSessionsSkeleton() {
  const { tr } = useI18n();
  return (
    <SkeletonPage label={`${tr("common.loading")} ${tr("nav.sessions")}`}>
      <SkeletonPanel>
        <SkeletonPanelHeader />
        <SkeletonListRows count={5} />
      </SkeletonPanel>
    </SkeletonPage>
  );
}

export function WorkspaceDoctorSkeleton() {
  const { tr } = useI18n();
  return (
    <SkeletonPage label={`${tr("common.loading")} ${tr("nav.doctor")}`}>
      <SkeletonPanel>
        <SkeletonPanelHeader />
        <SkeletonListRows count={4} />
      </SkeletonPanel>
    </SkeletonPage>
  );
}

export function WorkspaceStorageSkeleton() {
  const { tr } = useI18n();
  return (
    <SkeletonPage label={`${tr("common.loading")} ${tr("storage.allocated")}`}>
      <SkeletonToolbar />
      <SkeletonPanel>
        <SkeletonPanelHeader />
        <SkeletonListRows count={5} />
      </SkeletonPanel>
    </SkeletonPage>
  );
}

export function WorkspacesSkeleton({ view }: { view: "list" | "storage" }) {
  const { tr } = useI18n();
  return view === "storage" ? (
    <WorkspaceStorageSkeleton />
  ) : (
    <SkeletonPage className="pb-8" label={`${tr("common.loading")} ${tr("nav.workspaces")}`}>
      <SkeletonToolbar />
      <SkeletonTable rows={5} columns={4} />
    </SkeletonPage>
  );
}
