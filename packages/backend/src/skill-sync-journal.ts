import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { isReparseOrSymlink } from "./native-files";

type RecordValue = Record<string, unknown>;
type SyncOperation = "adopt" | "pull" | "push" | "fork" | "detach" | "restore" | "bind";

/** Only the validated identities needed by deployment gates are exposed here. */
export type SkillSyncJournalIdentity = {
  schema_version: 1;
  kind: "skill-sync";
  operation_id: string;
  phase: "prepared" | "library-committed" | "location-committed";
  library_id: string | null;
  plan: {
    operation: SyncOperation;
    library_id: string | null;
    location: {
      destination: string;
      target: { id: string; scope: "personal" | "workspace"; root: string; scope_root: string };
      receipt: { id: string } | null;
    };
  };
};

export type SkillSyncTargetJournal = {
  operation_id: string;
  destination: string;
  scope_root: string;
  target_id: string;
  deployment_id: string | null;
  library_id: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_JOURNALS = 4096;
const OPERATIONS = ["adopt", "pull", "push", "fork", "detach", "restore", "bind"];
/** Native directories retain their names; only library identities use ASCII slugs. */
export function safeSkillDirectoryName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !path.isAbsolute(value) &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !/^[a-z]:/i.test(value) &&
    ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  );
}
const object = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const nullableHash = (value: unknown) => value === null || (text(value) && HASH.test(value));
const nullableId = (value: unknown) => value === null || (text(value) && ID.test(value));
const strings = (value: unknown) =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");
const absolutePath = (value: unknown): value is string =>
  text(value) &&
  path.isAbsolute(value) &&
  !value.includes("\0") &&
  !value.split(/[\\/]/).includes("..");

function inside(file: string, root: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function physicalPath(value: string): string {
  let current = path.resolve(value);
  const suffix: string[] = [];
  while (true) {
    try {
      const resolved = path.join(realpathSync.native(current), ...suffix);
      return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

function sameEntry(left: string, right: string): boolean {
  const identity = (file: string) => {
    const entry = path.join(physicalPath(path.dirname(file)), path.basename(file));
    return process.platform === "win32" ? entry.toLowerCase() : entry;
  };
  return identity(left) === identity(right);
}

/** Validate before filtering or granting an operation permission to ignore itself. */
export function assertSkillSyncJournal(
  value: unknown,
  id: string,
): asserts value is SkillSyncJournalIdentity {
  const invalid = () => new Error(`Invalid Skill synchronization journal: ${id}`);
  if (
    !UUID.test(id) ||
    !object(value) ||
    value.schema_version !== 1 ||
    value.kind !== "skill-sync" ||
    value.operation_id !== id ||
    !["prepared", "library-committed", "location-committed"].includes(String(value.phase)) ||
    !["manual", "automatic", "recovery"].includes(String(value.trigger)) ||
    !nullableId(value.library_id) ||
    !text(value.started_at) ||
    !Number.isFinite(Date.parse(value.started_at)) ||
    !object(value.plan)
  )
    throw invalid();
  const plan = value.plan;
  if (
    !OPERATIONS.includes(String(plan.operation)) ||
    !text(plan.token) ||
    !UUID.test(plan.token) ||
    !nullableId(plan.library_id) ||
    !Number.isSafeInteger(plan.policy_revision) ||
    (plan.policy_revision as number) < 0 ||
    !Number.isSafeInteger(plan.expires) ||
    (plan.expires as number) <= 0 ||
    !strings(plan.conflicts) ||
    (plan.resolution !== undefined &&
      !["library", "deployment"].includes(String(plan.resolution))) ||
    [
      "before_hash",
      "candidate_hash",
      "target_snapshot",
      "library_snapshot",
      "base_snapshot",
      "base_hash",
    ].some((key) => !nullableHash(plan[key])) ||
    (plan.operation !== "detach" && plan.candidate_hash === null) ||
    !object(plan.location)
  )
    throw invalid();
  const location = plan.location;
  if (
    !absolutePath(location.destination) ||
    !safeSkillDirectoryName(path.basename(location.destination)) ||
    !absolutePath(location.receipt_file) ||
    !nullableHash(location.target_hash) ||
    !text(location.owner_key) ||
    !text(location.target_key) ||
    (location.target_identity !== undefined &&
      location.target_identity !== null &&
      !text(location.target_identity)) ||
    (location.observation_id !== undefined && !text(location.observation_id)) ||
    !object(location.target)
  )
    throw invalid();
  const target = location.target;
  if (
    !text(target.id) ||
    !ID.test(target.id) ||
    !["personal", "workspace"].includes(String(target.scope)) ||
    !absolutePath(target.root) ||
    !absolutePath(target.scope_root) ||
    !inside(location.destination, target.scope_root) ||
    !inside(target.root, target.scope_root) ||
    physicalPath(path.dirname(location.destination)) !== physicalPath(target.root)
  )
    throw invalid();
  const receipt = location.receipt;
  if (receipt === null) {
    if (!text(location.observation_id)) throw invalid();
  } else if (
    !object(receipt) ||
    !text(receipt.id) ||
    !ID.test(receipt.id) ||
    !text(receipt.library_id) ||
    !ID.test(receipt.library_id) ||
    !safeSkillDirectoryName(receipt.package_name) ||
    receipt.package_name !== path.basename(location.destination) ||
    !text(receipt.package_hash) ||
    !HASH.test(receipt.package_hash) ||
    !absolutePath(receipt.target) ||
    !sameEntry(receipt.target, location.destination) ||
    receipt.scope !== target.scope ||
    !absolutePath(receipt.scope_root) ||
    physicalPath(receipt.scope_root) !== physicalPath(target.scope_root) ||
    !strings(receipt.agents) ||
    !strings(receipt.visible_to) ||
    !text(receipt.status) ||
    (receipt.library_root !== undefined &&
      receipt.library_root !== null &&
      !absolutePath(receipt.library_root))
  )
    throw invalid();
  if (plan.library !== null) {
    const library = plan.library;
    if (
      !object(library) ||
      !text(library.id) ||
      library.id !== plan.library_id ||
      typeof library.display_name !== "string" ||
      !text(library.hash) ||
      !HASH.test(library.hash) ||
      !nullableHash(library.observed_hash) ||
      !text(library.lock_fingerprint) ||
      !absolutePath(library.path) ||
      typeof library.valid !== "boolean" ||
      (library.upstream_base_hash !== undefined && !nullableHash(library.upstream_base_hash)) ||
      (library.diagnostics !== undefined && !strings(library.diagnostics))
    )
      throw invalid();
  }
}

export async function readSkillSyncTargetJournals(
  libraryRoot: string,
): Promise<SkillSyncTargetJournal[]> {
  return readSkillSyncTargetJournalsSync(libraryRoot);
}

/** Synchronous readers also guard legacy ChangeSets without importing the state store. */
export function readSkillSyncTargetJournalsSync(libraryRoot: string): SkillSyncTargetJournal[] {
  let directory = path.resolve(libraryRoot);
  for (const part of ["", ".skill-state", "journals"]) {
    if (part) directory = path.join(directory, part);
    let metadata;
    try {
      metadata = lstatSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (!metadata.isDirectory() || isReparseOrSymlink(directory, metadata))
      throw new Error(`Skill synchronization journal directory is unsafe: ${directory}`);
  }
  let entries: string[];
  try {
    entries = readdirSync(directory)
      .filter((entry) => entry.endsWith(".json"))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (entries.length > MAX_JOURNALS)
    throw new Error("Skill synchronization journals exceed their record limit");
  const targets: SkillSyncTargetJournal[] = [];
  for (const entry of entries) {
    const id = entry.slice(0, -5);
    const file = path.join(directory, entry);
    let descriptor: number | undefined;
    let journal: unknown;
    try {
      const metadata = lstatSync(file);
      if (
        !metadata.isFile() ||
        isReparseOrSymlink(file, metadata) ||
        metadata.size > MAX_JSON_BYTES
      )
        throw new Error(
          `Skill synchronization journal is unsafe or exceeds its size limit: ${file}`,
        );
      descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(descriptor);
      const current = lstatSync(file);
      if (
        !opened.isFile() ||
        opened.size > MAX_JSON_BYTES ||
        !current.isFile() ||
        isReparseOrSymlink(file, current) ||
        opened.dev !== metadata.dev ||
        opened.ino !== metadata.ino ||
        opened.dev !== current.dev ||
        opened.ino !== current.ino
      )
        throw new Error(`Skill synchronization journal changed or is unsafe: ${file}`);
      const bytes = readFileSync(descriptor);
      if (bytes.length > MAX_JSON_BYTES)
        throw new Error(`Skill synchronization journal exceeds its size limit: ${file}`);
      journal = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      // A concurrent terminal cleanup may remove a journal after directory enumeration.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    assertSkillSyncJournal(journal, id);
    // Forks only write the library; completed location commits need no target lease.
    if (journal.plan.operation === "fork" || journal.phase === "location-committed") continue;
    targets.push({
      operation_id: journal.operation_id,
      destination: journal.plan.location.destination,
      scope_root: journal.plan.location.target.scope_root,
      target_id: journal.plan.location.target.id,
      deployment_id: journal.plan.location.receipt?.id ?? null,
      library_id: journal.library_id,
    });
  }
  return targets;
}
