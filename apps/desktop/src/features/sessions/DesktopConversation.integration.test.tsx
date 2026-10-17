// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbeddedConversation } from "./conversation/conversation";
import { WebClient, type Access, type Live } from "@agentkib/web-client";
import { permissionModeCopy } from "./conversation/features/sessions/permission-mode-copy";
import { claudeConnectionCopy } from "./conversation/features/sessions/claude-connection-copy";
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
  it("rechecks Claude handoff eligibility through the trusted bridge without discarding the draft", async () => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    sessionStorage.clear();
    const state: { live: Live; owned: boolean } = {
      owned: false,
      live: {
        sessionId: "claude-session",
        status: "idle",
        revision: 1,
        sendEnabled: false,
        approvals: [],
        questions: [],
        executionMode: "managed-resume",
        reason: "handoff-required",
        cliVersion: "2.1.296 (Claude Code)",
      },
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
    const bridge: DesktopConversationBridge = {
      request: vi.fn(async (path) => {
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
                  id: "claude-session",
                  workspace_id: "workspace",
                  agent: "claude-code",
                  title: "Native Claude conversation",
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
                  content: "Existing Claude history",
                  attachment_count: 0,
                  truncated: false,
                },
              ],
              warnings: [],
            },
          };
        if (operation === "live") return { status: 200, body: state.live };
        if (operation === "managed/capabilities")
          return {
            status: 200,
            body: {
              sessionId: "claude-session",
              executionMode: state.live.executionMode,
              status: "idle",
              features: {
                send: { available: state.owned },
                adopt: { available: !state.owned },
                inspect: { available: true },
              },
            },
          };
        if (operation === "managed/options")
          return {
            status: 200,
            body: {
              available: true,
              workspaces: [{ id: "workspace", name: "Project" }],
              models: [],
            },
          };
        if (operation === "managed/inspect")
          return {
            status: 200,
            body: { sessionId: "claude-session", handoffFingerprint: "verified-history" },
          };
        if (operation === "managed/adopt") {
          state.owned = true;
          state.live = {
            ...state.live,
            revision: state.live.revision + 1,
            executionMode: "claude-managed",
            reason: undefined,
            sendEnabled: true,
          };
          return { status: 200, body: { accepted: true, sessionId: "claude-session" } };
        }
        return { status: 200, body: {} };
      }),
      upload: vi.fn(async () => ({ status: 400, body: { error: "not-used" } })),
      subscribe: vi.fn(async (sessionId): Promise<ConversationSubscription<Live>> => ({
        subscriptionId: "claude-subscription",
        events: [
          {
            protocolVersion: 2,
            sessionId,
            subscriptionId: "claude-subscription",
            runtimeBootId: "runtime",
            epoch: "epoch",
            seq: 0,
            cursor: "cursor-0",
            type: "snapshot",
            payload: { live: { ...state.live, sessionId } },
          },
        ],
        cursor: "cursor-0",
      })),
      acknowledge: vi.fn(async () => {}),
      unsubscribe: vi.fn(async () => {}),
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      onUnavailable: () => () => {},
      onControlChanged: () => () => {},
    };
    const mutations = () =>
      vi.mocked(bridge.request).mock.calls.filter(([, body]) => body !== undefined);
    const client = new WebClient(
      undefined,
      { type: "same-origin" },
      createDesktopConversationAdapter(() => bridge),
    );
    render(
      <EmbeddedConversation
        client={client}
        sessionId="claude-session"
        locale="zh-CN"
        onSessionChange={vi.fn()}
      />,
    );
    expect(await screen.findByText("Existing Claude history")).toBeVisible();
    const draft = screen.getByRole("textbox", { name: "发送消息" });
    fireEvent.change(draft, { target: { value: "保留桌面草稿" } });
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(
      (
        await screen.findAllByText(
          "此会话尚未交给 AgentKib。请先停止原客户端中的同一会话，再确认交接。",
        )
      ).length,
    ).toBeGreaterThan(0);
    fireEvent.click(await screen.findByRole("button", { name: "交给 AgentKib" }));
    const confirm = await screen.findByRole("button", { name: "交给 AgentKib" });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(mutations()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(draft).toHaveValue("保留桌面草稿");
    expect(mutations()).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "交给 AgentKib" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: /我已结束当前轮次/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "交给 AgentKib" })).toBeEnabled(),
    );
    function emitLive(seq: number) {
      for (const listener of listeners)
        listener({
          protocolVersion: 2,
          sessionId: "claude-session",
          subscriptionId: "claude-subscription",
          runtimeBootId: "runtime",
          epoch: "epoch",
          seq,
          cursor: `cursor-${seq}`,
          type: "snapshot",
          payload: { live: { ...state.live } },
        });
    }
    state.live = {
      ...state.live,
      revision: 2,
      reason: "control-outcome-unconfirmed",
    };
    act(() => emitLive(1));
    fireEvent.click(screen.getByRole("button", { name: "交给 AgentKib" }));
    expect(mutations()).toEqual([]);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "交给 AgentKib" })).toBeDisabled(),
    );
    expect(draft).toHaveValue("保留桌面草稿");
    state.live = { ...state.live, revision: 3, reason: "handoff-required" };
    act(() => emitLive(2));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "交给 AgentKib" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "交给 AgentKib" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "交给 AgentKib" })).not.toBeInTheDocument(),
    );
    expect(draft).toHaveValue("保留桌面草稿");
    expect(mutations()).toEqual([
      [
        "managed/adopt",
        expect.objectContaining({
          agent: "claude-code",
          sessionId: "claude-session",
          handoffConfirmed: true,
          handoffFingerprint: "verified-history",
          requestId: expect.any(String),
        }),
      ],
    ]);
    expect(vi.mocked(bridge.request).mock.calls.some(([path]) => path === "send")).toBe(false);
    expect(screen.queryByRole("button", { name: "交给 AgentKib" })).not.toBeInTheDocument();
  });

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

  describe("Claude permission mode notice", () => {
    // Hand-built bridge for a managed Claude session; no real session data is involved.
    function claudeBridge(initial: Live, adoptAvailable = false) {
      const listeners = new Set<(event: SessionStreamEvent<Live>) => void>();
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
      const bridge: DesktopConversationBridge = {
        request: vi.fn(async (path) => {
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
                    id: "claude-session",
                    workspace_id: "workspace",
                    agent: "claude-code",
                    title: "Native Claude conversation",
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
                    content: "Existing Claude history",
                    attachment_count: 0,
                    truncated: false,
                  },
                ],
                warnings: [],
              },
            };
          if (operation === "live") return { status: 200, body: initial };
          if (operation === "managed/capabilities")
            return {
              status: 200,
              body: {
                sessionId: "claude-session",
                executionMode: initial.executionMode,
                status: "idle",
                features: {
                  send: { available: initial.sendEnabled },
                  adopt: { available: adoptAvailable },
                },
              },
            };
          return { status: 200, body: {} };
        }),
        upload: vi.fn(async () => ({ status: 400, body: { error: "not-used" } })),
        subscribe: vi.fn(async (sessionId): Promise<ConversationSubscription<Live>> => ({
          subscriptionId: "claude-subscription",
          events: [
            {
              protocolVersion: 2,
              sessionId,
              subscriptionId: "claude-subscription",
              runtimeBootId: "runtime",
              epoch: "epoch",
              seq: 0,
              cursor: "cursor-0",
              type: "snapshot",
              payload: { live: { ...initial, sessionId } },
            },
          ],
          cursor: "cursor-0",
        })),
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
      let seq = 0;
      const patch = (payload: Partial<Live>) =>
        act(() => {
          seq += 1;
          const event: SessionStreamEvent<Live> = {
            protocolVersion: 2,
            sessionId: "claude-session",
            subscriptionId: "claude-subscription",
            runtimeBootId: "runtime",
            epoch: "epoch",
            seq,
            cursor: `cursor-${seq}`,
            type: "state",
            payload,
          };
          for (const listener of listeners) listener(event);
        });
      return { bridge, patch };
    }
    const live = (permission?: Live["permission"]): Live => ({
      sessionId: "claude-session",
      status: "idle",
      revision: 1,
      sendEnabled: true,
      approvals: [],
      questions: [],
      executionMode: "claude-managed",
      cliVersion: "2.1.296 (Claude Code)",
      ...(permission ? { permission } : {}),
    });
    const shown = (text: string) =>
      screen.queryAllByRole("status").some((element) => element.textContent?.includes(text));
    async function open(
      initial: Live,
      locale: "zh-CN" | "en-US" | "zh-TW" | "ja-JP" = "zh-CN",
      adoptAvailable = false,
    ) {
      vi.spyOn(window, "scrollTo").mockImplementation(() => {});
      sessionStorage.clear();
      const fixture = claudeBridge(initial, adoptAvailable);
      render(
        <EmbeddedConversation
          client={
            new WebClient(
              undefined,
              { type: "same-origin" },
              createDesktopConversationAdapter(() => fixture.bridge),
            )
          }
          sessionId="claude-session"
          locale={locale}
          onSessionChange={vi.fn()}
        />,
      );
      expect(await screen.findByText("Existing Claude history")).toBeVisible();
      return fixture;
    }

    it("keeps an original-terminal connection outside managed handoff with stale adoption capabilities", async () => {
      const { bridge } = await open(
        {
          ...live(),
          executionMode: "claude-follower",
          sendEnabled: false,
          reason: "handoff-required",
        },
        "zh-CN",
        true,
      );
      const draft = screen.getByRole("textbox", { name: "发送消息" });
      fireEvent.change(draft, { target: { value: "Keep original terminal draft" } });
      expect(screen.queryByRole("button", { name: "交给 AgentKib" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
      expect(draft).toHaveValue("Keep original terminal draft");
      expect(vi.mocked(bridge.request).mock.calls.filter(([, body]) => body !== undefined)).toEqual(
        [],
      );
    });

    it("connects the original Claude session without handoff and retains the draft after disconnect", async () => {
      const { bridge, patch } = await open({
        ...live(),
        executionMode: "claude-follower",
        connectionGeneration: "lease-a",
      });
      expect(await screen.findByText("已连接原会话", { selector: "aside strong" })).toBeVisible();
      expect(screen.queryByRole("button", { name: "交给 AgentKib" })).not.toBeInTheDocument();
      const draft = screen.getByRole("textbox", { name: "发送消息" });
      fireEvent.change(draft, { target: { value: "保留原终端草稿" } });
      await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
      patch({
        revision: 2,
        status: "unsupported",
        sendEnabled: false,
        stopEnabled: false,
        reason: "claude-bridge-disconnected",
        connectionGeneration: "revoked-a",
        approvals: [],
        questions: [],
        streamText: "",
      });
      await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeDisabled());
      expect(draft).toHaveValue("保留原终端草稿");
      expect(screen.getByText("原终端连接已断开", { selector: "aside strong" })).toBeVisible();
      expect(screen.queryByRole("button", { name: "交给 AgentKib" })).not.toBeInTheDocument();
      expect(
        vi
          .mocked(bridge.request)
          .mock.calls.filter(
            ([path, body]) =>
              body !== undefined && ["send", "managed/adopt", "managed/create"].includes(path),
          ),
      ).toEqual([]);
    });

    it("explains the unverified native send boundary without requesting a managed handoff", async () => {
      const { bridge } = await open({
        ...live(),
        executionMode: "claude-follower",
        connectionGeneration: "lease-a",
        sendEnabled: false,
        reason: "claude-follower-send-unverified",
      });
      expect(
        await screen.findByText(
          "原会话发送尚未开放，请在原终端发送；AgentKib 可同步观察并取消当前轮次。",
        ),
      ).toBeVisible();
      fireEvent.change(screen.getByRole("textbox", { name: "发送消息" }), {
        target: { value: "Keep unsent draft" },
      });
      expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
      expect(screen.queryByRole("button", { name: "交给 AgentKib" })).not.toBeInTheDocument();
      expect(vi.mocked(bridge.request).mock.calls.filter(([path]) => path === "send")).toHaveLength(
        0,
      );
    });

    it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
      "shows unconfirmed native turn state in %s without handoff",
      async (locale) => {
        const { bridge } = await open(
          {
            ...live(),
            executionMode: "claude-follower",
            status: "running",
            sendEnabled: false,
            stopEnabled: false,
            reason: "claude-follower-turn-unconfirmed",
          },
          locale,
        );
        expect(await screen.findByText(claudeConnectionCopy[locale].turnUnconfirmed)).toBeVisible();
        expect(
          vi
            .mocked(bridge.request)
            .mock.calls.filter(([path]) => ["send", "stop", "managed/adopt"].includes(path)),
        ).toHaveLength(0);
      },
    );

    it("explains follower approvals in the original terminal without offering a local decision", async () => {
      await open({
        ...live(),
        executionMode: "claude-follower",
        connectionGeneration: "lease-a",
        status: "awaiting-approval",
        sendEnabled: false,
        reason: "claude-terminal-approval",
      });
      expect(await screen.findByText("正在等待工具审批，请在原终端处理。")).toBeVisible();
      expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
      expect(screen.queryByRole("button", { name: "交给 AgentKib" })).not.toBeInTheDocument();
    });

    it.each([
      ["zh-CN", "auto", { mode: "auto" }],
      ["en-US", "dontAsk", { mode: "dontAsk" }],
      ["zh-TW", "bypassPermissions", { mode: "bypassPermissions" }],
      ["ja-JP", "possiblyAuto", { mode: null, possiblyAuto: true }],
    ] as const)(
      "shows the %s %s notice in the desktop composer",
      async (locale, key, permission) => {
        await open(live(permission), locale);
        const copy = permissionModeCopy[locale];
        await waitFor(() => expect(shown(copy[key])).toBe(true));
        for (const other of [
          "auto",
          "dontAsk",
          "bypassPermissions",
          "possiblyAuto",
          "previous",
        ] as const)
          if (other !== key) expect(shown(copy[other])).toBe(false);
      },
    );

    it.each([
      ["default", { mode: "default" }],
      ["an unknown mode without a hint", { mode: null }],
      ["no permission field", undefined],
    ] as const)("shows no notice for %s", async (_name, permission) => {
      await open(live(permission));
      const copy = permissionModeCopy["zh-CN"];
      for (const key of [
        "auto",
        "dontAsk",
        "bypassPermissions",
        "possiblyAuto",
        "previous",
      ] as const)
        expect(shown(copy[key])).toBe(false);
    });

    it("updates from native patches and shows the previous-mode suffix", async () => {
      const fixture = await open(live({ mode: null, possiblyAuto: true }), "en-US");
      const copy = permissionModeCopy["en-US"];
      await waitFor(() => expect(shown(copy.possiblyAuto)).toBe(true));
      fixture.patch({ revision: 2, permission: { mode: "auto" } });
      await waitFor(() => expect(shown(copy.auto)).toBe(true));
      expect(shown(copy.possiblyAuto)).toBe(false);
      fixture.patch({ revision: 3, permission: { mode: "auto", previous: true } });
      await waitFor(() => expect(shown(copy.previous)).toBe(true));
      fixture.patch({ revision: 4, permission: { mode: null } });
      await waitFor(() => expect(shown(copy.auto)).toBe(false));
      expect(shown(copy.previous)).toBe(false);
    });
  });
});
