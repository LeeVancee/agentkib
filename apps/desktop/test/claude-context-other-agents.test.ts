import { openSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultIo } from "../../../packages/backend/src/context-claude-sources";
import { contextFixture, type ContextFixture } from "./fixtures/claude-context";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, openSync: vi.fn(fs.openSync), readFileSync: vi.fn(fs.readFileSync) };
});

// OpenCode and Grok Build read Claude Code's personal folder (~/.claude) as well. The app shows
// what they would load, as before. An Agent connected over MCP gets only the number and size of
// those files, no text and no path, so it cannot read through AgentKib what is outside the
// workspace sandbox and private to the user.

const fixtures: ContextFixture[] = [];
function fixture() {
  const created = contextFixture();
  fixtures.push(created);
  return created;
}
afterEach(() => {
  for (const created of fixtures.splice(0)) created.dispose();
  vi.mocked(openSync).mockClear();
  vi.mocked(readFileSync).mockClear();
  vi.restoreAllMocks();
});
const symlinks = process.platform === "win32" ? it.skip : it;
const reads = () =>
  [...vi.mocked(openSync).mock.calls, ...vi.mocked(readFileSync).mock.calls].map(([file]) =>
    String(file),
  );
const app = (f: ContextFixture, agent: string) =>
  f.context.request({ project: f.project, cwd: f.project, agent });

describe("OpenCode", () => {
  function seed(f: ContextFixture) {
    f.user("CLAUDE.md", "PERSONAL-CANARY\n@~/.claude/imported.md\n");
    f.user("imported.md", "IMPORTED-CANARY\n");
    f.write("AGENTS.md", "project text\n");
  }

  it("still shows the personal file in the app", async () => {
    const f = fixture();
    seed(f);
    const preview = await app(f, "opencode");
    expect(preview.sections.map((section) => section.scope)).toEqual(["agent-home", ""]);
    expect(preview.sections[0]!.content).toContain("PERSONAL-CANARY");
    expect(preview.warnings.join("\n")).not.toContain("Claude Code user files");
  });

  it("returns only a count and a size over MCP, without text, imports or paths", async () => {
    const f = fixture();
    seed(f);
    const preview = await f.mcp(f.project, "opencode");
    const output = JSON.stringify(preview);
    for (const hidden of ["PERSONAL-CANARY", "IMPORTED-CANARY", f.home])
      expect(output).not.toContain(hidden);
    expect(preview.sections.map((section) => section.scope)).toEqual([""]);
    expect(preview.sections[0]!.content).toContain("project text");
    expect(preview.warnings).toContain(
      "Note: Claude Code user files that this Agent reads exist (1 file, 39 bytes); their content is not included in this result.",
    );
  });

  it("says nothing when there is no personal file", async () => {
    const f = fixture();
    f.write("AGENTS.md", "project text\n");
    expect((await f.mcp(f.project, "opencode")).warnings).toEqual([]);
  });

  it("leaves a personal file of its own (the OpenCode config folder) alone", async () => {
    const f = fixture();
    f.write(".config/opencode/AGENTS.md".replace(/^/, f.home + "/"), "OPENCODE-OWN\n");
    f.user("CLAUDE.md", "PERSONAL-CANARY\n");
    const preview = await f.mcp(f.project, "opencode");
    expect(JSON.stringify(preview)).not.toContain("PERSONAL-CANARY");
    expect(preview.sections.some((section) => section.content.includes("OPENCODE-OWN"))).toBe(true);
  });

  symlinks(
    "holds back personal files reached through an OpenCode directory alias before reading",
    async () => {
      const f = fixture();
      const personal = f.user("AGENTS.md", "CLAUDE-ALIAS-CANARY\n");
      f.link(f.inHome(".claude"), f.inHome(".config", "opencode"));
      f.write("AGENTS.md", "project\n");
      expect(JSON.stringify(await app(f, "opencode"))).toContain("CLAUDE-ALIAS-CANARY");
      vi.mocked(openSync).mockClear();
      const output = JSON.stringify(await f.mcp(f.project, "opencode"));
      expect(output).not.toContain("CLAUDE-ALIAS-CANARY");
      expect(output).not.toContain(f.home);
      expect(vi.mocked(openSync).mock.calls.map(([file]) => file)).not.toContain(personal);
    },
  );

  symlinks(
    "compares the canonical personal directory when both configuration folders are aliases",
    async () => {
      const f = fixture();
      const folder = f.mkdir(f.inHome("shared-instructions"));
      const personal = f.write(folder + "/AGENTS.md", "CANONICAL-PERSONAL-CANARY\n");
      f.link(folder, f.inHome(".claude"));
      f.link(folder, f.inHome(".config", "opencode"));
      f.write("AGENTS.md", "project\n");
      const output = JSON.stringify(await f.mcp(f.project, "opencode"));
      expect(output).not.toContain("CANONICAL-PERSONAL-CANARY");
      expect(output).not.toContain(f.home);
      expect(vi.mocked(openSync).mock.calls.map(([file]) => file)).not.toContain(personal);
    },
  );

  symlinks(
    "checks imported aliases even when the containing OpenCode instruction is allowed",
    async () => {
      const f = fixture();
      const folder = f.mkdir(f.inHome(".config", "opencode", "personal"));
      const personal = f.write(folder + "/notes.md", "IMPORTED-ALIAS-CANARY\n");
      f.link(folder, f.inHome(".claude"));
      f.write(f.inHome(".config", "opencode", "AGENTS.md"), "own text\n@personal/notes.md\n");
      f.write("AGENTS.md", "project\n");
      const preview = await f.mcp(f.project, "opencode");
      expect(JSON.stringify(preview)).not.toContain("IMPORTED-ALIAS-CANARY");
      expect(preview.sections[0]!.content).toContain("own text");
      expect(vi.mocked(openSync).mock.calls.map(([file]) => file)).not.toContain(personal);
    },
  );

  it("withholds bodies when the personal directory identity cannot be verified", async () => {
    const f = fixture();
    f.user("CLAUDE.md", "PERSONAL-CANARY\n");
    f.write("AGENTS.md", "project\n");
    const lstat = defaultIo.lstat;
    vi.spyOn(defaultIo, "lstat").mockImplementation((file) => {
      if (file === f.inHome(".claude"))
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      return lstat(file);
    });
    const preview = await f.mcp(f.project, "opencode");
    expect(preview.sections).toEqual([]);
    expect(preview.warnings.join("\n")).toContain("could not be checked");
    expect(JSON.stringify(preview)).not.toContain(f.home);
    expect(vi.mocked(openSync).mock.calls.map(([file]) => file)).not.toContain(f.at("AGENTS.md"));
    expect(JSON.stringify(await app(f, "opencode"))).toContain("PERSONAL-CANARY");
  });
});

describe("Grok Build", () => {
  it("shows ~/.claude in the app and holds it back over MCP", async () => {
    const f = fixture();
    f.user("CLAUDE.md", "GROK-PERSONAL-CANARY\n");
    f.write("AGENTS.md", "project text\n");
    const shown = await app(f, "grok-build");
    expect(JSON.stringify(shown)).toContain("GROK-PERSONAL-CANARY");
    vi.mocked(openSync).mockClear();
    const preview = await f.mcp(f.project, "grok-build");
    const output = JSON.stringify(preview);
    expect(output).not.toContain("GROK-PERSONAL-CANARY");
    expect(output).not.toContain(f.home);
    expect(preview.sections.some((section) => section.content.includes("project text"))).toBe(true);
    expect(preview.warnings.join("\n")).toContain(
      "Claude Code user files that this Agent reads exist (1 file, 21 bytes)",
    );
    expect(vi.mocked(openSync).mock.calls.map(([file]) => file)).not.toContain(
      f.inHome(".claude", "CLAUDE.md"),
    );
  });

  symlinks("holds back a personal directory reached through GROK_HOME", async () => {
    const f = fixture();
    const personal = f.user("AGENTS.md", "GROK-ALIAS-CANARY\n");
    f.link(f.inHome(".claude"), f.inHome("grok-alias"));
    f.environment.GROK_HOME = f.inHome("grok-alias");
    f.write("AGENTS.md", "project\n");
    const output = JSON.stringify(await f.mcp(f.project, "grok-build"));
    expect(output).not.toContain("GROK-ALIAS-CANARY");
    expect(output).not.toContain(f.home);
    expect(vi.mocked(openSync).mock.calls.map(([file]) => file)).not.toContain(personal);
  });
});

describe("DeepSeek Harness", () => {
  symlinks(
    "holds back the same personal file through a DSH_HOME alias before reading",
    async () => {
      const f = fixture();
      const personal = f.user("AGENTS.md", "DSH-ALIAS-CANARY\n");
      f.link(f.inHome(".claude"), f.inHome("dsh-alias"));
      f.environment.DSH_HOME = f.inHome("dsh-alias");
      f.write("AGENTS.md", "project\n");
      expect(JSON.stringify(await app(f, "deepseek-harness"))).toContain("DSH-ALIAS-CANARY");
      vi.mocked(openSync).mockClear();
      const output = JSON.stringify(await f.mcp(f.project, "deepseek-harness"));
      expect(output).not.toContain("DSH-ALIAS-CANARY");
      expect(output).not.toContain(f.home);
      expect(vi.mocked(openSync).mock.calls.map(([file]) => file)).not.toContain(personal);
    },
  );
});

describe.each([
  ["cursor", ".cursor", "mdc"],
  ["antigravity", ".agents", "md"],
])("%s rule discovery", (agent, folder, extension) => {
  symlinks("does not read personal front matter through a project directory alias", async () => {
    const f = fixture();
    f.user(`rules/personal.${extension}`, "---\nalwaysApply: true\n---\nPRIVATE-RULE-CANARY\n");
    f.link(f.inHome(".claude"), f.at(folder));
    f.write("AGENTS.md", "project\n");
    const preview = await f.mcp(f.project, agent);
    expect(JSON.stringify(preview)).not.toContain("PRIVATE-RULE-CANARY");
    expect(vi.mocked(openSync).mock.calls.map(([file]) => String(file))).not.toEqual(
      expect.arrayContaining([expect.stringContaining(`personal.${extension}`)]),
    );
    expect(preview.sections.some((section) => section.content.includes("project"))).toBe(true);
  });

  symlinks("does not read personal profile patches or expose personal skill names", async () => {
    const f = fixture();
    f.user("cordis.patch.yml", "agent-instructions: PRIVATE-PATCH-CANARY\n");
    f.user("profiles/active/cordis.patch.yml", "skill-filesystem: PRIVATE-PATCH-CANARY\n");
    f.user("skills/private-skill/SKILL.md", "PRIVATE-SKILL-CANARY\n");
    f.link(f.inHome(".claude"), f.inHome("dsh-alias"));
    f.environment.DSH_HOME = f.inHome("dsh-alias");
    f.write("AGENTS.md", "project\n");
    const preview = await f.mcp(f.project, "deepseek-harness");
    expect(reads().filter((file) => file.endsWith("cordis.patch.yml"))).toEqual([]);
    expect(preview.visible_skills).not.toContain("private-skill");
    expect(preview.warnings.join("\n")).not.toContain("custom instruction or Skill loading");
    expect(JSON.stringify(preview)).not.toContain(f.home);
  });
});

describe("personal configuration aliases", () => {
  symlinks(
    "does not parse OpenCode global or project instruction configuration aliases",
    async () => {
      const f = fixture();
      const config = f.user("opencode.json", JSON.stringify({ instructions: ["personal.md"] }));
      f.user("personal.md", "CONFIG-IMPORT-CANARY\n");
      f.link(f.inHome(".claude"), f.inHome(".config", "opencode"));
      f.link(config, f.at("opencode.json"));
      f.write("AGENTS.md", "project\n");
      const preview = await f.mcp(f.project, "opencode");
      expect(reads().filter((file) => file.endsWith("opencode.json"))).toEqual([]);
      expect(JSON.stringify(preview)).not.toContain("CONFIG-IMPORT-CANARY");
      expect(JSON.stringify(preview)).not.toContain(f.home);
    },
  );

  symlinks("does not parse personal Grok compatibility configuration", async () => {
    const f = fixture();
    f.user("config.toml", "[compat.claude]\nagents = false\n");
    f.link(f.inHome(".claude"), f.inHome(".grok"));
    f.write("AGENTS.md", "project\n");
    await f.mcp(f.project, "grok-build");
    expect(reads()).not.toContain(f.inHome(".grok", "config.toml"));
  });

  symlinks("does not parse personal Antigravity plugin manifests", async () => {
    const f = fixture();
    f.user("config/plugins/hidden/plugin.json", JSON.stringify({ name: "private-plugin" }));
    f.user("config/plugins/hidden/rules/context.md", "PRIVATE-PLUGIN-CANARY\n");
    f.link(f.inHome(".claude"), f.inHome(".gemini"));
    f.write("AGENTS.md", "project\n");
    const preview = await f.mcp(f.project, "antigravity");
    expect(reads().filter((file) => file.endsWith("plugin.json"))).toEqual([]);
    expect(JSON.stringify(preview)).not.toContain("PRIVATE-PLUGIN-CANARY");
    expect(JSON.stringify(preview)).not.toContain(f.home);
  });

  symlinks(
    "does not parse personal Antigravity overrides or assume they allow staged plugins",
    async () => {
      const f = fixture();
      const config = f.user(
        "config.json",
        JSON.stringify({ plugins: { staged: { enabled: true } } }),
      );
      f.link(config, f.inHome(".gemini", "config", "config.json"));
      f.write(
        f.inHome(".gemini", "antigravity-cli", "plugins", "staged", "plugin.json"),
        JSON.stringify({ name: "staged" }),
      );
      f.write(
        f.inHome(".gemini", "antigravity-cli", "plugins", "staged", "rules", "rule.md"),
        "STAGED-CANARY\n",
      );
      f.write("AGENTS.md", "project\n");
      const preview = await f.mcp(f.project, "antigravity");
      expect(reads()).not.toContain(f.inHome(".gemini", "config", "config.json"));
      expect(JSON.stringify(preview)).not.toContain("STAGED-CANARY");
    },
  );
});

describe("Claude Code itself", () => {
  it("keeps its own rules for these files", async () => {
    const f = fixture();
    f.user("CLAUDE.md", "USER-CANARY\n");
    f.write("CLAUDE.md", "project\n");
    const preview = await f.mcp();
    expect(JSON.stringify(preview)).not.toContain("USER-CANARY");
    expect(preview.warnings.join("\n")).toContain("User instructions exist (1 file, 12 bytes)");
    expect(preview.warnings.join("\n")).not.toContain(
      "Claude Code user files that this Agent reads",
    );
  });
});
