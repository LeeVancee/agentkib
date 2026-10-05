import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifiedCursorBridgeBundle } from "./cursor-bridge-bundle";

const directories: string[] = [];
async function fixture() {
  const directory = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "agentkib-cursor-bundle-")),
  );
  directories.push(directory);
  const bytes = Buffer.from("synthetic-vsix-for-integrity-test");
  const manifest = {
    id: "agentkib.cursor-bridge",
    version: "0.1.0",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  await Promise.all([
    writeFile(path.join(directory, "agentkib.cursor-bridge.vsix"), bytes),
    writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest)),
  ]);
  return { directory, manifest };
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
describe("bundled Cursor bridge", () => {
  it("returns only the verified fixed bundle path", async () => {
    const { directory, manifest } = await fixture();
    expect(await verifiedCursorBridgeBundle(directory)).toEqual({
      ...manifest,
      path: path.join(directory, "agentkib.cursor-bridge.vsix"),
    });
  });
  it("rejects changed VSIX bytes and unknown extension identity", async () => {
    const { directory, manifest } = await fixture();
    await writeFile(path.join(directory, "agentkib.cursor-bridge.vsix"), "tampered");
    await expect(verifiedCursorBridgeBundle(directory)).rejects.toThrow("verification failed");
    await writeFile(
      path.join(directory, "manifest.json"),
      JSON.stringify({ ...manifest, id: "untrusted.extension" }),
    );
    await expect(verifiedCursorBridgeBundle(directory)).rejects.toThrow("verification failed");
  });
  it.skipIf(process.platform === "win32")("rejects symlinked artifact and directory", async () => {
    const { directory } = await fixture();
    const bundle = path.join(directory, "agentkib.cursor-bridge.vsix");
    await rm(bundle);
    await symlink(path.join(directory, "manifest.json"), bundle);
    await expect(verifiedCursorBridgeBundle(directory)).rejects.toThrow("Invalid bundled");
    const alias = `${directory}-alias`;
    directories.push(alias);
    await symlink(directory, alias);
    await expect(verifiedCursorBridgeBundle(alias)).rejects.toThrow("Unsafe");
  });
});
