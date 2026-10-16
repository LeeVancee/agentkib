import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeLibraryTransaction,
  readLibraryTransaction,
  recoverLibraryTransactions,
} from "../../../packages/backend/src/skill-library-transaction";
import { writeSkillJson } from "../../../packages/backend/src/skill-state";

const folders: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    folders.splice(0).map((folder) => fs.rm(folder, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "skill-transaction-boundary-")),
  );
  folders.push(root);
  const id = "boundary-transaction";
  const temporary = path.join(root, ".skill-state/library-staging", id);
  const target = path.join(root, "skills/demo");
  const incoming = path.join(temporary, "incoming");
  const backup = path.join(root, "backups/skills/demo");
  for (const [folder, value] of [
    [target, "old"],
    [incoming, "new"],
  ]) {
    await fs.mkdir(folder!, { recursive: true });
    await fs.writeFile(path.join(folder!, "SKILL.md"), value!);
  }
  const oldLock = { schema_version: 2, skills: {}, previous: {} };
  const lockFile = path.join(root, "skills.lock.json");
  await writeSkillJson(lockFile, oldLock);
  const input = {
    id,
    operation: "update",
    library_id: "demo",
    old_lock: oldLock,
    new_lock: oldLock,
    moves: [
      { from: target, to: backup },
      { from: incoming, to: target },
    ],
    cleanup: [temporary],
  };
  return { root, target, incoming, backup, temporary, lockFile, oldLock, input };
}

describe("Skill transaction recovery boundaries", () => {
  it("does not mistake unchanged metadata for a committed interrupted package move", async () => {
    const f = await fixture();
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (from === f.incoming) throw new Error("activation failed");
      return rename(from, to);
    });
    await expect(executeLibraryTransaction(f.root, f.input)).rejects.toThrow("activation failed");
    expect(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe("old");
    expect(JSON.parse(await fs.readFile(f.lockFile, "utf8"))).toEqual(f.oldLock);
    expect((await readLibraryTransaction(f.root, f.input.id))?.state).toBe("recovered");
  });

  it("reports committed with pending cleanup when post-commit journal persistence and cleanup both fail", async () => {
    const f = await fixture();
    const rename = fs.rename.bind(fs);
    let metadataSaved = false;
    let journalFailed = false;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (metadataSaved && !journalFailed && String(to).endsWith(`${f.input.id}.json`)) {
        journalFailed = true;
        throw new Error("journal disk full");
      }
      await rename(from, to);
      if (to === f.lockFile) metadataSaved = true;
    });
    const remove = fs.rm.bind(fs);
    vi.spyOn(fs, "rm").mockImplementation(async (file, options) => {
      if (file === f.temporary) throw new Error("cleanup denied");
      return remove(file, options);
    });
    await expect(executeLibraryTransaction(f.root, f.input)).resolves.toEqual({
      cleanup_pending: true,
    });
    expect(journalFailed).toBe(true);
    expect(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe("new");
    expect(await fs.readFile(path.join(f.backup, "SKILL.md"), "utf8")).toBe("old");
    expect((await readLibraryTransaction(f.root, f.input.id))?.state).toBe("committed");
  });

  it("rejects a cleanup path that points at the live package tree before moving content", async () => {
    const f = await fixture();
    await expect(
      executeLibraryTransaction(f.root, { ...f.input, cleanup: [path.join(f.root, "skills")] }),
    ).rejects.toThrow("cleanup location");
    expect(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe("old");
    expect(await fs.readFile(path.join(f.incoming, "SKILL.md"), "utf8")).toBe("new");
  });

  it("preserves an external replacement of an operation temporary directory during cleanup recovery", async () => {
    const f = await fixture();
    const remove = fs.rm.bind(fs);
    vi.spyOn(fs, "rm").mockImplementation(async (file, options) => {
      if (file === f.temporary) throw new Error("cleanup denied");
      return remove(file, options);
    });
    expect(await executeLibraryTransaction(f.root, f.input)).toEqual({ cleanup_pending: true });
    vi.restoreAllMocks();
    await fs.rename(f.temporary, `${f.temporary}-original`);
    await fs.mkdir(f.temporary);
    await fs.writeFile(path.join(f.temporary, "external.txt"), "preserve me");
    const result = await recoverLibraryTransactions(f.root);
    expect(result[0]).toMatchObject({
      status: "committed",
      error: expect.stringContaining("preserved"),
    });
    expect(await fs.readFile(path.join(f.temporary, "external.txt"), "utf8")).toBe("preserve me");
  });
});
