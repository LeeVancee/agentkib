import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeSections, stripBlockComments } from "../../../packages/backend/src/context-claude";
import { isProjectScope } from "../../../packages/backend/src/context-files";
import { Doctor } from "../../../packages/backend/src/doctor";
import { loadManifest } from "../../../packages/backend/src/manifest";
import { contextFixture, type ContextFixture } from "./fixtures/claude-context";
import { virtualIo } from "./fixtures/claude-virtual-io";

// Where Claude Code instructions come from and in which order they load
// (https://code.claude.com/docs/en/memory): organization policy, the user's own files, every
// directory from the file system root down to the working directory, then auto memory. Rules
// with a `paths` field load only when a matching file is read, so they are listed apart.
const SETTINGS_NOT_READ =
  "Note: Claude Code settings are not read yet (claudeMdExcludes, the Project instructions choice, the autoMemoryDirectory and autoMemoryEnabled settings, managed claudeMd) and rules in parent directories are not read, so this list can differ from what Claude Code loads.";
const HOME_FILE =
  "Note: ~/.claude/CLAUDE.md is listed as a parent-directory file because CLAUDE_CONFIG_DIR points to another folder. AgentKib does not count it when deciding on the AGENTS.md fallback; whether Claude Code does is not verified.";
const NO_PROJECT = "No project instruction file was found for this Agent";
const posix = process.platform === "win32" ? describe.skip : describe;

const fixtures: ContextFixture[] = [];
function fixture(...args: Parameters<typeof contextFixture>) {
  const created = contextFixture(...args);
  fixtures.push(created);
  return created;
}
afterEach(() => {
  for (const created of fixtures.splice(0)) created.dispose();
});
const shape = (preview: { sections: { source: string; scope: string }[] }) =>
  preview.sections.map((section) => [path.basename(section.source), section.scope]);
const contents = (preview: { sections: { content: string }[] }) =>
  preview.sections.map((section) => section.content);

describe("which sources are found, and in which order", () => {
  it("lists them from the broadest to the narrowest", async () => {
    const f = fixture();
    f.managed("managed policy\n");
    f.user("CLAUDE.md", "user instructions\n");
    f.user("rules/u.md", "user rule\n");
    f.user("rules/uc.md", "---\npaths: docs/**\n---\nuser conditional\n");
    f.write(f.outside("CLAUDE.md"), "parent directory\n");
    f.write("CLAUDE.md", "project\n");
    f.write(".claude/CLAUDE.md", "project dot claude\n");
    f.write(".claude/rules/c.md", "---\npaths: src/**/*.ts\n---\nproject conditional\n");
    f.write(".claude/rules/r.md", "project rule\n");
    f.write("CLAUDE.local.md", "project local\n");
    f.write("packages/app/CLAUDE.md", "app\n");
    f.memory("remembered\n", f.at("packages", "app"));
    const preview = await f.resolve(f.at("packages", "app"));
    expect(shape(preview)).toEqual([
      ["CLAUDE.md", "managed"],
      ["CLAUDE.md", "user"],
      ["u.md", "user"],
      ["CLAUDE.md", "ancestor"],
      ["CLAUDE.md", ""],
      ["CLAUDE.md", ".claude"],
      ["r.md", ".claude/rules"],
      ["CLAUDE.local.md", ""],
      ["CLAUDE.md", "packages/app"],
      ["MEMORY.md", "auto-memory"],
      ["uc.md", "conditional"],
      ["c.md", "conditional"],
    ]);
    expect(contents(preview)).toEqual([
      "managed policy\n",
      "user instructions\n",
      "user rule\n",
      "parent directory\n",
      "project\n",
      "project dot claude\n",
      "project rule\n",
      "project local\n",
      "app\n",
      "remembered\n",
      // A rule with a `paths` field is listed by its patterns and is not loaded at startup.
      "paths:\n- docs/**\n",
      "paths:\n- src/**/*.ts\n",
    ]);
    expect(preview.sections.map((section) => section.precedence)).toEqual(
      preview.sections.map((_, index) => index),
    );
  });

  it("reads the rules of every directory between the root and the working directory", async () => {
    const f = fixture();
    f.write(".claude/rules/root.md", "root rule\n");
    f.write("packages/.claude/rules/mid.md", "middle rule\n");
    f.write("packages/app/.claude/rules/app.md", "app rule\n");
    f.write("packages/other/.claude/rules/other.md", "a sibling, not on the path\n");
    const preview = await f.resolve(f.at("packages", "app"));
    expect(contents(preview)).toEqual(["root rule\n", "middle rule\n", "app rule\n"]);
  });

  it("keeps the files of one directory in the order CLAUDE.md, .claude/CLAUDE.md, rules, CLAUDE.local.md", async () => {
    const f = fixture();
    f.write("CLAUDE.local.md", "5 local");
    f.write(".claude/rules/a.md", "4 rule");
    f.write(".claude/CLAUDE.md", "3 dot");
    f.write("CLAUDE.md", "2 main");
    const preview = await f.resolve();
    expect(contents(preview)).toEqual(["2 main\n", "3 dot\n", "4 rule\n", "5 local\n"]);
  });

  it("puts the user's rules after the user's CLAUDE.md and before any project file", async () => {
    const f = fixture();
    f.write("CLAUDE.md", "project\n");
    f.user("rules/b.md", "user b\n");
    f.user("rules/a.md", "user a\n");
    f.user("CLAUDE.md", "user main\n");
    const preview = await f.resolve();
    expect(contents(preview)).toEqual(["user main\n", "user a\n", "user b\n", "project\n"]);
  });

  it("reads every parent directory, the farthest first, and not the file system root", async () => {
    const fs = virtualIo({
      "/CLAUDE.md": "ROOT-BODY",
      "/.claude/CLAUDE.md": "ROOT-BODY",
      "/a/CLAUDE.md": "far\n",
      "/a/b/CLAUDE.local.md": "near local\n",
      "/a/b/CLAUDE.md": "near\n",
      "/a/b/w/CLAUDE.md": "workspace\n",
    });
    const sections = await claudeSections({
      root: "/a/b/w",
      cwd: "/a/b/w",
      dirs: ["/a/b/w"],
      environment: { HOME: "/home/u" },
      budget: { remaining: 100_000 },
      warnings: [],
      externalBodies: true,
      version: async () => null,
      managedDir: null,
      platform: "linux",
      io: fs.io,
    });
    expect(sections.map((section) => [section.scope, section.content])).toEqual([
      ["ancestor", "far\n"],
      ["ancestor", "near\n"],
      ["ancestor", "near local\n"],
      ["", "workspace\n"],
    ]);
    expect(JSON.stringify(sections)).not.toContain("ROOT-BODY");
    expect(
      fs.calls.some((entry) => ["/CLAUDE.md", "/CLAUDE.local.md", "/.claude"].includes(entry.path)),
    ).toBe(false);
  });

  it("checks only the nearest 32 parent directories and says so, even in the MCP mode", async () => {
    const parts = Array.from({ length: 40 }, (_, index) => `d${index}`);
    const root = `/${parts.join("/")}`;
    const fs = virtualIo({ "/d0/CLAUDE.md": "TOO-FAR", [`${root}/CLAUDE.md`]: "w\n" });
    const run = (externalBodies: boolean) => {
      const warnings: string[] = [];
      return claudeSections({
        root,
        cwd: root,
        dirs: [root],
        environment: { HOME: "/home/u" },
        budget: { remaining: 100_000 },
        warnings,
        externalBodies,
        version: async () => null,
        managedDir: null,
        platform: "linux",
        io: fs.io,
      }).then((sections) => ({ sections, warnings }));
    };
    const full = await run(true);
    expect(JSON.stringify(full.sections)).not.toContain("TOO-FAR");
    expect(full.warnings).toContain(
      "Note: Only the nearest 32 parent directories were checked for instruction files.",
    );
    expect((await run(false)).warnings).toContain(
      "Note: Only the nearest 32 parent directories were checked for instruction files.",
    );
  });
});

describe("a CLAUDE.md in a parent directory decides the AGENTS.md fallback", () => {
  it.each(["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"])(
    "reads the parent's %s and not AGENTS.md",
    async (name) => {
      const f = fixture();
      f.write("AGENTS.md", "agents\n");
      f.write(".claude/AGENTS.md", "agents in .claude\n");
      f.write(f.outside(name), "parent\n");
      const preview = await f.resolve();
      expect(preview.sections.map((section) => [section.scope, section.content])).toEqual([
        ["ancestor", "parent\n"],
      ]);
      // No version lookup is needed when the fallback does not apply. The settings note is there
      // because a file outside the workspace is part of the list, and a parent directory's file
      // is not a project file, so the project itself is still reported as having none.
      expect(preview.warnings).toEqual([SETTINGS_NOT_READ, NO_PROJECT]);
    },
  );

  it("still falls back when the parent has no CLAUDE file", async () => {
    const f = fixture();
    f.claude("2.1.296 (Claude Code)");
    f.write("AGENTS.md", "agents\n");
    f.write(f.outside("AGENTS.md"), "parent agents\n");
    const preview = await f.resolve();
    // The fallback reads AGENTS.md from every directory, nearest last.
    expect(preview.sections.map((section) => [section.scope, section.content])).toEqual([
      ["ancestor", "parent agents\n"],
      ["", "agents\n"],
    ]);
  });

  it("leaves the Doctor's view of the project as it was", async () => {
    const f = fixture();
    f.write("AGENTS.md", "agents\n");
    f.write(f.outside("CLAUDE.md"), "parent\n");
    const full = await f.resolve();
    expect(contents(full)).toEqual(["parent\n"]);
    const doctor = await f.resolve(f.project, { includeOutsideSources: false });
    expect(contents(doctor)).toEqual(["agents\n"]);
    expect(doctor.warnings.filter((warning) => !warning.startsWith("Note: "))).toEqual([
      expect.stringContaining("AGENTS.md may not be loaded"),
    ]);
  });
});

describe("the user's own CLAUDE.md and ~/.claude/CLAUDE.md", () => {
  // The home directory is made an ancestor of the project, so ~/.claude/CLAUDE.md is also the
  // `.claude/CLAUDE.md` of a parent directory.
  it("is the user's file once, and does not count for the fallback", async () => {
    const f = fixture();
    f.environment.HOME = f.root;
    f.environment.USERPROFILE = f.root;
    f.write(f.outside(".claude", "CLAUDE.md"), "user level\n");
    f.write("AGENTS.md", "agents\n");
    const preview = await f.resolve();
    expect(preview.sections.map((section) => [section.scope, section.content])).toEqual([
      ["user", "user level\n"],
      ["", "agents\n"],
    ]);
  });

  it("is a parent directory's file when CLAUDE_CONFIG_DIR points elsewhere, and still does not count", async () => {
    const f = fixture();
    f.environment.HOME = f.root;
    f.environment.USERPROFILE = f.root;
    f.environment.CLAUDE_CONFIG_DIR = f.outside("cfg");
    f.write(f.outside("cfg", "CLAUDE.md"), "configured user level\n");
    f.write(f.outside(".claude", "CLAUDE.md"), "home dot claude\n");
    f.write("AGENTS.md", "agents\n");
    const preview = await f.resolve();
    expect(preview.sections.map((section) => [section.scope, section.content])).toEqual([
      ["user", "configured user level\n"],
      ["ancestor", "home dot claude\n"],
      ["", "agents\n"],
    ]);
    expect(preview.warnings).toContain(HOME_FILE);
  });

  it("is not mistaken for the user's file when it is another directory's CLAUDE.md", async () => {
    const f = fixture();
    f.user("CLAUDE.md", "user level\n");
    f.write("AGENTS.md", "agents\n");
    f.write(f.outside("CLAUDE.md"), "parent\n");
    const preview = await f.resolve();
    expect(contents(preview)).toEqual(["user level\n", "parent\n"]);
  });
});

describe("managed policy", () => {
  it("comes first and loses its block comments", async () => {
    const f = fixture();
    f.managed("<!-- internal note -->\nOrganization policy\n");
    f.write("CLAUDE.md", "project\n");
    const preview = await f.resolve();
    expect(preview.sections.map((section) => [section.scope, section.content])).toEqual([
      ["managed", "Organization policy\n"],
      ["", "project\n"],
    ]);
  });

  it("is looked for in the platform's own folder", async () => {
    const seen: string[] = [];
    for (const [platform, expected] of [
      ["darwin", "/Library/Application Support/ClaudeCode/CLAUDE.md"],
      ["linux", "/etc/claude-code/CLAUDE.md"],
      ["freebsd", null],
    ] as const) {
      const fs = virtualIo(expected ? { [expected]: "policy\n" } : {});
      const sections = await claudeSections({
        root: "/w",
        cwd: "/w",
        dirs: ["/w"],
        environment: { HOME: "/home/u" },
        budget: { remaining: 100_000 },
        warnings: [],
        externalBodies: true,
        version: async () => null,
        platform,
        io: fs.io,
      });
      seen.push(`${platform}:${sections.map((section) => section.scope).join(",")}`);
    }
    expect(seen).toEqual(["darwin:managed", "linux:managed", "freebsd:"]);
  });

  it("is looked for on Windows under Program Files", async () => {
    const file = "C:\\Program Files\\ClaudeCode\\CLAUDE.md";
    const fs = virtualIo({ [file]: "policy\n", "C:\\w\\CLAUDE.md": "w\n" }, "win32");
    const sections = await claudeSections({
      root: "C:\\w",
      cwd: "C:\\w",
      dirs: ["C:\\w"],
      environment: { HOME: "C:\\Users\\u", USERPROFILE: "C:\\Users\\u" },
      budget: { remaining: 100_000 },
      warnings: [],
      externalBodies: true,
      version: async () => null,
      platform: "win32",
      io: fs.io,
    });
    expect(sections.map((section) => [section.source, section.scope])).toEqual([
      [file, "managed"],
      ["C:\\w\\CLAUDE.md", ""],
    ]);
  });
});

describe("block-level HTML comments", () => {
  it.each([
    ["a single-line comment", "a\n<!-- note -->\nb\n", "a\nb\n"],
    ["a comment with indentation up to three spaces", "a\n   <!-- note -->\nb\n", "a\nb\n"],
    ["a multi-line comment", "a\n<!--\nnote\nmore\n-->\nb\n", "a\nb\n"],
    ["a comment that ends with white space after it", "a\n<!-- n -->  \nb\n", "a\nb\n"],
    ["two comments", "<!-- 1 -->\nx\n<!-- 2 -->\n", "x\n"],
    ["a file that is only a comment", "<!-- only -->\n", ""],
    ["Windows line endings", "a\r\n<!-- note -->\r\nb\r\n", "a\r\nb\r\n"],
  ])("removes %s", (_name, input, expected) => {
    expect(stripBlockComments(input)).toBe(expected);
  });

  it.each([
    ["a comment inside a fenced code block", "```\n<!-- keep -->\n```\n"],
    ["a comment inside a tilde fence", "~~~md\n<!--\nkeep\n-->\n~~~\n"],
    ["an inline comment", "text <!-- keep --> more\n"],
    ["a comment indented by four spaces", "    <!-- keep -->\n"],
    ["a comment that is never closed", "a\n<!-- never closed\nb\n"],
    ["a comment with text after its end", "<!-- note --> text after\n"],
    ["a comment that ends with text after it on a later line", "<!-- a\nb --> trailing\n"],
    ["an opening that is on a line of its own after an inline one", "x <!--\n-->\n"],
  ])("keeps %s", (_name, input) => {
    expect(stripBlockComments(input)).toBe(input);
  });

  it("is safe to apply twice", () => {
    for (const input of [
      "a\n<!-- x -->\nb\n",
      "<!--\n```\n-->\n```\n<!-- y -->\n```\n",
      "<!-- a\n<!-- b -->\nc\n",
      "<!-- a --> t\n<!-- b -->\n",
      "no comments\n",
      "",
    ])
      expect(stripBlockComments(stripBlockComments(input))).toBe(stripBlockComments(input));
  });

  it("applies to CLAUDE.md, .claude/CLAUDE.md, CLAUDE.local.md and the user's and parent's files", async () => {
    const f = fixture();
    f.user("CLAUDE.md", "<!-- c -->\nuser\n");
    f.write(f.outside("CLAUDE.md"), "<!-- c -->\nparent\n");
    f.write("CLAUDE.md", "<!-- c -->\nmain\n");
    f.write(".claude/CLAUDE.md", "<!-- c -->\ndot\n");
    f.write("CLAUDE.local.md", "<!-- c -->\nlocal\n");
    const preview = await f.resolve();
    expect(contents(preview)).toEqual(["user\n", "parent\n", "main\n", "dot\n", "local\n"]);
  });

  it("does not apply to the AGENTS.md fallback, rule files or imported files", async () => {
    const f = fixture();
    f.claude("2.1.296 (Claude Code)");
    f.write("AGENTS.md", "<!-- agents -->\nagents\n");
    f.write(".claude/rules/r.md", "<!-- rule -->\nrule\n");
    const fallback = await f.resolve();
    expect(contents(fallback)).toEqual(["<!-- agents -->\nagents\n", "<!-- rule -->\nrule\n"]);
    f.write("CLAUDE.md", "@notes.md\n");
    f.write("notes.md", "<!-- imported -->\nnotes\n");
    const imported = await f.resolve();
    expect(imported.sections[0]!.content).toBe("<!-- imported -->\nnotes\n\n");
  });

  it("removes a comment before the imports are looked for, so an import inside it is not expanded", async () => {
    const f = fixture();
    f.write("CLAUDE.md", "<!--\n@notes.md\n-->\n@notes.md\n");
    f.write("notes.md", "notes\n");
    const preview = await f.resolve();
    expect(contents(preview)).toEqual(["notes\n\n"]);
  });

  it("keeps the preview in step with the manifest text that AgentKib wrote into CLAUDE.md", async () => {
    const override = "<!-- agentkib:start -->\nPrefer small diffs.\n<!-- agentkib:end -->";
    const f = fixture();
    f.write(
      ".agentkib/manifest.yaml",
      [
        "schema_version: 2",
        "workspace:",
        "  id: fixture",
        "  name: Fixture",
        "instructions:",
        "  shared: |",
        "    <!-- agentkib:shared -->",
        "    Use tabs.",
        "    <!-- agentkib:end -->",
        "  platform_overrides:",
        "    claude-code: |",
        ...override.split("\n").map((line) => `      ${line}`),
        "",
      ].join("\n"),
    );
    f.write(
      "CLAUDE.md",
      `<!-- agentkib:shared -->\nUse tabs.\n<!-- agentkib:end -->\n${override}\n`,
    );
    // The Context page: the override is already there once comments are ignored on both sides.
    const preview = await f.request();
    expect(preview.sections.map((section) => section.scope)).toEqual([""]);
    expect(preview.warnings).toEqual([]);
    // The Doctor: neither the shared text nor the override is reported as missing.
    const report = await new Doctor(f.context, () => f.project).report("fixture");
    expect(
      report.issues.filter((issue) => issue.agent === "claude-code").map((issue) => issue.code),
    ).toEqual([]);
  });

  it("does not make the Doctor report text that Claude Code's real layout carries through an import", async () => {
    // AgentKib writes the shared instructions into a managed block of AGENTS.md, and CLAUDE.md
    // imports it with `@AGENTS.md` next to the platform override. The import is not stripped,
    // CLAUDE.md itself is, so the two sides only match when both are compared without comments.
    const shared = [
      "<!-- agentkib:shared:start -->",
      "Use tabs.",
      "<!-- a note",
      "over two lines -->",
      "```text",
      "<!-- kept inside a fence -->",
      "```",
      "<!-- agentkib:shared:end -->",
    ];
    const override = [
      "<!-- agentkib:override:start -->",
      "Prefer small diffs.",
      "<!-- agentkib:override:end -->",
    ];
    const indent = (rows: string[], spaces: number) => rows.map((row) => " ".repeat(spaces) + row);
    const f = fixture();
    f.write(
      ".agentkib/manifest.yaml",
      [
        "schema_version: 2",
        "workspace:",
        "  id: fixture",
        "  name: Fixture",
        "instructions:",
        "  shared: |",
        ...indent(shared, 4),
        "  platform_overrides:",
        "    claude-code: |",
        ...indent(override, 6),
        "",
      ].join("\n"),
    );
    // The manifest itself must load, or the checks below would see nothing at all.
    expect(loadManifest(f.project).instructions.shared).toBe(`${shared.join("\n")}\n`);
    f.write("AGENTS.md", `${shared.join("\n")}\n`);
    f.write("CLAUDE.md", `@AGENTS.md\n\n${override.join("\n")}\n`);
    const report = await new Doctor(f.context, () => f.project).report("fixture");
    expect(
      report.issues.filter((issue) => issue.agent === "claude-code").map((issue) => issue.code),
    ).toEqual([]);
    // The Context page agrees: nothing is added for an override that is already there.
    expect((await f.request()).sections.map((section) => section.scope)).toEqual([""]);
  });

  it("counts two CLAUDE.md files that differ only in comments as duplicates in the Doctor", async () => {
    const f = fixture();
    f.write(
      ".agentkib/manifest.yaml",
      "schema_version: 2\nworkspace:\n  id: fixture\n  name: Fixture\n",
    );
    f.write("CLAUDE.md", "<!-- one -->\nsame text\n");
    f.write(".claude/CLAUDE.md", "<!-- two -->\nsame text\n");
    const report = await new Doctor(f.context, () => f.project).report("fixture");
    expect(
      report.issues.filter((issue) => issue.agent === "claude-code").map((issue) => issue.code),
    ).toEqual(["instruction.exact-duplicate"]);
  });
});

describe("a project directory named like a source kind", () => {
  it.each(["user", "managed", "ancestor", "conditional"])(
    "keeps %s/CLAUDE.md a project source",
    async (name) => {
      const f = fixture();
      f.write(`${name}/CLAUDE.md`, "inside\n");
      const preview = await f.resolve(f.at(name));
      expect(preview.sections.map((section) => section.scope)).toEqual([`./${name}`]);
      expect(preview.warnings).not.toContain(NO_PROJECT);
    },
  );

  it("tells the sentinels from the directories for Claude Code only", () => {
    for (const scope of ["managed", "user", "ancestor", "auto-memory", "conditional"])
      expect(isProjectScope("claude-code", scope)).toBe(false);
    for (const scope of ["", "src", "./user", "user/app", ".claude/rules"])
      expect(isProjectScope("claude-code", scope)).toBe(true);
    // Other Agents have only the Agent Home as an exception, so a folder named `user` is theirs.
    expect(isProjectScope("codex", "user")).toBe(true);
    expect(isProjectScope("codex", "agent-home")).toBe(false);
    expect(isProjectScope("claude-code", "agent-home")).toBe(false);
  });

  it("does not turn a folder named user into a non-project source for Codex", async () => {
    const f = fixture();
    f.write("user/AGENTS.md", "codex rules\n");
    const preview = await f.context.resolve(f.project, f.at("user"), "codex", null, []);
    expect(preview.sections.map((section) => section.scope)).toEqual(["user"]);
    expect(preview.warnings).not.toContain(NO_PROJECT);
  });
});

describe("the budget for sources outside the workspace", () => {
  const big = (label: string) => `${label}${"x".repeat(131_072 - label.length)}`;

  it("is separate, so project files are never crowded out", async () => {
    const f = fixture();
    f.managed(big("M"));
    f.user("CLAUDE.md", big("U"));
    f.write(f.outside("CLAUDE.md"), "parent that no longer fits\n");
    f.write("CLAUDE.md", "project\n");
    const preview = await f.resolve();
    expect(preview.sections.map((section) => section.scope)).toEqual(["managed", "user", ""]);
    expect(preview.sections.at(-1)!.content).toBe("project\n");
    expect(preview.warnings).toContain(
      "Note: The budget for instruction sources outside the workspace (256 Ki characters) was used up; later sources were not read.",
    );
    // The project's own budget message is not used for them.
    expect(preview.warnings.some((warning) => warning.startsWith("Resolved project"))).toBe(false);
  });

  it("truncates one oversized file and says which", async () => {
    const f = fixture();
    const file = f.user("CLAUDE.md", `${"y".repeat(131_073)}\n`);
    const preview = await f.resolve();
    expect(preview.sections[0]!.content.length).toBeLessThan(131_074);
    expect(preview.warnings).toContain(
      `Note: Instruction file exceeds the preview limit and was truncated: ${file}`,
    );
  });
});

posix("outside sources are read only", () => {
  it("leaves every file in the tree as it found it", async () => {
    const f = fixture();
    f.managed("managed\n");
    f.user("CLAUDE.md", "user\n");
    f.user("rules/r.md", "rule\n");
    f.write(f.outside("CLAUDE.md"), "parent\n");
    f.memory("memory\n");
    f.write("CLAUDE.md", "project\n");
    const snapshot = () => {
      const out: string[] = [];
      const walk = (directory: string) => {
        for (const name of readdirSync(directory).sort()) {
          const full = path.join(directory, name);
          const stat = statSync(full);
          out.push(`${full} ${stat.isDirectory() ? "d" : stat.size} ${stat.mtimeMs}`);
          if (stat.isDirectory()) walk(full);
        }
      };
      walk(f.root);
      return out;
    };
    const before = snapshot();
    await f.resolve();
    await f.request();
    await f.mcp();
    await f.resolve(f.project, { includeOutsideSources: false });
    expect(snapshot()).toEqual(before);
  });
});
