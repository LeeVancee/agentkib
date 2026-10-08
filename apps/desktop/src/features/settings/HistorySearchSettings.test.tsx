// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { HistorySearchStatus } from "@agentkib/web-client";
import { initializeI18n } from "@/core/i18n";
import type {
  DesktopConversationBridge,
  DesktopConversationResponse,
} from "@/core/conversation-bridge";
import { HistorySearchSettings } from "./HistorySearchSettings";

const status = (enabled: boolean, bytes: number): HistorySearchStatus => ({
  enabled,
  bytes,
  generation: String(bytes),
  limitBytes: 4096,
  budgetExceeded: false,
  coverage: {
    total: 1,
    ready: 1,
    building: 0,
    partial: 0,
    stale: 0,
    unavailable: 0,
    limitations: [],
  },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((done) => {
      resolve = done;
    }),
    resolve: (value: T) => resolve(value),
  };
}
const previous = window.desktopConversation;
beforeAll(() => initializeI18n("en-US"));
afterEach(() => {
  cleanup();
  window.desktopConversation = previous;
  vi.useRealTimers();
});
function fixture() {
  const pending = deferred<DesktopConversationResponse>();
  let reads = 0;
  const bridge: DesktopConversationBridge = {
    request: vi.fn(async (path, body) => {
      if (path === "access")
        return {
          status: 200,
          body: {
            protocolVersion: 2,
            status: "approved",
            csrfToken: "test",
            bootId: "boot",
            historySearch: true,
          },
        };
      if (path === "history/status")
        return ++reads === 1 ? { status: 200, body: status(true, 1024) } : pending.promise;
      if (path === "history/configure")
        return { status: 200, body: status((body as { enabled: boolean }).enabled, 0) };
      return { status: 200, body: status(true, 0) };
    }),
    cancelRead: vi.fn(async () => {}),
    upload: vi.fn(),
    subscribe: vi.fn(),
    acknowledge: vi.fn(),
    unsubscribe: vi.fn(),
    onEvent: vi.fn(),
    onUnavailable: vi.fn(),
    onControlChanged: vi.fn(),
  };
  window.desktopConversation = bridge;
  return { bridge, pending };
}
describe("content search settings with the real desktop client", () => {
  it.each(["Disable and clear index", "Clear index", "Rebuild index"])(
    "keeps %s authoritative when an older poll settles",
    async (label) => {
      vi.useFakeTimers();
      const { bridge, pending } = fixture();
      render(<HistorySearchSettings />);
      await act(async () => {});
      expect(screen.getByText("1 / 4 KiB")).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      const request = vi
        .mocked(bridge.request)
        .mock.calls.filter(([path]) => path === "history/status")
        .at(-1)!;
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: label }));
      });
      expect(bridge.cancelRead).toHaveBeenCalledWith(request[2]);
      expect(screen.getByText("0 / 4 KiB")).toBeTruthy();
      await act(async () => {
        pending.resolve({ status: 200, body: status(true, 4096) });
      });
      expect(screen.getByText("0 / 4 KiB")).toBeTruthy();
      const toggle = screen.getByRole("button", {
        name: label.startsWith("Disable") ? "Enable content indexing" : "Disable and clear index",
      }) as HTMLButtonElement;
      expect(toggle.disabled).toBe(false);
    },
  );
  it("can clear and rebuild a damaged cache when its initial status is unavailable", async () => {
    const { bridge } = fixture();
    const request = vi.mocked(bridge.request).getMockImplementation()!;
    vi.mocked(bridge.request).mockImplementation((path, body, id) =>
      path === "history/status"
        ? Promise.resolve({ status: 410, body: { error: "history-search-cache-unavailable" } })
        : request(path, body, id),
    );
    render(<HistorySearchSettings />);
    await act(async () => {});
    expect(screen.getByRole("alert")).toBeTruthy();
    const clear = screen.getByRole("button", { name: "Clear index" }) as HTMLButtonElement;
    expect(clear.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(clear);
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("0 / 4 KiB")).toBeTruthy();
    const rebuild = screen.getByRole("button", { name: "Rebuild index" }) as HTMLButtonElement;
    expect(rebuild.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(rebuild);
    });
    expect(bridge.request).toHaveBeenCalledWith("history/clear", {});
    expect(bridge.request).toHaveBeenCalledWith("history/rebuild", {});
  });
  it("cancels an unfinished initial status read when settings closes", async () => {
    const { bridge, pending } = fixture();
    const request = vi.mocked(bridge.request).getMockImplementation()!;
    vi.mocked(bridge.request).mockImplementation((path, body, id) =>
      path === "history/status" ? pending.promise : request(path, body, id),
    );
    const view = render(<HistorySearchSettings />);
    await act(async () => {});
    const read = vi.mocked(bridge.request).mock.calls.find(([path]) => path === "history/status")!;
    view.unmount();
    expect(bridge.cancelRead).toHaveBeenCalledExactlyOnceWith(read[2]);
    await act(async () => {
      pending.resolve({ status: 200, body: status(true, 4096) });
    });
    expect(screen.queryByText("4 / 4 KiB")).toBeNull();
  });
});
