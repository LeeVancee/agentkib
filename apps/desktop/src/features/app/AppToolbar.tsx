import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatShortcut, getShortcutDefinition } from "@/core/keyboard-shortcuts";
import { tr } from "@/core/i18n";
import { CircleHelp, MoreHorizontal, RefreshCw, Search } from "lucide-react";

export function AppToolbar({
  breadcrumb,
  onOpenSearch,
  onRefresh,
  onOpenHelp,
}: {
  breadcrumb: string[];
  onOpenSearch: () => void;
  onRefresh: () => void;
  onOpenHelp: () => void;
}) {
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
        <Button
          variant="bare"
          size="content"
          className="app-toolbar-search"
          type="button"
          onClick={onOpenSearch}
        >
          <Search size={14} />
          <span>{tr("search.open")}</span>
          <kbd>{formatShortcut(getShortcutDefinition("open-search"))}</kbd>
        </Button>
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
