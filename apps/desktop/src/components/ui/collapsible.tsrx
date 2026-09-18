/** @jsxImportSource octane */

import type { PropsOf } from "@/lib/octane-types";
import { Collapsible as CollapsiblePrimitive } from "@octanejs/base-ui/collapsible";
function Collapsible({ ...props }: PropsOf<typeof CollapsiblePrimitive.Root>) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}
function CollapsibleTrigger({ ...props }: PropsOf<typeof CollapsiblePrimitive.Trigger>) {
  return <CollapsiblePrimitive.Trigger data-slot="collapsible-trigger" {...props} />;
}
function CollapsibleContent({ ...props }: PropsOf<typeof CollapsiblePrimitive.Panel>) {
  return <CollapsiblePrimitive.Panel data-slot="collapsible-content" {...props} />;
}
export { Collapsible, CollapsibleTrigger, CollapsibleContent };
