// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeInfo } from "@/core/types";
import { useAppStore } from "@/stores/app-store";
import { clampSidebarWidth, useSidebarWidthStore } from "./sidebar-width-store";

const { saveWidth } = vi.hoisted(() => ({ saveWidth: vi.fn() }));
vi.mock("@/core/api", () => ({ api: { setSidebarWidthPreference: saveWidth } }));

const store = () => useSidebarWidthStore.getState();
describe("sidebar width preference", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSidebarWidthStore.setState(useSidebarWidthStore.getInitialState());
    useAppStore.getState().reset();
    saveWidth.mockImplementation(async (width) => ({ sidebar_width_preference: width }));
  });

  it("defaults to 250 and clamps only interactive values to 250–400", () => {
    expect(store().width).toBe(250);
    expect([100, 300.6, 500, NaN].map(clampSidebarWidth)).toEqual([250, 301, 400, 250]);
    for (const value of [null, undefined, "300", 249, 401, 300.5]) {
      store().hydrate(value, store().revision);
      expect(store().width).toBe(250);
    }
  });

  it("restores the durable preference without relying on Chromium cache", () => {
    localStorage.clear();
    store().hydrate(340, store().revision);
    expect(store()).toMatchObject({ width: 340, savedWidth: 340, hydrated: true });
    expect(saveWidth).not.toHaveBeenCalled();
  });

  it("previews without writes and cancels back to the saved width", () => {
    expect(store().beginResize()).toBe(false);
    store().hydrate(280, 0);
    expect(store().beginResize()).toBe(true);
    store().preview(380);
    expect(store().width).toBe(380);
    expect(saveWidth).not.toHaveBeenCalled();
    store().cancelResize();
    expect(store()).toMatchObject({ width: 280, dragging: false });
  });

  it("writes once after dragging, preserves other runtime settings, and rejects stale hydration", async () => {
    store().hydrate(250, 0);
    useAppStore
      .getState()
      .setRuntime({ effective_locale: "ja-JP", accent_theme_preference: "sakura" } as RuntimeInfo);
    const previousRevision = store().revision;
    store().beginResize();
    store().preview(330);
    await store().save(store().width);
    store().hydrate(250, previousRevision);
    expect(store()).toMatchObject({ width: 330, savedWidth: 330, saving: false });
    expect(saveWidth).toHaveBeenCalledExactlyOnceWith(330);
    expect(useAppStore.getState().runtime).toMatchObject({
      effective_locale: "ja-JP",
      accent_theme_preference: "sakura",
      sidebar_width_preference: 330,
    });
  });

  it("blocks overlapping changes and stale reads started during a save", async () => {
    let resolve!: (runtime: { sidebar_width_preference: number }) => void;
    saveWidth.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    store().hydrate(250, 0);
    const pending = store().save(320);
    const staleRevision = store().revision;
    expect(store().beginResize()).toBe(false);
    await store().save(350);
    store().hydrate(250, staleRevision);
    resolve({ sidebar_width_preference: 320 });
    await pending;
    store().hydrate(250, staleRevision);
    expect(saveWidth).toHaveBeenCalledTimes(1);
    expect(store().width).toBe(320);
  });

  it("restores the previous width on failure and does not pretend it was saved", async () => {
    store().hydrate(280, 0);
    saveWidth.mockRejectedValue(new Error("Disk unavailable"));
    await store().save(380);
    expect(store()).toMatchObject({
      width: 280,
      savedWidth: 280,
      saving: false,
      error: expect.stringContaining("Disk unavailable"),
    });
    store().clearError();
    expect(store().error).toBe("");
  });

  it("skips unchanged width and rejects an unconfirmed write", async () => {
    store().hydrate(null, 0);
    await store().save(250);
    expect(saveWidth).not.toHaveBeenCalled();
    saveWidth.mockResolvedValue({ sidebar_width_preference: null });
    await store().save(300);
    expect(store().width).toBe(250);
    expect(store().error).not.toBe("");
  });
});
