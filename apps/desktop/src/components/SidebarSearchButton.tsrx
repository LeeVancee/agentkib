/** @jsxImportSource octane */

import { useTranslation } from "@octanejs/i18next";
import { Search } from "@octanejs/lucide";
import { Button } from "@/components/ui/button.tsrx";
import {
  ariaShortcut,
  currentAppPlatform,
  formatShortcut,
  getShortcutDefinition,
} from "@/core/keyboard-shortcuts";
import { cn } from "@/lib/utils";

export function SidebarSearchButton({
  onOpenSearch,
  className,
}: {
  onOpenSearch: () => void;
  className?: string;
}) {
  const { t: tr } = useTranslation();
  const shortcut = getShortcutDefinition("open-search");
  return (
    <Button
      variant="bare"
      size="content"
      type="button"
      data-global-search-trigger
      className={cn("sidebar-search-button", className)}
      aria-label={tr("search.open")}
      aria-keyshortcuts={ariaShortcut(shortcut, currentAppPlatform())}
      title={`${tr("search.open")} (${formatShortcut(shortcut)})`}
      onClick={onOpenSearch}
    >
      <Search size={18} aria-hidden="true" />
    </Button>
  );
}
