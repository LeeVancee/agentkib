import { lstat, realpath } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function canonicalize(value: string): Promise<string> {
  return realpath(value);
}

/** Resolve an existing prefix, appending only normal missing components. */
export async function canonicalizeAllowMissing(value: string): Promise<string> {
  const parsed = path.parse(value);
  const parts = value
    .slice(parsed.root.length)
    .split(/[\\/]+/)
    .filter(Boolean);
  if (parts.includes("..")) throw new TypeError("path must not contain parent components");
  let current = value;
  const suffix: string[] = [];
  while (true) {
    try {
      current = await realpath(current);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current)
        throw new TypeError("missing path suffix must contain only normal components");
      suffix.push(path.basename(current));
      current = parent;
    }
  }
  return path.join(current, ...suffix.reverse());
}

export function identity(value: string): string {
  try {
    return identityForPlatform(realpathSync.native(value), process.platform === "win32");
  } catch {
    return identityForPlatform(path.resolve(value), process.platform === "win32");
  }
}
/** Pure normalization helper used by cross-platform callers and parity tests. */
export function identityForPlatform(value: string, windows: boolean): string {
  let normalized = value;
  if (windows) {
    normalized = normalized.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/i, "");
    normalized = normalized.replaceAll("/", "\\").toLowerCase();
  }
  return trimSeparators(normalized);
}
export function equivalent(left: string, right: string): boolean {
  return identity(left) === identity(right);
}
export function startsWith(value: string, base: string): boolean {
  const child = identity(value),
    root = identity(base);
  return child === root || child.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}
function trimSeparators(value: string): string {
  return value.length > 1 ? value.replace(/[\\/]$/, "") : value;
}

export function fileUriToPath(value: string): string | undefined {
  return fileUriToPathForPlatform(value, process.platform === "win32");
}
export function fileUriToPathForPlatform(value: string, windows: boolean): string | undefined {
  if (!value.startsWith("file://")) return undefined;
  try {
    const decoded = decodeURIComponent(value.slice("file://".length));
    if (!windows) return fileURLToPath(new URL(value));
    let normalized = decoded.replaceAll("/", "\\");
    if (/^\\\\localhost\\/i.test(normalized)) normalized = normalized.slice("\\localhost".length);
    if (/^\\[A-Za-z]:/.test(normalized)) return normalized.slice(1);
    if (/^[A-Za-z]:/.test(normalized) || normalized.startsWith("\\\\")) return normalized;
    return `\\\\${normalized}`;
  } catch {
    return undefined;
  }
}

export async function isReparseOrSymlink(value: string): Promise<boolean> {
  const metadata = await lstat(value);
  // lstat reports symlinks on every platform. Windows reparse points that are
  // not symlinks are intentionally handled by the OS realpath check at use sites.
  return metadata.isSymbolicLink();
}
export async function isSafeScanEntry(value: string): Promise<boolean> {
  try {
    return !(await isReparseOrSymlink(value));
  } catch {
    return false;
  }
}
export async function isKnownAgentProbeWorkspace(value: string): Promise<boolean> {
  try {
    return await lstat(path.join(value, ".codexbar-session-id")).then((m) => m.isFile());
  } catch {
    return false;
  }
}
