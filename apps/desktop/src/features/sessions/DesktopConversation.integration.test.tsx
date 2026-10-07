// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbeddedConversation } from "@agentkib/conversation-ui/conversation";
import { WebClient, type Access, type Live } from "@agentkib/web-client";
import type { ConversationSubscription, SessionStreamEvent } from "@agentkib/conversation-state";
import {
  createDesktopConversationAdapter,
  type DesktopConversationBridge,
} from "@/core/conversation-bridge";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("desktop embedded conversation", () => {
  it("uses the trusted bridge for history, streaming and sends without pairing or a second application shell", async () => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const live: Live = {
      sessionId: "session",
      status: "idle",
      revision: 1,
      sendEnabled: true,
      approvals: [],
      executionMode: "codex-managed",
    };
    const access: Access = {
      protocolVersion: 2,
      status: "approved",
      csrfToken: "local",
      bootId: "boot",
      experimentalEnabled: true,
      device: {
        id: "local",
        name: "Desktop",
        accessMode: "full",
        send: true,
        approve: true,
        advancedControl: true,
        manage: true,
      },
    };
    const listeners = new Set<(event: SessionStreamEvent<Live>) => void>();
    const subscriptions = new Map<string, string>();
    const bridge: DesktopConversationBridge = {
      request: vi.fn(async (path, body) => {
        const operation = path.split("?")[0];
        if (operation === "access") return { status: 200, body: access };
        if (operation === "catalog")
          return {
            status: 200,
            body: {
              indexEnabled: true,
              workspaces: [{ id: "workspace", name: "Project", path: "/isolated/project" }],
              sessions: [
                {
                  id: "session",
                  workspace_id: "workspace",
                  agent: "codex",
                  title: "Native conversation",
                  availability: "readable",
                  archived: false,
                  sidechain: false,
                },
              ],
            },
          };
        if (operation === "events")
          return {
            status: 200,
            body: {
              events: [
                {
                  id: "history",
                  kind: "agent-message",
                  content: "Existing history",
                  attachment_count: 0,
                  truncated: false,
                },
              ],
              warnings: [],
            },
          };
        if (operation === "live") return { status: 200, body: live };
        if (operation === "codex/capabilities")
          return {
            status: 200,
            body: {
              sessionId: "session",
              executionMode: "codex-managed",
              status: "idle",
              features: { send: { available: true } },
            },
          };
        if (operation === "codex/session-settings")
          return {
            status: 200,
            body: {
              sessionId: "session",
              available: false,
              revision: 1,
              current: {},
              defaults: {},
              writable: {
                model: { available: false },
                effort: { available: false },
                mode: { available: false },
                policy: { available: false },
                serviceTier: { available: false },
              },
              options: { models: [], policies: [], serviceTiers: [] },
            },
          };
        if (operation === "codex/goals")
          return {
            status: 200,
            body: { sessionId: "session", available: false, revision: 1, actions: {} },
          };
        if (operation === "codex/context-options")
          return { status: 200, body: { sessionId: "session", available: false, resources: [] } };
        if (operation === "send")
          return {
            status: 200,
            body: {
              accepted: true,
              requestId:
                typeof body === "object" && body && "requestId" in body ? body.requestId : "",
              sessionId: "session",
              turnId: "new-turn",
            },
          };
        return { status: 200, body: {} };
      }),
      upload: vi.fn(async () => ({ status: 400, body: { error: "not-used" } })),
      subscribe: vi.fn(async (sessionId: string): Promise<ConversationSubscription<Live>> => {
        const subscriptionId = `sub-${subscriptions.size}`;
        subscriptions.set(sessionId, subscriptionId);
        return {
          subscriptionId,
          events: [
            {
              protocolVersion: 2,
              sessionId,
              subscriptionId,
              runtimeBootId: "runtime",
              epoch: "epoch",
              seq: 0,
              cursor: "cursor-0",
              type: "snapshot",
              payload: { live: { ...live, sessionId } },
            },
          ],
          cursor: "cursor-0",
        };
      }),
      acknowledge: vi.fn(async () => {}),
      unsubscribe: vi.fn(async () => {}),
      onEvent: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      onUnavailable: () => () => {},
      onControlChanged: () => () => {},
    };
    const client = new WebClient(
      undefined,
      { type: "same-origin" },
      createDesktopConversationAdapter(() => bridge),
    );
    render(
      <EmbeddedConversation
        client={client}
        sessionId="session"
        locale="en-US"
        onSessionChange={vi.fn()}
      />,
    );
    expect(await screen.findByText("Existing history")).toBeVisible();
    expect(screen.queryByText(/pairing code/i)).toBeNull();
    await waitFor(() => expect(subscriptions.has("session")).toBe(true));
    act(() => {
      const event: SessionStreamEvent<Live> = {
        protocolVersion: 2,
        subscriptionId: subscriptions.get("session")!,
        sessionId: "session",
        runtimeBootId: "runtime",
        epoch: "epoch",
        seq: 1,
        cursor: "cursor-1",
        type: "item-upsert",
        payload: {
          id: "live-reply",
          turn_id: "turn",
          kind: "agent-message",
          content: "Live reply in desktop",
          attachment_count: 0,
          truncated: false,
        },
      };
      for (const listener of listeners) listener(event);
    });
    expect(await screen.findByText("Live reply in desktop")).toBeVisible();
    const durations: number[] = [];
    let reply = "Live reply in desktop";
    // Measure the actual shared reader DOM, including the IPC adapter, store and
    // React commit. Native generation and OS IPC latency are outside this fixture.
    for (let batch = 0; batch < 40; batch++) {
      const text = ` · ${batch}🙂`;
      const event: SessionStreamEvent<Live> = {
        protocolVersion: 2,
        subscriptionId: subscriptions.get("session")!,
        sessionId: "session",
        runtimeBootId: "runtime",
        epoch: "epoch",
        seq: batch + 2,
        cursor: `cursor-${batch + 2}`,
        type: "text-delta",
        payload: { itemId: "live-reply", turnId: "turn", text, offset: reply.length },
      };
      reply += text;
      const started = performance.now();
      await act(async () => {
        for (const listener of listeners) listener(event);
      });
      expect(document.querySelector('[data-event-id="live-reply"]')).toHaveTextContent(reply);
      durations.push(performance.now() - started);
    }
    const p95 = [...durations].sort((a, b) => a - b)[Math.ceil(durations.length * 0.95) - 1];
    console.info(
      `Desktop Embedded event→DOM P95: ${p95.toFixed(2)}ms (${durations.length} batches; ${process.platform}/${process.arch}, Node ${process.version}, jsdom, real React reader)`,
    );
    expect(p95).toBeLessThanOrEqual(150);
    expect(document.querySelectorAll('[data-event-id="live-reply"]')).toHaveLength(1);
    expect(screen.getByText("Existing history")).toBeVisible();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Continue this conversation" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(bridge.request).toHaveBeenCalledWith(
        "send",
        expect.objectContaining({ sessionId: "session", text: "Continue this conversation" }),
      ),
    );
    expect(vi.mocked(bridge.request).mock.calls.filter(([path]) => path === "send")).toHaveLength(
      1,
    );
  });
});
