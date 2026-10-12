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
    ["filename only", "AGENTS.md", "AGENTS.md"],
    ["empty", "", ""],
  ] as const)("shortens %s paths without losing the final segments", (_kind, input, expected) => {
    expect(shortPath(input)).toBe(expected);
  });

  it.each([
    [String.raw`C:\Users\Example\project\AGENTS.md`, "AGENTS.md"],
    [String.raw`\\server\share\project\config.toml`, "config.toml"],
    ["/home/example/project/CLAUDE.md", "CLAUDE.md"],
    ["AGENTS.md", "AGENTS.md"],
    ["", ""],
  ] as const)("extracts a filename from %s", (input, expected) => {
    expect(fileName(input)).toBe(expected);
  });
});
