import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkillSyncPreview, SkillSyncReport, SkillSyncState } from "@agentkib/runtime-protocol";
import { Skills } from "../../../packages/backend/src/skills";

const folders: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(folders.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(name: string, withName = true) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "skill-native-names-")));
  folders.push(home);
  const root = path.join(home, "library");
  const project = path.join(home, "project");
  const target = path.join(project, ".claude/skills", name);
  const normal = path.join(project, ".claude/skills/normal");
  const text = (body: string) =>
    `---\n${withName ? "name: reviewer\n" : ""}description: Fixture\n---\n${body}\n`;
  for (const directory of [target, normal]) {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "SKILL.md"), text("initial"));
  }
  await fs.mkdir(path.join(project, ".git"));
  const create = () =>
    new Skills(
      { HOME: home, USERPROFILE: home, AGENTKIB_HOME: root },
      path.join(home, "data"),
      () => [{ id: "project", path: project }],
    );
  const skills = create();
  const state = (backend = skills) =>
    backend.request("skills.syncState", {}) as Promise<SkillSyncState>;
  const prepare = (params: Record<string, unknown>, backend = skills) =>
    backend.request("skills.prepareSync", params) as Promise<SkillSyncPreview>;
  const apply = (preview: SkillSyncPreview, backend = skills) =>
    backend.request("skills.applySync", {
      token: preview.token,
      confirmed: true,
    }) as Promise<SkillSyncReport>;
  const observation = (await state()).observations.find((row) => row.path === target)!;
  const adopt = async () => {
    expect(observation.can_adopt).toBe(true);
    const report = await apply(
      await prepare({ operation: "adopt", observation_id: observation.id }),
    );
    expect(report.results[0], JSON.stringify(report)).toMatchObject({
      success: true,
      status: "synchronized",
    });
    return { id: report.results[0]!.deployment_id!, libraryId: report.results[0]!.library_id! };
  };
  const deploy = async (operation: string, id: string, backend = skills) => {
    const preview = await backend.manager.prepareDeployment({ operation, deployment_id: id });
    expect(preview.targets[0]!.conflicts).toEqual([]);
    const report = await backend.manager.applyDeployment({ token: preview.token, confirmed: true });
    expect(report.results[0], JSON.stringify(report)).toMatchObject({ success: true });
    return report;
  };
  return {
    home,
    root,
    project,
    target,
    normal,
    text,
    create,
    skills,
    state,
    prepare,
    apply,
    adopt,
    deploy,
  };
}

describe("description-only native Skill names", () => {
  it.each(["missing", "invalid"])("keeps GitHub %s name metadata invalid", async (kind) => {
    const f = await fixture("my skill", false);
    const body =
      kind === "missing"
        ? f.text("remote")
        : "---\nname: Bad Name\ndescription: Fixture\n---\nremote\n";
    const sha = "a".repeat(40);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.hostname === "raw.githubusercontent.com") return new Response(body);
        if (url.hostname !== "api.github.com") throw new Error("Unexpected external request");
        if (url.pathname.includes("/commits/"))
          return Response.json({ sha, commit: { tree: { sha: "tree" } } });
        if (url.pathname.includes("/git/trees/"))
          return Response.json({
            tree: [
              { path: "skills/reviewer", type: "tree", mode: "040000", sha: "package" },
              {
                path: "skills/reviewer/SKILL.md",
                type: "blob",
                mode: "100644",
                sha: "blob",
                size: Buffer.byteLength(body),
              },
            ],
          });
        if (url.pathname === "/repos/example/skills")
          return Response.json({ default_branch: "main" });
        throw new Error(`Unexpected GitHub fixture route ${url.pathname}`);
      }),
    );
    await expect(
      f.skills.prepareInstall({
        kind: "github",
        repository: "example/skills",
        ref: "main",
        ref_type: "branch",
        path: "skills/reviewer",
      }),
    ).rejects.toThrow(/Skill name/);
    expect(await f.skills.installed()).toEqual([]);
    await expect(fs.lstat(path.join(f.root, ".skill-state/journals"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(
    ["my skill", "中文技能", ".hidden-skill"].flatMap((name) =>
      (["copy", "adopt", "fork"] as const).map((operation) => ({ name, operation })),
    ),
  )(
    "preserves $name through $operation, restart, deployment and trash restore",
    async ({ name, operation }) => {
      const f = await fixture(name, false);
      const original = f.text("initial");
      const observation = (await f.state()).observations.find((row) => row.path === f.target)!;
      expect(observation.can_adopt).toBe(true);
      let libraryId: string;
      let adoptedId: string | undefined;
      if (operation === "copy") {
        const preview = (await f.skills.prepareImport(observation.id)) as {
          token: string;
          library_id: string;
          skill: { name: string };
        };
        expect(preview.skill.name).toBe(name);
        libraryId = preview.library_id;
        await f.skills.request("skills.applyOperation", { token: preview.token, confirmed: true });
      } else {
        const preview = await f.prepare({ operation, observation_id: observation.id });
        expect(preview.targets[0]!.conflicts).toEqual([]);
        const report = await f.apply(preview);
        expect(report.results[0], JSON.stringify(report)).toMatchObject({ success: true });
        libraryId = report.results[0]!.library_id!;
        if (operation === "adopt") adoptedId = report.results[0]!.deployment_id!;
      }
      expect(libraryId).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(libraryId.length).toBeLessThanOrEqual(64);
      expect(libraryId).not.toBe(name);
      const libraryEntry = path.join(f.root, "skills", libraryId, "SKILL.md");
      expect(await fs.readFile(libraryEntry, "utf8")).toBe(original);
      expect(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe(original);
      const restarted = f.create();
      expect((await restarted.installed()).find((row) => row.name === libraryId)).toMatchObject({
        display_name: name,
        source: null,
      });
      expect(await restarted.manager.detail({ library_id: libraryId })).toMatchObject({
        library_id: libraryId,
        name,
      });
      expect(
        (await f.state(restarted)).library.find((row) => row.library_id === libraryId),
      ).toMatchObject({ display_name: name });
      const cursor = (await restarted.manager.targets()).find(
        (row) => row.agent === "cursor" && row.scope === "workspace",
      )!;
      const preview = await restarted.manager.prepareDeployment({
        operation: "deploy",
        library_id: libraryId,
        target_ids: [cursor.id],
      });
      expect(preview.targets[0]!.conflicts).toEqual([]);
      const deployed = await restarted.manager.applyDeployment({
        token: preview.token,
        confirmed: true,
      });
      expect(deployed.results[0], JSON.stringify(deployed)).toMatchObject({ success: true });
      const deploymentId = deployed.results[0]!.deployment_id!;
      expect(
        (await restarted.manager.listDeployments()).find((row) => row.id === deploymentId),
      ).toMatchObject({ display_name: name, library_id: libraryId });
      expect(await fs.readFile(path.join(cursor.root, libraryId, "SKILL.md"), "utf8")).toBe(
        original,
      );
      await f.deploy("undeploy", deploymentId, restarted);
      if (adoptedId) await f.deploy("undeploy", adoptedId, restarted);
      const removed = await restarted.uninstall({ name: libraryId, confirmed: true });
      expect(removed).toMatchObject({ name: libraryId, display_name: name });
      expect(await fs.readFile(path.join(removed.path, "SKILL.md"), "utf8")).toBe(original);
      await restarted.restore({ id: removed.id, confirmed: true });
      expect((await restarted.installed()).find((row) => row.name === libraryId)).toMatchObject({
        display_name: name,
      });
      expect(await fs.readFile(libraryEntry, "utf8")).toBe(original);
      if (!adoptedId)
        expect(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe(original);
      expect(await f.state(f.create())).toHaveProperty("library");
    },
  );

  it("allocates stable bounded IDs for colliding 64-byte directory display names", async () => {
    const name = "a".repeat(64);
    const f = await fixture(name, false);
    const other = path.join(f.project, ".cursor/skills", name);
    await fs.mkdir(other, { recursive: true });
    await fs.writeFile(path.join(other, "SKILL.md"), f.text("initial"));
    const ids = (await f.state()).observations
      .filter((row) => [f.target, other].includes(row.path))
      .map((row) => row.id);
    const prepare = () =>
      f.skills.request("skills.prepareImports", { observation_ids: ids }) as Promise<{
        token: string;
        items: Array<{ library_id: string; status: string; display_name: string }>;
      }>;
    const first = await prepare();
    const names = first.items.map((row) => row.library_id);
    expect(new Set(names).size).toBe(2);
    expect(first.items.map((row) => row.status)).toEqual(["ready", "ready"]);
    expect(first.items.map((row) => row.display_name)).toEqual([name, name]);
    expect((await prepare()).items.map((row) => row.library_id)).toEqual(names);
    for (const id of names) {
      expect(id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(id.length).toBeLessThanOrEqual(64);
    }
    const report = (await f.skills.request("skills.applyImports", {
      token: first.token,
      confirmed: true,
    })) as { items: Array<{ status: string }> };
    expect(report.items.map((row) => row.status)).toEqual(["imported", "imported"]);
    const repeated = await prepare();
    expect(repeated.items.map((row) => row.status)).toEqual(["skipped", "skipped"]);
    expect(repeated.items.map((row) => row.library_id)).toEqual(names);
    const cursor = (await f.skills.manager.targets()).find(
      (row) => row.agent === "claude-code" && row.scope === "workspace",
    )!;
    for (const id of names) {
      expect(await f.skills.manager.detail({ library_id: id })).toMatchObject({ name });
      const deploy = await f.skills.manager.prepareDeployment({
        operation: "deploy",
        library_id: id,
        target_ids: [cursor.id],
      });
      if (path.join(cursor.root, id) === f.target)
        expect(deploy.targets[0]!.conflicts.length).toBeGreaterThan(0);
      else {
        expect(deploy.targets[0]!.conflicts).toEqual([]);
        const applied = await f.skills.manager.applyDeployment({
          token: deploy.token,
          confirmed: true,
        });
        expect(applied.results[0], JSON.stringify(applied)).toMatchObject({ success: true });
        expect(await fs.readFile(path.join(cursor.root, id, "SKILL.md"), "utf8")).toBe(
          f.text("initial"),
        );
      }
    }
  });

  it("rejects overlong fallback names consistently without persisting a journal", async () => {
    const f = await fixture("a".repeat(65), false);
    const observation = (await f.state()).observations.find((row) => row.path === f.target)!;
    expect(observation.can_adopt).toBe(false);
    await expect(f.prepare({ operation: "adopt", observation_id: observation.id })).rejects.toThrow(
      "Skill name is invalid",
    );
    await expect(f.skills.prepareImport(observation.id)).rejects.toThrow("Skill name is invalid");
    await expect(fs.lstat(path.join(f.root, ".skill-state/journals"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("forks a copied deployment using its original display name and bytes", async () => {
    const name = "中文技能";
    const f = await fixture(name, false);
    const observation = (await f.state()).observations.find((row) => row.path === f.target)!;
    const copied = (await f.skills.prepareImport(observation.id)) as {
      token: string;
      library_id: string;
    };
    await f.skills.request("skills.applyOperation", { token: copied.token, confirmed: true });
    const cursor = (await f.skills.manager.targets()).find(
      (row) => row.agent === "cursor" && row.scope === "workspace",
    )!;
    const deploy = await f.skills.manager.prepareDeployment({
      operation: "deploy",
      library_id: copied.library_id,
      target_ids: [cursor.id],
    });
    const deployed = await f.skills.manager.applyDeployment({
      token: deploy.token,
      confirmed: true,
    });
    const preview = await f.prepare({
      operation: "fork",
      deployment_id: deployed.results[0]!.deployment_id,
    });
    const forked = await f.apply(preview);
    expect(forked.results[0], JSON.stringify(forked)).toMatchObject({ success: true });
    const id = forked.results[0]!.library_id!;
    expect(id).not.toBe(copied.library_id);
    expect(await f.skills.manager.detail({ library_id: id })).toMatchObject({ name });
    expect(await fs.readFile(path.join(f.root, "skills", id, "SKILL.md"), "utf8")).toBe(
      f.text("initial"),
    );
    expect((await f.state(f.create())).library.find((row) => row.library_id === id)).toMatchObject({
      display_name: name,
    });
  });

  it("recovers adoption after restart without losing a description-only display name", async () => {
    const name = ".hidden-skill";
    const f = await fixture(name, false);
    const observation = (await f.state()).observations.find((row) => row.path === f.target)!;
    const preview = await f.prepare({ operation: "adopt", observation_id: observation.id });
    const rename = fs.rename.bind(fs);
    let interrupted = false;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await rename(from, to);
      if (!interrupted && to === path.join(f.project, ".agentkib/skill-deployments.json")) {
        interrupted = true;
        throw Object.assign(new Error("Fixture receipt EIO"), { code: "EIO" });
      }
    });
    const failed = await f.apply(preview);
    vi.restoreAllMocks();
    expect(interrupted).toBe(true);
    expect(failed.results[0]).toMatchObject({ success: false, status: "recovery-required" });
    const restarted = f.create();
    const recovered = (await restarted.request("skills.recoverSync", {
      operation_id: failed.operation_id,
      confirmed: true,
    })) as SkillSyncReport;
    expect(recovered.results[0], JSON.stringify(recovered)).toMatchObject({ success: true });
    const id = recovered.results[0]!.library_id!;
    expect(
      await restarted.request("skills.recoverSync", {
        operation_id: failed.operation_id,
        confirmed: true,
      }),
    ).toEqual(recovered);
    expect(await restarted.manager.detail({ library_id: id })).toMatchObject({ name });
    expect(await fs.readFile(path.join(f.root, "skills", id, "SKILL.md"), "utf8")).toBe(
      f.text("initial"),
    );
    expect(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe(f.text("initial"));
  });

  it.each(["null", "", '""', '"   "', "4", "true", "[]", "{}", '"Bad Name"'])(
    "rejects an explicitly invalid name %s before creating synchronization state",
    async (value) => {
      const f = await fixture("my skill", false);
      const original = `---\nname: ${value}\ndescription: Fixture\n---\ninitial\n`;
      await fs.writeFile(path.join(f.target, "SKILL.md"), original);
      const observation = (await f.state()).observations.find((row) => row.path === f.target)!;
      expect(observation.can_adopt).toBe(false);
      await expect(
        f.prepare({ operation: "adopt", observation_id: observation.id }),
      ).rejects.toThrow(/Skill name/);
      await expect(f.skills.prepareImport(observation.id)).rejects.toThrow(/Skill name/);
      await expect(fs.lstat(path.join(f.root, ".skill-state/journals"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await f.skills.installed()).toEqual([]);
      expect(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe(original);
    },
  );
});

describe("adopted native Skill directory names", () => {
  it.each(["my skill", "中文技能", ".hidden-skill"])(
    "manages %s through adoption, restart, update, rollback and withdrawal",
    async (name) => {
      const f = await fixture(name);
      const { id, libraryId } = await f.adopt();
      expect(libraryId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
      expect((await f.state()).deployments.find((row) => row.id === id)).toMatchObject({
        package_name: name,
        target: f.target,
        status: "active",
      });
      const restarted = f.create();
      expect((await f.state(restarted)).deployments.find((row) => row.id === id)).toMatchObject({
        package_name: name,
        sync_state: "current",
      });
      const cursor = (await restarted.manager.targets()).find(
        (row) => row.agent === "cursor" && row.scope === "workspace",
      )!;
      const prepared = await restarted.manager.prepareDeployment({
        operation: "deploy",
        library_id: libraryId,
        target_ids: [cursor.id],
      });
      const second = await restarted.manager.applyDeployment({
        token: prepared.token,
        confirmed: true,
      });
      expect(second.results[0]).toMatchObject({ success: true });
      await fs.writeFile(path.join(cursor.root, libraryId, "SKILL.md"), f.text("next"));
      const pulled = await f.apply(
        await f.prepare(
          { operation: "pull", deployment_id: second.results[0]!.deployment_id },
          restarted,
        ),
        restarted,
      );
      expect(pulled.results[0]).toMatchObject({ success: true });
      await f.deploy("update", id, restarted);
      expect(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe(f.text("next"));
      await f.deploy("rollback", id, restarted);
      expect(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe(f.text("initial"));
      await f.deploy("update", id, restarted);
      await fs.rm(f.target, { recursive: true });
      const restored = await f.apply(
        await f.prepare({ operation: "restore", deployment_id: id }, restarted),
        restarted,
      );
      expect(restored.results[0], JSON.stringify(restored)).toMatchObject({ success: true });
      expect(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe(f.text("next"));
      await f.deploy("undeploy", id, restarted);
      await expect(fs.lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await f.state(restarted)).deployments.find((row) => row.id === id)).toMatchObject({
        package_name: name,
        status: "inactive",
      });
      const unaffected = (await f.state(restarted)).observations.find(
        (row) => row.path === f.normal,
      )!;
      expect(unaffected).toMatchObject({ owner: "external", can_adopt: true });
      const adopted = await f.apply(
        await f.prepare({ operation: "adopt", observation_id: unaffected.id }, restarted),
        restarted,
      );
      expect(adopted.results[0]).toMatchObject({ success: true });
      expect(await fs.readFile(path.join(f.normal, "SKILL.md"), "utf8")).toBe(f.text("initial"));
    },
  );

  it.each(["my skill", "中文技能", ".hidden-skill"])(
    "recovers a committed receipt for %s after restart",
    async (name) => {
      const f = await fixture(name);
      const { id } = await f.adopt();
      const edited = f.text("native edit");
      await fs.writeFile(path.join(f.target, "SKILL.md"), edited);
      const preview = await f.prepare({ operation: "pull", deployment_id: id });
      const rename = fs.rename.bind(fs);
      let interrupted = false;
      vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        await rename(from, to);
        if (!interrupted && to === path.join(f.project, ".agentkib/skill-deployments.json")) {
          interrupted = true;
          throw Object.assign(new Error("EIO after deployment receipt commit"), { code: "EIO" });
        }
      });
      const failed = await f.apply(preview);
      vi.restoreAllMocks();
      expect(interrupted).toBe(true);
      expect(failed.results[0]).toMatchObject({ success: false, status: "recovery-required" });
      const restarted = f.create();
      expect((await f.state(restarted)).deployments.find((row) => row.id === id)).toMatchObject({
        status: "recovery-required",
        operation_id: failed.operation_id,
        package_name: name,
      });
      const recover = () =>
        restarted.request("skills.recoverSync", {
          operation_id: failed.operation_id,
          confirmed: true,
        }) as Promise<SkillSyncReport>;
      const recovered = await recover();
      expect(recovered.results[0], JSON.stringify(recovered)).toMatchObject({
        success: true,
        status: "synchronized",
        deployment_id: id,
      });
      expect(await recover()).toEqual(recovered);
      expect((await f.state(restarted)).deployments.find((row) => row.id === id)).toMatchObject({
        status: "active",
        package_name: name,
        sync_state: "current",
      });
      expect(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe(edited);
      expect(await fs.readFile(path.join(f.normal, "SKILL.md"), "utf8")).toBe(f.text("initial"));
    },
  );

  it.each([
    "",
    ".",
    "..",
    "../outside",
    "nested/child",
    "nested\\child",
    "bad\0name",
    "C:escape",
    "different name",
  ])("rejects unsafe or mismatched receipt entry %j before joining it", async (name) => {
    const f = await fixture("reviewer");
    const { id } = await f.adopt();
    const receiptFile = path.join(f.project, ".agentkib/skill-deployments.json");
    const document = JSON.parse(await fs.readFile(receiptFile, "utf8"));
    document.deployments[0].package_name = name;
    await fs.writeFile(receiptFile, JSON.stringify(document));
    await expect(
      f.skills.manager.prepareDeployment({ operation: "undeploy", deployment_id: id }),
    ).rejects.toThrow("invalid deployment");
    expect(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe(f.text("initial"));
    expect(await fs.readFile(path.join(f.normal, "SKILL.md"), "utf8")).toBe(f.text("initial"));
    await expect(fs.lstat(path.join(f.project, "outside"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves the library ID slug boundary for newly deployed copies", async () => {
    const f = await fixture("my skill");
    await f.adopt();
    const cursor = (await f.skills.manager.targets()).find(
      (row) => row.agent === "cursor" && row.scope === "workspace",
    )!;
    await expect(
      f.skills.manager.prepareDeployment({
        operation: "deploy",
        library_id: "my skill",
        target_ids: [cursor.id],
      }),
    ).rejects.toThrow("Invalid Skill package identity");
    await expect(fs.lstat(path.join(cursor.root, "my skill"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await f.state()).deployments[0]).toMatchObject({
      status: "active",
      package_name: "my skill",
    });
  });

  it("rejects a recovery journal moved outside its native direct parent", async () => {
    const f = await fixture("中文技能");
    const { id } = await f.adopt();
    const preview = await f.skills.manager.prepareDeployment({
      operation: "update",
      deployment_id: id,
    });
    const rename = fs.rename.bind(fs);
    let interrupted = false;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await rename(from, to);
      if (!interrupted && String(to).endsWith(`${path.sep}journal.json`)) {
        interrupted = true;
        throw Object.assign(new Error("EIO after recovery journal commit"), { code: "EIO" });
      }
    });
    const failed = await f.skills.manager.applyDeployment({
      token: preview.token,
      confirmed: true,
    });
    vi.restoreAllMocks();
    expect(interrupted).toBe(true);
    expect(failed.results[0]).toMatchObject({ success: false, status: "recovery-required" });
    const target = (await f.skills.manager.targets()).find(
      (row) => row.agent === "claude-code" && row.scope === "workspace",
    )!;
    const journalFile = path.join(
      path.dirname(target.root),
      ".agentkib-skill-state/operations",
      failed.operation_id,
      target.id,
      "journal.json",
    );
    const journal = JSON.parse(await fs.readFile(journalFile, "utf8"));
    journal.destination = path.join(f.project, "outside/中文技能");
    journal.next_receipt.target = journal.destination;
    await fs.writeFile(journalFile, JSON.stringify(journal));
    await expect(f.skills.manager.recoverSyncOperation(failed.operation_id, false)).rejects.toThrow(
      "Invalid Skill operation journal",
    );
    expect(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe(f.text("initial"));
    await expect(fs.lstat(path.join(f.project, "outside"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.skipIf(process.platform === "win32").each(["bad\\name", "bad\nname"])(
    "does not accept unsupported native name %j or persist a journal",
    async (name) => {
      const f = await fixture(name);
      const rows = (await f.state()).observations;
      const observation = rows.find((row) => row.path === f.target)!;
      expect(observation.can_adopt).toBe(false);
      expect(rows.find((row) => row.path === f.normal)?.can_adopt).toBe(true);
      await expect(
        f.prepare({ operation: "adopt", observation_id: observation.id }),
      ).rejects.toThrow("safe single name");
      await expect(fs.lstat(path.join(f.root, ".skill-state/journals"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe(f.text("initial"));
    },
  );
});
