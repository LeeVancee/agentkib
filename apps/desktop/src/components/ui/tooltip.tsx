/** @jsxImportSource octane */

import { Tooltip } from "@octanejs/base-ui/tooltip";
import type { Renderable } from "@/lib/octane-types";
export function SidebarTooltip({
  label,
  children,
  side = "right",
}: {
  label: string;
  children: Renderable;
  side?: "top" | "right" | "bottom" | "left";
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={children} aria-label={label} />
      <Tooltip.Portal>
        <Tooltip.Positioner side={side} sideOffset={8}>
          <Tooltip.Popup className="z-[100] rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs font-medium text-popover-foreground shadow-lg">
            {label}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
