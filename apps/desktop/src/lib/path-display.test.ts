import { describe, expect, it } from "vitest";
import { fileName, shortPath } from "./path-display";

describe("path display", () => {
  it.each([
    ["long Windows", String.raw`C:\Users\Example\project\AGENTS.md`, "…/Example/project/AGENTS.md"],
    ["short Windows", String.raw`C:\repo\AGENTS.md`, String.raw`C:\repo\AGENTS.md`],
    ["UNC", String.raw`\\server\share\team\AGENTS.md`, "…/share/team/AGENTS.md"],
    ["Unix", "/home/example/project/AGENTS.md", "…/example/project/AGENTS.md"],
    ["short Unix", "/project/AGENTS.md", "/project/AGENTS.md"],
    ["mixed", String.raw`C:/Users\Example/project/AGENTS.md`, "…/Example/project/AGENTS.md"],
    [
      "POSIX literal backslash in filename",
      String.raw`/repo/.cursor/rules/team\policy.mdc`,
      String.raw`…/.cursor/rules/team\policy.mdc`,
    ],
    [
      "POSIX literal backslash in directory",
      String.raw`/repo/team\policy/rules/CLAUDE.md`,
      String.raw`…/team\policy/rules/CLAUDE.md`,
    ],
    [
      "POSIX relative filename with backslash",
      String.raw`rules/team\policy.mdc`,
      String.raw`rules/team\policy.mdc`,
    ],
    ["filename only", "AGENTS.md", "AGENTS.md"],
    ["empty", "", ""],
  ] as const)("shortens %s paths without losing the final segments", (_kind, input, expected) => {
    expect(shortPath(input)).toBe(expected);
  });

  it.each([
    [String.raw`C:\Users\Example\project\AGENTS.md`, "AGENTS.md"],
    [String.raw`\\server\share\project\config.toml`, "config.toml"],
    ["/home/example/project/CLAUDE.md", "CLAUDE.md"],
    [String.raw`/repo/.cursor/rules/team\policy.mdc`, String.raw`team\policy.mdc`],
    [String.raw`/repo/team\policy/rules/CLAUDE.md`, "CLAUDE.md"],
    [String.raw`rules/team\policy.mdc`, String.raw`team\policy.mdc`],
    ["AGENTS.md", "AGENTS.md"],
    ["", ""],
  ] as const)("extracts a filename from %s", (input, expected) => {
    expect(fileName(input)).toBe(expected);
  });
});
