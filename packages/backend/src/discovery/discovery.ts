import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import {
  canonicalize,
  identity,
  isKnownAgentProbeWorkspace,
  isSafeScanEntry,
} from "../platform/path.js";
import { backendError } from "../contracts.js";
import type { DiscoveryCandidate, DiscoverySnapshot } from "../domain/types.js";

const ignored = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
  ".cache",
  ".next",
  ".turbo",
  ".venv",
  "venv",
  "vendor",
  "coverage",
  "Pods",
  "DerivedData",
  "Library",
]);
const markers = [
  ".agentkib",
  ".git",
  "AGENTS.md",
  "CLAUDE.md",
  ".codex",
  ".claude",
  ".cursor",
  ".openclaw",
  ".hermes",
  ".dsh",
];
export interface ScanRoot {
  path: string;
  max_depth?: number;
}

/** Discover project roots from explicit scan roots, preserving safety boundaries. */
export async function discover(scanRoots: ScanRoot[]): Promise<DiscoverySnapshot> {
  const candidates: DiscoveryCandidate[] = [],
    errors: string[] = [];
  for (const scanRoot of scanRoots) {
    try {
      if (!(await isSafeScanEntry(scanRoot.path)))
        throw backendError("VALIDATION", "scan root must not be a symbolic link or reparse point");
      const root = await canonicalize(scanRoot.path);
      if (!(await lstat(root)).isDirectory())
        throw backendError("VALIDATION", "scan root must be a directory");
      await walk(root, Math.min(Math.max(scanRoot.max_depth ?? 5, 1), 8), candidates, errors, 0);
    } catch (error) {
      errors.push(`Scan root ${scanRoot.path} failed: ${(error as Error).message}`);
    }
  }
  const grouped = new Map<string, DiscoveryCandidate>();
  for (const candidate of candidates) {
    const key = identity(candidate.path);
    if (!grouped.has(key)) grouped.set(key, candidate);
  }
  return { candidates: [...grouped.values()].sort((a, b) => a.path.localeCompare(b.path)), errors };
}
async function walk(
  directory: string,
  maxDepth: number,
  output: DiscoveryCandidate[],
  errors: string[],
  depth: number,
): Promise<void> {
  if (depth > maxDepth || !(await isSafeScanEntry(directory))) return;
  if (depth > 0 && (await isKnownAgentProbeWorkspace(directory))) return;
  if (depth > 0 && (await hasMarker(directory)))
    output.push({ path: directory, evidence: "scan-marker", session_count: 0 });
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    errors.push(`Could not read ${directory}`);
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || ignored.has(entry.name)) continue;
    const child = path.join(directory, entry.name);
    if (await isSafeScanEntry(child)) await walk(child, maxDepth, output, errors, depth + 1);
  }
}
async function hasMarker(directory: string): Promise<boolean> {
  for (const marker of markers) {
    try {
      const markerPath = path.join(directory, marker);
      if (!(await isSafeScanEntry(markerPath))) continue;
      const metadata = await lstat(markerPath);
      if (metadata.isDirectory() || metadata.isFile()) return true;
    } catch {
      /* absent */
    }
  }
  return false;
}
