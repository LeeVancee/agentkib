import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode, useState } from "react";
import {
  ApiError,
  WebClient,
  type ConversationClientBridge,
  type ConversationEvent,
  type ConversationSessionSummary,
  type SessionStreamHandlers,
} from "@agentkib/web-client";
import { EmbeddedConversation } from "./conversation";
import { useSessionController } from "./features/sessions/use-session-controller";
import { pendingScope, readPending, rememberPending } from "./features/sessions/pending-controls";

afterEach(cleanup);
beforeEach(() => {
  sessionStorage.clear();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
function fixture(lan = false) {
  const host = { bootId: "boot" };
  const sessions: ConversationSessionSummary[] = ["first", "second"].map((id) => ({
    id,
    workspace_id: "workspace",
    agent: "claude-code",
    availability: "readable",
    archived: false,
    sidechain: false,
  }));
  const streams = new Map<string, SessionStreamHandlers>();
  const live = (id: string) => ({
    sessionId: id,
    status: "idle",
    revision: 1,
    sendEnabled: true,
    approvals: [],
    questions: [],
  });
  const bridge: ConversationClientBridge = {
    async request<Result>(path: string) {
      const operation = path.split("?")[0];
      const id = new URLSearchParams(path.split("?")[1]).get("sessionId") ?? "";
      if (operation === "info")
        return {
          protocolVersion: 1,
          conversationProtocolVersion: 2,
          transport: "lan",
          capabilities: { read: true, send: true, approve: true },
        } as Result;
      const result =
        operation === "access"
          ? {
              protocolVersion: 2,
              status: "approved",
              csrfToken: "local",
              ...(lan ? { bearerToken: "isolated-test-token" } : {}),
              bootId: host.bootId,
              experimentalEnabled: true,
              device: { id: "local", name: "Desktop", send: true, approve: true, manage: true },
            }
          : operation === "catalog"
            ? { indexEnabled: true, sessions: sessions.map((session) => ({ ...session })) }
            : operation === "events"
              ? {
                  events: [
                    {
                      id: `${id}-history`,
                      kind: "agent-message",
                      content: `${id} history`,
                      attachment_count: 0,
                      truncated: false,
                    },
                  ],
                  warnings: [],
                }
              : operation === "live"
                ? live(id)
                : operation === "managed/options"
                  ? {
                      available: true,
                      workspaces: [{ id: "workspace", name: "Project" }],
                      models: [],
                    }
                  : operation === "codex/capabilities"
                    ? {
                        sessionId: id,
                        executionMode: "codex-managed",
                        status: "idle",
                        features: { archive: { available: true } },
                      }
                    : operation === "codex/queue"
                      ? { sessionId: id, data: [] }
                      : operation === "codex/archive"
                        ? { accepted: true }
                        : { available: false };
      return result as Result;
    },
    stream(id, handlers) {
      streams.set(id, handlers);
      let closed = false;
      queueMicrotask(() => {
        if (closed) return;
        handlers.open();
        if (id)
          handlers.event(
            "session-event",
            JSON.stringify({
              protocolVersion: 2,
              subscriptionId: id,
              sessionId: id,
              runtimeBootId: "runtime",
              epoch: "epoch",
              seq: 0,
              cursor: "cursor",
              type: "snapshot",
              payload: { live: live(id) },
            }),
          );
      });
      return () => {
        closed = true;
      };
    },
    uploadAttachment: vi.fn(),
  };
  return {
    host,
    sessions,
    streams,
    bridge,
    client: new WebClient(
      undefined,
      lan ? { type: "lan-http", origin: "http://192.168.1.2:1421" } : { type: "same-origin" },
      bridge,
    ),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function emitSession(stream: SessionStreamHandlers, seq: number, type: string, payload: unknown) {
  act(() =>
    stream.event(
      "session-event",
      JSON.stringify({
        protocolVersion: 2,
        subscriptionId: "first",
        sessionId: "first",
        runtimeBootId: "runtime",
        epoch: "epoch",
        seq,
        cursor: `recovery-${seq}`,
        type,
        payload,
      }),
    ),
  );
}

describe("history pagination refresh compatibility", () => {
  const row = (index: number): ConversationEvent => ({
    id: `history-${index}`,
    kind: "agent-message",
    content: `History ${index}`,
    attachment_count: 0,
    truncated: false,
  });
  const readPage = (history: ConversationEvent[], cursor?: string) => {
    const end = cursor ? Number(cursor.slice("history-".length)) : history.length;
    const start = Math.max(0, end - 50);
    return {
      events: history.slice(start, end),
      next_cursor: start ? `history-${start}` : undefined,
      warnings: [],
    };
  };

  it.each([
    { exhausted: false, strict: false },
    { exhausted: true, strict: false },
    { exhausted: false, strict: true },
    { exhausted: true, strict: true },
  ])(
    "retains the oldest loaded cursor after an overlapping ordinary refresh (exhausted: $exhausted, strict: $strict)",
    async ({ exhausted, strict }) => {
      const { client } = fixture();
      const history = Array.from({ length: exhausted ? 100 : 150 }, (_, index) => row(index));
      const events = vi
        .spyOn(client, "events")
        .mockImplementation(async (_id, cursor) => readPage(history, cursor));
      const view = renderHook(() => useSessionController({ client, embedded: true }), {
        wrapper: strict ? ({ children }) => <StrictMode>{children}</StrictMode> : undefined,
      });
      await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
      await act(async () => view.result.current.choose("first"));
      await act(async () => view.result.current.earlier());
      const oldest = exhausted ? undefined : "history-50";
      expect(view.result.current.page?.events).toEqual(history.slice(-100));
      expect(view.result.current.page?.next_cursor).toBe(oldest);

      await act(async () => view.result.current.refresh());

      expect(view.result.current.page?.events).toEqual(history.slice(-100));
      expect(view.result.current.page?.next_cursor).toBe(oldest);
      if (!exhausted) {
        await act(async () => view.result.current.earlier());
        expect(events).toHaveBeenLastCalledWith("first", "history-50");
        expect(view.result.current.page?.events).toEqual(history);
        expect(view.result.current.page?.next_cursor).toBeUndefined();
      }
      expect(view.result.current.error).toBe(false);
    },
  );

  it("clears static loaded history and its cursor when an ordinary refresh returns an empty page", async () => {
    const { client } = fixture();
    let history = Array.from({ length: 150 }, (_, index) => row(index));
    vi.spyOn(client, "events").mockImplementation(async (_id, cursor) => readPage(history, cursor));
    const view = renderHook(() => useSessionController({ client, embedded: true }));
    await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
    await act(async () => view.result.current.choose("first"));
    await act(async () => view.result.current.earlier());
    expect(view.result.current.page?.events).toEqual(history.slice(-100));
    expect(view.result.current.page?.next_cursor).toBe("history-50");

    history = [];
    await act(async () => view.result.current.refresh());

    expect(view.result.current.page?.events).toEqual([]);
    expect(view.result.current.page?.next_cursor).toBeUndefined();
    expect(view.result.current.error).toBe(false);
  });

  it("replaces static disjoint history and keeps the replacement's older pages reachable", async () => {
    const { client } = fixture();
    let history = Array.from({ length: 100 }, (_, index) => row(index));
    vi.spyOn(client, "events").mockImplementation(async (_id, cursor) => readPage(history, cursor));
    const view = renderHook(() => useSessionController({ client, embedded: true }));
    await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
    await act(async () => view.result.current.choose("first"));
    await act(async () => view.result.current.earlier());
    expect(view.result.current.page?.events).toEqual(history);
    expect(view.result.current.page?.next_cursor).toBeUndefined();

    history = Array.from({ length: 100 }, (_, index) => row(index + 100));
    await act(async () => view.result.current.refresh());

    expect(view.result.current.page?.events).toEqual(history.slice(-50));
    expect(view.result.current.page?.next_cursor).toBe("history-50");
    await act(async () => view.result.current.earlier());
    expect(view.result.current.page?.events).toEqual(history);
    expect(view.result.current.page?.next_cursor).toBeUndefined();
    expect(view.result.current.error).toBe(false);
  });

  it("keeps all history reachable when pagination finishes before a disjoint ordinary refresh", async () => {
    const { client } = fixture();
    const initial = Array.from({ length: 150 }, (_, index) => row(index));
    const complete = Array.from({ length: 200 }, (_, index) => row(index));
    const pending = deferred<Awaited<ReturnType<WebClient["events"]>>>();
    const events = vi
      .spyOn(client, "events")
      .mockResolvedValueOnce(readPage(initial))
      .mockReturnValueOnce(pending.promise)
      .mockImplementation(async (_id, cursor) => readPage(complete, cursor));
    const view = renderHook(() => useSessionController({ client, embedded: true }));
    await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
    await act(async () => view.result.current.choose("first"));
    let refreshing!: Promise<void>;
    act(() => {
      refreshing = view.result.current.refresh();
    });
    await waitFor(() => expect(events).toHaveBeenCalledTimes(2));
    await act(async () => view.result.current.earlier());
    expect(view.result.current.page?.events).toEqual(initial.slice(50));
    expect(view.result.current.page?.next_cursor).toBe("history-50");
    await act(async () => {
      pending.resolve(readPage(complete));
      await refreshing;
    });

    // A full refresh may replace its visible window. Every omitted page must
    // still be reachable rather than skipped using coverage from that window.
    for (let read = 0; read < 6 && view.result.current.page?.next_cursor; read++)
      await act(async () => view.result.current.earlier());

    expect(view.result.current.page?.events).toEqual(complete);
    expect(view.result.current.page?.next_cursor).toBeUndefined();
    expect(view.result.current.error).toBe(false);
    expect(view.result.current.canSend).toBe(true);
  });

  it("places a delayed initial page before a newer disjoint invalidation page", async () => {
    const { client, streams } = fixture();
    const initial = Array.from({ length: 50 }, (_, index) => row(index));
    const complete = Array.from({ length: 150 }, (_, index) => row(index));
    const pending = deferred<Awaited<ReturnType<WebClient["events"]>>>();
    const events = vi
      .spyOn(client, "events")
      .mockReturnValueOnce(pending.promise)
      .mockImplementation(async (_id, cursor) => readPage(complete, cursor));
    const view = renderHook(() => useSessionController({ client, embedded: true }));
    await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
    let choosing!: Promise<void>;
    act(() => {
      choosing = view.result.current.choose("first");
    });
    await waitFor(() => expect(events).toHaveBeenCalledOnce());
    emitSession(streams.get("first")!, 1, "invalidate", { domains: ["history"] });
    await waitFor(() => expect(view.result.current.page?.events).toEqual(complete.slice(-50)));
    await act(async () => {
      pending.resolve(readPage(initial));
      await choosing;
    });

    expect(view.result.current.page?.events).toEqual([...initial, ...complete.slice(-50)]);
    for (let read = 0; read < 4 && view.result.current.page?.next_cursor; read++)
      await act(async () => view.result.current.earlier());
    expect(view.result.current.page?.events).toEqual(complete);
    expect(view.result.current.page?.next_cursor).toBeUndefined();
    expect(view.result.current.error).toBe(false);
  });

  it("preserves newer full-refresh content, cursor and warnings when an older refresh settles", async () => {
    const { client } = fixture();
    const initial = Array.from({ length: 150 }, (_, index) => row(index));
    const complete = Array.from({ length: 200 }, (_, index) => row(index));
    const current = { ...readPage(complete), warnings: ["current-history-warning"] };
    const pending = deferred<Awaited<ReturnType<WebClient["events"]>>>();
    const events = vi
      .spyOn(client, "events")
      .mockResolvedValueOnce(readPage(initial))
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(current);
    const view = renderHook(() => useSessionController({ client, embedded: true }));
    await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
    await act(async () => view.result.current.choose("first"));
    let olderRefresh!: Promise<void>;
    act(() => {
      olderRefresh = view.result.current.refresh();
    });
    await waitFor(() => expect(events).toHaveBeenCalledTimes(2));
    await act(async () => view.result.current.refresh());
    expect(view.result.current.page).toEqual(current);

    await act(async () => {
      pending.resolve({ ...readPage(initial), warnings: ["obsolete-history-warning"] });
      await olderRefresh;
    });

    expect(view.result.current.page).toEqual(current);
    expect(view.result.current.canSend).toBe(true);
    expect(view.result.current.error).toBe(false);
  });

  it.each(["history invalidation", "native item"] as const)(
    "appends a cache recovery retry after a full refresh establishes history (%s)",
    async (supersedingEvent) => {
      const { client, streams } = fixture();
      const view = renderHook(() => useSessionController({ client, embedded: true }));
      await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
      await act(async () => view.result.current.choose("first"));

      const baseline = Array.from({ length: 100 }, (_, index) => row(index));
      const complete = Array.from({ length: 200 }, (_, index) => row(index));
      const nativeItem = { ...row(99), content: "Newer native content" };
      const visibleBaseline = baseline.slice(-50);
      if (supersedingEvent === "native item") visibleBaseline[49] = nativeItem;
      const pending = deferred<Awaited<ReturnType<WebClient["events"]>>>();
      const events = vi
        .spyOn(client, "events")
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValueOnce(readPage(baseline))
        .mockImplementation(async (_id, cursor) => readPage(complete, cursor));
      const stream = streams.get("first")!;
      emitSession(stream, 1, "snapshot", {
        live: view.result.current.live!,
        items: [],
        historyCacheEpoch: "replacement-cache",
      });
      await waitFor(() => expect(events).toHaveBeenCalledOnce());

      await act(async () => view.result.current.refresh());
      expect(view.result.current.page?.events).toEqual(baseline.slice(-50));
      expect(view.result.current.page?.next_cursor).toBe("history-50");

      if (supersedingEvent === "history invalidation")
        emitSession(stream, 2, "invalidate", { domains: ["history"] });
      else emitSession(stream, 2, "item-upsert", nativeItem);
      await act(async () => pending.resolve(readPage(baseline)));
      await waitFor(() => expect(view.result.current.page?.events).toHaveLength(100));

      expect(events).toHaveBeenCalledTimes(3);
      expect(view.result.current.page?.events).toEqual([
        ...visibleBaseline,
        ...complete.slice(-50),
      ]);
      expect(view.result.current.page?.next_cursor).toBe("history-150");

      await act(async () => view.result.current.earlier());
      expect(events).toHaveBeenLastCalledWith("first", "history-150");
      expect(view.result.current.page?.events).toEqual([
        ...visibleBaseline,
        ...complete.slice(100),
      ]);
      expect(view.result.current.page?.next_cursor).toBe("history-100");
      await act(async () => view.result.current.earlier());
      expect(events).toHaveBeenLastCalledWith("first", "history-100");
      expect(view.result.current.page?.next_cursor).toBe("history-50");
      await act(async () => view.result.current.earlier());
      expect(events).toHaveBeenLastCalledWith("first", "history-50");
      expect(view.result.current.page?.events).toEqual([
        ...complete.slice(0, 50),
        ...visibleBaseline,
        ...complete.slice(100),
      ]);
      expect(view.result.current.page?.next_cursor).toBeUndefined();
      expect(view.result.current.error).toBe(false);
      expect(view.result.current.canSend).toBe(true);
    },
  );

  it.each([
    { removal: "items", retainHistory: false },
    { removal: "turn", retainHistory: false },
    { removal: "items", retainHistory: true },
    { removal: "turn", retainHistory: true },
  ] as const)(
    "orders a cache recovery retry around surviving raw history and native content after $removal removal (retain history: $retainHistory)",
    async ({ removal, retainHistory }) => {
      const { client, sessions, streams } = fixture();
      sessions[0].agent = "codex";
      vi.spyOn(client, "receipt").mockImplementation(async (requestId) => ({
        found: true,
        requestId,
        sessionId: "first",
        operation: "send",
        status: "unknown",
        completionObserved: false,
      }));
      const request = client.request.bind(client);
      const requests = vi
        .spyOn(client, "request")
        .mockImplementation((path, body, signal) =>
          path === "send"
            ? Promise.reject(new Error("send response lost"))
            : request(path, body, signal),
        );
      const view = renderHook(() => useSessionController({ client, embedded: true }));
      await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
      await act(async () => view.result.current.choose("first"));
      act(() => view.result.current.setMessage("Send once"));
      await act(async () => view.result.current.control("send"));
      expect(view.result.current.notice).toBe("uncertain");
      const pendingControl = readPending(pendingScope("", "local"));

      const retained = retainHistory ? [{ ...row(0), turn_id: "retained-turn" }] : [];
      const removed = [
        { ...row(10), turn_id: "removed-turn" },
        { ...row(11), turn_id: "removed-turn" },
      ];
      const recovered = [
        { ...row(1), turn_id: "recovered-turn" },
        { ...row(2), turn_id: "recovered-turn" },
      ];
      const nativeTail = {
        ...row(20),
        id: "native-tail",
        turn_id: "new-turn",
        ephemeral: true,
      };
      const oldest = { ...row(-1), turn_id: "oldest-turn" };
      const pending = deferred<Awaited<ReturnType<WebClient["events"]>>>();
      const events = vi
        .spyOn(client, "events")
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValueOnce({
          events: [...retained, ...removed],
          next_cursor: "older-baseline",
          warnings: [],
        })
        .mockResolvedValueOnce({
          events: [...retained, ...recovered],
          next_cursor: "older-surviving",
          warnings: [],
        })
        .mockResolvedValue({ events: [oldest, ...retained], warnings: [] });
      const stream = streams.get("first")!;
      emitSession(stream, 1, "snapshot", {
        live: view.result.current.live!,
        items: [],
        historyCacheEpoch: "replacement-cache",
      });
      await waitFor(() => expect(events).toHaveBeenCalledOnce());
      await act(async () => view.result.current.refresh());
      expect(view.result.current.page?.events).toEqual([...retained, ...removed]);

      const nativeLive = { ...view.result.current.live!, revision: 2 };
      emitSession(stream, 2, "snapshot", {
        live: nativeLive,
        items: [nativeTail],
        replaceItems: true,
        preserveItemsOutsideCoverage: true,
        ...(removal === "items"
          ? { removedItemIds: removed.map((item) => item.id) }
          : { removedTurnIds: ["removed-turn"] }),
        historyCacheEpoch: "replacement-cache",
      });
      expect(view.result.current.page?.events).toEqual([...retained, nativeTail]);
      await act(async () => pending.resolve({ events: removed, warnings: [] }));
      await waitFor(() => expect(events).toHaveBeenCalledTimes(3));
      await waitFor(() =>
        expect(view.result.current.page?.events).toEqual([...retained, ...recovered, nativeTail]),
      );
      const cursor = retainHistory ? "older-baseline" : "older-surviving";
      expect(view.result.current.page?.next_cursor).toBe(cursor);

      await act(async () => view.result.current.earlier());
      expect(events).toHaveBeenLastCalledWith("first", cursor);
      expect(view.result.current.page?.events).toEqual([
        oldest,
        ...retained,
        ...recovered,
        nativeTail,
      ]);
      expect(view.result.current.page?.next_cursor).toBeUndefined();
      expect(view.result.current.live?.revision).toBe(2);
      expect(view.result.current.error).toBe(false);
      expect(view.result.current.canSend).toBe(false);
      expect(readPending(pendingScope("", "local"))).toEqual(pendingControl);
      expect(requests.mock.calls.filter(([path]) => path === "send")).toHaveLength(1);
    },
  );

  it("places a delayed initial page before a native tail with no shared history IDs", async () => {
    const { client, streams } = fixture();
    const initial = Array.from({ length: 50 }, (_, index) => row(index));
    const tail = { ...row(50), id: "native-tail" };
    const pending = deferred<Awaited<ReturnType<WebClient["events"]>>>();
    const events = vi.spyOn(client, "events").mockReturnValueOnce(pending.promise);
    const view = renderHook(() => useSessionController({ client, embedded: true }));
    await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
    let choosing!: Promise<void>;
    act(() => {
      choosing = view.result.current.choose("first");
    });
    await waitFor(() => expect(events).toHaveBeenCalledOnce());
    emitSession(streams.get("first")!, 1, "item-upsert", tail);
    expect(view.result.current.page?.events).toEqual([tail]);
    await act(async () => {
      pending.resolve(readPage(initial));
      await choosing;
    });

    expect(view.result.current.page?.events).toEqual([...initial, tail]);
    expect(view.result.current.page?.next_cursor).toBeUndefined();
    expect(view.result.current.error).toBe(false);
  });

  it("places the first successful busy-selection baseline before an already delivered native tail", async () => {
    const { client, streams } = fixture();
    const history = Array.from({ length: 50 }, (_, index) => row(index));
    const tail = { ...row(50), id: "native-tail" };
    const pending = deferred<Awaited<ReturnType<WebClient["events"]>>>();
    const events = vi
      .spyOn(client, "events")
      .mockReturnValueOnce(pending.promise)
      .mockRejectedValueOnce(new ApiError(409, "operation_busy", "not-dispatched"))
      .mockImplementation(async (_id, cursor) => readPage(history, cursor));
    const view = renderHook(() => useSessionController({ client, embedded: true }));
    await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
    let choosing!: Promise<void>;
    act(() => {
      choosing = view.result.current.choose("first");
    });
    await waitFor(() => expect(events).toHaveBeenCalledOnce());
    emitSession(streams.get("first")!, 1, "item-upsert", tail);
    await act(async () => {
      pending.reject(new ApiError(409, "operation_busy", "not-dispatched"));
      await choosing;
    });
    await waitFor(() => expect(events).toHaveBeenCalledTimes(2));
    expect(view.result.current.page?.events).toEqual([tail]);
    expect(view.result.current.canSend).toBe(false);

    await act(async () =>
      streams.get("")!.event("control-changed", JSON.stringify({ sessionId: "first" })),
    );

    await waitFor(() => expect(view.result.current.page?.events).toEqual([...history, tail]));
    expect(view.result.current.page?.next_cursor).toBeUndefined();
    await waitFor(() => expect(view.result.current.canSend).toBe(true));
    expect(events).toHaveBeenCalledTimes(3);
    expect(view.result.current.error).toBe(false);
  });
});

describe("busy full-refresh recovery", () => {
  it("inserts empty-scan history before the native tail and restores the original cursor", async () => {
    const { client, streams } = fixture();
    const row = (id: string): ConversationEvent => ({
      id,
      kind: "agent-message",
      content: id,
      attachment_count: 0,
      truncated: false,
    });
    const [a, b, e, f, g] = ["a", "b", "e", "f", "g"].map(row);
    const events = vi
      .spyOn(client, "events")
      .mockResolvedValueOnce({ events: [a, b], next_cursor: "oldest", warnings: [] })
      .mockImplementation(async (_id, cursor) => {
        if (cursor === "scan") return { events: [e, f], next_cursor: "connect-old", warnings: [] };
        if (cursor === "connect-old")
          return { events: [a, b], next_cursor: "provider-older", warnings: [] };
        // A bounded transcript scan can return no visible records and still
        // have a continuation. The native tail has not reached persistence yet.
        return { events: [], next_cursor: "scan", warnings: ["TRANSCRIPT_SCAN_BUDGET"] };
      });
    const view = renderHook(() => useSessionController({ client, embedded: true }));
    await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
    await act(async () => view.result.current.choose("first"));
    emitSession(streams.get("first")!, 1, "item-upsert", g);
    events.mockRejectedValueOnce(new ApiError(409, "operation_busy", "not-dispatched"));
    await act(async () => view.result.current.refresh());
    await act(async () =>
      streams.get("")!.event("control-changed", JSON.stringify({ sessionId: "first" })),
    );
    await waitFor(() => expect(view.result.current.page?.next_cursor).toBe("scan"));
    expect(view.result.current.page?.events).toEqual([a, b, g]);
    await act(async () => view.result.current.earlier());
    expect(view.result.current.page?.events).toEqual([a, b, e, f, g]);
    expect(view.result.current.page?.next_cursor).toBe("connect-old");
    await act(async () => view.result.current.earlier());
    expect(view.result.current.page?.events).toEqual([a, b, e, f, g]);
    expect(view.result.current.page?.next_cursor).toBe("oldest");
    expect(view.result.current.error).toBe(false);
  });

  it.each([
    { toolCount: 2, exhausted: false },
    { toolCount: 26, exhausted: true },
    { toolCount: 76, exhausted: false },
  ])(
    "recovers ordered ACP history across a busy refresh ($toolCount tools, exhausted: $exhausted)",
    async ({ toolCount, exhausted }) => {
      const { client, streams } = fixture();
      const row = (id: string): ConversationEvent => ({
        id,
        kind: "agent-message",
        content: id,
        attachment_count: 0,
        truncated: false,
      });
      const old = Array.from({ length: exhausted ? 100 : 150 }, (_, index) => row(`old-${index}`));
      const loaded = old.slice(-100);
      const previousCursor = exhausted ? undefined : "old-50";
      const tools = Array.from({ length: toolCount }, (_, index): ConversationEvent => ({
        ...row(`call-${index}`),
        kind: "tool-summary",
        tool_name: "read",
        tool_status: "completed",
      }));
      const final = row("final-answer");
      const appended = [
        ...tools.flatMap((item) => [item, { ...item, id: `${item.id}-result` }]),
        final,
      ];
      const complete = [...old, ...appended];
      const events = vi
        .spyOn(client, "events")
        .mockResolvedValueOnce({
          events: old.slice(-50),
          next_cursor: `old-${old.length - 50}`,
          warnings: [],
        })
        .mockResolvedValueOnce({
          events: loaded.slice(0, 50),
          next_cursor: previousCursor,
          warnings: [],
        })
        .mockImplementation(async (_id, cursor) => {
          const end = cursor ? Number(cursor.split("-")[1]) : complete.length;
          const start = Math.max(0, end - 50);
          return {
            events: complete.slice(start, end),
            next_cursor: start ? `new-${start}` : undefined,
            warnings: [],
          };
        });
      const view = renderHook(() => useSessionController({ client, embedded: true }));
      await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
      await act(async () => view.result.current.choose("first"));
      await act(async () => view.result.current.earlier());
      expect(view.result.current.page?.events).toEqual(loaded);
      let seq = 1;
      for (const item of [...tools, final])
        emitSession(streams.get("first")!, seq++, "item-upsert", item);
      events.mockRejectedValueOnce(new ApiError(409, "operation_busy", "not-dispatched"));
      await act(async () => view.result.current.refresh());
      await act(async () =>
        streams.get("")!.event("control-changed", JSON.stringify({ sessionId: "first" })),
      );
      await waitFor(() =>
        expect(
          view.result.current.page?.events.some(
            (item) => item.id === `call-${toolCount - 1}-result`,
          ),
        ).toBe(true),
      );
      await waitFor(() => expect(view.result.current.canSend).toBe(true));
      // A bounded latest page may omit early results. They must be backfilled
      // automatically or remain reachable from the returned historical cursor.
      for (
        let page = 0;
        page < 5 && !view.result.current.page?.events.some((item) => item.id === "call-0-result");
        page++
      ) {
        if (!view.result.current.page?.next_cursor) break;
        await act(async () => view.result.current.earlier());
      }
      const ids = view.result.current.page!.events.map((item) => item.id);
      const expected = [...loaded, ...appended].map((item) => item.id);
      expect(ids.filter((id) => expected.includes(id))).toEqual(expected);
      expect(new Set(ids).size).toBe(ids.length);
      expect(view.result.current.page?.next_cursor).toBe(previousCursor);
      expect(view.result.current.error).toBe(false);
    },
  );

  it.each(["cache-reset", "selection"] as const)(
    "discards an in-flight history gap after %s replaces its scope",
    async (replacement) => {
      const { client, streams } = fixture();
      const row = (id: string): ConversationEvent => ({
        id,
        kind: "agent-message",
        content: id,
        attachment_count: 0,
        truncated: false,
      });
      const old = Array.from({ length: 100 }, (_, index) => row(`old-${index}`));
      const tools = Array.from({ length: 26 }, (_, index): ConversationEvent => ({
        ...row(`call-${index}`),
        kind: "tool-summary",
        tool_name: "read",
        tool_status: "completed",
      }));
      const final = row("final-answer");
      const complete = [
        ...old,
        ...tools.flatMap((item) => [item, { ...item, id: `${item.id}-result` }]),
        final,
      ];
      const gap = deferred<Awaited<ReturnType<WebClient["events"]>>>();
      const fresh = row("replacement-history");
      let gapStarted = false;
      let replaced = false;
      const events = vi
        .spyOn(client, "events")
        .mockResolvedValueOnce({ events: old.slice(50), next_cursor: "old-50", warnings: [] })
        .mockResolvedValueOnce({ events: old.slice(0, 50), warnings: [] })
        .mockImplementation(async (id, cursor) => {
          if (replaced || id === "second") return { events: [fresh], warnings: [] };
          if (cursor?.startsWith("new-")) {
            gapStarted = true;
            return gap.promise;
          }
          return { events: complete.slice(-50), next_cursor: "new-103", warnings: [] };
        });
      const view = renderHook(() => useSessionController({ client, embedded: true }));
      await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
      await act(async () => view.result.current.choose("first"));
      await act(async () => view.result.current.earlier());
      let seq = 1;
      for (const item of [...tools, final])
        emitSession(streams.get("first")!, seq++, "item-upsert", item);
      events.mockRejectedValueOnce(new ApiError(409, "operation_busy", "not-dispatched"));
      await act(async () => view.result.current.refresh());
      await act(async () =>
        streams.get("")!.event("control-changed", JSON.stringify({ sessionId: "first" })),
      );
      await waitFor(() =>
        expect(gapStarted || view.result.current.page?.next_cursor?.startsWith("new-")).toBe(true),
      );
      let paging: Promise<void> | undefined;
      if (!gapStarted)
        act(() => {
          paging = view.result.current.earlier();
        });
      await waitFor(() => expect(gapStarted).toBe(true));
      replaced = true;
      if (replacement === "selection") await act(async () => view.result.current.choose("second"));
      else
        emitSession(streams.get("first")!, seq, "snapshot", {
          live: view.result.current.live!,
          items: [],
          historyCacheEpoch: "replacement-cache",
        });
      await waitFor(() => expect(view.result.current.page?.events).toEqual([fresh]));
      await act(async () => {
        gap.resolve({ events: complete.slice(53, 103), next_cursor: "new-53", warnings: [] });
        await paging;
      });
      await waitFor(() => expect(view.result.current.canSend).toBe(true));
      expect(view.result.current.selected).toBe(replacement === "selection" ? "second" : "first");
      expect(view.result.current.page?.events).toEqual([fresh]);
      expect(view.result.current.page?.next_cursor).toBeUndefined();
      expect(view.result.current.error).toBe(false);
    },
  );

  it.each([
    { coverage: "overlap", exhausted: false, trigger: "invalidation" },
    { coverage: "disjoint", exhausted: false, trigger: "invalidation" },
    { coverage: "native-tools", exhausted: false, trigger: "invalidation" },
    { coverage: "disjoint", exhausted: true, trigger: "invalidation" },
    { coverage: "disjoint", exhausted: false, trigger: "direct-refresh" },
  ] as const)(
    "preserves loaded pages during busy history recovery ($coverage, exhausted: $exhausted, $trigger)",
    async ({ coverage, exhausted, trigger }) => {
      const { client, streams } = fixture();
      const row = (index: number): ConversationEvent => ({
        id: `history-${index}`,
        kind: "agent-message",
        content: `History ${index}`,
        attachment_count: 0,
        truncated: false,
      });
      const older = Array.from({ length: 50 }, (_, index) => row(index - 50));
      const initial = Array.from({ length: 50 }, (_, index) => row(index));
      const tools = Array.from({ length: 25 }, (_, index): ConversationEvent => ({
        ...row(index),
        id: `call-${index}`,
        kind: "tool-summary",
        tool_name: "read",
        tool_status: "completed",
      }));
      const final = { ...row(100), id: "final-answer" };
      const latest =
        coverage === "native-tools"
          ? [...tools.flatMap((tool) => [tool, { ...tool, id: `${tool.id}-result` }]), final].slice(
              1,
            )
          : Array.from({ length: 50 }, (_, index) =>
              row(index + (coverage === "overlap" ? 25 : 50)),
            );
      const events = vi
        .spyOn(client, "events")
        .mockResolvedValueOnce({ events: initial, next_cursor: "older", warnings: [] })
        .mockResolvedValueOnce({
          events: older,
          next_cursor: exhausted ? undefined : "oldest",
          warnings: [],
        })
        .mockImplementation(async (_id, cursor) =>
          cursor === "new-window"
            ? {
                events: coverage === "native-tools" ? [...initial.slice(1), tools[0]] : initial,
                next_cursor: "older",
                warnings: [],
              }
            : { events: latest, next_cursor: "new-window", warnings: [] },
        );
      const view = renderHook(() => useSessionController({ client, embedded: true }));
      await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
      await act(async () => view.result.current.choose("first"));
      await act(async () => view.result.current.earlier());
      expect(view.result.current.page?.events).toHaveLength(100);
      const stream = streams.get("first")!;
      let seq = 1;
      if (coverage === "native-tools") {
        // ACP streams publish toolCallId, while persisted history additionally
        // contains toolCallId-result. Deliver every live item before the read.
        for (const item of [...tools, final]) emitSession(stream, seq++, "item-upsert", item);
        expect(view.result.current.page?.events.some((item) => item.id === "final-answer")).toBe(
          true,
        );
        expect(view.result.current.page?.events.some((item) => item.id === "call-0-result")).toBe(
          false,
        );
      }
      events.mockRejectedValueOnce(new ApiError(409, "operation_busy", "not-dispatched"));
      if (trigger === "direct-refresh") {
        await act(async () => view.result.current.refresh());
        expect(view.result.current.page?.events).toEqual([...older, ...initial]);
        expect(view.result.current.page?.next_cursor).toBe("oldest");
        expect(view.result.current.canSend).toBe(false);
        // This recovery waits for settlement instead of immediately entering
        // through a selected history invalidation's readBusy fallback.
        await act(async () =>
          streams.get("")!.event("control-changed", JSON.stringify({ sessionId: "first" })),
        );
      } else emitSession(stream, seq, "invalidate", { domains: ["history"] });
      await waitFor(() =>
        expect(view.result.current.page?.events).toEqual(expect.arrayContaining(latest)),
      );
      expect(view.result.current.page?.events).toEqual(
        expect.arrayContaining([...older, ...initial]),
      );
      // A disjoint latest window has an unverified gap even if the old history
      // reached its beginning. Bridge that window before restoring its cursor.
      if (view.result.current.page?.next_cursor === "new-window")
        await act(async () => view.result.current.earlier());
      expect(view.result.current.page?.events).toEqual(
        expect.arrayContaining([...older, ...initial, ...latest]),
      );
      expect(view.result.current.page?.next_cursor).toBe(exhausted ? undefined : "oldest");
      const ids = view.result.current.page!.events.map((item) => item.id);
      expect(new Set(ids).size).toBe(ids.length);
      await waitFor(() => expect(view.result.current.canSend).toBe(true));
      expect(view.result.current.error).toBe(false);
    },
  );

  it("keeps the first history cursor when busy selection already has native items", async () => {
    const { client, streams } = fixture();
    const item: ConversationEvent = {
      id: "native-reply",
      kind: "agent-message",
      content: "Live reply before history loads",
      attachment_count: 0,
      truncated: false,
    };
    const initial = deferred<Awaited<ReturnType<WebClient["events"]>>>();
    const events = vi
      .spyOn(client, "events")
      .mockReturnValueOnce(initial.promise)
      .mockResolvedValue({ events: [item], next_cursor: "first-history-older", warnings: [] });
    const view = renderHook(() => useSessionController({ client, embedded: true }));
    await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
    let choosing!: Promise<void>;
    act(() => {
      choosing = view.result.current.choose("first");
    });
    await waitFor(() => expect(events).toHaveBeenCalledOnce());
    emitSession(streams.get("first")!, 1, "item-upsert", item);
    expect(view.result.current.page?.events).toEqual([item]);
    expect(view.result.current.page?.next_cursor).toBeUndefined();
    await act(async () => {
      initial.reject(new ApiError(409, "operation_busy", "not-dispatched"));
      await choosing;
    });
    await waitFor(() => expect(view.result.current.page?.next_cursor).toBe("first-history-older"));
    expect(view.result.current.page?.events).toEqual([item]);
    await waitFor(() => expect(view.result.current.canSend).toBe(true));
    expect(view.result.current.error).toBe(false);
  });

  it("discards loaded pages and an in-flight busy recovery when the history cache changes", async () => {
    const { client, streams } = fixture();
    const row = (id: string): ConversationEvent => ({
      id,
      kind: "agent-message",
      content: id,
      attachment_count: 0,
      truncated: false,
    });
    const expired = deferred<Awaited<ReturnType<WebClient["events"]>>>();
    const fresh = row("fresh-cache-item");
    const events = vi
      .spyOn(client, "events")
      .mockResolvedValueOnce({ events: [row("initial")], next_cursor: "older", warnings: [] })
      .mockResolvedValueOnce({ events: [row("old-page")], next_cursor: "oldest", warnings: [] })
      .mockRejectedValueOnce(new ApiError(409, "operation_busy", "not-dispatched"))
      .mockReturnValueOnce(expired.promise)
      .mockResolvedValue({ events: [fresh], next_cursor: "fresh-older", warnings: [] });
    const view = renderHook(() => useSessionController({ client, embedded: true }));
    await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
    await act(async () => view.result.current.choose("first"));
    await act(async () => view.result.current.earlier());
    expect(view.result.current.page?.events).toHaveLength(2);
    emitSession(streams.get("first")!, 1, "invalidate", { domains: ["history"] });
    await waitFor(() => expect(events).toHaveBeenCalledTimes(4));
    emitSession(streams.get("first")!, 2, "snapshot", {
      live: view.result.current.live!,
      items: [],
      historyCacheEpoch: "fresh-cache",
    });
    await waitFor(() => expect(view.result.current.page?.events).toEqual([fresh]));
    await act(async () => {
      expired.resolve({ events: [row("expired-response")], next_cursor: "expired", warnings: [] });
    });
    await waitFor(() => expect(view.result.current.canSend).toBe(true));
    expect(view.result.current.page?.events).toEqual([fresh]);
    expect(view.result.current.page?.next_cursor).toBe("fresh-older");
    expect(view.result.current.error).toBe(false);
  });

  it.each(["turn", "item"] as const)(
    "honors native %s removal while busy recovery preserves surviving pages",
    async (removal) => {
      const { client, streams } = fixture();
      const row = (id: string, turn: string): ConversationEvent => ({
        id,
        turn_id: turn,
        kind: "agent-message",
        content: id,
        attachment_count: 0,
        truncated: false,
      });
      const removed = [row("removed-old", "removed-turn"), row("removed-current", "removed-turn")];
      const retained = [row("retained-old", "kept-turn"), row("retained-current", "kept-turn")];
      const fresh = row("new-result", "new-turn");
      vi.spyOn(client, "events")
        .mockResolvedValueOnce({
          events: [removed[1], retained[1]],
          next_cursor: "older",
          warnings: [],
        })
        .mockResolvedValueOnce({
          events: [removed[0], retained[0]],
          next_cursor: "oldest",
          warnings: [],
        })
        .mockRejectedValueOnce(new ApiError(409, "operation_busy", "not-dispatched"))
        // Persistence can still contain a row already removed by native state.
        .mockResolvedValue({
          events: [...removed, fresh],
          next_cursor: "new-window",
          warnings: [],
        });
      const view = renderHook(() => useSessionController({ client, embedded: true }));
      await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
      await act(async () => view.result.current.choose("first"));
      await act(async () => view.result.current.earlier());
      expect(view.result.current.page?.events).toHaveLength(4);
      emitSession(streams.get("first")!, 1, "snapshot", {
        live: view.result.current.live!,
        items: [],
        replaceItems: true,
        preserveItemsOutsideCoverage: true,
        ...(removal === "turn"
          ? { removedTurnIds: ["removed-turn"] }
          : { removedItemIds: removed.map((item) => item.id) }),
      });
      expect(view.result.current.page?.events).toEqual(retained);
      emitSession(streams.get("first")!, 2, "invalidate", { domains: ["history"] });
      await waitFor(() => expect(view.result.current.page?.events).toContainEqual(fresh));
      expect(view.result.current.page?.events).toEqual([...retained, fresh]);
      expect(view.result.current.page?.next_cursor).toBe("oldest");
      await waitFor(() => expect(view.result.current.canSend).toBe(true));
    },
  );

  it("recovers the selected conversation when a different conversation settles", async () => {
    const { client, streams } = fixture();
    const view = renderHook(() => useSessionController({ client, embedded: true }));
    await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
    await act(async () => view.result.current.choose("first"));
    await waitFor(() => expect(view.result.current.canSend).toBe(true));
    vi.spyOn(client, "catalog").mockRejectedValueOnce(
      new ApiError(409, "operation_busy", "not-dispatched"),
    );
    await act(async () => view.result.current.refresh());
    const history = vi.spyOn(client, "events");
    const live = vi
      .spyOn(client, "live")
      .mockRejectedValueOnce(new ApiError(409, "operation_busy", "not-dispatched"));
    await act(async () =>
      streams.get("first")!.event("control-changed", JSON.stringify({ sessionId: "first" })),
    );
    expect(live).toHaveBeenCalledOnce();
    expect(view.result.current.canSend).toBe(false);
    // The shared admission is now held by a command on another conversation.
    // Its settlement has no matching notification on the selected stream.
    await act(async () =>
      streams.get("")!.event("control-changed", JSON.stringify({ sessionId: "second" })),
    );
    await waitFor(() => expect(view.result.current.canSend).toBe(true));
    expect(history).toHaveBeenCalledOnce();
    expect(live).toHaveBeenCalledTimes(2);
    expect(view.result.current.selected).toBe("first");
    expect(view.result.current.error).toBe(false);
  });

  it("recovers from a delayed busy calibration after another conversation wakes a fresh refresh", async () => {
    const { client, streams } = fixture();
    const view = renderHook(() => useSessionController({ client, embedded: true }));
    await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
    await act(async () => view.result.current.choose("first"));
    await waitFor(() => expect(view.result.current.canSend).toBe(true));
    vi.spyOn(client, "catalog").mockRejectedValueOnce(
      new ApiError(409, "operation_busy", "not-dispatched"),
    );
    await act(async () => view.result.current.refresh());
    const delayedBusy = deferred<never>();
    const live = vi.spyOn(client, "live").mockReturnValueOnce(delayedBusy.promise);
    const history = vi.spyOn(client, "events");
    await act(async () =>
      streams.get("first")!.event("control-changed", JSON.stringify({ sessionId: "first" })),
    );
    expect(live).toHaveBeenCalledOnce();
    // The selected HTTP response is delayed in transit. The other command
    // settles, and the subsequent complete refresh can already read fresh idle.
    await act(async () =>
      streams.get("")!.event("control-changed", JSON.stringify({ sessionId: "second" })),
    );
    await waitFor(() => expect(history).toHaveBeenCalledOnce());
    expect(live).toHaveBeenCalledTimes(2);
    await act(async () =>
      delayedBusy.reject(new ApiError(409, "operation_busy", "not-dispatched")),
    );
    await waitFor(() => expect(view.result.current.canSend).toBe(true));
    expect(view.result.current.error).toBe(false);
    const settledReads = { history: history.mock.calls.length, live: live.mock.calls.length };
    await act(async () => {});
    expect(history).toHaveBeenCalledTimes(settledReads.history);
    expect(live).toHaveBeenCalledTimes(settledReads.live);
  });

  it("retains full-refresh recovery when settlement collides with another busy command", async () => {
    const { client, streams } = fixture();
    const view = renderHook(() => useSessionController({ client, embedded: true }));
    await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
    await act(async () => view.result.current.choose("first"));
    await waitFor(() => expect(view.result.current.canSend).toBe(true));
    const access = vi.spyOn(client, "access");
    const history = vi.spyOn(client, "events");
    vi.spyOn(client, "catalog").mockRejectedValueOnce(
      new ApiError(409, "operation_busy", "not-dispatched"),
    );
    await act(async () => view.result.current.refresh());
    const nativeLive = client.live.bind(client);
    let nextCommandBusy = true;
    const live = vi
      .spyOn(client, "live")
      .mockImplementation((id) =>
        nextCommandBusy
          ? Promise.reject(new ApiError(409, "operation_busy", "not-dispatched"))
          : nativeLive(id),
      );
    const settle = () => {
      const data = JSON.stringify({ sessionId: "first" });
      streams.get("")!.event("control-changed", data);
      streams.get("first")!.event("control-changed", data);
    };
    await act(async () => settle());
    await waitFor(() => expect(live).toHaveBeenCalled());
    expect(view.result.current.canSend).toBe(false);
    const busyReads = { history: history.mock.calls.length, live: live.mock.calls.length };
    await act(async () => {});
    expect(history).toHaveBeenCalledTimes(busyReads.history);
    expect(live).toHaveBeenCalledTimes(busyReads.live);
    const accessBefore = access.mock.calls.length;
    nextCommandBusy = false;
    await act(async () => settle());
    await waitFor(() => expect(view.result.current.canSend).toBe(true));
    expect(access.mock.calls.length).toBeGreaterThan(accessBefore);
    expect(history.mock.calls.length).toBeGreaterThan(busyReads.history);
    expect(live.mock.calls.length).toBeGreaterThan(busyReads.live);
    expect(view.result.current.error).toBe(false);
    const settledReads = { history: history.mock.calls.length, live: live.mock.calls.length };
    await act(async () => {});
    expect(history).toHaveBeenCalledTimes(settledReads.history);
    expect(live).toHaveBeenCalledTimes(settledReads.live);
  });

  it("does not enable from an old refresh after selected control calibration becomes busy", async () => {
    const { client, streams } = fixture();
    const view = renderHook(() => useSessionController({ client, embedded: true }));
    await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
    await act(async () => view.result.current.choose("first"));
    await waitFor(() => expect(view.result.current.canSend).toBe(true));
    const oldHistory = deferred<Awaited<ReturnType<WebClient["events"]>>>();
    const history = vi.spyOn(client, "events").mockReturnValueOnce(oldHistory.promise);
    const live = vi.spyOn(client, "live");
    const access = vi.spyOn(client, "access");
    let refreshing!: Promise<void>;
    act(() => {
      refreshing = view.result.current.refresh();
    });
    await waitFor(() => {
      expect(history).toHaveBeenCalledOnce();
      expect(live).toHaveBeenCalledOnce();
    });
    await act(async () => {});
    // The old full refresh already received idle. A newer admission-busy
    // control read invalidates that evidence before its history read completes.
    live.mockRejectedValueOnce(new ApiError(409, "operation_busy", "not-dispatched"));
    await act(async () =>
      streams.get("first")!.event("control-changed", JSON.stringify({ sessionId: "first" })),
    );
    expect(live).toHaveBeenCalledTimes(2);
    await act(async () => {
      oldHistory.resolve({ events: [], warnings: [] });
      await refreshing;
    });
    expect(view.result.current.canSend).toBe(false);
    expect(history).toHaveBeenCalledOnce();
    const accessBefore = access.mock.calls.length;
    await act(async () => {
      const data = JSON.stringify({ sessionId: "first" });
      streams.get("")!.event("control-changed", data);
      streams.get("first")!.event("control-changed", data);
    });
    await waitFor(() => expect(view.result.current.canSend).toBe(true));
    expect(access.mock.calls.length).toBeGreaterThan(accessBefore);
    expect(history).toHaveBeenCalledTimes(2);
    expect(view.result.current.error).toBe(false);
  });

  it.each(["live", "events"] as const)(
    "does not conceal a real sibling failure after the %s refresh read is busy",
    async (blockedStage) => {
      const { client, streams } = fixture();
      const view = renderHook(() => useSessionController({ client, embedded: true }));
      await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
      await act(async () => view.result.current.choose("first"));
      await waitFor(() => expect(view.result.current.canSend).toBe(true));
      const failure = deferred<never>();
      const history = vi.spyOn(client, "events");
      const live = vi.spyOn(client, "live");
      const reads = { events: history, live };
      reads[blockedStage].mockRejectedValueOnce(
        new ApiError(409, "operation_busy", "not-dispatched"),
      );
      reads[blockedStage === "live" ? "events" : "live"].mockReturnValueOnce(failure.promise);
      let refreshing!: Promise<void>;
      act(() => {
        refreshing = view.result.current.refresh();
      });
      await waitFor(() => {
        expect(history).toHaveBeenCalledOnce();
        expect(live).toHaveBeenCalledOnce();
      });
      await act(async () => {
        failure.reject(new Error("genuine sibling read failure"));
        await refreshing;
      });
      expect(view.result.current.error).toBe(true);
      await act(async () => streams.get("")!.event("control-changed", "{}"));
      expect(history).toHaveBeenCalledOnce();
      expect(live).toHaveBeenCalledOnce();
      expect(view.result.current.error).toBe(true);
      expect(view.result.current.canSend).toBe(false);
    },
  );

  it.each(["catalog-invalidated", "reconnect"])(
    "rechecks access, history and live after a busy refresh receives %s",
    async (trigger) => {
      const { client, streams } = fixture();
      const view = renderHook(() => useSessionController({ client, embedded: true }));
      await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
      await act(async () => view.result.current.choose("first"));
      await waitFor(() => expect(view.result.current.canSend).toBe(true));
      const access = vi.spyOn(client, "access");
      const history = vi.spyOn(client, "events");
      const live = vi.spyOn(client, "live");
      vi.spyOn(client, "catalog").mockRejectedValueOnce(
        new ApiError(409, "operation_busy", "not-dispatched"),
      );
      await act(async () => view.result.current.refresh());
      expect(view.result.current.canSend).toBe(false);
      act(() => {
        if (trigger === "reconnect") streams.get("")!.open();
        else streams.get("")!.event(trigger, "{}");
      });
      await waitFor(() => expect(view.result.current.canSend).toBe(true));
      expect(access.mock.calls.length).toBeGreaterThan(1);
      expect(history).toHaveBeenCalled();
      expect(live).toHaveBeenCalled();
      expect(view.result.current.error).toBe(false);
    },
  );

  it.each(["catalog", "live", "events"] as const)(
    "does not consume settlement arriving before the busy %s response",
    async (stage) => {
      const { client, streams } = fixture();
      const view = renderHook(() => useSessionController({ client, embedded: true }));
      await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
      await act(async () => view.result.current.choose("first"));
      await waitFor(() => expect(view.result.current.canSend).toBe(true));
      const pending = deferred<never>();
      const blocked = vi.spyOn(client, stage).mockReturnValueOnce(pending.promise);
      let refreshing!: Promise<void>;
      act(() => {
        refreshing = view.result.current.refresh();
      });
      await waitFor(() => expect(blocked).toHaveBeenCalledOnce());
      await act(async () => {
        streams.get("")!.event("control-changed", JSON.stringify({ sessionId: "first" }));
      });
      expect(view.result.current.canSend).toBe(false);
      await act(async () => {
        pending.reject(new ApiError(409, "operation_busy", "not-dispatched"));
        await refreshing;
      });
      await waitFor(() => expect(view.result.current.canSend).toBe(true));
      expect(view.result.current.error).toBe(false);
      expect(blocked.mock.calls.length).toBeGreaterThan(1);
    },
  );

  it("waits for another event if full-refresh recovery is still busy", async () => {
    const { client, streams } = fixture();
    const view = renderHook(() => useSessionController({ client, embedded: true }));
    await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
    await act(async () => view.result.current.choose("first"));
    await waitFor(() => expect(view.result.current.canSend).toBe(true));
    const history = vi
      .spyOn(client, "events")
      .mockRejectedValueOnce(new ApiError(409, "operation_busy", "not-dispatched"))
      .mockRejectedValueOnce(new ApiError(409, "operation_busy", "not-dispatched"));
    await act(async () => view.result.current.refresh());
    act(() => streams.get("")!.event("catalog-invalidated", "{}"));
    await waitFor(() => expect(history).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(history).toHaveBeenCalledTimes(2);
    expect(view.result.current.canSend).toBe(false);
    act(() => streams.get("")!.event("control-changed", "{}"));
    await waitFor(() => expect(view.result.current.canSend).toBe(true));
    expect(history).toHaveBeenCalledTimes(3);
    expect(view.result.current.error).toBe(false);
  });

  it.each(["selection", "refresh"] as const)(
    "does not release a newer %s while the previous busy refresh waits for settlement",
    async (replacement) => {
      const { client, streams } = fixture();
      const view = renderHook(() => useSessionController({ client, embedded: true }));
      await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
      await act(async () => view.result.current.choose("first"));
      await waitFor(() => expect(view.result.current.canSend).toBe(true));
      vi.spyOn(client, "catalog").mockRejectedValueOnce(
        new ApiError(409, "operation_busy", "not-dispatched"),
      );
      await act(async () => view.result.current.refresh(true));
      if (replacement === "selection") await act(async () => view.result.current.choose("second"));
      const pending = deferred<Awaited<ReturnType<WebClient["events"]>>>();
      const history = vi.spyOn(client, "events").mockReturnValueOnce(pending.promise);
      let replacementRead!: Promise<void>;
      act(() => {
        replacementRead = view.result.current.refresh();
      });
      await waitFor(() => expect(history).toHaveBeenCalledOnce());
      await act(async () => {
        streams.get("")!.event("control-changed", JSON.stringify({ sessionId: "first" }));
      });
      expect(history).toHaveBeenCalledOnce();
      expect(view.result.current.canSend).toBe(false);
      await act(async () => {
        pending.resolve({ events: [], warnings: [] });
        await replacementRead;
      });
      expect(view.result.current.selected).toBe(replacement === "selection" ? "second" : "first");
      expect(view.result.current.canSend).toBe(true);
    },
  );

  it.each(["revocation", "boot change"])(
    "does not recover the previous scope after %s",
    async (change) => {
      const { client, streams, host } = fixture();
      const view = renderHook(() => useSessionController({ client, embedded: true }));
      await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
      await act(async () => view.result.current.choose("first"));
      await waitFor(() => expect(view.result.current.canSend).toBe(true));
      vi.spyOn(client, "catalog").mockRejectedValueOnce(
        new ApiError(409, "operation_busy", "not-dispatched"),
      );
      await act(async () => view.result.current.refresh());
      const access = vi.spyOn(client, "access");
      const history = vi.spyOn(client, "events");
      const oldGlobal = streams.get("")!;
      await act(async () => {
        if (change === "revocation") oldGlobal.event("access-ended", "{}");
        else {
          host.bootId = "replacement-boot";
          oldGlobal.event("access-changed", "{}");
        }
      });
      await waitFor(() => expect(view.result.current.selected).toBe(""));
      await act(async () => oldGlobal.event("control-changed", "{}"));
      expect(history).not.toHaveBeenCalled();
      expect(view.result.current.canSend).toBe(false);
      if (change === "revocation") {
        expect(view.result.current.access?.status).toBe("ended");
        expect(access).not.toHaveBeenCalled();
      } else expect(view.result.current.access?.bootId).toBe("replacement-boot");
    },
  );

  it.each([false, true])(
    "does not acknowledge a new unknown outcome through an old manual retry (durable: %s)",
    async (durable) => {
      const { client, streams, sessions } = fixture();
      sessions[0].agent = durable ? "codex" : "antigravity";
      vi.spyOn(client, "receipt").mockImplementation(async (requestId) => ({
        found: true,
        requestId,
        sessionId: "first",
        operation: "send",
        status: "unknown",
        completionObserved: false,
      }));
      const view = renderHook(() => useSessionController({ client, embedded: true }));
      await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
      await act(async () => view.result.current.choose("first"));
      await waitFor(() => expect(view.result.current.canSend).toBe(true));
      const sending = deferred<never>();
      const request = client.request.bind(client);
      const requests = vi
        .spyOn(client, "request")
        .mockImplementation((path, body, signal) =>
          path === "send" ? sending.promise : request(path, body, signal),
        );
      act(() => view.result.current.setMessage("Dispatch once"));
      let sent!: ReturnType<typeof view.result.current.control>;
      act(() => {
        sent = view.result.current.control("send");
      });
      await waitFor(() =>
        expect(requests.mock.calls.filter(([path]) => path === "send")).toHaveLength(1),
      );
      vi.spyOn(client, "catalog").mockRejectedValueOnce(
        new ApiError(409, "operation_busy", "not-dispatched"),
      );
      await act(async () => view.result.current.refresh(true));
      await act(async () => {
        sending.reject(new Error("send response lost after manual refresh"));
        await sent;
      });
      expect(view.result.current.notice).toBe("uncertain");
      const pending = readPending(pendingScope("", "local"));
      expect(pending).toHaveLength(durable ? 1 : 0);
      await act(async () => {
        streams.get("")!.event("control-changed", JSON.stringify({ sessionId: "first" }));
        streams.get("")!.event("catalog-invalidated", "{}");
      });
      emitSession(streams.get("first")!, 1, "state", { revision: 2 });
      expect(view.result.current.canSend).toBe(false);
      expect(readPending(pendingScope("", "local"))).toEqual(pending);
      expect(requests.mock.calls.filter(([path]) => path === "send")).toHaveLength(1);
    },
  );

  it.each([
    { stage: "catalog", manual: false },
    { stage: "catalog", manual: true },
    { stage: "live", manual: false },
    { stage: "live", manual: true },
    { stage: "events", manual: false },
    { stage: "events", manual: true },
  ] as const)(
    "recalibrates a busy $stage read after control settlement (manual: $manual)",
    async ({ stage, manual }) => {
      const { client, streams } = fixture();
      const view = renderHook(() => useSessionController({ client, embedded: true }));
      await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
      await act(async () => view.result.current.choose("first"));
      await waitFor(() => expect(view.result.current.canSend).toBe(true));
      const access = vi.spyOn(client, "access");
      const history = vi.spyOn(client, "events");
      const live = vi.spyOn(client, "live");
      const catalog = vi.spyOn(client, "catalog");
      const blocked = { catalog, live, events: history }[stage];
      blocked.mockRejectedValueOnce(new ApiError(409, "operation_busy", "not-dispatched"));
      await act(async () => view.result.current.refresh(manual));
      expect(blocked).toHaveBeenCalledOnce();
      expect(view.result.current.canSend).toBe(false);
      await act(async () => {});
      // A busy read must wait for a host event, never spin on the same admission.
      expect(blocked).toHaveBeenCalledOnce();
      const readsBefore = {
        access: access.mock.calls.length,
        history: history.mock.calls.length,
        live: live.mock.calls.length,
      };
      act(() => streams.get("")!.event("control-changed", JSON.stringify({ sessionId: "first" })));
      await waitFor(() => expect(view.result.current.canSend).toBe(true));
      expect(access.mock.calls.length).toBeGreaterThan(readsBefore.access);
      expect(history.mock.calls.length).toBeGreaterThan(readsBefore.history);
      expect(live.mock.calls.length).toBeGreaterThan(readsBefore.live);
      expect(view.result.current.page?.events[0].content).toBe("first history");
      expect(view.result.current.error).toBe(false);
      expect(view.result.current.online).toBe(true);
    },
  );
});

describe("event-driven refresh completion", () => {
  it("recovers catalog and controls after an admission-busy read and final invalidation", async () => {
    const { client, sessions, streams } = fixture();
    const view = renderHook(() => useSessionController({ client, embedded: true }));
    await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
    await act(async () => view.result.current.choose("first"));
    await waitFor(() => expect(view.result.current.canSend).toBe(true));
    const catalog = vi
      .spyOn(client, "catalog")
      .mockRejectedValueOnce(new ApiError(409, "operation_busy", "not-dispatched"));
    act(() => streams.get("")!.event("catalog-invalidated", "{}"));
    await waitFor(() => expect(catalog).toHaveBeenCalledOnce());
    await act(async () => {});
    sessions.push({ ...sessions[0], id: "created-elsewhere", title: "New conversation" });
    await act(async () => {
      streams.get("")!.event("catalog-invalidated", "{}");
      streams.get("first")!.event("control-changed", JSON.stringify({ sessionId: "first" }));
    });
    await waitFor(() => expect(view.result.current.sessions).toHaveLength(3));
    expect(view.result.current.sessions[2].id).toBe("created-elsewhere");
    expect(view.result.current.online).toBe(true);
    expect(view.result.current.error).toBe(false);
    expect(view.result.current.canSend).toBe(true);
    expect(catalog).toHaveBeenCalledTimes(2);
  });

  it.each([
    { manual: false, cacheReset: false },
    { manual: true, cacheReset: false },
    { manual: false, cacheReset: true },
    { manual: true, cacheReset: true },
  ])(
    "finishes a refresh superseded by successful event history (manual: $manual, cache reset: $cacheReset)",
    async ({ manual, cacheReset }) => {
      const { client, streams } = fixture();
      const view = renderHook(() => useSessionController({ client, embedded: true }));
      await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
      await act(async () => view.result.current.choose("first"));
      await waitFor(() => expect(view.result.current.canSend).toBe(true));
      const old = deferred<Awaited<ReturnType<WebClient["events"]>>>();
      const events = vi.spyOn(client, "events").mockReturnValueOnce(old.promise);
      let refreshing!: Promise<void>;
      act(() => {
        refreshing = view.result.current.refresh(manual);
      });
      await waitFor(() => expect(events).toHaveBeenCalledOnce());
      const originalStream = streams.get("first")!;
      if (cacheReset)
        emitSession(originalStream, 1, "snapshot", {
          live: view.result.current.live!,
          items: [],
          historyCacheEpoch: "fresh-cache",
        });
      else emitSession(originalStream, 1, "invalidate", { domains: ["history"] });
      await waitFor(() => expect(events).toHaveBeenCalledTimes(2));
      await act(async () => {});
      await act(async () => {
        old.reject(new Error("superseded history failure"));
        await refreshing;
      });
      const currentStream = streams.get("first")!;
      emitSession(currentStream, currentStream === originalStream ? 2 : 1, "state", {
        revision: 2,
      });
      expect(view.result.current.page?.events[0].content).toBe("first history");
      expect(view.result.current.online).toBe(true);
      expect(view.result.current.error).toBe(false);
      expect(view.result.current.canSend).toBe(true);
    },
  );

  it.each([false, true])(
    "does not clear an unknown send while recovering a busy catalog (durable: %s)",
    async (durable) => {
      const { client, sessions, streams } = fixture();
      if (durable) sessions[0].agent = "codex";
      vi.spyOn(client, "receipt").mockImplementation(async (requestId) => ({
        found: true,
        requestId,
        sessionId: "first",
        operation: "send",
        status: "unknown",
        completionObserved: false,
      }));
      const request = client.request.bind(client);
      const requests = vi
        .spyOn(client, "request")
        .mockImplementation((path, body, signal) =>
          path === "send"
            ? Promise.reject(new Error("send response lost"))
            : request(path, body, signal),
        );
      const view = renderHook(() => useSessionController({ client, embedded: true }));
      await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
      await act(async () => view.result.current.choose("first"));
      act(() => view.result.current.setMessage("Send once"));
      await act(async () => view.result.current.control("send"));
      expect(view.result.current.notice).toBe("uncertain");
      const pending = readPending(pendingScope("", "local"));
      const catalog = vi
        .spyOn(client, "catalog")
        .mockRejectedValueOnce(new ApiError(409, "operation_busy", "not-dispatched"));
      act(() => streams.get("")!.event("catalog-invalidated", "{}"));
      await waitFor(() => expect(catalog).toHaveBeenCalledOnce());
      await act(async () => {});
      sessions[1].title = "Updated elsewhere";
      await act(async () => {
        streams.get("")!.event("catalog-invalidated", "{}");
        streams.get("first")!.event("control-changed", JSON.stringify({ sessionId: "first" }));
      });
      await waitFor(() => expect(view.result.current.sessions[1].title).toBe("Updated elsewhere"));
      expect(view.result.current.canSend).toBe(false);
      expect(readPending(pendingScope("", "local"))).toEqual(pending);
      expect(requests.mock.calls.filter(([path]) => path === "send")).toHaveLength(1);
    },
  );

  it.each([
    { manual: false, durable: false },
    { manual: false, durable: true },
    { manual: true, durable: true },
  ])(
    "retains unknown sends through superseded history recovery (manual: $manual, durable: $durable)",
    async ({ manual, durable }) => {
      const { client, sessions, streams } = fixture();
      if (durable) sessions[0].agent = "codex";
      vi.spyOn(client, "receipt").mockImplementation(async (requestId) => ({
        found: true,
        requestId,
        sessionId: "first",
        operation: "send",
        status: "unknown",
        completionObserved: false,
      }));
      const request = client.request.bind(client);
      const requests = vi
        .spyOn(client, "request")
        .mockImplementation((path, body, signal) =>
          path === "send"
            ? Promise.reject(new Error("send response lost"))
            : request(path, body, signal),
        );
      const view = renderHook(() => useSessionController({ client, embedded: true }));
      await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
      await act(async () => view.result.current.choose("first"));
      act(() => view.result.current.setMessage("Send once"));
      await act(async () => view.result.current.control("send"));
      expect(view.result.current.notice).toBe("uncertain");
      const pending = readPending(pendingScope("", "local"));
      const old = deferred<Awaited<ReturnType<WebClient["events"]>>>();
      const events = vi.spyOn(client, "events").mockReturnValueOnce(old.promise);
      let refreshing!: Promise<void>;
      act(() => {
        refreshing = view.result.current.refresh(manual);
      });
      await waitFor(() => expect(events).toHaveBeenCalledOnce());
      const originalStream = streams.get("first")!;
      emitSession(originalStream, 1, "invalidate", { domains: ["history"] });
      await waitFor(() => expect(events).toHaveBeenCalledTimes(2));
      await act(async () => {});
      await act(async () => {
        old.reject(new Error("superseded history failure"));
        await refreshing;
      });
      const currentStream = streams.get("first")!;
      emitSession(currentStream, currentStream === originalStream ? 2 : 1, "state", {
        revision: 2,
      });
      expect(view.result.current.error).toBe(false);
      expect(view.result.current.canSend).toBe(false);
      expect(readPending(pendingScope("", "local"))).toEqual(pending);
      expect(requests.mock.calls.filter(([path]) => path === "send")).toHaveLength(1);
    },
  );

  it("does not release a newer same-session refresh when the older history read is superseded", async () => {
    const { client, streams } = fixture();
    const view = renderHook(() => useSessionController({ client, embedded: true }));
    await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
    await act(async () => view.result.current.choose("first"));
    const old = deferred<Awaited<ReturnType<WebClient["events"]>>>();
    const events = vi.spyOn(client, "events").mockReturnValueOnce(old.promise);
    let olderRefresh!: Promise<void>;
    act(() => {
      olderRefresh = view.result.current.refresh();
    });
    await waitFor(() => expect(events).toHaveBeenCalledOnce());
    emitSession(streams.get("first")!, 1, "invalidate", { domains: ["history"] });
    await waitFor(() => expect(events).toHaveBeenCalledTimes(2));
    await act(async () => {});
    const newer = deferred<Awaited<ReturnType<WebClient["events"]>>>();
    events.mockReturnValueOnce(newer.promise);
    let newerRefresh!: Promise<void>;
    act(() => {
      newerRefresh = view.result.current.refresh();
    });
    await waitFor(() => expect(events).toHaveBeenCalledTimes(3));
    await act(async () => {
      old.reject(new Error("superseded history failure"));
      await olderRefresh;
    });
    emitSession(streams.get("first")!, 2, "state", { revision: 2 });
    expect(view.result.current.canSend).toBe(false);
    await act(async () => {
      newer.resolve({ events: [], warnings: [] });
      await newerRefresh;
    });
    expect(view.result.current.error).toBe(false);
    expect(view.result.current.canSend).toBe(true);
  });

  it("does not retry a cache-invalidated refresh after a send outcome becomes unknown", async () => {
    const { client, streams } = fixture();
    const view = renderHook(() => useSessionController({ client, embedded: true }));
    await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
    await act(async () => view.result.current.choose("first"));
    const request = client.request.bind(client);
    const sending = deferred<never>();
    const requests = vi
      .spyOn(client, "request")
      .mockImplementation((path, body, signal) =>
        path === "send" ? sending.promise : request(path, body, signal),
      );
    act(() => view.result.current.setMessage("Send once"));
    let sent!: ReturnType<typeof view.result.current.control>;
    act(() => {
      sent = view.result.current.control("send");
    });
    const old = deferred<Awaited<ReturnType<WebClient["events"]>>>();
    const events = vi.spyOn(client, "events").mockReturnValueOnce(old.promise);
    let refreshing!: Promise<void>;
    act(() => {
      refreshing = view.result.current.refresh(true);
    });
    await waitFor(() => expect(events).toHaveBeenCalledOnce());
    emitSession(streams.get("first")!, 1, "snapshot", {
      live: view.result.current.live!,
      items: [],
      historyCacheEpoch: "fresh-cache",
    });
    await waitFor(() => expect(events).toHaveBeenCalledTimes(2));
    await act(async () => {});
    await act(async () => {
      sending.reject(new Error("send response lost"));
      await sent;
    });
    expect(view.result.current.notice).toBe("uncertain");
    await act(async () => {
      old.reject(new Error("old cache history failure"));
      await refreshing;
    });
    emitSession(streams.get("first")!, 2, "state", { revision: 2 });
    expect(view.result.current.canSend).toBe(false);
    expect(events).toHaveBeenCalledTimes(2);
    expect(requests.mock.calls.filter(([path]) => path === "send")).toHaveLength(1);
  });

  it.each([false, true])(
    "preserves a newer host control fence when old refresh history settles (failed: %s)",
    async (failed) => {
      const { client, streams } = fixture();
      const originalEvents = client.events.bind(client);
      const events = vi.spyOn(client, "events").mockImplementation(async (id, cursor) => ({
        ...(await originalEvents(id, cursor)),
        next_cursor: "older",
      }));
      const view = renderHook(() => useSessionController({ client, embedded: true }));
      await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
      await act(async () => view.result.current.choose("first"));
      await waitFor(() => expect(view.result.current.canSend).toBe(true));
      const old = deferred<Awaited<ReturnType<WebClient["events"]>>>();
      events.mockClear().mockReturnValueOnce(old.promise);
      let refreshing!: Promise<void>;
      act(() => {
        refreshing = view.result.current.refresh();
      });
      await waitFor(() => expect(events).toHaveBeenCalledOnce());
      // Pagination satisfies the history read without advancing native delivery.
      await act(async () => view.result.current.earlier());
      expect(events).toHaveBeenCalledTimes(2);
      const unknown = {
        ...view.result.current.live!,
        status: "outcome-unknown",
        reason: "control-outcome-unconfirmed",
        sendEnabled: false,
        stopEnabled: false,
      };
      const live = vi.spyOn(client, "live").mockResolvedValue(unknown);
      act(() =>
        streams.get("first")!.event("control-changed", JSON.stringify({ sessionId: "first" })),
      );
      await waitFor(() => expect(view.result.current.live?.status).toBe("outcome-unknown"));
      expect(view.result.current.canSend).toBe(false);
      await act(async () => {
        if (failed) old.reject(new Error("superseded history failure"));
        else old.resolve({ events: [], warnings: [] });
        await refreshing;
      });
      expect(view.result.current.live).toMatchObject(unknown);
      expect(view.result.current.canSend).toBe(false);
      expect(live).toHaveBeenCalledOnce();
      expect(events).toHaveBeenCalledTimes(2);
    },
  );

  it("retains a newer history failure when a superseded refresh settles", async () => {
    const { client, streams } = fixture();
    const view = renderHook(() => useSessionController({ client, embedded: true }));
    await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
    await act(async () => view.result.current.choose("first"));
    const old = deferred<Awaited<ReturnType<WebClient["events"]>>>();
    const events = vi.spyOn(client, "events").mockReturnValueOnce(old.promise);
    let refreshing!: Promise<void>;
    act(() => {
      refreshing = view.result.current.refresh();
    });
    await waitFor(() => expect(events).toHaveBeenCalledOnce());
    emitSession(streams.get("first")!, 1, "invalidate", { domains: ["history"] });
    await waitFor(() => expect(events).toHaveBeenCalledTimes(2));
    await act(async () => {});
    events.mockRejectedValueOnce(new Error("latest history unavailable"));
    emitSession(streams.get("first")!, 2, "invalidate", { domains: ["history"] });
    await waitFor(() => expect(view.result.current.error).toBe(true));
    await act(async () => {
      old.reject(new Error("superseded history failure"));
      await refreshing;
    });
    emitSession(streams.get("first")!, 3, "state", { revision: 2 });
    expect(view.result.current.error).toBe(true);
    expect(view.result.current.canSend).toBe(false);
  });
});

describe("session refresh ownership", () => {
  it.each([
    { lan: false, failed: false },
    { lan: false, failed: true },
    { lan: true, failed: false },
    { lan: true, failed: true },
  ])(
    "ignores an old refresh after a rapid session round trip ($lan, $failed)",
    async ({ lan, failed }) => {
      const { client } = fixture(lan);
      const view = renderHook(() => useSessionController({ client, embedded: true }));
      await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
      await act(async () => view.result.current.choose("first"));
      await waitFor(() => expect(view.result.current.canSend).toBe(true));
      const old = deferred<Awaited<ReturnType<WebClient["events"]>>>();
      const events = vi.spyOn(client, "events").mockReturnValueOnce(old.promise);
      let refresh!: Promise<void>;
      act(() => {
        refresh = view.result.current.refresh(true);
      });
      await waitFor(() => expect(events).toHaveBeenCalledOnce());
      await act(async () => view.result.current.choose("second"));
      expect(view.result.current.canSend).toBe(true);
      await act(async () => view.result.current.choose("first"));
      expect(view.result.current.canSend).toBe(true);
      await act(async () => {
        if (failed) old.reject(new Error("old history read failed"));
        else old.resolve({ events: [], warnings: [] });
        await refresh;
      });
      expect(view.result.current.selected).toBe("first");
      expect(view.result.current.page?.events[0].content).toBe("first history");
      expect(view.result.current.error).toBe(false);
      expect(view.result.current.canSend).toBe(true);
    },
  );

  it("keeps the new session's refresh fence when an obsolete refresh settles", async () => {
    const { client } = fixture();
    const view = renderHook(() => useSessionController({ client, embedded: true }));
    await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
    await act(async () => view.result.current.choose("first"));
    const old = deferred<Awaited<ReturnType<WebClient["events"]>>>();
    const events = vi.spyOn(client, "events").mockReturnValueOnce(old.promise);
    let oldRefresh!: Promise<void>;
    act(() => {
      oldRefresh = view.result.current.refresh(true);
    });
    await waitFor(() => expect(events).toHaveBeenCalledOnce());
    await act(async () => view.result.current.choose("second"));
    const next = deferred<Awaited<ReturnType<WebClient["events"]>>>();
    events.mockReturnValueOnce(next.promise);
    let nextRefresh!: Promise<void>;
    act(() => {
      nextRefresh = view.result.current.refresh(true);
    });
    await waitFor(() => expect(events).toHaveBeenCalledTimes(3));
    await act(async () => {
      old.resolve({ events: [], warnings: [] });
      await oldRefresh;
    });
    expect(view.result.current.canSend).toBe(false);
    await act(async () => {
      next.reject(new Error("current history read failed"));
      await nextRefresh;
    });
    expect(view.result.current.error).toBe(true);
    expect(view.result.current.canSend).toBe(false);
    await act(async () => view.result.current.refresh(true));
    expect(view.result.current.error).toBe(false);
    expect(view.result.current.canSend).toBe(true);
  });

  it.each([false, true])(
    "retains session-specific unknown outcomes across navigation (durable %s)",
    async (durable) => {
      const { client, sessions } = fixture();
      sessions[0].agent = durable ? "codex" : "antigravity";
      vi.spyOn(client, "receipt").mockImplementation(async (requestId) => ({
        found: true,
        requestId,
        sessionId: "first",
        operation: "send",
        status: "unknown",
        completionObserved: false,
      }));
      const request = client.request.bind(client);
      const requests = vi.spyOn(client, "request").mockImplementation((path, body, signal) => {
        if (path === "send") return Promise.reject(new Error("lost send response"));
        return request(path, body, signal);
      });
      const view = renderHook(() => useSessionController({ client, embedded: true }));
      await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
      await act(async () => view.result.current.choose("first"));
      act(() => view.result.current.setMessage("Send exactly once"));
      await act(async () => view.result.current.control("send"));
      expect(view.result.current.notice).toBe("uncertain");
      const scope = pendingScope("", "local");
      const pending = readPending(scope);
      expect(pending).toHaveLength(durable ? 1 : 0);
      await act(async () => view.result.current.choose("second"));
      expect(view.result.current.canSend).toBe(true);
      await act(async () => view.result.current.choose("first"));
      expect(view.result.current.canSend).toBe(false);
      await act(async () => view.result.current.refresh());
      expect(view.result.current.canSend).toBe(false);
      await act(async () => view.result.current.refresh(true));
      expect(view.result.current.canSend).toBe(!durable);
      expect(readPending(scope)).toEqual(pending);
      expect(requests.mock.calls.filter(([path]) => path === "send")).toHaveLength(1);
    },
  );

  it("restores index availability when a scope reconnect returns an enabled catalog", async () => {
    const { client, streams, sessions } = fixture();
    const view = renderHook(() => useSessionController({ client, embedded: true }));
    await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
    const catalog = vi
      .spyOn(client, "catalog")
      .mockResolvedValue({ indexEnabled: false, sessions: [] });
    act(() => streams.get("")!.open());
    await waitFor(() => expect(view.result.current.indexEnabled).toBe(false));
    expect(view.result.current.sessions).toHaveLength(0);
    catalog.mockResolvedValue({ indexEnabled: true, sessions });
    act(() => streams.get("")!.open());
    await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
    expect(view.result.current.indexEnabled).toBe(true);
  });
});

describe("shared embedded conversation", () => {
  it("opens the requested create dialog after initial access loads", async () => {
    const { client } = fixture();
    render(
      <EmbeddedConversation client={client} create locale="en-US" onSessionChange={vi.fn()} />,
    );
    expect(await screen.findByRole("dialog")).toBeVisible();
    await waitFor(() => expect(screen.getByRole("button", { name: "Create" })).toBeEnabled());
    expect(screen.queryByRole("button", { name: "New task" })).not.toBeInTheDocument();
  });

  it.each(["reconnect", "settlement", "runtime restart"])(
    "recovers unknown creation on a global %s without replaying creation",
    async (trigger) => {
      const { client, streams, bridge, host } = fixture();
      const scope = pendingScope("", "local");
      const requestId = crypto.randomUUID();
      rememberPending(scope, {
        requestId,
        kind: "create",
        workspaceId: "workspace",
      });
      const receipt = vi.spyOn(client, "receipt").mockResolvedValue({
        found: true,
        requestId,
        status: "unknown",
        operation: "create",
        sessionId: "first",
        completionObserved: false,
      });
      const request = vi.spyOn(bridge, "request");
      const onSessionChange = vi.fn();
      render(
        <EmbeddedConversation client={client} locale="en-US" onSessionChange={onSessionChange} />,
      );
      await waitFor(() => expect(receipt).toHaveBeenCalled());
      await act(async () => {});
      expect(readPending(scope)).toHaveLength(1);
      receipt.mockClear();
      receipt.mockResolvedValue({
        found: true,
        requestId,
        status: "accepted",
        operation: "create",
        sessionId: "first",
        completionObserved: false,
      });
      act(() => {
        if (trigger === "settlement") streams.get("")!.event("control-changed", "{}");
        else {
          if (trigger === "runtime restart") host.bootId = "restarted-boot";
          streams.get("")!.open();
        }
      });
      await screen.findByText("first history");
      expect(readPending(scope)).toEqual([]);
      expect(onSessionChange).toHaveBeenCalledWith("first");
      expect(
        request.mock.calls.some(([path, body]) => path === "managed/create" && body !== undefined),
      ).toBe(false);
    },
  );

  it("clears the host selection after archive and can reopen that same record", async () => {
    const { client, sessions } = fixture();
    sessions[0].agent = "codex";
    const changed = vi.fn();
    function Host() {
      const [id, setId] = useState<string | undefined>("first");
      return (
        <>
          <button onClick={() => setId("first")}>Select original</button>
          <EmbeddedConversation
            client={client}
            sessionId={id}
            locale="en-US"
            onSessionChange={(next) => {
              changed(next);
              setId(next);
            }}
          />
        </>
      );
    }
    render(<Host />);
    await screen.findByText("first history");
    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    const archive = await screen.findByRole("button", { name: "Archive" });
    await waitFor(() => expect(archive).toBeEnabled());
    fireEvent.click(archive);
    await waitFor(() => expect(changed).toHaveBeenCalledWith(undefined));
    expect(screen.queryByText("first history")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Select original" }));
    expect(await screen.findByText("first history")).toBeVisible();
  });

  it("does not bounce an external selection back to the previous memory-router route", async () => {
    const { client } = fixture();
    const onSessionChange = vi.fn();
    const view = render(
      <EmbeddedConversation
        client={client}
        sessionId="first"
        locale="en-US"
        onSessionChange={onSessionChange}
      />,
    );
    await screen.findByText("first history");
    view.rerender(
      <EmbeddedConversation
        client={client}
        sessionId="second"
        locale="en-US"
        onSessionChange={onSessionChange}
      />,
    );
    await screen.findByText("second history");
    expect(onSessionChange).not.toHaveBeenCalled();
  });
  it("refreshes from an explicit host revision without rereading on mount or losing the draft", async () => {
    const { client } = fixture();
    const events = vi.spyOn(client, "events");
    const props = {
      client,
      sessionId: "first",
      locale: "en-US" as const,
      onSessionChange: vi.fn(),
    };
    const view = render(<EmbeddedConversation {...props} refreshRevision={4} />);
    await screen.findByText("first history");
    await act(async () => {});
    expect(events).toHaveBeenCalledOnce();
    const input = screen.getByRole("textbox", { name: "Send a message" });
    fireEvent.change(input, { target: { value: "Keep this unsent draft" } });
    events.mockResolvedValue({
      events: [
        {
          id: "refreshed",
          kind: "agent-message",
          content: "Explicitly refreshed history",
          attachment_count: 0,
          truncated: false,
        },
      ],
      warnings: [],
    });
    view.rerender(<EmbeddedConversation {...props} refreshRevision={5} />);
    expect(await screen.findByText("Explicitly refreshed history")).toBeVisible();
    expect(input).toHaveValue("Keep this unsent draft");
    expect(events).toHaveBeenCalledTimes(2);
    view.rerender(<EmbeddedConversation {...props} refreshRevision={5} />);
    await act(async () => {});
    expect(events).toHaveBeenCalledTimes(2);
  });
  it("ignores an old host refresh after the selected conversation changes", async () => {
    const { client } = fixture();
    const events = vi.spyOn(client, "events");
    const props = { client, locale: "en-US" as const, onSessionChange: vi.fn() };
    const view = render(<EmbeddedConversation {...props} sessionId="first" refreshRevision={0} />);
    await screen.findByText("first history");
    let finish!: (page: Awaited<ReturnType<WebClient["events"]>>) => void;
    events.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    view.rerender(<EmbeddedConversation {...props} sessionId="first" refreshRevision={1} />);
    await waitFor(() => expect(finish).toEqual(expect.any(Function)));
    view.rerender(<EmbeddedConversation {...props} sessionId="second" refreshRevision={1} />);
    await screen.findByText("second history");
    await act(async () => {
      finish({
        events: [
          {
            id: "late-first",
            kind: "agent-message",
            content: "Late first conversation refresh",
            attachment_count: 0,
            truncated: false,
          },
        ],
        warnings: [],
      });
    });
    expect(screen.getByText("second history")).toBeVisible();
    expect(screen.queryByText("Late first conversation refresh")).not.toBeInTheDocument();
    expect(events.mock.calls.map(([id]) => id)).toEqual(["first", "first", "second"]);
    fireEvent.change(screen.getByRole("textbox", { name: "Send a message" }), {
      target: { value: "Send in the new conversation" },
    });
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });
  it("applies a simultaneous host selection and refresh to the newly selected conversation", async () => {
    const { client } = fixture();
    const events = vi.spyOn(client, "events");
    const props = { client, locale: "en-US" as const, onSessionChange: vi.fn() };
    const view = render(<EmbeddedConversation {...props} sessionId="first" refreshRevision={0} />);
    await screen.findByText("first history");
    view.rerender(<EmbeddedConversation {...props} sessionId="second" refreshRevision={1} />);
    await screen.findByText("second history");
    await waitFor(() => expect(events).toHaveBeenCalledTimes(3));
    expect(events.mock.calls.map(([id]) => id)).toEqual(["first", "second", "second"]);
  });
  it("retains unknown control receipts and never resends them during a host refresh", async () => {
    const { client, sessions, bridge } = fixture();
    sessions[0].agent = "codex";
    const requestId = crypto.randomUUID();
    const scope = pendingScope("", "local");
    rememberPending(scope, { requestId, sessionId: "first", kind: "send" });
    vi.spyOn(client, "receipt").mockResolvedValue({
      found: true,
      requestId,
      sessionId: "first",
      operation: "send",
      status: "unknown",
      completionObserved: false,
    });
    const request = vi.spyOn(bridge, "request");
    const events = vi.spyOn(client, "events");
    const props = {
      client,
      sessionId: "first",
      locale: "en-US" as const,
      onSessionChange: vi.fn(),
    };
    const view = render(<EmbeddedConversation {...props} refreshRevision={0} />);
    await screen.findByText("first history");
    view.rerender(<EmbeddedConversation {...props} refreshRevision={1} />);
    await waitFor(() => expect(events).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(readPending(scope)).toEqual([{ requestId, sessionId: "first", kind: "send" }]);
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(request.mock.calls.some(([path, body]) => path === "send" && body !== undefined)).toBe(
      false,
    );
  });
  it("updates nonselected pending badges from a catalog notification without detail polling", async () => {
    const { client, sessions, streams } = fixture();
    const detailRead = vi.spyOn(client, "live");
    const view = renderHook(() => useSessionController({ client, embedded: true }));
    await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
    sessions[1].pendingInteraction = true;
    act(() => {
      streams.get("")!.event("catalog-invalidated", "{}");
    });
    await waitFor(() => expect(view.result.current.pendingSessions.second).toBe(true));
    delete sessions[1].pendingInteraction;
    act(() => {
      streams.get("")!.event("catalog-invalidated", "{}");
    });
    await waitFor(() => expect(view.result.current.sessions[1].pendingInteraction).toBeUndefined());
    expect(view.result.current.pendingSessions.second).toBe(true);
    sessions[1].pendingInteraction = false;
    act(() => {
      streams.get("")!.event("catalog-invalidated", "{}");
    });
    await waitFor(() => expect(view.result.current.pendingSessions.second).toBe(false));
    expect(detailRead).not.toHaveBeenCalled();
  });

  it.each(["removed", "metadata-only"] as const)(
    "clears a nonselected pending reminder when its catalog entry is %s",
    async (change) => {
      const { client, sessions, streams } = fixture();
      sessions[1].title = "Pending second task";
      sessions[1].pendingInteraction = true;
      const detailRead = vi.spyOn(client, "live");
      render(<EmbeddedConversation client={client} locale="en-US" onSessionChange={vi.fn()} />);
      await screen.findByRole("button", { name: "Pending actions (1)" });

      if (change === "removed") sessions.splice(1, 1);
      else sessions[1].availability = "metadata-only";
      act(() => streams.get("")!.event("catalog-invalidated", "{}"));

      fireEvent.click(await screen.findByRole("button", { name: "Pending actions" }));
      expect(await screen.findByText("No pending actions")).toBeVisible();
      expect(screen.queryByRole("button", { name: "Pending second task" })).not.toBeInTheDocument();
      expect(detailRead).not.toHaveBeenCalled();
    },
  );

  it.each(["removed", "metadata-only", "cleared"] as const)(
    "retains an unknown receipt reminder when its catalog interaction is %s",
    async (change) => {
      const { client, sessions, streams, bridge } = fixture();
      sessions[1].title = "Unconfirmed second task";
      sessions[1].pendingInteraction = true;
      const pending = {
        requestId: crypto.randomUUID(),
        sessionId: "second",
        kind: "send" as const,
      };
      const scope = pendingScope("", "local");
      rememberPending(scope, pending);
      const receipt = vi.spyOn(client, "receipt").mockResolvedValue({
        found: true,
        requestId: pending.requestId,
        sessionId: "second",
        operation: "send",
        status: "unknown",
        completionObserved: false,
      });
      const request = vi.spyOn(bridge, "request");
      const onCatalogChange = vi.fn();
      render(
        <EmbeddedConversation
          client={client}
          locale="en-US"
          onSessionChange={vi.fn()}
          onCatalogChange={onCatalogChange}
        />,
      );
      await screen.findByRole("button", { name: "Pending actions (1)" });
      await waitFor(() => expect(receipt).toHaveBeenCalledWith(pending.requestId));
      onCatalogChange.mockClear();

      if (change === "removed") sessions.splice(1, 1);
      else if (change === "metadata-only") sessions[1].availability = "metadata-only";
      else sessions[1].pendingInteraction = false;
      act(() => streams.get("")!.event("catalog-invalidated", "{}"));
      await waitFor(() => expect(onCatalogChange).toHaveBeenCalled());

      fireEvent.click(screen.getByRole("button", { name: "Pending actions (1)" }));
      expect(
        await screen.findByText(
          "The last outcome is unknown. Checking its receipt without replaying it.",
        ),
      ).toBeVisible();
      expect(readPending(scope)).toEqual([pending]);
      expect(request.mock.calls.some(([path, body]) => path === "send" && body !== undefined)).toBe(
        false,
      );
    },
  );

  it.each(["removed", "metadata-only"] as const)(
    "does not restore a selected live reminder after its catalog entry is %s",
    async (change) => {
      const { client, sessions, streams } = fixture();
      const onCatalogChange = vi.fn();
      render(
        <EmbeddedConversation
          client={client}
          sessionId="first"
          locale="en-US"
          onSessionChange={vi.fn()}
          onCatalogChange={onCatalogChange}
        />,
      );
      await screen.findByText("first history");
      const stream = streams.get("first")!;
      const pendingLive: Awaited<ReturnType<WebClient["live"]>> = {
        sessionId: "first",
        status: "awaiting-approval",
        revision: 2,
        sendEnabled: false,
        approvals: [
          {
            requestId: "approval-first",
            turnId: "turn-first",
            method: "tools/call",
            availableDecisions: [],
            supported: false,
          },
        ],
        questions: [],
      };
      vi.spyOn(client, "live").mockResolvedValue(pendingLive);
      emitSession(stream, 1, "state", pendingLive);
      await screen.findByRole("button", { name: "Pending actions (1)" });
      onCatalogChange.mockClear();

      if (change === "removed") sessions.splice(0, 1);
      else sessions[0].availability = "metadata-only";
      act(() => streams.get("")!.event("catalog-invalidated", "{}"));
      await waitFor(() => expect(onCatalogChange).toHaveBeenCalled());
      await screen.findByRole("button", { name: "Pending actions" });

      emitSession(stream, 2, "state", { revision: 3 });
      fireEvent.click(screen.getByRole("button", { name: "Pending actions" }));
      expect(await screen.findByText("No pending actions")).toBeVisible();
      expect(screen.queryByRole("button", { name: /approval-first/ })).not.toBeInTheDocument();
    },
  );

  it.each([
    ["refresh-first", "approved", false],
    ["notification-first", "approved", false],
    ["refresh-first", "ended", false],
    ["notification-first", "ended", false],
    ["refresh-first", "approved", true],
    ["notification-first", "approved", true],
  ] as const)(
    "finishes a concurrent %s refresh using the latest %s access response (obsolete read failed: %s)",
    async (order, status, obsoleteFailed) => {
      const { client, streams } = fixture();
      const view = renderHook(() => useSessionController({ client, embedded: true }));
      await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
      await act(async () => {
        await view.result.current.choose("first");
      });
      await waitFor(() => expect(view.result.current.controlReady).toBe(true));
      const approved = view.result.current.access!;
      const completions: ((value: typeof approved) => void)[] = [];
      const failures: ((error: Error) => void)[] = [];
      vi.spyOn(client, "access").mockImplementation(
        () =>
          new Promise((resolve, reject) => {
            completions.push(resolve);
            failures.push(reject);
          }),
      );
      let refreshing!: Promise<void>;
      act(() => {
        const notify = () => streams.get("")!.event("catalog-invalidated", "{}");
        if (order === "notification-first") notify();
        refreshing = view.result.current.refresh();
        if (order === "refresh-first") notify();
      });
      expect(completions).toHaveLength(2);
      await act(async () => {
        if (obsoleteFailed) failures[0](new Error("obsolete access response"));
        else completions[0](approved);
      });
      expect(view.result.current.controlReady).toBe(false);
      await act(async () => {
        completions[1]({ ...approved, status });
        await refreshing;
      });
      expect(view.result.current.access?.status).toBe(status);
      expect(view.result.current.controlReady).toBe(status === "approved");
      if (status === "approved") {
        expect(view.result.current.online).toBe(true);
        expect(view.result.current.error).toBe(false);
        expect(view.result.current.selected).toBe("first");
      } else {
        expect(view.result.current.selected).toBe("");
        expect(view.result.current.sessions).toEqual([]);
      }
    },
  );

  it.each([
    ["access", false],
    ["catalog", false],
    ["access", true],
    ["catalog", true],
  ] as const)(
    "retries a global %s invalidation after switching sessions (obsolete read failed: %s)",
    async (phase, failed) => {
      const { client, sessions, streams, bridge } = fixture();
      const subscriptions = vi.spyOn(bridge, "stream");
      const view = renderHook(() => useSessionController({ client, embedded: true }));
      await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
      await act(async () => {
        await view.result.current.choose("first");
      });
      const access = vi.spyOn(client, "access");
      const catalog = vi.spyOn(client, "catalog");
      let finish!: () => void;
      if (phase === "access") {
        const obsolete = { ...view.result.current.access!, bootId: "obsolete-boot" };
        const pending = deferred<typeof obsolete>();
        access.mockReturnValueOnce(pending.promise);
        finish = () =>
          failed ? pending.reject(new Error("obsolete access failed")) : pending.resolve(obsolete);
      } else {
        const pending = deferred<Awaited<ReturnType<WebClient["catalog"]>>>();
        catalog.mockReturnValueOnce(pending.promise);
        finish = () =>
          failed
            ? pending.reject(new Error("obsolete catalog failed"))
            : pending.resolve({ indexEnabled: true, sessions: [] });
      }
      sessions.push({ ...sessions[0], id: "created-elsewhere", title: "New task" });
      const globalStream = streams.get("")!;
      act(() => globalStream.event("catalog-invalidated", "{}"));
      await waitFor(() => expect(phase === "access" ? access : catalog).toHaveBeenCalledOnce());
      await act(async () => {
        await view.result.current.choose("second");
      });
      await act(async () => {
        finish();
      });
      await waitFor(() =>
        expect(view.result.current.sessions.map((session) => session.id)).toContain(
          "created-elsewhere",
        ),
      );
      expect(view.result.current.selected).toBe("second");
      expect(view.result.current.access?.bootId).toBe("boot");
      expect(view.result.current.sessions).toHaveLength(3);
      expect(view.result.current.page?.events[0].content).toBe("second history");
      expect(view.result.current.error).toBe(false);
      expect(access).toHaveBeenCalledTimes(2);
      expect(catalog).toHaveBeenCalledTimes(phase === "access" ? 1 : 2);
      expect(streams.get("")).toBe(globalStream);
      expect(subscriptions.mock.calls.filter(([id]) => id === "")).toHaveLength(1);
    },
  );

  it.each(["access", "catalog"] as const)(
    "coalesces catalog notifications while a global %s read crosses navigation",
    async (phase) => {
      const { client, sessions, streams } = fixture();
      const view = renderHook(() => useSessionController({ client, embedded: true }));
      await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
      await act(async () => view.result.current.choose("first"));
      const accepted = view.result.current.access!;
      const access = vi.spyOn(client, "access");
      const catalog = vi.spyOn(client, "catalog");
      let finish!: () => void;
      if (phase === "access") {
        const pending = deferred<typeof accepted>();
        access.mockReturnValueOnce(pending.promise);
        finish = () => pending.resolve(accepted);
      } else {
        const pending = deferred<Awaited<ReturnType<WebClient["catalog"]>>>();
        catalog.mockReturnValueOnce(pending.promise);
        finish = () => pending.resolve({ indexEnabled: true, sessions: [] });
      }
      act(() => streams.get("")!.event("catalog-invalidated", "{}"));
      await waitFor(() => expect(phase === "access" ? access : catalog).toHaveBeenCalledOnce());
      await act(async () => view.result.current.choose("second"));
      const followup = deferred<Awaited<ReturnType<WebClient["catalog"]>>>();
      catalog.mockReturnValueOnce(followup.promise);
      act(() => {
        for (let index = 0; index < 20; index++)
          streams.get("")!.event("catalog-invalidated", "{}");
      });
      expect(access).toHaveBeenCalledOnce();
      expect(catalog).toHaveBeenCalledTimes(phase === "access" ? 0 : 1);
      await act(async () => finish());
      await waitFor(() => expect(catalog).toHaveBeenCalledTimes(phase === "access" ? 1 : 2));
      expect(access).toHaveBeenCalledTimes(2);
      sessions[1].pendingInteraction = true;
      act(() => {
        for (let index = 0; index < 20; index++)
          streams.get("")!.event("catalog-invalidated", "{}");
      });
      await act(async () => followup.resolve({ indexEnabled: true, sessions: [] }));
      await waitFor(() => expect(view.result.current.pendingSessions.second).toBe(true));
      expect(view.result.current.sessions).toHaveLength(2);
      expect(access).toHaveBeenCalledTimes(3);
      expect(catalog).toHaveBeenCalledTimes(phase === "access" ? 2 : 3);
    },
  );

  it.each([
    ["access", "revocation"],
    ["catalog", "revocation"],
    ["access", "unmount"],
    ["catalog", "unmount"],
  ] as const)("does not retry a global %s read after %s", async (phase, ending) => {
    const { client, sessions, streams } = fixture();
    const view = renderHook(() => useSessionController({ client, embedded: true }));
    await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
    await act(async () => view.result.current.choose("first"));
    const accepted = view.result.current.access!;
    const access = vi.spyOn(client, "access");
    const catalog = vi.spyOn(client, "catalog");
    let finish!: () => void;
    if (phase === "access") {
      const pending = deferred<typeof accepted>();
      access.mockReturnValueOnce(pending.promise);
      finish = () => pending.resolve(accepted);
    } else {
      const pending = deferred<Awaited<ReturnType<WebClient["catalog"]>>>();
      catalog.mockReturnValueOnce(pending.promise);
      finish = () => pending.resolve({ indexEnabled: true, sessions });
    }
    const globalStream = streams.get("")!;
    act(() => globalStream.event("catalog-invalidated", "{}"));
    await waitFor(() => expect(phase === "access" ? access : catalog).toHaveBeenCalledOnce());
    if (ending === "unmount") view.unmount();
    else act(() => globalStream.event("access-ended", "{}"));
    await act(async () => {
      finish();
      globalStream.open();
      globalStream.event("catalog-invalidated", "{}");
    });
    expect(access).toHaveBeenCalledOnce();
    expect(catalog).toHaveBeenCalledTimes(phase === "access" ? 0 : 1);
    if (ending === "revocation") {
      expect(view.result.current.access?.status).toBe("ended");
      expect(view.result.current.selected).toBe("");
      expect(view.result.current.sessions).toEqual([]);
    }
  });

  it.each([
    ["access", "boot"],
    ["catalog", "boot"],
    ["access", "device"],
    ["catalog", "device"],
  ] as const)(
    "retries a stale global %s read only under the new %s identity",
    async (phase, changed) => {
      const { client, sessions, streams } = fixture();
      const view = renderHook(() => useSessionController({ client, embedded: true }));
      await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
      await act(async () => view.result.current.choose("first"));
      const previous = view.result.current.access!;
      const access = vi.spyOn(client, "access");
      const catalog = vi.spyOn(client, "catalog");
      let finish!: () => void;
      if (phase === "access") {
        const pending = deferred<typeof previous>();
        access.mockReturnValueOnce(pending.promise);
        finish = () => pending.resolve(previous);
      } else {
        const pending = deferred<Awaited<ReturnType<WebClient["catalog"]>>>();
        catalog.mockReturnValueOnce(pending.promise);
        finish = () => pending.resolve({ indexEnabled: true, sessions: [] });
      }
      act(() => streams.get("")!.event("catalog-invalidated", "{}"));
      await waitFor(() => expect(phase === "access" ? access : catalog).toHaveBeenCalledOnce());
      const current = {
        ...previous,
        ...(changed === "boot"
          ? { bootId: "new-boot" }
          : { device: { ...previous.device!, id: "new-device" } }),
      };
      access.mockResolvedValue(current);
      sessions[0].title = "Current identity catalog";
      await act(async () => view.result.current.refresh());
      expect(view.result.current.access).toEqual(current);
      expect(view.result.current.selected).toBe("");
      await act(async () => finish());
      expect(view.result.current.access).toEqual(current);
      expect(view.result.current.sessions[0].title).toBe("Current identity catalog");
      expect(view.result.current.sessions).toHaveLength(2);
      expect(access).toHaveBeenCalledTimes(3);
      expect(catalog).toHaveBeenCalledTimes(phase === "access" ? 2 : 3);
      expect(view.result.current.error).toBe(false);
    },
  );

  it.each(["choose", "refresh", "earlier"])(
    "rejects a %s history read captured before a cache epoch reset",
    async (operation) => {
      const { client, streams } = fixture();
      const originalEvents = client.events.bind(client);
      const events = vi.spyOn(client, "events").mockImplementation(async (id) => ({
        ...(await originalEvents(id)),
        next_cursor: "older",
      }));
      const view = renderHook(() => useSessionController({ client, embedded: true }));
      await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
      if (operation !== "choose")
        await act(async () => {
          await view.result.current.choose("first");
        });
      const fresh = {
        id: "fresh",
        kind: "agent-message" as const,
        content: "fresh cache",
        attachment_count: 0,
        truncated: false,
      };
      let finish!: (page: Awaited<ReturnType<WebClient["events"]>>) => void;
      events.mockClear();
      events
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        )
        .mockResolvedValue({ events: [fresh], warnings: [] });
      let pending!: Promise<void>;
      act(() => {
        pending =
          operation === "choose"
            ? view.result.current.choose("first")
            : operation === "refresh"
              ? view.result.current.refresh()
              : view.result.current.earlier();
      });
      await waitFor(() => expect(finish).toEqual(expect.any(Function)));
      act(() =>
        streams.get("first")!.event(
          "session-event",
          JSON.stringify({
            protocolVersion: 2,
            subscriptionId: "first",
            sessionId: "first",
            runtimeBootId: "runtime",
            epoch: "epoch",
            seq: 1,
            cursor: "cache-reset",
            type: "snapshot",
            payload: { live: view.result.current.live!, items: [], historyCacheEpoch: "cache-1" },
          }),
        ),
      );
      await waitFor(() => expect(view.result.current.page?.events).toEqual([fresh]));
      await act(async () => {
        finish({
          events: [{ ...fresh, id: "obsolete", content: "old cache" }],
          warnings: [],
          next_cursor: "obsolete-cursor",
        });
        await pending;
      });
      expect(view.result.current.page?.events).toEqual([fresh]);
      expect(view.result.current.page?.next_cursor).toBeUndefined();
      // A refresh owns a control fence, so crossing cache epochs requires a new
      // complete baseline before releasing it. Other readers only discard A.
      expect(events).toHaveBeenCalledTimes(operation === "refresh" ? 3 : 2);
      expect(view.result.current.canSend).toBe(true);
    },
  );

  it.each(["history", "manual"])(
    "keeps a cache recovery error visible through native state until %s recovery succeeds",
    async (recovery) => {
      const { client, streams } = fixture();
      const view = renderHook(() => useSessionController({ client, embedded: true }));
      await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
      await act(async () => {
        await view.result.current.choose("first");
      });
      const events = vi
        .spyOn(client, "events")
        .mockRejectedValueOnce(new Error("history unavailable"));
      const emit = (seq: number, type: string, payload: unknown) =>
        act(() =>
          streams.get("first")!.event(
            "session-event",
            JSON.stringify({
              protocolVersion: 2,
              subscriptionId: "first",
              sessionId: "first",
              runtimeBootId: "runtime",
              epoch: "epoch",
              seq,
              cursor: `cache-${seq}`,
              type,
              payload,
            }),
          ),
        );
      emit(1, "snapshot", {
        live: view.result.current.live!,
        items: [],
        historyCacheEpoch: "cache-1",
      });
      await waitFor(() => expect(view.result.current.error).toBe(true));
      emit(2, "state", { revision: 12 });
      expect(view.result.current.error).toBe(true);
      expect(events).toHaveBeenCalledOnce();
      if (recovery === "manual") {
        await act(async () => {
          await view.result.current.refresh(true);
        });
      } else emit(3, "invalidate", { domains: ["history"] });
      await waitFor(() => expect(view.result.current.error).toBe(false));
      expect(view.result.current.page?.events[0].content).toBe("first history");
      expect(events).toHaveBeenCalledTimes(2);
    },
  );

  it("ignores an old session's cache recovery after switching conversations", async () => {
    const { client, streams } = fixture();
    const view = renderHook(() => useSessionController({ client, embedded: true }));
    await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
    await act(async () => {
      await view.result.current.choose("first");
    });
    let finish!: (page: Awaited<ReturnType<WebClient["events"]>>) => void;
    vi.spyOn(client, "events").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    act(() =>
      streams.get("first")!.event(
        "session-event",
        JSON.stringify({
          protocolVersion: 2,
          subscriptionId: "first",
          sessionId: "first",
          runtimeBootId: "runtime",
          epoch: "epoch",
          seq: 1,
          cursor: "cache-reset",
          type: "snapshot",
          payload: { live: view.result.current.live!, items: [], historyCacheEpoch: "cache-1" },
        }),
      ),
    );
    await act(async () => {
      await view.result.current.choose("second");
    });
    await act(async () => {
      finish({ events: [], warnings: [], next_cursor: "old-session" });
    });
    expect(view.result.current.selected).toBe("second");
    expect(view.result.current.page?.events[0].content).toBe("second history");
    expect(view.result.current.page?.next_cursor).toBeUndefined();
  });
});

describe("history read error ownership", () => {
  function emit(stream: SessionStreamHandlers, seq: number, type: string, payload: unknown) {
    act(() =>
      stream.event(
        "session-event",
        JSON.stringify({
          protocolVersion: 2,
          subscriptionId: "first",
          sessionId: "first",
          runtimeBootId: "runtime",
          epoch: "epoch",
          seq,
          cursor: `history-${seq}`,
          type,
          payload,
        }),
      ),
    );
  }

  it.each(["choose", "refresh", "earlier"])(
    "keeps a failed %s history read visible through live updates and retry until success",
    async (operation) => {
      const { client, streams } = fixture();
      const original = client.events.bind(client);
      const events = vi.spyOn(client, "events").mockImplementation(async (id, cursor) => ({
        ...(await original(id, cursor)),
        next_cursor: "older",
      }));
      const view = renderHook(() => useSessionController({ client, embedded: true }));
      await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
      if (operation !== "choose") await act(async () => view.result.current.choose("first"));
      const failed = deferred<Awaited<ReturnType<WebClient["events"]>>>();
      events.mockReturnValueOnce(failed.promise);
      let reading!: Promise<void>;
      act(() => {
        reading =
          operation === "choose"
            ? view.result.current.choose("first")
            : operation === "refresh"
              ? view.result.current.refresh()
              : view.result.current.earlier();
      });
      await waitFor(() => expect(view.result.current.live?.sessionId).toBe("first"));
      await act(async () => {
        failed.reject(new Error("history unavailable"));
        await reading;
      });
      expect(view.result.current.error).toBe(true);
      if (operation === "choose") expect(view.result.current.page).toBeUndefined();
      const stream = streams.get("first")!;
      emit(stream, 1, "state", { revision: 2 });
      expect(view.result.current.error).toBe(true);
      const completedReads = events.mock.calls.length;
      const retry = deferred<Awaited<ReturnType<WebClient["events"]>>>();
      events.mockReturnValueOnce(retry.promise);
      let retrying!: Promise<void>;
      act(() => {
        retrying =
          operation === "earlier"
            ? view.result.current.earlier()
            : view.result.current.refresh(true);
      });
      await waitFor(() => expect(events).toHaveBeenCalledTimes(completedReads + 1));
      emit(stream, 2, "state", { revision: 3 });
      expect(view.result.current.error).toBe(true);
      await act(async () => {
        retry.resolve({
          events: [
            {
              id: "recovered",
              kind: "agent-message",
              content: "Recovered history",
              attachment_count: 0,
              truncated: false,
            },
          ],
          warnings: [],
        });
        await retrying;
      });
      expect(view.result.current.error).toBe(false);
      expect(
        view.result.current.page?.events.some((item) => item.content === "Recovered history"),
      ).toBe(true);
    },
  );

  it("retains a late history failure after the concurrent live request has failed", async () => {
    const { client, streams } = fixture();
    const view = renderHook(() => useSessionController({ client, embedded: true }));
    await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
    const pending = deferred<Awaited<ReturnType<WebClient["events"]>>>();
    vi.spyOn(client, "events").mockReturnValueOnce(pending.promise);
    vi.spyOn(client, "live").mockRejectedValueOnce(new Error("live unavailable"));
    await act(async () => view.result.current.choose("first"));
    emit(streams.get("first")!, 1, "state", { revision: 2 });
    await act(async () => pending.reject(new Error("late history failure")));
    expect(view.result.current.error).toBe(true);
    emit(streams.get("first")!, 2, "state", { revision: 3 });
    expect(view.result.current.error).toBe(true);
    await act(async () => view.result.current.refresh(true));
    expect(view.result.current.error).toBe(false);
    expect(view.result.current.page?.events[0].content).toBe("first history");
  });

  it("does not turn a live-only refresh failure into a persistent history error", async () => {
    const { client, streams } = fixture();
    const view = renderHook(() => useSessionController({ client, embedded: true }));
    await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
    await act(async () => view.result.current.choose("first"));
    vi.spyOn(client, "live").mockRejectedValueOnce(new Error("live unavailable"));
    await act(async () => view.result.current.refresh());
    expect(view.result.current.error).toBe(true);
    emit(streams.get("first")!, 1, "state", { revision: 2 });
    expect(view.result.current.error).toBe(false);
    expect(view.result.current.page?.events[0].content).toBe("first history");
  });

  it.each(["session", "cache", "newer history"])(
    "ignores an old history failure after %s replacement",
    async (replacement) => {
      const { client, streams } = fixture();
      const view = renderHook(() => useSessionController({ client, embedded: true }));
      await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
      const pending = deferred<Awaited<ReturnType<WebClient["events"]>>>();
      const events = vi.spyOn(client, "events").mockReturnValueOnce(pending.promise);
      let choosing!: Promise<void>;
      act(() => {
        choosing = view.result.current.choose("first");
      });
      await waitFor(() => expect(view.result.current.live?.sessionId).toBe("first"));
      if (replacement === "session") await act(async () => view.result.current.choose("second"));
      else if (replacement === "cache")
        emit(streams.get("first")!, 1, "snapshot", {
          live: view.result.current.live!,
          items: [],
          historyCacheEpoch: "new-cache",
        });
      else emit(streams.get("first")!, 1, "invalidate", { domains: ["history"] });
      await waitFor(() =>
        expect(view.result.current.page?.events[0].content).toBe(
          replacement === "session" ? "second history" : "first history",
        ),
      );
      expect(events).toHaveBeenCalledTimes(2);
      await act(async () => {
        pending.reject(new Error("obsolete history failure"));
        await choosing;
      });
      expect(view.result.current.error).toBe(false);
      expect(view.result.current.selected).toBe(replacement === "session" ? "second" : "first");
    },
  );

  it("ignores a live failure from before a history cache replacement", async () => {
    const { client, streams } = fixture();
    const view = renderHook(() => useSessionController({ client, embedded: true }));
    await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
    const live = deferred<Awaited<ReturnType<WebClient["live"]>>>();
    vi.spyOn(client, "live").mockReturnValueOnce(live.promise);
    let choosing!: Promise<void>;
    act(() => {
      choosing = view.result.current.choose("first");
    });
    await waitFor(() => expect(view.result.current.live?.sessionId).toBe("first"));
    emit(streams.get("first")!, 1, "snapshot", {
      live: view.result.current.live!,
      items: [],
      historyCacheEpoch: "new-cache",
    });
    await waitFor(() => expect(view.result.current.page?.events[0].content).toBe("first history"));
    await act(async () => {
      live.reject(new Error("obsolete live failure"));
      await choosing;
    });
    expect(view.result.current.error).toBe(false);
  });
});
