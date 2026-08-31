import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { z } from "zod";
import { canonicalize, canonicalizeAllowMissing, startsWith } from "../platform/path.js";
import { backendError } from "../contracts.js";
export const ObsidianVault = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  source: z.enum(["discovered", "manual"]),
});
export const WorkspaceLink = z.object({
  workspace_id: z.string().min(1),
  vault_path: z.string().min(1),
  relative_path: z.string().min(1),
});
export type ObsidianVault = z.infer<typeof ObsidianVault>;
export type WorkspaceLink = z.infer<typeof WorkspaceLink>;
export const ObsidianStored = z.object({
  manual_vaults: z.array(z.string()).default([]),
  workspace_links: z.record(z.string(), WorkspaceLink).default({}),
});
export type ObsidianStored = z.infer<typeof ObsidianStored>;
export async function validateVaultPath(value: string): Promise<string> {
  const resolved = await canonicalize(value);
  const { stat } = await import("node:fs/promises");
  const info = await stat(resolved).catch(() => undefined);
  if (!info?.isDirectory()) throw backendError("VALIDATION", "The selected folder is not an Obsidian vault");
  const marker = await stat(path.join(resolved, ".obsidian")).catch(() => undefined);
  if (!marker?.isDirectory()) throw backendError("VALIDATION", "The selected folder is not an Obsidian vault");
  return resolved;
}
export async function loadStoredIntegration(file: string): Promise<ObsidianStored> {
  try {
    return ObsidianStored.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { manual_vaults: [], workspace_links: {} };
    throw backendError("VALIDATION", "Obsidian integration config is invalid");
  }
}
export async function saveStoredIntegration(file: string, value: ObsidianStored): Promise<void> {
  const parsed = ObsidianStored.parse(value);
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, JSON.stringify(parsed, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, file);
}
export async function createWorkspaceLink(
  workspacePath: string,
  vault: ObsidianVault,
  workspaceId: string,
  relativePath: string,
): Promise<WorkspaceLink> {
  const root = await validateVaultPath(vault.path);
  const target = await canonicalizeAllowMissing(path.resolve(root, relativePath));
  if (!startsWith(target, root))
    throw backendError("VALIDATION", "Obsidian link path escapes vault");
  const workspace = await canonicalize(workspacePath).catch(() => undefined);
  const { stat } = await import("node:fs/promises");
  if (!workspace || !(await stat(workspace).catch(() => undefined))?.isDirectory())
    throw backendError("VALIDATION", "The selected workspace is not a directory");
  return WorkspaceLink.parse({
    workspace_id: workspaceId,
    vault_path: root,
    relative_path: path.relative(root, target),
  });
}
export function planObsidianOpen(
  vault: ObsidianVault,
  relativePath?: string,
): { action: "open-vault" | "open-file"; path: string } {
  const root = path.resolve(vault.path);
  if (!relativePath) return { action: "open-vault", path: root };
  const target = path.resolve(root, relativePath);
  if (path.relative(root, target).startsWith(".."))
    throw backendError("VALIDATION", "Obsidian path escapes vault");
  return { action: "open-file", path: target };
}
