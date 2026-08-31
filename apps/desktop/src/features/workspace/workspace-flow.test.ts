import { describe, expect, it } from "vitest";
import { changesReturnPage, hasActiveChangesFlow } from "./workspace-flow";

describe("workspace changes flow", () => {
  it("returns to the page that started the review", () => {
    expect(changesReturnPage("standard")).toBe("overview");
    expect(changesReturnPage("doctor")).toBe("doctor");
    expect(changesReturnPage("handoff")).toBe("sessions");
  });

  it("only exposes Changes while transient state exists", () => {
    expect(hasActiveChangesFlow(undefined, undefined)).toBe(false);
    expect(hasActiveChangesFlow({ id: "changes" }, undefined)).toBe(true);
    expect(hasActiveChangesFlow(undefined, { filename: "handoff.md" })).toBe(true);
  });
});
