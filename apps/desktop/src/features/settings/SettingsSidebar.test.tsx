// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "@/core/i18n";
import { ShortcutHelpProvider } from "@/features/app/ShortcutHelpContext";
import { SettingsSidebar } from "./SettingsSidebar";

describe("SettingsSidebar v8 navigation", () => {
  beforeAll(() => initializeI18n("en-US"));
  afterEach(cleanup);

  it("shows only the back entry and six settings sections", () => {
    const { container } = render(
      <ShortcutHelpProvider openShortcutHelp={() => undefined}>
        <SettingsSidebar
          active="general"
          onSelect={() => undefined}
          onBack={() => undefined}
          onSettings={() => undefined}
          collapsed={false}
          onCollapsedChange={() => undefined}
        />
      </ShortcutHelpProvider>,
    );

    expect(container.querySelectorAll("kbd")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Keyboard shortcuts" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Tools & updates" })).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: "Search settings…" })).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(8);
  });

  it("searches settings content and selects the matching target", () => {
    const onSelect = vi.fn();
    render(
      <ShortcutHelpProvider openShortcutHelp={() => undefined}>
        <SettingsSidebar
          active="general"
          onSelect={onSelect}
          onBack={() => undefined}
          collapsed={false}
        />
      </ShortcutHelpProvider>,
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "Search settings…" }), {
      target: { value: "Vault" },
    });

    expect(screen.queryByRole("button", { name: "General" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Obsidian" }));
    expect(onSelect).toHaveBeenCalledWith("integrations", "integrations-obsidian");
  });

  it("shows an empty state and clears the search", () => {
    render(
      <ShortcutHelpProvider openShortcutHelp={() => undefined}>
        <SettingsSidebar
          active="general"
          onSelect={() => undefined}
          onBack={() => undefined}
          collapsed={false}
        />
      </ShortcutHelpProvider>,
    );

    const search = screen.getByRole("searchbox", { name: "Search settings…" });
    fireEvent.change(search, { target: { value: "not-a-setting" } });
    expect(screen.getByText("No matching settings")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear settings search" }));
    expect(screen.getByRole("button", { name: "General" })).toBeTruthy();
  });
});
