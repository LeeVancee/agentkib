import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Doctor } from "../../../packages/backend/src/doctor";
import { parseRule } from "../../../packages/backend/src/context-claude-sources";
import { contextFixture, type ContextFixture } from "./fixtures/claude-context";

// `.claude/rules` as Claude Code reads it (https://code.claude.com/docs/en/memory, "Organize
// rules"): every `.md` file below the folder, at any depth. A rule without a `paths` field loads
// at startup like `.claude/CLAUDE.md`; one with `paths` loads when a matching file is read. The
// user's rules in `~/.claude/rules` load before the project's.
const NO_PROJECT = "No project instruction file was found for this Agent";
const SETTINGS_NOT_READ =
  "Note: Claude Code settings are not read yet (claudeMdExcludes, the Project instructions choice, the autoMemoryDirectory and autoMemoryEnabled settings, managed claudeMd) and rules in parent directories are not read, so this list can differ from what Claude Code loads.";
const symlinks = process.platform === "win32" ? it.skip : it;

const fixtures: ContextFixture[] = [];
function fixture(...args: Parameters<typeof contextFixture>) {
  const created = contextFixture(...args);
  fixtures.push(created);
  return created;
}
afterEach(() => {
  for (const created of fixtures.splice(0)) created.dispose();
});
const sections = (preview: { sections: { source: string; scope: string; content: string }[] }) =>
  preview.sections.map((section) => [section.scope, section.content]);
const names = (preview: { sections: { source: string }[] }, base: string) =>
  preview.sections.map((section) => path.relative(base, section.source).split(path.sep).join("/"));

describe("the rules folder", () => {
  it("is read at any depth, only for .md files, in the byte order of the relative path", async () => {
    const f = fixture();
    f.write(".claude/rules/b.md", "b");
    // Capitals sort before lower case. (A name that differs only by case would be the same file
    // on macOS and Windows.)
    f.write(".claude/rules/Zed.md", "Zed");
    f.write(".claude/rules/a-b.md", "a-b");
    f.write(".claude/rules/a/z.md", "a/z");
    f.write(".claude/rules/a/deeper/x.md", "a/deeper/x");
    f.write(".claude/rules/notes.txt", "not a rule");
    f.write(".claude/rules/c.MD", "wrong case");
    const preview = await f.resolve();
    expect(names(preview, f.at(".claude", "rules"))).toEqual([
      "Zed.md",
      "a-b.md",
      "a/deeper/x.md",
      "a/z.md",
      "b.md",
    ]);
    // The scope is the folder that holds the file, like for every other source.
    expect(preview.sections.map((section) => section.scope)).toEqual([
      ".claude/rules",
      ".claude/rules",
      ".claude/rules/a/deeper",
      ".claude/rules/a",
      ".claude/rules",
    ]);
  });

  it("expands imports in a rule, as in any CLAUDE.md-style file", async () => {
    const f = fixture();
    f.write("docs/shared.md", "shared text\n");
    f.write(".claude/rules/r.md", "before\n@../../docs/shared.md\nafter\n");
    const preview = await f.resolve();
    expect(preview.sections[0]!.content).toBe("before\nshared text\n\nafter\n");
  });

  it("is not read from a parent directory", async () => {
    const f = fixture();
    f.write(f.outside(".claude", "rules", "canary.md"), "PARENT-RULE-BODY\n");
    f.write("CLAUDE.md", "main\n");
    for (const result of [await f.resolve(), await f.mcp()])
      expect(JSON.stringify(result)).not.toContain("PARENT-RULE-BODY");
  });

  it("is read from a parent directory when that is turned on", async () => {
    // Whether Claude Code loads these at startup is not documented, so it is off by default.
    const f = fixture({ ancestorRules: true });
    f.write(f.outside(".claude", "rules", "canary.md"), "PARENT-RULE-BODY\n");
    f.write("CLAUDE.md", "main\n");
    const preview = await f.resolve();
    expect(sections(preview)).toEqual([
      ["ancestor", "PARENT-RULE-BODY\n"],
      ["", "main\n"],
    ]);
    // Even then the MCP tool only counts it.
    expect(JSON.stringify(await f.mcp())).not.toContain("PARENT-RULE-BODY");
  });

  it("puts the user's rules before the project's and the project's in the chain order", async () => {
    const f = fixture();
    f.write(".claude/rules/project.md", "project\n");
    f.write("packages/app/.claude/rules/app.md", "app\n");
    f.user("rules/user.md", "user\n");
    const preview = await f.resolve(f.at("packages", "app"));
    expect(sections(preview)).toEqual([
      ["user", "user\n"],
      [".claude/rules", "project\n"],
      ["packages/app/.claude/rules", "app\n"],
    ]);
  });
});

describe("rules with a paths field", () => {
  it("are listed by their patterns, apart from the rules that load at startup", async () => {
    const f = fixture();
    f.write("CLAUDE.md", "main\n");
    f.write(".claude/rules/always.md", "always\n");
    f.write(
      ".claude/rules/api.md",
      "---\npaths:\n  - src/api/**/*.ts\n  - 'tests/**'\n---\nAPI-RULE-BODY\n",
    );
    const preview = await f.resolve();
    expect(preview.sections.map((section) => section.scope)).toEqual([
      "",
      ".claude/rules",
      "conditional",
    ]);
    expect(preview.sections[2]).toMatchObject({
      source: f.at(".claude", "rules", "api.md"),
      content: "paths:\n- src/api/**/*.ts\n- tests/**\n",
    });
    expect(JSON.stringify(preview)).not.toContain("API-RULE-BODY");
    // Only the files that load at startup count as the project's instructions. The one note is
    // that the list is not the whole story: a conditional rule makes the preview differ from
    // what is loaded at startup.
    expect(preview.warnings).toEqual([SETTINGS_NOT_READ]);
  });

  it("accept a comma-separated string, and keep the commas inside braces", async () => {
    const f = fixture();
    f.write("CLAUDE.md", "main\n");
    f.write(".claude/rules/a.md", "---\npaths: src/**/*.{ts,tsx}, docs/*.md ,, \n---\nbody\n");
    const preview = await f.resolve();
    expect(preview.sections.at(-1)).toMatchObject({
      scope: "conditional",
      content: "paths:\n- src/**/*.{ts,tsx}\n- docs/*.md\n",
    });
  });

  it("show the first eight patterns and say how many more", async () => {
    const f = fixture();
    f.write("CLAUDE.md", "main\n");
    const patterns = Array.from({ length: 11 }, (_, index) => `dir${index}/**`);
    f.write(".claude/rules/many.md", `---\npaths: [${patterns.join(", ")}]\n---\nbody\n`);
    const preview = await f.resolve();
    expect(preview.sections.at(-1)!.content).toBe(
      `paths:\n${patterns
        .slice(0, 8)
        .map((pattern) => `- ${pattern}`)
        .join("\n")}\n… (+3 more)\n`,
    );
  });

  it.each([
    ["an empty paths field", "---\npaths:\n---\nrule body\n"],
    ["a paths field that is a mapping", "---\npaths: {a: 1}\n---\nrule body\n"],
    ["a paths list with no strings", "---\npaths: [1, 2, null]\n---\nrule body\n"],
    ["only blank patterns", "---\npaths: ' , '\n---\nrule body\n"],
    ["only other fields", "---\ndescription: x\n---\nrule body\n"],
  ])("load at startup with %s, without their front matter", async (_name, text) => {
    const f = fixture();
    f.write(".claude/rules/r.md", text);
    const preview = await f.resolve();
    expect(sections(preview)).toEqual([[".claude/rules", "rule body\n"]]);
  });

  it("load at startup, text and all, when the front matter cannot be parsed", async () => {
    const f = fixture();
    const text = "---\npaths: [unclosed\n---\nrule body\n";
    f.write(".claude/rules/r.md", text);
    const preview = await f.resolve();
    expect(sections(preview)).toEqual([[".claude/rules", text]]);
  });

  it("are not front matter unless the file starts with a --- line that is closed", async () => {
    const f = fixture();
    f.write(".claude/rules/late.md", "intro\n---\npaths: a\n---\nrest\n");
    f.write(".claude/rules/open.md", "---\npaths: a\nnever closed\n");
    const preview = await f.resolve();
    expect(sections(preview)).toEqual([
      [".claude/rules", "intro\n---\npaths: a\n---\nrest\n"],
      [".claude/rules", "---\npaths: a\nnever closed\n"],
    ]);
  });

  it("read the front matter after a byte order mark and with Windows line endings", () => {
    expect(parseRule("\uFEFF---\r\npaths: a/**\r\n---\r\nbody\r\n")).toEqual({
      body: "body\r\n",
      paths: ["a/**"],
    });
    expect(parseRule("---\n---\nbody")).toEqual({ body: "body", paths: null });
    expect(parseRule("---\npaths: a\n...\nbody")).toEqual({ body: "body", paths: ["a"] });
  });

  it("do not count as the project's instructions, so the project is still reported as bare", async () => {
    const f = fixture();
    f.write(".claude/rules/only.md", "---\npaths: src/**\n---\nbody\n");
    const preview = await f.resolve();
    expect(preview.sections.map((section) => section.scope)).toEqual(["conditional"]);
    expect(preview.warnings).toContain(NO_PROJECT);
  });

  it("are not instructions the Doctor can match", async () => {
    const f = fixture();
    f.write(
      ".agentkib/manifest.yaml",
      "schema_version: 2\nworkspace:\n  id: fixture\n  name: Fixture\ninstructions:\n  shared: |\n    Use tabs.\n",
    );
    f.write("CLAUDE.md", "something unrelated\n");
    // The rule's pattern list happens to contain the manifest text; it must still not count.
    f.write(".claude/rules/only.md", "---\npaths: 'Use tabs.'\n---\nUse tabs.\n");
    const report = await new Doctor(f.context, () => f.project).report("fixture");
    expect(
      report.issues.filter((issue) => issue.agent === "claude-code").map((issue) => issue.code),
    ).toEqual(["instruction.expected-content-missing"]);
  });

  it("let the Doctor find manifest text that sits in a nested rule file", async () => {
    // The rules folder is read recursively now, and the Doctor sees what the preview shows.
    const f = fixture();
    f.write(
      ".agentkib/manifest.yaml",
      "schema_version: 2\nworkspace:\n  id: fixture\n  name: Fixture\ninstructions:\n  shared: |\n    Use tabs.\n",
    );
    f.write("CLAUDE.md", "something unrelated\n");
    f.write(".claude/rules/team/style.md", "Use tabs.\n");
    const report = await new Doctor(f.context, () => f.project).report("fixture");
    expect(
      report.issues.filter((issue) => issue.agent === "claude-code").map((issue) => issue.code),
    ).toEqual([]);
  });

  it("are listed for the user's rules too, before the project's", async () => {
    const f = fixture();
    f.write(".claude/rules/p.md", "---\npaths: p/**\n---\nbody\n");
    f.user("rules/u.md", "---\npaths: u/**\n---\nbody\n");
    const preview = await f.resolve();
    expect(sections(preview)).toEqual([
      ["conditional", "paths:\n- u/**\n"],
      ["conditional", "paths:\n- p/**\n"],
    ]);
  });
});

describe("limits on a rules folder", () => {
  it("reads at most 64 files of the user's and says that the rest were not read", async () => {
    const f = fixture();
    for (let index = 0; index < 65; index++)
      f.user(`rules/r${String(index).padStart(3, "0")}.md`, `rule ${index}\n`);
    const preview = await f.resolve();
    expect(preview.sections).toHaveLength(64);
    expect(preview.sections.at(-1)!.content).toBe("rule 63\n");
    expect(preview.warnings).toContain(
      "Note: Rule files in User rules exceed the preview limits (64 files, 8 folder levels); the rest were not read.",
    );
  });

  it("reads folders down to eight levels for the user's rules", async () => {
    const f = fixture();
    const nest = (depth: number) =>
      Array.from({ length: depth }, (_, index) => `n${index}`).join("/");
    f.user(`rules/${nest(8)}/in.md`, "eight\n");
    f.user(`rules/${nest(9)}/out.md`, "nine\n");
    const preview = await f.resolve();
    expect(preview.sections.map((section) => section.content)).toEqual(["eight\n"]);
    expect(preview.warnings.some((warning) => warning.includes("8 folder levels"))).toBe(true);
  });

  it("lists at most 512 folders, however wide the tree is", async () => {
    // 30 folders with 30 folders each: no single folder is large, but the whole tree is.
    const f = fixture();
    for (let outer = 0; outer < 30; outer++)
      for (let inner = 0; inner < 30; inner++)
        f.mkdir(f.inHome(".claude", "rules", `a${outer}`, `b${inner}`));
    f.user("rules/a0/b0/deep.md", "first rule\n");
    f.user("rules/z-last.md", "last rule\n");
    const preview = await f.resolve();
    expect(preview.warnings.some((warning) => warning.includes("exceed the preview limits"))).toBe(
      true,
    );
    expect(preview.sections.map((section) => section.content)).toContain("first rule\n");
  });

  it("does not report a limit when there is none to report", async () => {
    const f = fixture();
    for (let index = 0; index < 64; index++) f.user(`rules/r${index}.md`, "x\n");
    const preview = await f.resolve();
    expect(preview.sections).toHaveLength(64);
    expect(preview.warnings.some((warning) => warning.includes("exceed the preview limits"))).toBe(
      false,
    );
  });
});

describe("links inside a rules folder", () => {
  symlinks("are followed, and the file keeps the place where it is linked", async () => {
    const f = fixture();
    f.write("shared/style.md", "shared style\n");
    f.link(f.at("shared", "style.md"), ".claude/rules/style.md");
    f.link(f.at("shared"), ".claude/rules/team");
    const preview = await f.resolve();
    expect(sections(preview)).toEqual([
      [".claude/rules", "shared style\n"],
      [".claude/rules/team", "shared style\n"],
    ]);
    expect(preview.sections[1]!.source).toBe(f.at(".claude", "rules", "team", "style.md"));
    expect(preview.warnings).toEqual([]);
  });

  symlinks("do not loop when a folder links back to one above it", async () => {
    const f = fixture();
    f.write(".claude/rules/one.md", "one\n");
    f.link(f.at(".claude", "rules"), ".claude/rules/again");
    f.link(f.at(".claude"), ".claude/rules/up");
    const preview = await f.resolve();
    expect(preview.sections.map((section) => section.content)).toEqual(["one\n"]);
  });

  symlinks("are skipped when they are broken", async () => {
    const f = fixture();
    f.write(".claude/rules/ok.md", "ok\n");
    f.link(f.at("missing.md"), ".claude/rules/broken.md");
    const preview = await f.resolve();
    expect(preview.sections.map((section) => section.content)).toEqual(["ok\n"]);
  });
});

describe("imports in the user's own files", () => {
  it("are trusted: no approval note, but still filtered and redacted", async () => {
    const f = fixture();
    f.write(f.inHome("shared.md"), "shared\npassword=hunter2\n");
    f.write(f.inHome(".npmrc"), "TOP-SECRET-BODY\n");
    f.user("CLAUDE.md", "@~/shared.md\n@~/.npmrc\n");
    const preview = await f.resolve();
    expect(preview.sections[0]!.content).toBe("shared\npassword=[REDACTED]\n\n@~/.npmrc\n");
    expect(JSON.stringify(preview)).not.toContain("hunter2");
    expect(JSON.stringify(preview)).not.toContain("TOP-SECRET-BODY");
    expect(preview.warnings.some((warning) => warning.includes("asks for approval"))).toBe(false);
    expect(preview.warnings).toContain(
      `Note: Instruction import skipped (sensitive path): ${f.inHome(".npmrc")} (source: ${f.user("CLAUDE.md")})`,
    );
  });

  it("are not trusted in a project file, which gets the approval note", async () => {
    const f = fixture();
    f.write(f.inHome("shared.md"), "shared\n");
    f.write("CLAUDE.md", "@~/shared.md\n");
    const preview = await f.resolve();
    expect(preview.warnings.some((warning) => warning.includes("asks for approval"))).toBe(true);
  });
});
