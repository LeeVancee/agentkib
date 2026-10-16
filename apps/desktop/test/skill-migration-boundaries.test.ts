import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Skills } from "../../../packages/backend/src/skills";
import { skillPackage } from "../../../packages/backend/src/skill-package";

const folders: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    folders.splice(0).map((folder) => fs.rm(folder, { recursive: true, force: true })),
  );
});
async function fixture() {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "skill-migration-")));
  folders.push(home);
  const root = path.join(home, "library");
  const current = path.join(root, "skills/demo");
  const target = path.join(home, ".claude/skills/demo");
  for (const folder of [current, target]) {
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(
      path.join(folder, "SKILL.md"),
      "---\nname: demo\ndescription: Fixture\n---\nOld content\n",
    );
  }
  const hash = (await skillPackage(current)).hash;
  const lockFile = path.join(root, "skills.lock.json");
  const lockBytes =
    JSON.stringify(
      {
        schema_version: 1,
        skills: {
          demo: {
            source: null,
            content_sha256: hash,
            installed_at: "2026-10-01T00:00:00.000Z",
            updated_at: "2026-10-01T00:00:00.000Z",
          },
        },
        previous: {},
      },
      null,
      4,
    ) + "\n";
  await fs.writeFile(lockFile, lockBytes);
  const receiptFile = path.join(root, "skill-deployments.json");
  const receiptBytes =
    JSON.stringify(
      {
        schema_version: 1,
        deployments: [
          {
            id: "legacy-deployment",
            library_id: "demo",
            library_root: root,
            package_name: "demo",
            package_hash: hash,
            scope: "personal",
            scope_root: home,
            workspace_id: null,
            target,
            agents: ["claude-code"],
            visible_to: ["claude-code"],
            status: "active",
            diagnostics: [],
            previous_hash: null,
            operation_id: "legacy-operation",
            updated_at: "2026-10-01T00:00:00.000Z",
          },
        ],
      },
      null,
      4,
    ) + "\n";
  await fs.writeFile(receiptFile, receiptBytes);
  const skills = new Skills(
    { HOME: home, USERPROFILE: home, AGENTKIB_HOME: root },
    path.join(home, "data"),
  );
  return { home, root, current, target, lockFile, lockBytes, receiptFile, receiptBytes, skills };
}

describe("Skill schema migration boundaries", () => {
  it("reads v1 inventory, installed packages and sync state without migration or state creation", async () => {
    const f = await fixture();
    const before = await fs.readdir(f.root);
    await f.skills.request("skills.listInstalled", {});
    await f.skills.request("skills.inventory", {});
    const state = (await f.skills.request("skills.syncState", {})) as {
      deployments: Array<{ sync_state: string }>;
    };
    expect(state.deployments[0]?.sync_state).toBe("unverified");
    expect(await fs.readFile(f.lockFile, "utf8")).toBe(f.lockBytes);
    expect(await fs.readFile(f.receiptFile, "utf8")).toBe(f.receiptBytes);
    expect(await fs.readdir(f.root)).toEqual(before);
  });

  it("keeps v1 metadata byte-for-byte when the first v2 metadata commit fails", async () => {
    const f = await fixture();
    const source = path.join(f.home, ".cursor/skills/second");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(
      path.join(source, "SKILL.md"),
      "---\nname: second\ndescription: Second\n---\nNew content\n",
    );
    const inventory = (await f.skills.request("skills.inventory", {})) as {
      observations: Array<{ id: string; path: string }>;
    };
    const observation = inventory.observations.find((row) => row.path === source)!;
    expect(observation).toBeDefined();
    const preview = (await f.skills.request("skills.prepareImport", {
      observation_id: observation.id,
    })) as { token: string; library_id: string };
    const rename = fs.rename.bind(fs);
    let failed = false;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (!failed && to === f.lockFile) {
        failed = true;
        throw Object.assign(new Error("metadata disk full"), { code: "ENOSPC" });
      }
      return rename(from, to);
    });
    await expect(
      f.skills.request("skills.applyOperation", { token: preview.token, confirmed: true }),
    ).rejects.toThrow("metadata disk full");
    expect(failed).toBe(true);
    expect(await fs.readFile(f.lockFile, "utf8")).toBe(f.lockBytes);
    expect(await fs.readFile(f.receiptFile, "utf8")).toBe(f.receiptBytes);
    expect(await fs.readFile(path.join(f.current, "SKILL.md"), "utf8")).toContain("Old content");
    await expect(fs.lstat(path.join(f.root, "skills", preview.library_id))).rejects.toThrow();
  });
});
