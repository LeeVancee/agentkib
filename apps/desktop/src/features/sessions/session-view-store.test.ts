// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import type { ConversationSessionSummary } from "@/core/types";
import { useSessionViewStore } from "./session-view-store";

const source: ConversationSessionSummary = {
  id: "source",
  workspace_id: "workspace",
  agent: "codex",
  title: "Source",
  archived: false,
  sidechain: false,
  availability: "readable",
};
const auxiliary: ConversationSessionSummary = {
  ...source,
  id: "auxiliary",
  title: "Auxiliary",
  origin: "auxiliary",
  spawned_by_session_id: source.id,
};

describe("session view source visibility", () => {
  beforeEach(() => {
    useSessionViewStore.setState({
      agent: "all",
      host: "all",
      filter: "current",
      showAuxiliary: false,
      collapsed: { workspace: true },
      scrollTop: 0,
    });
  });

  it("shares the opt-in toggle across navigation and resets it with filters", () => {
    useSessionViewStore.getState().setShowAuxiliary(true);
    expect(useSessionViewStore.getState().showAuxiliary).toBe(true);
    useSessionViewStore.getState().resetFilters();
    expect(useSessionViewStore.getState().showAuxiliary).toBe(false);
  });

  it("reveals an explicitly targeted auxiliary session and expands its workspace", () => {
    useSessionViewStore.getState().revealSession(auxiliary);
    expect(useSessionViewStore.getState()).toMatchObject({
      showAuxiliary: true,
      collapsed: { workspace: false },
    });
  });

  it("does not infer auxiliary origin from sidechain", () => {
    useSessionViewStore.getState().setShowAuxiliary(false);
    useSessionViewStore.getState().revealSession({ ...source, sidechain: true });
    expect(useSessionViewStore.getState().showAuxiliary).toBe(false);
  });
});
