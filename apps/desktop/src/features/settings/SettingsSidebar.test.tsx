// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { initializeI18n } from "@/core/i18n";
import { ShortcutHelpProvider } from "@/features/app/ShortcutHelpContext";
import { SettingsSidebar } from "./SettingsSidebar";

describe("SettingsSidebar shortcut hints", () => {
  beforeAll(() => initializeI18n("en-US"));
  afterEach(cleanup);

  it("does not render inline shortcut hints while keeping accessibility metadata", () => {
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
    expect(screen.getByRole("button", { name: "Keyboard shortcuts" }).getAttribute("aria-keyshortcuts")).toBe(
      "Control+/",
    );
    expect(container.querySelector('button[aria-label="Settings"]')?.getAttribute("title")).toBe(
      "Settings",
    );
  });
});
