// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionStreamEvent } from "@agentkib/conversation-state";
import type { Live } from "@agentkib/web-client";
import type {
  DesktopConversationBridge,
  DesktopConversationResponse,
} from "@/core/conversation-bridge";
import { refreshConversationCatalog, useConversationCatalog } from "./conversation-catalog";

function catalog(id: string): DesktopConversationResponse {
  return {
    status: 200,
    body: {
      workspaces: [],
      sessions: [
        {
          id,
          workspace_id: "workspace",
          agent: "codex",
          title: id,
          availability: "readable",
          archived: false,
          sidechain: false,
        },
      ],
    },
  };
}

function fixture() {
  let receive = (_event: SessionStreamEvent<Live>) => {};
  const bridge: DesktopConversationBridge = {
    request: vi.fn(async () => catalog("initial")),
    upload: vi.fn(async () => ({ status: 400, body: {} })),
    subscribe: vi.fn(async () => ({
      subscriptionId: "catalog",
      cursor: "epoch:0",
      events: [
        {
          protocolVersion: 2 as const,
          sessionId: "",
          subscriptionId: "catalog",
          runtimeBootId: "boot",
          epoch: "epoch",
          seq: 0,
          cursor: "epoch:0",
          type: "snapshot" as const,
          payload: {
            live: { sessionId: "", status: "idle", revision: 0, sendEnabled: false, approvals: [] },
          },
        },
      ],
    })),
    acknowledge: vi.fn(async () => {}),
    unsubscribe: vi.fn(async () => {}),
    onEvent: (listener) => {
      receive = listener;
      return () => {
        receive = () => {};
      };
    },
    onUnavailable: () => () => {},
    onControlChanged: () => () => {},
  };
  window.desktopConversation = bridge;
  return { bridge, emit: (event: SessionStreamEvent<Live>) => receive(event) };
}

afterEach(() => {
  cleanup();
  delete window.desktopConversation;
});

describe("desktop conversation catalog", () => {
  it("normalizes Claude's verified history alias for desktop links and continuation", async () => {
    const { bridge } = fixture();
    vi.mocked(bridge.request).mockResolvedValue({
      status: 200,
      body: {
        sessions: [
          {
            id: "managed-claude",
            indexedSessionId: "indexed-claude",
            workspace_id: "workspace",
            agent: "claude-code",
            availability: "readable",
            archived: false,
            sidechain: false,
          },
        ],
      },
    });
    expect(await refreshConversationCatalog()).toEqual([
      expect.objectContaining({
        id: "managed-claude",
        indexedSessionIds: ["indexed-claude"],
      }),
    ]);
  });

  it("keeps transport errors visible across successful reads until the stream recovers", async () => {
    const { bridge } = fixture();
    const disconnected = new Error("runtime_unavailable");
    vi.mocked(bridge.subscribe).mockRejectedValueOnce(disconnected);
    const view = renderHook(() => useConversationCatalog(true));
    await waitFor(() => expect(view.result.current.error).toBe(disconnected));
    await act(async () => {
      await refreshConversationCatalog();
    });
    expect(view.result.current.error).toBe(disconnected);
    await waitFor(() => expect(view.result.current.error).toBeUndefined());
    expect(bridge.subscribe).toHaveBeenCalledTimes(2);
  });

  it("reports exhausted recovery and reconnects on explicit refresh without remounting", async () => {
    const { bridge, emit } = fixture();
    const successful = await bridge.subscribe("", undefined);
    vi.mocked(bridge.subscribe)
      .mockClear()
      .mockResolvedValue({
        ...successful,
        events: [
          { ...successful.events[0], type: "resync-required", payload: { reason: "overflow" } },
        ],
      });
    const view = renderHook(() => useConversationCatalog(true));
    await waitFor(() => expect(view.result.current.error).toBeInstanceOf(Error));
    expect(bridge.subscribe).toHaveBeenCalledTimes(4);
    expect(view.result.current.sessions[0]?.id).toBe("initial");
    expect(bridge.unsubscribe).toHaveBeenCalledTimes(4);

    // The fetch succeeds before the new baseline. It must not hide the broken stream.
    let baseline!: (value: typeof successful) => void;
    vi.mocked(bridge.subscribe).mockReturnValueOnce(new Promise((done) => (baseline = done)));
    vi.mocked(bridge.request).mockResolvedValue(catalog("refreshed"));
    await act(async () => {
      await refreshConversationCatalog();
    });
    expect(bridge.subscribe).toHaveBeenCalledTimes(5);
    expect(view.result.current.sessions[0]?.id).toBe("refreshed");
    expect(view.result.current.error).toBeInstanceOf(Error);
    await act(async () => baseline(successful));
    await waitFor(() => expect(view.result.current.error).toBeUndefined());

    vi.mocked(bridge.request).mockResolvedValue(catalog("live-again"));
    act(() =>
      emit({
        ...successful.events[0],
        seq: 1,
        cursor: "epoch:1",
        type: "invalidate",
        payload: { domains: ["catalog"] },
      }),
    );
    await waitFor(() => expect(view.result.current.sessions[0]?.id).toBe("live-again"));
    view.unmount();
    await refreshConversationCatalog();
    expect(bridge.subscribe).toHaveBeenCalledTimes(5);
  });

  it("subscribes to catalog invalidations even with no open live conversation", async () => {
    const { bridge, emit } = fixture();
    const view = renderHook(() => useConversationCatalog(true));
    await waitFor(() => expect(view.result.current.sessions[0]?.id).toBe("initial"));
    expect(bridge.subscribe).toHaveBeenCalledWith("", undefined);
    vi.mocked(bridge.request).mockResolvedValue(catalog("created"));
    act(() =>
      emit({
        protocolVersion: 2,
        sessionId: "",
        subscriptionId: "catalog",
        runtimeBootId: "boot",
        epoch: "epoch",
        seq: 1,
        cursor: "epoch:1",
        type: "invalidate",
        payload: { domains: ["catalog"] },
      }),
    );
    await waitFor(() => expect(view.result.current.sessions[0]?.id).toBe("created"));
    view.unmount();
    expect(bridge.unsubscribe).toHaveBeenCalledWith("catalog");
  });

  it("does not lose a mutation refresh that arrives during an older catalog request", async () => {
    const { bridge } = fixture();
    let resolve!: (response: DesktopConversationResponse) => void;
    vi.mocked(bridge.request).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    vi.mocked(bridge.request).mockResolvedValue(catalog("after-fork"));
    const old = refreshConversationCatalog();
    const afterFork = refreshConversationCatalog();
    resolve(catalog("before-fork"));
    expect((await afterFork)[0].id).toBe("after-fork");
    expect((await old)[0].id).toBe("after-fork");
    expect(bridge.request).toHaveBeenCalledTimes(2);
  });

  it("allows later independent gaps after successful baseline recovery", async () => {
    const { bridge, emit } = fixture();
    const view = renderHook(() => useConversationCatalog(true));
    await waitFor(() => expect(bridge.subscribe).toHaveBeenCalledTimes(1));
    for (let attempt = 1; attempt <= 5; attempt++) {
      await act(async () => {
        emit({
          protocolVersion: 2,
          sessionId: "",
          subscriptionId: "catalog",
          runtimeBootId: "boot",
          epoch: "epoch",
          seq: 2,
          cursor: "epoch:2",
          type: "invalidate",
          payload: { domains: ["catalog"] },
        });
      });
      await waitFor(() => expect(bridge.subscribe).toHaveBeenCalledTimes(attempt + 1));
    }
    vi.mocked(bridge.request).mockResolvedValue(catalog("recovered"));
    await act(async () => {
      emit({
        protocolVersion: 2,
        sessionId: "",
        subscriptionId: "catalog",
        runtimeBootId: "boot",
        epoch: "epoch",
        seq: 1,
        cursor: "epoch:1",
        type: "invalidate",
        payload: { domains: ["catalog"] },
      });
    });
    await waitFor(() => expect(view.result.current.sessions[0]?.id).toBe("recovered"));
  });
});
