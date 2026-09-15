/** @jsxImportSource octane */

// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@octanejs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "@/core/i18n";
import { useAppStore } from "@/stores/app-store";
import { AppShell } from "./AppShell";
import { useSidebarWidthStore } from "./sidebar-width-store";

const { saveWidth } = vi.hoisted(() => ({ saveWidth: vi.fn() }));
vi.mock("@/core/api", () => ({ api: { setSidebarWidthPreference: saveWidth } }));
vi.mock("@octanejs/tanstack-router", () => ({ useLocation: () => "/sessions" }));
const shell = (settings = false) => (
  <AppShell sidebar={<aside className="app-sidebar">Navigation</aside>} headerless={settings}>
    Conversation
  </AppShell>
);
const resizeWindow = (width: number) => {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  fireEvent(window, new Event("resize"));
};

describe("shared sidebar resize handle", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await initializeI18n("en-US");
    useAppStore.getState().reset();
    useSidebarWidthStore.setState(useSidebarWidthStore.getInitialState());
    useSidebarWidthStore.getState().hydrate(250, 0);
    resizeWindow(1280);
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
    saveWidth.mockImplementation(async (width) => ({ sidebar_width_preference: width }));
  });
  afterEach(cleanup);

  it("shares the chosen width between primary and settings shells", async () => {
    const { container, rerender } = render(shell());
    const handle = screen.getByRole("separator", { name: "Resize sidebar" });
    expect(handle).toHaveAttribute("aria-valuenow", "250");
    fireEvent.keyDown(handle, { key: "End" });
    await waitFor(() => expect(handle).toHaveAttribute("aria-disabled", "false"));
    expect(
      container
        .querySelector<HTMLElement>(".app-shell")
        ?.style.getPropertyValue("--sidebar-expanded-width"),
    ).toBe("400px");
    rerender(shell(true));
    expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "400");
    fireEvent.doubleClick(screen.getByRole("separator"));
    await waitFor(() => expect(saveWidth).toHaveBeenLastCalledWith(250));
    expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "250");
  });

  it("previews a clamped drag and writes only on pointer release", async () => {
    const { container } = render(shell());
    const handle = screen.getByRole("separator");
    fireEvent.pointerDown(handle, { button: 0, clientX: 250 });
    expect(handle.setPointerCapture).toHaveBeenCalledWith(1);
    fireEvent.pointerMove(handle, { clientX: 900 });
    expect(handle).toHaveAttribute("aria-valuenow", "400");
    expect(container.querySelector(".app-shell")).toHaveClass("app-shell-sidebar-resizing");
    expect(saveWidth).not.toHaveBeenCalled();
    fireEvent.pointerUp(handle, { clientX: 900 });
    await waitFor(() => expect(saveWidth).toHaveBeenCalledExactlyOnceWith(400));
    expect(container.querySelector(".app-shell")).not.toHaveClass("app-shell-sidebar-resizing");
  });

  it.each(["pointerCancel", "lostPointerCapture", "blur", "escape"])(
    "cancels on %s without persisting",
    (event) => {
      render(shell());
      const handle = screen.getByRole("separator");
      fireEvent.pointerDown(handle, { button: 0, clientX: 250 });
      fireEvent.pointerMove(handle, { clientX: 320 });
      if (event === "blur") fireEvent(window, new Event("blur"));
      else if (event === "escape") fireEvent.keyDown(handle, { key: "Escape" });
      else if (event === "pointerCancel") fireEvent.pointerCancel(handle);
      else fireEvent.lostPointerCapture(handle);
      expect(handle).toHaveAttribute("aria-valuenow", "250");
      expect(saveWidth).not.toHaveBeenCalled();
    },
  );

  it("hides for collapsed and drawer modes, and keeps the saved width when resizing the window", async () => {
    render(shell());
    await act(async () => {
      await useSidebarWidthStore.getState().save(400);
    });
    act(() => useAppStore.getState().setSidebarCollapsed(true));
    expect(screen.queryByRole("separator")).toBeNull();
    act(() => useAppStore.getState().setSidebarCollapsed(false));
    expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "400");
    act(() => resizeWindow(1024));
    expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "384");
    act(() => resizeWindow(900));
    expect(screen.queryByRole("separator")).toBeNull();
    act(() => resizeWindow(1440));
    expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "400");
    expect(saveWidth).toHaveBeenCalledTimes(1);
  });

  it("cancels an unfinished drag when the layout unmounts", () => {
    const { unmount } = render(shell());
    const handle = screen.getByRole("separator");
    fireEvent.pointerDown(handle, { button: 0, clientX: 250 });
    fireEvent.pointerMove(handle, { clientX: 350 });
    unmount();
    expect(useSidebarWidthStore.getState()).toMatchObject({ dragging: false, width: 250 });
    expect(saveWidth).not.toHaveBeenCalled();
  });

  it("disables further input while saving and reports failures without keeping a false width", async () => {
    let reject!: (error: Error) => void;
    saveWidth.mockReturnValue(
      new Promise((_, fail) => {
        reject = fail;
      }),
    );
    render(shell());
    const handle = screen.getByRole("separator");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle).toHaveAttribute("aria-disabled", "true");
    fireEvent.keyDown(handle, { key: "End" });
    expect(saveWidth).toHaveBeenCalledExactlyOnceWith(260);
    await act(async () => reject(new Error("Read-only preferences")));
    expect(handle).toHaveAttribute("aria-valuenow", "250");
    expect(screen.getByRole("alert")).toHaveTextContent("Could not save sidebar width");
  });
});
