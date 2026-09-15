import { create } from "@octanejs/zustand";
import type { AgentKind, ConversationSessionSummary } from "@/core/types";

export type SessionRecordFilter = "current" | "archived" | "metadata" | "all";

// View-only state survives navigation, but never persists transcript content to disk.
export const useSessionViewStore = create<{
  agent: AgentKind | "all";
  host: string;
  filter: SessionRecordFilter;
  showAuxiliary: boolean;
  collapsed: Record<string, boolean>;
  scrollTop: number;
  revealSession: (session: ConversationSessionSummary) => void;
  setAgent: (agent: AgentKind | "all") => void;
  setHost: (host: string) => void;
  setFilter: (filter: SessionRecordFilter) => void;
  setShowAuxiliary: (showAuxiliary: boolean) => void;
  toggleWorkspace: (id: string) => void;
  setScrollTop: (scrollTop: number) => void;
  resetFilters: () => void;
}>((set) => ({
  agent: "all",
  host: "all",
  filter: "current",
  showAuxiliary: false,
  collapsed: {},
  scrollTop: 0,
  revealSession: (session) =>
    set((state) => ({
      host:
        state.host === "all" || state.host === (session.remote?.host_id ?? "local")
          ? state.host
          : "all",
      agent: state.agent === "all" || state.agent === session.agent ? state.agent : "all",
      showAuxiliary: state.showAuxiliary || session.origin === "auxiliary",
      filter:
        (state.filter === "current" && (session.archived || session.availability !== "readable")) ||
        (state.filter === "archived" && !session.archived) ||
        (state.filter === "metadata" && session.availability !== "metadata-only")
          ? "all"
          : state.filter,
      collapsed: { ...state.collapsed, [session.workspace_id]: false },
    })),
  setAgent: (agent) => set({ agent }),
  setHost: (host) => set({ host }),
  setFilter: (filter) => set({ filter }),
  setShowAuxiliary: (showAuxiliary) => set({ showAuxiliary }),
  toggleWorkspace: (id) =>
    set((state) => ({ collapsed: { ...state.collapsed, [id]: !state.collapsed[id] } })),
  setScrollTop: (scrollTop) => set({ scrollTop }),
  resetFilters: () => set({ agent: "all", filter: "current", host: "all", showAuxiliary: false }),
}));
