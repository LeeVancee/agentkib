import { promises as fs } from "node:fs";
import path from "node:path";
import { readSkillJson, writeSkillJson } from "./skill-state";
import { isReparseOrSymlink } from "./native-files";

type Move = { from: string; to: string; identity?: string };
export type LibraryTransaction = {
  schema_version: 1;
  id: string;
  operation: string;
  library_id: string;
  old_lock: unknown;
  new_lock: unknown;
  moves: Move[];
  cleanup: string[];
  cleanup_identities?: Record<string, string>;
  state: "prepared" | "committing" | "committed" | "recovered";
  cursor: number;
  created_at: string;
  error?: string;
};

function journalFile(root: string, id: string) {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new Error("Invalid Skill operation ID");
  return path.join(root, ".skill-state/library-transactions", `${id}.json`);
}

async function identity(file: string) {
  return fs.lstat(file).then(
    (stat) => `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`,
    (error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? null : Promise.reject(error)),
  );
}

function assertInside(root: string, file: string) {
  const relative = path.relative(root, file);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error("Skill transaction path escaped the library");
}

async function safeParents(root: string, file: string) {
  assertInside(root, file);
  let directory = root;
  for (const segment of [
    "",
    ...path.relative(root, path.dirname(file)).split(path.sep).filter(Boolean),
  ]) {
    if (segment) directory = path.join(directory, segment);
    const stat = await fs
      .lstat(directory)
      .catch((error: NodeJS.ErrnoException) =>
        error.code === "ENOENT" ? null : Promise.reject(error),
      );
    if (!stat) return;
    if (!stat.isDirectory() || isReparseOrSymlink(directory, stat))
      throw new Error("Skill transaction parent is unsafe");
  }
}

function safeCleanup(root: string, journal: LibraryTransaction, file: string) {
  const staging = path.join(root, ".skill-state/library-staging", journal.id);
  const backup = path.join(root, "backups/skills", `${journal.library_id}.staging-${journal.id}`);
  const relativeTrash = path.relative(path.join(root, "trash/skills"), file);
  const restoring =
    journal.operation === "restore" &&
    /^skill-[a-zA-Z0-9-]{1,150}$/.test(relativeTrash) &&
    journal.moves.some((move) => move.from === path.join(file, "package"));
  if (file !== staging && file !== backup && !restoring)
    throw new Error("Invalid Skill transaction cleanup location");
}

async function cleanupTransaction(root: string, journal: LibraryTransaction) {
  for (const file of journal.cleanup) {
    safeCleanup(root, journal, file);
    await safeParents(root, file);
    const actual = await identity(file);
    if (actual && actual !== journal.cleanup_identities?.[file])
      throw new Error("Skill transaction temporary location changed; contents were preserved");
    await fs.rm(file, { recursive: true, force: true });
  }
}

export async function readLibraryTransaction(root: string, id: string) {
  await safeParents(root, journalFile(root, id));
  return readSkillJson<LibraryTransaction>(journalFile(root, id));
}

export async function listLibraryTransactions(root: string): Promise<LibraryTransaction[]> {
  const folder = path.dirname(journalFile(root, "list"));
  await safeParents(root, path.join(folder, "list.json"));
  const files = await fs
    .readdir(folder)
    .catch((error: NodeJS.ErrnoException) =>
      error.code === "ENOENT" ? [] : Promise.reject(error),
    );
  const output: LibraryTransaction[] = [];
  for (const file of files) {
    if (!/^[a-zA-Z0-9_-]{1,200}\.json$/.test(file)) continue;
    const record = await readSkillJson<LibraryTransaction>(path.join(folder, file));
    if (
      !record ||
      record.schema_version !== 1 ||
      !Array.isArray(record.moves) ||
      !Array.isArray(record.cleanup) ||
      !Number.isInteger(record.cursor) ||
      record.cursor < -1 ||
      record.cursor >= record.moves.length ||
      !["prepared", "committing", "committed", "recovered"].includes(record.state) ||
      record.id !== path.basename(file, ".json") ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(record.library_id)
    )
      throw new Error("Invalid Skill library transaction; manual recovery is required");
    output.push(record);
  }
  return output;
}

// The caller holds the physical library lease. Every rename is recorded before it
// happens. Recovery distinguishes a rename interrupted before/after its syscall by
// the original directory identity, without deleting an intervening external edit.
export async function recoverLibraryTransactions(root: string, operationId?: string) {
  const results: Array<{ operation_id: string; status: string; error?: string }> = [];
  for (const journal of await listLibraryTransactions(root)) {
    if (operationId && journal.id !== operationId) continue;
    if (journal.state === "recovered") continue;
    if (journal.state === "committed" && journal.cleanup.length === 0) {
      results.push({ operation_id: journal.id, status: "committed" });
      continue;
    }
    const file = journalFile(root, journal.id);
    try {
      for (const move of journal.moves) {
        await safeParents(root, move.from);
        await safeParents(root, move.to);
      }
      for (const cleanup of journal.cleanup) await safeParents(root, cleanup);
      const lockFile = path.join(root, "skills.lock.json");
      const actual = await readSkillJson(lockFile);
      if (
        journal.state === "committed" ||
        JSON.stringify(actual) === JSON.stringify(journal.new_lock)
      ) {
        journal.state = "committed";
        await writeSkillJson(file, journal);
        // Only operation-owned temporary paths are eligible for removal.
        let cleanupError: string | undefined;
        try {
          await cleanupTransaction(root, journal);
          journal.cleanup = [];
          await writeSkillJson(file, journal);
        } catch (error) {
          cleanupError = error instanceof Error ? error.message : String(error);
        }
        results.push({
          operation_id: journal.id,
          status: "committed",
          ...(cleanupError ? { error: cleanupError } : {}),
        });
        continue;
      }
      if (JSON.stringify(actual) !== JSON.stringify(journal.old_lock))
        throw new Error("Library metadata changed outside the interrupted operation");
      while (journal.cursor >= 0) {
        const move = journal.moves[journal.cursor]!;
        if (!move.identity) {
          journal.cursor--;
          await writeSkillJson(file, journal);
          continue;
        }
        const [source, destination] = await Promise.all([identity(move.from), identity(move.to)]);
        if (!(source === move.identity && destination === null)) {
          if (source !== null || destination !== move.identity)
            throw new Error("Skill transaction location changed; recovery preserved all files");
          await fs.rename(move.to, move.from);
        }
        journal.cursor--;
        await writeSkillJson(file, journal);
      }
      journal.state = "recovered";
      delete journal.error;
      await writeSkillJson(file, journal);
      results.push({ operation_id: journal.id, status: "recovered" });
    } catch (error) {
      journal.error = error instanceof Error ? error.message : String(error);
      await writeSkillJson(file, journal);
      results.push({ operation_id: journal.id, status: "recovery-required", error: journal.error });
    }
  }
  return results;
}

export async function executeLibraryTransaction(
  root: string,
  input: {
    id: string;
    operation: string;
    library_id: string;
    old_lock: unknown;
    new_lock: unknown;
    moves: Move[];
    cleanup?: string[];
  },
) {
  const file = journalFile(root, input.id);
  const existing = await readLibraryTransaction(root, input.id);
  if (existing) {
    if (existing.state === "committed" && existing.library_id === input.library_id)
      return { cleanup_pending: existing.cleanup.length > 0 };
    throw new Error("Skill operation already exists; recover it before retrying");
  }
  const journal: LibraryTransaction = {
    ...input,
    schema_version: 1,
    cleanup: input.cleanup ?? [],
    state: "prepared",
    cursor: -1,
    created_at: new Date().toISOString(),
  };
  if (!input.new_lock || typeof input.new_lock !== "object" || Array.isArray(input.new_lock))
    throw new Error("Invalid Skill library metadata");
  // A unique marker makes metadata-only operations distinguishable from an
  // interrupted rename, even when the package was previously unmanaged.
  journal.new_lock = { ...input.new_lock, last_operation_id: input.id };
  journal.cleanup_identities = {};
  for (const cleanup of journal.cleanup) {
    safeCleanup(root, journal, cleanup);
    const value = await identity(cleanup);
    if (value) journal.cleanup_identities[cleanup] = value;
  }
  for (const move of journal.moves) {
    await safeParents(root, move.from);
    await safeParents(root, move.to);
  }
  await writeSkillJson(file, journal);
  try {
    for (let index = 0; index < journal.moves.length; index++) {
      const move = journal.moves[index]!;
      await safeParents(root, move.from);
      await safeParents(root, move.to);
      const sourceInfo = await fs.lstat(move.from);
      if (!sourceInfo.isDirectory() || isReparseOrSymlink(move.from, sourceInfo))
        throw new Error("Skill transaction source must be a regular directory");
      move.identity = (await identity(move.from)) ?? undefined;
      if (!move.identity || (await identity(move.to)))
        throw new Error("Skill transaction location changed");
      await fs.mkdir(path.dirname(move.to), { recursive: true });
      journal.cursor = index;
      journal.state = "committing";
      if (journal.cleanup.includes(move.to) && move.identity)
        journal.cleanup_identities[move.to] = move.identity;
      await writeSkillJson(file, journal);
      await fs.rename(move.from, move.to);
    }
    await writeSkillJson(path.join(root, "skills.lock.json"), journal.new_lock);
    journal.state = "committed";
    await writeSkillJson(file, journal);
  } catch (error) {
    const recovered = await recoverLibraryTransactions(root);
    const committed = recovered.find(
      (item) => item.operation_id === input.id && item.status === "committed",
    );
    if (committed) return { cleanup_pending: Boolean(committed.error) };
    throw error;
  }
  // Cleanup failure is recoverable and must not make a committed write appear to
  // have failed (or cause a caller to import the same candidate twice).
  let cleanupPending = false;
  await cleanupTransaction(root, journal).catch(() => {
    cleanupPending = true;
  });
  if (!cleanupPending) {
    journal.cleanup = [];
    await writeSkillJson(file, journal).catch(() => undefined);
  }
  return { cleanup_pending: cleanupPending };
}
