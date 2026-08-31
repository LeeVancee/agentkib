// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentAppPlatform } from "@/core/keyboard-shortcuts";
import { useAppShortcuts, type AppShortcutActions } from "./useAppShortcuts";

function ShortcutHarness(actions: AppShortcutActions) {
  useAppShortcuts(actions);
  return <input aria-label="Editor" />;
}

function createActions(overrides: Partial<AppShortcutActions> = {}): AppShortcutActions {
  return {
    onNavigate: vi.fn(),
    onOpenSettings: vi.fn(),
    onRefreshCurrent: vi.fn().mockResolvedValue(undefined),
    onAddWorkspace: vi.fn().mockResolvedValue(undefined),
    onAddScanRoot: vi.fn().mockResolvedValue(undefined),
    onToggleSidebar: vi.fn(),
    onGoBack: vi.fn(),
    onGoForward: vi.fn(),
    onOpenSearch: vi.fn(),
    onOpenHelp: vi.fn(),
    helpOpen: false,
    ...overrides,
  };
}

describe("useAppShortcuts", () => {
  beforeEach(() => {
    document.documentElement.dataset.platform = "windows";
  });

  afterEach(cleanup);

  it("routes navigation, refresh, sidebar, search, and help shortcuts", () => {
    const actions = createActions();
    render(<ShortcutHarness {...actions} />);

    fireEvent.keyDown(window, { key: "1", ctrlKey: true });
    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.keyDown(window, { key: "/", ctrlKey: true });
    fireEvent.keyDown(window, { key: "ArrowLeft", altKey: true });
    fireEvent.keyDown(window, { key: "ArrowRight", altKey: true });

    expect(actions.onNavigate).toHaveBeenCalledWith("home");
    expect(actions.onRefreshCurrent).toHaveBeenCalledOnce();
    expect(actions.onToggleSidebar).toHaveBeenCalledOnce();
    expect(actions.onOpenSearch).toHaveBeenCalledOnce();
    expect(actions.onOpenHelp).toHaveBeenCalledOnce();
    expect(actions.onGoBack).toHaveBeenCalledOnce();
    expect(actions.onGoForward).toHaveBeenCalledOnce();
  });

  it("routes settings and file action shortcuts", () => {
    const actions = createActions();
    render(<ShortcutHarness {...actions} />);

    fireEvent.keyDown(window, { key: ",", ctrlKey: true });
    fireEvent.keyDown(window, { key: "o", ctrlKey: true });
    fireEvent.keyDown(window, { key: "o", ctrlKey: true, shiftKey: true });

    expect(actions.onOpenSettings).toHaveBeenCalledOnce();
    expect(actions.onAddWorkspace).toHaveBeenCalledOnce();
    expect(actions.onAddScanRoot).toHaveBeenCalledOnce();
  });

  it("does not hijack editable fields, composition, or repeated keys", () => {
    const actions = createActions();
    const { getByRole } = render(<ShortcutHarness {...actions} />);
    const editor = getByRole("textbox");

    fireEvent.keyDown(editor, { key: "1", ctrlKey: true });
    fireEvent.keyDown(window, { key: "2", ctrlKey: true, isComposing: true });
    fireEvent.keyDown(window, { key: "3", ctrlKey: true, repeat: true });

    expect(actions.onNavigate).not.toHaveBeenCalled();
  });

  it("does not navigate while the help dialog is open", () => {
    const actions = createActions({ helpOpen: true });
    render(<ShortcutHarness {...actions} />);

    fireEvent.keyDown(window, { key: "1", ctrlKey: true });

    expect(actions.onNavigate).not.toHaveBeenCalled();
  });

  it("handles new shortcuts on macOS while leaving native menu shortcuts alone", () => {
    document.documentElement.dataset.platform = "macos";
    expect(currentAppPlatform()).toBe("macos");
    const actions = createActions();
    render(<ShortcutHarness {...actions} />);

    fireEvent.keyDown(window, { key: "1", metaKey: true });
    fireEvent.keyDown(window, { key: "b", metaKey: true });
    fireEvent.keyDown(window, { key: "/", metaKey: true });
    fireEvent.keyDown(window, { key: "[", metaKey: true });
    fireEvent.keyDown(window, { key: "]", metaKey: true });

    expect(actions.onNavigate).not.toHaveBeenCalled();
    expect(actions.onToggleSidebar).toHaveBeenCalledOnce();
    expect(actions.onOpenHelp).toHaveBeenCalledOnce();
    expect(actions.onGoBack).toHaveBeenCalledOnce();
    expect(actions.onGoForward).toHaveBeenCalledOnce();
  });
});
