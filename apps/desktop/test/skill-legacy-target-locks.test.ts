import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  promises as fs,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyChanges, type ApplyOptions } from "../../../packages/backend/src/change-apply";
import type { ChangeSet, FileChange } from "../../../packages/backend/src/change-plan";
import * as leases from "../../../packages/backend/src/managed-session-lock";
import { SkillManager } from "../../../packages/backend/src/skill-manager";
import { skillPackage } from "../../../packages/backend/src/skill-package";

const folders: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "skill-legacy-locks-")));
  folders.push(root);
  const source = path.join(root, "source");
  const project = path.join(root, "target");
  const backups = path.join(root, "backups");
  for (const directory of [source, project]) mkdirSync(directory);
  const write = (file: string, content: unknown) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  };
  const change = (
    target = path.join(project, ".claude.json"),
    scope: FileChange["scope"] = "agent-home",
  ): FileChange => ({
    target,
    scope,
    original_hash: null,
    before: "",
    after: "{}\n",
    risk: "low",
    validator: "json",
  });
  const apply = (changes: FileChange[], extra: Partial<ApplyOptions> = {}) => {
    const plan: ChangeSet = {
      id: "legacy",
      project_root: source,
      created_at: "2026-10-16T00:00:00.000Z",
      requires_home_approval: changes.some((item) => item.scope === "agent-home"),
      changes,
    };
    return applyChanges(plan, backups, {
      approvedHome: changes
        .filter((item) => item.scope === "agent-home")
        .map((item) => item.target),
      approvedApplication: changes
        .filter((item) => item.scope === "application-data")
        .map((item) => item.target),
      protectedHome: [],
      approveHome: true,
      ...extra,
    });
  };
  const held = (directory: string, fn: () => void) => {
    const release = leases.acquirePortableFileLease(path.join(directory, ".agentkib-skill.lock"));
    try {
      fn();
    } finally {
      release();
    }
  };
  const untouched = (target: string) => {
    expect(existsSync(target)).toBe(false);
    expect(existsSync(backups)).toBe(false);
  };
  return { root, source, project, backups, write, change, apply, held, untouched };
}

async function deploymentFixture() {
  const f = fixture();
  const library = path.join(f.root, "library");
  const source = path.join(library, "skills/demo");
  f.write(
    path.join(source, "SKILL.md"),
    "---\nname: demo\ndescription: Fixture\n---\nManaged instructions\n",
  );
  const hash = (await skillPackage(source)).hash;
  f.write(path.join(library, "skills.lock.json"), {
    schema_version: 2,
    skills: { demo: { content_sha256: hash } },
    previous: {},
  });
  const manager = new SkillManager(library, { HOME: f.project, USERPROFILE: f.project }, () => []);
  const target = (await manager.targets()).find(
    (item) => item.agent === "claude-code" && item.scope === "personal",
  )!;
  const preview = await manager.prepareDeployment({
    operation: "deploy",
    library_id: "demo",
    target_ids: [target.id],
  });
  return { ...f, library, manager, target, preview };
}

describe("legacy ChangeSet actual target locks", () => {
  it.each(["agent-home", "application-data"] as const)(
    "honors the actual %s target lease before preparing any files",
    (scope) => {
      const f = fixture();
      const change = f.change(undefined, scope);
      f.held(f.project, () => expect(() => f.apply([change])).toThrow("another-runtime"));
      f.untouched(change.target);
      expect(existsSync(path.join(f.source, ".agentkib-skill.lock"))).toBe(false);
    },
  );

  it("locks every containing project before writing a nested Home target", () => {
    const f = fixture();
    mkdirSync(path.join(f.project, ".git"));
    const nested = path.join(f.project, "nested");
    mkdirSync(path.join(nested, ".agentkib"), { recursive: true });
    mkdirSync(path.join(nested, ".claude"));
    const change = f.change(path.join(nested, ".claude/settings.json"));
    for (const root of [f.project, nested])
      f.held(root, () => expect(() => f.apply([change])).toThrow("another-runtime"));
    f.untouched(change.target);
  });

  it.each(["scope", "associated-library", "configured-library"])(
    "shares the %s lock used by personal Skill deployment",
    (kind) => {
      const f = fixture();
      const library = path.join(f.root, "library");
      mkdirSync(library);
      mkdirSync(path.join(f.project, "config"));
      f.write(path.join(f.project, ".agentkib/skill-personal-library-roots.json"), {
        schema_version: 1,
        libraries: kind === "configured-library" ? [] : [library],
      });
      const change = f.change(path.join(f.project, "config/settings.json"));
      f.held(kind === "scope" ? f.project : library, () =>
        expect(() =>
          f.apply([change], kind === "configured-library" ? { skillHomes: [library] } : {}),
        ).toThrow("another-runtime"),
      );
      f.untouched(change.target);
    },
  );

  it("applies Home-only changes without trying to create a lease in the unrelated source", () => {
    const f = fixture();
    const acquire = leases.acquirePortableFileLease;
    vi.spyOn(leases, "acquirePortableFileLease").mockImplementation((file) => {
      if (path.dirname(file) === f.source)
        throw Object.assign(new Error("Source is read-only"), { code: "EACCES" });
      return acquire(file);
    });
    const change = f.change();
    expect(f.apply([change]).applied).toEqual([change.target]);
    expect(readFileSync(change.target, "utf8")).toBe(change.after);
    expect(existsSync(path.join(f.source, ".agentkib-skill.lock"))).toBe(false);
  });

  it("still locks project writes and the project containing a legacy Skill source", () => {
    const f = fixture();
    const projectChange = f.change(path.join(f.source, "settings.json"), "project");
    f.held(f.source, () => expect(() => f.apply([projectChange])).toThrow("another-runtime"));
    const source = path.join(f.source, "assets/reviewer");
    mkdirSync(source, { recursive: true });
    const homeChange = { ...f.change(), skill_source: source };
    f.held(f.source, () => expect(() => f.apply([homeChange])).toThrow("another-runtime"));
    f.untouched(homeChange.target);
  });

  it.each(["skill-deployments.json", "skill-deployment-reservations.json"])(
    "rechecks %s created after preview before writing",
    (name) => {
      const f = fixture();
      const change = f.change();
      f.write(path.join(f.project, ".agentkib", name), {
        schema_version: 2,
        deployments: [{ target: change.target, status: "active" }],
      });
      expect(() => f.apply([change])).toThrow("managed Skill deployment");
      f.untouched(change.target);
      f.held(f.project, () => undefined);
    },
  );

  it("rechecks ownership after acquiring the target lease", () => {
    const f = fixture();
    const change = f.change();
    const acquire = leases.acquirePortableFileLease;
    vi.spyOn(leases, "acquirePortableFileLease").mockImplementation((file) => {
      const release = acquire(file);
      if (path.dirname(file) === f.project)
        f.write(path.join(f.project, ".agentkib/skill-deployment-reservations.json"), {
          schema_version: 2,
          deployments: [{ target: change.target }],
        });
      return release;
    });
    expect(() => f.apply([change])).toThrow("managed Skill deployment");
    f.untouched(change.target);
    vi.restoreAllMocks();
    f.held(f.project, () => undefined);
  });

  it("rejects a newly discovered library without extending the held locks out of order", () => {
    const f = fixture();
    const library = path.join(f.root, "a-library");
    mkdirSync(library);
    const change = f.change();
    const acquire = leases.acquirePortableFileLease;
    const acquired: string[] = [];
    vi.spyOn(leases, "acquirePortableFileLease").mockImplementation((file) => {
      const release = acquire(file);
      acquired.push(path.dirname(file));
      f.write(path.join(f.project, ".agentkib/skill-personal-library-roots.json"), {
        schema_version: 1,
        libraries: [library],
      });
      return release;
    });
    expect(() => f.apply([change])).toThrow("ownership changed");
    expect(acquired).toEqual([f.project]);
    f.untouched(change.target);
    vi.restoreAllMocks();
    f.held(f.project, () => undefined);
  });

  it("batches physical aliases and different change orders into the same acquisition order", () => {
    const f = fixture();
    const first = path.join(f.root, "a-target");
    const last = path.join(f.root, "z-target");
    mkdirSync(first);
    mkdirSync(last);
    const alias = path.join(f.root, "0-alias");
    symlinkSync(last, alias, process.platform === "win32" ? "junction" : "dir");
    const acquire = leases.acquirePortableFileLease;
    const acquired: string[] = [];
    vi.spyOn(leases, "acquirePortableFileLease").mockImplementation((file) => {
      acquired.push(path.dirname(file));
      return acquire(file);
    });
    const changes = [
      f.change(path.join(alias, "one.json")),
      f.change(path.join(first, "two.json")),
      f.change(path.join(last, "three.json")),
    ];
    expect(f.apply(changes).applied).toHaveLength(3);
    expect(acquired).toEqual([first, last]);
    for (const change of changes) rmSync(change.target);
    acquired.length = 0;
    expect(f.apply([...changes].reverse()).applied).toHaveLength(3);
    expect(acquired).toEqual([first, last]);
  });

  it("releases earlier leases when a later target is contended", () => {
    const f = fixture();
    const first = path.join(f.root, "a-target");
    mkdirSync(first);
    const changes = [f.change(), f.change(path.join(first, "missing/settings.json"))];
    f.held(f.project, () => expect(() => f.apply(changes)).toThrow("another-runtime"));
    f.held(first, () => undefined);
    for (const change of changes) f.untouched(change.target);
    expect(existsSync(path.join(first, "missing"))).toBe(false);
  });

  it("releases every lease and preserves the apply error if one release fails", () => {
    const f = fixture();
    const first = path.join(f.root, "a-target");
    mkdirSync(first);
    const changes = [f.change(), f.change(path.join(first, "settings.json"))];
    const acquire = leases.acquirePortableFileLease;
    const released: string[] = [];
    vi.spyOn(leases, "acquirePortableFileLease").mockImplementation((file) => {
      const release = acquire(file);
      return () => {
        release();
        released.push(path.dirname(file));
        if (path.dirname(file) === f.project) throw new Error("Release failed");
      };
    });
    let error: unknown;
    try {
      f.apply(changes, { approveHome: false });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map(String)).toEqual([
      expect.stringContaining("requires separate authorization"),
      expect.stringContaining("Release failed"),
    ]);
    expect(released).toEqual([f.project, first]);
    for (const change of changes) f.untouched(change.target);
    vi.restoreAllMocks();
    for (const directory of [first, f.project]) f.held(directory, () => undefined);
  });

  it("blocks the first deployment into a missing scope while its existing ancestor is leased", async () => {
    const f = await deploymentFixture();
    expect(existsSync(f.target.scope_root)).toBe(false);
    const release = leases.acquirePortableFileLease(path.join(f.project, ".agentkib-skill.lock"));
    try {
      const report = await f.manager.applyDeployment({
        token: f.preview.token,
        confirmed: true,
        approve_home: true,
      });
      expect(report.results[0]).toMatchObject({
        success: false,
        error: expect.stringContaining("another-runtime"),
      });
      expect(existsSync(f.target.scope_root)).toBe(false);
      expect(existsSync(path.join(f.library, "skill-deployments.json"))).toBe(false);
      expect(existsSync(f.backups)).toBe(false);
    } finally {
      release();
    }
  });

  it("blocks legacy writes while deployment creates its first scope and before ownership is saved", async () => {
    const f = await deploymentFixture();
    const change = f.change(path.join(f.target.root, "demo/SKILL.md"));
    const mkdir = fs.mkdir.bind(fs);
    let checked = false;
    vi.spyOn(fs, "mkdir").mockImplementation(async (directory, options) => {
      const result = await mkdir(directory, options);
      if (directory === f.target.scope_root && !checked) {
        checked = true;
        expect(existsSync(path.join(f.target.scope_root, ".agentkib"))).toBe(false);
        expect(() => f.apply([change])).toThrow("another-runtime");
        f.untouched(change.target);
      }
      return result;
    });
    const report = await f.manager.applyDeployment({
      token: f.preview.token,
      confirmed: true,
      approve_home: true,
    });
    expect(checked).toBe(true);
    expect(report.results[0], report.results[0]?.error ?? "").toMatchObject({ success: true });
    expect(readFileSync(change.target, "utf8")).toContain("Managed instructions");
  });

  it("rejects recovery when a journal changes targets during lease acquisition", async () => {
    const f = await deploymentFixture();
    const destination = path.join(f.target.root, "demo");
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (to === destination) throw new Error("Interrupted before activation");
      return rename(from, to);
    });
    const failed = await f.manager.applyDeployment({
      token: f.preview.token,
      confirmed: true,
      approve_home: true,
    });
    expect(failed.results[0]).toMatchObject({ status: "recovery-required" });
    vi.restoreAllMocks();
    const journalFile = path.join(
      f.target.scope_root,
      ".agentkib-skill-state/operations",
      failed.operation_id,
      f.target.id,
      "journal.json",
    );
    const reservationFile = path.join(f.library, "skill-deployment-reservations.json");
    const reservationBefore = readFileSync(reservationFile, "utf8");
    const journal = JSON.parse(readFileSync(journalFile, "utf8"));
    const changed = path.join(f.target.root, "changed");
    const acquire = leases.acquirePortableFileLease;
    vi.spyOn(leases, "acquirePortableFileLease").mockImplementation((file) => {
      const release = acquire(file);
      journal.destination = changed;
      journal.next_receipt.target = changed;
      // Keep the receipt valid so recovery reaches the post-lock identity check.
      journal.next_receipt.package_name = path.basename(changed);
      f.write(journalFile, journal);
      return release;
    });
    await expect(f.manager.recoverSyncOperation(failed.operation_id, true)).rejects.toThrow(
      "recovery targets changed",
    );
    expect(readFileSync(reservationFile, "utf8")).toBe(reservationBefore);
    expect(existsSync(journalFile)).toBe(true);
    expect(existsSync(changed)).toBe(false);
    expect(existsSync(destination)).toBe(false);
    vi.restoreAllMocks();
    for (const directory of [f.library, f.project, f.target.scope_root, f.target.root])
      f.held(directory, () => undefined);
  });
});
