// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { skillKeys, useSkillSyncEvents } from "./skills-query";
import type { SkillSyncCoordinatorState } from "@/core/types";

afterEach(cleanup);
describe("Skill synchronization cache events", () => {
  it("invalidates inactive Skill caches after background work while no Hub is mounted", () => {
    const original = window.agentkibDesktop;
    if (!original) throw new Error("Missing desktop fixture bridge");
    let listener!: (state: SkillSyncCoordinatorState) => void;
    Object.defineProperty(window, "agentkibDesktop", {
      configurable: true,
      value: {
        ...original,
        events: {
          ...original.events,
          onSkillSyncState: (callback: typeof listener) => {
            listener = callback;
            return () => {};
          },
        },
      },
    });
    try {
      const client = new QueryClient();
      client.setQueryData(skillKeys.library(), { installed: [], removed: [] });
      client.setQueryData(skillKeys.sync(), {});
      const { unmount } = renderHook(useSkillSyncEvents, {
        wrapper: ({ children }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      });
      act(() => listener({ state: "failed", error: "offline" }));
      expect(client.getQueryState(skillKeys.library())?.isInvalidated).toBe(false);
      act(() => listener({ state: "succeeded", checked_at: "2026-10-15T00:00:00Z" }));
      expect(client.getQueryState(skillKeys.library())?.isInvalidated).toBe(true);
      expect(client.getQueryState(skillKeys.sync())?.isInvalidated).toBe(true);
      unmount();
    } finally {
      Object.defineProperty(window, "agentkibDesktop", { configurable: true, value: original });
    }
  });
});
