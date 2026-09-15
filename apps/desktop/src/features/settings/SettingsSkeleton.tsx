/** @jsxImportSource octane */

import {
  SkeletonListRows,
  SkeletonPage,
  SkeletonPanel,
  SkeletonPanelHeader,
  SkeletonText,
} from "@/components/ui/skeleton-layouts";
import { SettingsPage, type SettingsPageVariant } from "./components/SettingsLayout";

export function SettingsSkeleton() {
  return (
    <SkeletonPage className="grid-cols-[180px_minmax(0,1fr)] gap-5 p-5" labelKey="loading.settings">
      <SkeletonPanel className="h-fit p-3">
        <div className="grid gap-2">
          {Array.from({ length: 7 }, (_, index) => (
            <SkeletonText className="h-9 w-full rounded-lg" key={index} />
          ))}
        </div>
      </SkeletonPanel>
      <SkeletonPanel>
        <SkeletonPanelHeader />
        <div className="p-5">
          <SkeletonListRows count={5} compact />
        </div>
      </SkeletonPanel>
    </SkeletonPage>
  );
}

export function SettingsContentSkeleton({ variant = "form" }: { variant?: SettingsPageVariant }) {
  return (
    <SettingsPage variant={variant}>
      <SkeletonPage labelKey="loading.settings">
        <SkeletonPanel className="rounded-xl shadow-none">
          <SkeletonPanelHeader />
          <div className="p-5">
            <SkeletonListRows count={5} compact />
          </div>
        </SkeletonPanel>
      </SkeletonPage>
    </SettingsPage>
  );
}
