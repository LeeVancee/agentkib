import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Skills } from "../../../packages/backend/src/skills";

const homes: string[] = [];
const A = "a".repeat(40),
  B = "b".repeat(40),
  C = "c".repeat(40);
const body = (name = "reviewer", text = "First version") =>
  `---\nname: ${name}\ndescription: Review code changes\n---\n${text}\n`;
type Preview = {
  token: string;
  library_id: string;
  previous_source?: { ref: string };
  skill: { source: Source };
  expires_at: string;
  added: string[];
};
type Source = {
  kind: "github";
  repository: string;
  ref: string;
  ref_type?: "tag" | "branch" | "commit";
  path: string;
  resolved_commit: string;
  tree_sha: string;
};
type Batch = {
  token: string;
  total_size: number;
  expires_at: string;
  items: Array<{
    id: string;
    observation_ids: string[];
    paths: string[];
    agents: string[];
    status: string;
    reason?: string;
    library_id: string;
    preview?: Preview;
  }>;
};
type Report = {
  token: string;
  items: Array<{
    id: string;
    status: string;
    library_id?: string;
    error?: string;
    warnings?: string[];
    skill?: { name: string };
  }>;
};

async function fixture(workspaces: Array<{ id: string; path: string }> = []) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agentkib-skills-lifecycle-"));
  homes.push(home);
  const root = path.join(home, "data");
  const backend = new Skills(
    { HOME: home, USERPROFILE: home, AGENTKIB_HOME: root },
    path.join(home, "cache"),
    () => workspaces,
  );
  return { home, root, backend };
}
async function local(home: string, relative: string, name = "reviewer", text?: string) {
  const folder = path.join(home, relative);
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, "SKILL.md"), body(name, text));
  return folder;
}
async function observations(backend: Skills) {
  return (await backend.manager.inventory()).observations;
}
async function prepareBatch(backend: Skills, ids?: string[]) {
  return (await backend.request("skills.prepareImports", {
    observation_ids: ids ?? (await observations(backend)).map((item) => item.id),
  })) as Batch;
}
async function applyBatch(backend: Skills, batch: Batch) {
  return (await backend.request("skills.applyImports", {
    token: batch.token,
    confirmed: true,
  })) as Report;
}
function source(
  repository = "example/skills",
  ref = "main",
  ref_type: Source["ref_type"] = "branch",
): Source {
  return {
    kind: "github",
    repository,
    ref,
    ref_type,
    path: "skills/reviewer",
    resolved_commit: A,
    tree_sha: "package-a",
  };
}
function github(packagePaths = ["skills/reviewer"], resources: string[] = []) {
  const refs = new Map([
    ["heads/main", A],
    ["heads/next", B],
    ["heads/same", A],
    ["tags/v1", A],
    ["tags/next", C],
  ]);
  const versions = new Map([
    [A, body()],
    [B, body("reviewer", "Second version")],
    [C, body("reviewer", "Tag version")],
  ]);
  const calls: string[] = [];
  const missingPackages = new Set<string>();
  const pages = new Map<string, Array<{ name: string; commit: { sha: string } }>>();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      calls.push(url.href);
      const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if (url.hostname === "raw.githubusercontent.com") {
        const sha = segments[2]!;
        const version = versions.get(sha);
        if (!version) return new Response("Missing", { status: 404 });
        const content = url.pathname.endsWith("/SKILL.md") ? version : "late";
        return new Response(content);
      }
      if (url.hostname !== "api.github.com") throw new Error("Unexpected external request");
      const operation = segments[3];
      if (!operation) return Response.json({ default_branch: "main" });
      if (operation === "branches" || operation === "tags")
        return Response.json(
          pages.get(`${operation}:${url.searchParams.get("page")}`) ?? [
            { name: operation === "tags" ? "v1" : "main", commit: { sha: A } },
          ],
        );
      if (operation === "commits") {
        const ref = segments.slice(4).join("/");
        const sha = refs.get(ref) ?? [A, B, C].find((commit) => commit.startsWith(ref));
        if (!sha) return new Response("Missing ref", { status: 404 });
        return Response.json({ sha, commit: { tree: { sha: `tree-${sha}` } } });
      }
      if (operation === "git" && segments[4] === "trees") {
        const sha = segments[5]!.replace(/^tree-/, "");
        if (missingPackages.has(sha)) return Response.json({ tree: [] });
        const content = versions.get(sha)!;
        return Response.json({
          tree: packagePaths.flatMap((packagePath) => [
            { path: packagePath, type: "tree", mode: "040000", sha: `package-${sha}` },
            {
              path: `${packagePath}/SKILL.md`,
              type: "blob",
              mode: "100644",
              sha: "blob",
              size: Buffer.byteLength(content),
            },
            ...resources.map((resource) => ({
              path: `${packagePath}/${resource}`,
              type: "blob",
              mode: "100644",
              sha: "resource",
              size: 4,
            })),
          ]),
        });
      }
      throw new Error(`Unexpected GitHub fixture route ${url.pathname}`);
    }),
  );
  return { refs, versions, calls, pages, missingPackages };
}
async function install(backend: Skills, from = source()) {
  const preview = (await backend.prepareInstall(from)) as Preview;
  await backend.request("skills.applyOperation", { token: preview.token, confirmed: true });
  return preview;
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
});

describe("Skill batch imports", () => {
  it("combines linked aliases, preserves the complete package and skips only matching source/content", async () => {
    const { backend, home, root } = await fixture();
    const original = await local(home, ".cc-switch/skills/reviewer");
    const ownerMetadata = path.join(home, ".cc-switch/metadata.json");
    await fs.writeFile(ownerMetadata, '{"owner":"cc-switch","enabled":true}');
    const originalMetadata = await fs.readFile(ownerMetadata);
    await fs.mkdir(path.join(home, ".claude/skills"), { recursive: true });
    await fs.symlink(
      original,
      path.join(home, ".claude/skills/reviewer"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await fs.mkdir(path.join(original, "resources/empty"), { recursive: true });
    await fs.mkdir(path.join(original, "agents"));
    await fs.writeFile(path.join(original, "agents/openai.yaml"), "display_name: Reviewer\n");
    await fs.writeFile(path.join(original, "LICENSE"), "Apache-2.0 fixture\n");
    const bytes = Buffer.from([0, 255, 20, 3]);
    await fs.writeFile(path.join(original, "resources/image.png"), bytes);
    await fs.writeFile(path.join(original, "run.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await fs.mkdir(path.join(home, ".cursor/skills"), { recursive: true });
    await fs.symlink(
      original,
      path.join(home, ".cursor/skills/alias"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const initial = await prepareBatch(backend);
    expect(initial.items).toHaveLength(1);
    expect(initial.items[0]!.observation_ids).toHaveLength(3);
    expect(initial.items[0]!.status).toBe("ready");
    const result = await applyBatch(backend, initial);
    expect(result.items[0]!.status).toBe("imported");
    const target = path.join(root, "skills", result.items[0]!.library_id!);
    expect(await fs.readFile(path.join(target, "resources/image.png"))).toEqual(bytes);
    expect(await fs.readFile(path.join(target, "agents/openai.yaml"), "utf8")).toBe(
      "display_name: Reviewer\n",
    );
    expect(await fs.readFile(path.join(target, "LICENSE"), "utf8")).toBe("Apache-2.0 fixture\n");
    expect(await fs.readFile(ownerMetadata)).toEqual(originalMetadata);
    expect((await fs.stat(path.join(target, "resources/empty"))).isDirectory()).toBe(true);
    if (process.platform !== "win32")
      expect((await fs.stat(path.join(target, "run.sh"))).mode & 0o111).toBeTruthy();
    expect(await fs.readFile(path.join(original, "SKILL.md"), "utf8")).toBe(body());
    expect(await applyBatch(backend, initial)).toEqual(result);
    const repeated = await prepareBatch(backend);
    expect(repeated.items[0]!.status).toBe("skipped");
    await fs.writeFile(path.join(target, "SKILL.md"), body("reviewer", "Local edit"));
    const changed = await prepareBatch(backend);
    expect(changed.items[0]!.status).toBe("ready");
    expect(changed.items[0]!.library_id).not.toBe(result.items[0]!.library_id);
  });

  it("keeps different sources with the same name and reports partial failures without replay", async () => {
    const { backend, home, root } = await fixture();
    await local(home, ".claude/skills/one");
    await local(home, ".cursor/skills/two");
    const batch = await prepareBatch(backend);
    expect(batch.items.map((item) => item.status)).toEqual(["ready", "ready"]);
    expect(new Set(batch.items.map((item) => item.library_id)).size).toBe(2);
    const conflict = path.join(root, "skills", batch.items[0]!.library_id);
    await fs.mkdir(conflict, { recursive: true });
    await fs.writeFile(path.join(conflict, "external.txt"), "External installation");
    const report = await applyBatch(backend, batch);
    expect(report.items.map((item) => item.status)).toEqual(["failed", "imported"]);
    expect(await fs.readFile(path.join(conflict, "external.txt"), "utf8")).toBe(
      "External installation",
    );
    expect(await applyBatch(backend, batch)).toEqual(report);
  });

  it.each(["linked-resource", "oversized-resource", "linked-target", "file-target"])(
    "imports a healthy source when an older matching snapshot has a %s",
    async (damage) => {
      const { backend, home, root } = await fixture();
      const original = await local(home, ".cc-switch/skills/reviewer");
      const metadataPath = path.join(home, ".cc-switch/metadata.json");
      const metadata = '{"owner":"cc-switch","enabled":true}';
      await fs.writeFile(metadataPath, metadata);
      const alias = path.join(home, ".claude/skills/reviewer");
      await fs.mkdir(path.dirname(alias), { recursive: true });
      await fs.symlink(original, alias, process.platform === "win32" ? "junction" : "dir");
      const aliasTarget = await fs.readlink(alias);
      const initial = await prepareBatch(backend);
      const sourceIds = initial.items[0]!.observation_ids;
      const imported = await applyBatch(backend, initial);
      const oldId = imported.items[0]!.library_id!;
      const oldTarget = path.join(root, "skills", oldId);
      const resource = path.join(oldTarget, "resource");
      const displaced = path.join(home, "old-library-snapshot");
      const lockPath = path.join(root, "skills.lock.json");
      const oldRecord = JSON.parse(await fs.readFile(lockPath, "utf8")).skills[oldId];
      let preservedLink: string | undefined;
      if (damage === "linked-resource") {
        await fs.symlink(
          path.join(home, "missing-resource"),
          resource,
          process.platform === "win32" ? "junction" : "dir",
        );
        preservedLink = await fs.readlink(resource);
      } else if (damage === "oversized-resource") {
        await fs.writeFile(resource, Buffer.alloc(8 * 1024 * 1024 + 1, 7));
      } else {
        await fs.rename(oldTarget, displaced);
        if (damage === "linked-target") {
          await fs.symlink(displaced, oldTarget, process.platform === "win32" ? "junction" : "dir");
          preservedLink = await fs.readlink(oldTarget);
        } else {
          await fs.writeFile(oldTarget, "External data");
        }
      }

      const batch = await prepareBatch(backend, sourceIds);
      expect(batch.items).toHaveLength(1);
      const item = batch.items[0]!;
      expect(item.status).toBe("ready");
      expect(item.library_id).not.toBe(oldId);
      expect(item.reason).toContain(oldId);
      const report = await applyBatch(backend, batch);
      expect(report.items[0]!.status).toBe("imported");
      expect(
        await fs.readFile(path.join(root, "skills", item.library_id, "SKILL.md"), "utf8"),
      ).toBe(body());
      expect(await fs.readdir(path.join(root, "skills", item.library_id))).toEqual(["SKILL.md"]);
      expect(JSON.parse(await fs.readFile(lockPath, "utf8")).skills[oldId]).toEqual(oldRecord);
      expect(await fs.readFile(path.join(original, "SKILL.md"), "utf8")).toBe(body());
      expect(await fs.readFile(metadataPath, "utf8")).toBe(metadata);
      expect(await fs.readlink(alias)).toBe(aliasTarget);
      if (damage === "linked-resource") {
        expect(await fs.readlink(resource)).toBe(preservedLink);
        expect(await fs.readFile(path.join(oldTarget, "SKILL.md"), "utf8")).toBe(body());
      } else if (damage === "oversized-resource") {
        expect((await fs.readFile(resource)).equals(Buffer.alloc(8 * 1024 * 1024 + 1, 7))).toBe(
          true,
        );
        expect(await fs.readFile(path.join(oldTarget, "SKILL.md"), "utf8")).toBe(body());
      } else {
        expect(await fs.readFile(path.join(displaced, "SKILL.md"), "utf8")).toBe(body());
        if (damage === "linked-target") {
          expect(await fs.readlink(oldTarget)).toBe(preservedLink);
        } else {
          expect(await fs.readFile(oldTarget, "utf8")).toBe("External data");
        }
      }
      expect(await applyBatch(backend, batch)).toEqual(report);
      expect(await fs.readdir(path.join(root, ".staging/skills"))).toEqual([]);

      // The damaged record is encountered first; a later healthy snapshot still deduplicates.
      const repeated = await prepareBatch(backend, sourceIds);
      expect(repeated.items[0]!.status).toBe("skipped");
      expect(repeated.items[0]!.library_id).toBe(item.library_id);
      expect(repeated.items[0]!.reason).toContain(oldId);
      expect((await applyBatch(backend, repeated)).items[0]!.status).toBe("skipped");
    },
  );

  it("still blocks a linked library parent while checking matching snapshots", async () => {
    const { backend, home, root } = await fixture();
    await local(home, ".claude/skills/reviewer");
    const initial = await prepareBatch(backend);
    const sourceIds = initial.items[0]!.observation_ids;
    await applyBatch(backend, initial);
    const library = path.join(root, "skills");
    const displaced = path.join(home, "external-library");
    const lockPath = path.join(root, "skills.lock.json");
    const lockBytes = await fs.readFile(lockPath);
    await fs.rename(library, displaced);
    await fs.symlink(displaced, library, process.platform === "win32" ? "junction" : "dir");
    const linkTarget = await fs.readlink(library);

    await expect(prepareBatch(backend, sourceIds)).rejects.toThrow(/link or non-directory/);
    expect(await fs.readFile(path.join(displaced, "reviewer/SKILL.md"), "utf8")).toBe(body());
    expect(await fs.readdir(displaced)).toEqual(["reviewer"]);
    expect(await fs.readFile(lockPath)).toEqual(lockBytes);
    expect(await fs.readlink(library)).toBe(linkTarget);
  });

  it.each(["removed", "modified", "source-changed", "lock-removed"])(
    "fails a skipped item that was %s after preview without blocking other imports",
    async (change) => {
      const { backend, home, root } = await fixture();
      const original = await local(home, ".claude/skills/reviewer");
      const imported = await applyBatch(backend, await prepareBatch(backend));
      const name = imported.items[0]!.library_id!;
      const target = path.join(root, "skills", name);
      const lockPath = path.join(root, "skills.lock.json");
      await local(home, ".cursor/skills/other", "other");
      const batch = await prepareBatch(backend);
      const skipped = batch.items.find((item) => item.status === "skipped")!;
      expect(skipped.library_id).toBe(name);
      expect(batch.items.filter((item) => item.status === "ready")).toHaveLength(1);

      if (change === "removed") {
        await backend.request("skills.uninstall", { name, confirmed: true });
      } else if (change === "modified") {
        await fs.writeFile(path.join(target, "SKILL.md"), body("reviewer", "Later local edit"));
      } else {
        const lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
        if (change === "source-changed") {
          const otherSource = await local(home, "other-source");
          lock.skills[name].local_source = otherSource;
          lock.skills[name].local_resolved_path = await fs.realpath(otherSource);
        } else {
          delete lock.skills[name];
        }
        await fs.writeFile(lockPath, JSON.stringify(lock));
      }
      const expectedRecord = JSON.parse(await fs.readFile(lockPath, "utf8")).skills[name];
      const report = await applyBatch(backend, batch);
      const failed = report.items.find((item) => item.id === skipped.id)!;
      expect(failed.status).toBe("failed");
      expect(failed.error).toMatch(/changed after preview/);
      const other = report.items.find((item) => item.status === "imported")!;
      expect(other.skill?.name).toBe("other");
      expect(JSON.parse(await fs.readFile(lockPath, "utf8")).skills[name]).toEqual(expectedRecord);
      expect(await fs.readFile(path.join(original, "SKILL.md"), "utf8")).toBe(body());
      if (change === "removed") {
        await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toBe(
          change === "modified" ? body("reviewer", "Later local edit") : body(),
        );
      }
      expect(await applyBatch(backend, batch)).toEqual(report);
      expect(await fs.readdir(path.join(root, ".staging/skills"))).toEqual([]);

      const retry = await prepareBatch(backend, skipped.observation_ids);
      expect(retry.items[0]!.status).toBe("ready");
      const retried = await applyBatch(backend, retry);
      expect(retried.items[0]!.status).toBe("imported");
      expect(
        await fs.readFile(
          path.join(root, "skills", retried.items[0]!.library_id!, "SKILL.md"),
          "utf8",
        ),
      ).toBe(body());
      expect(await applyBatch(backend, batch)).toEqual(report);
      expect(await fs.readFile(path.join(root, "skills/other/SKILL.md"), "utf8")).toBe(
        body("other"),
      );
    },
  );

  it("keeps an unchanged skipped item after lock keys are reordered and imports its sibling", async () => {
    const { backend, home, root } = await fixture();
    await local(home, ".claude/skills/reviewer");
    const first = await applyBatch(backend, await prepareBatch(backend));
    const name = first.items[0]!.library_id!;
    const target = path.join(root, "skills", name);
    await local(home, ".cursor/skills/other", "other");
    const batch = await prepareBatch(backend);
    const skipped = batch.items.find((item) => item.status === "skipped")!;
    const lockPath = path.join(root, "skills.lock.json");
    const lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
    lock.skills[name] = Object.fromEntries(Object.entries(lock.skills[name]).reverse());
    await fs.writeFile(lockPath, JSON.stringify(lock));
    const rename = vi.spyOn(fs, "rename");
    const report = await applyBatch(backend, batch);
    expect(report.items.find((item) => item.id === skipped.id)).toMatchObject({
      status: "skipped",
      library_id: name,
    });
    expect(report.items.filter((item) => item.status === "imported")).toHaveLength(1);
    expect(rename.mock.calls.some(([, destination]) => String(destination) === target)).toBe(false);
    expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toBe(body());
    expect(Object.keys(batch).toSorted()).toEqual(["expires_at", "items", "token", "total_size"]);
    expect(await applyBatch(backend, batch)).toEqual(report);
  });

  it.each(["broken", "outside", "oversized"])(
    "groups shared packages with %s resources into one failure and supports retry",
    async (kind) => {
      const { backend, home, root } = await fixture();
      const original = await local(home, ".cc-switch/skills/reviewer");
      const ownerMetadata = path.join(home, ".cc-switch/metadata.json");
      const metadata = '{"owner":"cc-switch","enabled":true}';
      await fs.writeFile(ownerMetadata, metadata);
      const aliases = [".claude/skills/reviewer", ".cursor/skills/alias"].map((entry) =>
        path.join(home, entry),
      );
      for (const alias of aliases) {
        await fs.mkdir(path.dirname(alias), { recursive: true });
        await fs.symlink(original, alias, process.platform === "win32" ? "junction" : "dir");
      }
      const aliasTargets = await Promise.all(aliases.map((alias) => fs.readlink(alias)));
      const resource = path.join(original, "resource");
      const external = path.join(home, "external");
      if (kind === "oversized") {
        await fs.writeFile(resource, Buffer.alloc(8 * 1024 * 1024 + 1));
      } else {
        if (kind === "outside") {
          await fs.mkdir(external);
          await fs.writeFile(path.join(external, "keep.txt"), "Unchanged");
        }
        await fs.symlink(external, resource, process.platform === "win32" ? "junction" : "dir");
      }
      const resourceTarget = kind === "oversized" ? null : await fs.readlink(resource);
      await local(home, ".cursor/skills/valid", "valid");
      const real = await fs.realpath(original);
      const shared = (await observations(backend)).filter((item) => item.resolved_path === real);
      expect(shared).toHaveLength(3);

      const batch = await prepareBatch(backend);
      expect(batch.items).toHaveLength(2);
      const failed = batch.items.find((item) => item.status === "failed")!;
      expect(failed.observation_ids.toSorted()).toEqual(shared.map((item) => item.id).toSorted());
      expect(failed.paths.toSorted()).toEqual(shared.map((item) => item.path).toSorted());
      expect(failed.agents.toSorted()).toEqual(
        [...new Set(shared.flatMap((item) => item.agents))].toSorted(),
      );
      expect(failed.reason).toContain(kind === "oversized" ? "file limit" : "linked");
      expect(failed.library_id).toBeNull();
      expect(failed.preview).toBeUndefined();
      expect(batch.items.filter((item) => item.status === "ready")).toHaveLength(1);
      const report = await applyBatch(backend, batch);
      expect(report.items[batch.items.indexOf(failed)]!.status).toBe("failed");
      expect(report.items.filter((item) => item.status === "imported")).toHaveLength(1);
      expect(await applyBatch(backend, batch)).toEqual(report);
      expect(await fs.readdir(path.join(root, "skills"))).toEqual(["valid"]);
      expect(await fs.readdir(path.join(root, ".staging/skills"))).toEqual([]);
      expect(await fs.readFile(ownerMetadata, "utf8")).toBe(metadata);
      expect(await fs.readFile(path.join(original, "SKILL.md"), "utf8")).toBe(body());
      for (const [index, alias] of aliases.entries())
        expect(await fs.readlink(alias)).toBe(aliasTargets[index]);
      if (kind === "oversized") {
        expect((await fs.stat(resource)).size).toBe(8 * 1024 * 1024 + 1);
      } else {
        expect(await fs.readlink(resource)).toBe(resourceTarget);
        if (kind === "outside")
          expect(await fs.readFile(path.join(external, "keep.txt"), "utf8")).toBe("Unchanged");
      }

      await fs.rm(resource);
      const retry = await prepareBatch(backend, failed.observation_ids);
      expect(retry.items).toHaveLength(1);
      expect(retry.items[0]!.status).toBe("ready");
      expect((await applyBatch(backend, retry)).items[0]!.status).toBe("imported");
      expect((await prepareBatch(backend, failed.observation_ids)).items[0]!.status).toBe(
        "skipped",
      );
      expect(await fs.readFile(ownerMetadata, "utf8")).toBe(metadata);
      expect((await fs.readdir(path.join(root, "skills"))).toSorted()).toEqual([
        "reviewer",
        "valid",
      ]);
    },
  );

  it.each(["linked", "oversized", "changed"])(
    "discards a shared snapshot when a later alias has %s contents",
    async (kind) => {
      const { backend, home, root } = await fixture();
      const original = await local(home, ".cc-switch/skills/reviewer");
      for (const entry of [".claude/skills/reviewer", ".cursor/skills/alias"]) {
        const alias = path.join(home, entry);
        await fs.mkdir(path.dirname(alias), { recursive: true });
        await fs.symlink(original, alias, process.platform === "win32" ? "junction" : "dir");
      }
      const inventory = await backend.manager.inventory();
      expect(inventory.observations).toHaveLength(3);
      vi.spyOn(backend.manager, "inventory").mockResolvedValue(inventory);
      const real = await fs.realpath(original);
      const staging = path.join(root, ".staging/skills");
      const realpath = fs.realpath.bind(fs);
      let modified = false;
      vi.spyOn(fs, "realpath").mockImplementation((async (
        value: Parameters<typeof fs.realpath>[0],
        ...args: unknown[]
      ) => {
        if (String(value) === real && !modified) {
          const entries = await fs.readdir(staging).catch(() => []);
          const snapshots = await Promise.all(
            entries.map((entry) =>
              fs.readFile(path.join(staging, entry, "package/SKILL.md"), "utf8").catch(() => null),
            ),
          );
          // Simulate an external edit after the first alias has a complete snapshot.
          if (snapshots.includes(body())) {
            modified = true;
            if (kind === "linked") {
              await fs.symlink(
                path.join(home, "missing-resource"),
                path.join(original, "resource"),
                process.platform === "win32" ? "junction" : "dir",
              );
            } else if (kind === "oversized") {
              await fs.writeFile(
                path.join(original, "resource"),
                Buffer.alloc(8 * 1024 * 1024 + 1),
              );
            } else {
              await fs.writeFile(path.join(original, "SKILL.md"), body("reviewer", "Later edit"));
            }
          }
        }
        return realpath(value, ...(args as []));
      }) as typeof fs.realpath);
      const batch = await prepareBatch(backend);
      expect(modified).toBe(true);
      expect(batch.items).toHaveLength(1);
      expect(batch.items[0]).toMatchObject({ status: "failed", library_id: null });
      expect(batch.items[0]!.observation_ids).toHaveLength(3);
      expect(batch.items[0]!.paths).toHaveLength(3);
      expect(batch.items[0]!.preview).toBeUndefined();
      expect(batch.items[0]!.reason).toContain(
        kind === "linked" ? "linked" : kind === "oversized" ? "file limit" : "changed",
      );
      expect(batch.total_size).toBe(0);
      expect(await fs.readdir(staging)).toEqual([]);
      expect((await applyBatch(backend, batch)).items).toMatchObject([{ status: "failed" }]);
      await expect(fs.stat(path.join(root, "skills/reviewer"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("retains completed reports after preview expiry and more than 64 later batches", async () => {
    const { backend, home, root } = await fixture();
    await local(home, ".claude/skills/reviewer");
    const batch = await prepareBatch(backend);
    const report = await applyBatch(backend, batch);
    expect(report.items[0]!.status).toBe("imported");
    const lockPath = path.join(root, "skills.lock.json");
    const lock = await fs.readFile(lockPath, "utf8");
    const target = path.join(root, "skills", report.items[0]!.library_id!, "SKILL.md");
    await fs.writeFile(target, body("reviewer", "Later local edit"));

    vi.spyOn(Date, "now").mockReturnValue(Date.parse(batch.expires_at) + 24 * 60 * 60_000);
    vi.spyOn(backend.manager, "inventory").mockResolvedValue({ observations: [], warnings: [] });
    for (let index = 0; index < 65; index++) {
      const later = await prepareBatch(backend, ["missing-observation"]);
      expect((await applyBatch(backend, later)).items[0]!.status).toBe("failed");
    }
    const rename = vi.spyOn(fs, "rename");
    expect(await applyBatch(backend, batch)).toEqual(report);
    expect(rename).not.toHaveBeenCalled();
    expect(await fs.readFile(target, "utf8")).toBe(body("reviewer", "Later local edit"));
    expect(await fs.readFile(lockPath, "utf8")).toBe(lock);
    expect(await fs.readdir(path.join(root, "skills"))).toHaveLength(1);
  });

  it("keeps frozen source identity when its old path becomes a link to another source", async () => {
    const { backend, home, root } = await fixture();
    const original = await local(home, ".claude/skills/reviewer");
    const first = await applyBatch(backend, await prepareBatch(backend));
    const originalId = first.items[0]!.library_id!;
    const lockPath = path.join(root, "skills.lock.json");
    const originalRecord = JSON.parse(await fs.readFile(lockPath, "utf8")).skills[originalId];
    expect(originalRecord.local_resolved_path).toBe(await fs.realpath(original));

    await fs.rename(original, path.join(home, "moved-original"));
    const other = await local(home, ".cursor/skills/reviewer");
    await fs.symlink(other, original, process.platform === "win32" ? "junction" : "dir");
    const batch = await prepareBatch(backend);
    expect(batch.items).toHaveLength(1);
    expect(batch.items[0]!.paths).toHaveLength(2);
    expect(batch.items[0]!.status).toBe("ready");
    expect(batch.items[0]!.library_id).not.toBe(originalId);
    expect(JSON.parse(await fs.readFile(lockPath, "utf8")).skills[originalId]).toEqual(
      originalRecord,
    );
    const second = await applyBatch(backend, batch);
    expect(second.items[0]!.status).toBe("imported");
    const lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
    expect(lock.skills[originalId]).toEqual(originalRecord);
    expect(lock.skills[second.items[0]!.library_id!].local_resolved_path).toBe(
      await fs.realpath(other),
    );
    expect(await fs.readdir(path.join(root, "skills"))).toHaveLength(2);
  });

  it.each(["native-restricted", "pending-trust", "unverified"])(
    "allows %s observations while isolating invalid packages",
    async (status) => {
      const { backend, home } = await fixture();
      await local(home, ".hermes/skills/reviewer");
      const items = await observations(backend);
      vi.spyOn(backend.manager, "inventory").mockResolvedValue({
        observations: [
          { ...items[0]!, status, diagnostics: ["Native configuration needs attention"] },
        ],
        warnings: [],
      });
      const batch = await prepareBatch(backend, [items[0]!.id, "missing-observation"]);
      expect(batch.items.map((item) => item.status)).toEqual(["ready", "failed"]);
      expect(batch.items[0]!.reason).toContain(status);
      expect((await applyBatch(backend, batch)).items.map((item) => item.status)).toEqual([
        "imported",
        "failed",
      ]);
    },
  );

  it("serves frozen batch contents, cleans cancelled/expired previews, and validates selection", async () => {
    const { backend, home, root } = await fixture();
    const origin = await local(home, ".claude/skills/reviewer");
    const batch = await prepareBatch(backend);
    await fs.writeFile(path.join(origin, "SKILL.md"), body("reviewer", "New source"));
    const preview = (await backend.request("skills.readPreviewFile", {
      token: batch.token,
      item_id: batch.items[0]!.id,
      path: "SKILL.md",
    })) as { after: string };
    expect(preview.after).toBe(body());
    await backend.request("skills.discardPreview", { token: batch.token });
    await expect(applyBatch(backend, batch)).rejects.toThrow(/expired/);
    expect(await fs.readdir(path.join(root, ".staging/skills"))).toEqual([]);
    const next = await prepareBatch(backend);
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(next.expires_at) + 1);
    await expect(applyBatch(backend, next)).rejects.toThrow(/expired/);
    expect(await fs.readdir(path.join(root, ".staging/skills"))).toEqual([]);
    await expect(prepareBatch(backend, [])).rejects.toThrow(/unique/);
    await expect(prepareBatch(backend, ["same", "same"])).rejects.toThrow(/unique/);
  });

  it.each(["single", "batch"])(
    "reclaims expired %s snapshots after restarting the backend",
    async (kind) => {
      const { backend, home, root } = await fixture();
      const origin = await local(home, ".claude/skills/reviewer");
      const preview =
        kind === "batch"
          ? await prepareBatch(backend)
          : await backend.prepareImport((await observations(backend))[0]!.id);
      const staging = path.join(root, ".staging/skills");
      const previousDirectories = await fs.readdir(staging);
      expect(previousDirectories).toHaveLength(1);
      vi.spyOn(Date, "now").mockReturnValue(Date.parse(String(preview.expires_at)) + 1);
      const restarted = new Skills(
        { HOME: home, USERPROFILE: home, AGENTKIB_HOME: root },
        path.join(home, "cache"),
      );
      await restarted.installed();
      await restarted.manager.inventory();
      expect(await fs.readdir(staging)).toEqual(previousDirectories);
      await restarted.request("skills.discardPreview", { token: preview.token });
      expect(await fs.readdir(staging)).toEqual([]);
      await expect(
        restarted.request("skills.applyOperation", { token: preview.token, confirmed: true }),
      ).rejects.toThrow(/expired/);
      const next = await prepareBatch(restarted);
      const directories = await fs.readdir(staging);
      expect(directories).toHaveLength(1);
      expect(directories[0]).not.toBe(previousDirectories[0]);
      const result = await applyBatch(restarted, next);
      expect(result.items[0]!.status).toBe("imported");
      expect(await fs.readFile(path.join(origin, "SKILL.md"), "utf8")).toBe(body());
    },
  );

  it("preserves unexpired snapshots owned by another backend instance", async () => {
    const { backend, home, root } = await fixture();
    await local(home, ".claude/skills/reviewer");
    const first = await prepareBatch(backend);
    const restarted = new Skills(
      { HOME: home, USERPROFILE: home, AGENTKIB_HOME: root },
      path.join(home, "cache"),
    );
    const next = await prepareBatch(restarted);
    const staging = path.join(root, ".staging/skills");
    expect(await fs.readdir(staging)).toHaveLength(2);
    const file = (await backend.request("skills.readPreviewFile", {
      token: first.token,
      item_id: first.items[0]!.id,
      path: "SKILL.md",
    })) as { after: string };
    expect(file.after).toBe(body());
    await backend.request("skills.discardPreview", { token: first.token });
    expect(await fs.readdir(staging)).toHaveLength(1);
    expect((await applyBatch(restarted, next)).items[0]!.status).toBe("imported");
  });

  it("protects in-progress copies and persists the completed batch expiry", async () => {
    const { backend, home, root } = await fixture();
    await local(home, ".claude/skills/reviewer");
    const copyFile = fs.copyFile.bind(fs);
    let unblock = () => {};
    let copied = () => {};
    const blocked = new Promise<void>((resolve) => {
      copied = resolve;
    });
    const release = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    vi.spyOn(fs, "copyFile").mockImplementation(async (from, to, mode) => {
      if (String(to).includes(`${path.sep}.staging${path.sep}`)) {
        copied();
        await release;
      }
      return copyFile(from, to, mode);
    });
    const preparing = prepareBatch(backend);
    await blocked;
    const staging = path.join(root, ".staging/skills");
    const [directory] = await fs.readdir(staging);
    const marker = path.join(staging, directory!, ".agentkib-preview.json");
    const initial = JSON.parse(await fs.readFile(marker, "utf8")) as { expires_at: string };
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(initial.expires_at) + 1);
    const restarted = new Skills(
      { HOME: home, USERPROFILE: home, AGENTKIB_HOME: root },
      path.join(home, "cache"),
    );
    try {
      await restarted.request("skills.discardPreview", { token: "unknown" });
      expect(await fs.readdir(staging)).toEqual([directory]);
    } finally {
      unblock();
    }
    const batch = await preparing;
    const metadata = JSON.parse(await fs.readFile(marker, "utf8")) as { expires_at: string };
    expect(Date.parse(metadata.expires_at)).toBeGreaterThan(Date.parse(initial.expires_at));
    expect(metadata.expires_at).toBe(batch.expires_at);
    await restarted.request("skills.discardPreview", { token: batch.token });
    const file = (await backend.request("skills.readPreviewFile", {
      token: batch.token,
      item_id: batch.items[0]!.id,
      path: "SKILL.md",
    })) as { after: string };
    expect(file.after).toBe(body());
  });

  it("protects an applying batch from orphan cleanup in another instance", async () => {
    const { backend, home, root } = await fixture();
    await local(home, ".claude/skills/reviewer");
    const batch = await prepareBatch(backend);
    const rename = fs.rename.bind(fs);
    let unblock = () => {};
    let moving = () => {};
    const blocked = new Promise<void>((resolve) => {
      moving = resolve;
    });
    const release = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (path.basename(String(from)) === "package") {
        moving();
        await release;
      }
      return rename(from, to);
    });
    const applying = applyBatch(backend, batch);
    await blocked;
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(batch.expires_at) + 1);
    const restarted = new Skills(
      { HOME: home, USERPROFILE: home, AGENTKIB_HOME: root },
      path.join(home, "cache"),
    );
    try {
      await restarted.request("skills.discardPreview", { token: batch.token });
      expect(await fs.readdir(path.join(root, ".staging/skills"))).toHaveLength(1);
    } finally {
      unblock();
    }
    expect((await applying).items[0]!.status).toBe("imported");
    expect(
      await fs.readFile(path.join(root, "skills", batch.items[0]!.library_id, "SKILL.md"), "utf8"),
    ).toBe(body());
  });

  it.each(["single", "batch"])(
    "protects an accepted %s snapshot before the first asynchronous cleanup",
    async (kind) => {
      const { backend, home, root } = await fixture();
      await local(home, ".claude/skills/reviewer");
      const preview =
        kind === "batch"
          ? await prepareBatch(backend)
          : await backend.prepareImport((await observations(backend))[0]!.id);
      const staging = path.join(root, ".staging/skills");
      const lstat = fs.lstat.bind(fs);
      let paused = false;
      let unblock = () => {};
      let entered = () => {};
      const blocked = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const release = new Promise<void>((resolve) => {
        unblock = resolve;
      });
      vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        if (!paused && String(args[0]) === staging) {
          paused = true;
          entered();
          await release;
        }
        return lstat(...args);
      });
      const clock = vi
        .spyOn(Date, "now")
        .mockReturnValue(Date.parse(String(preview.expires_at)) - 1);
      const applying = backend.request(
        kind === "batch" ? "skills.applyImports" : "skills.applyOperation",
        {
          token: preview.token,
          confirmed: true,
        },
      );
      await blocked;
      clock.mockReturnValue(Date.parse(String(preview.expires_at)) + 1);
      const restarted = new Skills(
        { HOME: home, USERPROFILE: home, AGENTKIB_HOME: root },
        path.join(home, "cache"),
      );
      try {
        if (kind === "single") {
          // Retaining new previews must not evict a snapshot already accepted by apply.
          const id = (await observations(backend))[0]!.id;
          for (let index = 0; index < 4; index++) await backend.prepareImport(id);
        }
        await restarted.request("skills.discardPreview", { token: preview.token });
        expect(await fs.readdir(staging)).toHaveLength(kind === "single" ? 4 : 1);
      } finally {
        unblock();
        await applying.catch(() => undefined);
      }
      const result = await applying;
      if (kind === "batch") expect((result as Report).items[0]!.status).toBe("imported");
      else expect((result as { name: string }).name).toBe("reviewer");
      expect(await fs.readFile(path.join(root, "skills/reviewer/SKILL.md"), "utf8")).toBe(body());
    },
  );

  it("leaves unknown staging entries and linked metadata untouched when reclaiming snapshots", async () => {
    const { backend, home, root } = await fixture();
    await local(home, ".claude/skills/reviewer");
    const batch = await prepareBatch(backend);
    const staging = path.join(root, ".staging/skills");
    const [directory] = await fs.readdir(staging);
    const markerName = ".agentkib-preview.json";
    const metadata = await fs.readFile(path.join(staging, directory!, markerName), "utf8");
    const outside = path.join(home, "unrelated");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "keep.txt"), "Keep external data");
    await fs.writeFile(path.join(outside, "marker.json"), metadata);
    await fs.symlink(
      outside,
      path.join(staging, "preview-linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const unmarked = path.join(staging, "preview-unmarked");
    await fs.mkdir(unmarked);
    await fs.writeFile(path.join(unmarked, "keep.txt"), "Keep unknown data");
    const malformed = path.join(staging, "preview-malformed");
    await fs.mkdir(malformed);
    await fs.writeFile(path.join(malformed, markerName), "{invalid JSON");
    const linkedMarker = path.join(staging, `${directory!}-copy`);
    await fs.mkdir(linkedMarker);
    await fs.symlink(path.join(outside, "marker.json"), path.join(linkedMarker, markerName));
    const mismatched = path.join(staging, `${directory!}-other`);
    await fs.mkdir(mismatched);
    await fs.writeFile(path.join(mismatched, markerName), metadata);
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(batch.expires_at) + 1);
    const restarted = new Skills(
      { HOME: home, USERPROFILE: home, AGENTKIB_HOME: root },
      path.join(home, "cache"),
    );
    await restarted.request("skills.discardPreview", { token: batch.token });
    expect((await fs.readdir(staging)).sort()).toEqual(
      [
        path.basename(linkedMarker),
        path.basename(mismatched),
        "preview-linked",
        "preview-malformed",
        "preview-unmarked",
      ].sort(),
    );
    expect(await fs.readFile(path.join(outside, "keep.txt"), "utf8")).toBe("Keep external data");
    expect(await fs.readFile(path.join(unmarked, "keep.txt"), "utf8")).toBe("Keep unknown data");
    expect(await fs.readFile(path.join(outside, "marker.json"), "utf8")).toBe(metadata);
  });

  it.each(["creation", "completion"])(
    "cleans snapshots when metadata writing fails at %s",
    async (phase) => {
      const { backend, home, root } = await fixture();
      const origin = await local(home, ".claude/skills/reviewer");
      const writeFile = fs.writeFile.bind(fs);
      let writes = 0;
      vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
        if (
          path.basename(String(args[0])).startsWith(".agentkib-preview.json.") &&
          ++writes === (phase === "creation" ? 1 : 2)
        ) {
          throw new Error("Fixture preview metadata write failed");
        }
        return writeFile(...args);
      });
      if (phase === "creation") {
        const batch = await prepareBatch(backend);
        expect(batch.items[0]!.status).toBe("failed");
        expect(batch.items[0]!.reason).toContain("metadata write failed");
      } else {
        await expect(prepareBatch(backend)).rejects.toThrow(/metadata write failed/);
      }
      expect(await fs.readdir(path.join(root, ".staging/skills"))).toEqual([]);
      expect(await fs.readFile(path.join(origin, "SKILL.md"), "utf8")).toBe(body());
      expect(await backend.installed()).toEqual([]);
    },
  );

  it.each(["original", "restarted"])(
    "does not follow a replaced staging root in the %s backend",
    async (kind) => {
      const { backend, home, root } = await fixture();
      await local(home, ".claude/skills/reviewer");
      const batch = await prepareBatch(backend);
      const staging = path.join(root, ".staging/skills");
      const outside = path.join(home, "outside-staging");
      await fs.rename(staging, outside);
      await fs.symlink(outside, staging, process.platform === "win32" ? "junction" : "dir");
      const before = await fs.readdir(outside);
      vi.spyOn(Date, "now").mockReturnValue(Date.parse(batch.expires_at) + 1);
      const restarted = new Skills(
        { HOME: home, USERPROFILE: home, AGENTKIB_HOME: root },
        path.join(home, "cache"),
      );
      await expect(prepareBatch(kind === "original" ? backend : restarted)).rejects.toThrow(
        /link|directory/,
      );
      expect(await fs.readdir(outside)).toEqual(before);
    },
  );

  it("does not mistake a successful write for failure when refresh fails", async () => {
    const { backend, home, root } = await fixture();
    await local(home, ".claude/skills/reviewer");
    const batch = await prepareBatch(backend);
    vi.spyOn(backend, "installed").mockRejectedValue(new Error("Refresh unavailable"));
    const report = await applyBatch(backend, batch);
    expect(report.items[0]!.status).toBe("imported");
    expect(report.items[0]!.warnings?.join(" ")).toContain("refresh");
    expect(
      await fs.readFile(
        path.join(root, "skills", report.items[0]!.library_id!, "SKILL.md"),
        "utf8",
      ),
    ).toBe(body());
    expect(await applyBatch(backend, batch)).toEqual(report);
  });

  it("does not follow a link placed at the reviewed destination", async () => {
    const { backend, home, root } = await fixture();
    const original = await local(home, ".claude/skills/reviewer");
    const batch = await prepareBatch(backend);
    await fs.symlink(
      original,
      path.join(root, "skills", batch.items[0]!.library_id),
      process.platform === "win32" ? "junction" : "dir",
    );
    const report = await applyBatch(backend, batch);
    expect(report.items[0]!.status).toBe("failed");
    expect(await fs.readFile(path.join(original, "SKILL.md"), "utf8")).toBe(body());
  });
});

describe("Skill preview and remote source concurrency", () => {
  it("retains at most four single previews when completion receipts overlap and preserves batches", async () => {
    github();
    const { backend, home, root } = await fixture();
    await local(home, ".claude/skills/local", "local");
    const batch = await prepareBatch(backend);
    const previews: Preview[] = [];
    for (let index = 0; index < 3; index++)
      previews.push((await backend.prepareInstall(source())) as Preview);
    const rename = fs.rename.bind(fs);
    const readFile = fs.readFile.bind(fs);
    const receiptWrites = new Map<string, number>();
    const packageReads = new Map<string, number>();
    let pausedDirectory = "";
    let released = false;
    let unblock = () => {};
    const release = new Promise<void>((resolve) => {
      unblock = () => {
        released = true;
        resolve();
      };
    });
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (path.basename(String(to)) === ".agentkib-preview.json") {
        const directory = path.dirname(String(to));
        const writes = (receiptWrites.get(directory) ?? 0) + 1;
        receiptWrites.set(directory, writes);
        if (writes === 2 && !pausedDirectory) {
          pausedDirectory = directory;
          await release;
        }
      }
      return rename(from, to);
    });
    vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      const result = await readFile(...args);
      const file = String(args[0]);
      if (file.endsWith(path.join("package", "SKILL.md"))) {
        const directory = path.dirname(path.dirname(file));
        const reads = (packageReads.get(directory) ?? 0) + 1;
        packageReads.set(directory, reads);
        // The last package-hash read completes before retention. Release on the
        // next event-loop turn, after this request has entered the retention queue.
        if (pausedDirectory && directory !== pausedDirectory && reads === 4) setImmediate(unblock);
      }
      return result;
    });
    const first = backend.prepareInstall(source()) as Promise<Preview>;
    let second: Promise<Preview> | undefined;
    try {
      await vi.waitFor(() => expect(pausedDirectory).not.toBe(""), { timeout: 2_000 });
      second = backend.prepareInstall(source()) as Promise<Preview>;
      previews.push(...(await Promise.all([first, second])));
      expect(released).toBe(true);
    } finally {
      unblock();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
    }
    const readable = await Promise.allSettled(
      previews.map((preview) =>
        backend.request("skills.readPreviewFile", { token: preview.token, path: "SKILL.md" }),
      ),
    );
    expect(readable.map((result) => result.status)).toEqual([
      "rejected",
      "fulfilled",
      "fulfilled",
      "fulfilled",
      "fulfilled",
    ]);
    expect(await fs.readdir(path.join(root, ".staging/skills"))).toHaveLength(5);
    expect(
      await backend.request("skills.readPreviewFile", {
        token: batch.token,
        item_id: batch.items[0]!.id,
        path: "SKILL.md",
      }),
    ).toMatchObject({ after: body("local") });
    expect((await applyBatch(backend, batch)).items[0]!.status).toBe("imported");
  });

  it.each(["single", "batch"])(
    "cleans a failed %s completion receipt and accepts later single and batch previews",
    async (kind) => {
      github();
      const { backend, home, root } = await fixture();
      await local(home, ".claude/skills/local", "local");
      const prior: Preview[] = [];
      for (let index = 0; index < 3; index++)
        prior.push((await backend.prepareInstall(source())) as Preview);
      const rename = fs.rename.bind(fs);
      const receiptWrites = new Map<string, number>();
      let failedDirectory = "";
      const failure = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        if (path.basename(String(to)) === ".agentkib-preview.json") {
          const directory = path.dirname(String(to));
          const writes = (receiptWrites.get(directory) ?? 0) + 1;
          receiptWrites.set(directory, writes);
          if (writes === 2 && !failedDirectory) {
            failedDirectory = directory;
            throw new Error("Fixture completion receipt failed");
          }
        }
        return rename(from, to);
      });
      await expect(
        kind === "single" ? backend.prepareInstall(source()) : prepareBatch(backend),
      ).rejects.toThrow("Fixture completion receipt failed");
      failure.mockRestore();
      expect(failedDirectory).not.toBe("");
      expect(await fs.lstat(failedDirectory).catch(() => null)).toBeNull();
      expect(await fs.readdir(path.join(root, ".staging/skills"))).toHaveLength(3);
      const single = (await backend.prepareInstall(source())) as Preview;
      const batch = await prepareBatch(backend);
      for (const preview of [...prior, single])
        expect(
          await backend.request("skills.readPreviewFile", {
            token: preview.token,
            path: "SKILL.md",
          }),
        ).toMatchObject({ after: body() });
      expect((await applyBatch(backend, batch)).items[0]!.status).toBe("imported");
      await backend.request("skills.applyOperation", { token: single.token, confirmed: true });
      expect((await backend.installed()).map((skill) => skill.display_name).sort()).toEqual([
        "local",
        "reviewer",
      ]);
    },
  );

  it.each(["main", "next"])(
    "rejects a %s installation prepared while the same repository/path is committed",
    async (ref) => {
      github();
      const { backend, root } = await fixture();
      const first = (await backend.prepareInstall(source())) as Preview;
      const fetchFixture = vi.mocked(fetch).getMockImplementation()!;
      let downloading = false;
      let unblock = () => {};
      const release = new Promise<void>((resolve) => {
        unblock = resolve;
      });
      vi.mocked(fetch).mockImplementation(async (...args) => {
        if (new URL(String(args[0])).hostname === "raw.githubusercontent.com") {
          downloading = true;
          await release;
        }
        return fetchFixture(...args);
      });
      const pending = backend.prepareInstall(source("EXAMPLE/SKILLS", ref));
      const outcome = pending.then(
        (preview) => ({ preview, error: undefined }),
        (error: unknown) => ({ preview: undefined, error }),
      );
      try {
        await vi.waitFor(() => expect(downloading).toBe(true), { timeout: 2_000 });
        await backend.request("skills.applyOperation", { token: first.token, confirmed: true });
      } finally {
        unblock();
      }
      expect((await outcome).error).toBeInstanceOf(Error);
      expect(String((await outcome).error)).toMatch(/installed while preparing|prepare.*again/i);
      expect((await backend.installed()).map((skill) => skill.name)).toEqual([first.library_id]);
      expect(await fs.readdir(path.join(root, ".staging/skills"))).toEqual([]);
      if (ref === "main") {
        const retry = (await backend.prepareInstall(source("EXAMPLE/SKILLS"))) as Preview;
        expect(retry).toMatchObject({ library_id: first.library_id, operation: "update" });
        await backend.request("skills.applyOperation", { token: retry.token, confirmed: true });
      } else {
        await expect(backend.prepareInstall(source("EXAMPLE/SKILLS", ref))).rejects.toThrow(
          /Change version/,
        );
        const retry = (await backend.request("skills.prepareVersionChange", {
          library_id: first.library_id,
          selector: { type: "branch", value: ref },
        })) as Preview;
        expect(retry.library_id).toBe(first.library_id);
        await backend.request("skills.applyOperation", { token: retry.token, confirmed: true });
      }
      expect((await backend.installed()).map((skill) => skill.name)).toEqual([first.library_id]);
      expect((await backend.installed())[0]!.source?.ref).toBe(ref);
    },
  );

  it.each(["main", "next"])(
    "rejects applying a stale new ID after the same source is installed from %s in another ID",
    async (ref) => {
      github();
      const { backend, home, root } = await fixture();
      await local(home, ".claude/skills/reviewer");
      const imported = await applyBatch(backend, await prepareBatch(backend));
      expect(imported.items[0]!.library_id).toBe("reviewer");
      const stale = (await backend.prepareInstall(source())) as Preview;
      expect(stale.library_id).not.toBe("reviewer");
      // Removing the local library package releases its ID without changing the
      // already frozen remote preview; a later installation takes that ID.
      await backend.request("skills.uninstall", { name: "reviewer", confirmed: true });
      const current = await install(backend, source("EXAMPLE/SKILLS", ref));
      expect(current.library_id).toBe("reviewer");
      const lockPath = path.join(root, "skills.lock.json");
      const committed = await fs.readFile(lockPath, "utf8");
      await expect(
        backend.request("skills.applyOperation", { token: stale.token, confirmed: true }),
      ).rejects.toThrow(/installed after preview|prepare.*again/i);
      expect(await fs.readFile(lockPath, "utf8")).toBe(committed);
      expect(
        await fs.lstat(path.join(root, "skills", stale.library_id)).catch(() => null),
      ).toBeNull();
      expect((await backend.installed()).map((skill) => skill.name)).toEqual([current.library_id]);
      expect((await backend.installed())[0]!.source).toMatchObject({ ref });
      expect(await fs.readFile(path.join(root, "skills/reviewer/SKILL.md"), "utf8")).toBe(
        body("reviewer", ref === "main" ? "First version" : "Second version"),
      );
      expect(await fs.readdir(path.join(root, ".staging/skills"))).toEqual([]);
      expect(await fs.readFile(path.join(home, ".claude/skills/reviewer/SKILL.md"), "utf8")).toBe(
        body(),
      );
    },
  );

  it("retains independent remote packages at different repositories or paths", async () => {
    github(["skills/reviewer", "skills/alternate"]);
    const { backend } = await fixture();
    const first = await install(backend);
    const differentPath = await install(backend, { ...source(), path: "skills/alternate" });
    const differentRepository = await install(backend, source("another/skills"));
    expect(
      new Set([first.library_id, differentPath.library_id, differentRepository.library_id]).size,
    ).toBe(3);
    expect((await backend.installed()).map((skill) => skill.source)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ repository: "example/skills", path: "skills/reviewer" }),
        expect.objectContaining({ repository: "example/skills", path: "skills/alternate" }),
        expect.objectContaining({ repository: "another/skills", path: "skills/reviewer" }),
      ]),
    );
  });
});

describe("Skill failed remote download cleanup", () => {
  function checkpoint() {
    let resolve = () => {};
    let reached = false;
    const promise = new Promise<void>((ready) => {
      resolve = ready;
    });
    return {
      promise,
      get reached() {
        return reached;
      },
      resolve() {
        reached = true;
        resolve();
      },
    };
  }

  function failedResponse(status: number, observed: ReturnType<typeof checkpoint>) {
    const response = new Response("Fixture download failed", { status });
    Object.defineProperty(response, "ok", {
      get() {
        observed.resolve();
        return false;
      },
    });
    return response;
  }

  it.each(
    (["install", "update", "version-change"] as const).flatMap((operation) =>
      (["mkdir", "writeFile"] as const).map((boundary) => ({ operation, boundary })),
    ),
  )(
    "waits for a pending $boundary before cleaning a failed $operation and permits retry",
    async ({ operation, boundary }) => {
      const remote = github(["skills/reviewer"], ["docs/late.txt"]);
      const { backend, root } = await fixture();
      if (operation !== "install") await install(backend);
      if (operation === "update") remote.refs.set("heads/main", B);
      const lockPath = path.join(root, "skills.lock.json");
      const currentPath = path.join(root, "skills/reviewer/SKILL.md");
      const originalLock = await fs.readFile(lockPath, "utf8").catch(() => null);
      const originalContent = await fs.readFile(currentPath, "utf8").catch(() => null);
      const started = checkpoint();
      const release = checkpoint();
      const written = checkpoint();
      const failed = checkpoint();
      const mkdir = fs.mkdir.bind(fs);
      const writeFile = fs.writeFile.bind(fs);
      const mkdirSpy = vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
        if (boundary === "mkdir" && String(args[0]).endsWith(path.join("package", "docs"))) {
          started.resolve();
          await release.promise;
        }
        return mkdir(...args);
      });
      const writeSpy = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
        const isLateResource = String(args[0]).endsWith(path.join("package", "docs/late.txt"));
        if (isLateResource && boundary === "writeFile") {
          started.resolve();
          await release.promise;
        }
        try {
          return await writeFile(...args);
        } finally {
          if (isLateResource) written.resolve();
        }
      });
      const fetchFixture = vi.mocked(fetch).getMockImplementation()!;
      vi.mocked(fetch).mockImplementation(async (...args) => {
        const url = new URL(String(args[0]));
        if (url.hostname === "raw.githubusercontent.com" && url.pathname.endsWith("/SKILL.md")) {
          await started.promise;
          return failedResponse(500, failed);
        }
        return fetchFixture(...args);
      });
      const prepare = () =>
        operation === "install"
          ? backend.prepareInstall(source())
          : operation === "update"
            ? backend.prepareUpdate("reviewer")
            : backend.request("skills.prepareVersionChange", {
                library_id: "reviewer",
                selector: { type: "tag", value: "next" },
              });
      let settled = false;
      const pending = prepare().then(
        (preview) => {
          settled = true;
          return { preview, error: undefined };
        },
        (error: unknown) => {
          settled = true;
          return { preview: undefined, error };
        },
      );
      const staging = path.join(root, ".staging/skills");
      let directory = "";
      try {
        await vi.waitFor(() => expect(failed.reached).toBe(true), { timeout: 2_000 });
        await failed.promise;
        // Drain the failed mapper's microtasks without releasing the pending write.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(settled).toBe(false);
        const entries = await fs.readdir(staging);
        expect(entries).toHaveLength(1);
        directory = path.join(staging, entries[0]!);
        expect(await fs.lstat(path.join(directory, ".agentkib-preview.json"))).toBeTruthy();
        expect(await fs.readFile(lockPath, "utf8").catch(() => null)).toBe(originalLock);
      } finally {
        release.resolve();
        try {
          await pending;
          await vi.waitFor(() => expect(written.reached).toBe(true), { timeout: 2_000 });
        } finally {
          mkdirSpy.mockRestore();
          writeSpy.mockRestore();
        }
      }
      const outcome = await pending;
      expect(outcome.preview).toBeUndefined();
      expect(outcome.error).toBeInstanceOf(Error);
      expect(String(outcome.error)).toContain("GitHub download failed (500)");
      expect(await fs.readdir(staging)).toEqual([]);
      expect(await fs.lstat(directory).catch(() => null)).toBeNull();
      expect(await fs.readFile(lockPath, "utf8").catch(() => null)).toBe(originalLock);
      expect(await fs.readFile(currentPath, "utf8").catch(() => null)).toBe(originalContent);
      vi.mocked(fetch).mockImplementation(fetchFixture);
      const preview = (await prepare()) as Preview;
      await backend.request("skills.applyOperation", { token: preview.token, confirmed: true });
      expect(await fs.readFile(path.join(root, "skills/reviewer/docs/late.txt"), "utf8")).toBe(
        "late",
      );
      expect(await fs.readFile(currentPath, "utf8")).toBe(
        remote.versions.get(operation === "install" ? A : operation === "update" ? B : C),
      );
      expect((await backend.installed())[0]!.source?.resolved_commit).toBe(
        operation === "install" ? A : operation === "update" ? B : C,
      );
      expect(await fs.readdir(staging)).toEqual([]);
    },
  );

  it("stops queued downloads after the first error, drains later failures and preserves the first error", async () => {
    const resources = Array.from({ length: 17 }, (_, index) => `resources/hold-${index}.txt`);
    github(["skills/reviewer"], resources);
    const { backend, root } = await fixture();
    const allStarted = checkpoint();
    const release = checkpoint();
    const failed = checkpoint();
    const fetchFixture = vi.mocked(fetch).getMockImplementation()!;
    const downloads: string[] = [];
    vi.mocked(fetch).mockImplementation(async (...args) => {
      const url = new URL(String(args[0]));
      if (url.hostname !== "raw.githubusercontent.com") return fetchFixture(...args);
      downloads.push(url.pathname);
      if (url.pathname.endsWith("/SKILL.md")) {
        await allStarted.promise;
        return failedResponse(500, failed);
      }
      if (downloads.length === 8) allStarted.resolve();
      await release.promise;
      if (url.pathname.endsWith("/hold-0.txt"))
        return new Response("Later failure", { status: 502 });
      return fetchFixture(...args);
    });
    let settled = false;
    const pending = backend.prepareInstall(source()).then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await vi.waitFor(() => expect(failed.reached).toBe(true), { timeout: 2_000 });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(downloads).toHaveLength(8);
    } finally {
      release.resolve();
      await pending;
    }
    expect(String(await pending)).toContain("GitHub download failed (500)");
    expect(downloads).toHaveLength(8);
    expect(await fs.readdir(path.join(root, ".staging/skills"))).toEqual([]);
    expect(await fs.lstat(path.join(root, "skills.lock.json")).catch(() => null)).toBeNull();
    expect(await backend.installed()).toEqual([]);
    vi.mocked(fetch).mockImplementation(fetchFixture);
    const retry = (await backend.prepareInstall(source())) as Preview;
    await backend.request("skills.applyOperation", { token: retry.token, confirmed: true });
    expect(
      await fs.readFile(path.join(root, "skills/reviewer/resources/hold-16.txt"), "utf8"),
    ).toBe("late");
    expect(await fs.readdir(path.join(root, ".staging/skills"))).toEqual([]);
  });

  it("keeps discovering valid metadata after individual downloads or metadata parsing fail", async () => {
    const packagePaths = Array.from({ length: 10 }, (_, index) => `skills/skill-${index}`);
    github(packagePaths).refs.set("main", A);
    const { backend, root } = await fixture();
    const fetchFixture = vi.mocked(fetch).getMockImplementation()!;
    const downloads: string[] = [];
    vi.mocked(fetch).mockImplementation(async (...args) => {
      const url = new URL(String(args[0]));
      if (url.hostname !== "raw.githubusercontent.com") return fetchFixture(...args);
      downloads.push(url.pathname);
      if (url.pathname.endsWith("/skill-0/SKILL.md"))
        return new Response("Failure", { status: 500 });
      if (url.pathname.endsWith("/skill-1/SKILL.md")) return new Response("Invalid frontmatter");
      return new Response(body(path.posix.basename(path.posix.dirname(url.pathname))));
    });
    const candidates = await backend.discover("https://github.com/example/skills");
    expect(candidates.map((candidate) => candidate.name)).toEqual(
      Array.from({ length: 8 }, (_, index) => `skill-${index + 2}`),
    );
    expect(candidates.map((candidate) => candidate.source.path)).toEqual(packagePaths.slice(2));
    expect(downloads).toHaveLength(10);
    expect(await fs.lstat(path.join(root, ".staging/skills")).catch(() => null)).toBeNull();
    expect(await fs.lstat(path.join(root, "skills.lock.json")).catch(() => null)).toBeNull();
  });
});

describe("Skill remote version selection", () => {
  it("lists tags/branches, switches refs explicitly, and restores both content and tracking on rollback", async () => {
    const githubFixture = github();
    const { backend, root } = await fixture();
    const initial = await install(backend);
    const listing = await backend.request("skills.listVersions", {
      library_id: initial.library_id,
      type: "tag",
      page: 1,
    });
    expect(listing).toEqual({
      entries: [{ name: "v1", commit: A }],
      type: "tag",
      page: 1,
      has_more: false,
    });
    const change = (await backend.request("skills.prepareVersionChange", {
      library_id: initial.library_id,
      selector: { type: "tag", value: "next" },
    })) as Preview;
    expect(change.skill.source).toMatchObject({ ref: "next", ref_type: "tag", resolved_commit: C });
    expect(change.previous_source?.ref).toBe("main");
    await backend.request("skills.applyOperation", { token: change.token, confirmed: true });
    expect(await fs.readFile(path.join(root, "skills/reviewer/SKILL.md"), "utf8")).toContain(
      "Tag version",
    );
    await backend.request("skills.rollback", { name: initial.library_id, confirmed: true });
    expect((await backend.installed())[0]!.source).toMatchObject({
      ref: "main",
      ref_type: "branch",
      resolved_commit: A,
    });
    expect(await fs.readFile(path.join(root, "skills/reviewer/SKILL.md"), "utf8")).toBe(body());
    githubFixture.refs.set("heads/main", B);
    const update = (await backend.prepareUpdate(initial.library_id)) as Preview;
    expect(update.skill.source).toMatchObject({
      ref: "main",
      ref_type: "branch",
      resolved_commit: B,
    });
    await backend.request("skills.applyOperation", { token: update.token, confirmed: true });
    expect((await backend.installed())[0]!.source?.ref).toBe("main");
  });

  it("expands short commits and prevents stale same-content previews from overwriting source records", async () => {
    github();
    const { backend } = await fixture();
    await install(backend);
    const stale = (await backend.request("skills.prepareVersionChange", {
      library_id: "reviewer",
      selector: { type: "branch", value: "same" },
    })) as Preview;
    const pinned = (await backend.request("skills.prepareVersionChange", {
      library_id: "reviewer",
      selector: { type: "commit", value: A.slice(0, 7) },
    })) as Preview;
    expect(pinned.skill.source).toMatchObject({ ref: A, ref_type: "commit", resolved_commit: A });
    await backend.request("skills.applyOperation", { token: pinned.token, confirmed: true });
    await expect(
      backend.request("skills.applyOperation", { token: stale.token, confirmed: true }),
    ).rejects.toThrow(/source record changed/);
    expect((await backend.installed())[0]!.source?.ref_type).toBe("commit");
  });

  it("keeps before/after previews frozen and rejects target or lock changes", async () => {
    github();
    const { backend, root } = await fixture();
    await install(backend);
    const change = (await backend.request("skills.prepareVersionChange", {
      library_id: "reviewer",
      selector: { type: "branch", value: "next" },
    })) as Preview;
    await fs.writeFile(
      path.join(root, "skills/reviewer/SKILL.md"),
      body("reviewer", "External edit"),
    );
    const file = (await backend.request("skills.readPreviewFile", {
      token: change.token,
      path: "SKILL.md",
    })) as { before: string; after: string };
    expect(file.before).toBe(body());
    expect(file.after).toContain("Second version");
    await expect(
      backend.request("skills.applyOperation", { token: change.token, confirmed: true }),
    ).rejects.toThrow(/changed after preview/);
  });

  it("preserves independent source identities and requires explicit ref switches", async () => {
    github();
    const { backend } = await fixture();
    await install(backend);
    await expect(backend.prepareInstall(source("example/skills", "next"))).rejects.toThrow(
      /Change version/,
    );
    const second = await install(backend, source("another/skills"));
    expect(second.library_id).not.toBe("reviewer");
    const changed = (await backend.request("skills.prepareVersionChange", {
      library_id: second.library_id,
      selector: { type: "branch", value: "next" },
    })) as Preview;
    expect(changed.library_id).toBe(second.library_id);
    await backend.request("skills.applyOperation", { token: changed.token, confirmed: true });
    expect(
      (await backend.installed()).find((item) => item.name === second.library_id)?.source
        ?.repository,
    ).toBe("another/skills");
  });

  it("preserves legacy lock records while preparing and uses batches independently of single-preview eviction", async () => {
    github();
    const { backend, home, root } = await fixture();
    await install(backend);
    const lockPath = path.join(root, "skills.lock.json");
    const lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
    delete lock.skills.reviewer.source.ref_type;
    lock.skills.reviewer.local_source = "/fixture/legacy-origin";
    await fs.writeFile(lockPath, JSON.stringify(lock));
    const original = await fs.readFile(lockPath, "utf8");
    await local(home, ".claude/skills/local", "local");
    const batch = await prepareBatch(backend);
    const previews: Preview[] = [];
    for (let index = 0; index < 5; index++)
      previews.push(
        (await backend.request("skills.prepareVersionChange", {
          library_id: "reviewer",
          selector: { type: "tag", value: "v1" },
        })) as Preview,
      );
    expect(await fs.readFile(lockPath, "utf8")).toBe(original);
    await expect(
      backend.request("skills.readPreviewFile", { token: previews[0]!.token, path: "SKILL.md" }),
    ).rejects.toThrow(/expired/);
    expect((await applyBatch(backend, batch)).items[0]!.status).toBe("imported");
    await backend.request("skills.applyOperation", {
      token: previews.at(-1)!.token,
      confirmed: true,
    });
    expect(JSON.parse(await fs.readFile(lockPath, "utf8")).skills.reviewer.local_source).toBe(
      "/fixture/legacy-origin",
    );
  });

  it("compensates a lock write failure and retains previous contents and metadata", async () => {
    github();
    const { backend, root } = await fixture();
    await install(backend);
    const previous = await fs.readFile(path.join(root, "skills.lock.json"), "utf8");
    const change = (await backend.request("skills.prepareVersionChange", {
      library_id: "reviewer",
      selector: { type: "branch", value: "next" },
    })) as Preview;
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to) === path.join(root, "skills.lock.json")) throw new Error("Disk write failed");
      return rename(from, to);
    });
    await expect(
      backend.request("skills.applyOperation", { token: change.token, confirmed: true }),
    ).rejects.toThrow("Disk write failed");
    expect(await fs.readFile(path.join(root, "skills.lock.json"), "utf8")).toBe(previous);
    expect(await fs.readFile(path.join(root, "skills/reviewer/SKILL.md"), "utf8")).toBe(body());
  });
});

describe("Skill rollback recovery", () => {
  async function previousVersion() {
    const remote = github();
    const context = await fixture();
    await install(context.backend);
    const change = (await context.backend.request("skills.prepareVersionChange", {
      library_id: "reviewer",
      selector: { type: "branch", value: "next" },
    })) as Preview;
    await context.backend.request("skills.applyOperation", {
      token: change.token,
      confirmed: true,
    });
    return {
      ...context,
      remote,
      target: path.join(context.root, "skills/reviewer"),
      backup: path.join(context.root, "backups/skills/reviewer"),
      lockPath: path.join(context.root, "skills.lock.json"),
    };
  }

  async function recoveredVersion(
    damage: "oversized-file" | "oversized-package" | "broken-resource" | "outside-resource",
  ) {
    const context = await previousVersion();
    const resource = path.join(context.target, "damaged-resource");
    const external = path.join(context.home, "external-resource");
    const damagedFiles: Array<{ name: string; contents: Buffer }> = [];
    let link: string | undefined;
    if (damage === "oversized-file") {
      damagedFiles.push({
        name: "damaged-resource",
        contents: Buffer.alloc(8 * 1024 * 1024 + 1, 29),
      });
    } else if (damage === "oversized-package") {
      const contents = Buffer.alloc(7 * 1024 * 1024, 31);
      for (let index = 0; index < 5; index++)
        damagedFiles.push({ name: `damaged-resource-${index}`, contents });
    } else {
      if (damage === "outside-resource") {
        await fs.mkdir(external);
        await fs.writeFile(path.join(external, "metadata.json"), '{"owner":"external"}');
      }
      await fs.symlink(external, resource, process.platform === "win32" ? "junction" : "dir");
      link = await fs.readlink(resource);
    }
    for (const file of damagedFiles)
      await fs.writeFile(path.join(context.target, file.name), file.contents);
    await context.backend.request("skills.rollback", { name: "reviewer", confirmed: true });
    const lockBytes = await fs.readFile(context.lockPath, "utf8");
    return { ...context, link, external, lockBytes };
  }

  async function nextPreview(
    context: Awaited<ReturnType<typeof recoveredVersion>>,
    operation: "update" | "version-change",
  ) {
    if (operation === "update") {
      context.remote.refs.set("heads/main", B);
      return (await context.backend.prepareUpdate("reviewer")) as Preview;
    }
    return (await context.backend.request("skills.prepareVersionChange", {
      library_id: "reviewer",
      selector: { type: "tag", value: "next" },
    })) as Preview;
  }

  it.each(
    (
      ["oversized-file", "oversized-package", "broken-resource", "outside-resource"] as const
    ).flatMap((damage) =>
      (["update", "version-change"] as const).map((operation) => ({ damage, operation })),
    ),
  )("continues $operation after recovering $damage", async ({ damage, operation }) => {
    const context = await recoveredVersion(damage);
    const { backend, root, target, backup, lockPath, external } = context;
    const preview = await nextPreview(context, operation);
    const result = (await backend.request("skills.applyOperation", {
      token: preview.token,
      confirmed: true,
    })) as { source: Source };
    const expectedSource =
      operation === "update"
        ? { ref: "main", ref_type: "branch", resolved_commit: B }
        : { ref: "next", ref_type: "tag", resolved_commit: C };
    expect(result.source).toMatchObject(expectedSource);
    expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toBe(
      body("reviewer", operation === "update" ? "Second version" : "Tag version"),
    );
    expect(await fs.readdir(target)).toEqual(["SKILL.md"]);
    expect(await fs.readFile(path.join(backup, "SKILL.md"), "utf8")).toBe(body());
    expect(await fs.readdir(backup)).toEqual(["SKILL.md"]);
    const lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
    expect(lock.skills.reviewer.source).toMatchObject(expectedSource);
    expect(lock.previous.reviewer).toEqual(JSON.parse(context.lockBytes).skills.reviewer);
    expect(await fs.readdir(path.dirname(backup))).toEqual(["reviewer"]);
    expect(await fs.readdir(path.join(root, ".staging/skills"))).toEqual([]);
    if (damage === "outside-resource")
      expect(await fs.readFile(path.join(external, "metadata.json"), "utf8")).toBe(
        '{"owner":"external"}',
      );
    else if (damage === "broken-resource")
      await expect(fs.lstat(external)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["backup-file", "backup-link", "backup-parent"])(
    "rejects an unsafe obsolete %s after preview without modifying current contents or records",
    async (location) => {
      const context = await recoveredVersion("broken-resource");
      const { backend, home, root, target, backup, lockPath, lockBytes, link } = context;
      const preview = await nextPreview(context, "version-change");
      const unsafe = location === "backup-parent" ? path.dirname(backup) : backup;
      const displaced = path.join(home, "displaced-obsolete-backup");
      await fs.rename(unsafe, displaced);
      if (location === "backup-file") await fs.writeFile(unsafe, "External file");
      else await fs.symlink(displaced, unsafe, process.platform === "win32" ? "junction" : "dir");
      const unsafeLink = location === "backup-file" ? undefined : await fs.readlink(unsafe);
      await expect(
        backend.request("skills.applyOperation", { token: preview.token, confirmed: true }),
      ).rejects.toThrow(/directory|link/);
      expect(await fs.readFile(lockPath, "utf8")).toBe(lockBytes);
      expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toBe(body());
      expect(await fs.readdir(target)).toEqual(["SKILL.md"]);
      const preserved = location === "backup-parent" ? path.join(displaced, "reviewer") : displaced;
      expect(await fs.readFile(path.join(preserved, "SKILL.md"), "utf8")).toBe(
        body("reviewer", "Second version"),
      );
      expect(await fs.readlink(path.join(preserved, "damaged-resource"))).toBe(link);
      if (location === "backup-file")
        expect(await fs.readFile(unsafe, "utf8")).toBe("External file");
      else expect(await fs.readlink(unsafe)).toBe(unsafeLink);
      expect(await fs.readdir(path.join(root, ".staging/skills"))).toEqual([]);
    },
  );

  it.each(["metadata-commit", "install-candidate", "move-current"])(
    "compensates %s with a damaged obsolete backup and permits a newly prepared retry",
    async (phase) => {
      const context = await recoveredVersion("outside-resource");
      const { backend, root, target, backup, lockPath, lockBytes, link, external } = context;
      const preview = await nextPreview(context, "version-change");
      const rename = fs.rename.bind(fs);
      let rejected = false;
      const failure = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        const source = String(from);
        const destination = String(to);
        const matches =
          phase === "metadata-commit"
            ? destination === lockPath
            : phase === "install-candidate"
              ? destination === target && source.endsWith(`${path.sep}package`)
              : source === target && destination === backup;
        if (matches && !rejected) {
          rejected = true;
          throw new Error(`Fixture ${phase} failed`);
        }
        return rename(from, to);
      });
      await expect(
        backend.request("skills.applyOperation", { token: preview.token, confirmed: true }),
      ).rejects.toThrow(`Fixture ${phase} failed`);
      expect(rejected).toBe(true);
      expect(await fs.readFile(lockPath, "utf8")).toBe(lockBytes);
      expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toBe(body());
      expect(await fs.readdir(target)).toEqual(["SKILL.md"]);
      expect(await fs.readFile(path.join(backup, "SKILL.md"), "utf8")).toBe(
        body("reviewer", "Second version"),
      );
      expect(await fs.readlink(path.join(backup, "damaged-resource"))).toBe(link);
      expect(await fs.readFile(path.join(external, "metadata.json"), "utf8")).toBe(
        '{"owner":"external"}',
      );
      expect(await fs.readdir(path.dirname(backup))).toEqual(["reviewer"]);
      expect(await fs.readdir(path.join(root, ".staging/skills"))).toEqual([]);
      failure.mockRestore();
      const retry = await nextPreview(context, "version-change");
      await backend.request("skills.applyOperation", { token: retry.token, confirmed: true });
      expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toBe(
        body("reviewer", "Tag version"),
      );
      expect(await fs.readFile(path.join(backup, "SKILL.md"), "utf8")).toBe(body());
      expect(await fs.readdir(backup)).toEqual(["SKILL.md"]);
    },
  );

  it("reports cleanup failure as a warning after replacing a damaged obsolete backup", async () => {
    const context = await recoveredVersion("outside-resource");
    const { backend, root, target, backup, lockPath, external, link } = context;
    const preview = await nextPreview(context, "version-change");
    const remove = fs.rm.bind(fs);
    const cleanup = vi.spyOn(fs, "rm").mockImplementation(async (entry, options) => {
      if (String(entry).startsWith(`${backup}.staging-`))
        throw new Error("Fixture obsolete backup cleanup failed");
      return remove(entry, options);
    });
    const result = (await backend.request("skills.applyOperation", {
      token: preview.token,
      confirmed: true,
    })) as { source: Source; warnings: string[] };
    expect(result.source).toMatchObject({ ref: "next", ref_type: "tag", resolved_commit: C });
    expect(result.warnings.join(" ")).toContain("older backup could not be removed");
    expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toBe(
      body("reviewer", "Tag version"),
    );
    expect(await fs.readFile(path.join(backup, "SKILL.md"), "utf8")).toBe(body());
    expect(JSON.parse(await fs.readFile(lockPath, "utf8")).skills.reviewer.source).toMatchObject({
      ref_type: "tag",
      resolved_commit: C,
    });
    const retained = (await fs.readdir(path.dirname(backup))).filter((name) =>
      name.startsWith("reviewer.staging-"),
    );
    expect(retained).toHaveLength(1);
    expect(
      await fs.readlink(path.join(path.dirname(backup), retained[0]!, "damaged-resource")),
    ).toBe(link);
    expect(await fs.readFile(path.join(external, "metadata.json"), "utf8")).toBe(
      '{"owner":"external"}',
    );
    expect(await fs.readdir(path.join(root, ".staging/skills"))).toEqual([]);
    cleanup.mockRestore();
  });

  it.each([
    "oversized-file",
    "oversized-package",
    "broken-resource",
    "outside-resource",
    "missing-skill",
  ])("restores a healthy previous version when the current package has %s", async (damage) => {
    const { backend, home, target, backup, lockPath } = await previousVersion();
    const originalLock = JSON.parse(await fs.readFile(lockPath, "utf8"));
    const resource = path.join(target, "damaged-resource");
    const external = path.join(home, "external-resource");
    let bytes: Buffer | undefined;
    let link: string | undefined;
    let fileCount = 0;
    if (damage === "oversized-file") {
      bytes = Buffer.alloc(8 * 1024 * 1024 + 1, 17);
      await fs.writeFile(resource, bytes);
      fileCount = 1;
    } else if (damage === "oversized-package") {
      bytes = Buffer.alloc(7 * 1024 * 1024, 19);
      fileCount = 5;
      for (let index = 0; index < fileCount; index++)
        await fs.writeFile(`${resource}-${index}`, bytes);
    } else if (damage === "missing-skill") {
      await fs.rm(path.join(target, "SKILL.md"));
    } else {
      if (damage === "outside-resource") {
        await fs.mkdir(external);
        await fs.writeFile(path.join(external, "keep.txt"), "External data");
      }
      await fs.symlink(external, resource, process.platform === "win32" ? "junction" : "dir");
      link = await fs.readlink(resource);
    }
    const damagedEntries = await fs.readdir(target);
    const result = (await backend.request("skills.rollback", {
      name: "reviewer",
      confirmed: true,
    })) as { name: string; source: Source };
    expect(result.source).toMatchObject({ ref: "main", ref_type: "branch", resolved_commit: A });
    expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toBe(body());
    expect(await fs.readdir(target)).toEqual(["SKILL.md"]);
    expect(await fs.readdir(backup)).toEqual(damagedEntries);
    if (damage !== "missing-skill")
      expect(await fs.readFile(path.join(backup, "SKILL.md"), "utf8")).toBe(
        body("reviewer", "Second version"),
      );
    if (bytes) {
      for (let index = 0; index < fileCount; index++) {
        const retained = path.join(
          backup,
          damage === "oversized-file" ? "damaged-resource" : `damaged-resource-${index}`,
        );
        expect((await fs.readFile(retained)).equals(bytes)).toBe(true);
      }
    } else if (link) {
      expect((await fs.lstat(path.join(backup, "damaged-resource"))).isSymbolicLink()).toBe(true);
      expect(await fs.readlink(path.join(backup, "damaged-resource"))).toBe(link);
      if (damage === "outside-resource")
        expect(await fs.readFile(path.join(external, "keep.txt"), "utf8")).toBe("External data");
      else await expect(fs.lstat(external)).rejects.toMatchObject({ code: "ENOENT" });
    }
    const recoveredLock = await fs.readFile(lockPath, "utf8");
    expect(JSON.parse(recoveredLock).skills.reviewer).toEqual(originalLock.previous.reviewer);
    expect(JSON.parse(recoveredLock).previous.reviewer).toEqual(originalLock.skills.reviewer);
    await expect(
      backend.request("skills.rollback", { name: "reviewer", confirmed: true }),
    ).rejects.toThrow();
    expect(await fs.readFile(lockPath, "utf8")).toBe(recoveredLock);
    expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toBe(body());
    expect(await fs.readdir(backup)).toEqual(damagedEntries);
  });

  it("compensates a failed metadata commit when recovering a damaged current package", async () => {
    const { backend, target, backup, lockPath } = await previousVersion();
    const originalLock = await fs.readFile(lockPath, "utf8");
    const bytes = Buffer.alloc(8 * 1024 * 1024 + 1, 23);
    await fs.writeFile(path.join(target, "damaged-resource"), bytes);
    const rename = fs.rename.bind(fs);
    let rejected = false;
    const writeFailure = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to) === lockPath && !rejected) {
        rejected = true;
        throw new Error("Fixture rollback metadata write failed");
      }
      return rename(from, to);
    });
    await expect(
      backend.request("skills.rollback", { name: "reviewer", confirmed: true }),
    ).rejects.toThrow("Fixture rollback metadata write failed");
    expect(await fs.readFile(lockPath, "utf8")).toBe(originalLock);
    expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toBe(
      body("reviewer", "Second version"),
    );
    expect((await fs.readFile(path.join(target, "damaged-resource"))).equals(bytes)).toBe(true);
    expect(await fs.readFile(path.join(backup, "SKILL.md"), "utf8")).toBe(body());
    expect(await fs.readdir(backup)).toEqual(["SKILL.md"]);
    expect(await fs.readdir(path.dirname(target))).toEqual(["reviewer"]);
    writeFailure.mockRestore();
    await backend.request("skills.rollback", { name: "reviewer", confirmed: true });
    expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toBe(body());
    expect((await fs.readFile(path.join(backup, "damaged-resource"))).equals(bytes)).toBe(true);
    expect(JSON.parse(await fs.readFile(lockPath, "utf8")).skills.reviewer.source).toMatchObject({
      ref: "main",
      ref_type: "branch",
      resolved_commit: A,
    });
  });

  it.each(["current-file", "current-link", "library-parent", "backup-parent"])(
    "rejects unsafe rollback directories at %s without changing files or metadata",
    async (location) => {
      const { backend, home, target, backup, lockPath } = await previousVersion();
      const originalLock = await fs.readFile(lockPath, "utf8");
      const unsafe =
        location === "library-parent"
          ? path.dirname(target)
          : location === "backup-parent"
            ? path.dirname(backup)
            : target;
      const displaced = path.join(home, "displaced-directory");
      await fs.rename(unsafe, displaced);
      if (location === "current-file") await fs.writeFile(unsafe, "External file");
      else await fs.symlink(displaced, unsafe, process.platform === "win32" ? "junction" : "dir");
      const displacedSkill = path.join(
        displaced,
        location.endsWith("parent") ? "reviewer/SKILL.md" : "SKILL.md",
      );
      const originalBody = await fs.readFile(displacedSkill, "utf8");
      await expect(
        backend.request("skills.rollback", { name: "reviewer", confirmed: true }),
      ).rejects.toThrow(/directory|link/);
      expect(await fs.readFile(lockPath, "utf8")).toBe(originalLock);
      expect(await fs.readFile(displacedSkill, "utf8")).toBe(originalBody);
      if (location === "current-file")
        expect(await fs.readFile(unsafe, "utf8")).toBe("External file");
      else expect((await fs.lstat(unsafe)).isSymbolicLink()).toBe(true);
      const untouched = location.startsWith("backup") ? target : backup;
      expect(await fs.readFile(path.join(untouched, "SKILL.md"), "utf8")).toBe(
        location.startsWith("backup") ? body("reviewer", "Second version") : body(),
      );
    },
  );

  it.each(["oversized-resource", "linked-resource"])(
    "rejects an invalid previous package with %s and preserves the healthy current package",
    async (damage) => {
      const { backend, home, target, backup, lockPath } = await previousVersion();
      const originalLock = await fs.readFile(lockPath, "utf8");
      const resource = path.join(backup, "damaged-resource");
      const external = path.join(home, "backup-external-resource");
      if (damage === "oversized-resource")
        await fs.writeFile(resource, Buffer.alloc(8 * 1024 * 1024 + 1));
      else {
        await fs.mkdir(external);
        await fs.writeFile(path.join(external, "keep.txt"), "External data");
        await fs.symlink(external, resource, process.platform === "win32" ? "junction" : "dir");
      }
      await expect(
        backend.request("skills.rollback", { name: "reviewer", confirmed: true }),
      ).rejects.toThrow(/large|unsupported/);
      expect(await fs.readFile(lockPath, "utf8")).toBe(originalLock);
      expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toBe(
        body("reviewer", "Second version"),
      );
      expect(await fs.readFile(path.join(backup, "SKILL.md"), "utf8")).toBe(body());
      if (damage === "linked-resource") {
        expect((await fs.lstat(resource)).isSymbolicLink()).toBe(true);
        expect(await fs.readFile(path.join(external, "keep.txt"), "utf8")).toBe("External data");
      } else expect((await fs.stat(resource)).size).toBe(8 * 1024 * 1024 + 1);
    },
  );
});

describe("Skill lifecycle boundary cases", () => {
  it("imports six packages in one batch without single-preview eviction", async () => {
    const { backend, home, root } = await fixture();
    for (let i = 0; i < 6; i++) await local(home, `.cursor/skills/package-${i}`, `package-${i}`);
    const batch = await prepareBatch(backend);
    expect(batch.items).toHaveLength(6);
    expect(batch.items.every((item) => item.status === "ready")).toBe(true);
    const report = await applyBatch(backend, batch);
    expect(report.items.map((item) => item.status)).toEqual(Array(6).fill("imported"));
    expect(await fs.readdir(path.join(root, "skills"))).toHaveLength(6);
    expect(await fs.readdir(path.join(root, ".staging/skills"))).toEqual([]);
  });

  it.each(["broken", "outside"])(
    "rejects %s resource links without touching their targets",
    async (kind) => {
      const { backend, home } = await fixture();
      const origin = await local(home, ".cursor/skills/reviewer");
      const external = path.join(home, "external");
      if (kind === "outside") {
        await fs.mkdir(external);
        await fs.writeFile(path.join(external, "keep.txt"), "Unchanged");
      }
      await fs.symlink(
        external,
        path.join(origin, "resource"),
        process.platform === "win32" ? "junction" : "dir",
      );
      const item = (await observations(backend)).find((entry) => entry.path === origin)!;
      const batch = await prepareBatch(backend, [item.id]);
      expect(batch.items[0]!.status).toBe("failed");
      expect(batch.items[0]!.reason).toContain("linked");
      if (kind === "outside")
        expect(await fs.readFile(path.join(external, "keep.txt"), "utf8")).toBe("Unchanged");
    },
  );

  it("rejects cross-volume staging before application", async () => {
    const { backend, home } = await fixture();
    await local(home, ".cursor/skills/reviewer");
    const ids = (await observations(backend)).map((item) => item.id);
    const stat = fs.stat.bind(fs);
    vi.spyOn(fs, "stat").mockImplementation((async (
      value: Parameters<typeof fs.stat>[0],
      ...args: unknown[]
    ) => {
      const info = await stat(value, ...(args as []));
      return String(value).endsWith(path.join(".staging", "skills"))
        ? { ...info, dev: Number(info.dev) + 1 }
        : info;
    }) as typeof fs.stat);
    const batch = await prepareBatch(backend, ids);
    expect(batch.items[0]!.status).toBe("failed");
    expect(batch.items[0]!.reason).toContain("same volume");
  });

  it("applies the frozen commit after a tracking branch moves", async () => {
    const remote = github();
    const { backend, root } = await fixture();
    await install(backend);
    const preview = (await backend.request("skills.prepareVersionChange", {
      library_id: "reviewer",
      selector: { type: "branch", value: "next" },
    })) as Preview;
    remote.refs.set("heads/next", C);
    await backend.request("skills.applyOperation", { token: preview.token, confirmed: true });
    expect(await fs.readFile(path.join(root, "skills/reviewer/SKILL.md"), "utf8")).toContain(
      "Second version",
    );
    expect((await backend.installed())[0]!.source).toMatchObject({
      ref: "next",
      resolved_commit: B,
    });
    expect((await backend.checkUpdates())[0]!.status).toBe("update-available");
  });

  it("reports missing Skill paths and rejects remote selection for local copies", async () => {
    const remote = github();
    const { backend, home } = await fixture();
    await install(backend);
    remote.missingPackages.add(C);
    await expect(
      backend.request("skills.prepareVersionChange", {
        library_id: "reviewer",
        selector: { type: "tag", value: "next" },
      }),
    ).rejects.toThrow(/directory does not exist/);
    await local(home, ".cursor/skills/local", "local");
    const batch = await prepareBatch(backend);
    const report = await applyBatch(backend, batch);
    await expect(
      backend.request("skills.prepareVersionChange", {
        library_id: report.items[0]!.library_id,
        selector: { type: "branch", value: "main" },
      }),
    ).rejects.toThrow(/no GitHub source/);
  });

  it("paginates versions and surfaces API errors without changing the installed version", async () => {
    const remote = github();
    const { backend } = await fixture();
    await install(backend);
    remote.pages.set(
      "tags:1",
      Array.from({ length: 50 }, (_, index) => ({ name: `v${index}`, commit: { sha: A } })),
    );
    remote.pages.set("tags:2", []);
    const first = (await backend.request("skills.listVersions", {
      library_id: "reviewer",
      type: "tag",
    })) as { has_more: boolean; entries: unknown[] };
    expect(first.entries).toHaveLength(50);
    expect(first.has_more).toBe(true);
    expect(
      await backend.request("skills.listVersions", { source: source(), type: "tag", page: 2 }),
    ).toMatchObject({ page: 2, has_more: false, entries: [] });
    vi.mocked(fetch).mockResolvedValueOnce(new Response("Rate limit", { status: 429 }));
    await expect(
      backend.request("skills.listVersions", { library_id: "reviewer", type: "branch" }),
    ).rejects.toThrow("429");
    expect((await backend.installed())[0]!.source?.resolved_commit).toBe(A);
    await expect(
      backend.request("skills.listVersions", {
        library_id: "reviewer",
        source: source(),
        type: "branch",
      }),
    ).rejects.toThrow(/exactly one/);
  });

  it("returns rollback success with warnings after a refresh failure and rejects linked rollback targets", async () => {
    github();
    const { backend, root, home } = await fixture();
    await install(backend);
    const change = (await backend.request("skills.prepareVersionChange", {
      library_id: "reviewer",
      selector: { type: "branch", value: "next" },
    })) as Preview;
    await backend.request("skills.applyOperation", { token: change.token, confirmed: true });
    const refresh = vi
      .spyOn(backend, "installed")
      .mockRejectedValue(new Error("Refresh unavailable"));
    const result = (await backend.request("skills.rollback", {
      name: "reviewer",
      confirmed: true,
    })) as { name: string; source: Source; warnings: string[] };
    expect(result.name).toBe("reviewer");
    expect(result.source.ref).toBe("main");
    expect(result.warnings.join(" ")).toContain("refresh");
    expect(await fs.readFile(path.join(root, "skills/reviewer/SKILL.md"), "utf8")).toBe(body());
    refresh.mockRestore();
    const backup = path.join(root, "backups/skills/reviewer");
    await fs.rename(backup, path.join(home, "external-backup"));
    await fs.symlink(
      path.join(home, "external-backup"),
      backup,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      backend.request("skills.rollback", { name: "reviewer", confirmed: true }),
    ).rejects.toThrow(/regular directory/);
    expect(await fs.readFile(path.join(home, "external-backup/SKILL.md"), "utf8")).toContain(
      "Second version",
    );
  });
});
