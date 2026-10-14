import { afterEach, describe, expect, it } from "vitest";
import { contextFixture, type ContextFixture } from "./fixtures/claude-context";

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
});
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
});

describe("Grok Build", () => {
  it("shows ~/.claude in the app and holds it back over MCP", async () => {
    const f = fixture();
    f.user("CLAUDE.md", "GROK-PERSONAL-CANARY\n");
    f.write("AGENTS.md", "project text\n");
    const shown = await app(f, "grok-build");
    expect(JSON.stringify(shown)).toContain("GROK-PERSONAL-CANARY");
    const preview = await f.mcp(f.project, "grok-build");
    const output = JSON.stringify(preview);
    expect(output).not.toContain("GROK-PERSONAL-CANARY");
    expect(output).not.toContain(f.home);
    expect(preview.sections.some((section) => section.content.includes("project text"))).toBe(true);
    expect(preview.warnings.join("\n")).toContain(
      "Claude Code user files that this Agent reads exist (1 file, 21 bytes)",
    );
  });
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
