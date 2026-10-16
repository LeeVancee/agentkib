import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { acquirePortableFileLease } from "./managed-session-lock";
import { isReparseOrSymlink, moveNoReplace } from "./native-files";
import { copySkillPackage, skillPackage } from "./skill-package";
import { skillTargetLockRoots } from "./skill-ownership";

export const SKILL_HASH_ALGORITHM = "skill-package-v1" as const;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const heldLocks = new AsyncLocalStorage<ReadonlySet<string>>();

async function regularDirectory(directory: string, create = false): Promise<void> {
  if (create) await fs.mkdir(directory, { recursive: true });
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || isReparseOrSymlink(directory, info))
    throw new Error(`Skill state directory is unsafe: ${directory}`);
}

async function syncDirectory(directory: string): Promise<void> {
  // Windows does not provide the POSIX directory fsync operation.
  if (process.platform === "win32") return;
  const handle = await fs.open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Missing files are optional; malformed, oversized and linked state is never ignored. */
export async function readSkillJson<T>(file: string, maxBytes = MAX_JSON_BYTES): Promise<T | null> {
  let handle;
  try {
    await regularDirectory(path.dirname(file));
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes || isReparseOrSymlink(file, await fs.lstat(file)))
      throw new Error(`Skill state file is unsafe or exceeds its size limit: ${file}`);
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes)
      throw new Error(`Skill state file exceeds its size limit: ${file}`);
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (value === null) throw new Error(`Skill state file cannot contain null: ${file}`);
    return value as T;
  } finally {
    await handle.close();
  }
}

async function writeJson(file: string, value: unknown, exclusive: boolean): Promise<void> {
  const text = JSON.stringify(value, null, 2);
  if (text === undefined || Buffer.byteLength(text + "\n") > MAX_JSON_BYTES)
    throw new Error("Skill state JSON is invalid or exceeds its size limit");
  const parent = path.dirname(file);
  await regularDirectory(parent, true);
  try {
    const info = await fs.lstat(file);
    if (!info.isFile() || isReparseOrSymlink(file, info))
      throw new Error(`Skill state file is unsafe: ${file}`);
    if (exclusive) throw new Error(`Skill state already exists: ${file}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = path.join(parent, `.skill-state-${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(text + "\n");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (exclusive) moveNoReplace(temporary, file);
    else await fs.rename(temporary, file);
    await syncDirectory(parent);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function writeSkillJson(file: string, value: unknown): Promise<void> {
  return writeJson(file, value, false);
}

/** Shared across library, deployment and recovery writers; contention fails without polling. */
export async function withSkillLocks<T>(roots: string[], fn: () => Promise<T>): Promise<T> {
  const identities = await Promise.all(
    roots.map(async (root) => {
      let ancestor = root;
      const suffix: string[] = [];
      while (true) {
        try {
          await fs.lstat(ancestor);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          suffix.unshift(path.basename(ancestor));
          ancestor = path.dirname(ancestor);
        }
      }
      const real = path.join(await fs.realpath(ancestor), ...suffix);
      return process.platform === "win32" ? real.toLowerCase() : real;
    }),
  );
  const ordered = [...new Set(identities)].sort((a, b) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b)),
  );
  const inherited = heldLocks.getStore() ?? new Set<string>();
  const heldOrder = [...inherited].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const lastHeld = heldOrder.at(-1);
  if (
    lastHeld &&
    ordered.some(
      (root) =>
        !inherited.has(root) && Buffer.compare(Buffer.from(root), Buffer.from(lastHeld)) < 0,
    )
  )
    throw new Error("Skill locks must be acquired together in physical-path order");
  const active = new Set(inherited);
  const releases: Array<() => void> = [];
  let outcome: { value: T } | { error: unknown };
  try {
    for (const root of ordered) {
      if (active.has(root)) continue;
      // Resolve missing roots before sorting, but create each one only after its
      // existing ancestors have been locked. Contention cannot create a new scope.
      await fs.mkdir(root, { recursive: true });
      const real = await fs.realpath(root);
      if ((process.platform === "win32" ? real.toLowerCase() : real) !== root)
        throw new Error("Skill lock path changed before acquisition");
      await regularDirectory(root);
      releases.push(acquirePortableFileLease(path.join(root, ".agentkib-skill.lock")));
      active.add(root);
    }
    outcome = { value: await heldLocks.run(active, fn) };
  } catch (error) {
    outcome = { error };
  }
  const releaseFailures: unknown[] = [];
  for (const release of releases.reverse()) {
    try {
      release();
    } catch (error) {
      releaseFailures.push(error);
    }
  }
  if ("error" in outcome) {
    if (releaseFailures.length)
      throw new AggregateError(
        [outcome.error, ...releaseFailures],
        "Skill operation and lease release failed",
      );
    throw outcome.error;
  }
  if (releaseFailures.length)
    throw new AggregateError(releaseFailures, "Skill lease release failed");
  return outcome.value;
}

/** Deployment, synchronization and recovery share all target ownership leases. */
export async function withSkillTargetLocks<T>(
  library: string,
  targets: Array<{ destination: string; scope_root: string }>,
  fn: () => Promise<T>,
): Promise<T> {
  const roots = skillTargetLockRoots(library, targets);
  return withSkillLocks(roots, async () => {
    if (skillTargetLockRoots(library, targets).some((root) => !roots.includes(root)))
      throw new Error("Skill ownership changed while acquiring locks; prepare the operation again");
    return fn();
  });
}

export class SkillStateStore {
  readonly root: string;
  readonly directory: string;
  constructor(root: string) {
    this.root = path.resolve(root);
    this.directory = path.join(this.root, ".skill-state");
  }

  #hash(hash: string): void {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid Skill snapshot hash");
  }

  async #directory(relative: string, create: boolean): Promise<string> {
    await regularDirectory(this.root, create);
    let directory = this.root;
    for (const part of [".skill-state", ...relative.split("/").filter(Boolean)]) {
      directory = path.join(directory, part);
      await regularDirectory(directory, create);
    }
    return directory;
  }

  snapshotPath(hash: string): string {
    this.#hash(hash);
    return path.join(this.directory, "snapshots", SKILL_HASH_ALGORITHM, hash);
  }

  async verifySnapshot(hash: string): Promise<string> {
    const directory = this.snapshotPath(hash);
    await this.#directory(`snapshots/${SKILL_HASH_ALGORITHM}`, false);
    await regularDirectory(directory);
    const info = await skillPackage(directory);
    if (info.diagnostics.length || info.hash !== hash)
      throw new Error(`Skill snapshot is corrupt: ${hash}`);
    if (!info.files.some((entry) => entry.path === "SKILL.md"))
      throw new Error(`Skill snapshot has no SKILL.md entry point: ${hash}`);
    return directory;
  }

  async snapshot(directory: string, expectedHash?: string): Promise<string> {
    if (expectedHash !== undefined) this.#hash(expectedHash);
    await regularDirectory(directory);
    const original = await skillPackage(directory);
    if (original.diagnostics.length) throw new Error(original.diagnostics.join("; "));
    if (!original.files.some((entry) => entry.path === "SKILL.md"))
      throw new Error("Skill snapshot requires a SKILL.md entry point");
    if (expectedHash !== undefined && original.hash !== expectedHash)
      throw new Error("Skill package changed before snapshotting");
    const parent = await this.#directory(`snapshots/${SKILL_HASH_ALGORITHM}`, true);
    const destination = this.snapshotPath(original.hash);
    try {
      await fs.lstat(destination);
      await this.verifySnapshot(original.hash);
      return original.hash;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporary = path.join(parent, `.snapshot-${randomUUID()}`);
    try {
      await copySkillPackage(directory, temporary);
      const staged = await skillPackage(temporary);
      const current = await skillPackage(directory);
      if (
        staged.diagnostics.length ||
        current.diagnostics.length ||
        staged.hash !== original.hash ||
        current.hash !== original.hash
      )
        throw new Error("Skill package changed while snapshotting");
      for (const entry of staged.files) {
        if (entry.path.endsWith("/")) continue;
        const handle = await fs.open(path.join(temporary, entry.path), constants.O_RDONLY);
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      for (const entry of staged.files.filter((entry) => entry.path.endsWith("/")).reverse())
        await syncDirectory(path.join(temporary, entry.path));
      await syncDirectory(temporary);
      try {
        moveNoReplace(temporary, destination);
        await syncDirectory(parent);
      } catch (error) {
        // Concurrent identical snapshots may win, but damaged existing content is never replaced.
        try {
          await fs.lstat(destination);
        } catch {
          throw error;
        }
        await this.verifySnapshot(original.hash);
      }
      await this.verifySnapshot(original.hash);
      return original.hash;
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }

  #journalId(id: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id))
      throw new Error("Invalid Skill journal identity");
  }
  async startJournal(id: string, value: unknown): Promise<void> {
    this.#journalId(id);
    const directory = await this.#directory("journals", true);
    await writeJson(path.join(directory, `${id}.json`), value, true);
  }
  async writeJournal(id: string, value: unknown): Promise<void> {
    this.#journalId(id);
    const directory = await this.#directory("journals", true);
    await writeSkillJson(path.join(directory, `${id}.json`), value);
  }
  async readJournal<T>(id: string): Promise<T | null> {
    this.#journalId(id);
    try {
      await this.#directory("journals", false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    return readSkillJson<T>(path.join(this.directory, "journals", `${id}.json`));
  }
  async listJournals<T>(): Promise<Array<{ id: string; journal: T }>> {
    let directory: string;
    try {
      directory = await this.#directory("journals", false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const result: Array<{ id: string; journal: T }> = [];
    for (const entry of (await fs.readdir(directory)).sort()) {
      if (!entry.endsWith(".json")) continue;
      const id = entry.slice(0, -5);
      this.#journalId(id);
      const journal = await readSkillJson<T>(path.join(directory, entry));
      if (journal !== null) result.push({ id, journal });
    }
    return result;
  }
  async removeJournal(id: string): Promise<void> {
    this.#journalId(id);
    const directory = await this.#directory("journals", false);
    await fs.rm(path.join(directory, `${id}.json`), { force: true });
    await syncDirectory(directory);
  }
}
