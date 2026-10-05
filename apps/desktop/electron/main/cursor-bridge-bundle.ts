import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { CursorBridgeBundle } from "../../src/core/types";

export const CURSOR_BRIDGE_ID = "agentkib.cursor-bridge";
export const CURSOR_BRIDGE_VERSION = "0.1.0";

/** Only the shipped artifact is exposed; a renderer cannot supply a path. */
export async function verifiedCursorBridgeBundle(directory: string): Promise<CursorBridgeBundle> {
  if (!path.isAbsolute(directory) || (await realpath(directory)) !== path.resolve(directory))
    throw new Error("Unsafe Cursor bridge bundle directory");
  const manifestPath = path.join(directory, "manifest.json");
  const bundlePath = path.join(directory, "agentkib.cursor-bridge.vsix");
  const [manifestStat, bundleStat] = await Promise.all([lstat(manifestPath), lstat(bundlePath)]);
  if (
    !manifestStat.isFile() ||
    manifestStat.size > 4096 ||
    !bundleStat.isFile() ||
    bundleStat.size > 16 * 1024 * 1024
  ) {
    throw new Error("Invalid bundled Cursor bridge artifact");
  }
  const [manifestBytes, bundle] = await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(bundlePath),
  ]);
  if (Buffer.byteLength(manifestBytes) > 4096 || bundle.length > 16 * 1024 * 1024)
    throw new Error("Cursor bridge bundle exceeds size limit");
  const manifest: unknown = JSON.parse(manifestBytes);
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("id" in manifest) ||
    manifest.id !== CURSOR_BRIDGE_ID ||
    !("version" in manifest) ||
    manifest.version !== CURSOR_BRIDGE_VERSION ||
    !("sha256" in manifest) ||
    typeof manifest.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(manifest.sha256) ||
    createHash("sha256").update(bundle).digest("hex") !== manifest.sha256
  ) {
    throw new Error("Cursor bridge bundle verification failed");
  }
  return {
    id: CURSOR_BRIDGE_ID,
    version: CURSOR_BRIDGE_VERSION,
    sha256: manifest.sha256,
    path: bundlePath,
  };
}
