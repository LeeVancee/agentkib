import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Skills } from "../../../packages/backend/src/skills";
import { assertUnmanagedSkillPath } from "../../../packages/backend/src/skill-ownership";
import { planWorkspace } from "../../../packages/backend/src/change-plan";
import { manifestSchema } from "../../../packages/backend/src/manifest";
import type { SkillSyncPreview, SkillSyncReport, SkillSyncState } from "@agentkib/runtime-protocol";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
});

async function fixture() {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "skill-detach-legacy-")));
  homes.push(home);
  const project = path.join(home, "project");
  const target = path.join(project, ".agents/skills/reviewer");
  await fs.mkdir(target, { recursive: true });
  await fs.mkdir(path.join(project, ".git"));
  const text = "---\nname: reviewer\ndescription: Review changes\n---\nKeep these instructions\n";
  await fs.writeFile(path.join(target, "SKILL.md"), text);
  await fs.writeFile(path.join(project, "AGENTS.md"), "Project instructions\n");
  const skills = new Skills(
    { HOME: home, USERPROFILE: home, AGENTKIB_HOME: path.join(home, "library") },
    path.join(home, "data"),
    () => [{ id: "project", path: project }],
  );
  const state = (await skills.request("skills.syncState", {})) as SkillSyncState;
  const observation = state.observations.find((item) => item.path === target)!;
  const preview = (await skills.request("skills.prepareSync", {
    operation: "adopt",
    observation_id: observation.id,
  })) as SkillSyncPreview;
  const report = (await skills.request("skills.applySync", {
    token: preview.token,
    confirmed: true,
  })) as SkillSyncReport;
  expect(report.results[0]?.success).toBe(true);
  return { skills, project, target, text, deployment: report.results[0]!.deployment_id! };
}

describe("detached Skill compatibility", () => {
  it("releases retained files to the legacy workflow after a confirmed detach", async () => {
    const f = await fixture();
    const source = path.join(f.target, "SKILL.md");
    expect(() => assertUnmanagedSkillPath(source)).toThrow("managed Skill deployment");
    const preview = (await f.skills.request("skills.prepareSync", {
      operation: "detach",
      deployment_id: f.deployment,
    })) as SkillSyncPreview;
    const report = (await f.skills.request("skills.applySync", {
      token: preview.token,
      confirmed: true,
    })) as SkillSyncReport;
    expect(report.results[0]).toMatchObject({ success: true, status: "detached" });
    expect(await fs.readFile(source, "utf8")).toBe(f.text);
    expect(() => assertUnmanagedSkillPath(source)).not.toThrow();
    const plan = planWorkspace(
      f.project,
      manifestSchema.parse({
        schema_version: 2,
        workspace: { id: "project", name: "Project" },
        skills: [{ name: "reviewer", path: ".agents/skills/reviewer", targets: ["claude-code"] }],
      }),
    );
    expect(
      plan.changes.some((change) => change.target.endsWith(".claude/skills/reviewer/SKILL.md")),
    ).toBe(true);
  });

  it("still protects a pending reservation at a withdrawn location", async () => {
    const f = await fixture();
    const directory = path.join(f.project, ".agentkib");
    await fs.writeFile(
      path.join(directory, "skill-deployments.json"),
      JSON.stringify({
        schema_version: 2,
        deployments: [{ target: f.target, status: "inactive" }],
      }),
    );
    await fs.writeFile(
      path.join(directory, "skill-deployment-reservations.json"),
      JSON.stringify({
        schema_version: 1,
        deployments: [{ target: f.target, status: "inactive" }],
      }),
    );
    expect(() => assertUnmanagedSkillPath(path.join(f.target, "SKILL.md"))).toThrow(
      "managed Skill deployment",
    );
  });
});
