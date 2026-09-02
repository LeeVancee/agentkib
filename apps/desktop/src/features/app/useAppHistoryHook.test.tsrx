// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@octanejs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppHistoryLocation } from "./useAppHistory.tsx";

type HistoryUpdate = {
  location: AppHistoryLocation;
  action: { type: "PUSH" | "REPLACE" | "BACK" | "FORWARD" | "GO" };
};

const testHistory = vi.hoisted(() => ({
  location: undefined as AppHistoryLocation | undefined,
  listener: undefined as ((update: HistoryUpdate) => void) | undefined,
  go: vi.fn(),
  subscribe: vi.fn(),
}));

vi.mock("@octanejs/tanstack-router", () => ({
  useRouter: () => ({ history: testHistory }),
}));

import { useAppHistory } from "./useAppHistory.tsx";

function location(href: string, index: number): AppHistoryLocation {
  return {
    href,
    pathname: href,
    search: "",
    hash: "",
    state: { __TSR_index: index, __TSR_key: `key-${index}` },
  };
}

describe("useAppHistory.tsx", () => {
  beforeEach(() => {
    testHistory.location = location("/", 0);
    testHistory.listener = undefined;
    testHistory.go.mockReset();
    testHistory.subscribe.mockReset().mockImplementation((listener) => {
      testHistory.listener = listener;
      return () => {
        testHistory.listener = undefined;
      };
    });
  });

  afterEach(cleanup);

  it("uses the browser index delta when duplicate locations are not recorded", async () => {
    const beforeMove = vi.fn().mockResolvedValue(true);
    const { result } = renderHook(() => useAppHistory(beforeMove));

    act(() => {
      testHistory.listener?.({ location: location("/agents", 1), action: { type: "PUSH" } });
      testHistory.listener?.({ location: location("/agents", 2), action: { type: "PUSH" } });
    });
    expect(result.current.canGoBack).toBe(true);

    act(() => result.current.goBack());
    await waitFor(() => expect(testHistory.go).toHaveBeenCalledWith(-2));
    expect(beforeMove).toHaveBeenCalledOnce();
    expect(result.current.canGoBack).toBe(false);
    expect(result.current.canGoForward).toBe(false);
  });

  it("does not move or change the history boundary when navigation is cancelled", async () => {
    const beforeMove = vi.fn().mockResolvedValue(false);
    const { result } = renderHook(() => useAppHistory(beforeMove));

    act(() => {
      testHistory.listener?.({ location: location("/workspaces", 1), action: { type: "PUSH" } });
    });
    act(() => result.current.goBack());

    await waitFor(() => expect(result.current.canGoBack).toBe(true));
    expect(beforeMove).toHaveBeenCalledOnce();
    expect(testHistory.go).not.toHaveBeenCalled();
    expect(result.current.canGoForward).toBe(false);
  });
});
