import { describe, expect, it } from "vitest";
import {
  braceVariants,
  GlobMatchBudget,
  GlobMatchBudgetExceeded,
  globMatches,
} from "../../../packages/backend/src/context-glob";

class CountedBudget extends GlobMatchBudget {
  spent = 0;

  override spend(amount = 1): void {
    super.spend(amount);
    this.spent += amount;
  }
}

describe("glob matching work budget", () => {
  it.each<[string, string, boolean]>([
    ["CLAUDE.md", "CLAUDE.md", true],
    ["CLAUDE.md", "claude.md", false],
    ["文?.md", "文😀.md", true],
    ["?", "😀", true],
    ["?", "e\u0301", false],
    ["*", "", true],
    ["*.md", ".hidden.md", true],
    ["*.md", "src/CLAUDE.md", false],
    ["**/CLAUDE.md", "CLAUDE.md", true],
    ["**/CLAUDE.md", "a/b/CLAUDE.md", true],
    ["a/**/b/**", "a/x/y/b/z", true],
    ["a/**/b", "a/x/y/c", false],
    ["[a-z][!0-9]", "a文", true],
    ["[a-z][^0-9]", "a1", false],
    ["[😀-🙏]", "😁", true],
    ["\\*", "*", true],
    ["{AGENTS,CLAUDE}.md", "CLAUDE.md", true],
    ["{a,{b,c}}.md", "c.md", true],
    ["\\{a,b\\}", "{a,b}", true],
    ["@(AGENTS|CLAUDE).md", "CLAUDE.md", true],
    ["?(a)b", "b", true],
    ["?(a)b", "aab", false],
    ["+(a|b)", "abba", true],
    ["+(a|b)", "", false],
    ["*(|a)", "aaa", true],
    ["+(|a)", "", true],
    ["!(secret).md", "CLAUDE.md", true],
    ["!(secret).md", "secret.md", false],
    ["!(!(x))", "x", true],
    ["!(!(x))", "y", false],
    ["!(*.test).ts", "main.ts", true],
    ["!(*.test).ts", "main.test.ts", false],
    ["[a-", "a", false],
    ["@(a|", "a", false],
    ["a\\", "a", false],
  ])("preserves legacy matching for %s against %s", (pattern, target, expected) => {
    expect(globMatches(pattern, target)).toBe(expected);
    expect(globMatches(pattern, target, new GlobMatchBudget())).toBe(expected);
  });

  it("memoizes nested negation while preserving its result", () => {
    const pattern = `**/${"!(".repeat(10)}x${")".repeat(10)}`;
    expect(globMatches(pattern, "CLAUDE.md", new GlobMatchBudget())).toBe(false);
    expect(globMatches(pattern, "x", new GlobMatchBudget())).toBe(true);
  });

  it("stops the pathological nested negation within the default work budget", () => {
    const pattern = `**/${"!(".repeat(10)}x${")".repeat(10)}`;
    const budget = new CountedBudget();
    expect(() => globMatches(pattern, "a".repeat(128), budget)).toThrow(GlobMatchBudgetExceeded);
    expect(budget.spent).toBeLessThanOrEqual(100_000);
    expect(() => globMatches("*", "a", budget)).toThrow(GlobMatchBudgetExceeded);
  });

  it("shares work across matches and starts independently for a new request", () => {
    const pattern = "**/{AGENTS,CLAUDE}.md";
    const target = "project/CLAUDE.md";
    const measurement = new CountedBudget();
    expect(globMatches(pattern, target, measurement)).toBe(true);
    const shared = new GlobMatchBudget(measurement.spent * 2);
    expect(globMatches(pattern, target, shared)).toBe(true);
    expect(globMatches(pattern, target, shared)).toBe(true);
    expect(() => globMatches(pattern, target, shared)).toThrow(GlobMatchBudgetExceeded);
    expect(globMatches(pattern, target, new GlobMatchBudget(measurement.spent * 2))).toBe(true);
  });

  it.each<[string, string]>([
    ["*", "/".repeat(100_001)],
    ["a".repeat(100_001), "a"],
    [`*[${"a".repeat(500)}]`, "b".repeat(500)],
    ["*(*)", "a".repeat(512)],
    ["{a,b}".repeat(8), "a"],
  ])("bounds splitting, parsing, classes, repetition and expansion: %#", (pattern, target) => {
    expect(() => globMatches(pattern, target, new GlobMatchBudget())).toThrow(
      GlobMatchBudgetExceeded,
    );
  });

  it("reports the brace limit instead of a partially expanded answer", () => {
    const exactly128 = `{${Array<string>(128).fill("a").join(",")}}`;
    const over128 = `{${Array<string>(128).fill("a").join(",")},b}`;
    expect(globMatches(exactly128, "a", new GlobMatchBudget())).toBe(true);
    expect(braceVariants(over128)).toHaveLength(128);
    expect(globMatches(over128, "b")).toBe(false);
    expect(() => globMatches(over128, "b", new GlobMatchBudget())).toThrow(GlobMatchBudgetExceeded);
    expect(() => globMatches(over128, "a", new GlobMatchBudget())).toThrow(GlobMatchBudgetExceeded);
  });

  it.each<[string, boolean]>([
    ["@", false],
    ["!", true],
  ])(
    "reports matching depth limits inside %s without returning false",
    (operator, legacyResult) => {
      const pattern = `${operator}(`.repeat(17) + "x" + ")".repeat(17);
      expect(globMatches(pattern, "x")).toBe(legacyResult);
      expect(() => globMatches(pattern, "x", new GlobMatchBudget())).toThrow(
        GlobMatchBudgetExceeded,
      );
      expect(() => globMatches(pattern, "x", new GlobMatchBudget())).toThrow(
        "Glob matching depth limit exceeded",
      );
    },
  );

  it("reports parsing depth limits without treating an invalid subtree as a nonmatch", () => {
    const pattern = "!(".repeat(129) + "x" + ")".repeat(129);
    expect(globMatches(pattern, "x")).toBe(false);
    expect(() => globMatches(pattern, "x", new GlobMatchBudget())).toThrow(GlobMatchBudgetExceeded);
    expect(() => globMatches(pattern, "x", new GlobMatchBudget())).toThrow(
      "Glob parsing depth limit exceeded",
    );
  });

  it("propagates budget errors without converting them into a match or nonmatch", () => {
    const failure = new GlobMatchBudgetExceeded("request work exhausted");
    class FailedBudget extends GlobMatchBudget {
      override spend(): void {
        throw failure;
      }
    }
    expect(() => globMatches("!(anything)", "CLAUDE.md", new FailedBudget())).toThrow(failure);
    expect(() => globMatches("*", "a", new GlobMatchBudget(0))).toThrow(GlobMatchBudgetExceeded);
  });
});
