// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { initializeI18n } from "@/core/i18n";
import { AppSidebar } from "./AppSidebar";
import { ShortcutHelpProvider } from "@/features/app/ShortcutHelpContext";

describe("AppSidebar v8 navigation", () => {
  beforeAll(() => initializeI18n("en-US"));
  afterEach(cleanup);

  it("keeps settings as the only persistent footer action", () => {
    render(
      <ShortcutHelpProvider openShortcutHelp={() => undefined}>
        <AppSidebar
          active="home"
          entries={[{ id: "home", label: "nav.home", icon: () => null, shortcut: "navigate-home" }]}
          onNavigate={() => undefined}
          onSettings={() => undefined}
          onBrandClick={() => undefined}
          collapsed={false}
          onCollapsedChange={() => undefined}
        />
      </ShortcutHelpProvider>,
    );

    expect(screen.queryByRole("button", { name: "Keyboard shortcuts" })).toBeNull();
    expect(screen.getByRole("button", { name: "Settings" }).getAttribute("aria-keyshortcuts")).toBe(
      "Control+,",
    );
    expect(screen.getByText("General, discovery, and integrations")).toBeTruthy();
  });

  it("keeps shortcut semantics without rendering inline shortcut hints", () => {
    const { container } = render(
      <ShortcutHelpProvider openShortcutHelp={() => undefined}>
        <AppSidebar
          active="home"
          entries={[{ id: "home", label: "nav.home", icon: () => null, shortcut: "navigate-home" }]}
          onNavigate={() => undefined}
          onSettings={() => undefined}
          onBrandClick={() => undefined}
          collapsed={false}
          onCollapsedChange={() => undefined}
        />
      </ShortcutHelpProvider>,
    );

    expect(container.querySelectorAll("kbd")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Today" }).getAttribute("aria-keyshortcuts")).toBe(
      "Control+1",
    );
    expect(screen.getByRole("button", { name: "Today" }).getAttribute("title")).toBe("Today");
  });
});
