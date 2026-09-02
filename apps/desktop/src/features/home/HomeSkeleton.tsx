/** @jsxImportSource octane */

import {
  SkeletonListRows,
  SkeletonMetricCard,
  SkeletonPage,
  SkeletonPanel,
  SkeletonPanelHeader,
  SkeletonText,
} from "@/components/ui/skeleton-layouts";
import { Skeleton } from "@/components/ui/skeleton";

export function HomeSkeleton() {
  return (
    <SkeletonPage className="pb-8" label="Loading home">
      <div className="grid grid-cols-4 gap-3 max-[800px]:grid-cols-2">
        {Array.from({ length: 4 }, (_, index) => (
          <SkeletonMetricCard key={index} />
        ))}
      </div>
      <SkeletonPanel className="border-amber-500/20 bg-amber-500/[0.045] shadow-none">
        <div className="flex items-center justify-between border-b border-amber-500/15 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <div className="size-4 rounded-full bg-amber-500/15" />
            <SkeletonText className="h-4 w-32" />
          </div>
          <Skeleton className="h-6 w-7 rounded-full" />
        </div>
        <SkeletonListRows count={3} className="divide-amber-500/15" />
      </SkeletonPanel>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.55fr)_minmax(300px,.85fr)]">
        <SkeletonPanel>
          <SkeletonPanelHeader />
          <SkeletonListRows count={5} />
        </SkeletonPanel>
        <SkeletonPanel>
          <SkeletonPanelHeader />
          <SkeletonListRows count={5} compact />
        </SkeletonPanel>
      </div>
    </SkeletonPage>
  );
}
