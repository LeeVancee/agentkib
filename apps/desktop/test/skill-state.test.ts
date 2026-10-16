import { constants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquirePortableFileLease } from "../../../packages/backend/src/managed-session-lock";
import { skillPackage } from "../../../packages/backend/src/skill-package";
import {
  SkillStateStore,
  readSkillJson,
  withSkillLocks,
  writeSkillJson,
} from "../../../packages/backend/src/skill-state";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "skill-state-")));
  directories.push(directory);
  const source = path.join(directory, "source");
  await fs.mkdir(path.join(source, "resources/empty"), { recursive: true });
  await fs.writeFile(path.join(source, "SKILL.md"), "---\nname: fixture\n---\nInstructions\n");
  await fs.writeFile(path.join(source, "resources/data.bin"), Buffer.from([0, 1, 2, 255]));
  await fs.writeFile(path.join(source, "run.sh"), "#!/bin/sh\nexit 0\n");
  await fs.chmod(path.join(source, "run.sh"), 0o755);
  const store = new SkillStateStore(path.join(directory, "library"));
  return { directory, source, store };
}

describe("Skill persistent state", () => {
  it("deduplicates complete immutable package snapshots and preserves binary, mode and empty folders", async () => {
    const { source, store } = await fixture();
    const expected = (await skillPackage(source)).hash;
    const hashes = await Promise.all([store.snapshot(source, expected), store.snapshot(source)]);
    expect(hashes).toEqual([expected, expected]);
    const saved = await store.verifySnapshot(expected);
    expect((await skillPackage(saved)).hash).toBe(expected);
    expect(await fs.readFile(path.join(saved, "resources/data.bin"))).toEqual(
      Buffer.from([0, 1, 2, 255]),
    );
    expect((await fs.stat(path.join(saved, "resources/empty"))).isDirectory()).toBe(true);
    await fs.writeFile(path.join(source, "SKILL.md"), "Changed after snapshot\n");
    expect(await fs.readFile(path.join(saved, "SKILL.md"), "utf8")).toContain("Instructions");
    await expect(store.snapshot(source, expected)).rejects.toThrow("changed before snapshotting");
  });

  it("fails closed on damaged snapshots instead of replacing their bytes", async () => {
    const { source, store } = await fixture();
    const hash = await store.snapshot(source);
    const entry = path.join(store.snapshotPath(hash), "SKILL.md");
    await fs.writeFile(entry, "Damaged\n");
    await expect(store.verifySnapshot(hash)).rejects.toThrow("corrupt");
    await expect(store.snapshot(source)).rejects.toThrow("corrupt");
    expect(await fs.readFile(entry, "utf8")).toBe("Damaged\n");
    expect(() => store.snapshotPath("../outside")).toThrow("Invalid Skill snapshot hash");
  });

  it("flushes every snapshot file using a writable handle without changing its contents or mode", async () => {
    const { source, store } = await fixture();
    // The copier normalizes native read-only inputs to its existing 0644/0755 contract.
    await fs.chmod(path.join(source, "resources/data.bin"), 0o444);
    const original = await skillPackage(source);
    const open = fs.open.bind(fs);
    const flushed: string[] = [];
    vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      const handle = await open(file, flags, mode);
      if (
        String(file)
          .split(path.sep)
          .some((part) => part.startsWith(".snapshot-"))
      ) {
        const info = await handle.stat();
        if (info.isFile()) {
          const sync = handle.sync.bind(handle);
          vi.spyOn(handle, "sync").mockImplementation(async () => {
            // Model Windows' FlushFileBuffers requirement on every host.
            if (typeof flags !== "number" || !(flags & (constants.O_WRONLY | constants.O_RDWR)))
              throw Object.assign(new Error("EPERM: operation not permitted, fsync"), {
                code: "EPERM",
              });
            flushed.push(path.relative(path.dirname(String(file)), String(file)));
            return sync();
          });
        }
      }
      return handle;
    });
    const hash = await store.snapshot(source, original.hash);
    expect(flushed.sort()).toEqual(["SKILL.md", "data.bin", "run.sh"]);
    expect((await skillPackage(source)).hash).toBe(original.hash);
    const saved = await store.verifySnapshot(hash);
    expect((await skillPackage(saved)).hash).toBe(original.hash);
    expect(await fs.readFile(path.join(saved, "resources/data.bin"))).toEqual(
      Buffer.from([0, 1, 2, 255]),
    );
    if (process.platform !== "win32") {
      expect((await fs.stat(path.join(saved, "resources/data.bin"))).mode & 0o777).toBe(0o644);
      expect((await fs.stat(path.join(saved, "run.sh"))).mode & 0o777).toBe(0o755);
      expect((await fs.stat(path.join(source, "resources/data.bin"))).mode & 0o777).toBe(0o444);
    }
  });

  it.each(["EPERM", "EIO"])(
    "does not publish a snapshot when its file flush fails with %s",
    async (code) => {
      const { source, store } = await fixture();
      const original = await skillPackage(source);
      const open = fs.open.bind(fs);
      const failure = Object.assign(new Error(`Injected ${code} during snapshot flush`), { code });
      let attempted = false;
      vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
        const handle = await open(file, flags, mode);
        if (
          String(file)
            .split(path.sep)
            .some((part) => part.startsWith(".snapshot-"))
        ) {
          const info = await handle.stat();
          if (info.isFile())
            vi.spyOn(handle, "sync").mockImplementation(async () => {
              attempted = true;
              throw failure;
            });
        }
        return handle;
      });
      await expect(store.snapshot(source, original.hash)).rejects.toBe(failure);
      vi.restoreAllMocks();
      expect(attempted).toBe(true);
      expect((await skillPackage(source)).hash).toBe(original.hash);
      await expect(fs.lstat(store.snapshotPath(original.hash))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await fs.readdir(path.dirname(store.snapshotPath(original.hash)))).toEqual([]);
      expect(await store.snapshot(source, original.hash)).toBe(original.hash);
    },
  );

  it("retains journal stages across instances and refuses an existing operation identity", async () => {
    const { store } = await fixture();
    await store.startJournal("operation", {
      state: "prepared",
      hash_algorithm: "skill-package-v1",
    });
    await expect(store.startJournal("operation", { state: "replacement" })).rejects.toThrow(
      "already exists",
    );
    const reopened = new SkillStateStore(store.root);
    expect(await reopened.readJournal("operation")).toMatchObject({ state: "prepared" });
    await reopened.writeJournal("operation", { state: "committed" });
    expect(await store.listJournals()).toEqual([
      { id: "operation", journal: { state: "committed" } },
    ]);
    await store.removeJournal("operation");
    expect(await reopened.readJournal("operation")).toBeNull();
    expect(await reopened.listJournals()).toEqual([]);
  });

  it("does not turn malformed or oversized JSON into missing state", async () => {
    const { directory } = await fixture();
    const file = path.join(directory, "state.json");
    expect(await readSkillJson(file)).toBeNull();
    await writeSkillJson(file, { value: "saved" });
    expect(await readSkillJson(file)).toEqual({ value: "saved" });
    await expect(readSkillJson(file, 2)).rejects.toThrow("size limit");
    await fs.writeFile(file, "{broken");
    await expect(readSkillJson(file)).rejects.toThrow();
    await fs.writeFile(file, "null");
    await expect(readSkillJson(file)).rejects.toThrow("cannot contain null");
    expect((await fs.readdir(directory)).some((name) => name.startsWith(".skill-state-"))).toBe(
      false,
    );
  });

  it("uses one physical lock for aliases, allows nested reuse and releases after an error", async () => {
    const { directory } = await fixture();
    const lockFile = path.join(directory, ".agentkib-skill.lock");
    await expect(
      withSkillLocks([directory, directory], async () => {
        expect(() => acquirePortableFileLease(lockFile)).toThrow();
        await withSkillLocks([directory], async () => "nested");
        throw new Error("Operation failed");
      }),
    ).rejects.toThrow("Operation failed");
    const release = acquirePortableFileLease(lockFile);
    try {
      await expect(withSkillLocks([directory], async () => "unexpected")).rejects.toThrow();
    } finally {
      release();
    }
    expect(await withSkillLocks([directory], async () => "available")).toBe("available");
  });

  it("rejects extending a held lock set out of physical-path order", async () => {
    const { directory } = await fixture();
    const first = path.join(directory, "a");
    const second = path.join(directory, "z");
    await withSkillLocks([second], async () => {
      await expect(withSkillLocks([first, second], async () => undefined)).rejects.toThrow(
        "physical-path order",
      );
    });
    await withSkillLocks([second, first], async () => {
      await withSkillLocks([first], async () => undefined);
    });
  });

  it.skipIf(process.platform === "win32")(
    "rejects linked snapshots and linked state metadata",
    async () => {
      const { directory, source, store } = await fixture();
      const hash = await store.snapshot(source);
      const snapshot = store.snapshotPath(hash);
      await fs.rm(snapshot, { recursive: true });
      await fs.symlink(source, snapshot, "dir");
      await expect(store.verifySnapshot(hash)).rejects.toThrow("unsafe");
      const stateFile = path.join(directory, "state.json");
      const original = path.join(directory, "original.json");
      await fs.writeFile(original, "{}");
      await fs.symlink(original, stateFile);
      await expect(readSkillJson(stateFile)).rejects.toThrow();
      await expect(writeSkillJson(stateFile, { changed: true })).rejects.toThrow("unsafe");
      expect(await fs.readFile(original, "utf8")).toBe("{}");
    },
  );
});
