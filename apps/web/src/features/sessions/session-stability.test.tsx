import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Access,
  Approval,
  ConversationCatalog,
  ConversationEventPage,
  Live,
  UserQuestionRequest,
} from "@agentkib/web-client";
import { WebApplication } from "@/router";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners: Record<string, (event: MessageEvent) => void> = {};
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();

  constructor() {
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: (event: MessageEvent) => void) {
    this.listeners[name] = listener;
  }

  emit(name: string, value: unknown) {
    this.listeners[name]?.(new MessageEvent(name, { data: JSON.stringify(value) }));
  }
}

const approvedAccess: Access = {
  status: "approved",
  csrfToken: "csrf",
  bootId: "boot",
  experimentalEnabled: true,
  device: { id: "browser", name: "Browser", send: true, approve: true },
};
const catalog: ConversationCatalog = {
  indexEnabled: true,
  workspaces: [{ id: "workspace", name: "Project", path: "/projects/project" }],
  sessions: [
    {
      id: "session",
      workspace_id: "workspace",
      agent: "claude-code",
      title: "Test session",
      availability: "readable",
      archived: false,
      sidechain: false,
    },
  ],
};
const history: ConversationEventPage = {
  events: [
    {
      id: "secret",
      kind: "agent-message",
      content: "Secret history",
      attachment_count: 0,
      truncated: false,
    },
  ],
  warnings: [],
};
const idleLive: Live = {
  sessionId: "session",
  status: "idle",
  revision: 1,
  sendEnabled: true,
  approvals: [],
  questions: [],
};
const question: UserQuestionRequest = {
  requestId: "question",
  turnId: "turn",
  supported: true,
  questions: [
    {
      id: "choice",
      question: "选一个",
      options: [{ label: "甲" }, { label: "乙" }],
      multiSelect: false,
      allowCustom: false,
    },
  ],
};
const approval: Approval = {
  requestId: "approval",
  turnId: "turn",
  method: "claude/can_use_tool",
  toolName: "Bash",
  input: { command: "echo before" },
  availableDecisions: ["allow", "deny"],
  supported: true,
};

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Content-Type": "application/json" } });
}

function createServer(initialLive: Live = idleLive) {
  const state = {
    access: approvedAccess,
    catalog,
    history,
    live: initialLive,
    mutation: undefined as ((path: string, init?: RequestInit) => Promise<Response>) | undefined,
  };
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (state.mutation && init?.method === "POST") return state.mutation(path, init);
    if (path.endsWith("/access")) return json(state.access);
    if (path.endsWith("/catalog")) return json(state.catalog);
    if (path.includes("/events?")) return json(state.history);
    if (path.includes("/live?")) return json(state.live);
    return json({});
  });
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("EventSource", FakeEventSource);
  return { state, fetcher };
}

beforeEach(() => {
  vi.stubGlobal("scrollTo", vi.fn());
});

async function openSession() {
  render(<WebApplication />);
  fireEvent.click(await screen.findByRole("button", { name: /Test session/ }));
  await screen.findByText("Secret history");
  await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
}

afterEach(() => {
  cleanup();
  FakeEventSource.instances = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("access invalidation", () => {
  it("clears private state immediately and ignores late events after access is revoked", async () => {
    const server = createServer();
    await openSession();
    const stream = FakeEventSource.instances.at(-1)!;
    const original = server.fetcher.getMockImplementation()!;
    let releaseHistory!: (response: Response) => void;
    server.fetcher.mockImplementation(async (input, init) => {
      if (String(input).includes("/events?"))
        return new Promise<Response>((resolve) => {
          releaseHistory = resolve;
        });
      return original(input, init);
    });
    fireEvent.click(screen.getAllByRole("button", { name: "刷新" })[0]);
    await waitFor(() => expect(releaseHistory).toBeTypeOf("function"));

    act(() => stream.emit("access-ended", {}));

    await screen.findByText("远程访问已结束");
    expect(screen.queryByText("Secret history")).not.toBeInTheDocument();
    await act(async () =>
      releaseHistory(
        json({
          events: [{ ...history.events[0], id: "late", content: "Late network history" }],
          warnings: [],
        }),
      ),
    );
    act(() => stream.emit("snapshot", { ...idleLive, revision: 99, streamText: "late secret" }));
    expect(screen.queryByText("Late network history")).not.toBeInTheDocument();
    expect(screen.queryByText("late secret")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Test session/ })).not.toBeInTheDocument();
  });

  it("clears selected history and catalog when indexing is disabled", async () => {
    const server = createServer();
    await openSession();
    server.state.catalog = { indexEnabled: false, sessions: [] };

    fireEvent.click(screen.getAllByRole("button", { name: "刷新" })[0]);

    await screen.findByText("历史索引未开启");
    expect(screen.queryByText("Secret history")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Test session/ })).not.toBeInTheDocument();
  });
});

describe("control outcome recovery", () => {
  it("never resends an unknown send outcome and requires a later manual refresh", async () => {
    const polling: (() => void)[] = [];
    vi.spyOn(globalThis, "setInterval").mockImplementation(((
      callback: () => void,
      delay: number,
    ) => {
      if (delay === 4000) polling.push(callback);
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval);
    const server = createServer();
    server.state.mutation = async (path) =>
      path.endsWith("/send")
        ? json({ code: "permission_denied", controlOutcome: "unknown" }, 403)
        : json({});
    await openSession();
    fireEvent.change(screen.getByLabelText("发送消息"), { target: { value: "draft" } });

    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByText(/结果未确认/);
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(screen.getByLabelText("发送消息")).toHaveValue("draft");

    await act(async () => polling.forEach((poll) => poll()));
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(server.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/send"))).toHaveLength(
      1,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "刷新" })[0]);
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
    expect(server.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/send"))).toHaveLength(
      1,
    );
  });
});

describe("live interaction validity", () => {
  it("dismisses without answering, reopens, and disables a cancelled question", async () => {
    const server = createServer({
      ...idleLive,
      status: "awaiting-input",
      turnId: "turn",
      sendEnabled: false,
      questions: [question],
    });
    await openSession();
    const dialog = await screen.findByRole("dialog", { name: "需要你的回答" });
    expect(dialog).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      server.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/answer")),
    ).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "需要你的回答" }));
    fireEvent.click(screen.getByLabelText("甲"));
    const cancelled = { ...idleLive, revision: 2 };
    server.state.live = cancelled;
    act(() => FakeEventSource.instances.at(-1)!.emit("snapshot", cancelled));

    expect(screen.getByRole("button", { name: "提交回答" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("button", { name: "提交回答" }).closest("form")!);
    expect(
      server.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/answer")),
    ).toHaveLength(0);
  });

  it("invalidates an approval when its reviewed projection changes", async () => {
    const server = createServer({
      ...idleLive,
      status: "awaiting-approval",
      turnId: "turn",
      sendEnabled: false,
      approvals: [approval],
    });
    await openSession();
    await screen.findByRole("dialog", { name: "等待审批" });
    expect(screen.getByText(/echo before/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      server.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/approve")),
    ).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "等待审批" }));
    await screen.findByRole("dialog", { name: "等待审批" });

    const changed = {
      ...server.state.live,
      revision: 2,
      approvals: [{ ...approval, input: { command: "echo after" } }],
    };
    server.state.live = changed;
    act(() => FakeEventSource.instances.at(-1)!.emit("snapshot", changed));

    expect(screen.queryByRole("button", { name: /允许/ })).not.toBeInTheDocument();
    expect(screen.getByText(/请回官方客户端查看/)).toBeVisible();
    expect(
      server.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/approve")),
    ).toHaveLength(0);
  });

  it("uses the native ACP option name when its opaque id matches a legacy decision", async () => {
    const nativeApproval: Approval = {
      requestId: "native-approval",
      turnId: "native-turn",
      method: "session/request_permission",
      toolCall: { toolCallId: "tool", title: "Native action" },
      options: [{ optionId: "cancel", name: "Allow this native action", kind: "allow_once" }],
      availableDecisions: ["cancel"],
      supported: true,
    };
    const server = createServer({
      ...idleLive,
      status: "waiting-approval",
      turnId: nativeApproval.turnId,
      sendEnabled: false,
      approvals: [nativeApproval],
    });
    server.state.mutation = async () => json({ accepted: true });
    await openSession();

    await screen.findByRole("dialog", { name: "等待审批" });
    const option = screen.getByRole("button", { name: "Allow this native action" });
    expect(screen.queryByRole("button", { name: "取消运行" })).not.toBeInTheDocument();
    expect(option.querySelector("svg")).toBeNull();
    fireEvent.click(option);

    await waitFor(() => {
      expect(
        server.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/approve")),
      ).toHaveLength(1);
    });
    const approveCall = server.fetcher.mock.calls.find(([url]) => String(url).endsWith("/approve"));
    expect(JSON.parse(String(approveCall?.[1]?.body))).toMatchObject({
      sessionId: "session",
      turnId: "native-turn",
      approvalId: "native-approval",
      decision: "cancel",
    });
  });

  it("closes an open interaction and clears its data when permission is revoked", async () => {
    createServer({
      ...idleLive,
      status: "awaiting-input",
      turnId: "turn",
      sendEnabled: false,
      questions: [question],
    });
    await openSession();
    await screen.findByRole("dialog", { name: "需要你的回答" });

    act(() => FakeEventSource.instances.at(-1)!.emit("access-ended", {}));

    await screen.findByText("远程访问已结束");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("选一个")).not.toBeInTheDocument();
  });
});

describe("host identity isolation", () => {
  it("drops the previous host's history and draft before bootstrapping a new host", async () => {
    const hostA = "http://192.168.1.10:1422";
    const hostB = "http://192.168.1.11:1422";
    const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const host = url.startsWith(hostB) ? hostB : hostA;
      if (url.endsWith("/info"))
        return json({
          protocolVersion: 1,
          transport: "lan",
          capabilities: { read: true, send: true, approve: true },
        });
      if (url.endsWith("/access"))
        return json({
          ...approvedAccess,
          bearerToken: host === hostA ? "token-a" : "token-b",
          bootId: host === hostA ? "boot-a" : "boot-b",
        });
      if (url.endsWith("/catalog"))
        return json({
          ...catalog,
          sessions: catalog.sessions.map((session) => ({
            ...session,
            title: host === hostA ? "Host A session" : "Host B session",
          })),
        });
      if (url.includes("/events?"))
        return json({
          events: [
            {
              ...history.events[0],
              id: host === hostA ? "secret-a" : "secret-b",
              content: host === hostA ? "Host A secret" : "Host B history",
            },
          ],
          warnings: [],
        });
      if (url.includes("/live?")) return json(idleLive);
      if (url.includes("/stream?")) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            streams.push(controller);
          },
        });
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
      }
      return json({});
    });
    vi.stubGlobal("fetch", fetcher);

    render(<WebApplication hosted origin={hostA} />);
    fireEvent.click(await screen.findByRole("button", { name: /Host A session/ }));
    await screen.findByText("Host A secret");
    fireEvent.change(screen.getByLabelText("发送消息"), { target: { value: "private draft" } });

    fireEvent.click(screen.getByRole("button", { name: "更换连接 / 清空内容" }));
    await screen.findByRole("button", { name: "连接桌面 AgentKib" });
    expect(screen.queryByText("Host A secret")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("private draft")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("电脑的局域网地址"), { target: { value: hostB } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "连接桌面 AgentKib" }));
    fireEvent.click(await screen.findByRole("button", { name: /Host B session/ }));
    await screen.findByText("Host B history");

    expect(screen.queryByText("Host A secret")).not.toBeInTheDocument();
    expect(screen.getByLabelText("发送消息")).toHaveValue("");
    const hostBAccess = fetcher.mock.calls.find(
      ([url]) => String(url) === `${hostB}/api/web/v1/access`,
    );
    expect(hostBAccess).toBeDefined();
    expect(streams.length).toBeGreaterThan(0);
  });
});
