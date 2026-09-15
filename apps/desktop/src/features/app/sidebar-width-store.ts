import { create } from "@octanejs/zustand";
import { api } from "@/core/api";
import { localizeMessage } from "@/core/i18n";
import { useAppStore } from "@/stores/app-store";
import type { RuntimeInfo } from "@/core/types";

export const DEFAULT_SIDEBAR_WIDTH = 250;
export const MIN_SIDEBAR_WIDTH = 250;
export const MAX_SIDEBAR_WIDTH = 400;

export function clampSidebarWidth(value: number) {
  return Number.isFinite(value)
    ? Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(value)))
    : DEFAULT_SIDEBAR_WIDTH;
}

function storedWidth(value: unknown) {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_SIDEBAR_WIDTH &&
    value <= MAX_SIDEBAR_WIDTH
    ? value
    : DEFAULT_SIDEBAR_WIDTH;
}

interface SidebarWidthState {
  width: number;
  savedWidth: number;
  hydrated: boolean;
  dragging: boolean;
  saving: boolean;
  revision: number;
  error: string;
  hydrate: (value: unknown, revision: number) => void;
  beginResize: () => boolean;
  preview: (width: number) => void;
  cancelResize: () => void;
  save: (width: number) => Promise<void>;
  clearError: () => void;
}

// Kept outside the route tree: navigation cannot discard an in-flight save.
// preferences.json is authoritative; there is no Chromium-only width preference.
export const useSidebarWidthStore = create<SidebarWidthState>((set, get) => ({
  width: DEFAULT_SIDEBAR_WIDTH,
  savedWidth: DEFAULT_SIDEBAR_WIDTH,
  hydrated: false,
  dragging: false,
  saving: false,
  revision: 0,
  error: "",
  hydrate: (value, revision) => {
    const state = get();
    if (state.revision !== revision || state.saving || state.dragging) return;
    const width = storedWidth(value);
    set({ width, savedWidth: width, hydrated: true });
  },
  beginResize: () => {
    const state = get();
    if (!state.hydrated || state.saving || state.dragging) return false;
    set({ dragging: true, revision: state.revision + 1, error: "" });
    return true;
  },
  preview: (width) => {
    if (get().dragging) set({ width: clampSidebarWidth(width) });
  },
  cancelResize: () => {
    if (get().dragging)
      set((state) => ({
        dragging: false,
        width: state.savedWidth,
        revision: state.revision + 1,
      }));
  },
  save: async (value) => {
    const state = get();
    if (!state.hydrated || state.saving) return;
    const width = clampSidebarWidth(value);
    set({ dragging: false, width, revision: state.revision + 1, error: "" });
    if (width === state.savedWidth) return;
    set({ saving: true });
    try {
      const runtime = await api.setSidebarWidthPreference(width);
      if (runtime.sidebar_width_preference !== width)
        throw new Error("Sidebar width was not saved");
      set({ width, savedWidth: width });
      useAppStore
        .getState()
        .setRuntime((current) =>
          current ? { ...current, sidebar_width_preference: width } : current,
        );
    } catch (error) {
      set({ width: state.savedWidth, error: localizeMessage(error) });
    } finally {
      set((current) => ({ saving: false, revision: current.revision + 1 }));
    }
  },
  clearError: () => set({ error: "" }),
}));

export function synchronizeSidebarWidth(runtime: RuntimeInfo, revision: number): RuntimeInfo {
  const state = useSidebarWidthStore.getState();
  if (state.revision !== revision || state.saving || state.dragging) {
    return { ...runtime, sidebar_width_preference: state.savedWidth };
  }
  state.hydrate(runtime.sidebar_width_preference, revision);
  return runtime;
}
