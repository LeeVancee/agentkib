/** @jsxImportSource octane */

import type { DivProps } from "@/lib/octane-types";
import { cn } from "@/lib/utils";
function Separator({
  className,
  orientation = "horizontal",
  ...props
}: DivProps & { orientation?: "horizontal" | "vertical" }) {
  return (
    <div
      data-slot="separator"
      data-orientation={orientation}
      role="separator"
      className={cn(
        "shrink-0 bg-border-subtle",
        orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
        className,
      )}
      {...props}
    />
  );
}
export { Separator };
