/** @jsxImportSource octane */

import {
  SkeletonListRows,
  SkeletonPage,
  SkeletonPanel,
  SkeletonPanelHeader,
  SkeletonText,
  SkeletonToolbar,
} from "@/components/ui/skeleton-layouts";

export function CatalogSkeleton() {
  return (
    <SkeletonPage className="pb-8" label="Loading assets">
      <SkeletonToolbar />
      <SkeletonPanel>
        <div className="border-b border-border/70 px-4 py-3">
          <div className="flex gap-2">
            {Array.from({ length: 4 }, (_, index) => (
              <SkeletonText className="h-9 w-24 rounded-lg" key={index} />
            ))}
          </div>
        </div>
        <SkeletonPanelHeader />
        <SkeletonListRows count={5} />
      </SkeletonPanel>
    </SkeletonPage>
  );
}
