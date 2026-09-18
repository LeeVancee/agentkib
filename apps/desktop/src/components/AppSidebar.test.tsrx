/** @jsxImportSource octane */

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@octanejs/testing-library";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { changeLocale, initializeI18n, tr } from "@/core/i18n";
import { AppSidebar } from "./AppSidebar.tsrx";
import { ShortcutHelpProvider } from "@/features/app/ShortcutHelpContext.tsrx";
import { createGlobalNavigation } from "@/features/app/global-navigation";
import { useAppStore } from "@/stores/app-store";
import { clearSidebarPeekCloseTimer } from "@/features/app/sidebar-peek";

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
  afterEach(cleanup);

  it.each([
    ["zh-CN", "更多", "设置", "远程连接"],
    ["zh-TW", "更多", "設定", "遠端連線"],
    ["ja-JP", "その他", "設定", "リモート接続"],
    ["en-US", "More", "Settings", "Remote connections"],
  ] as const)(
    "updates the mounted sidebar and menu in %s without parent rerender",
    async (locale, more, settings, remote) => {
      render(
        <AppSidebar
          active="home"
          entries={createGlobalNavigation(0)}
          onNavigate={vi.fn()}
          onSettings={vi.fn()}
          collapsed={false}
        />,
      );
      const original = screen.getByRole("button", { name: "More" });
      try {
        await act(() => changeLocale(locale));
        const trigger = screen.getByRole("button", { name: more });
        expect(trigger).toBe(original);
        await userEvent.setup().click(trigger);
        expect(await screen.findByRole("menuitem", { name: settings })).toBeTruthy();
        expect(await screen.findByRole("menuitem", { name: remote })).toBeTruthy();
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

  it("keeps a peeking sidebar open while the directory menu is active", () => {
    vi.useFakeTimers();
    useAppStore.getState().reset();
    useAppStore.getState().setSidebarPeek(true);
    try {
      const { container } = render(
        <AppSidebar
          active="sessions"
          entries={createGlobalNavigation(0)}
          onNavigate={() => undefined}
          onSettings={() => undefined}
          collapsed
          context={{ kind: "sessions" }}
        />,
      );
      const sidebar = container.querySelector(".app-sidebar")!;
      fireEvent.pointerLeave(sidebar);
      fireEvent.click(screen.getByRole("button", { name: "Open directory menu" }));
      act(() => vi.advanceTimersByTime(350));
      expect(useAppStore.getState().sidebarPeek).toBe(true);
      fireEvent.pointerLeave(sidebar);
      act(() => vi.advanceTimersByTime(350));
      expect(useAppStore.getState().sidebarPeek).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "Close directory menu" }));
      act(() => vi.advanceTimersByTime(350));
      expect(useAppStore.getState().sidebarPeek).toBe(false);
    } finally {
      clearSidebarPeekCloseTimer();
      vi.useRealTimers();
      useAppStore.getState().reset();
    }
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
    const header = container.querySelector(".app-sidebar-header-row")!;
    const search = within(header as HTMLElement).getByRole("button", { name: tr("search.open") });
    expect(search.getAttribute("aria-keyshortcuts")).toBe("Control+K");
    expect(header.querySelector(".sidebar-brand")?.closest("button, a")).toBeNull();
    await userEvent.setup().click(search);
    expect(onOpenSearch).toHaveBeenCalledOnce();
  });

  it("keeps a fixed More trigger with settings and enabled remote connection entries", async () => {
    const user = userEvent.setup();
    const onSettings = vi.fn();
    const { container } = render(
      <ShortcutHelpProvider openShortcutHelp={() => undefined}>
        <AppSidebar
          active="home"
          entries={[{ id: "home", label: "nav.home", icon: () => null, shortcut: "navigate-home" }]}
          onNavigate={() => undefined}
          onSettings={onSettings}
          collapsed={false}
          onCollapsedChange={() => undefined}
        />
      </ShortcutHelpProvider>,
    );

    expect(screen.queryByRole("button", { name: "Keyboard shortcuts" })).toBeNull();
    const more = screen.getByRole("button", { name: tr("sessions.more") });
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
    expect(more.querySelector(".lucide-ellipsis")).toBeTruthy();
    await user.click(more);
    const menu = await screen.findByRole("menu");
    expect(menu.parentElement?.classList.contains("z-80")).toBe(true);
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(2);
    expect(
      within(menu).getByRole("menuitem", { name: "Settings" }).getAttribute("aria-keyshortcuts"),
    ).toBe("Control+,");
    const remote = within(menu).getByRole("menuitem", { name: tr("sessions.remote") });
    expect(remote.getAttribute("aria-disabled")).not.toBe("true");
    expect(more.querySelector(".lucide-ellipsis")).toBeTruthy();
    expect(container.querySelector(".app-sidebar-more-entry.app-sidebar-item-active")).toBeNull();
    await user.click(within(menu).getByRole("menuitem", { name: "Settings" }));
    expect(onSettings).toHaveBeenCalledOnce();
    expect(screen.queryByText("General, discovery, and integrations")).toBeNull();
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
    const primary = sidebar.querySelector(".app-sidebar-group")!;
    const names = within(primary as HTMLElement)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"));
    expect(names.slice(-2)).toEqual([tr("nav.agents"), tr("sessions.nav")]);
    const sessions = screen.getByRole("button", { name: tr("sessions.nav") });
    expect(sessions.getAttribute("aria-current")).toBe("page");
    expect(sessions.hasAttribute("aria-keyshortcuts")).toBe(false);
    expect(within(sidebar as HTMLElement).getByText("Example session")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: tr("sidebar.tools") }));
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
    expect(screen.getByRole("button", { name: "Today" }).getAttribute("title")).toBe("Today");
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
