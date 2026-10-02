import { create } from "zustand";
import type { AgentKind } from "@/core/types";

export type AgentDetailSection = "overview" | "assets" | "workspaces" | "usage";

export const useAgentViewStore = create<{
  query: string;
  sort: "name" | "status";
  sections: Partial<Record<AgentKind, AgentDetailSection>>;
  setQuery: (query: string) => void;
  setSort: (sort: "name" | "status") => void;
  setSection: (agent: AgentKind, section: AgentDetailSection) => void;
}>((set) => ({
  query: "",
  sort: "status",
  sections: {},
  setQuery: (query) => set({ query }),
  setSort: (sort) => set({ sort }),
  setSection: (agent, section) =>
    set((state) => ({ sections: { ...state.sections, [agent]: section } })),
}));
