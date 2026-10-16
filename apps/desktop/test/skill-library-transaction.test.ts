import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeLibraryTransaction,
  recoverLibraryTransactions,
  readLibraryTransaction,
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentkib-library-journal-"));
  folders.push(root);
  const target = path.join(root, "skills/demo");
  const incoming = path.join(root, "staging/incoming");
  const backup = path.join(root, "backups/demo");
  for (const [folder, contents] of [
    [target, "old"],
    [incoming, "new"],
  ]) {
    await fs.mkdir(folder!, { recursive: true });
    await fs.writeFile(path.join(folder!, "SKILL.md"), contents!);
  }
  const oldLock = { schema_version: 1, skills: { demo: "old" }, previous: {} };
  const newLock = { schema_version: 2, skills: { demo: "new" }, previous: { demo: "old" } };
  await writeSkillJson(path.join(root, "skills.lock.json"), oldLock);
  const input = {
    id: "transaction-test",
    operation: "update",
    library_id: "demo",
    old_lock: oldLock,
    new_lock: newLock,
    moves: [
      { from: target, to: backup },
      { from: incoming, to: target },
    ],
  };
  return { root, target, incoming, backup, oldLock, newLock, input };
}

describe("durable Skill library transactions", () => {
  it.each(["move-old", "activate-new", "metadata"])(
    "recovers a failure at %s without losing either version",
    async (phase) => {
      const f = await fixture();
      const rename = fs.rename.bind(fs);
      let failed = false;
      vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        const matches =
          phase === "move-old"
            ? from === f.target
            : phase === "activate-new"
              ? from === f.incoming
              : to === path.join(f.root, "skills.lock.json");
        if (!failed && matches) {
          failed = true;
          throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        }
        return rename(from, to);
      });
      await expect(executeLibraryTransaction(f.root, f.input)).rejects.toThrow("disk full");
      expect(failed).toBe(true);
      expect(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe("old");
      expect(await fs.readFile(path.join(f.incoming, "SKILL.md"), "utf8")).toBe("new");
      expect(JSON.parse(await fs.readFile(path.join(f.root, "skills.lock.json"), "utf8"))).toEqual(
        f.oldLock,
      );
      expect((await readLibraryTransaction(f.root, f.input.id))?.state).toBe("recovered");
      expect(await recoverLibraryTransactions(f.root)).toEqual([]);
    },
  );

  it("treats an interrupted post-commit journal write as committed and remains idempotent", async () => {
    const f = await fixture();
    const rename = fs.rename.bind(fs);
    let saved = false;
    let failed = false;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (saved && !failed && String(to).endsWith("transaction-test.json")) {
        failed = true;
        throw new Error("interrupted");
      }
      await rename(from, to);
      if (to === path.join(f.root, "skills.lock.json")) saved = true;
    });
    await executeLibraryTransaction(f.root, f.input);
    expect(failed).toBe(true);
    expect((await readLibraryTransaction(f.root, f.input.id))?.state).toBe("committed");
    await executeLibraryTransaction(f.root, f.input);
    expect(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe("new");
    expect(await fs.readFile(path.join(f.backup, "SKILL.md"), "utf8")).toBe("old");
  });

  it("preserves an external replacement when recovering interrupted content activation", async () => {
    const f = await fixture();
    const stat = await fs.lstat(f.target);
    await fs.mkdir(path.dirname(f.backup), { recursive: true });
    await fs.rename(f.target, f.backup);
    await fs.mkdir(f.target);
    await fs.writeFile(path.join(f.target, "SKILL.md"), "external");
    await writeSkillJson(
      path.join(f.root, ".skill-state/library-transactions/transaction-test.json"),
      {
        ...f.input,
        schema_version: 1,
        cleanup: [],
        state: "committing",
        cursor: 0,
        created_at: new Date().toISOString(),
        moves: [
          { from: f.target, to: f.backup, identity: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}` },
          f.input.moves[1],
        ],
      },
    );
    const result = await recoverLibraryTransactions(f.root);
    expect(result[0]?.status).toBe("recovery-required");
    expect(await fs.readFile(path.join(f.target, "SKILL.md"), "utf8")).toBe("external");
    expect(await fs.readFile(path.join(f.backup, "SKILL.md"), "utf8")).toBe("old");
  });
});
