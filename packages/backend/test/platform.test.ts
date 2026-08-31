import { describe, expect, test } from "vitest";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { atomicWriteChecked, expectedSha256, movePath } from "../src/platform/fs.js";
import {
  canonicalizeAllowMissing,
  fileUriToPath,
  fileUriToPathForPlatform,
  identityForPlatform,
  isKnownAgentProbeWorkspace,
  isSafeScanEntry,
  startsWith,
} from "../src/platform/path.js";

async function directory() {
  return mkdtemp(path.join(tmpdir(), "agentkib-backend-"));
}

describe("backend platform interface", () => {
  test("canonicalizes missing components without trusting parent traversal", async () => {
    const root = await directory();
    const canonicalRoot = await canonicalizeAllowMissing(root);
    expect(await canonicalizeAllowMissing(path.join(root, "new", "file.txt"))).toBe(
      path.join(canonicalRoot, "new", "file.txt"),
    );
    await expect(canonicalizeAllowMissing(`${root}/new/../../outside/file.txt`)).rejects.toThrow(
      /parent/,
    );
  });

  test("uses component boundaries for containment and decodes file URIs", () => {
    expect(identityForPlatform(String.raw`\\?\C:\Dev\AgentKib`, true)).toBe(
      identityForPlatform("c:/dev/agentkib/", true),
    );
    expect(identityForPlatform(String.raw`\\?\UNC\server\Share\repo`, true)).toBe(
      identityForPlatform(String.raw`\\server\share\REPO`, true),
    );
    expect(startsWith("/tmp/app/src", "/tmp/app")).toBe(true);
    expect(startsWith("/tmp/application", "/tmp/app")).toBe(false);
    expect(fileUriToPath("file:///tmp/a%20b")).toBe("/tmp/a b");
    expect(fileUriToPath("https://example.com/a")).toBeUndefined();
    expect(fileUriToPathForPlatform("file:///C:/dev/Agent%20Kib", true)).toBe(
      String.raw`C:\dev\Agent Kib`,
    );
    expect(fileUriToPathForPlatform("file://server/share/repo", true)).toBe(
      String.raw`\\server\share\repo`,
    );
  });

  test("rejects symlink scan entries and recognizes probe workspaces", async () => {
    const root = await directory();
    await writeFile(path.join(root, "target"), "ok");
    await symlink(path.join(root, "target"), path.join(root, "link"));
    await writeFile(path.join(root, ".codexbar-session-id"), "probe");
    expect(await isSafeScanEntry(path.join(root, "target"))).toBe(true);
    expect(await isSafeScanEntry(path.join(root, "link"))).toBe(false);
    expect(await isKnownAgentProbeWorkspace(root)).toBe(true);
  });

  test("atomically writes with an expected hash and moves missing targets", async () => {
    const root = await directory();
    const target = path.join(root, "settings.json");
    await writeFile(target, "old");
    await atomicWriteChecked(
      target,
      "new",
      expectedSha256("cba06b5736faf67e54b07b561eae94395e774c517a7d910a54369e1263ccfbd4"),
    );
    expect(await readFile(target, "utf8")).toBe("new");
    await expect(atomicWriteChecked(target, "bad", expectedSha256("stale"))).rejects.toMatchObject({
      code: "ECONFLICT",
    });
    const source = path.join(root, "source"),
      moved = path.join(root, "moved");
    await writeFile(source, "value");
    await movePath(source, moved);
    expect(await readFile(moved, "utf8")).toBe("value");
  });
});
