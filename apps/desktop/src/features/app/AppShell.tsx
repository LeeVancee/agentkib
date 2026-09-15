/** @jsxImportSource octane */

import { useI18n } from "@/core/useI18n";
import type { CSSProperties, ReactNode } from "octane";
import { SidebarResizeHandle } from "./SidebarResizeHandle";
import { MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, useSidebarWidthStore } from "./sidebar-width-store";

import type { Renderable } from "@/lib/octane-types";

import { useLocation } from "@octanejs/tanstack-router";
import { Button } from "@/components/ui/button";
import { WindowToolbar } from "@/components/WindowToolbar";
import { ariaShortcut, currentAppPlatform, getShortcutDefinition } from "@/core/keyboard-shortcuts";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app-store";
import {
  clearSidebarPeekCloseTimer,
  scheduleSidebarPeekClose as scheduleSidebarPeekCloseTimer,
} from "./sidebar-peek";
import { ArrowLeft, ArrowRight, PanelLeftClose, PanelLeftOpen } from "@octanejs/lucide";
import { useEffect, useLayoutEffect, useRef, useState } from "octane";

const mainClassName =
  "app-shell-main !flex !min-h-0 !min-w-0 !h-full !flex-col !overflow-hidden !text-sm";

export function WindowNavigationControls({
  canGoBack = false,
  canGoForward = false,
  onBack,
  onForward,
}: {
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
        className="app-sidebar-collapse-button"
        type="button"
        aria-label={tr(sidebarCollapsed ? "common.expandSidebar" : "common.collapseSidebar")}
        aria-keyshortcuts={ariaShortcut(getShortcutDefinition("toggle-sidebar"), platform)}
        aria-expanded={!sidebarCollapsed}
        data-collapsed={sidebarCollapsed}
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
        className="app-history-button"
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
        className="app-history-button"
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

export function AppShellHeader({ children }: { children?: Renderable }) {
  return <div className="app-shell-header">{children}</div>;
}

export function AppShell({
  sidebar,
  sidebarMode = "primary",
  children,
  toolbar,
  headerless = false,
  mainClassName: additionalMainClassName,
  canGoBack = false,
  canGoForward = false,
  onBack,
  onForward,
}: {
  sidebar: Renderable;
  sidebarMode?: "primary" | "settings";
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
    Math.min(MAX_SIDEBAR_WIDTH, windowWidth - 640),
  );
  const visibleSidebarWidth = Math.min(sidebarWidth.width, maxSidebarWidth);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const previousSidebarMode = useRef(sidebarMode);
  const [sidebarMotion, setSidebarMotion] = useState<"to-primary" | "to-settings" | null>(null);

  useLayoutEffect(() => {
    if (previousSidebarMode.current === sidebarMode) return;
    previousSidebarMode.current = sidebarMode;
    const motion = sidebarMode === "settings" ? "to-settings" : "to-primary";
    const startTimeout = window.setTimeout(() => setSidebarMotion(motion), 0);
    const clearTimeout = window.setTimeout(() => setSidebarMotion(null), 280);
    return () => {
      window.clearTimeout(startTimeout);
      window.clearTimeout(clearTimeout);
    };
  }, [sidebarMode]);

  useEffect(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = 0;
    }
  }, [locationKey]);

  useEffect(() => {
    if (!sidebarCollapsed && sidebarPeek) {
      const timeout = window.setTimeout(() => setSidebarPeek(false), 0);
      return () => window.clearTimeout(timeout);
    }
  }, [sidebarCollapsed, sidebarPeek, setSidebarPeek]);

  const revealSidebar = () => {
    if (!sidebarCollapsed) return;
    clearSidebarPeekCloseTimer();
    setSidebarPeek(true);
  };

  const scheduleSidebarPeekClose = () => {
    if (!sidebarCollapsed) return;
    scheduleSidebarPeekCloseTimer(setSidebarPeek);
  };

  return (
    <div
      style={{ "--sidebar-expanded-width": `${visibleSidebarWidth}px` } as CSSProperties}
      className={cn(
        "group app-shell !grid !h-full !w-full !min-h-0 !overflow-hidden",
        headerless && "app-shell-headerless",
        sidebarCollapsed && "app-shell-sidebar-collapsed",
        sidebarWidth.dragging && "app-shell-sidebar-resizing",
        sidebarMotion && `app-shell-sidebar-motion-${sidebarMotion}`,
      )}
    >
      <div
        className="app-sidebar-hover-trigger"
        aria-hidden="true"
        onPointerEnter={revealSidebar}
        onPointerLeave={scheduleSidebarPeekClose}
      />
      <WindowToolbar />
      <WindowNavigationControls
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        onBack={onBack}
        onForward={onForward}
      />
      {!headerless && <AppShellHeader>{toolbar}</AppShellHeader>}
      {sidebar}
      {!sidebarCollapsed && windowWidth >= 1024 && (
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
