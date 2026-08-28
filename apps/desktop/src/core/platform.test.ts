// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyPlatformAttribute,
  normalizePlatform,
  primaryShortcutModifier,
  usesSystemTrayWording,
} from "./platform";

describe("desktop platform marker", () => {
  beforeEach(() => {
    delete document.documentElement.dataset.platform;
  });

  it.each([
    ["windows", "windows"],
    ["darwin", "macos"],
    ["macos", "macos"],
    ["linux", "linux"],
    [undefined, "web"],
  ] as const)("normalizes %s to %s", (input, expected) => {
    expect(normalizePlatform(input)).toBe(expected);
  });

  it.each(["windows", "linux"])("marks the document root for %s-specific layout", (platform) => {
    applyPlatformAttribute(platform);

    expect(document.documentElement.dataset.platform).toBe(platform);
  });

  it("uses native shortcut and tray terminology by platform", () => {
    expect(primaryShortcutModifier("darwin")).toBe("Command");
    expect(primaryShortcutModifier("linux")).toBe("Ctrl");
    expect(primaryShortcutModifier("windows")).toBe("Ctrl");
    expect(usesSystemTrayWording("linux")).toBe(true);
    expect(usesSystemTrayWording("darwin")).toBe(false);
  });
});
