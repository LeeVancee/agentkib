// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { initializeI18n } from "@/core/i18n";
import { ShortcutHelpDialog } from "./ShortcutHelpDialog";

describe("ShortcutHelpDialog", () => {
  beforeAll(() => initializeI18n("en-US"));
  afterEach(cleanup);

  it("shows navigation and action shortcuts for the current platform", () => {
    document.documentElement.dataset.platform = "windows";
    render(<ShortcutHelpDialog open onOpenChange={() => undefined} />);

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Navigation")).toBeTruthy();
    expect(screen.getByText("Actions")).toBeTruthy();
    expect(screen.getByText("Today")).toBeTruthy();
    expect(screen.getByText("Ctrl+1")).toBeTruthy();
    expect(screen.getByText("Ctrl+Shift+O")).toBeTruthy();
    expect(screen.getByText("Toggle sidebar")).toBeTruthy();
  });
});
