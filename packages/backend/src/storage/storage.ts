import { readdir, lstat } from "node:fs/promises";
import path from "node:path";
import { isSafeScanEntry } from "../platform/path.js";
import type { StorageNode, StorageWorkspace, WorkspaceStorage, StorageBreakdown } from "./types.js";
type Totals = {
  allocated: number;
  logical: number;
  regenerable: number;
  agent: number;
  files: number;
  dirs: number;
};
export async function scanStorage(
  workspace: StorageWorkspace,
  excludedRoots: string[] = [],
  signal?: AbortSignal,
): Promise<WorkspaceStorage> {
  const attempted = new Date().toISOString(),
    seen = new Set<string>(),
    errors: string[] = [];
  let cancelled = false;
  const excluded = new Set(excludedRoots.map((root) => path.resolve(root)));
  const result = await walk(workspace.path, "", 0);
  const quality =
    cancelled || errors.length
      ? result.files || result.dirs
        ? "partial"
        : "unavailable"
      : "complete";
  const success = quality !== "unavailable" && !cancelled ? new Date().toISOString() : undefined;
  const root = result.node;
  const breakdown: StorageBreakdown[] = root.children
    .filter((child) => child.kind === "directory")
    .map((child) => ({
      name: child.name,
      relative_path: child.relative_path,
      kind: "directory",
      allocated_bytes: child.allocated_bytes,
      logical_bytes: child.logical_bytes,
      regenerable_bytes: child.regenerable_bytes,
      agent_asset_bytes: child.agent_asset_bytes,
    }));
  const files = root.children.filter((child) => child.kind === "root-files");
  if (files.length)
    breakdown.push({
      name: "Root files",
      relative_path: "",
      kind: "root-files",
      allocated_bytes: files.reduce((n, c) => n + c.allocated_bytes, 0),
      logical_bytes: files.reduce((n, c) => n + c.logical_bytes, 0),
      regenerable_bytes: files.reduce((n, c) => n + c.regenerable_bytes, 0),
      agent_asset_bytes: files.reduce((n, c) => n + c.agent_asset_bytes, 0),
    });
  return {
    workspace_id: workspace.id,
    name: workspace.name,
    path: workspace.path,
    snapshot_version: 2,
    root: quality === "unavailable" ? undefined : root,
    measurement: process.platform === "win32" ? "logical-estimate" : "allocated-exact",
    quality,
    allocated_bytes: result.allocated,
    logical_bytes: result.logical,
    regenerable_bytes: result.regenerable,
    agent_asset_bytes: result.agent,
    file_count: result.files,
    directory_count: result.dirs,
    breakdown,
    last_attempt_at: attempted,
    last_success_at: success,
    error_key: cancelled
      ? "storage.scanStopped"
      : quality === "unavailable"
        ? "storage.scanUnavailable"
        : errors.length
          ? "storage.scanPartial"
          : undefined,
    error_detail: errors.slice(0, 3).join("\n") || undefined,
  };
  async function walk(
    directory: string,
    relative: string,
    depth: number,
  ): Promise<Totals & { node: StorageNode }> {
    const totals: Totals = {
      allocated: 0,
      logical: 0,
      regenerable: 0,
      agent: 0,
      files: 0,
      dirs: 1,
    };
    const children: StorageNode[] = [];
    if (signal?.aborted) {
      cancelled = true;
      return { ...totals, node: node(directory, relative, children, totals, true) };
    }
    if (excluded.has(path.resolve(directory)))
      return {
        allocated: 0,
        logical: 0,
        regenerable: 0,
        agent: 0,
        files: 0,
        dirs: 0,
        node: node(directory, relative, children, totals, false),
      };
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      errors.push(`Could not scan ${directory}`);
      return { ...totals, node: node(directory, relative, children, totals, true) };
    }
    for (const entry of entries) {
      if (signal?.aborted) {
        cancelled = true;
        break;
      }
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "target")
        continue;
      const full = path.join(directory, entry.name);
      if (!(await isSafeScanEntry(full))) continue;
      try {
        const metadata = await lstat(full);
        if (metadata.isDirectory() && depth < 32) {
          const child = await walk(full, path.join(relative, entry.name), depth + 1);
          Object.assign(totals, {
            allocated: totals.allocated + child.allocated,
            logical: totals.logical + child.logical,
            regenerable: totals.regenerable + child.regenerable,
            agent: totals.agent + child.agent,
            files: totals.files + child.files,
            dirs: totals.dirs + child.dirs,
          });
          children.push(child.node);
        } else if (metadata.isFile()) {
          const logical = Number(metadata.size);
          const allocated =
            Number(
              (metadata as unknown as { blocks?: bigint }).blocks ??
                BigInt(Math.ceil(logical / 512)),
            ) * 512;
          const key = `${metadata.dev ?? 0}:${metadata.ino ?? full}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const regenerable = /(^|[\\/])(node_modules|target|dist|build|\.cache)([\\/]|$)/.test(
            full,
          )
            ? logical
            : 0;
          const agent =
            /(^|[\\/])(AGENTS|CLAUDE|\.codex|\.claude|\.cursor|\.openclaw|\.hermes|\.dsh)([\\/]|$)/i.test(
              full,
            )
              ? logical
              : 0;
          totals.allocated += allocated;
          totals.logical += logical;
          totals.regenerable += regenerable;
          totals.agent += agent;
          totals.files++;
          children.push({
            id: full,
            name: entry.name,
            relative_path: path.join(relative, entry.name),
            kind: "root-files",
            allocated_bytes: allocated,
            logical_bytes: logical,
            regenerable_bytes: regenerable,
            agent_asset_bytes: agent,
            file_count: 1,
            directory_count: 0,
            child_count: 0,
            children: [],
            expandable: false,
            partial: false,
          });
        }
      } catch {
        errors.push(`Could not inspect ${full}`);
      }
    }
    return {
      ...totals,
      node: node(directory, relative, children, totals, cancelled || errors.length > 0),
    };
  }
}
function node(
  directory: string,
  relative: string,
  children: StorageNode[],
  totals: Totals,
  partial: boolean,
): StorageNode {
  return {
    id: directory,
    name: path.basename(directory) || directory,
    relative_path: relative,
    kind: relative ? "directory" : "workspace",
    allocated_bytes: totals.allocated,
    logical_bytes: totals.logical,
    regenerable_bytes: totals.regenerable,
    agent_asset_bytes: totals.agent,
    file_count: totals.files,
    directory_count: totals.dirs,
    child_count: children.length,
    children: children.sort((a, b) => b.logical_bytes - a.logical_bytes),
    expandable: children.length > 0,
    partial,
  };
}
