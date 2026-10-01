import { create } from "@octanejs/zustand";

// Navigation view state is deliberately scoped to this application run.
export const useSidebarViewStore = create<{
  expandedWorkspaces: Record<string, boolean>;
  settingsQuery: string;
  setWorkspaceExpanded: (id: string, expanded: boolean) => void;
  setSettingsQuery: (query: string) => void;
}>((set) => ({
  expandedWorkspaces: {},
  settingsQuery: "",
  setWorkspaceExpanded: (id, expanded) =>
    set((state) => ({ expandedWorkspaces: { ...state.expandedWorkspaces, [id]: expanded } })),
  setSettingsQuery: (settingsQuery) => set({ settingsQuery }),
}));
