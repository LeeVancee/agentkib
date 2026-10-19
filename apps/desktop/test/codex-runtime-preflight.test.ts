import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexRuntimePreflight,
  codexVersionSupportsWriterLock,
} from "../../../packages/backend/src/codex-runtime-preflight";
import { Commands } from "../../../packages/backend/src/commands";
import {
  acquirePortableFileLease,
  existingFileLeaseBusy,
} from "../../../packages/backend/src/managed-session-lock";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
describe("Codex writer preflight", () => {
  it.each([
    ["codex-cli 0.147.0", null],
    ["codex-cli 0.146.0", "codex-cli-version-too-old"],
    ["unrecognized version", "codex-cli-version-unavailable"],
  ])("runs a bounded version command and caches its result for %s", async (output, reason) => {
    const root = mkdtempSync(path.join(tmpdir(), "agentkib-version-check-"));
    roots.push(root);
    const executable = path.join(root, process.platform === "win32" ? "codex.exe" : "codex");
    writeFileSync(executable, "fixture");
    chmodSync(executable, 0o700);
    const run = vi.spyOn(Commands.prototype, "run").mockResolvedValue({
      bytes: Buffer.from(output),
      error: "",
      success: true,
      truncated: false,
      exitCode: 0,
    });
    const checker = new CodexRuntimePreflight({ PATH: root });
    try {
      expect(await checker.check()).toMatchObject({ executable, reason });
      expect(await checker.check()).toMatchObject({ executable, reason });
      expect(run).toHaveBeenCalledOnce();
      expect(run).toHaveBeenCalledWith(
        executable,
        ["--version"],
        expect.objectContaining({ timeout: 5000, limit: 512, strictOutput: true }),
      );
    } finally {
      checker.close();
    }
  });
  it.each([
    ["codex-cli 0.146.9", false],
    ["codex-cli 0.147.0-alpha.1", false],
    ["codex-cli 0.147.0", true],
    ["codex-cli 0.155.1", true],
    ["codex-cli 0.163.0-alpha.1", true],
    ["codex 0.147.0", true],
    ["0.155.1", false],
    ["codex-cli 0.155.1 unexpected", false],
  ])("checks %s against the first stable writer-lock release", (version, expected) => {
    expect(codexVersionSupportsWriterLock(version)).toBe(expected);
  });

  it("probes existing locks without changing contents, permissions or creating missing files", () => {
    const root = mkdtempSync(path.join(tmpdir(), "agentkib-writer-probe-"));
    roots.push(root);
    const directory = path.join(root, "thread-writer-locks");
    mkdirSync(directory);
    const lock = path.join(directory, "thread.lock");
    writeFileSync(lock, "owner metadata", { mode: 0o640 });
    const before = statSync(lock);
    expect(existingFileLeaseBusy(path.join(directory, "missing.lock"))).toBe(false);
    expect(existingFileLeaseBusy(lock)).toBe(false);
    const release = acquirePortableFileLease(lock);
    try {
      // The owner helper restricts its own file; the probe itself must leave that mode alone.
      const ownerMode = statSync(lock).mode;
      expect(existingFileLeaseBusy(lock)).toBe(true);
      expect(statSync(lock).mode).toBe(ownerMode);
      expect(readFileSync(lock, "utf8")).toBe("owner metadata");
    } finally {
      release();
    }
    expect(existingFileLeaseBusy(lock)).toBe(false);
    expect(statSync(lock).ino).toBe(before.ino);
  });
});
