import { describe, expect, it } from "vitest";
import { projectContextUsage } from "@agentkib/backend/context-usage";
import { versionAtLeast } from "@agentkib/backend/native-version";
import { assertActivityAllows } from "@agentkib/backend/session-activity";

describe("native minimum versions", () => {
  it.each([
    ["26.917.62051", "26.917.62051", true],
    ["26.917.62050", "26.917.62051", false],
    ["26.924.22138", "26.924.22138", true],
    ["26.930.51102", "26.924.22138", true],
    ["27.1.1", "26.924.22138", true],
    ["26.1000.1", "26.930.51102", true],
    ["2.1.286", "2.1.263", true],
    ["1.1.2", "1.1.1", true],
    ["", "1.1.1", false],
    ["1.2", "1.1.1", false],
    ["1.2.3-extra", "1.1.1", false],
    [" 1.2.3", "1.1.1", false],
    ["1.-2.3", "1.1.1", false],
    ["1.2.9007199254740992", "1.1.1", false],
  ])("compares %s with %s", (actual, minimum, expected) => {
    expect(versionAtLeast(actual, minimum)).toBe(expected);
  });
});

describe("native context usage projection", () => {
  it("uses last context occupancy, retaining cumulative consumption separately", () => {
    expect(
      projectContextUsage({
        available: true,
        tokenUsage: {
          last: { totalTokens: 3000 },
          total: { totalTokens: 12000 },
          modelContextWindow: 48000,
        },
      }),
    ).toMatchObject({ usedTokens: 3000, totalTokens: 12000, percent: 6.25, state: "ready" });
  });
  it("never substitutes cumulative tokens for a missing native report", () => {
    expect(
      projectContextUsage({
        available: true,
        tokenUsage: { total: 12000, modelContextWindow: 48000 },
      }),
    ).toEqual({ available: true, state: "pending", totalTokens: 12000, contextWindow: 48000 });
  });
  it("accepts native zero and safe ACP integers, without fabricating a window", () => {
    expect(
      projectContextUsage({ available: true, usedTokens: 0n, contextWindow: 100n }),
    ).toMatchObject({ state: "ready", usedTokens: 0, percent: 0 });
    expect(projectContextUsage({ available: true, usedTokens: 12 })).toEqual({
      available: true,
      state: "pending",
      usedTokens: 12,
    });
    expect(
      projectContextUsage({ available: true, usedTokens: 9007199254740992n, contextWindow: 100n })
        ?.usedTokens,
    ).toBeUndefined();
  });
  it("preserves report identity and stale candidates but suppresses their gauge", () => {
    expect(
      projectContextUsage(
        {
          available: true,
          state: "stale",
          usedTokens: 12,
          contextWindow: 100,
          percent: 12,
          reportId: 7,
          reportGeneration: 2,
          updatedAt: "2026-10-06T00:00:00Z",
        },
        9,
      ),
    ).toEqual({
      available: true,
      state: "stale",
      usedTokens: 12,
      contextWindow: 100,
      reportId: 7,
      reportGeneration: 2,
      revision: 9,
      updatedAt: "2026-10-06T00:00:00Z",
    });
  });
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "2", null])(
    "does not accept an invalid native report generation %s",
    (reportGeneration) => {
      expect(projectContextUsage({ available: true, reportGeneration })).not.toHaveProperty(
        "reportGeneration",
      );
    },
  );
});

describe("native compaction control barrier", () => {
  it.each([
    "send",
    "steer",
    "settings",
    "goal-set",
    "goal-pause",
    "goal-resume",
    "goal-clear",
    "release",
    "fork",
    "resume",
  ])("blocks %s even when the turn appears idle", (operation) => {
    expect(() =>
      assertActivityAllows({ activity: "compacting", status: "idle" }, operation),
    ).toThrow("session-compacting");
  });
  it.each([
    "stop",
    "approve",
    "answer",
    "queue-add",
    "queue-update",
    "queue-delete",
    "queue-reorder",
    "inspect",
  ])("leaves %s to its existing native checks", (operation) => {
    expect(() => assertActivityAllows({ activity: "compacting" }, operation)).not.toThrow();
  });
  it("clears only the compaction barrier, independently of execution and usage", () => {
    expect(() =>
      assertActivityAllows(
        { activity: null, status: "running", usage: { state: "stale" } },
        "send",
      ),
    ).not.toThrow();
  });
});
