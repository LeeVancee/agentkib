import { useI18n } from "@/core/useI18n";
import type { CSSProperties, ReactNode } from "react";
import { useRetainedScroll } from "./useRetainedScroll";
import { SidebarResizeHandle } from "./SidebarResizeHandle";
import { MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, useSidebarWidthStore } from "./sidebar-width-store";

import { useLocation } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { WindowToolbar } from "@/components/WindowToolbar";
import { ariaShortcut, currentAppPlatform, getShortcutDefinition } from "@/core/keyboard-shortcuts";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app-store";
import { ArrowLeft, ArrowRight, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

const mainClassName =
  "app-shell-main !flex !min-h-0 !min-w-0 !h-full !flex-col !overflow-hidden !text-sm";

export function WindowNavigationControls({
  canGoBack = false,
  canGoForward = false,
  onBack,
  onForward,
  hasSidebarPanel = true,
}: {
  hasSidebarPanel?: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onBack?: () => void;
  onForward?: () => void;
}) {
  const { tr } = useI18n();
  const sidebarCollapsed = useAppStore((state) => state.sidebarCollapsed);
  const setSidebarCollapsed = useAppStore((state) => state.setSidebarCollapsed);
  const setSidebarPeek = useAppStore((state) => state.setSidebarPeek);
  const platform = currentAppPlatform();
  const backShortcut = getShortcutDefinition("history-back");
  const forwardShortcut = getShortcutDefinition("history-forward");

  return (
    <div className="app-window-navigation-controls">
      <Button
        variant="bare"
        size="content"
        className="app-sidebar-collapse-button max-lg:hidden grid size-6 place-items-center border-0 bg-transparent text-[color:color-mix(in_srgb,var(--sidebar-foreground)_58%,transparent)] transition-[transform,scale,color] duration-180 ease-[cubic-bezier(0.22,1,0.36,1)] pointer-events-auto [-webkit-app-region:no-drag] hover:scale-[1.06] hover:text-sidebar-accent-foreground active:scale-[0.92] focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 motion-reduce:transition-none"
        type="button"
        aria-label={tr(sidebarCollapsed ? "common.expandSidebar" : "common.collapseSidebar")}
        aria-keyshortcuts={ariaShortcut(getShortcutDefinition("toggle-sidebar"), platform)}
        aria-expanded={!sidebarCollapsed}
        data-collapsed={sidebarCollapsed}
        disabled={!hasSidebarPanel}
        title={tr(sidebarCollapsed ? "common.expandSidebar" : "common.collapseSidebar")}
        onClick={() => {
          setSidebarPeek(false);
          setSidebarCollapsed(!sidebarCollapsed);
        }}
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
      <Button
        variant="bare"
        size="content"
        className="app-history-button grid size-6 place-items-center text-[color:color-mix(in_srgb,var(--foreground)_58%,transparent)] transition-[transform,scale,color] duration-180 ease-[cubic-bezier(0.22,1,0.36,1)] enabled:hover:scale-[1.06] enabled:hover:text-foreground enabled:active:scale-[0.92] disabled:text-[color:color-mix(in_srgb,var(--foreground)_28%,transparent)] disabled:cursor-default focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 motion-reduce:transition-none"
        type="button"
        disabled={!canGoBack}
        aria-label={tr("shortcuts.back")}
        aria-keyshortcuts={ariaShortcut(backShortcut, platform)}
        title={tr("shortcuts.back")}
        onClick={onBack}
      >
        <ArrowLeft size={17} aria-hidden="true" />
      </Button>
      <Button
        variant="bare"
        size="content"
        className="app-history-button grid size-6 place-items-center text-[color:color-mix(in_srgb,var(--foreground)_58%,transparent)] transition-[transform,scale,color] duration-180 ease-[cubic-bezier(0.22,1,0.36,1)] enabled:hover:scale-[1.06] enabled:hover:text-foreground enabled:active:scale-[0.92] disabled:text-[color:color-mix(in_srgb,var(--foreground)_28%,transparent)] disabled:cursor-default focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 motion-reduce:transition-none"
        type="button"
        disabled={!canGoForward}
        aria-label={tr("shortcuts.forward")}
        aria-keyshortcuts={ariaShortcut(forwardShortcut, platform)}
        title={tr("shortcuts.forward")}
        onClick={onForward}
      >
        <ArrowRight size={17} aria-hidden="true" />
      </Button>
    </div>
  );
}

export function AppShellHeader({ children }: { children?: ReactNode }) {
  return <div className="app-shell-header">{children}</div>;
}

export function AppShell({
  sidebar,
  sidebarMode = "primary",
  hasSidebarPanel = true,
  children,
  toolbar,
  headerless = false,
  mainClassName: additionalMainClassName,
  canGoBack = false,
  canGoForward = false,
  onBack,
  onForward,
}: {
  sidebar: ReactNode;
  sidebarMode?: "primary" | "settings";
  hasSidebarPanel?: boolean;
  children: ReactNode;
  toolbar?: ReactNode;
  headerless?: boolean;
  mainClassName?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onBack?: () => void;
  onForward?: () => void;
}) {
  const { tr } = useI18n();
  const sidebarCollapsed = useAppStore((state) => state.sidebarCollapsed);
  const sidebarPeek = useAppStore((state) => state.sidebarPeek);
  const setSidebarPeek = useAppStore((state) => state.setSidebarPeek);
  const locationKey = useLocation({ select: (location) => location.href });
  const sidebarWidth = useSidebarWidthStore();
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const resize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const maxSidebarWidth = Math.max(
    MIN_SIDEBAR_WIDTH,
    Math.min(MAX_SIDEBAR_WIDTH, windowWidth - 640 - 52),
  );
  const visibleSidebarWidth = Math.min(sidebarWidth.width, maxSidebarWidth);
  const [scrollOffsets] = useState(() => new Map<string, number>());
  const scrollContainerRef = useRetainedScroll(locationKey, scrollOffsets);
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
    if (!sidebarCollapsed && sidebarPeek) setSidebarPeek(false);
  }, [sidebarCollapsed, sidebarPeek, setSidebarPeek]);

  return (
    <div
      style={{ "--sidebar-expanded-width": `${visibleSidebarWidth}px` } as CSSProperties}
      className={cn(
        "group app-shell !grid !h-full !w-full !min-h-0 !overflow-hidden",
        headerless && "app-shell-headerless",
        sidebarCollapsed && "app-shell-sidebar-collapsed",
        !hasSidebarPanel && "app-shell-no-context",
        sidebarWidth.dragging && "app-shell-sidebar-resizing",
        sidebarMotion && `app-shell-sidebar-motion-${sidebarMotion}`,
      )}
    >
      <WindowToolbar />
      <WindowNavigationControls
        hasSidebarPanel={hasSidebarPanel}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        onBack={onBack}
        onForward={onForward}
      />
      {!headerless && <AppShellHeader>{toolbar}</AppShellHeader>}
      {sidebar}
      {hasSidebarPanel && !sidebarCollapsed && windowWidth >= 1024 && (
        <SidebarResizeHandle width={visibleSidebarWidth} maxWidth={maxSidebarWidth} />
      )}
      {sidebarWidth.error && (
        <div className="sidebar-resize-error" role="alert">
          <span>{tr("sidebar.resizeSaveFailed")}</span>
          <Button variant="ghost" size="sm" onClick={sidebarWidth.clearError}>
            {tr("common.close")}
          </Button>
        </div>
      )}
      <main className={cn(mainClassName, additionalMainClassName)}>
        <div ref={scrollContainerRef} className="page-scroll-container min-h-0 flex-1">
          {children}
        </div>
      </main>
    </div>
  );
}
