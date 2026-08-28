import { useEffect, useRef } from "react";
import type { GlobalPage } from "./app-route";
import {
  currentAppPlatform,
  isEditableTarget,
  matchesShortcut,
  shouldHandleInFrontend,
  shortcutDefinitions,
  type ShortcutId,
} from "@/core/keyboard-shortcuts";

export interface AppShortcutActions {
  onNavigate: (page: GlobalPage) => void;
  onOpenSettings: () => void;
  onRefreshCurrent: () => Promise<void>;
  onAddWorkspace: () => Promise<void>;
  onAddScanRoot: () => Promise<void>;
  onToggleSidebar: () => void;
  onOpenHelp: () => void;
  helpOpen: boolean;
}

const navigationByShortcut: Partial<Record<ShortcutId, GlobalPage>> = {
  "navigate-home": "home",
  "navigate-workspaces": "workspaces",
  "navigate-catalog": "catalog",
  "navigate-agents": "agents",
  "navigate-quota": "quota",
  "navigate-insights": "insights",
};

export function useAppShortcuts({
  onNavigate,
  onOpenSettings,
  onRefreshCurrent,
  onAddWorkspace,
  onAddScanRoot,
  onToggleSidebar,
  onOpenHelp,
  helpOpen,
}: AppShortcutActions) {
  const actionsRef = useRef<AppShortcutActions>({
    onNavigate,
    onOpenSettings,
    onRefreshCurrent,
    onAddWorkspace,
    onAddScanRoot,
    onToggleSidebar,
    onOpenHelp,
    helpOpen,
  });
  actionsRef.current = {
    onNavigate,
    onOpenSettings,
    onRefreshCurrent,
    onAddWorkspace,
    onAddScanRoot,
    onToggleSidebar,
    onOpenHelp,
    helpOpen,
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const actions = actionsRef.current;
      if (event.defaultPrevented || event.isComposing || event.repeat || actions.helpOpen) return;
      if (isEditableTarget(event.target)) return;
      const platform = currentAppPlatform();
      const definition = shortcutDefinitions.find(
        (candidate) =>
          shouldHandleInFrontend(candidate, platform) && matchesShortcut(event, candidate, platform),
      );
      if (!definition) return;

      event.preventDefault();
      const page = navigationByShortcut[definition.id];
      if (page) {
        actions.onNavigate(page);
        return;
      }
      switch (definition.id) {
        case "open-settings":
          actions.onOpenSettings();
          break;
        case "refresh-current":
          void actions.onRefreshCurrent();
          break;
        case "add-workspace":
          void actions.onAddWorkspace();
          break;
        case "add-scan-root":
          void actions.onAddScanRoot();
          break;
        case "toggle-sidebar":
          actions.onToggleSidebar();
          break;
        case "open-help":
          actions.onOpenHelp();
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
