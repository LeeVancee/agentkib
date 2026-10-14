import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contextFixture, type ContextFixture } from "./fixtures/claude-context";

// Settings that change which instructions Claude Code loads (memory page and settings reference):
// claudeMdExcludes, the managed claudeMd key, "Project instructions" (pluginConfigs of the
// built-in AGENTS.md plugin), autoMemoryEnabled and autoMemoryDirectory.

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
const json = (value: unknown) => JSON.stringify(value);
const user = (f: ContextFixture, value: unknown) => f.user("settings.json", json(value));
const project = (f: ContextFixture, value: unknown) =>
  f.write(".claude/settings.json", json(value));
const local = (f: ContextFixture, value: unknown) =>
  f.write(".claude/settings.local.json", json(value));
const managed = (f: ContextFixture, value: unknown) =>
  f.write(path.join(f.managedDir, "managed-settings.json"), json(value));
const names = (preview: { sections: { source: string; scope: string }[] }) =>
  preview.sections
    .filter((section) => section.scope !== "settings")
    .map((section) => `${path.basename(section.source)}:${section.scope}`);
const notes = (preview: { warnings: string[] }) => preview.warnings.join("\n");

describe("claudeMdExcludes", () => {
  it("leaves out user, project and local files whose absolute path matches, merging patterns across layers", async () => {
    const f = fixture();
    f.managed("managed\n");
    f.user("CLAUDE.md", "user\n");
    f.write("CLAUDE.md", "project\n");
    f.write("sub/CLAUDE.md", "sub\n");
    f.write("sub/CLAUDE.local.md", "sub local\n");
    user(f, { claudeMdExcludes: [f.inHome(".claude", "CLAUDE.md")] });
    // Both files are read from the working directory: there is no repository around it.
    f.write("sub/.claude/settings.json", json({ claudeMdExcludes: ["**/sub/CLAUDE.md"] }));
    f.write("sub/.claude/settings.local.json", json({ claudeMdExcludes: ["**/CLAUDE.local.md"] }));
    const preview = await f.resolve(f.at("sub"));
    expect(names(preview)).toEqual(["CLAUDE.md:managed", "CLAUDE.md:"]);
    expect(notes(preview)).toContain(
      `Note: Excluded by claudeMdExcludes: ${f.at("sub", "CLAUDE.md")}`,
    );
    expect(notes(preview)).toContain(
      `Excluded by claudeMdExcludes: ${f.inHome(".claude", "CLAUDE.md")}`,
    );
  });

  it("cannot exclude the managed policy file or the managed claudeMd text", async () => {
    const f = fixture();
    f.managed("managed file\n");
    managed(f, { claudeMd: "managed text\n", claudeMdExcludes: ["**/*.md", "**/*"] });
    f.write("CLAUDE.md", "project\n");
    const preview = await f.resolve();
    expect(names(preview)).toEqual([
      "CLAUDE.md:managed",
      "managed-settings.json (claudeMd):managed",
    ]);
  });

  it("lets AGENTS.md take over when the only CLAUDE.md is excluded, and excludes AGENTS.md too", async () => {
    const f = fixture();
    f.claude("2.1.300 (Claude Code)");
    f.write("CLAUDE.md", "claude\n");
    f.write("AGENTS.md", "agents\n");
    project(f, { claudeMdExcludes: [f.at("CLAUDE.md")] });
    expect(names(await f.resolve())).toEqual(["AGENTS.md:"]);
    project(f, { claudeMdExcludes: [f.at("CLAUDE.md"), f.at("AGENTS.md")] });
    expect(names(await f.resolve())).toEqual([]);
  });

  posix("when only the real path of a link matches", () => {
    it("keeps the file and says it may be excluded", async () => {
      const f = fixture();
      const target = f.write(f.outside("shared", "common.md"), "shared\n");
      f.link(target, "CLAUDE.md");
      project(f, { claudeMdExcludes: [target] });
      const preview = await f.resolve();
      expect(names(preview)).toEqual(["CLAUDE.md:"]);
      expect(notes(preview)).toContain("may be excluded by claudeMdExcludes");
    });
  });

  it("tells MCP how many outside files are excluded, but not which", async () => {
    const f = fixture();
    f.user("CLAUDE.md", "user text\n");
    f.write("CLAUDE.md", "project\n");
    user(f, { claudeMdExcludes: [f.inHome(".claude", "CLAUDE.md")] });
    const preview = await f.mcp();
    expect(notes(preview)).toContain(
      "1 instruction file outside the workspace is excluded by claudeMdExcludes and not listed.",
    );
    expect(JSON.stringify(preview)).not.toContain(f.home);
  });
});

describe("the managed claudeMd key", () => {
  it("loads like the managed CLAUDE.md: before the user's files, shown in the app", async () => {
    const f = fixture();
    f.user("CLAUDE.md", "user\n");
    f.write("CLAUDE.md", "project\n");
    managed(f, { claudeMd: "Always run lint.\n<!-- hidden -->\nNever push to main.\n" });
    const preview = await f.resolve();
    expect(names(preview)).toEqual([
      "managed-settings.json (claudeMd):managed",
      "CLAUDE.md:user",
      "CLAUDE.md:",
    ]);
    const section = preview.sections[0]!;
    expect(section.content).toContain("Always run lint.");
    expect(section.content).not.toContain("hidden");
  });

  it("is ignored in user, project and local settings", async () => {
    const f = fixture();
    f.write("CLAUDE.md", "project\n");
    user(f, { claudeMd: "USER-CLAUDEMD" });
    project(f, { claudeMd: "PROJECT-CLAUDEMD" });
    local(f, { claudeMd: "LOCAL-CLAUDEMD" });
    const preview = await f.resolve();
    expect(names(preview)).toEqual(["CLAUDE.md:"]);
    expect(
      JSON.stringify(preview.sections.filter((section) => section.scope !== "settings")),
    ).not.toContain("CLAUDEMD");
  });

  it("gives MCP its size only, and the Doctor nothing", async () => {
    const f = fixture();
    managed(f, { claudeMd: "MANAGED-TEXT-CANARY\n" });
    f.write("CLAUDE.md", "project\n");
    const mcp = await f.mcp();
    expect(JSON.stringify(mcp)).not.toContain("MANAGED-TEXT-CANARY");
    expect(notes(mcp)).toContain("Managed policy instructions exist (1 file, 20 bytes)");
    const doctor = await f.resolve(f.project, { includeOutsideSources: false });
    expect(JSON.stringify(doctor)).not.toContain("MANAGED-TEXT-CANARY");
    expect(names(doctor)).toEqual(["CLAUDE.md:"]);
  });

  it("does not stop the AGENTS.md fallback", async () => {
    const f = fixture();
    f.claude("2.1.300 (Claude Code)");
    f.write("AGENTS.md", "agents\n");
    managed(f, { claudeMd: "managed text\n" });
    expect(names(await f.resolve())).toEqual([
      "managed-settings.json (claudeMd):managed",
      "AGENTS.md:",
    ]);
  });
});

describe("Project instructions", () => {
  const choose = (value: string, id = "cc-plugin-agents-md@builtin") => ({
    pluginConfigs: { [id]: { options: { instructionFiles: value } } },
  });
  const seed = (f: ContextFixture) => {
    f.claude("2.1.300 (Claude Code)");
    f.managed("managed\n");
    f.user("CLAUDE.md", "user\n");
    f.memory("memory\n");
    f.write("CLAUDE.md", "claude\n");
    f.write("CLAUDE.local.md", "claude local\n");
    f.write("AGENTS.md", "agents\n");
  };

  it("claude-md-or-agents-md is the default: CLAUDE.md files win and AGENTS.md is not read", async () => {
    const f = fixture();
    seed(f);
    expect(names(await f.resolve())).toEqual([
      "CLAUDE.md:managed",
      "CLAUDE.md:user",
      "CLAUDE.md:",
      "CLAUDE.local.md:",
      "MEMORY.md:auto-memory",
    ]);
  });

  it("claude-md-and-agents-md reads AGENTS.md after the CLAUDE.md files of each directory", async () => {
    const f = fixture();
    seed(f);
    user(f, choose("claude-md-and-agents-md"));
    const preview = await f.resolve();
    expect(names(preview)).toEqual([
      "CLAUDE.md:managed",
      "CLAUDE.md:user",
      "CLAUDE.md:",
      "CLAUDE.local.md:",
      "AGENTS.md:",
      "MEMORY.md:auto-memory",
    ]);
    expect(notes(preview)).toContain(
      "Project instructions is set to claude-md-and-agents-md in the user settings",
    );
  });

  it("reads an AGENTS.md that a CLAUDE.md imports or links to only once", async () => {
    const f = fixture();
    f.claude("2.1.300 (Claude Code)");
    f.write("AGENTS.md", "SHARED-AGENTS\n");
    f.write("CLAUDE.md", "@AGENTS.md\nmore\n");
    user(f, choose("claude-md-and-agents-md"));
    let preview = await f.resolve();
    expect(names(preview)).toEqual(["CLAUDE.md:"]);
    expect(preview.sections[0]!.content.match(/SHARED-AGENTS/g)).toHaveLength(1);
    if (process.platform === "win32") return;
    const g = fixture();
    g.claude("2.1.300 (Claude Code)");
    g.write("AGENTS.md", "SHARED\n");
    g.link(g.at("AGENTS.md"), "CLAUDE.md");
    user(g, choose("claude-md-and-agents-md"));
    preview = await g.resolve();
    expect(names(preview)).toEqual(["CLAUDE.md:"]);
  });

  it("claude-md never reads AGENTS.md", async () => {
    const f = fixture();
    f.claude("2.1.300 (Claude Code)");
    f.write("AGENTS.md", "agents\n");
    user(f, choose("claude-md"));
    const preview = await f.resolve();
    expect(names(preview)).toEqual([]);
    expect(notes(preview)).toContain(
      "Project instructions is set to claude-md in the user settings: AGENTS.md is not read.",
    );
  });

  it("managed-only keeps the managed instructions and auto memory, nothing else", async () => {
    const f = fixture();
    seed(f);
    f.write(".claude/rules/r.md", "rule\n");
    f.user("rules/u.md", "user rule\n");
    managed(f, choose("managed-only"));
    const preview = await f.resolve();
    expect(names(preview)).toEqual(["CLAUDE.md:managed", "MEMORY.md:auto-memory"]);
    expect(notes(preview)).toContain(
      "Project instructions is set to managed-only in the managed settings",
    );
  });

  it("reads the old plugin id, prefers managed over user, and ignores project and local files", async () => {
    const f = fixture();
    seed(f);
    user(f, choose("claude-md-and-agents-md", "agents-md@builtin"));
    expect(names(await f.resolve())).toContain("AGENTS.md:");
    managed(f, choose("claude-md"));
    expect(names(await f.resolve())).not.toContain("AGENTS.md:");
    const g = fixture();
    seed(g);
    project(g, choose("managed-only"));
    local(g, choose("claude-md-and-agents-md"));
    const preview = await g.resolve();
    expect(names(preview)).toContain("CLAUDE.md:user");
    expect(names(preview)).not.toContain("AGENTS.md:");
    expect(notes(preview)).toContain(
      "The Project instructions setting in the local and project settings is ignored",
    );
  });

  it("falls back to the default for a value it does not know", async () => {
    const f = fixture();
    seed(f);
    user(f, choose("everything"));
    const preview = await f.resolve();
    expect(names(preview)).not.toContain("AGENTS.md:");
    expect(notes(preview)).toContain(
      "The Project instructions value in the settings is not one of",
    );
  });

  it("does not change what the Doctor sees", async () => {
    const f = fixture();
    seed(f);
    user(f, choose("managed-only"));
    const doctor = await f.resolve(f.project, { includeOutsideSources: false });
    expect(names(doctor)).toEqual(["CLAUDE.md:", "CLAUDE.local.md:"]);
  });
});

describe("auto memory settings", () => {
  it("autoMemoryEnabled=false from any layer switches the memory section off", async () => {
    const f = fixture();
    f.memory("remembered\n");
    f.write("CLAUDE.md", "p\n");
    expect(names(await f.resolve())).toContain("MEMORY.md:auto-memory");
    project(f, { autoMemoryEnabled: false });
    const preview = await f.resolve();
    expect(names(preview)).not.toContain("MEMORY.md:auto-memory");
    expect(notes(preview)).toContain("autoMemoryEnabled=false in the project settings");
    local(f, { autoMemoryEnabled: true });
    expect(names(await f.resolve())).toContain("MEMORY.md:auto-memory");
  });

  it("autoMemoryDirectory from user settings replaces the default folder, with ~/ expanded", async () => {
    const f = fixture();
    f.memory("DEFAULT-MEMORY\n");
    f.write(path.join(f.home, "notes", "MEMORY.md"), "CUSTOM-MEMORY\n");
    user(f, { autoMemoryDirectory: "~/notes" });
    const preview = await f.resolve();
    const memory = preview.sections.find((section) => section.scope === "auto-memory")!;
    expect(memory.content).toContain("CUSTOM-MEMORY");
    expect(memory.source).toBe(path.join(f.home, "notes", "MEMORY.md"));
    f.write(f.outside("abs", "MEMORY.md"), "ABSOLUTE-MEMORY\n");
    managed(f, { autoMemoryDirectory: f.outside("abs") });
    expect(
      (await f.resolve()).sections.find((section) => section.scope === "auto-memory")!.content,
    ).toContain("ABSOLUTE-MEMORY");
  });

  it("does not apply autoMemoryDirectory from a project or local file", async () => {
    const f = fixture();
    f.memory("DEFAULT-MEMORY\n");
    f.write(f.outside("chosen", "MEMORY.md"), "CHOSEN-BY-REPOSITORY\n");
    project(f, { autoMemoryDirectory: f.outside("chosen") });
    local(f, { autoMemoryDirectory: f.outside("chosen") });
    const preview = await f.resolve();
    const memory = preview.sections.find((section) => section.scope === "auto-memory")!;
    expect(memory.content).toContain("DEFAULT-MEMORY");
    expect(JSON.stringify(preview)).not.toContain("CHOSEN-BY-REPOSITORY");
    expect(notes(preview)).toContain(
      "autoMemoryDirectory in the local and project settings is not applied",
    );
  });

  it("rejects a relative or traversing autoMemoryDirectory and keeps the default", async () => {
    const f = fixture();
    f.memory("DEFAULT-MEMORY\n");
    user(f, { autoMemoryDirectory: "../elsewhere" });
    const preview = await f.resolve();
    expect(preview.sections.find((section) => section.scope === "auto-memory")!.content).toContain(
      "DEFAULT-MEMORY",
    );
    expect(notes(preview)).toContain(
      "autoMemoryDirectory must be an absolute path or start with ~/",
    );
  });

  it("gives MCP the size of the memory file at the configured place, not its text", async () => {
    const f = fixture();
    f.write(path.join(f.home, "notes", "MEMORY.md"), "CUSTOM-MEMORY\n");
    user(f, { autoMemoryDirectory: "~/notes" });
    const mcp = await f.mcp();
    expect(JSON.stringify(mcp)).not.toContain("CUSTOM-MEMORY");
    expect(notes(mcp)).toContain("Auto memory (MEMORY.md) exists (1 file, 14 bytes)");
  });
});

describe("variables a settings env block sets", () => {
  it("are named, because AgentKib reads them from its own environment only", async () => {
    const f = fixture();
    user(f, { env: { CLAUDE_CONFIG_DIR: "/somewhere", OTHER: "x" } });
    const preview = await f.resolve();
    expect(notes(preview)).toContain("The env block of a settings file sets CLAUDE_CONFIG_DIR.");
    expect(JSON.stringify(preview)).not.toContain("/somewhere");
  });
});
