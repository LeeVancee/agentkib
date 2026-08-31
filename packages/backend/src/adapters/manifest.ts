import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Manifest, AgentKind, SkillDefinition } from "../domain/types.js";
import { validateManifest } from "../workspace/manifest.js";

export async function defaultManifest(project: string): Promise<Manifest> {
  const name = path.basename(project) || "workspace";
  const shared = await readFile(path.join(project, "AGENTS.md"), "utf8").catch(async () =>
    readFile(path.join(project, "CLAUDE.md"), "utf8").catch(() => ""),
  );
  const skills: SkillDefinition[] = [];
  const directory = path.join(project, ".agents", "skills");
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    if (
      await stat(path.join(directory, entry.name, "SKILL.md"))
        .then(() => true)
        .catch(() => false)
    )
      skills.push({ name: entry.name, path: `.agents/skills/${entry.name}`, targets: [] });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  const writable: AgentKind[] = ["codex", "claude-code", "cursor", "open-claw", "hermes"];
  const manifest: Manifest = {
    schema_version: 2,
    workspace: { id: randomUUID(), name },
    instructions: { shared, scoped: [], platform_overrides: {} },
    skills,
    mcp: { config: "mcp.json" },
    connections: [],
    memories: { require_approval: true },
    adapters: Object.fromEntries(
      writable.map((agent) => [agent, { enabled: true, generated_hashes: {} }]),
    ),
  };
  validateManifest(manifest);
  return manifest;
}
