import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { isReparseOrSymlink } from "./native-files";
import { readSkillSyncTargetJournalsSync } from "./skill-sync-journal";

const RECORD_FILES = ["skill-deployments.json", "skill-deployment-reservations.json"];
const INDEX_FILES = ["skill-library-roots.json", "skill-personal-library-roots.json"];
const RESERVED_FILES = new Set([
  ...RECORD_FILES,
  ...INDEX_FILES,
  "skills.lock.json",
  ".agentkib-skill.lock",
  "skill-sync-policies.json",
  "skill-sync.json",
  "skill-sync-runs.json",
]);

function physical(file: string): string {
  if (!path.isAbsolute(file) || file.includes("\0") || file.split(/[\\/]/).includes(".."))
    throw new Error("Skill ownership path is invalid");
  let current = file;
  const suffix: string[] = [];
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error("Skill ownership path has no existing ancestor");
    suffix.unshift(path.basename(current));
    current = parent;
  }
  const real = path.join(realpathSync.native(current), ...suffix);
  return process.platform === "win32" ? real.toLowerCase() : real;
}

function contains(file: string, root: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}
function overlaps(left: string, right: string): boolean {
  return contains(left, right) || contains(right, left);
}

function readRecord(file: string, maxBytes: number): Record<string, unknown> | null {
  let info;
  try {
    info = lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parent = lstatSync(path.dirname(file));
  if (
    !info.isFile() ||
    isReparseOrSymlink(file, info) ||
    info.size > maxBytes ||
    !parent.isDirectory() ||
    isReparseOrSymlink(path.dirname(file), parent)
  )
    throw new Error(`Skill ownership cannot be verified: ${file}`);
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Skill ownership cannot be verified: ${file}`);
  return value as Record<string, unknown>;
}

function skillPathOwnership(target: string, skillHomes: string[]) {
  const candidate = physical(target);
  const libraries = new Set(skillHomes.map((root) => path.resolve(root)));
  const receiptFiles = new Set<string>();
  const lockRoots = new Set<string>();
  const syncTargets: ReturnType<typeof readSkillSyncTargetJournalsSync> = [];
  const ancestors = new Set<string>();
  for (const parent of [path.dirname(target), path.dirname(candidate)])
    for (let current = parent; ; current = path.dirname(current)) {
      ancestors.add(current);
      if (path.dirname(current) === current) break;
    }
  // A target without project metadata still shares its existing parent with a
  // concurrent deployment. Do not create missing directories merely to lock them.
  let parent = path.dirname(candidate);
  while (!existsSync(parent)) parent = path.dirname(parent);
  for (let current = parent; ; current = path.dirname(current)) {
    if (existsSync(path.join(current, "SKILL.md"))) parent = path.dirname(current);
    if (path.dirname(current) === current) break;
  }
  lockRoots.add(physical(parent));
  for (const current of ancestors) {
    if (
      existsSync(path.join(current, ".git")) ||
      existsSync(path.join(current, ".agentkib")) ||
      existsSync(path.join(current, ".agentkib-skill.lock"))
    )
      lockRoots.add(physical(current));
    for (const file of RECORD_FILES) receiptFiles.add(path.join(current, ".agentkib", file));
    if (existsSync(path.join(current, "skills.lock.json"))) {
      libraries.add(current);
      lockRoots.add(physical(current));
    }
    for (const name of INDEX_FILES) {
      const file = path.join(current, ".agentkib", name);
      const index = readRecord(file, 1024 * 1024);
      if (!index) continue;
      if (
        ![1, 2].includes(index.schema_version as number) ||
        !Array.isArray(index.libraries) ||
        index.libraries.length > 128 ||
        index.libraries.some((root) => typeof root !== "string" || !path.isAbsolute(root))
      )
        throw new Error(`Skill ownership index cannot be verified: ${file}`);
      for (const root of index.libraries as string[]) {
        const info = lstatSync(root);
        if (!info.isDirectory() || isReparseOrSymlink(root, info))
          throw new Error(`Skill ownership library is unavailable or unsafe: ${root}`);
        libraries.add(root);
      }
    }
  }
  for (const library of libraries) {
    if (existsSync(library)) lockRoots.add(physical(library));
    for (const file of RECORD_FILES) receiptFiles.add(path.join(library, file));
    for (const journal of readSkillSyncTargetJournalsSync(library)) {
      syncTargets.push(journal);
      if (overlaps(candidate, physical(journal.destination)))
        lockRoots.add(physical(journal.scope_root));
    }
  }
  return { candidate, libraries, receiptFiles, lockRoots, syncTargets };
}

/** Resolve the same scopes and libraries that the legacy ownership check reads. */
export function skillPathLockRoots(target: string, skillHomes: string[] = []): string[] {
  return [...skillPathOwnership(target, skillHomes).lockRoots];
}

export function skillTargetLockRoots(
  library: string,
  targets: Array<{ destination: string; scope_root: string }>,
): string[] {
  return [
    ...new Set([
      physical(library),
      ...targets.flatMap((target) => [
        physical(target.scope_root),
        ...skillPathLockRoots(target.destination, [library]),
      ]),
    ]),
  ];
}

/** Legacy text generation must never read from or replace package-manager owned state. */
export function assertUnmanagedSkillPath(
  target: string,
  skillHomes: string[] = [],
  includeAncestors = true,
): void {
  if (RESERVED_FILES.has(path.basename(target)) || target.split(path.sep).includes(".skill-state"))
    throw new Error(`Skill state cannot be changed by a text ChangeSet: ${target}`);
  const { candidate, libraries, receiptFiles, syncTargets } = skillPathOwnership(
    target,
    skillHomes,
  );
  const protectedPath = (owned: string) =>
    includeAncestors ? overlaps(candidate, owned) : contains(candidate, owned);
  for (const library of libraries) {
    for (const relative of [
      "skills",
      "backups/skills",
      "trash/skills",
      ".staging/skills",
      ".skill-state",
    ])
      if (protectedPath(physical(path.join(library, relative))))
        throw new Error(`ChangeSet overlaps a managed Skill library: ${target}`);
  }
  for (const journal of syncTargets)
    if (protectedPath(physical(journal.destination)))
      throw new Error(
        `ChangeSet overlaps a managed Skill deployment requiring recovery: ${target}`,
      );
  for (const file of receiptFiles) {
    const parsed = readRecord(file, 4 * 1024 * 1024);
    if (!parsed) continue;
    if (
      ![1, 2].includes(parsed.schema_version as number) ||
      !Array.isArray(parsed.deployments) ||
      parsed.deployments.length > 4096
    )
      throw new Error(`Skill deployment ownership cannot be verified: ${file}`);
    for (const record of parsed.deployments) {
      if (
        !record ||
        typeof record !== "object" ||
        typeof record.target !== "string" ||
        !path.isAbsolute(record.target)
      )
        throw new Error(`Skill deployment ownership cannot be verified: ${file}`);
      // Completed withdrawal retains an audit receipt, not ownership of the files.
      // Reservations remain protective regardless of any incidental status field.
      if (path.basename(file) === "skill-deployments.json" && record.status === "inactive")
        continue;
      if (protectedPath(physical(record.target)))
        throw new Error(`ChangeSet overlaps a managed Skill deployment: ${target}`);
    }
  }
}
