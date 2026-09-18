/** @jsxImportSource octane */

import { useI18n } from "@/core/useI18n";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsrx";
import { formatShortcut, getShortcutDefinition } from "@/core/keyboard-shortcuts";
import { CircleHelp, MoreHorizontal, RefreshCw } from "@octanejs/lucide";

export function AppToolbar({
  breadcrumb,
  onRefresh,
  onOpenHelp,
}: {
  breadcrumb: string[];
  onRefresh: () => void;
  onOpenHelp: () => void;
}) {
  const { tr } = useI18n();
  return (
    <div className="app-toolbar-content">
      <div className="app-toolbar-breadcrumb" aria-label={tr("common.breadcrumb")}>
        {breadcrumb.map((part, index) => (
          <span key={part + "-" + index}>
            {index > 0 ? <em>/</em> : null}
            <span>{part}</span>
          </span>
        ))}
      </div>
      <div className="app-toolbar-actions">
        <DropdownMenu>
          <DropdownMenuTrigger
            className="app-toolbar-more"
            aria-label={tr("common.moreActions")}
            title={tr("common.moreActions")}
          >
            <MoreHorizontal size={17} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-52">
            <DropdownMenuItem onClick={onRefresh}>
              <RefreshCw size={15} />
              {tr("menu.refreshCurrent")}
              <DropdownMenuShortcut>
                {formatShortcut(getShortcutDefinition("refresh-current"))}
              </DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onOpenHelp}>
              <CircleHelp size={15} />
              {tr("shortcuts.openHelp")}
              <DropdownMenuShortcut>
                {formatShortcut(getShortcutDefinition("open-help"))}
              </DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
