import { symlinkSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultIo, type ClaudeIo } from "../../../packages/backend/src/context-claude-sources";
import { Doctor } from "../../../packages/backend/src/doctor";
import { contextFixture, type ContextFixture } from "./fixtures/claude-context";

// What each caller gets of the sources outside the workspace (managed policy, the user's own
// files, parent directories, auto memory, links that lead out):
// - the app and the CLI read them, filtered and redacted;
// - an Agent connected over MCP gets sizes and counts, no text and no path, whatever Agent the
//   connection URL names: they are personal, and must not reach another Agent;
// - the Doctor does not look at them at all, so they can never become a finding.
const symlinks = process.platform === "win32" ? it.skip : it;
const SETTINGS_NOT_READ =
  "Note: Claude Code settings are not read yet (claudeMdExcludes, the Project instructions choice, the autoMemoryDirectory and autoMemoryEnabled settings, managed claudeMd) and rules in parent directories are not read, so this list can differ from what Claude Code loads.";

const fixtures: ContextFixture[] = [];
function fixture(...args: Parameters<typeof contextFixture>) {
  const created = contextFixture(...args);
  fixtures.push(created);
  return created;
}
afterEach(() => {
  for (const created of fixtures.splice(0)) created.dispose();
});

const CANARIES = {
  managed: "MANAGED-CANARY\n",
  user: "USER-CANARY\n",
  userRule: "USER-RULE-CANARY\n",
  userConditional: "---\npaths: secret/**\n---\nUSER-CONDITIONAL-CANARY\n",
  parent: "PARENT-CANARY\n",
  memory: "MEMORY-CANARY\n",
  linked: "LINKED-CANARY\n",
} as const;
const bytes = (text: string) => Buffer.byteLength(text);

/** Every kind of outside source, each with a distinct canary. */
function seed(f: ContextFixture) {
  f.managed(CANARIES.managed);
  f.user("CLAUDE.md", CANARIES.user);
  f.user("rules/u.md", CANARIES.userRule);
  f.user("rules/c.md", CANARIES.userConditional);
  f.write(f.outside("CLAUDE.md"), CANARIES.parent);
  f.memory(CANARIES.memory);
  f.write("CLAUDE.md", "project text\n");
  if (process.platform !== "win32")
    f.link(f.write(f.outside("shared", "linked.md"), CANARIES.linked), ".claude/CLAUDE.md");
}
const everywhere = (f: ContextFixture) => [
  f.home,
  f.managedDir,
  f.memoryFile(),
  f.outside("shared"),
  path.dirname(f.memoryFile()),
];

describe("the MCP tool", () => {
  it("returns sizes and counts of every outside source, and none of their text or paths", async () => {
    const f = fixture();
    seed(f);
    const result = await f.mcp();
    const json = JSON.stringify(result);
    for (const canary of Object.values(CANARIES))
      for (const line of canary.split("\n").filter((row) => /CANARY/.test(row)))
        expect(json).not.toContain(line);
    for (const place of everywhere(f)) expect(json).not.toContain(place);
    expect(result.sections.map((section) => [section.scope, section.content])).toEqual([
      ["", "project text\n"],
    ]);
    expect(result.warnings).toEqual([
      `Note: Managed policy instructions exist (1 file, ${bytes(CANARIES.managed)} bytes); its content is not included in this result.`,
      `Note: User instructions exist (1 file, ${bytes(CANARIES.user)} bytes); its content is not included in this result.`,
      `Note: User rules exist (2 files, ${bytes(CANARIES.userRule) + bytes(CANARIES.userConditional)} bytes); its content is not included in this result.`,
      `Note: Parent-directory instruction files exist (1 file, ${bytes(CANARIES.parent)} bytes); its content is not included in this result.`,
      `Note: Auto memory (MEMORY.md) exists (1 file, ${bytes(CANARIES.memory)} bytes); its content is not included in this result.`,
      ...(process.platform === "win32"
        ? []
        : [
            `Note: External instruction sources exist (1 file, ${bytes(CANARIES.linked)} bytes); its content is not included in this result.`,
          ]),
      SETTINGS_NOT_READ,
    ]);
  });

  it("gives the app the same sources with their text", async () => {
    const f = fixture();
    seed(f);
    const result = await f.request();
    const scopes = result.sections.map((section) => section.scope);
    expect(scopes.slice(0, 3)).toEqual(["managed", "user", "user"]);
    expect(scopes).toContain("ancestor");
    expect(scopes).toContain("auto-memory");
    expect(scopes.at(-1)).toBe("conditional");
    const json = JSON.stringify(result);
    for (const canary of [CANARIES.managed, CANARIES.user, CANARIES.parent, CANARIES.memory])
      expect(json).toContain(canary.trim());
    // A rule with a `paths` field shows only its patterns, to every caller.
    expect(json).not.toContain("USER-CONDITIONAL-CANARY");
  });

  it("is the same for a connection that names another Agent in its URL", async () => {
    const f = fixture();
    seed(f);
    for (const agent of ["claude-code", "codex", "cursor", "opencode-other"]) {
      const result = await f
        .mcp(f.project, agent)
        .catch((error: Error) => ({ error: error.message }));
      const json = JSON.stringify(result);
      for (const canary of [CANARIES.managed, CANARIES.parent, CANARIES.memory, CANARIES.linked])
        expect(json).not.toContain(canary.trim());
      for (const place of everywhere(f)) expect(json).not.toContain(place);
    }
  });

  it("counts a file that is refused instead of naming it", async () => {
    const f = fixture();
    // The parent's file leads to a credentials folder, so it is counted as skipped.
    if (process.platform !== "win32")
      symlinkSync(f.write(f.inHome(".ssh", "notes.md"), "SSH-CANARY\n"), f.outside("CLAUDE.md"));
    f.write("CLAUDE.md", "project text\n");
    const result = await f.mcp();
    const json = JSON.stringify(result);
    expect(json).not.toContain("SSH-CANARY");
    expect(json).not.toContain(".ssh");
    expect(json).not.toContain("sensitive");
    if (process.platform !== "win32")
      expect(result.warnings).toContain(
        "Note: Parent-directory instruction files exist (0 files, 0 bytes, 1 skipped); its content is not included in this result.",
      );
  });

  it("says that MEMORY.md may be cut when it is longer than Claude Code reads", async () => {
    const f = fixture();
    f.memory(`${"m".repeat(25_000)}\n`);
    const long = await f.mcp();
    expect(long.warnings).toContain(
      "Note: Auto memory (MEMORY.md) exists (1 file, 25001 bytes, may be shortened); its content is not included in this result.",
    );
    f.memory(`${"m".repeat(24_999)}\n`);
    const fits = await f.mcp();
    expect(fits.warnings).toContain(
      "Note: Auto memory (MEMORY.md) exists (1 file, 25000 bytes); its content is not included in this result.",
    );
  });

  it("reads nothing of an outside file, only its size", async () => {
    const calls: { call: string; path: string }[] = [];
    const spy: ClaudeIo = {
      ...defaultIo,
      readFile(file, limit) {
        calls.push({ call: "readFile", path: file });
        return defaultIo.readFile(file, limit);
      },
    };
    const f = fixture({ io: spy });
    seed(f);
    await f.mcp();
    const reads = calls.map((call) => call.path);
    // Only the project's own files are opened.
    expect(reads.every((file) => file.startsWith(f.project + path.sep))).toBe(true);
  });

  it("returns what it always did when nothing exists outside the workspace", async () => {
    const f = fixture();
    f.write("CLAUDE.md", "project\n@docs/a.md\n");
    f.write("docs/a.md", "alpha\n");
    f.write(".claude/rules/r.md", "rule\n");
    const mcp = await f.mcp();
    const app = await f.request();
    const doctor = await f.resolve(f.project, { includeOutsideSources: false });
    expect(mcp.sections).toEqual(app.sections);
    expect(doctor.sections).toEqual(app.sections);
    expect(mcp.warnings).toEqual([]);
    expect(app.warnings).toEqual([]);
    expect(doctor.warnings).toEqual([]);
  });
});

describe("the Doctor", () => {
  const manifest = [
    "schema_version: 2",
    "workspace:",
    "  id: fixture",
    "  name: Fixture",
    "instructions:",
    "  shared: |",
    "    Use tabs for indentation.",
    "",
  ].join("\n");
  const issuesOf = async (f: ContextFixture) =>
    (await new Doctor(f.context, () => f.project).report("fixture")).issues.filter(
      (issue) => issue.agent === "claude-code",
    );

  it("does not change its answer because a parent directory has a CLAUDE.md", async () => {
    const f = fixture();
    f.write(".agentkib/manifest.yaml", manifest);
    f.claude("2.1.296 (Claude Code)");
    f.write("AGENTS.md", "Use tabs for indentation.\n");
    const alone = await issuesOf(f);
    f.write(f.outside("CLAUDE.md"), "Something else entirely.\n");
    const withParent = await issuesOf(f);
    expect(withParent).toEqual(alone);
    expect(withParent.map((issue) => issue.code)).not.toContain("instruction.missing");
    expect(withParent.map((issue) => issue.code)).not.toContain(
      "instruction.expected-content-missing",
    );
    // The Context page, on the same folder, reads the parent's file and not AGENTS.md.
    const page = await f.request();
    expect(page.sections.map((section) => section.scope)).toEqual(["ancestor"]);
    expect(page.warnings).toContain(SETTINGS_NOT_READ);
  });

  it("does not call a parent's or the user's file a duplicate of the project's", async () => {
    const f = fixture();
    f.write(".agentkib/manifest.yaml", manifest);
    f.write("CLAUDE.md", "Use tabs for indentation.\n");
    f.write(f.outside("CLAUDE.md"), "Use tabs for indentation.\n");
    f.user("CLAUDE.md", "Use tabs for indentation.\n");
    f.managed("Use tabs for indentation.\n");
    expect((await issuesOf(f)).map((issue) => issue.code)).toEqual([]);
  });

  it("never touches an outside source", async () => {
    const calls: { call: string; path: string }[] = [];
    const record =
      <A extends unknown[], R>(call: string, fn: (file: string, ...rest: A) => R) =>
      (file: string, ...rest: A): R => {
        calls.push({ call, path: file });
        return fn(file, ...rest);
      };
    const spy: ClaudeIo = {
      lstat: record("lstat", defaultIo.lstat),
      readlink: record("readlink", defaultIo.readlink),
      realpath: record("realpath", defaultIo.realpath),
      readdir: record("readdir", defaultIo.readdir),
      readFile: record("readFile", defaultIo.readFile),
    };
    const f = fixture({ io: spy });
    f.write(".agentkib/manifest.yaml", manifest);
    seed(f);
    await issuesOf(f);
    const inside = (file: string) => file === f.project || file.startsWith(f.project + path.sep);
    // Nothing outside the project is read or listed, and the only outside paths looked at are
    // the targets of links inside the project (to see that they lead out).
    expect(
      calls.filter((call) => ["readFile", "readdir"].includes(call.call) && !inside(call.path)),
    ).toEqual([]);
    for (const place of [f.home, f.managedDir, path.dirname(f.memoryFile())])
      expect(calls.filter((call) => call.path.startsWith(place))).toEqual([]);
    expect(calls.some((call) => call.path === f.outside("CLAUDE.md"))).toBe(false);
    expect(
      calls.some(
        (call) =>
          call.path.startsWith(f.outside("shared")) &&
          call.call !== "realpath" &&
          call.call !== "lstat",
      ),
    ).toBe(false);
  });

  symlinks(
    "refuses a folder that leads out of the project without listing or reading it",
    async () => {
      const calls: { call: string; path: string }[] = [];
      const spy: ClaudeIo = {
        ...defaultIo,
        readdir(file) {
          calls.push({ call: "readdir", path: file });
          return defaultIo.readdir(file);
        },
        readFile(file, limit) {
          calls.push({ call: "readFile", path: file });
          return defaultIo.readFile(file, limit);
        },
      };
      const f = fixture({ io: spy });
      f.write(".agentkib/manifest.yaml", manifest);
      f.write(f.outside("dotfiles", "claude", "CLAUDE.md"), "DOTFILES-CANARY\n");
      f.write(f.outside("dotfiles", "claude", "rules", "x.md"), "RULE-CANARY\n");
      f.link(f.outside("dotfiles", "claude"), ".claude");
      const issues = await issuesOf(f);
      expect(JSON.stringify(issues)).not.toContain("CANARY");
      expect(calls.filter((call) => !call.path.startsWith(f.project))).toEqual([]);
      const refusals = issues
        .filter((issue) => issue.code === "context.warning")
        .map((issue) => issue.evidence[0]!.detail);
      expect(refusals).toContain(
        `Instruction source skipped (outside the project): ${f.at(".claude", "CLAUDE.md")}`,
      );
      expect(refusals).toContain(
        `Instruction source skipped (outside the project): ${f.at(".claude", "rules")}`,
      );
    },
  );

  symlinks(
    "passes over a folder inside the rules that links out, which the other callers enter",
    async () => {
      const lists: string[] = [];
      const spy: ClaudeIo = {
        ...defaultIo,
        readdir(file) {
          lists.push(file);
          return defaultIo.readdir(file);
        },
      };
      const f = fixture({ io: spy });
      f.write(f.outside("team-rules", "shared.md"), "TEAM-RULE-CANARY\n");
      f.link(f.outside("team-rules"), ".claude/rules/team");
      f.write(".claude/rules/own.md", "own rule\n");
      const doctor = await f.resolve(f.project, { includeOutsideSources: false });
      expect(doctor.sections.map((section) => section.content)).toEqual(["own rule\n"]);
      expect(JSON.stringify(doctor)).not.toContain("TEAM-RULE-CANARY");
      expect(lists.filter((directory) => !directory.startsWith(f.project))).toEqual([]);
      expect(doctor.warnings.filter((warning) => !warning.startsWith("Note: "))).toEqual([]);
      // The app reads it as an outside rule, noted; the MCP tool only counts it.
      const app = await f.resolve();
      expect(app.sections.map((section) => section.content)).toEqual([
        "own rule\n",
        "TEAM-RULE-CANARY\n",
      ]);
      const mcp = await f.mcp();
      expect(JSON.stringify(mcp)).not.toContain("TEAM-RULE-CANARY");
      expect(mcp.warnings).toContain(
        "Note: External instruction sources exist (1 file, 17 bytes); its content is not included in this result.",
      );
    },
  );

  it("asks for no outside source: the sections of the preview it uses are the project's only", async () => {
    const f = fixture();
    seed(f);
    const preview = await f.resolve(f.project, { includeOutsideSources: false });
    expect(
      preview.sections.every(
        (section) => !["managed", "user", "ancestor", "auto-memory"].includes(section.scope),
      ),
    ).toBe(true);
    expect(JSON.stringify(preview)).not.toContain("MANAGED-CANARY");
    expect(JSON.stringify(preview)).not.toContain("PARENT-CANARY");
    expect(JSON.stringify(preview)).not.toContain("MEMORY-CANARY");
    expect(JSON.stringify(preview)).not.toContain("USER-CANARY");
  });
});
