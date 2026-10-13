import { afterEach, describe, expect, it } from "vitest";
import { supportsClaudeVersion as viaManagedRead } from "../../../packages/backend/src/claude-managed-read";
import {
  readClaudeVersion,
  supportsClaudeVersion,
} from "../../../packages/backend/src/claude-version";
import { contextFixture, type ContextFixture } from "./fixtures/claude-context";

const fixtures: ContextFixture[] = [];
afterEach(() => {
  for (const created of fixtures.splice(0)) created.dispose();
});
const posix = process.platform === "win32" ? describe.skip : describe;

describe("supportsClaudeVersion", () => {
  it("is still exported by the module that used to define it", () => {
    expect(viaManagedRead).toBe(supportsClaudeVersion);
  });

  it("applies the managed-session minimum by default", () => {
    expect(supportsClaudeVersion("2.1.263 (Claude Code)")).toBe(true);
    expect(supportsClaudeVersion("2.1.262 (Claude Code)")).toBe(false);
  });

  it("compares against an explicit minimum", () => {
    expect(supportsClaudeVersion("2.1.277 (Claude Code)", "2.1.277")).toBe(true);
    expect(supportsClaudeVersion("2.1.276 (Claude Code)", "2.1.277")).toBe(false);
    expect(supportsClaudeVersion("2.10.0 (Claude Code)", "2.9.99")).toBe(true);
  });

  it.each(["", "2.1.296", "Claude Code 2.1.296", "2.1 (Claude Code)", "2.1.296 (Other Tool)"])(
    "rejects the malformed value %j",
    (value) => {
      expect(supportsClaudeVersion(value, "0.0.0")).toBe(false);
    },
  );
});

posix("readClaudeVersion", () => {
  function setup() {
    const f = contextFixture();
    fixtures.push(f);
    return f;
  }

  it("returns the version line of an installed claude", async () => {
    const f = setup();
    f.claude("2.1.296 (Claude Code)");
    expect(await readClaudeVersion(f.commands, f.environment)).toBe("2.1.296 (Claude Code)");
  });

  it("does not apply a minimum version", async () => {
    const f = setup();
    f.claude("1.0.0 (Claude Code)");
    expect(await readClaudeVersion(f.commands, f.environment)).toBe("1.0.0 (Claude Code)");
  });

  it("returns null when claude cannot be found", async () => {
    const f = setup();
    expect(await readClaudeVersion(f.commands, f.environment)).toBeNull();
  });

  it.each([
    ["an unexpected format", "version two", 0],
    ["a missing suffix", "2.1.296", 0],
    ["a non-zero exit code", "2.1.296 (Claude Code)", 1],
    ["more output than the limit", "x".repeat(5000), 0],
  ])("returns null for %s", async (_name, output, exitCode) => {
    const f = setup();
    f.claude(output, { exitCode });
    expect(await readClaudeVersion(f.commands, f.environment)).toBeNull();
  });
});
