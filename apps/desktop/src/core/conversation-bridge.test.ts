// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationSubscription, SessionStreamEvent } from "@agentkib/conversation-state";
import type { Live } from "@agentkib/web-client";
import {
  createDesktopConversationAdapter,
  decodeConversationResponse,
  type DesktopConversationBridge,
} from "./conversation-bridge";

const event: SessionStreamEvent<Live> = {
  protocolVersion: 2,
  subscriptionId: "sub",
  sessionId: "session",
  runtimeBootId: "boot",
  epoch: "epoch",
  seq: 0,
  cursor: "cursor-0",
  type: "snapshot",
  payload: {
    live: {
      sessionId: "session",
      status: "running",
      revision: 1,
      sendEnabled: false,
      approvals: [],
    },
  },
};
const next: SessionStreamEvent<Live> = {
  ...event,
  seq: 1,
  cursor: "cursor-1",
  type: "text-delta",
  payload: { text: "你好", offset: 0 },
};
function bridgeFixture() {
  let receive: (value: SessionStreamEvent<Live>) => void = () => {};
  let unavailable = () => {};
  let controlChanged = (_sessionId: string) => {};
  const remove = vi.fn();
  const bridge: DesktopConversationBridge = {
    request: vi.fn(async () => ({ status: 200, body: {} })),
    upload: vi.fn(async () => ({
      status: 200,
      body: { id: "file", name: "a.txt", mime: "text/plain", size: 1, version: "v1" },
    })),
    subscribe: vi.fn(async () => ({ subscriptionId: "sub", events: [event], cursor: "cursor-0" })),
    acknowledge: vi.fn(async () => {}),
    unsubscribe: vi.fn(async () => {}),
    onEvent: vi.fn((listener) => {
      receive = listener;
      return remove;
    }),
    onUnavailable: vi.fn((listener) => {
      unavailable = listener;
      return remove;
    }),
    onControlChanged: vi.fn((listener) => {
      controlChanged = listener;
      return remove;
    }),
  };
  return {
    bridge,
    remove,
    emit: (value: SessionStreamEvent<Live>) => receive(value),
    unavailable: () => unavailable(),
    controlChanged: (id: string) => controlChanged(id),
  };
}
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Value>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
async function flushAcknowledgements() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
const applyCursor = (type: string, data: string) =>
  type === "session-event" ? (JSON.parse(data).cursor as string) : false;
afterEach(() => vi.useRealTimers());

describe("desktop conversation bridge", () => {
  it("preserves control outcomes instead of converting uncertain sends to safe retries", async () => {
    const fixture = bridgeFixture();
    vi.mocked(fixture.bridge.request).mockResolvedValue({
      status: 504,
      body: { error: "outcome_unknown", controlOutcome: "unknown" },
    });
    const adapter = createDesktopConversationAdapter(() => fixture.bridge);
    await expect(adapter.request("send", { text: "hello" })).rejects.toMatchObject({
      status: 504,
      code: "outcome_unknown",
      controlOutcome: "unknown",
    });
    expect(fixture.bridge.request).toHaveBeenCalledTimes(1);
    expect(() =>
      decodeConversationResponse({
        status: 409,
        body: { code: "stale_state", controlOutcome: "not-dispatched" },
      }),
    ).toThrow("stale_state");
  });

  it("delivers bootstrap before events received while subscription was pending", async () => {
    const fixture = bridgeFixture();
    let resolve!: (value: ConversationSubscription<Live>) => void;
    vi.mocked(fixture.bridge.subscribe).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const delivered: string[] = [];
    const stop = createDesktopConversationAdapter(() => fixture.bridge).stream("session", {
      event: (type, data) => {
        delivered.push(type === "session-event" ? JSON.parse(data).type : type);
      },
      open: vi.fn(),
      error: vi.fn(),
    });
    fixture.emit(next);
    fixture.emit({ ...next, sessionId: "other" });
    resolve({ subscriptionId: "sub", events: [event] });
    await Promise.resolve();
    expect(delivered).toEqual(["snapshot", "text-delta", "session-ready"]);
    stop();
    fixture.emit(next);
    expect(delivered).toHaveLength(3);
    expect(fixture.bridge.unsubscribe).toHaveBeenCalledWith("sub");
    expect(fixture.remove).toHaveBeenCalledTimes(3);
  });

  it("releases a subscription that finishes after its view was closed", async () => {
    const fixture = bridgeFixture();
    let resolve!: (value: ConversationSubscription<Live>) => void;
    vi.mocked(fixture.bridge.subscribe).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const receive = vi.fn();
    const stop = createDesktopConversationAdapter(() => fixture.bridge).stream("session", {
      event: receive,
      open: vi.fn(),
      error: vi.fn(),
    });
    stop();
    resolve({ subscriptionId: "sub", events: [event] });
    await Promise.resolve();
    expect(receive).not.toHaveBeenCalled();
    expect(fixture.bridge.unsubscribe).toHaveBeenCalledWith("sub");
    expect(fixture.bridge.acknowledge).not.toHaveBeenCalled();
  });

  it("coalesces applied bootstrap and buffered events into one cumulative acknowledgement", async () => {
    const fixture = bridgeFixture();
    const pending = deferred<ConversationSubscription<Live>>();
    vi.mocked(fixture.bridge.subscribe).mockReturnValue(pending.promise);
    const stop = createDesktopConversationAdapter(() => fixture.bridge).stream("session", {
      event: applyCursor,
      open: vi.fn(),
      error: vi.fn(),
    });
    fixture.emit({ ...next, seq: 2, cursor: "cursor-2" });
    pending.resolve({ subscriptionId: "sub", events: [event, next], cursor: "cursor-1" });
    await flushAcknowledgements();
    expect(fixture.bridge.acknowledge).toHaveBeenCalledExactlyOnceWith("sub", "cursor-2");
    stop();
  });

  it("acknowledges only the consumer's applied cursor and never a rejected gap", async () => {
    const fixture = bridgeFixture();
    const stop = createDesktopConversationAdapter(() => fixture.bridge).stream("session", {
      event: (type, data) => {
        if (type !== "session-event") return "readiness-is-not-a-delivery";
        return JSON.parse(data).seq <= 1 ? "cursor-0" : false;
      },
      open: vi.fn(),
      error: vi.fn(),
    });
    await flushAcknowledgements();
    fixture.emit(next);
    fixture.emit({ ...next, seq: 9, cursor: "cursor-9" });
    await flushAcknowledgements();
    expect(vi.mocked(fixture.bridge.acknowledge).mock.calls).toEqual([
      ["sub", "cursor-0"],
      ["sub", "cursor-0"],
    ]);
    stop();
  });

  it("keeps at most one acknowledgement in flight and retains only the latest applied cursor", async () => {
    const fixture = bridgeFixture();
    const first = deferred<void>();
    vi.mocked(fixture.bridge.acknowledge).mockReturnValueOnce(first.promise);
    const stop = createDesktopConversationAdapter(() => fixture.bridge).stream("session", {
      event: applyCursor,
      open: vi.fn(),
      error: vi.fn(),
    });
    await flushAcknowledgements();
    for (let seq = 1; seq <= 1_000; seq++) fixture.emit({ ...next, seq, cursor: `cursor-${seq}` });
    await flushAcknowledgements();
    expect(fixture.bridge.acknowledge).toHaveBeenCalledExactlyOnceWith("sub", "cursor-0");
    first.resolve();
    await flushAcknowledgements();
    expect(vi.mocked(fixture.bridge.acknowledge).mock.calls).toEqual([
      ["sub", "cursor-0"],
      ["sub", "cursor-1000"],
    ]);
    stop();
  });

  it.each(["queued", "in-flight"])(
    "discards %s acknowledgements when the stream closes",
    async (phase) => {
      const fixture = bridgeFixture();
      const first = deferred<void>();
      vi.mocked(fixture.bridge.acknowledge).mockReturnValueOnce(first.promise);
      const error = vi.fn();
      const stop = createDesktopConversationAdapter(() => fixture.bridge).stream("session", {
        event: applyCursor,
        open: vi.fn(),
        error,
      });
      if (phase === "queued") await Promise.resolve();
      else await flushAcknowledgements();
      fixture.emit(next);
      stop();
      first.resolve();
      await flushAcknowledgements();
      expect(fixture.bridge.acknowledge).toHaveBeenCalledTimes(phase === "queued" ? 0 : 1);
      expect(error).not.toHaveBeenCalled();
    },
  );

  it.each(["resolve", "reject"])(
    "isolates a new connection from an old acknowledgement that will %s",
    async (outcome) => {
      vi.useFakeTimers();
      const fixture = bridgeFixture();
      const old = deferred<void>();
      vi.mocked(fixture.bridge.acknowledge).mockReturnValueOnce(old.promise);
      const error = vi.fn();
      const stop = createDesktopConversationAdapter(() => fixture.bridge).stream("session", {
        event: applyCursor,
        open: vi.fn(),
        error,
      });
      await flushAcknowledgements();
      fixture.emit(next);
      vi.mocked(fixture.bridge.subscribe).mockResolvedValueOnce({
        subscriptionId: "new-sub",
        events: [{ ...next, subscriptionId: "new-sub", seq: 2, cursor: "cursor-2" }],
      });
      fixture.unavailable();
      await vi.advanceTimersByTimeAsync(500);
      expect(vi.mocked(fixture.bridge.acknowledge).mock.calls).toEqual([
        ["sub", "cursor-0"],
        ["new-sub", "cursor-2"],
      ]);
      error.mockClear();
      if (outcome === "resolve") old.resolve();
      else old.reject(new Error("old connection failed"));
      await flushAcknowledgements();
      fixture.emit({ ...next, subscriptionId: "new-sub", seq: 3, cursor: "cursor-3" });
      await flushAcknowledgements();
      expect(fixture.bridge.acknowledge).toHaveBeenLastCalledWith("new-sub", "cursor-3");
      expect(fixture.bridge.acknowledge).toHaveBeenCalledTimes(3);
      expect(error).not.toHaveBeenCalled();
      expect(fixture.bridge.unsubscribe).not.toHaveBeenCalledWith("new-sub");
      stop();
    },
  );

  it("reports acknowledgement failure and reconnects observation without retrying a command", async () => {
    vi.useFakeTimers();
    const fixture = bridgeFixture();
    const failure = new Error("acknowledgement failed");
    vi.mocked(fixture.bridge.acknowledge).mockRejectedValueOnce(failure);
    vi.mocked(fixture.bridge.subscribe)
      .mockResolvedValueOnce({
        subscriptionId: "sub",
        events: [event, next],
      })
      .mockResolvedValueOnce({
        subscriptionId: "recovered",
        events: [],
        cursor: "cursor-1",
      });
    const adapter = createDesktopConversationAdapter(() => fixture.bridge);
    await adapter.request("send", { text: "only once" });
    const error = vi.fn();
    const open = vi.fn();
    const stop = adapter.stream("session", { event: applyCursor, open, error });
    await flushAcknowledgements();
    expect(error).toHaveBeenCalledExactlyOnceWith(failure);
    expect(fixture.bridge.unsubscribe).toHaveBeenCalledExactlyOnceWith("sub");
    await vi.advanceTimersByTimeAsync(500);
    expect(fixture.bridge.subscribe).toHaveBeenLastCalledWith("session", "cursor-1");
    expect(open).toHaveBeenCalledTimes(2);
    expect(fixture.bridge.request).toHaveBeenCalledExactlyOnceWith("send", { text: "only once" });
    expect(fixture.bridge.acknowledge).toHaveBeenCalledExactlyOnceWith("sub", "cursor-1");
    stop();
  });

  it("relays matching control fence notifications without acknowledging a delivery cursor", async () => {
    const fixture = bridgeFixture();
    const receive = vi.fn();
    const stop = createDesktopConversationAdapter(() => fixture.bridge).stream("session", {
      event: receive,
      open: vi.fn(),
      error: vi.fn(),
    });
    await Promise.resolve();
    receive.mockClear();
    fixture.controlChanged("other");
    expect(receive).not.toHaveBeenCalled();
    fixture.controlChanged("session");
    expect(receive).toHaveBeenCalledWith(
      "control-changed",
      JSON.stringify({ sessionId: "session" }),
    );
    receive.mockClear();
    fixture.controlChanged("");
    expect(receive).toHaveBeenCalledExactlyOnceWith(
      "control-changed",
      JSON.stringify({ sessionId: "session" }),
    );
    expect(fixture.bridge.acknowledge).not.toHaveBeenCalled();
    stop();
    receive.mockClear();
    fixture.controlChanged("session");
    expect(receive).not.toHaveBeenCalled();
  });

  it("reconnects observation from its applied cursor without replaying a command", async () => {
    vi.useFakeTimers();
    const fixture = bridgeFixture();
    const stop = createDesktopConversationAdapter(() => fixture.bridge).stream("session", {
      event: (type, data) =>
        type === "session-event" ? (JSON.parse(data).cursor as string) : false,
      open: vi.fn(),
      error: vi.fn(),
    });
    await Promise.resolve();
    fixture.emit(next);
    fixture.unavailable();
    await vi.advanceTimersByTimeAsync(500);
    expect(fixture.bridge.subscribe).toHaveBeenLastCalledWith("session", "cursor-1");
    expect(fixture.bridge.request).not.toHaveBeenCalled();
    stop();
  });

  it("keeps the applied cursor when a consumer rejects a gap and marks an empty replay ready", async () => {
    vi.useFakeTimers();
    const fixture = bridgeFixture();
    const receive = vi.fn((type: string, data: string): string | false =>
      type === "session-event" && JSON.parse(data).seq === 0 ? "cursor-0" : false,
    );
    const stop = createDesktopConversationAdapter(() => fixture.bridge).stream("session", {
      event: receive,
      open: vi.fn(),
      error: vi.fn(),
    });
    await Promise.resolve();
    fixture.emit({ ...next, seq: 9, cursor: "cursor-9" });
    vi.mocked(fixture.bridge.subscribe).mockResolvedValue({
      subscriptionId: "sub-reconnected",
      events: [],
      cursor: "cursor-0",
    });
    fixture.unavailable();
    await vi.advanceTimersByTimeAsync(500);
    expect(fixture.bridge.subscribe).toHaveBeenLastCalledWith("session", "cursor-0");
    expect(receive).toHaveBeenLastCalledWith(
      "session-ready",
      JSON.stringify({ cursor: "cursor-0" }),
    );
    stop();
  });

  it("marks replay ready after the newer notification buffered during IPC bootstrap", async () => {
    vi.useFakeTimers();
    const fixture = bridgeFixture();
    const receive = vi.fn((type: string, data: string) =>
      type === "session-event" ? (JSON.parse(data).cursor as string) : false,
    );
    const stop = createDesktopConversationAdapter(() => fixture.bridge).stream("session", {
      event: receive,
      open: vi.fn(),
      error: vi.fn(),
    });
    await Promise.resolve();
    let finish!: (value: ConversationSubscription<Live>) => void;
    vi.mocked(fixture.bridge.subscribe).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    fixture.unavailable();
    await vi.advanceTimersByTimeAsync(500);
    fixture.emit({ ...next, subscriptionId: "reconnected" });
    finish({ subscriptionId: "reconnected", events: [], cursor: "cursor-0" });
    await Promise.resolve();
    expect(receive).toHaveBeenLastCalledWith(
      "session-ready",
      JSON.stringify({ cursor: "cursor-1" }),
    );
    stop();
  });

  it("rejects attachments above 25 MiB before reading or accessing IPC", async () => {
    const fixture = bridgeFixture();
    const getBridge = vi.fn(() => fixture.bridge);
    const read = vi.fn(async () => new ArrayBuffer(1));
    const progress = vi.fn();
    const file = new File(["a"], "large.txt", { type: "text/plain" });
    Object.defineProperties(file, {
      size: { value: 25 * 1024 * 1024 + 1 },
      arrayBuffer: { value: read },
    });
    await expect(
      createDesktopConversationAdapter(getBridge).uploadAttachment("session", file, progress),
    ).rejects.toMatchObject({ status: 413, code: "attachment_too_large" });
    expect(read).not.toHaveBeenCalled();
    expect(getBridge).not.toHaveBeenCalled();
    expect(fixture.bridge.upload).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
  });

  it("accepts an attachment at exactly 25 MiB", async () => {
    const fixture = bridgeFixture();
    const data = new ArrayBuffer(25 * 1024 * 1024);
    const read = vi.fn(async () => data);
    const progress = vi.fn();
    const file = new File(["a"], "limit.txt", { type: "text/plain" });
    Object.defineProperties(file, {
      size: { value: data.byteLength },
      arrayBuffer: { value: read },
    });
    vi.mocked(fixture.bridge.upload).mockResolvedValue({
      status: 200,
      body: { id: "file", name: file.name, mime: file.type, size: file.size, version: "v1" },
    });
    await expect(
      createDesktopConversationAdapter(() => fixture.bridge).uploadAttachment(
        "session",
        file,
        progress,
      ),
    ).resolves.toMatchObject({ id: "file", size: 25 * 1024 * 1024 });
    expect(read).toHaveBeenCalledOnce();
    expect(fixture.bridge.upload).toHaveBeenCalledExactlyOnceWith({
      sessionId: "session",
      name: file.name,
      mime: file.type,
      data,
    });
    expect(progress.mock.calls).toEqual([[0], [100]]);
  });

  it.each(["before-read", "during-read"])(
    "does not transfer attachments cancelled %s",
    async (when) => {
      const fixture = bridgeFixture();
      const abort = new AbortController();
      const read = vi.fn(async () => {
        abort.abort();
        return new ArrayBuffer(1);
      });
      const file = new File(["a"], "a.txt", { type: "text/plain" });
      Object.defineProperty(file, "arrayBuffer", { value: read });
      if (when === "before-read") abort.abort();
      await expect(
        createDesktopConversationAdapter(() => fixture.bridge).uploadAttachment(
          "session",
          file,
          vi.fn(),
          abort.signal,
        ),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(read).toHaveBeenCalledTimes(when === "before-read" ? 0 : 1);
      expect(fixture.bridge.upload).not.toHaveBeenCalled();
      expect(fixture.bridge.request).not.toHaveBeenCalled();
    },
  );

  it("cleans up an attachment when cancellation arrives after IPC transfer", async () => {
    const fixture = bridgeFixture();
    const abort = new AbortController();
    const file = new File(["a"], "a.txt", { type: "text/plain" });
    Object.defineProperty(file, "arrayBuffer", { value: async () => new ArrayBuffer(1) });
    vi.mocked(fixture.bridge.upload).mockImplementation(async () => {
      abort.abort();
      return {
        status: 200,
        body: { id: "file", name: "a.txt", mime: "text/plain", size: 1, version: "v1" },
      };
    });
    await expect(
      createDesktopConversationAdapter(() => fixture.bridge).uploadAttachment(
        "session",
        file,
        vi.fn(),
        abort.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fixture.bridge.request).toHaveBeenCalledWith("attachments/delete", {
      sessionId: "session",
      attachmentId: "file",
      version: "v1",
    });
  });
});
