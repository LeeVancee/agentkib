import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkillSyncPreview, SkillSyncReport, SkillSyncState } from "@agentkib/runtime-protocol";
import { Skills } from "../../../packages/backend/src/skills";
import { applyChanges } from "../../../packages/backend/src/change-apply";
import { hash } from "../../../packages/backend/src/doctor-files";

const folders: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(folders.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(adopt = true) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "skill-sync-gate-")));
  folders.push(home);
  const root = path.join(home, "library");
  const project = path.join(home, "project");
  const target = path.join(project, ".claude/skills/reviewer");
  const entry = path.join(target, "SKILL.md");
  const text = (body: string) => `---\nname: reviewer\ndescription: Fixture\n---\n${body}\n`;
  await fs.mkdir(target, { recursive: true });
  await fs.mkdir(path.join(project, ".git"));
  await fs.writeFile(entry, text("initial"));
  const create = () =>
    new Skills(
      { HOME: home, USERPROFILE: home, AGENTKIB_HOME: root },
      path.join(home, "data"),
      () => [{ id: "project", path: project }],
    );
  const skills = create();
  const state = () => skills.request("skills.syncState", {}) as Promise<SkillSyncState>;
  const prepare = (params: Record<string, unknown>) =>
    skills.request("skills.prepareSync", params) as Promise<SkillSyncPreview>;
  const apply = (preview: SkillSyncPreview) =>
    skills.request("skills.applySync", {
      token: preview.token,
      confirmed: true,
    }) as Promise<SkillSyncReport>;
  const observation = (await state()).observations.find((row) => row.path === target)!;
  let id: string | undefined;
  let libraryId: string | undefined;
  if (adopt) {
    const adopted = await apply(
      await prepare({ operation: "adopt", observation_id: observation.id }),
    );
    expect(adopted.results[0], JSON.stringify(adopted)).toMatchObject({ success: true });
    id = adopted.results[0]!.deployment_id;
    libraryId = adopted.results[0]!.library_id ?? undefined;
  }
  const interrupt = async (preview: SkillSyncPreview) => {
    const rename = fs.rename.bind(fs);
    let interrupted = false;
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (
        !interrupted &&
        String(to).includes(`${path.sep}.skill-state${path.sep}journals${path.sep}`)
      ) {
        const journal = JSON.parse(await fs.readFile(from, "utf8"));
        if (journal.phase === "library-committed") {
          interrupted = true;
          throw Object.assign(new Error("EIO saving library-committed sync journal"), {
            code: "EIO",
          });
        }
      }
      return rename(from, to);
    });
    const failed = await apply(preview);
    spy.mockRestore();
    expect(interrupted).toBe(true);
    expect(failed.results[0]).toMatchObject({ success: false, status: "recovery-required" });
    return failed;
  };
  const legacy = (before: string) =>
    applyChanges(
      {
        id: "legacy",
        project_root: project,
        created_at: "2026-10-16T00:00:00.000Z",
        requires_home_approval: false,
        changes: [
          {
            target: entry,
            scope: "project",
            original_hash: hash(before),
            before,
            after: text("legacy replacement"),
            risk: "low",
            validator: "markdown",
          },
        ],
      },
      path.join(home, "legacy-backups"),
      {
        approvedHome: [],
        protectedHome: [],
        approvedApplication: [],
        approveHome: false,
      },
    );
  return {
    home,
    root,
    project,
    target,
    entry,
    text,
    create,
    skills,
    state,
    prepare,
    apply,
    observation,
    id,
    libraryId,
    interrupt,
    legacy,
  };
}

describe("unfinished Skill sync ownership gates", () => {
  it.each(["push", "detach"])(
    "blocks a new %s after the library commit journal EIO",
    async (operation) => {
      const f = await fixture();
      const changed = f.text("accepted native edit");
      await fs.writeFile(f.entry, changed);
      const failed = await f.interrupt(await f.prepare({ operation: "pull", deployment_id: f.id }));
      expect(await fs.readFile(path.join(f.root, "skills", f.libraryId!, "SKILL.md"), "utf8")).toBe(
        changed,
      );
      const receiptFile = path.join(f.project, ".agentkib/skill-deployments.json");
      const before = await fs.readFile(receiptFile, "utf8");
      expect((await f.state()).deployments.find((row) => row.id === f.id)).toMatchObject({
        status: "recovery-required",
        operation_id: failed.operation_id,
        sync_state: "blocked",
      });
      await expect(
        f.prepare({ operation, deployment_id: f.id, resolution: "library" }),
      ).rejects.toThrow("recovery");
      expect(() => f.legacy(changed)).toThrow("managed Skill deployment");
      expect(await fs.readFile(f.entry, "utf8")).toBe(changed);
      expect(await fs.readFile(receiptFile, "utf8")).toBe(before);
    },
  );

  it("keeps the gate after restart, rejects dispatched stale previews, and recovers after another target advances the library", async () => {
    const f = await fixture();
    const cursor = (await f.skills.manager.targets()).find(
      (row) => row.agent === "cursor" && row.scope === "workspace",
    )!;
    const deployment = await f.skills.manager.prepareDeployment({
      operation: "deploy",
      library_id: f.libraryId,
      target_ids: [cursor.id],
    });
    const second = await f.skills.manager.applyDeployment({
      token: deployment.token,
      confirmed: true,
    });
    expect(second.results[0]).toMatchObject({ success: true });
    const secondId = second.results[0]!.deployment_id;
    const native = f.text("accepted first edit");
    await fs.writeFile(f.entry, native);
    const stale = await f.prepare({ operation: "detach", deployment_id: f.id });
    const failed = await f.interrupt(await f.prepare({ operation: "pull", deployment_id: f.id }));
    const before = await fs.readFile(
      path.join(f.project, ".agentkib/skill-deployments.json"),
      "utf8",
    );
    await expect(f.apply(stale)).rejects.toThrow("recovery");
    expect(await fs.readFile(f.entry, "utf8")).toBe(native);
    expect(
      await fs.readFile(path.join(f.project, ".agentkib/skill-deployments.json"), "utf8"),
    ).toBe(before);
    const restarted = f.create();
    expect(
      ((await restarted.request("skills.syncState", {})) as SkillSyncState).deployments.find(
        (row) => row.id === f.id,
      ),
    ).toMatchObject({ status: "recovery-required", operation_id: failed.operation_id });
    await expect(
      restarted.request("skills.prepareSync", { operation: "push", deployment_id: f.id }),
    ).rejects.toThrow("recovery");
    const next = f.text("another target's accepted edit");
    await fs.writeFile(path.join(cursor.root, f.libraryId!, "SKILL.md"), next);
    const other = await f.prepare({
      operation: "pull",
      deployment_id: secondId,
      resolution: "deployment",
    });
    expect((await f.apply(other)).results[0]).toMatchObject({ success: true });
    const recover = () =>
      restarted.request("skills.recoverSync", {
        operation_id: failed.operation_id,
        confirmed: true,
      }) as Promise<SkillSyncReport>;
    const recovered = await recover();
    expect(recovered.operation_id).toBe(failed.operation_id);
    expect(recovered.results[0], JSON.stringify(recovered)).toMatchObject({
      success: true,
      status: "synchronized",
      deployment_id: f.id,
    });
    expect(await recover()).toEqual(recovered);
    expect(await fs.readFile(f.entry, "utf8")).toBe(native);
    expect(await fs.readFile(path.join(f.root, "skills", f.libraryId!, "SKILL.md"), "utf8")).toBe(
      next,
    );
    expect(
      ((await restarted.request("skills.syncState", {})) as SkillSyncState).deployments.find(
        (row) => row.id === f.id,
      ),
    ).toMatchObject({ sync_state: "outgoing" });
    const preview = (await restarted.request("skills.prepareSync", {
      operation: "push",
      deployment_id: f.id,
    })) as SkillSyncPreview;
    expect(preview.targets[0]!.conflicts).toEqual([]);
  });

  it("protects an interrupted first adopt and its newly committed library before a receipt exists", async () => {
    const f = await fixture();
    const external = path.join(f.project, ".cursor/skills/reviewer");
    const entry = path.join(external, "SKILL.md");
    const body = f.text("external second package");
    await fs.mkdir(external, { recursive: true });
    await fs.writeFile(entry, body);
    const observation = (await f.state()).observations.find((row) => row.path === external)!;
    const failed = await f.interrupt(
      await f.prepare({ operation: "adopt", observation_id: observation.id }),
    );
    const libraryId = failed.results[0]!.library_id!;
    expect(libraryId).not.toBe(f.libraryId);
    expect((await f.state()).deployments.find((row) => row.target === external)).toMatchObject({
      status: "recovery-required",
      operation_id: failed.operation_id,
    });
    expect((await f.state()).observations.find((row) => row.id === observation.id)).toMatchObject({
      status: "recovery-required",
      can_adopt: false,
    });
    await expect(f.prepare({ operation: "adopt", observation_id: observation.id })).rejects.toThrow(
      "recovery",
    );
    expect(() =>
      applyChanges(
        {
          id: "legacy-adopt",
          project_root: f.project,
          created_at: "2026-10-16T00:00:00.000Z",
          requires_home_approval: false,
          changes: [
            {
              target: entry,
              scope: "project",
              original_hash: hash(body),
              before: body,
              after: f.text("legacy"),
              risk: "low",
              validator: "markdown",
            },
          ],
        },
        path.join(f.home, "legacy-adopt-backups"),
        { approvedHome: [], approvedApplication: [], protectedHome: [], approveHome: false },
      ),
    ).toThrow("managed Skill deployment");
    await expect(
      f.skills.request("skills.uninstall", { name: libraryId, confirmed: true }),
    ).rejects.toThrow("unfinished Skill synchronization");
    expect(await fs.readFile(path.join(f.root, "skills", libraryId, "SKILL.md"), "utf8")).toBe(
      body,
    );
    expect(await fs.readFile(entry, "utf8")).toBe(body);
    const restarted = f.create();
    const recovered = (await restarted.request("skills.applyDeployment", {
      token: failed.operation_id,
      confirmed: true,
    })) as SkillSyncReport;
    expect(recovered.results[0]).toHaveProperty(
      "target_id",
      (await restarted.manager.targets()).find(
        (target) => target.agent === "cursor" && target.scope === "workspace",
      )!.id,
    );
    expect(recovered.results[0]).toHaveProperty("error", null);
    expect(recovered.results[0], JSON.stringify(recovered)).toMatchObject({
      success: true,
      library_id: libraryId,
      status: "synchronized",
    });
    expect(
      ((await restarted.request("skills.syncState", {})) as SkillSyncState).deployments.find(
        (row) => row.target === external,
      ),
    ).toMatchObject({ status: "active", library_id: libraryId, sync_state: "current" });
  });

  it("recognizes a valid journal-only operation left by the earlier failure window", async () => {
    const f = await fixture(false);
    const native = f.text("initial");
    const failed = await f.interrupt(
      await f.prepare({ operation: "adopt", observation_id: f.observation.id }),
    );
    await fs.writeFile(
      path.join(f.project, ".agentkib/skill-deployment-reservations.json"),
      JSON.stringify({ schema_version: 2, deployments: [] }),
    );
    const restarted = f.create();
    expect(
      ((await restarted.request("skills.syncState", {})) as SkillSyncState).observations.find(
        (row) => row.id === f.observation.id,
      ),
    ).toMatchObject({ status: "recovery-required", can_adopt: false });
    await expect(
      restarted.request("skills.prepareSync", {
        operation: "adopt",
        observation_id: f.observation.id,
      }),
    ).rejects.toThrow("recovery");
    expect(() => f.legacy(native)).toThrow("managed Skill deployment");
    expect(await fs.readFile(f.entry, "utf8")).toBe(native);
    const recovered = (await restarted.request("skills.recoverSync", {
      operation_id: failed.operation_id,
      confirmed: true,
    })) as SkillSyncReport;
    expect(recovered.results[0], JSON.stringify(recovered)).toMatchObject({ success: true });
  });

  it.each(["kind", "operation-id", "target", "malformed-fork", "false", "zero", "empty"])(
    "fails closed for a journal with invalid %s",
    async (damage) => {
      const f = await fixture();
      const native = f.text("accepted edit");
      await fs.writeFile(f.entry, native);
      const failed = await f.interrupt(await f.prepare({ operation: "pull", deployment_id: f.id }));
      const journalFile = path.join(f.root, ".skill-state/journals", `${failed.operation_id}.json`);
      const original = await fs.readFile(journalFile, "utf8");
      const journal = JSON.parse(original);
      if (damage === "kind") journal.kind = "unknown";
      if (damage === "operation-id") journal.operation_id = "00000000-0000-0000-0000-000000000000";
      if (damage === "target") journal.plan.location.target.root = path.join(f.home, "unrelated");
      if (damage === "malformed-fork") {
        journal.plan.operation = "fork";
        journal.plan.candidate_hash = null;
      }
      const value =
        damage === "false" ? false : damage === "zero" ? 0 : damage === "empty" ? "" : journal;
      await fs.writeFile(journalFile, JSON.stringify(value));
      await expect(f.prepare({ operation: "detach", deployment_id: f.id })).rejects.toThrow(
        "Invalid Skill synchronization journal",
      );
      await expect(
        f.skills.request("skills.recoverSync", {
          operation_id: failed.operation_id,
          confirmed: true,
        }),
      ).rejects.toThrow("Invalid Skill synchronization journal");
      await expect(f.skills.request("skills.syncRuns", {})).rejects.toThrow(
        "Invalid Skill synchronization journal",
      );
      expect(await fs.readFile(f.entry, "utf8")).toBe(native);
    },
  );

  it.each(["reservation", "journal", "run-history"])(
    "keeps recovery reachable after a %s cleanup failure",
    async (failure) => {
      const f = await fixture();
      const native = f.text("accepted edit");
      await fs.writeFile(f.entry, native);
      const preview = await f.prepare({ operation: "pull", deployment_id: f.id });
      const rename = fs.rename.bind(fs);
      const remove = fs.rm.bind(fs);
      let interrupted = false;
      vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        if (
          !interrupted &&
          ((failure === "run-history" && to === path.join(f.root, "skill-sync-runs.json")) ||
            (failure === "reservation" &&
              to === path.join(f.project, ".agentkib/skill-deployment-reservations.json") &&
              JSON.parse(await fs.readFile(from, "utf8")).deployments.length === 0))
        ) {
          interrupted = true;
          throw Object.assign(new Error(`EIO ${failure}`), { code: "EIO" });
        }
        return rename(from, to);
      });
      vi.spyOn(fs, "rm").mockImplementation(async (file, options) => {
        if (
          failure === "journal" &&
          !interrupted &&
          String(file).includes(`${path.sep}.skill-state${path.sep}journals${path.sep}`) &&
          String(file).endsWith(".json")
        ) {
          interrupted = true;
          throw Object.assign(new Error("EIO journal cleanup"), { code: "EIO" });
        }
        return remove(file, options);
      });
      const result = await f.apply(preview);
      vi.restoreAllMocks();
      expect(interrupted).toBe(true);
      expect(result.results[0], JSON.stringify(result)).toMatchObject({
        success: failure !== "reservation",
        ...(failure === "reservation" ? { status: "recovery-required" } : {}),
      });
      expect(result.warnings.length).toBeGreaterThan(0);
      await fs.lstat(path.join(f.root, ".skill-state/journals", `${result.operation_id}.json`));
      const restarted = f.create();
      const recover = () =>
        restarted.request("skills.recoverSync", {
          operation_id: result.operation_id,
          confirmed: true,
        }) as Promise<SkillSyncReport>;
      const recovered = await recover();
      expect(recovered.results[0], JSON.stringify(recovered)).toMatchObject({
        success: true,
        deployment_id: f.id,
      });
      expect(await recover()).toEqual(recovered);
      expect(await fs.readFile(f.entry, "utf8")).toBe(native);
      const next = (await restarted.request("skills.prepareSync", {
        operation: "detach",
        deployment_id: f.id,
      })) as SkillSyncPreview;
      expect(next.targets[0]!.conflicts).toEqual([]);
      expect(
        JSON.parse(
          await fs.readFile(
            path.join(f.project, ".agentkib/skill-deployment-reservations.json"),
            "utf8",
          ),
        ).deployments,
      ).toEqual([]);
    },
  );

  it("releases its reservation after a library failure with no committed transaction", async () => {
    const f = await fixture();
    const native = f.text("unaccepted edit");
    await fs.writeFile(f.entry, native);
    const preview = await f.prepare({ operation: "pull", deployment_id: f.id });
    vi.spyOn(f.skills.sync.hooks, "accept").mockRejectedValue(
      new Error("failure before transaction"),
    );
    const result = await f.apply(preview);
    expect(result.results[0]).toMatchObject({ success: false, status: "failed" });
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(f.project, ".agentkib/skill-deployment-reservations.json"),
          "utf8",
        ),
      ).deployments,
    ).toEqual([]);
    expect(await fs.readFile(f.entry, "utf8")).toBe(native);
    expect(
      (await f.prepare({ operation: "pull", deployment_id: f.id })).targets[0]!.conflicts,
    ).toEqual([]);
  });

  it("still detaches a deployment whose entire native directory is missing", async () => {
    const f = await fixture();
    await fs.rm(f.target, { recursive: true });
    const preview = await f.prepare({ operation: "detach", deployment_id: f.id });
    const result = await f.apply(preview);
    expect(result.results[0], JSON.stringify(result)).toMatchObject({
      success: true,
      status: "detached",
    });
    await expect(fs.lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a detached package valid through legacy apply and a subsequent adoption", async () => {
    const f = await fixture();
    expect(
      (await f.apply(await f.prepare({ operation: "detach", deployment_id: f.id }))).results[0],
    ).toMatchObject({ success: true, status: "detached" });
    expect(await fs.readdir(f.target)).toEqual(["SKILL.md"]);
    f.legacy(f.text("initial"));
    expect(await fs.readdir(f.target)).toEqual(["SKILL.md"]);
    expect(await fs.readFile(f.entry, "utf8")).toBe(f.text("legacy replacement"));
    const row = (await f.state()).observations.find((item) => item.path === f.target)!;
    expect(row).toMatchObject({ owner: "external", can_adopt: true });
    const adopted = await f.apply(await f.prepare({ operation: "adopt", observation_id: row.id }));
    expect(adopted.results[0], JSON.stringify(adopted)).toMatchObject({ success: true });
    expect(
      (await f.state()).deployments.find((item) => item.id === adopted.results[0]!.deployment_id),
    ).toMatchObject({ status: "active", sync_state: "current" });
    expect(await fs.readdir(f.target)).toEqual(["SKILL.md"]);
  });

  it("does not create a competing journal when an older preview is dispatched during library commit", async () => {
    const f = await fixture();
    await fs.writeFile(f.entry, f.text("accepted edit"));
    const first = await f.prepare({ operation: "pull", deployment_id: f.id });
    const second = await f.prepare({ operation: "detach", deployment_id: f.id });
    const accept = f.skills.sync.hooks.accept;
    let entered!: () => void;
    let resume!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      resume = resolve;
    });
    vi.spyOn(f.skills.sync.hooks, "accept").mockImplementation(async (input) => {
      entered();
      await release;
      return accept(input);
    });
    const running = f.apply(first);
    await waiting;
    try {
      await expect(f.apply(second)).rejects.toThrow("recovery");
      expect(await fs.readdir(path.join(f.root, ".skill-state/journals"))).toHaveLength(1);
    } finally {
      resume();
    }
    expect((await running).results[0]).toMatchObject({ success: true });
    expect(await fs.readdir(path.join(f.root, ".skill-state/journals"))).toEqual([]);
  });

  it("does not block its target when only an interrupted fork needs library recovery", async () => {
    const f = await fixture();
    const fork = f.skills.sync.hooks.fork;
    vi.spyOn(f.skills.sync.hooks, "fork").mockImplementation(async (input) => {
      await fork(input);
      throw new Error("fork committed before acknowledgment");
    });
    const failed = await f.apply(await f.prepare({ operation: "fork", deployment_id: f.id }));
    vi.restoreAllMocks();
    expect(failed.results[0]).toMatchObject({ status: "recovery-required" });
    expect(
      (await f.prepare({ operation: "detach", deployment_id: f.id })).targets[0]!.conflicts,
    ).toEqual([]);
    const recovered = (await f.skills.request("skills.recoverSync", {
      operation_id: failed.operation_id,
      confirmed: true,
    })) as SkillSyncReport;
    expect(recovered.results[0], JSON.stringify(recovered)).toMatchObject({
      success: true,
      status: "forked",
    });
    expect((await f.state()).deployments.find((row) => row.id === f.id)).toMatchObject({
      status: "active",
      library_id: f.libraryId,
    });
  });

  it.skipIf(process.platform === "win32")(
    "cleans a journal created before the directory fsync fails",
    async () => {
      const f = await fixture();
      await fs.writeFile(f.entry, f.text("accepted edit"));
      const preview = await f.prepare({ operation: "pull", deployment_id: f.id });
      const directory = path.join(f.root, ".skill-state/journals");
      const open = fs.open.bind(fs);
      let interrupted = false;
      vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
        const handle = await open(file, flags, mode);
        if (file === directory && !interrupted) {
          vi.spyOn(handle, "sync").mockImplementationOnce(async () => {
            interrupted = true;
            throw Object.assign(new Error("EIO after creating sync journal"), { code: "EIO" });
          });
        }
        return handle;
      });
      const result = await f.apply(preview);
      vi.restoreAllMocks();
      expect(interrupted).toBe(true);
      expect(result.results[0], JSON.stringify(result)).toMatchObject({
        success: false,
        status: "failed",
      });
      expect(await fs.readdir(directory)).toEqual([]);
      const next = await f.prepare({ operation: "pull", deployment_id: f.id });
      expect((await f.apply(next)).results[0]).toMatchObject({ success: true });
    },
  );

  it("retains the compensated result if releasing its recovery reservation fails", async () => {
    const f = await fixture();
    const native = f.text("retained native edit");
    await fs.writeFile(f.entry, native);
    const library = path.join(f.root, "skills", f.libraryId!);
    const backup = path.join(f.root, "backups/skills", f.libraryId!);
    const rename = fs.rename.bind(fs);
    let moved = false;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (from === library && !moved) {
        await rename(from, to);
        moved = true;
        throw new Error("interruption after library move");
      }
      if (moved && from === backup && to === library) throw new Error("recovery unavailable");
      return rename(from, to);
    });
    const failed = await f.apply(await f.prepare({ operation: "pull", deployment_id: f.id }));
    vi.restoreAllMocks();
    expect(failed.results[0]).toMatchObject({ status: "recovery-required" });
    let interrupted = false;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (
        !interrupted &&
        to === path.join(f.project, ".agentkib/skill-deployment-reservations.json") &&
        JSON.parse(await fs.readFile(from, "utf8")).deployments.length === 0
      ) {
        interrupted = true;
        throw Object.assign(new Error("EIO releasing compensated reservation"), { code: "EIO" });
      }
      return rename(from, to);
    });
    const recover = () =>
      f.skills.request("skills.recoverSync", {
        operation_id: failed.operation_id,
        confirmed: true,
      }) as Promise<SkillSyncReport>;
    const pending = await recover();
    vi.restoreAllMocks();
    expect(interrupted).toBe(true);
    expect(pending.results[0]).toMatchObject({ success: false, status: "recovery-required" });
    const recovered = await recover();
    expect(recovered.results[0], JSON.stringify(recovered)).toMatchObject({
      success: false,
      status: "recovered",
    });
    expect(await recover()).toEqual(recovered);
    expect(await fs.readFile(path.join(library, "SKILL.md"), "utf8")).toBe(f.text("initial"));
    expect(await fs.readFile(f.entry, "utf8")).toBe(native);
    expect(
      (await f.prepare({ operation: "pull", deployment_id: f.id })).targets[0]!.conflicts,
    ).toEqual([]);
  });
});
