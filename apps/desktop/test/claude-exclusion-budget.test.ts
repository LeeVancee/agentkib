import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultIo, type ClaudeIo } from "../../../packages/backend/src/context-claude-sources";
import { Doctor } from "../../../packages/backend/src/doctor";
import { contextFixture, type ContextFixture } from "./fixtures/claude-context";

const BUDGET_WARNING = "claudeMdExcludes could not be fully evaluated within the matching budget";
// All alternatives are valid non-matches; silently checking only the first 128 is not enough.
const TOO_MANY_ALTERNATIVES = `**/{${Array.from({ length: 129 }, (_, i) => `x${i}`).join(",")}}`;
const fixtures: ContextFixture[] = [];
function fixture(...args: Parameters<typeof contextFixture>) {
  const created = contextFixture(...args);
  fixtures.push(created);
  return created;
}
afterEach(() => {
  for (const created of fixtures.splice(0)) created.dispose();
});
const excludes = (f: ContextFixture, patterns: string[]) =>
  f.write(".claude/settings.json", JSON.stringify({ claudeMdExcludes: patterns }));
const budgetWarnings = (result: { warnings: string[] }) =>
  result.warnings.filter((warning) => warning.includes(BUDGET_WARNING));
const instructions = (result: { sections: { scope: string; content: string }[] }) =>
  result.sections
    .filter((section) => section.scope !== "settings")
    .map((section) => section.content);

describe("claudeMdExcludes matching budget", () => {
  it.each(["full", "MCP"] as const)(
    "evaluates a matching exclusion longer than 1024 characters on %s",
    async (surface) => {
      const f = fixture();
      f.claude("2.1.300 (Claude Code)");
      f.managed("MANAGED-INSTRUCTIONS\n");
      f.user("CLAUDE.md", "PRIVATE-USER-INSTRUCTIONS\n");
      f.write("CLAUDE.md", "EXCLUDED-LONG-PATTERN-INSTRUCTIONS\n");
      f.write("AGENTS.md", "FALLBACK-INSTRUCTIONS\n");
      excludes(f, [`**/${"*".repeat(1_024)}CLAUDE.md`]);
      const result = surface === "full" ? await f.request() : await f.mcp();
      expect(budgetWarnings(result)).toEqual([]);
      expect(instructions(result)).not.toContain("EXCLUDED-LONG-PATTERN-INSTRUCTIONS\n");
      expect(instructions(result)).toContain("FALLBACK-INSTRUCTIONS\n");
      if (surface === "full") expect(instructions(result)).toContain("MANAGED-INSTRUCTIONS\n");
      else {
        expect(JSON.stringify(result)).not.toContain("PRIVATE-USER-INSTRUCTIONS");
        expect(JSON.stringify(result)).not.toContain("MANAGED-INSTRUCTIONS");
      }
    },
  );

  it.each(["full", "MCP"] as const)(
    "reports incomplete matching for one long rule exceeding the shared budget on %s and recovers on the next request",
    async (surface) => {
      const f = fixture();
      f.claude("2.1.300 (Claude Code)");
      f.write("CLAUDE.md", "UNDECIDED-LONG-PATTERN-INSTRUCTIONS\n");
      f.write("AGENTS.md", "FALLBACK-INSTRUCTIONS\n");
      // The whole settings file fits its 256 KiB read budget, but evaluating this
      // literal consumes the shared work allowance before a match can be decided.
      const expensive = `**/${"q".repeat(180_000)}.md`;
      excludes(f, [expensive, "**/CLAUDE.md"]);
      const request = () => (surface === "full" ? f.request() : f.mcp());
      const limited = await request();
      expect(budgetWarnings(limited)).toHaveLength(1);
      expect(budgetWarnings(limited)[0]).not.toContain(expensive);
      expect(instructions(limited)).toContain("UNDECIDED-LONG-PATTERN-INSTRUCTIONS\n");
      expect(instructions(limited)).not.toContain("FALLBACK-INSTRUCTIONS\n");
      excludes(f, ["**/CLAUDE.md"]);
      const recovered = await request();
      expect(budgetWarnings(recovered)).toEqual([]);
      expect(instructions(recovered)).not.toContain("UNDECIDED-LONG-PATTERN-INSTRUCTIONS\n");
      expect(instructions(recovered)).toContain("FALLBACK-INSTRUCTIONS\n");
    },
  );

  it.each(["full", "MCP", "Doctor"] as const)(
    "retains undecided instructions and the existing privacy boundary for %s",
    async (surface) => {
      const accesses: string[] = [],
        reads: string[] = [];
      const record =
        <A extends unknown[], R>(fn: (file: string, ...rest: A) => R) =>
        (file: string, ...rest: A): R => {
          accesses.push(file);
          return fn(file, ...rest);
        };
      const io: ClaudeIo = {
        lstat: record(defaultIo.lstat),
        readlink: record(defaultIo.readlink),
        realpath: record(defaultIo.realpath),
        readdir: record(defaultIo.readdir),
        readFile: record((file, limit) => {
          reads.push(file);
          return defaultIo.readFile(file, limit);
        }),
      };
      const f = fixture({ io });
      f.claude("2.1.300 (Claude Code)");
      f.write("CLAUDE.md", "PROJECT-INSTRUCTIONS\n");
      f.write("CLAUDE.local.md", "LOCAL-INSTRUCTIONS\n");
      f.write(".claude/rules/a.md", "FIRST-RULE\n");
      f.write(".claude/rules/b.md", "SECOND-RULE\n");
      const fallback = f.write("AGENTS.md", "INCORRECT-FALLBACK\n");
      const outsideBodies = [
        f.managed("MANAGED-BODY-CANARY\n"),
        f.user("CLAUDE.md", "USER-BODY-CANARY\n"),
        f.write(f.outside("CLAUDE.md"), "PARENT-BODY-CANARY\n"),
        f.memory("MEMORY-BODY-CANARY\n"),
      ];
      f.write(
        path.join(f.managedDir, "managed-settings.json"),
        JSON.stringify({ claudeMd: "MANAGED-TEXT-CANARY\n" }),
      );
      const privatePattern = f.inHome("private-pattern-canary", "*.md");
      // The later broad match must not remove files whose exclusion was never decided.
      excludes(f, [TOO_MANY_ALTERNATIVES, "**/*.md", privatePattern]);
      const result =
        surface === "full"
          ? await f.request()
          : surface === "MCP"
            ? await f.mcp()
            : await f.resolve(f.project, { includeOutsideSources: false });

      expect(instructions(result)).toEqual(
        expect.arrayContaining([
          "PROJECT-INSTRUCTIONS\n",
          "LOCAL-INSTRUCTIONS\n",
          "FIRST-RULE\n",
          "SECOND-RULE\n",
        ]),
      );
      expect(instructions(result)).not.toContain("INCORRECT-FALLBACK\n");
      expect(reads).not.toContain(fallback);
      if (surface === "Doctor") {
        // Doctor intentionally ignores settings, including workspace exclusions.
        expect(budgetWarnings(result)).toEqual([]);
        expect(reads).not.toContain(f.at(".claude", "settings.json"));
      } else {
        expect(budgetWarnings(result)).toHaveLength(1);
        const warning = budgetWarnings(result)[0]!;
        for (const privateValue of [TOO_MANY_ALTERNATIVES, privatePattern, f.home, f.managedDir])
          expect(warning).not.toContain(privateValue);
      }

      if (surface === "full") {
        expect(instructions(result)).toEqual(
          expect.arrayContaining(["MANAGED-BODY-CANARY\n", "MANAGED-TEXT-CANARY\n"]),
        );
      } else {
        const output = JSON.stringify(result);
        for (const canary of [
          "MANAGED-BODY",
          "MANAGED-TEXT",
          "USER-BODY",
          "PARENT-BODY",
          "MEMORY-BODY",
        ])
          expect(output).not.toContain(`${canary}-CANARY`);
        for (const privatePath of [f.home, f.managedDir, f.outside("CLAUDE.md")])
          expect(output).not.toContain(privatePath);
        for (const file of outsideBodies) expect(reads).not.toContain(file);
      }
      if (surface === "Doctor")
        expect(
          accesses.filter((file) => file !== f.project && !file.startsWith(f.project + path.sep)),
        ).toEqual([]);
    },
  );

  it("keeps exclusion settings out of Doctor findings and does not report retained instructions as missing", async () => {
    const f = fixture();
    f.write(
      ".agentkib/manifest.yaml",
      "schema_version: 2\nworkspace:\n  id: fixture\n  name: Fixture\ninstructions:\n  shared: |\n    Use tabs for indentation.\n",
    );
    f.write("CLAUDE.md", "Use tabs for indentation.\n");
    f.write("AGENTS.md", "Unrelated fallback.\n");
    excludes(f, [TOO_MANY_ALTERNATIVES, "**/*.md"]);
    const report = await new Doctor(f.context, () => f.project).report("fixture");
    const issues = report.issues.filter((issue) => issue.agent === "claude-code");
    expect(
      issues.filter((issue) => issue.evidence.some((row) => row.detail.includes(BUDGET_WARNING))),
    ).toHaveLength(0);
    expect(issues.map((issue) => issue.code)).not.toContain("instruction.missing");
    expect(issues.map((issue) => issue.code)).not.toContain("instruction.expected-content-missing");
  });

  it("starts a fresh budget for the next request and applies ordinary exclusions and fallback", async () => {
    const f = fixture();
    f.claude("2.1.300 (Claude Code)");
    f.managed("MANAGED-INSTRUCTIONS\n");
    f.write("CLAUDE.md", "CLAUDE-INSTRUCTIONS\n");
    f.write("AGENTS.md", "AGENTS-INSTRUCTIONS\n");
    f.write(".claude/rules/skip.md", "EXCLUDED-RULE\n");
    f.write(".claude/rules/keep.md", "RETAINED-RULE\n");
    excludes(f, [TOO_MANY_ALTERNATIVES, "**/*.md"]);
    const limited = await f.request();
    expect(budgetWarnings(limited)).toHaveLength(1);
    expect(instructions(limited)).toContain("CLAUDE-INSTRUCTIONS\n");
    expect(instructions(limited)).not.toContain("AGENTS-INSTRUCTIONS\n");

    excludes(f, ["**/CLAUDE.md", "**/skip.md"]);
    const recovered = await f.request();
    expect(budgetWarnings(recovered)).toEqual([]);
    expect(instructions(recovered)).toEqual([
      "MANAGED-INSTRUCTIONS\n",
      "AGENTS-INSTRUCTIONS\n",
      "RETAINED-RULE\n",
    ]);
  });

  it("shares one allowance across distinct exclusion patterns", async () => {
    const f = fixture();
    f.write("CLAUDE.md", "UNDECIDED-INSTRUCTIONS\n");
    const patterns = Array.from({ length: 2_048 }, (_, i) => `**/${"q".repeat(64)}-${i}.md`);
    excludes(f, [patterns[0]!, "**/CLAUDE.md"]);
    const onePattern = await f.request();
    expect(budgetWarnings(onePattern)).toEqual([]);
    expect(instructions(onePattern)).not.toContain("UNDECIDED-INSTRUCTIONS\n");

    excludes(f, [...patterns, "**/CLAUDE.md"]);
    const manyPatterns = await f.request();
    expect(budgetWarnings(manyPatterns)).toHaveLength(1);
    expect(instructions(manyPatterns)).toContain("UNDECIDED-INSTRUCTIONS\n");
  });

  it("does not renew the allowance for each additional instruction file", async () => {
    const f = fixture();
    f.write(".claude/rules/000.md", "ALREADY-EXCLUDED-RULE\n");
    excludes(f, [`**/${"q".repeat(900)}.md`, "**/rules/*.md"]);
    const oneFile = await f.request();
    expect(budgetWarnings(oneFile)).toEqual([]);
    expect(instructions(oneFile)).not.toContain("ALREADY-EXCLUDED-RULE\n");

    for (let i = 1; i <= 128; i++)
      f.write(`.claude/rules/${String(i).padStart(3, "0")}.md`, `RULE-${i}\n`);
    const manyFiles = await f.request();
    expect(budgetWarnings(manyFiles)).toHaveLength(1);
    expect(instructions(manyFiles)).not.toContain("ALREADY-EXCLUDED-RULE\n");
    expect(instructions(manyFiles)).toContain("RULE-128\n");
  });

  it("preserves a proven exclusion when discovery of a later file exhausts the budget", async () => {
    const f = fixture();
    f.claude("2.1.300 (Claude Code)");
    f.write("CLAUDE.md", "ALREADY-EXCLUDED-INSTRUCTIONS\n");
    f.write(".claude/CLAUDE.md", "UNDECIDED-INSTRUCTIONS\n");
    f.write("AGENTS.md", "INCORRECT-FALLBACK\n");
    excludes(f, [f.at("CLAUDE.md"), TOO_MANY_ALTERNATIVES, "**/*.md"]);

    // Fallback discovery decides the root CLAUDE.md first, then reaches the costly rule
    // for .claude/CLAUDE.md. Loading the first file must reuse its already proven decision.
    const result = await f.request();
    expect(budgetWarnings(result)).toHaveLength(1);
    expect(instructions(result)).toEqual(["UNDECIDED-INSTRUCTIONS\n"]);
    expect(result.warnings).toContain(`Note: Excluded by claudeMdExcludes: ${f.at("CLAUDE.md")}`);
  });
});
