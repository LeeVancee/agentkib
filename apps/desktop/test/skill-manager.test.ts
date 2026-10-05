import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Skills } from "../../../packages/backend/src/skills";

const temporaryHomes: string[] = [];

async function skill(home: string, relative: string, name: string) {
  const directory = path.join(home, relative);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "SKILL.md"), `---\nname: ${name}\n---\n`);
  return directory;
}

async function inventory(home: string, environment: NodeJS.ProcessEnv = {}) {
  const backend = new Skills(
    { ...environment, HOME: home, USERPROFILE: home },
    path.join(home, "data"),
  );
  return (await backend.request("skills.inventory", {})) as {
    observations: Array<{
      name: string;
      path: string;
      agents: string[];
    }>;
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryHomes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

describe("Skill inventory", () => {
  it("keeps the default Claude compatibility directory visible when CLAUDE_CONFIG_DIR is overridden", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "agentkib-skill-manager-"));
    temporaryHomes.push(home);
    const defaultPath = await skill(home, ".claude/skills/default-review", "default-review");
    const overridePath = await skill(home, ".claude-custom/skills/custom-review", "custom-review");

    const result = await inventory(home, { CLAUDE_CONFIG_DIR: path.join(home, ".claude-custom") });

    const defaultObservation = result.observations.find((item) => item.path === defaultPath);
    const overrideObservation = result.observations.find((item) => item.path === overridePath);
    expect(defaultObservation?.agents).toContain("opencode");
    expect(defaultObservation?.agents).not.toContain("claude-code");
    expect(overrideObservation?.agents).toContain("claude-code");
    expect(overrideObservation?.agents).not.toContain("opencode");
  });

  it.each(["OPENCODE_DISABLE_CLAUDE_CODE_SKILLS", "OPENCODE_DISABLE_CLAUDE_CODE"])(
    "does not report ancestor Claude Skills as OpenCode-visible when %s is enabled",
    async (setting) => {
      const home = await mkdtemp(path.join(os.tmpdir(), "agentkib-skill-manager-"));
      temporaryHomes.push(home);
      const gitRoot = path.join(home, "repository");
      const workspace = path.join(gitRoot, "packages", "app");
      const claudePath = await skill(home, "repository/.claude/skills/team-review", "team-review");
      await mkdir(path.join(gitRoot, ".git"), { recursive: true });
      await mkdir(workspace, { recursive: true });

      const backend = new Skills(
        { [setting]: "true", HOME: home, USERPROFILE: home },
        path.join(home, "data"),
        () => [{ id: "workspace-1", path: workspace }],
      );
      const result = (await backend.request("skills.inventory", {})) as {
        observations: Array<{ path: string; agents: string[] }>;
      };
      const observation = result.observations.find((item) => item.path === claudePath);

      expect(observation?.agents ?? []).not.toContain("opencode");
    },
  );

  it("finds nested packages under OpenCode compatibility roots with their real entry paths", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "agentkib-skill-manager-"));
    temporaryHomes.push(home);
    const gitRoot = path.join(home, "repository");
    const workspace = path.join(gitRoot, "packages", "app");
    const nestedPath = await skill(
      home,
      "repository/.agents/skills/team/nested-review",
      "nested-review",
    );
    await mkdir(path.join(gitRoot, ".git"), { recursive: true });
    await mkdir(workspace, { recursive: true });

    const backend = new Skills({ HOME: home, USERPROFILE: home }, path.join(home, "data"), () => [
      { id: "workspace-1", path: workspace },
    ]);
    const result = (await backend.request("skills.inventory", {})) as {
      observations: Array<{ name: string; path: string; agents: string[] }>;
    };

    const observation = result.observations.find((item) => item.path === nestedPath);
    expect(observation).toMatchObject({
      name: "nested-review",
      path: nestedPath,
      agents: ["opencode"],
    });
  });

  it("finds a nested Skill package inside another Skill package", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "agentkib-skill-manager-"));
    temporaryHomes.push(home);
    const gitRoot = path.join(home, "repository");
    const workspace = path.join(gitRoot, "packages", "app");
    const parentPath = await skill(home, "repository/.agents/skills/team", "team");
    const nestedPath = await skill(
      home,
      "repository/.agents/skills/team/nested-review",
      "nested-review",
    );
    await mkdir(path.join(gitRoot, ".git"), { recursive: true });
    await mkdir(workspace, { recursive: true });

    const backend = new Skills({ HOME: home, USERPROFILE: home }, path.join(home, "data"), () => [
      { id: "workspace-1", path: workspace },
    ]);
    const result = (await backend.request("skills.inventory", {})) as {
      observations: Array<{ name: string; path: string; agents: string[] }>;
    };

    expect(result.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "team", path: parentPath, agents: ["opencode"] }),
        expect.objectContaining({
          name: "nested-review",
          path: nestedPath,
          agents: ["opencode"],
        }),
      ]),
    );
  });
});
