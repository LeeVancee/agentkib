/** @jsxImportSource octane */

import {
  SkeletonListRows,
  SkeletonPage,
  SkeletonPanel,
  SkeletonPanelHeader,
} from "@/components/ui/skeleton-layouts";

export function AgentsSkeleton() {
  return (
    <SkeletonPage className="pb-8" label="Loading agents">
      <SkeletonPanel>
        <SkeletonPanelHeader />
        <SkeletonListRows count={2} />
      </SkeletonPanel>
      <SkeletonPanel>
        <SkeletonPanelHeader />
        <SkeletonListRows count={5} />
      </SkeletonPanel>
    </SkeletonPage>
  );
}
