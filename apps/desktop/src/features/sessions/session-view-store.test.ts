// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationSessionSummary } from "@/core/types";
import {
  normalizeDirectoryOrder,
  normalizeSessionDirectoryOrder,
  useSessionViewStore,
} from "./session-view-store";

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
    localStorage.removeItem("agentkib.session-directory-order");
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

  it("keeps newly discovered sessions ahead of manually ordered sessions", () => {
    expect(normalizeSessionDirectoryOrder(["saved"], ["new", "saved"])).toEqual(["new", "saved"]);
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

  it("restores saved order and removes stale or duplicate IDs on its next write", async () => {
    localStorage.setItem(
      "agentkib.session-directory-order",
      JSON.stringify({
        workspaceOrder: ["deleted-workspace", "workspace-b", "workspace-b"],
        sessionOrder: { workspace: ["deleted-session", "saved-session", "saved-session"] },
      }),
    );
    vi.resetModules();
    const { useSessionViewStore: restoredView } = await import("./session-view-store");
    expect(restoredView.getState().workspaceOrder).toEqual([
      "deleted-workspace",
      "workspace-b",
      "workspace-b",
    ]);
    expect(restoredView.getState().sessionOrder.workspace).toEqual([
      "deleted-session",
      "saved-session",
      "saved-session",
    ]);

    restoredView
      .getState()
      .setWorkspaceOrder(
        normalizeDirectoryOrder(restoredView.getState().workspaceOrder, [
          "workspace-a",
          "workspace-b",
        ]),
      );
    restoredView
      .getState()
      .setSessionOrder(
        "workspace",
        normalizeDirectoryOrder(restoredView.getState().sessionOrder.workspace, [
          "saved-session",
          "new-session",
        ]),
      );

    expect(JSON.parse(localStorage.getItem("agentkib.session-directory-order") ?? "{}")).toEqual({
      workspaceOrder: ["workspace-b", "workspace-a"],
      sessionOrder: { workspace: ["saved-session", "new-session"] },
    });
  });
});
