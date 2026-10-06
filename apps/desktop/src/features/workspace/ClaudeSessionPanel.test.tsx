// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { ClaudeSessionPanel } from "./ClaudeSessionPanel";
import type { Live } from "../../../../../packages/web-client/src/index";
import type { SessionStreamHandlers } from "@agentkib/web-client";
vi.mock("@/core/api", () => ({ api: { claudeRequest: vi.fn() } }));
vi.mock("@/core/useI18n", () => ({ useI18n: () => ({ locale }) }));
vi.mock("@/components/MarkdownContent", () => ({
  MarkdownContent: ({ content }: { content: string }) => <p>{content}</p>,
}));
vi.mock("@/core/conversation-bridge", () => ({
  hasDesktopConversation: () => true,
  createDesktopConversationAdapter: () => ({
    request: async () => {
      if (accessError) throw accessError;
      return {
        protocolVersion: 2,
        status: "approved",
        bootId: "boot",
        csrfToken: "local",
        experimentalEnabled: true,
      };
    },
    stream: (id: string, handlers: SessionStreamHandlers) => {
      const listeners = streams.get(id) ?? new Set<SessionStreamHandlers>();
      listeners.add(handlers);
      streams.set(id, listeners);
      queueMicrotask(() => {
        if (!listeners.has(handlers)) return;
        handlers.open();
        handlers.event(
          "session-event",
          JSON.stringify({
            protocolVersion: 2,
            subscriptionId: id || "catalog",
            sessionId: id,
            runtimeBootId: "boot",
            epoch: "epoch",
            seq: 0,
            cursor: `${id}:0`,
            type: "snapshot",
            payload: { live: { ...live, sessionId: id } },
          }),
        );
        handlers.event("session-ready", JSON.stringify({ cursor: `${id}:0` }));
      });
      return () => {
        listeners.delete(handlers);
        stopped(id);
      };
    },
  }),
}));
let live: Live;
let locale = "en-US";
let accessError: Error | undefined;
let streams: Map<string, Set<SessionStreamHandlers>>;
const stopped = vi.fn();
function notifyControl(sessionId = "session") {
  for (const handlers of streams.get(sessionId) ?? [])
    handlers.event("control-changed", JSON.stringify({ sessionId }));
}
function emitNative(seq: number, type: string, payload: unknown, sessionId = "session") {
  for (const handlers of streams.get(sessionId) ?? [])
    handlers.event(
      "session-event",
      JSON.stringify({
        protocolVersion: 2,
        subscriptionId: sessionId,
        sessionId,
        runtimeBootId: "boot",
        epoch: "epoch",
        seq,
        cursor: `${sessionId}:${seq}`,
        type,
        payload,
      }),
    );
}
const calls = (operation: string) =>
  vi.mocked(api.claudeRequest).mock.calls.filter(([value]) => value.operation === operation);
function mount(sessionId = "session") {
  return render(
    <ClaudeSessionPanel
      workspaceId="workspace"
      initialSessionId={sessionId || undefined}
      onClose={vi.fn()}
    />,
  );
}
async function enabled(element: HTMLElement) {
  await waitFor(() => expect(element).toBeEnabled());
  return element;
}
async function enterMessage(text: string) {
  fireEvent.change(await enabled(screen.getByLabelText("Message")), { target: { value: text } });
}
beforeEach(() => {
  localStorage.clear();
  locale = "en-US";
  accessError = undefined;
  streams = new Map();
  stopped.mockReset();
  vi.spyOn(globalThis, "setInterval");
  live = {
    sessionId: "session",
    status: "idle",
    revision: 1,
    sendEnabled: true,
    executionMode: "claude-managed",
    approvals: [],
    questions: [],
  };
  vi.mocked(api.claudeRequest)
    .mockReset()
    .mockImplementation(async (value) => {
      switch (value.operation) {
        case "options":
          return { available: true, workspaces: [{ id: "workspace", name: "Project" }] };
        case "catalog":
          return {
            indexEnabled: true,
            sessions: [
              {
                id: "session",
                workspace_id: "workspace",
                agent: "claude-code",
                title: "Synthetic session",
              },
            ],
          };
        case "live":
          return live;
        case "events":
          return {
            events: [{ id: "message", kind: "agent-message", content: "Synthetic history" }],
            warnings: [],
          };
        case "capabilities":
          return {
            sessionId: "session",
            features: {
              attachments: { available: live.sendEnabled === true },
              files: { available: true },
            },
          };
        case "files":
          return {
            directoryId: "root",
            entries: [
              {
                id: "artifact",
                name: "result.txt",
                kind: "file",
                previewKind: "text",
                revision: "v1",
              },
            ],
          };
        case "inspect":
          return { sessionId: "session", handoffFingerprint: "frozen-history" };
        case "receipt":
          return { found: false, requestId: value.requestId };
        default:
          return { accepted: true, sessionId: "session" };
      }
    });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe("Claude local owner panel", () => {
  it("shares native usage and compaction state while preserving native stop", async () => {
    live = {
      ...live,
      usage: { available: true, state: "ready", reportId: 1, usedTokens: 0, contextWindow: 100 },
    };
    mount();
    await screen.findByText("Synthetic history");
    await enabled(screen.getByLabelText("Message"));
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "next" } });
    expect(screen.getByRole("button", { name: "Context usage" })).toHaveTextContent("0%");
    act(() =>
      emitNative(1, "state", {
        revision: 2,
        status: "running",
        turnId: "turn",
        sendEnabled: false,
        stopEnabled: true,
        activity: "compacting",
      }),
    );
    expect(screen.getByRole("button", { name: "Context usage" })).toHaveTextContent(
      "Compacting context",
    );
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Release to original client" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
    act(() => emitNative(2, "state", { revision: 3, activity: null }));
    expect(screen.getByRole("button", { name: "Context usage" })).toHaveTextContent(
      "Awaiting update",
    );
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    act(() =>
      emitNative(3, "state", {
        revision: 4,
        usage: { available: true, state: "ready", reportId: 2, usedTokens: 4, contextWindow: 100 },
      }),
    );
    expect(screen.getByRole("button", { name: "Context usage" })).toHaveTextContent("4%");
  });
  it.each(["before", "after"])(
    "recovers an admission-busy history read when another session settles %s its response",
    async (settlement) => {
      mount();
      await screen.findByText("Synthetic history");
      await enabled(screen.getByLabelText("Message"));
      const pending = {
        requestId: crypto.randomUUID(),
        operation: "send",
        sessionId: "session",
        workspaceId: "workspace",
      };
      localStorage.setItem("agentkib:claude-owner-pending:v1:workspace", JSON.stringify(pending));
      const original = vi.mocked(api.claudeRequest).getMockImplementation()!;
      let reject!: (error: Error) => void;
      let busy = true;
      vi.mocked(api.claudeRequest).mockImplementation((value) => {
        if (value.operation !== "events") return original(value);
        if (busy)
          return new Promise((_resolve, fail) => {
            reject = fail;
          });
        return Promise.resolve({
          events: [
            {
              id: "message",
              kind: "agent-message",
              content: "Recovered history",
              attachment_count: 0,
              truncated: false,
            },
          ],
          warnings: [],
        });
      });
      act(() => emitNative(1, "invalidate", { domains: ["history"] }));
      await waitFor(() => expect(reject).toBeTypeOf("function"));
      const settled = () => {
        for (const handlers of streams.get("") ?? [])
          handlers.event("control-changed", JSON.stringify({ sessionId: "another-session" }));
      };
      await act(async () => {
        if (settlement === "before") settled();
        busy = false;
        reject(new Error("Error invoking remote method 'claude:request': Error: operation_busy"));
      });
      if (settlement === "after") await act(async () => settled());
      expect(await screen.findByText("Recovered history")).toBeVisible();
      expect(
        JSON.parse(localStorage.getItem("agentkib:claude-owner-pending:v1:workspace")!),
      ).toEqual(pending);
      expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
      expect(calls("send")).toHaveLength(0);
    },
  );
  it("renegotiates a failed initial access read when explicitly refreshed", async () => {
    accessError = new Error("access_unavailable");
    mount();
    await screen.findByText("access_unavailable");
    expect(streams.get("session")).toBeUndefined();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    accessError = undefined;
    fireEvent.click(await enabled(screen.getByRole("button", { name: "Refresh" })));
    await waitFor(() => expect(streams.get("session")?.size).toBe(1));
    await enterMessage("Ready after recovery");
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());
  });
  it.each(["empty-replay", "baseline"])(
    "recovers idle controls after only the catalog subscription reconnects with %s",
    async (recovery) => {
      mount();
      await screen.findByText("Synthetic history");
      await enterMessage("Preserved draft");
      await enabled(screen.getByRole("button", { name: "Send" }));
      await enabled(screen.getByLabelText("Add images or files"));
      const detail = [...streams.get("session")!][0];
      const catalog = [...streams.get("")!][0];
      const historyReads = calls("events").length;
      const liveReads = calls("live").length;
      const capabilityReads = calls("capabilities").length;
      await act(async () => catalog.error(new Error("catalog_subscription_failed")));
      expect(await screen.findByText("catalog_subscription_failed")).toBeVisible();
      expect(screen.getByLabelText("Message")).toBeDisabled();
      expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
      expect(screen.getByLabelText("Add images or files")).toBeDisabled();

      await act(async () => {
        if (recovery === "baseline")
          emitNative(1, "snapshot", { live: { ...live, sessionId: "" } }, "");
        catalog.event(
          "session-ready",
          JSON.stringify({ cursor: recovery === "baseline" ? ":1" : ":0" }),
        );
        catalog.open();
      });
      await enabled(screen.getByLabelText("Message"));
      await enabled(screen.getByRole("button", { name: "Send" }));
      await enabled(screen.getByLabelText("Add images or files"));
      await waitFor(() =>
        expect(screen.queryByText("catalog_subscription_failed")).not.toBeInTheDocument(),
      );
      expect(screen.getByLabelText("Message")).toHaveValue("Preserved draft");
      expect(calls("capabilities").length).toBeGreaterThan(capabilityReads);
      expect(calls("events")).toHaveLength(historyReads);
      expect(calls("live")).toHaveLength(liveReads);
      expect([...streams.get("session")!]).toEqual([detail]);
      expect(stopped).not.toHaveBeenCalledWith("session");
      expect(calls("send")).toHaveLength(0);
    },
  );
  it("does not restore catalog readiness from a mismatched cursor", async () => {
    mount();
    await screen.findByText("Synthetic history");
    await enterMessage("Preserved draft");
    const catalog = [...streams.get("")!][0];
    await act(async () => catalog.error(new Error("catalog_subscription_failed")));
    await act(async () => {
      catalog.event("session-ready", JSON.stringify({ cursor: "unapplied-cursor" }));
      catalog.open();
      // A healthy detail stream cannot prove that the separate catalog recovered.
      emitNative(1, "state", { revision: 2, sendEnabled: true });
    });
    expect(screen.getByText("catalog_subscription_failed")).toBeVisible();
    expect(screen.getByLabelText("Message")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByLabelText("Add images or files")).toBeDisabled();
    await act(async () => catalog.event("session-ready", JSON.stringify({ cursor: ":0" })));
    await enabled(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByLabelText("Message")).toHaveValue("Preserved draft");
  });
  it("ignores obsolete catalog errors and readiness after resynchronizing a gap", async () => {
    mount();
    await screen.findByText("Synthetic history");
    await enterMessage("Preserved draft");
    const previous = [...streams.get("")!][0];
    const detail = [...streams.get("session")!][0];
    await act(async () => emitNative(2, "state", { revision: 2 }, ""));
    await waitFor(() => {
      expect(streams.get("")?.size).toBe(1);
      expect([...streams.get("")!][0]).not.toBe(previous);
    });
    await enabled(screen.getByRole("button", { name: "Send" }));
    const current = [...streams.get("")!][0];
    await act(async () => previous.error(new Error("obsolete_catalog_failure")));
    expect(screen.queryByText("obsolete_catalog_failure")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
    await act(async () => {
      current.error(new Error("current_catalog_failure"));
      previous.event("session-ready", JSON.stringify({ cursor: ":0" }));
    });
    expect(screen.getByText("current_catalog_failure")).toBeVisible();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    await act(async () => current.event("session-ready", JSON.stringify({ cursor: ":0" })));
    await enabled(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByLabelText("Message")).toHaveValue("Preserved draft");
    expect([...streams.get("session")!]).toEqual([detail]);
    expect(stopped).not.toHaveBeenCalledWith("session");
    expect(calls("send")).toHaveLength(0);
  });
  it.each(["detail-stream", "metadata"])(
    "keeps the independent %s failure fenced after catalog recovery",
    async (failure) => {
      mount();
      await screen.findByText("Synthetic history");
      await enterMessage("Preserved draft");
      await enabled(screen.getByRole("button", { name: "Send" }));
      const detail = [...streams.get("session")!][0];
      const catalog = [...streams.get("")!][0];
      const original = vi.mocked(api.claudeRequest).getMockImplementation()!;
      if (failure === "metadata")
        vi.mocked(api.claudeRequest).mockImplementation((value) =>
          value.operation === "capabilities"
            ? Promise.reject(new Error("metadata_unavailable"))
            : original(value),
        );
      await act(async () => {
        if (failure === "detail-stream") detail.error(new Error("detail_disconnected"));
        else emitNative(1, "invalidate", { domains: ["catalog"] }, "");
      });
      if (failure === "metadata")
        expect(await screen.findByText("metadata_unavailable")).toBeVisible();
      await act(async () => catalog.error(new Error("catalog_subscription_failed")));
      const capabilityReads = calls("capabilities").length;
      await act(async () => {
        catalog.event(
          "session-ready",
          JSON.stringify({ cursor: failure === "metadata" ? ":1" : ":0" }),
        );
        catalog.open();
      });
      await waitFor(() => expect(calls("capabilities").length).toBeGreaterThan(capabilityReads));
      await waitFor(() =>
        expect(screen.queryByText("catalog_subscription_failed")).not.toBeInTheDocument(),
      );
      expect(screen.getByLabelText("Message")).toBeDisabled();
      expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
      expect(screen.getByLabelText("Add images or files")).toBeDisabled();
      expect(screen.getByLabelText("Message")).toHaveValue("Preserved draft");
      if (failure === "metadata") expect(screen.getByText("metadata_unavailable")).toBeVisible();
      expect(calls("send")).toHaveLength(0);
    },
  );
  it.each([false, true])(
    "reconciles a missed receipt after catalog empty replay without replaying the command (settled=%s)",
    async (settled) => {
      const key = "agentkib:claude-owner-pending:v1:workspace";
      const pending = {
        requestId: crypto.randomUUID(),
        operation: "send",
        sessionId: "session",
        workspaceId: "workspace",
      };
      localStorage.setItem(key, JSON.stringify(pending));
      mount();
      await screen.findByText("Synthetic history");
      await waitFor(() => expect(calls("receipt").length).toBeGreaterThan(0));
      expect(screen.getByLabelText("Message")).toBeDisabled();
      const catalog = [...streams.get("")!][0];
      await act(async () => catalog.error(new Error("catalog_subscription_failed")));
      const original = vi.mocked(api.claudeRequest).getMockImplementation()!;
      if (settled)
        vi.mocked(api.claudeRequest).mockImplementation((value) =>
          value.operation === "receipt"
            ? Promise.resolve({ ...pending, found: true, status: "accepted" })
            : original(value),
        );
      const receiptReads = calls("receipt").length;
      await act(async () => {
        catalog.event("session-ready", JSON.stringify({ cursor: ":0" }));
        catalog.open();
      });
      await waitFor(() => expect(calls("receipt").length).toBeGreaterThan(receiptReads));
      if (settled) {
        await enabled(screen.getByLabelText("Message"));
        await enabled(screen.getByLabelText("Add images or files"));
        expect(localStorage.getItem(key)).toBeNull();
        await enterMessage("New command after confirmed receipt");
        await enabled(screen.getByRole("button", { name: "Send" }));
      } else {
        expect(JSON.parse(localStorage.getItem(key)!)).toEqual(pending);
        expect(screen.getByLabelText("Message")).toBeDisabled();
        expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
        expect(screen.getByLabelText("Add images or files")).toBeDisabled();
      }
      await waitFor(() =>
        expect(screen.queryByText("catalog_subscription_failed")).not.toBeInTheDocument(),
      );
      expect(calls("send")).toHaveLength(0);
    },
  );
  it("applies native text without polling history and only unsubscribes on close", async () => {
    const view = mount();
    await screen.findByText("Synthetic history");
    await enabled(screen.getByLabelText("Message"));
    const reads = calls("events").length;
    const liveReads = calls("live").length;
    const capabilityReads = calls("capabilities").length;
    act(() => {
      emitNative(1, "text-delta", { itemId: "reply", turnId: "turn", text: "Native", offset: 0 });
      emitNative(2, "text-delta", { itemId: "reply", turnId: "turn", text: " reply", offset: 6 });
    });
    expect(await screen.findByText("Native reply")).toBeVisible();
    expect(calls("events")).toHaveLength(reads);
    expect(calls("live")).toHaveLength(liveReads);
    expect(calls("capabilities")).toHaveLength(capabilityReads);
    expect(
      vi.mocked(globalThis.setInterval).mock.calls.filter(([, delay]) => delay === 1000),
    ).toEqual([]);
    view.unmount();
    expect(stopped).toHaveBeenCalledWith("session");
    expect(stopped).toHaveBeenCalledWith("");
    expect(calls("stop")).toHaveLength(0);
    expect(calls("release")).toHaveLength(0);
  });
  it.each(["options", "catalog", "capabilities"])(
    "recovers idle controls after a transient %s failure through catalog events alone",
    async (operation) => {
      mount();
      await screen.findByText("Synthetic history");
      await enterMessage("Preserved draft");
      await enabled(screen.getByRole("button", { name: "Send" }));
      await enabled(screen.getByLabelText("Add images or files"));
      const original = vi.mocked(api.claudeRequest).getMockImplementation()!;
      let failed = true;
      vi.mocked(api.claudeRequest).mockImplementation((value) =>
        value.operation === operation && failed
          ? Promise.reject(new Error("transient_metadata_failure"))
          : original(value),
      );
      const listener = [...streams.get("session")!][0];
      const historyReads = calls("events").length;
      const liveReads = calls("live").length;
      await act(async () => emitNative(1, "invalidate", { domains: ["catalog"] }, ""));
      expect(await screen.findByText("transient_metadata_failure")).toBeVisible();
      expect(screen.getByLabelText("Message")).toBeDisabled();
      expect(screen.getByLabelText("Add images or files")).toBeDisabled();
      failed = false;
      await act(async () => emitNative(2, "invalidate", { domains: ["catalog"] }, ""));
      await enabled(screen.getByLabelText("Message"));
      await enabled(screen.getByRole("button", { name: "Send" }));
      await enabled(screen.getByLabelText("Add images or files"));
      await waitFor(() =>
        expect(screen.queryByText("transient_metadata_failure")).not.toBeInTheDocument(),
      );
      expect(screen.getByLabelText("Message")).toHaveValue("Preserved draft");
      expect([...streams.get("session")!]).toEqual([listener]);
      expect(stopped).not.toHaveBeenCalledWith("session");
      expect(calls("events")).toHaveLength(historyReads);
      expect(calls("live")).toHaveLength(liveReads);
      expect(calls("send")).toHaveLength(0);
    },
  );
  it("keeps controls blocked during metadata failure while continuing to display native progress", async () => {
    mount();
    await screen.findByText("Synthetic history");
    await enterMessage("Preserved draft");
    const original = vi.mocked(api.claudeRequest).getMockImplementation()!;
    vi.mocked(api.claudeRequest).mockImplementation((value) =>
      value.operation === "options"
        ? Promise.reject(new Error("transient_metadata_failure"))
        : original(value),
    );
    await act(async () => emitNative(1, "invalidate", { domains: ["catalog"] }, ""));
    expect(await screen.findByText("transient_metadata_failure")).toBeVisible();
    await act(async () => {
      emitNative(1, "text-delta", { itemId: "reply", text: "Still observing", offset: 0 });
      emitNative(2, "state", { revision: 2, status: "idle", sendEnabled: true });
    });
    expect(await screen.findByText("Still observing")).toBeVisible();
    expect(screen.getByText("transient_metadata_failure")).toBeVisible();
    expect(screen.getByLabelText("Message")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByLabelText("Add images or files")).toBeDisabled();
    expect(calls("send")).toHaveLength(0);
  });
  it("keeps a failed full history refresh pending until a later catalog event completes that read", async () => {
    mount();
    await screen.findByText("Synthetic history");
    await enterMessage("Preserved draft");
    const original = vi.mocked(api.claudeRequest).getMockImplementation()!;
    let historyFailed = true;
    vi.mocked(api.claudeRequest).mockImplementation((value) =>
      value.operation === "events" && historyFailed
        ? Promise.reject(new Error("history_refresh_failed"))
        : original(value),
    );
    fireEvent.click(await enabled(screen.getByRole("button", { name: "Refresh" })));
    expect(await screen.findByText("history_refresh_failed")).toBeVisible();
    expect(screen.getByLabelText("Message")).toBeDisabled();
    const failedReads = calls("events").length;
    await act(async () => emitNative(1, "invalidate", { domains: ["catalog"] }, ""));
    await waitFor(() => expect(calls("events").length).toBeGreaterThan(failedReads));
    expect(screen.getByText("history_refresh_failed")).toBeVisible();
    expect(screen.getByLabelText("Message")).toBeDisabled();
    expect(screen.getByLabelText("Add images or files")).toBeDisabled();
    historyFailed = false;
    await act(async () => emitNative(2, "invalidate", { domains: ["catalog"] }, ""));
    await enabled(screen.getByLabelText("Message"));
    await enabled(screen.getByRole("button", { name: "Send" }));
    await enabled(screen.getByLabelText("Add images or files"));
    await waitFor(() =>
      expect(screen.queryByText("history_refresh_failed")).not.toBeInTheDocument(),
    );
    expect(screen.getByLabelText("Message")).toHaveValue("Preserved draft");
    expect(calls("send")).toHaveLength(0);
  });
  it.each(["stream", "control"])(
    "does not reopen controls after %s failure when metadata succeeds late or on a later event",
    async (failure) => {
      mount();
      await screen.findByText("Synthetic history");
      await enterMessage("Preserved draft");
      fireEvent.click(await enabled(screen.getByRole("button", { name: "Files and artifacts" })));
      await screen.findByRole("button", { name: "result.txt" });
      const original = vi.mocked(api.claudeRequest).getMockImplementation()!;
      let release!: () => void;
      let deferCapabilities = true;
      vi.mocked(api.claudeRequest).mockImplementation((value) => {
        if (value.operation === "live") return Promise.reject(new Error("host_offline"));
        if (value.operation === "capabilities" && deferCapabilities) {
          deferCapabilities = false;
          const result = original(value);
          return new Promise((resolve) => {
            release = () => resolve(result);
          });
        }
        return original(value);
      });
      await act(async () => emitNative(1, "invalidate", { domains: ["catalog"] }, ""));
      await waitFor(() => expect(release).toBeTypeOf("function"));
      await act(async () => {
        if (failure === "control") notifyControl();
        else
          for (const handlers of streams.get("session") ?? [])
            handlers.error(new Error("host_offline"));
      });
      const expectDisconnected = () => {
        expect(screen.getByLabelText("Message")).toBeDisabled();
        expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
        expect(screen.getByLabelText("Add images or files")).toBeDisabled();
        expect(
          screen.queryByRole("button", { name: "Files and artifacts" }),
        ).not.toBeInTheDocument();
        expect(screen.queryByText("result.txt")).not.toBeInTheDocument();
        if (failure === "control") expect(screen.getByText("host_offline")).toBeVisible();
      };
      expectDisconnected();
      await act(async () => release());
      expectDisconnected();
      const beforeReads = calls("capabilities").length;
      await act(async () => emitNative(2, "invalidate", { domains: ["catalog"] }, ""));
      await waitFor(() => expect(calls("capabilities").length).toBeGreaterThan(beforeReads));
      expectDisconnected();
      expect(calls("send")).toHaveLength(0);
    },
  );
  it("restores attachments when a turn running on entry completes through the native stream", async () => {
    live = { ...live, status: "running", sendEnabled: false, turnId: "turn" };
    mount();
    await screen.findByText("Synthetic history");
    await enabled(screen.getByLabelText("Message"));
    expect(screen.getByLabelText("Add images or files")).toBeDisabled();
    const capabilityReads = calls("capabilities").length;
    live = { ...live, status: "idle", sendEnabled: true, revision: 2 };
    await act(async () => {
      emitNative(1, "state", { status: "idle", sendEnabled: true, revision: 2 });
      emitNative(2, "invalidate", {
        domains: ["history", "catalog", "queue", "usage", "goal", "settings"],
      });
      emitNative(1, "invalidate", { domains: ["catalog"] }, "");
    });
    expect(await screen.findByText("Idle")).toBeVisible();
    await enabled(screen.getByLabelText("Add images or files"));
    expect(calls("capabilities").length).toBeGreaterThan(capabilityReads);
    expect(calls("send")).toHaveLength(0);
  });
  it("updates attachments when another client starts and completes a turn", async () => {
    mount();
    await screen.findByText("Synthetic history");
    await enabled(screen.getByLabelText("Add images or files"));
    const capabilityReads = calls("capabilities").length;
    live = { ...live, status: "running", sendEnabled: false, turnId: "turn", revision: 2 };
    await act(async () => {
      emitNative(1, "state", {
        status: "running",
        sendEnabled: false,
        turnId: "turn",
        revision: 2,
      });
      emitNative(1, "invalidate", { domains: ["catalog"] }, "");
    });
    await waitFor(() => expect(screen.getByLabelText("Add images or files")).toBeDisabled());
    expect(calls("capabilities").length).toBeGreaterThan(capabilityReads);
    const runningCapabilityReads = calls("capabilities").length;
    live = { ...live, status: "idle", sendEnabled: true, revision: 3 };
    await act(async () => {
      emitNative(2, "state", { status: "idle", sendEnabled: true, revision: 3 });
      emitNative(3, "invalidate", {
        domains: ["history", "catalog", "queue", "usage", "goal", "settings"],
      });
      emitNative(2, "invalidate", { domains: ["catalog"] }, "");
    });
    await enabled(screen.getByLabelText("Add images or files"));
    expect(calls("capabilities").length).toBeGreaterThan(runningCapabilityReads);
    expect(calls("send")).toHaveLength(0);
  });
  it("retains a completion notification while the initial capabilities read is in flight", async () => {
    live = { ...live, status: "running", sendEnabled: false, turnId: "turn" };
    const original = vi.mocked(api.claudeRequest).getMockImplementation()!;
    let settle!: () => void;
    let firstCapabilities = true;
    vi.mocked(api.claudeRequest).mockImplementation((value) => {
      if (value.operation !== "capabilities" || !firstCapabilities) return original(value);
      firstCapabilities = false;
      const result = original(value);
      return new Promise((resolve) => {
        settle = () => resolve(result);
      });
    });
    mount();
    await waitFor(() => expect(streams.get("session")?.size).toBe(1));
    expect(calls("capabilities").length).toBeGreaterThan(0);
    live = { ...live, status: "idle", sendEnabled: true, revision: 2 };
    await act(async () => {
      emitNative(1, "state", { status: "idle", sendEnabled: true, revision: 2 });
      emitNative(2, "invalidate", {
        domains: ["history", "catalog", "queue", "usage", "goal", "settings"],
      });
      emitNative(1, "invalidate", { domains: ["catalog"] }, "");
    });
    await act(async () => settle());
    expect(await screen.findByText("Idle")).toBeVisible();
    await enabled(screen.getByLabelText("Add images or files"));
    expect(calls("capabilities").length).toBeGreaterThan(1);
    expect(calls("send")).toHaveLength(0);
  });
  it.each(["before", "after"])(
    "recovers admission-busy capabilities when another session settles %s the read response",
    async (settlement) => {
      live = { ...live, status: "running", sendEnabled: false, turnId: "turn" };
      mount();
      await screen.findByText("Synthetic history");
      await enabled(screen.getByLabelText("Message"));
      expect(screen.getByLabelText("Add images or files")).toBeDisabled();
      const original = vi.mocked(api.claudeRequest).getMockImplementation()!;
      let reject!: (error: Error) => void;
      let busy = true;
      vi.mocked(api.claudeRequest).mockImplementation((value) => {
        if (value.operation === "capabilities" && busy)
          return new Promise((_resolve, fail) => {
            reject = fail;
          });
        return original(value);
      });
      live = { ...live, status: "idle", sendEnabled: true, revision: 2 };
      await act(async () => {
        emitNative(1, "state", { status: "idle", sendEnabled: true, revision: 2 });
        emitNative(2, "invalidate", {
          domains: ["history", "catalog", "queue", "usage", "goal", "settings"],
        });
        emitNative(1, "invalidate", { domains: ["catalog"] }, "");
      });
      await waitFor(() => expect(reject).toBeTypeOf("function"));
      const settled = () => {
        for (const handlers of streams.get("") ?? [])
          handlers.event("control-changed", JSON.stringify({ sessionId: "another-session" }));
      };
      await act(async () => {
        if (settlement === "before") settled();
        busy = false;
        reject(new Error("Error invoking remote method 'claude:request': Error: operation_busy"));
      });
      if (settlement === "after") await act(async () => settled());
      await enabled(screen.getByLabelText("Add images or files"));
      expect(calls("send")).toHaveLength(0);
    },
  );
  it("resynchronizes a sequence gap before applying new native items", async () => {
    mount();
    await screen.findByText("Synthetic history");
    await enabled(screen.getByLabelText("Message"));
    await act(async () =>
      emitNative(3, "text-delta", { itemId: "reply", text: "missing", offset: 0 }),
    );
    expect(stopped).toHaveBeenCalledWith("session");
    expect(screen.queryByText("missing")).not.toBeInTheDocument();
    act(() => emitNative(1, "text-delta", { itemId: "reply", text: "Recovered", offset: 0 }));
    expect(await screen.findByText("Recovered")).toBeVisible();
    expect(calls("send")).toHaveLength(0);
  });
  it("resolves an indexed history entry to its exact managed identity", async () => {
    const original = vi.mocked(api.claudeRequest).getMockImplementation()!;
    vi.mocked(api.claudeRequest).mockImplementation(async (value) => {
      if (value.operation !== "catalog") return original(value);
      return {
        indexEnabled: true,
        sessions: [
          {
            id: "session",
            indexedSessionId: "history-id",
            workspace_id: "workspace",
            agent: "claude-code",
          },
        ],
      };
    });
    mount("history-id");
    await screen.findByText("Synthetic history");
    expect(calls("live")).toEqual([[{ operation: "live", sessionId: "session" }]]);
    expect(calls("events")).toEqual([[{ operation: "events", sessionId: "session" }]]);
  });
  it.each(["other-workspace", "ambiguous"])("rejects %s index mappings", async (kind) => {
    const original = vi.mocked(api.claudeRequest).getMockImplementation()!;
    vi.mocked(api.claudeRequest).mockImplementation(async (value) => {
      if (value.operation !== "catalog") return original(value);
      const row = {
        id: "session",
        indexedSessionId: "history-id",
        workspace_id: kind === "other-workspace" ? "other" : "workspace",
        agent: "claude-code",
      };
      return {
        indexEnabled: true,
        sessions: kind === "ambiguous" ? [row, { ...row, id: "second" }] : [row],
      };
    });
    mount("history-id");
    await screen.findByText("claude_session_unavailable");
    expect(calls("live")).toHaveLength(0);
    expect(calls("events")).toHaveLength(0);
    expect(streams.get("history-id")).toBeUndefined();
  });
  it("opens files from the session panel and clears them when host access is lost", async () => {
    mount();
    await screen.findByText("Synthetic history");
    await enabled(screen.getByLabelText("Message"));
    expect(screen.getByRole("combobox", { name: "Session" })).toHaveTextContent(
      "Synthetic session",
    );
    expect(calls("files")).toHaveLength(0);
    fireEvent.click(await enabled(screen.getByRole("button", { name: "Files and artifacts" })));
    await screen.findByRole("button", { name: "result.txt" });
    expect(calls("files")).toEqual([[{ operation: "files", sessionId: "session" }]]);
    const original = vi.mocked(api.claudeRequest).getMockImplementation()!;
    vi.mocked(api.claudeRequest).mockImplementation((value) =>
      value.operation === "live" ? Promise.reject(new Error("host_offline")) : original(value),
    );
    await act(async () => notifyControl());
    expect(screen.queryByRole("button", { name: "Files and artifacts" })).not.toBeInTheDocument();
    expect(screen.queryByText("result.txt")).not.toBeInTheDocument();
  });
  it("localizes idle status and renders completed history only once", async () => {
    locale = "zh-CN";
    live = { ...live, streamText: "Synthetic history" };
    mount();
    await screen.findByText("空闲");
    expect(screen.getAllByText("Synthetic history")).toHaveLength(1);
    expect(screen.queryByText("idle")).not.toBeInTheDocument();
  });

  it("prepares a new session without starting a model request", async () => {
    mount("");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "New Claude task" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "New Claude task" }));
    await waitFor(() => expect(calls("create")).toHaveLength(1));
    expect(calls("create")[0][0]).toMatchObject({
      workspaceId: "workspace",
      requestId: expect.any(String),
    });
    expect(calls("send")).toHaveLength(0);
  });
  it("binds the explicit takeover to the inspected source fingerprint", async () => {
    live = { ...live, executionMode: "managed-resume", sendEnabled: false };
    mount();
    await screen.findByText("Synthetic history");
    const prepare = screen.getByRole("button", { name: "Prepare handoff" });
    await waitFor(() => expect(prepare).toBeEnabled());
    fireEvent.click(prepare);
    fireEvent.click(await enabled(await screen.findByRole("checkbox")));
    fireEvent.click(await enabled(screen.getByRole("button", { name: "Hand over to AgentKib" })));
    await waitFor(() => expect(calls("adopt")).toHaveLength(1));
    expect(calls("adopt")[0][0]).toMatchObject({
      sessionId: "session",
      handoffConfirmed: true,
      handoffFingerprint: "frozen-history",
    });
  });
  it("persists a lost send receipt across reopening and never replays it during refresh", async () => {
    const original = vi.mocked(api.claudeRequest).getMockImplementation()!;
    vi.mocked(api.claudeRequest).mockImplementation((value) =>
      value.operation === "send" ? Promise.reject(new Error("lost_response")) : original(value),
    );
    const view = mount();
    await screen.findByText("Synthetic history");
    await enterMessage("only once");
    fireEvent.click(await enabled(screen.getByRole("button", { name: "Send" })));
    await screen.findByText("lost_response");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    view.unmount();
    mount();
    await screen.findByText("Synthetic history");
    await act(async () => notifyControl());
    expect(calls("send")).toHaveLength(1);
    expect(calls("receipt").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });
  it("dismisses approvals without deciding and refuses a changed form after the other client responds", async () => {
    const approval = {
      requestId: "approval",
      turnId: "turn",
      method: "claude/can_use_tool",
      supported: true,
      availableDecisions: ["allow", "deny"],
      input: { command: "echo safe" },
    };
    live = {
      ...live,
      status: "waiting-approval",
      sendEnabled: false,
      turnId: "turn",
      approvals: [approval],
    };
    mount();
    await enabled(await screen.findByRole("button", { name: "Allow" }));
    fireEvent.click(await enabled(screen.getByRole("button", { name: "Dismiss" })));
    expect(calls("approve")).toHaveLength(0);
    fireEvent.click(await enabled(screen.getByRole("button", { name: "Review approval" })));
    live = { ...live, revision: 2, approvals: [] };
    await act(async () => notifyControl());
    expect(screen.getByRole("button", { name: "Allow" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(calls("approve")).toHaveLength(0);
  });
  it.each([false, true])(
    "keeps question presets and custom input consistent (multiSelect=%s)",
    async (multiSelect) => {
      live = {
        ...live,
        status: "waiting-input",
        sendEnabled: false,
        turnId: "turn",
        questions: [
          {
            requestId: "question",
            turnId: "turn",
            supported: true,
            questions: [
              {
                id: "color",
                question: "Choose a color",
                options: [{ label: "Blue" }, { label: "Green" }],
                multiSelect,
                allowCustom: true,
              },
            ],
          },
        ],
      };
      mount();
      const blue = await enabled(await screen.findByRole("checkbox", { name: "Blue" }));
      fireEvent.click(blue);
      const custom = screen.getByLabelText("Choose a color Custom answer");
      fireEvent.change(await enabled(custom), { target: { value: "Other color" } });
      if (multiSelect) expect(blue).toBeChecked();
      else expect(blue).not.toBeChecked();
      fireEvent.click(await enabled(screen.getByRole("checkbox", { name: "Green" })));
      expect(custom).toHaveValue(multiSelect ? "Other color" : "");
      const submit = screen.getByRole("button", { name: "Submit answers" });
      await enabled(submit);
      fireEvent.click(submit);
      await waitFor(() => expect(calls("answer")).toHaveLength(1));
      expect(calls("answer")[0][0]).toMatchObject({
        sessionId: "session",
        questionId: "question",
        turnId: "turn",
        answers: { color: multiSelect ? ["Blue", "Green", "Other color"] : ["Green"] },
      });
    },
  );

  it("sends uploaded file identity without requiring text or exposing renderer file paths", async () => {
    const original = vi.mocked(api.claudeRequest).getMockImplementation()!;
    vi.mocked(api.claudeRequest).mockImplementation((value) =>
      value.operation === "upload"
        ? Promise.resolve({
            id: "upload-1",
            name: "fixture.txt",
            mime: "text/plain",
            size: 3,
            version: "v1",
          })
        : original(value),
    );
    mount();
    await screen.findByText("Synthetic history");
    const file = new File(["abc"], "fixture.txt", { type: "text/plain" });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new TextEncoder().encode("abc").buffer,
    });
    fireEvent.change(await enabled(screen.getByLabelText("Add images or files")), {
      target: { files: [file] },
    });
    await screen.findByText("fixture.txt");
    fireEvent.click(await enabled(screen.getByRole("button", { name: "Send" })));
    await waitFor(() => expect(calls("send")).toHaveLength(1));
    expect(calls("send")[0][0]).toMatchObject({ text: "", attachmentIds: ["upload-1"] });
    expect(calls("send")[0][0]).not.toHaveProperty("path");
  });
});

it("does not remove a newer pending identity when the previous panel's IPC response arrives late", async () => {
  const original = vi.mocked(api.claudeRequest).getMockImplementation()!;
  const replies: ((value: unknown) => void)[] = [];
  let admitted = "";
  vi.mocked(api.claudeRequest).mockImplementation((value) => {
    if (value.operation === "send")
      return new Promise((resolve) => {
        replies.push(resolve);
      });
    if (value.operation === "receipt" && value.requestId === admitted)
      return Promise.resolve({
        found: true,
        requestId: admitted,
        operation: "send",
        sessionId: "session",
        status: "accepted",
      });
    return original(value);
  });
  const first = mount();
  await screen.findByText("Synthetic history");
  await enterMessage("first");
  fireEvent.click(await enabled(screen.getByRole("button", { name: "Send" })));
  await waitFor(() => expect(replies).toHaveLength(1));
  admitted = String(calls("send")[0][0].requestId);
  first.unmount();
  mount();
  await screen.findByText("Synthetic history");
  await enterMessage("second");
  fireEvent.click(await enabled(screen.getByRole("button", { name: "Send" })));
  await waitFor(() => expect(replies).toHaveLength(2));
  const newer = String(calls("send")[1][0].requestId);
  await act(async () => replies[0]({ accepted: true, sessionId: "session" }));
  expect(
    JSON.parse(localStorage.getItem("agentkib:claude-owner-pending:v1:workspace")!).requestId,
  ).toBe(newer);
  await act(async () => replies[1]({ accepted: true, sessionId: "session" }));
});
