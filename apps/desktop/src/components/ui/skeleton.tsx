/** @jsxImportSource octane */

import type { DivProps } from "@/lib/octane-types";
import { cn } from "@/lib/utils";
function Skeleton({ className, ...props }: DivProps) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-muted motion-reduce:animate-none", className)}
      aria-hidden="true"
      {...props}
    />
  );
}
export { Skeleton };
