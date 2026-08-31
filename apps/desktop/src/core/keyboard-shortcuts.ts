import { normalizePlatform, type AppPlatform } from "./platform";

export type ShortcutId =
  | "navigate-home"
  | "navigate-workspaces"
  | "navigate-catalog"
  | "navigate-agents"
  | "navigate-quota"
  | "navigate-insights"
  | "open-settings"
  | "refresh-current"
  | "add-workspace"
  | "add-scan-root"
  | "toggle-sidebar"
  | "open-search"
  | "open-help";

export type ShortcutGroup = "navigation" | "actions";

export interface ShortcutDefinition {
  id: ShortcutId;
  key: string;
  labelKey: string;
  group: ShortcutGroup;
  shift?: boolean;
  nativeMac?: boolean;
}

export const shortcutDefinitions: readonly ShortcutDefinition[] = [
  { id: "navigate-home", key: "1", labelKey: "nav.home", group: "navigation", nativeMac: true },
  {
    id: "navigate-workspaces",
    key: "2",
    labelKey: "nav.workspaces",
    group: "navigation",
    nativeMac: true,
  },
  {
    id: "navigate-catalog",
    key: "3",
    labelKey: "nav.assets",
    group: "navigation",
    nativeMac: true,
  },
  { id: "navigate-agents", key: "4", labelKey: "nav.agents", group: "navigation", nativeMac: true },
  { id: "navigate-quota", key: "5", labelKey: "nav.quota", group: "navigation", nativeMac: true },
  {
    id: "navigate-insights",
    key: "6",
    labelKey: "nav.insights",
    group: "navigation",
    nativeMac: true,
  },
  {
    id: "open-settings",
    key: ",",
    labelKey: "menu.settings",
    group: "navigation",
    nativeMac: true,
  },
  {
    id: "refresh-current",
    key: "r",
    labelKey: "menu.refreshCurrent",
    group: "actions",
    nativeMac: true,
  },
  {
    id: "add-workspace",
    key: "o",
    labelKey: "menu.addWorkspace",
    group: "actions",
    nativeMac: true,
  },
  {
    id: "add-scan-root",
    key: "o",
    labelKey: "menu.addScanRoot",
    group: "actions",
    shift: true,
    nativeMac: true,
  },
  {
    id: "toggle-sidebar",
    key: "b",
    labelKey: "shortcuts.toggleSidebar",
    group: "actions",
  },
  {
    id: "open-search",
    key: "k",
    labelKey: "search.open",
    group: "actions",
  },
  {
    id: "open-help",
    key: "/",
    labelKey: "shortcuts.openHelp",
    group: "actions",
  },
];

const shortcutById = new Map(shortcutDefinitions.map((definition) => [definition.id, definition]));

export function getShortcutDefinition(id: ShortcutId): ShortcutDefinition {
  const definition = shortcutById.get(id);
  if (!definition) throw new Error(`Unknown shortcut: ${id}`);
  return definition;
}

export function shortcutsForGroup(group: ShortcutGroup): ShortcutDefinition[] {
  return shortcutDefinitions.filter((definition) => definition.group === group);
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object") return false;
  const element = target as HTMLElement;
  if (element.isContentEditable) return true;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)) return true;
  return (
    typeof element.closest === "function" && Boolean(element.closest('[contenteditable="true"]'))
  );
}

export function matchesShortcut(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
  definition: ShortcutDefinition,
  platform: AppPlatform = currentAppPlatform(),
): boolean {
  const primaryPressed =
    platform === "macos" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!primaryPressed || event.altKey || event.shiftKey !== Boolean(definition.shift)) return false;
  return event.key.toLowerCase() === definition.key.toLowerCase();
}

export function formatShortcut(
  definition: ShortcutDefinition,
  platform: AppPlatform = currentAppPlatform(),
): string {
  const primary = platform === "macos" ? "⌘" : "Ctrl+";
  const shift = definition.shift ? "Shift+" : "";
  return `${primary}${shift}${definition.key.length === 1 ? definition.key.toUpperCase() : definition.key}`;
}

export function ariaShortcut(
  definition: ShortcutDefinition,
  platform: AppPlatform = currentAppPlatform(),
): string {
  const primary = platform === "macos" ? "Meta" : "Control";
  const shift = definition.shift ? "Shift+" : "";
  return `${primary}+${shift}${definition.key.toUpperCase()}`;
}

export function currentAppPlatform(): AppPlatform {
  const rootPlatform = document.documentElement.dataset.platform;
  return normalizePlatform(rootPlatform);
}

export function shouldHandleInFrontend(
  definition: ShortcutDefinition,
  platform: AppPlatform = currentAppPlatform(),
): boolean {
  return platform !== "macos" || !definition.nativeMac;
}
