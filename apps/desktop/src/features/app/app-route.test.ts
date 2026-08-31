import { describe, expect, it } from "vitest";
import type { AppSearch } from "./app-route";
import { workspaceSearchForPage } from "./app-route";

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
});
