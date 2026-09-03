// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { settingsTargetId } from "./components/SettingsLayout";
import { useSettingsTargetFocus } from "./useSettingsTargetFocus";

function FocusHarness({
  contentPending,
  runtimeRevision,
}: {
  contentPending: boolean;
  runtimeRevision: number;
}) {
  useSettingsTargetFocus("general-interface", "general", contentPending);
  return contentPending ? null : (
    <div
      data-runtime-revision={runtimeRevision}
      id={settingsTargetId("general-interface")}
      tabIndex={-1}
    />
  );
}

describe("useSettingsTargetFocus", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("focuses when content becomes available without refocusing on later runtime updates", () => {
    let scheduledFrame: FrameRequestCallback | undefined;
    const requestAnimationFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        scheduledFrame = callback;
        return 1;
      });
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false })),
    });

    try {
      const view = render(<FocusHarness contentPending runtimeRevision={0} />);
      view.rerender(<FocusHarness contentPending={false} runtimeRevision={0} />);

      const target = view.container.querySelector<HTMLElement>(
        `#${settingsTargetId("general-interface")}`,
      )!;
      const scrollIntoView = vi.spyOn(target, "scrollIntoView");
      const focus = vi.spyOn(target, "focus");

      expect(requestAnimationFrame).toHaveBeenCalledOnce();
      scheduledFrame?.(0);
      expect(scrollIntoView).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledOnce();

      view.rerender(<FocusHarness contentPending={false} runtimeRevision={1} />);
      expect(requestAnimationFrame).toHaveBeenCalledOnce();
      expect(scrollIntoView).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledOnce();
    } finally {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: originalMatchMedia,
      });
    }
  });
});
