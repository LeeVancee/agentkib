import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { WindowToolbar } from "@/components/WindowToolbar";
import {
  ariaShortcut,
  currentAppPlatform,
  getShortcutDefinition,
} from "@/core/keyboard-shortcuts";
import { tr } from "@/core/i18n";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app-store";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";

const mainClassName =
  "app-shell-main !col-start-2 !row-start-3 !flex !min-h-0 !min-w-0 !h-full !flex-col !overflow-hidden !text-sm";

export function AppShellHeader() {
  const sidebarCollapsed = useAppStore((state) => state.sidebarCollapsed);
  const setSidebarCollapsed = useAppStore((state) => state.setSidebarCollapsed);
  const platform = currentAppPlatform();

  return (
    <div className="app-shell-header">
      <Button
        variant="bare"
        size="content"
        className="app-sidebar-collapse-button"
        type="button"
        aria-label={tr(sidebarCollapsed ? "common.expandSidebar" : "common.collapseSidebar")}
        aria-keyshortcuts={ariaShortcut(getShortcutDefinition("toggle-sidebar"), platform)}
        aria-expanded={!sidebarCollapsed}
        data-collapsed={sidebarCollapsed}
        title={tr(sidebarCollapsed ? "common.expandSidebar" : "common.collapseSidebar")}
        onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
      >
        <span className="app-sidebar-collapse-icon" aria-hidden="true">
          <PanelLeftClose
            className={cn("app-sidebar-collapse-icon-close", sidebarCollapsed && "is-hidden")}
            size={17}
          />
          <PanelLeftOpen
            className={cn("app-sidebar-collapse-icon-open", !sidebarCollapsed && "is-hidden")}
            size={17}
          />
        </span>
      </Button>
    </div>
  );
}

export function AppShell({
  sidebar,
  children,
  mainClassName: additionalMainClassName,
}: {
  sidebar: ReactNode;
  children: ReactNode;
  mainClassName?: string;
}) {
  const sidebarCollapsed = useAppStore((state) => state.sidebarCollapsed);

  return (
    <div
      className={cn(
        "group app-shell !grid !h-full !w-full !min-h-0 !overflow-hidden",
        sidebarCollapsed && "app-shell-sidebar-collapsed",
      )}
    >
      <WindowToolbar />
      <AppShellHeader />
      {sidebar}
      <main className={cn(mainClassName, additionalMainClassName)}>
        <div className="page-scroll-container min-h-0 flex-1">
          {children}
        </div>
      </main>
    </div>
  );
}
