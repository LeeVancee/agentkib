import { Children, isValidElement, type ReactNode } from "react";
import { Select, SelectContent, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";

export function McpChoice({
  value,
  onValueChange,
  disabled,
  children,
  "aria-label": label,
}: {
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  children: ReactNode;
  "aria-label"?: string;
}) {
  const chosen = Children.toArray(children).find(
    (child) => isValidElement<{ value: string }>(child) && child.props.value === value,
  );
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null) onValueChange(String(next));
      }}
    >
      <SelectTrigger aria-label={label}>
        <SelectValue>
          {isValidElement<{ children: ReactNode }>(chosen) ? chosen.props.children : value}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>{children}</SelectContent>
    </Select>
  );
}
export function McpDisclosure({
  title,
  children,
  className,
  defaultOpen,
}: {
  title: ReactNode;
  children: ReactNode;
  className?: string;
  defaultOpen?: boolean;
}) {
  return (
    <Collapsible className={className} defaultOpen={defaultOpen}>
      <CollapsibleTrigger render={<Button variant="outline" className="w-full justify-start" />}>
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent className="grid gap-4 pt-3">{children}</CollapsibleContent>
    </Collapsible>
  );
}
