// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { initializeI18n } from "@/core/i18n";
import { useAppStore } from "@/stores/app-store";
import { SidebarResizeHandle } from "./SidebarResizeHandle";
import { MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, useSidebarWidthStore } from "./sidebar-width-store";

const { saveWidth } = vi.hoisted(() => ({ saveWidth: vi.fn() }));
vi.mock("@/core/api", () => ({ api: { setSidebarWidthPreference: saveWidth } }));
function ResizeFixture({ settings = false, children }: { settings?: boolean; children: ReactNode }) {
  const width = useSidebarWidthStore();
  const storedCollapsed = useAppStore((state) => state.sidebarCollapsed);
  const collapsed = !settings && storedCollapsed;
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const resize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const maxWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, windowWidth - 640 - 52));
  const visibleWidth = Math.min(width.width, maxWidth);
  return (
    <div
      style={{ "--sidebar-expanded-width": `${visibleWidth}px` } as CSSProperties}
      className={`app-shell${settings ? " app-shell-settings" : ""}${collapsed ? " app-shell-sidebar-collapsed" : ""}${width.dragging ? " app-shell-sidebar-resizing" : ""}`}
    >
      <aside className="app-sidebar">Navigation</aside>
      {!collapsed && windowWidth >= 1024 && (
        <SidebarResizeHandle width={visibleWidth} maxWidth={maxWidth} />
      )}
      {children}
    </div>
  );
}
const shell = (settings = false) => <ResizeFixture settings={settings}>Conversation</ResizeFixture>;
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
    expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "332");
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
