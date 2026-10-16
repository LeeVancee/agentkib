import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkillSyncPolicy, SkillSyncRun } from "@agentkib/runtime-protocol";
import { Skills } from "../../../packages/backend/src/skills";

const homes: string[] = [];
const A = "a".repeat(40),
  B = "b".repeat(40),
  C = "c".repeat(40);
const body = (value: string) => `---\nname: reviewer\ndescription: Review changes\n---\n${value}\n`;
type Source = Parameters<Skills["prepareInstall"]>[0];
type Preview = { token: string; library_id: string };

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
});

function github() {
  const refs = new Map([
    ["v1", A],
    ["tags/v1", A],
    ["main", A],
    ["heads/main", A],
    ["release", A],
    ["tags/release", A],
    ["heads/release", A],
  ]);
  const trees = new Map([
    [A, "package-a"],
    [B, "package-b"],
    [C, "package-c"],
  ]);
  const contents = new Map([
    [A, body("initial")],
    [B, body("next")],
    [C, body("other")],
  ]);
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      calls.push(url.href);
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if (url.hostname === "raw.githubusercontent.com") {
        const content = contents.get(parts[2]!);
        if (!content) return new Response("Missing contents", { status: 404 });
        return new Response(content);
      }
      if (url.hostname !== "api.github.com") throw new Error("Unexpected external request");
      if (!parts[3]) return Response.json({ default_branch: "main" });
      if (parts[3] === "commits") {
        const reference = parts.slice(4).join("/");
        const sha = refs.get(reference) ?? [A, B, C].find((commit) => commit.startsWith(reference));
        if (!sha) return new Response("Missing reference", { status: 404 });
        return Response.json({ sha, commit: { tree: { sha: `root-${sha}` } } });
      }
      if (parts[3] === "git" && parts[4] === "trees") {
        const sha = parts[5]!.replace(/^root-/, "");
        return Response.json({
          tree: [
            { path: "skills/reviewer", type: "tree", mode: "040000", sha: trees.get(sha) },
            {
              path: "skills/reviewer/SKILL.md",
              type: "blob",
              mode: "100644",
              sha: "blob",
              size: Buffer.byteLength(contents.get(sha)!),
            },
          ],
        });
      }
      throw new Error(`Unexpected GitHub fixture route ${url.pathname}`);
    }),
  );
  return { refs, trees, contents, calls };
}

async function fixture() {
  const remote = github();
  const home = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "skill-legacy-ref-check-")),
  );
  homes.push(home);
  const root = path.join(home, "library");
  const create = () =>
    new Skills({ HOME: home, USERPROFILE: home, AGENTKIB_HOME: root }, path.join(home, "data"));
  const skills = create();
  const lockPath = path.join(root, "skills.lock.json");
  const source = (ref: string, type?: Source["ref_type"]): Source => ({
    kind: "github",
    repository: "example/skills",
    path: "skills/reviewer",
    ref,
    ...(type ? { ref_type: type } : {}),
    resolved_commit: A,
    tree_sha: "package-a",
  });
  const install = async (value: Source) => {
    const preview = (await skills.request("skills.prepareInstall", { source: value })) as Preview;
    await skills.request("skills.applyOperation", { token: preview.token, confirmed: true });
    return preview.library_id;
  };
  const urlSource = async (ref: string) => {
    const rows = (await skills.request("skills.discover", {
      url: `https://github.com/example/skills/tree/${ref}/skills/reviewer`,
    })) as Array<{ source: Source }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).not.toHaveProperty("ref_type");
    return rows[0]!.source;
  };
  const check = async (id: string, status: "current" | "update-available", pinned = false) => {
    const before = await fs.readFile(lockPath, "utf8");
    const entry = path.join(root, "skills", id, "SKILL.md");
    const bytes = await fs.readFile(entry);
    const restarted = create();
    const policy = (await restarted.request("skills.syncPolicy", {})) as SkillSyncPolicy;
    expect(policy).toMatchObject({ enabled: true, default_mode: "check", libraries: {} });
    remote.calls.length = 0;
    const run = (await restarted.request("skills.runDueSync", {})) as SkillSyncRun;
    expect(run, JSON.stringify(run)).toMatchObject({
      trigger: "automatic",
      results: [{ library_id: id, success: true, status }],
    });
    expect(run.warnings).toEqual([]);
    if (pinned) expect(remote.calls).toEqual([]);
    else expect(remote.calls.length).toBeGreaterThan(0);
    const runs = (await restarted.request("skills.syncRuns", {})) as { runs: SkillSyncRun[] };
    expect(runs.runs.find((row) => row.operation_id === run.operation_id)).toEqual(run);
    const schedule = JSON.parse(await fs.readFile(path.join(root, "skill-sync-runs.json"), "utf8"));
    expect(schedule.libraries[id].failures).toBe(0);
    expect(await fs.readFile(lockPath, "utf8")).toBe(before);
    expect(await fs.readFile(entry)).toEqual(bytes);
    const callCount = remote.calls.length;
    expect(await restarted.request("skills.runDueSync", {})).toBeNull();
    expect(remote.calls).toHaveLength(callCount);
    if (!pinned) {
      const manual = (await restarted.request("skills.checkUpdates", {})) as Array<{
        name: string;
        status: string;
        update_check?: string;
      }>;
      expect(manual.find((row) => row.name === id)).toMatchObject({ status });
      expect(manual.find((row) => row.name === id)).not.toHaveProperty("update_check", "failed");
    }
    expect(await fs.readFile(lockPath, "utf8")).toBe(before);
    expect(await fs.readFile(entry)).toEqual(bytes);
  };
  return { remote, skills, root, lockPath, source, install, urlSource, check };
}

describe("default Skill checks preserve legacy reference resolution", () => {
  it.each(["v1", A])(
    "checks a URL reference %s with its original generic resolver",
    async (ref) => {
      const f = await fixture();
      const id = await f.install(await f.urlSource(ref));
      await f.check(id, "current");
      const record = JSON.parse(await fs.readFile(f.lockPath, "utf8")).skills[id];
      expect(record.source).toMatchObject({ ref, resolved_commit: A });
      expect(record.source).not.toHaveProperty("ref_type");
    },
  );

  it("checks a schema-1 branch record without migrating its source", async () => {
    const f = await fixture();
    const id = await f.install(f.source("main"));
    const lock = JSON.parse(await fs.readFile(f.lockPath, "utf8"));
    lock.schema_version = 1;
    delete lock.skills[id].snapshot_hash;
    delete lock.skills[id].hash_algorithm;
    delete lock.skills[id].library_instance_id;
    await fs.writeFile(f.lockPath, JSON.stringify(lock, null, 2));
    f.remote.refs.set("main", B);
    await f.check(id, "update-available");
    expect(JSON.parse(await fs.readFile(f.lockPath, "utf8"))).toEqual(lock);
  });

  it.each(["current", "update-available"] as const)(
    "uses the generic tag tree when a same-named branch would report %s",
    async (branchStatus) => {
      const f = await fixture();
      const id = await f.install(await f.urlSource("release"));
      f.remote.refs.set("release", B);
      f.remote.refs.set("tags/release", B);
      f.remote.refs.set("heads/release", C);
      const genericChanged = branchStatus === "current";
      f.remote.trees.set(B, genericChanged ? "package-b" : "package-a");
      f.remote.trees.set(C, genericChanged ? "package-a" : "package-c");
      await f.check(id, genericChanged ? "update-available" : "current");
    },
  );

  it("keeps explicit branch resolution on heads when a generic tag has another tree", async () => {
    const f = await fixture();
    const id = await f.install(f.source("release", "branch"));
    f.remote.refs.set("release", B);
    f.remote.refs.set("tags/release", B);
    f.remote.refs.set("heads/release", C);
    f.remote.trees.set(C, "package-a");
    await f.check(id, "current");
    expect(JSON.parse(await fs.readFile(f.lockPath, "utf8")).skills[id].source.ref_type).toBe(
      "branch",
    );
  });

  it.each(["tag", "commit"] as const)(
    "keeps explicit %s sources pinned without an automatic fetch",
    async (type) => {
      const f = await fixture();
      const id = await f.install(f.source(type === "tag" ? "v1" : A, type));
      f.remote.refs.set("tags/v1", B);
      f.remote.refs.set("v1", B);
      await f.check(id, "current", true);
      expect(JSON.parse(await fs.readFile(f.lockPath, "utf8")).skills[id].source).toMatchObject({
        ref_type: type,
        resolved_commit: A,
      });
    },
  );
});
