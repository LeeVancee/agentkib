import { describe, expect, test } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadManifest, scanWorkspace, validateManifest } from "../src/index.js";

async function root() {
  return mkdtemp(path.join(tmpdir(), "agentkib-workspace-"));
}
const valid = `schema_version: 2
workspace: { id: demo, name: Demo }
instructions: { shared: README.md, scoped: [], platform_overrides: {} }
skills: [{ name: review, path: skills/review, targets: [codex] }]
mcp: { config: mcp.json }
connections: [{ name: local, transport: stdio, command: node, args: [], env: { TOKEN: "${"${TOKEN}"}" }, allow_tools: [], targets: [codex] }]
memories: { require_approval: true }
adapters: {}`;

describe("manifest and workspace scanner", () => {
  test("loads and validates manifest safety rules", async () => {
    const dir = await root();
    await mkdir(path.join(dir, ".agentkib"));
    await writeFile(path.join(dir, ".agentkib/manifest.yaml"), valid);
    expect((await loadManifest(dir)).workspace.id).toBe("demo");
    expect(() =>
      validateManifest({
        ...JSON.parse(
          JSON.stringify({
            schema_version: 1,
            workspace: { id: "x", name: "x" },
            instructions: { shared: "", scoped: [], platform_overrides: {} },
            skills: [{ name: "x", path: "../bad", targets: [] }],
            mcp: { config: "" },
            connections: [],
            memories: { require_approval: true },
            adapters: {},
          }),
        ),
      }),
    ).toThrow();
  });
  test("scans candidate agents, assets, and malformed native configs", async () => {
    const dir = await root();
    await mkdir(path.join(dir, ".codex", "skills"), { recursive: true });
    await writeFile(path.join(dir, "AGENTS.md"), "instructions");
    await writeFile(path.join(dir, ".codex", "settings.json"), "{bad");
    await writeFile(path.join(dir, ".codex", "skills", "SKILL.md"), "skill");
    const result = await scanWorkspace(dir);
    expect(result.agents.find((a) => a.agent === "codex")?.detected).toBe(true);
    expect(result.assets.some((a) => a.kind === "skill")).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("Invalid configuration"))).toBe(true);
  });
});
