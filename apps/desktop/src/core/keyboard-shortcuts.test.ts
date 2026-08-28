// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  ariaShortcut,
  formatShortcut,
  getShortcutDefinition,
  isEditableTarget,
  matchesShortcut,
  shouldHandleInFrontend,
} from "./keyboard-shortcuts";

describe("keyboard shortcuts", () => {
  beforeEach(() => {
    document.documentElement.dataset.platform = "";
  });

  it("matches the primary modifier for each platform", () => {
    const home = getShortcutDefinition("navigate-home");

    expect(matchesShortcut({ key: "1", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }, home, "windows")).toBe(true);
    expect(matchesShortcut({ key: "1", ctrlKey: false, metaKey: true, altKey: false, shiftKey: false }, home, "macos")).toBe(true);
    expect(matchesShortcut({ key: "1", ctrlKey: true, metaKey: true, altKey: false, shiftKey: false }, home, "macos")).toBe(false);
    expect(matchesShortcut({ key: "1", ctrlKey: true, metaKey: false, altKey: true, shiftKey: false }, home, "windows")).toBe(false);
  });

  it("matches shifted shortcuts without accepting the unshifted key", () => {
    const addScanRoot = getShortcutDefinition("add-scan-root");

    expect(matchesShortcut({ key: "o", ctrlKey: true, metaKey: false, altKey: false, shiftKey: true }, addScanRoot, "windows")).toBe(true);
    expect(matchesShortcut({ key: "o", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }, addScanRoot, "windows")).toBe(false);
  });

  it("identifies editable targets", () => {
    expect(isEditableTarget(document.createElement("input"))).toBe(true);
    expect(isEditableTarget(document.createElement("textarea"))).toBe(true);
    expect(isEditableTarget(document.createElement("select"))).toBe(true);

    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    const child = document.createElement("span");
    editor.append(child);
    expect(isEditableTarget(editor)).toBe(true);
    expect(isEditableTarget(child)).toBe(true);
    expect(isEditableTarget(document.createElement("main"))).toBe(false);
  });

  it("formats shortcuts for the platform and accessibility tree", () => {
    const addScanRoot = getShortcutDefinition("add-scan-root");

    expect(formatShortcut(addScanRoot, "windows")).toBe("Ctrl+Shift+O");
    expect(formatShortcut(addScanRoot, "macos")).toBe("⌘Shift+O");
    expect(ariaShortcut(addScanRoot, "windows")).toBe("Control+Shift+O");
    expect(ariaShortcut(addScanRoot, "macos")).toBe("Meta+Shift+O");
  });

  it("leaves existing macOS menu accelerators to the native menu", () => {
    expect(shouldHandleInFrontend(getShortcutDefinition("navigate-home"), "macos")).toBe(false);
    expect(shouldHandleInFrontend(getShortcutDefinition("refresh-current"), "macos")).toBe(false);
    expect(shouldHandleInFrontend(getShortcutDefinition("toggle-sidebar"), "macos")).toBe(true);
    expect(shouldHandleInFrontend(getShortcutDefinition("open-help"), "macos")).toBe(true);
  });
});
