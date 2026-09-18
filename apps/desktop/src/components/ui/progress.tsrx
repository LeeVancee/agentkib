/** @jsxImportSource octane */

import type { DivProps } from "@/lib/octane-types";
import { cn } from "@/lib/utils";
function Progress({ className, value = 0, ...props }: DivProps & { value?: number }) {
  const progress = Math.min(100, Math.max(0, value));
  return (
    <div
      data-slot="progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progress}
      className={cn("relative h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}
      {...props}
    >
      <div
        data-slot="progress-indicator"
        className="h-full rounded-full bg-primary transition-[width] duration-200"
        style={{ width: `${progress}%` }}
      />
    </div>
  );
}
export { Progress };
