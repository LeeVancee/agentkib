// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "@/core/i18n";
import { useAppStore } from "@/stores/app-store";
import { WindowNavigationControls } from "./AppShell";

describe("WindowNavigationControls", () => {
  beforeAll(async () => initializeI18n("zh-CN"));

  beforeEach(() => {
    document.documentElement.dataset.platform = "macos";
    useAppStore.getState().reset();
  });

  afterEach(cleanup);

  it("renders sidebar, back, and forward controls in a stable order", () => {
    const { container } = render(<WindowNavigationControls />);
    const buttons = [...container.querySelectorAll("button")];

    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "收起侧栏",
      "后退",
      "前进",
    ]);
    expect((buttons[1] as HTMLButtonElement).disabled).toBe(true);
    expect((buttons[2] as HTMLButtonElement).disabled).toBe(true);
    expect(buttons[1].getAttribute("aria-keyshortcuts")).toBe("Meta+[");
    expect(buttons[2].getAttribute("aria-keyshortcuts")).toBe("Meta+]");
  });

  it("toggles the sidebar and invokes enabled history actions", () => {
    const onBack = vi.fn();
    const onForward = vi.fn();
    render(
      <WindowNavigationControls canGoBack canGoForward onBack={onBack} onForward={onForward} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "收起侧栏" }));
    fireEvent.click(screen.getByRole("button", { name: "后退" }));
    fireEvent.click(screen.getByRole("button", { name: "前进" }));

    expect(useAppStore.getState().sidebarCollapsed).toBe(true);
    expect(onBack).toHaveBeenCalledOnce();
    expect(onForward).toHaveBeenCalledOnce();
  });
});
