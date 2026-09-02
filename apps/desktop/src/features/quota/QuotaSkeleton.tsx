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

export function QuotaSkeleton() {
  return (
    <SkeletonPage className="pb-8" label="Loading quota">
      <SkeletonPanel className="p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-10 min-w-[220px] flex-1 rounded-xl" />
          {Array.from({ length: 4 }, (_, index) => (
            <SkeletonText className="h-9 w-20 rounded-lg" key={index} />
          ))}
          <Skeleton className="size-10 rounded-xl" />
        </div>
      </SkeletonPanel>
      <div className="grid grid-cols-4 gap-3 max-[900px]:grid-cols-2">
        {Array.from({ length: 4 }, (_, index) => (
          <SkeletonMetricCard key={index} />
        ))}
      </div>
      <SkeletonPanel>
        <SkeletonPanelHeader />
        <SkeletonListRows count={5} />
      </SkeletonPanel>
    </SkeletonPage>
  );
}
