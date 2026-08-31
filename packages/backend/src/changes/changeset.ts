import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdir, copyFile, rm, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { parse as parseToml } from "@iarna/toml";
import {
  atomicWrite,
  atomicWriteChecked,
  expectedMissing,
  expectedSha256,
} from "../platform/fs.js";
import { canonicalizeAllowMissing, isReparseOrSymlink, startsWith } from "../platform/path.js";
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

export interface ApplyOptions {
  homeApproval?: boolean;
  /** Extra, explicitly approved Agent Home files for a caller with a narrower policy. */
  approvedHomeFiles?: string[];
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
  homeApprovalOrOptions: boolean | ApplyOptions = false,
): Promise<ApplyReport> {
  const options: ApplyOptions =
    typeof homeApprovalOrOptions === "boolean"
      ? { homeApproval: homeApprovalOrOptions }
      : homeApprovalOrOptions;
  const homeApproval = options.homeApproval === true;
  if (changeset.requires_home_approval && !homeApproval)
    throw backendError("PERMISSION", "Agent Home write is not authorized");
  const project = await canonicalizeAllowMissing(path.resolve(changeset.project_root)).catch(() => {
    throw backendError("VALIDATION", "ChangeSet project root is invalid");
  });
  const approvedHomeFiles = new Set(
    [
      path.join(homedir(), ".codex", "config.toml"),
      path.join(homedir(), ".claude.json"),
      path.join(homedir(), ".openclaw", "openclaw.json"),
      path.join(homedir(), ".hermes", "config.yaml"),
      ...(options.approvedHomeFiles ?? []),
    ].map((value) => path.resolve(value)),
  );
  // Rust performs the complete preflight before creating backups or writing any file.
  // Keep this separate from the write loop so a later invalid target cannot leave a
  // partially-applied ChangeSet.
  const prepared = [] as Array<{
    change: FileChange;
    target: string;
    reportedTarget: string;
    currentHash?: string;
    existed: boolean;
  }>;
  for (const change of changeset.changes) {
    if (change.scope !== "project" && change.scope !== "agent-home")
      throw backendError("VALIDATION", `Unknown ChangeSet scope: ${String(change.scope)}`);
    const requestedTarget = path.resolve(change.target);
    if (await isReparseOrSymlink(requestedTarget).catch(() => false))
      throw backendError("PERMISSION", "Refusing to write through a symlink or reparse point");
    const target = await canonicalizeAllowMissing(requestedTarget).catch(() => {
      throw backendError("VALIDATION", `Invalid ChangeSet target: ${change.target}`);
    });
    if (change.scope === "project" && !startsWith(target, project))
      throw backendError("PERMISSION", "Refusing to write outside the project");
    if (change.scope === "agent-home") {
      const approved = [...approvedHomeFiles].some((value) => path.resolve(value) === target);
      if (!approved)
        throw backendError("PERMISSION", `Agent Home target is not approved: ${target}`);
    }
    await assertSafeFilePath(target);
    let currentHash: string | undefined;
    let existed = false;
    try {
      const metadata = await lstat(target);
      if (!metadata.isFile())
        throw backendError("VALIDATION", `ChangeSet target is not a regular file: ${target}`);
      currentHash = hashContent(await readFile(target));
      existed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if ((change.original_hash ?? undefined) !== currentHash)
      throw backendError("CONFLICT", `File was modified externally: ${target}`);
    prepared.push({ change, target, reportedTarget: requestedTarget, currentHash, existed });
  }
  const backup = path.join(backupRoot, changeset.id);
  await mkdir(backup, { recursive: true });
  const applied: Array<{ target: string; backup: string; existed: boolean }> = [];
  try {
    for (let index = 0; index < prepared.length; index++) {
      const { change, target, reportedTarget, currentHash, existed } = prepared[index];
      if ((change.original_hash ?? undefined) !== currentHash)
        throw backendError("CONFLICT", `File was modified externally: ${target}`);
      const backupFile = path.join(backup, `${index}.bak`),
        expected = change.original_hash ? expectedSha256(change.original_hash) : expectedMissing;
      if (existed) await copyFile(target, backupFile);
      await atomicWriteChecked(
        target,
        change.after,
        expected,
      );
      await validateWritten(change.validator, change.after, target);
      applied.push({ target: reportedTarget, backup: backupFile, existed });
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

async function assertSafeFilePath(target: string): Promise<void> {
  let current = target;
  while (true) {
    try {
      if (await isReparseOrSymlink(current))
        throw backendError("PERMISSION", "Refusing to write through a symlink or reparse point");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function validateWritten(
  validator: FileChange["validator"],
  content: string,
  target: string,
): Promise<void> {
  try {
    switch (validator) {
      case "yaml":
        parseYaml(content);
        break;
      case "json":
        JSON.parse(content);
        break;
      case "toml":
        parseToml(content);
        break;
      case "markdown":
      case "text":
        break;
      default:
        throw new Error(`Unknown validator: ${String(validator)}`);
    }
  } catch (error) {
    throw backendError(
      "VALIDATION",
      `Post-write validation failed: ${target}${error instanceof Error ? `: ${error.message}` : ""}`,
    );
  }
}
