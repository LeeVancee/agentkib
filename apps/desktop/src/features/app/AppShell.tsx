import type { ReactNode } from "react";

import { useLocation } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { WindowToolbar } from "@/components/WindowToolbar";
import { ariaShortcut, currentAppPlatform, getShortcutDefinition } from "@/core/keyboard-shortcuts";
import { tr } from "@/core/i18n";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app-store";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

const mainClassName =
  "app-shell-main !col-start-2 !row-start-3 !flex !min-h-0 !min-w-0 !h-full !flex-col !overflow-hidden !text-sm";

export function AppShellHeader({ children }: { children?: ReactNode }) {
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
      {children}
    </div>
  );
}

export function AppShell({
  sidebar,
  sidebarMode = "primary",
  children,
  toolbar,
  mainClassName: additionalMainClassName,
}: {
  sidebar: ReactNode;
  sidebarMode?: "primary" | "settings";
  children: ReactNode;
  toolbar?: ReactNode;
  mainClassName?: string;
}) {
  const sidebarCollapsed = useAppStore((state) => state.sidebarCollapsed);
  const locationKey = useLocation({ select: (location) => location.href });
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const previousSidebarMode = useRef(sidebarMode);
  const [sidebarMotion, setSidebarMotion] = useState<"to-primary" | "to-settings" | null>(null);

  useLayoutEffect(() => {
    if (previousSidebarMode.current === sidebarMode) return;
    previousSidebarMode.current = sidebarMode;
    setSidebarMotion(sidebarMode === "settings" ? "to-settings" : "to-primary");

    const timeout = window.setTimeout(() => setSidebarMotion(null), 280);
    return () => window.clearTimeout(timeout);
  }, [sidebarMode]);

  useEffect(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = 0;
    }
  }, [locationKey]);

  return (
    <div
      className={cn(
        "group app-shell !grid !h-full !w-full !min-h-0 !overflow-hidden",
        sidebarCollapsed && "app-shell-sidebar-collapsed",
        sidebarMotion && `app-shell-sidebar-motion-${sidebarMotion}`,
      )}
    >
      <WindowToolbar />
      <AppShellHeader>{toolbar}</AppShellHeader>
      {sidebar}
      <main className={cn(mainClassName, additionalMainClassName)}>
        <div ref={scrollContainerRef} className="page-scroll-container min-h-0 flex-1">
          {children}
        </div>
      </main>
    </div>
  );
}
