import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyChanges } from "../../../packages/backend/src/change-apply";
import { planWorkspace } from "../../../packages/backend/src/change-plan";
import { defaultManifest } from "../../../packages/backend/src/default-manifest";
import { manifestSchema } from "../../../packages/backend/src/manifest";
import { assertUnmanagedSkillPath } from "../../../packages/backend/src/skill-ownership";
import { contextFixture, type ContextFixture } from "./fixtures/claude-context";

const roots: string[] = [];
const contexts: ContextFixture[] = [];
afterEach(() => {
  for (const context of contexts.splice(0)) context.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "skill-legacy-")));
  roots.push(root);
  const write = (relative: string, content: string) => {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
    return file;
  };
  write("AGENTS.md", "Shared instructions\n");
  const manifest = manifestSchema.parse({
    schema_version: 2,
    workspace: { id: "fixture", name: "Fixture" },
    skills: [{ name: "reviewer", path: "assets/reviewer", targets: ["claude-code"] }],
  });
  write("assets/reviewer/SKILL.md", "---\nname: reviewer\n---\nLegacy source\n");
  const own = (target: string, schema = 2) =>
    write(
      ".agentkib/skill-deployments.json",
      JSON.stringify({
        schema_version: schema,
        deployments: [{ target: path.join(root, target), status: "active" }],
      }),
    );
  return { root, write, manifest, own };
}

describe("legacy Skill ChangeSet isolation", () => {
  it.each([1, 2])("blocks a schema %s managed source before generating text copies", (schema) => {
    const f = fixture();
    f.own("assets/reviewer", schema);
    expect(() => planWorkspace(f.root, f.manifest)).toThrow("managed Skill deployment");
    expect(readFileSync(path.join(f.root, "assets/reviewer/SKILL.md"), "utf8")).toContain(
      "Legacy source",
    );
  });

  it.each([1, 2])("blocks a schema %s managed target during planning", (schema) => {
    const f = fixture();
    f.own(".claude/skills/reviewer", schema);
    expect(() => planWorkspace(f.root, f.manifest)).toThrow("managed Skill deployment");
  });

  it("rechecks a source adopted after planning before applying any file", () => {
    const f = fixture();
    const plan = planWorkspace(f.root, f.manifest);
    expect(
      plan.changes.find((change) => change.target.endsWith("skills/reviewer/SKILL.md"))
        ?.skill_source,
    ).toBe(path.join(f.root, "assets/reviewer"));
    f.own("assets/reviewer");
    expect(() =>
      applyChanges(plan, path.join(f.root, "backups"), {
        approvedHome: [],
        protectedHome: [],
        approvedApplication: [],
        approveHome: false,
      }),
    ).toThrow("managed Skill deployment");
    expect(readFileSync(path.join(f.root, "AGENTS.md"), "utf8")).toBe("Shared instructions\n");
  });

  it("excludes managed packages and their nested instructions from a default legacy manifest", () => {
    const f = fixture();
    f.write(".agents/skills/owned/SKILL.md", "---\nname: owned\n---\nManaged\n");
    f.write(".agents/skills/owned/AGENTS.md", "Managed nested instructions\n");
    f.write(".agents/skills/external/SKILL.md", "---\nname: external\n---\nExternal\n");
    f.write(
      "library/skills.lock.json",
      JSON.stringify({ schema_version: 2, skills: {}, previous: {} }),
    );
    f.write("library/backups/skills/old/AGENTS.md", "Obsolete\n");
    f.write("library/trash/skills/old/package/AGENTS.md", "Removed\n");
    f.write("library/.skill-state/snapshots/snapshot/AGENTS.md", "Snapshot\n");
    f.own(".agents/skills/owned");
    const manifest = defaultManifest(f.root);
    expect(manifest.skills.map((skill) => skill.name)).toEqual(["external"]);
    expect(manifest.instructions.scoped).toEqual([]);
  });

  it("fails closed on unknown ownership schemas and protects package snapshots and backups", () => {
    const f = fixture();
    f.own(".claude/skills/reviewer", 999);
    expect(() => planWorkspace(f.root, f.manifest)).toThrow("cannot be verified");
    expect(() =>
      assertUnmanagedSkillPath(path.join(f.root, ".skill-state/snapshots/a/SKILL.md")),
    ).toThrow("Skill state");
    f.write("library/skills.lock.json", "{}");
    expect(() =>
      assertUnmanagedSkillPath(path.join(f.root, "library/backups/skills/a/SKILL.md")),
    ).toThrow("managed Skill library");
  });
  it("protects a configured library even before its first lock file exists", () => {
    const f = fixture();
    f.manifest.skills[0]!.path = "library/skills/reviewer";
    f.write("library/skills/reviewer/SKILL.md", "---\nname: reviewer\n---\nLibrary\n");
    expect(() =>
      planWorkspace(f.root, f.manifest, { skillHomes: [path.join(f.root, "library")] }),
    ).toThrow("managed Skill library");
  });

  it("respects ownership recorded by another library registered with the physical workspace", () => {
    const f = fixture();
    const other = path.join(f.root, "other-library");
    const target = path.join(f.root, ".claude/skills/reviewer");
    f.write(
      "other-library/skill-deployments.json",
      JSON.stringify({ schema_version: 2, deployments: [{ target, status: "active" }] }),
    );
    f.write(
      ".agentkib/skill-library-roots.json",
      JSON.stringify({ schema_version: 1, libraries: [other] }),
    );
    expect(() => planWorkspace(f.root, f.manifest)).toThrow("managed Skill deployment");
  });

  it("does not promote linked native Skill roots into legacy source declarations", () => {
    const f = fixture();
    f.write("library/skills/reviewer/SKILL.md", "---\nname: reviewer\n---\nLibrary\n");
    mkdirSync(path.join(f.root, ".agents"));
    symlinkSync(
      path.join(f.root, "library/skills"),
      path.join(f.root, ".agents/skills"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(defaultManifest(f.root).skills).toEqual([]);
  });
});

describe("context Skill visibility", () => {
  it("separates legacy declarations from actual native package discovery", async () => {
    const f = contextFixture();
    contexts.push(f);
    f.write("AGENTS.md", "Project\n");
    f.write(".claude/skills/native/SKILL.md", "---\nname: native\n---\nNative\n");
    f.write(
      ".agentkib/manifest.yaml",
      "schema_version: 2\nworkspace: {id: fixture, name: Fixture}\nskills:\n  - {name: declared-only, path: missing, targets: [claude-code]}\n",
    );
    const preview = await f.request();
    expect(preview.visible_skills).toEqual(["native"]);
    expect(preview.legacy_declared_skills).toEqual(["declared-only"]);
  });

  it("keeps a restricted preview inside workspace roots and does not expose personal aliases", async () => {
    const f = contextFixture();
    contexts.push(f);
    f.write("AGENTS.md", "Project\n");
    f.write(".agents/skills/native/SKILL.md", "---\nname: native\n---\nNative\n");
    f.user("skills/private-skill/SKILL.md", "---\nname: private-skill\n---\nPrivate\n");
    if (process.platform !== "win32") f.link(f.inHome(".claude/skills"), f.at(".cursor/skills"));
    const preview = await f.context.request(
      { project: f.project, cwd: f.project, agent: "cursor" },
      { externalBodies: false },
    );
    expect(preview.visible_skills).toEqual(["native"]);
    expect(JSON.stringify(preview)).not.toContain("private-skill");
    expect(JSON.stringify(preview)).not.toContain(f.home);
  });
});
