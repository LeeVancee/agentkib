import { describe, expect, it } from "vitest";
import type { AppSearch } from "./app-route";
import { parseRoute, workspaceSearchForPage } from "./app-route";

describe("parseRoute", () => {
  it("distinguishes the global hub from workspace session history", () => {
    expect(parseRoute("/sessions")).toEqual({ kind: "global", page: "sessions" });
    expect(parseRoute("/workspace/example/sessions")).toEqual({
      kind: "workspace",
      workspaceId: "example",
      page: "sessions",
    });
  });
});

describe("workspaceSearchForPage", () => {
  const gitSubview = { kind: "commit", oid: "abc123" } as const;

  it("clears Git detail state when navigating to another workspace page", () => {
    const current: AppSearch = { gitSubview, doctorVerification: "applied" };

    expect(workspaceSearchForPage(current, "doctor")).toEqual({
      gitSubview: undefined,
      doctorVerification: "applied",
    });
  });

  it("preserves Git detail state when navigating to the Git page", () => {
    const current: AppSearch = { gitSubview };

    expect(workspaceSearchForPage(current, "git")).toBe(current);
  });

  it("keeps continuation recovery state only within sessions and changes", () => {
    const current: AppSearch = {
      handoffSession: "session",
      handoffTarget: "claude-code",
      handoffBudget: 120_000,
      handoffFormat: "markdown",
      handoffResume: "recheck",
    };

    expect(workspaceSearchForPage(current, "changes")).toMatchObject(current);
    expect(workspaceSearchForPage(current, "overview")).toEqual({ gitSubview: undefined });
  });
});
