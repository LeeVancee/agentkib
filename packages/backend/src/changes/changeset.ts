import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdir, copyFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  atomicWrite,
  atomicWriteChecked,
  expectedMissing,
  expectedSha256,
} from "../platform/fs.js";
import { isReparseOrSymlink } from "../platform/path.js";
import { backendError } from "../contracts.js";
export type ChangeRisk = "low" | "medium" | "high";
export interface FileChange {
  target: string;
  scope: "project" | "agent-home";
  original_hash?: string;
  before: string;
  after: string;
  risk: ChangeRisk;
  validator: "json" | "yaml" | "toml" | "markdown" | "text";
}
export interface ChangeSet {
  id: string;
  project_root: string;
  created_at: string;
  changes: FileChange[];
  requires_home_approval: boolean;
}
export interface ApplyReport {
  changeset_id: string;
  applied: string[];
  backup_dir: string;
}
export function hashContent(content: Uint8Array | string): string {
  return createHash("sha256").update(content).digest("hex");
}
export function planChangeSet(projectRoot: string, changes: FileChange[]): ChangeSet {
  return {
    id: randomUUID(),
    project_root: projectRoot,
    created_at: new Date().toISOString(),
    changes,
    requires_home_approval: changes.some((change) => change.scope === "agent-home"),
  };
}
export async function applyChangeSet(
  changeset: ChangeSet,
  backupRoot: string,
  homeApproval = false,
): Promise<ApplyReport> {
  if (changeset.requires_home_approval && !homeApproval)
    throw backendError("PERMISSION", "Agent Home write is not authorized");
  const backup = path.join(backupRoot, changeset.id);
  await mkdir(backup, { recursive: true });
  const applied: Array<{ target: string; backup: string; existed: boolean }> = [];
  try {
    for (let index = 0; index < changeset.changes.length; index++) {
      const change = changeset.changes[index];
      const target = path.resolve(change.target),
        project = path.resolve(changeset.project_root),
        relative = path.relative(project, target);
      if (change.scope === "project" && (relative.startsWith("..") || path.isAbsolute(relative)))
        throw backendError("PERMISSION", "Refusing to write outside the project");
      if (await isReparseOrSymlink(target).catch(() => false))
        throw backendError("PERMISSION", "Refusing to write through a symlink or reparse point");
      const currentHash = await readFile(target)
        .then((value) => hashContent(value))
        .catch(() => undefined);
      if ((change.original_hash ?? undefined) !== currentHash)
        throw backendError("CONFLICT", `File was modified externally: ${target}`);
      const backupFile = path.join(backup, `${index}.bak`),
        existed = currentHash !== undefined;
      if (existed) await copyFile(target, backupFile);
      await atomicWriteChecked(
        target,
        change.after,
        change.original_hash ? expectedSha256(change.original_hash) : expectedMissing,
      );
      applied.push({ target, backup: backupFile, existed });
    }
  } catch (error) {
    for (const item of applied.reverse()) {
      if (item.existed)
        await readFile(item.backup)
          .then((content) => atomicWrite(item.target, content))
          .catch(() => undefined);
      else await rm(item.target, { force: true }).catch(() => undefined);
    }
    throw error;
  }
  return {
    changeset_id: changeset.id,
    applied: applied.map((item) => item.target),
    backup_dir: backup,
  };
}
