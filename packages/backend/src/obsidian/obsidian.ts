import path from "node:path";
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
export async function validateVaultPath(value: string): Promise<string> {
  const resolved = await canonicalize(value);
  return resolved;
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
  await validateVaultPath(workspacePath);
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
