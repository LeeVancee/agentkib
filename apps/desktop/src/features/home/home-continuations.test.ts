import { describe, expect, it } from "vitest";
import type { ConversationSessionSummary, WorkspaceSummary } from "@/core/types";
import { selectRecentContinuations } from "./home-continuations";

const workspaces = ["first", "second", "third", "fourth"].map(
  (id) => ({ id, name: id }) as WorkspaceSummary,
);

const readableSession = {
  availability: "readable",
  agent: "codex",
} as ConversationSessionSummary;

describe("selectRecentContinuations", () => {
  it("takes the limit after filtering workspaces without readable sessions", () => {
    const result = selectRecentContinuations(workspaces, [[], [], [], [readableSession]], 3);

    expect(result.map((item) => item.workspace.id)).toEqual(["fourth"]);
  });
});
