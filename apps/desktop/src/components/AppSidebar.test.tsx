// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { changeLocale, initializeI18n, tr } from "@/core/i18n";
import { AppSidebar } from "./AppSidebar";
import { ShortcutHelpProvider } from "@/features/app/ShortcutHelpContext";
import { createGlobalNavigation } from "@/features/app/global-navigation";
import { useAppStore } from "@/stores/app-store";

vi.mock("@/features/sessions/SessionDirectory", () => ({
  SessionDirectory: ({ onMenuOpenChange }: { onMenuOpenChange?: (open: boolean) => void }) => (
    <>
      <button data-session-entry>Example session</button>
      <button onClick={() => onMenuOpenChange?.(true)}>Open directory menu</button>
      <button onClick={() => onMenuOpenChange?.(false)}>Close directory menu</button>
    </>
  ),
}));

describe("AppSidebar v8 navigation", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => useAppStore.getState().reset());
  afterEach(cleanup);

  it.each([
    ["zh-CN", "设置", "远程连接"],
    ["zh-TW", "設定", "遠端連線"],
    ["ja-JP", "設定", "リモート接続"],
    ["en-US", "Settings", "Remote connections"],
  ] as const)(
    "updates activity bar labels in %s without parent rerender",
    async (locale, settings, remote) => {
      render(
        <AppSidebar
          active="home"
          entries={createGlobalNavigation(0)}
          onNavigate={vi.fn()}
          onSettings={vi.fn()}
          collapsed={false}
        />,
      );
      const original = screen.getByRole("button", { name: "Settings" });
      try {
        await act(() => changeLocale(locale));
        expect(screen.getByRole("button", { name: settings })).toBe(original);
        expect(screen.getByRole("button", { name: remote })).toBeTruthy();
      } finally {
        await act(() => changeLocale("en-US"));
      }
    },
  );

  it("closes the navigation drawer when global search opens, including shortcut activation", () => {
    const onOpenSearch = vi.fn();
    const props = {
      active: "home" as const,
      entries: createGlobalNavigation(0),
      onNavigate: vi.fn(),
      onSettings: vi.fn(),
      onOpenSearch,
      collapsed: false,
    };
    const { container, rerender } = render(<AppSidebar {...props} searchOpen={false} />);
    fireEvent.click(screen.getByRole("button", { name: tr("common.primaryNavigation") }));
    expect(container.querySelector(".app-sidebar-open")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: tr("search.open") }));
    expect(onOpenSearch).toHaveBeenCalledOnce();
    rerender(<AppSidebar {...props} searchOpen />);
    expect(container.querySelector(".app-sidebar-open")).toBeNull();
    rerender(<AppSidebar {...props} searchOpen={false} />);
    fireEvent.click(screen.getByRole("button", { name: tr("common.primaryNavigation") }));
    expect(container.querySelector(".app-sidebar-open")).toBeTruthy();
    // A keyboard shortcut changes parent state without clicking the sidebar search button.
    rerender(<AppSidebar {...props} searchOpen />);
    expect(container.querySelector(".app-sidebar-open")).toBeNull();
    expect(onOpenSearch).toHaveBeenCalledOnce();
  });

  it("keeps the activity bar accessible while the context panel is collapsed", async () => {
    const onNavigate = vi.fn();
    const { container } = render(
      <AppSidebar
        active="sessions"
        entries={createGlobalNavigation(0)}
        onNavigate={onNavigate}
        onSettings={vi.fn()}
        collapsed
        context={{ kind: "sessions" }}
      />,
    );
    expect(container.querySelector(".app-context-sidebar")?.hasAttribute("inert")).toBe(true);
    await userEvent.setup().click(screen.getByRole("button", { name: tr("nav.agents") }));
    expect(onNavigate).toHaveBeenCalledWith("agents");
    expect(useAppStore.getState().sidebarCollapsed).toBe(false);
  });

  it("opens global search beside the non-clickable brand", async () => {
    const onOpenSearch = vi.fn();
    const { container } = render(
      <AppSidebar
        active="home"
        entries={createGlobalNavigation(0)}
        onNavigate={() => undefined}
        onSettings={() => undefined}
        onOpenSearch={onOpenSearch}
        collapsed={false}
      />,
    );
    const header = container.querySelector(".app-activity-bar")!;
    const search = within(header as HTMLElement).getByRole("button", { name: tr("search.open") });
    expect(search.getAttribute("aria-keyshortcuts")).toBe("Control+K");
    expect(header.querySelector(".activity-bar-brand")?.closest("button, a")).toBeNull();
    await userEvent.setup().click(search);
    expect(onOpenSearch).toHaveBeenCalledOnce();
  });

  it("exposes settings and remote connection actions directly in the activity bar", async () => {
    const onSettings = vi.fn();
    render(
      <AppSidebar
        active="home"
        entries={createGlobalNavigation(0)}
        onNavigate={vi.fn()}
        onSettings={onSettings}
        collapsed={false}
      />,
    );
    expect(screen.queryByRole("button", { name: tr("sessions.more") })).toBeNull();
    const settings = screen.getByRole("button", { name: tr("nav.settings") });
    expect(settings.getAttribute("aria-keyshortcuts")).toBe("Control+,");
    expect(
      screen.getByRole("button", { name: tr("sessions.remote") }).hasAttribute("disabled"),
    ).toBe(false);
    await userEvent.setup().click(settings);
    expect(onSettings).toHaveBeenCalledOnce();
  });

  it("adds sessions after Agents in the same sidebar and preserves the tool navigation", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const { container, rerender } = render(
      <AppSidebar
        active="sessions"
        entries={createGlobalNavigation(0)}
        onNavigate={onNavigate}
        onSettings={() => undefined}
        collapsed={false}
        context={{ kind: "sessions" }}
      />,
    );
    const sidebar = container.querySelector(".app-sidebar")!;
    expect(sidebar.classList.contains("app-sidebar-sessions")).toBe(true);
    const primary = sidebar.querySelector(".activity-bar-navigation")!;
    const names = within(primary as HTMLElement)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"));
    expect(names.indexOf(tr("sessions.nav"))).toBe(names.indexOf(tr("nav.agents")) + 1);
    const sessions = screen.getByRole("button", { name: tr("sessions.nav") });
    expect(sessions.getAttribute("aria-current")).toBe("page");
    expect(sessions.hasAttribute("aria-keyshortcuts")).toBe(false);
    expect(within(sidebar as HTMLElement).getByText("Example session")).toBeTruthy();
    expect(screen.getByRole("button", { name: tr("nav.catalog") })).toBeTruthy();
    expect(screen.getByRole("button", { name: tr("nav.quota") })).toBeTruthy();
    expect(screen.getByRole("button", { name: tr("nav.insights") })).toBeTruthy();
    await user.click(sessions);
    expect(onNavigate).toHaveBeenCalledWith("sessions");
    rerender(
      <AppSidebar
        active="agents"
        entries={createGlobalNavigation(0)}
        onNavigate={onNavigate}
        onSettings={() => undefined}
        collapsed={false}
        context={{ kind: "agents", filter: "all", onFilterChange: () => undefined }}
      />,
    );
    expect(container.querySelector(".app-sidebar-sessions")).toBeNull();
    expect(screen.queryByText("Example session")).toBeNull();
  });

  it("closes the narrow-window navigation drawer after selecting a session", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <AppSidebar
        active="sessions"
        entries={createGlobalNavigation(0)}
        onNavigate={() => undefined}
        onSettings={() => undefined}
        collapsed={false}
        context={{ kind: "sessions" }}
      />,
    );
    const trigger = screen.getByRole("button", { name: tr("common.primaryNavigation") });
    await user.click(trigger);
    expect(container.querySelector(".app-sidebar-open")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Example session" }));
    expect(container.querySelector(".app-sidebar-open")).toBeNull();
  });

  it("keeps shortcut semantics without rendering inline shortcut hints", () => {
    const { container } = render(
      <ShortcutHelpProvider openShortcutHelp={() => undefined}>
        <AppSidebar
          active="home"
          entries={[{ id: "home", label: "nav.home", icon: () => null, shortcut: "navigate-home" }]}
          onNavigate={() => undefined}
          onSettings={() => undefined}
          collapsed={false}
          onCollapsedChange={() => undefined}
        />
      </ShortcutHelpProvider>,
    );

    expect(container.querySelectorAll("kbd")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Today" }).getAttribute("aria-keyshortcuts")).toBe(
      "Control+1",
    );
  });

  it("only exposes agent filters backed by installation metadata", () => {
    render(
      <ShortcutHelpProvider openShortcutHelp={() => undefined}>
        <AppSidebar
          active="agents"
          entries={[{ id: "agents", label: "nav.agents", icon: () => null }]}
          onNavigate={() => undefined}
          onSettings={() => undefined}
          collapsed={false}
          context={{ kind: "agents", filter: "all", onFilterChange: () => undefined }}
        />
      </ShortcutHelpProvider>,
    );

    expect(screen.getByRole("button", { name: "All" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Enabled" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Available" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Updates" })).toBeNull();
  });
});
