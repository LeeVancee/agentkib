// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";
import { ApiError } from "@agentkib/web-client";
import type { ManagedOptions } from "@agentkib/web-client";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManagedTasks } from "@/features/conversation/features/sessions/managed-tasks";
import { managedControlCopy } from "@/features/conversation/features/sessions/managed-control-copy";
import {
  pendingScope,
  rememberPending,
} from "@/features/conversation/features/sessions/pending-controls";

const managementLocales = [
  {
    locale: "en-US",
    agent: "Agent",
    create: "Create",
    host: "host (the computer running the Agent)",
    note: "Uses the host Claude Code model and tool permissions by default. Creating a task does not start a model request.",
    handoff: "Hand over to AgentKib",
    release: "Return to original client",
    notHandedOver: "This session has not been handed over to AgentKib",
    handedOver: "This session has been handed over to AgentKib",
    pending:
      "The previous outcome is unconfirmed. Wait for the saved request's status before another operation.",
    checking:
      "The saved request status is checked automatically. Refreshing does not run the operation again.",
  },
  {
    locale: "zh-CN",
    agent: "执行工具",
    create: "创建",
    host: "主机（运行 Agent 的电脑）",
    note: "默认沿用主机 Claude Code 的模型与工具权限。创建任务不会调用模型。",
    handoff: "交给 AgentKib",
    release: "交还原客户端",
    notHandedOver: "此会话尚未交给 AgentKib",
    handedOver: "此会话已交给 AgentKib",
    pending: "上次操作结果尚未确认。请等待系统确认已保存的请求，再执行新的操作。",
    checking: "正在自动查询已保存请求的处理状态；刷新不会重新执行操作。",
  },
  {
    locale: "zh-TW",
    agent: "執行工具",
    create: "建立",
    host: "主機（執行 Agent 的電腦）",
    note: "預設沿用主機 Claude Code 的模型與工具權限。建立任務不會呼叫模型。",
    handoff: "交給 AgentKib",
    release: "交還原客戶端",
    notHandedOver: "此對話尚未交給 AgentKib",
    handedOver: "此對話已交給 AgentKib",
    pending: "上次操作結果尚未確認。請等待系統確認已儲存的請求，再執行新操作。",
    checking: "正在自動查詢已儲存請求的處理狀態；重新整理不會重新執行操作。",
  },
  {
    locale: "ja-JP",
    agent: "実行ツール",
    create: "作成",
    host: "ホスト（Agent を実行するコンピューター）",
    note: "既定ではホストの Claude Code のモデルとツール権限を使用します。タスクを作成してもモデルは呼び出しません。",
    handoff: "AgentKib に引き渡す",
    release: "元のクライアントに引き渡す",
    notHandedOver: "この会話はまだ AgentKib に引き渡されていません",
    handedOver: "この会話は AgentKib に引き渡されています",
    pending:
      "前回の結果は未確認です。保存済みリクエストの処理状況を確認してから次の操作を行ってください。",
    checking: "保存済みリクエストの処理状況を自動確認しています。更新しても再実行しません。",
  },
] as const;

const options: ManagedOptions = {
  available: true,
  workspaces: [{ id: "workspace", name: "Project" }],
  models: [],
};
function createSession() {
  return {
    origin: "",
    selected: "session",
    current: { id: "session", agent: "claude-code" },
    live: {
      sessionId: "session",
      executionMode: "external",
      connectionGeneration: undefined as string | undefined,
      status: "idle",
      reason: "handoff-required",
      activity: undefined as string | undefined,
      approvals: [] as unknown[],
      questions: [] as unknown[],
    },
    capabilities: {
      sessionId: "session",
      reason: undefined as string | undefined,
      features: { adopt: { available: true } },
    },
    access: {
      status: "approved",
      protocolVersion: 2,
      bootId: "boot",
      experimentalEnabled: true,
      device: { id: "device", manage: true, send: true },
    },
    client: {
      request: vi.fn(async (path: string, _body?: unknown) =>
        path.startsWith("managed/options") ? options : { sessionId: "session" },
      ),
      managedInspect: vi.fn(async () => ({
        sessionId: "session",
        handoffFingerprint: "verified-history" as string | undefined,
      })),
      receipt: vi.fn(async (requestId: string) => ({ found: false, requestId })),
    },
    online: true,
    controlReady: true,
    busy: false,
    notice: undefined as string | undefined,
    locale: "en-US" as keyof typeof managedControlCopy,
    refresh: vi.fn(async () => {}),
  };
}
let session: ReturnType<typeof createSession>;
vi.mock("@/features/conversation/features/sessions/session-context", () => ({
  useSession: () => session,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/features/conversation/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));
const mutations = () =>
  session.client.request.mock.calls.filter(([path]) => !path.startsWith("managed/options"));
async function show() {
  const view = render(<ManagedTasks initialOpen />);
  await screen.findByRole("button", { name: "Hand over to AgentKib" });
  return view;
}
describe("managed handoff feedback", () => {
  beforeEach(() => {
    sessionStorage.clear();
    session = createSession();
  });
  afterEach(cleanup);
  it.each([
    [
      "offline",
      (s: typeof session) => {
        s.online = false;
      },
    ],
    [
      "synchronizing",
      (s: typeof session) => {
        s.controlReady = false;
      },
    ],
    [
      "sessionBusy",
      (s: typeof session) => {
        s.busy = true;
      },
    ],
    [
      "uncertain",
      (s: typeof session) => {
        s.notice = "uncertain";
      },
    ],
    [
      "session",
      (s: typeof session) => {
        s.live.sessionId = "other";
      },
    ],
    [
      "capability",
      (s: typeof session) => {
        s.capabilities.features.adopt.available = false;
      },
    ],
    [
      "ownership",
      (s: typeof session) => {
        s.live.reason = "control-outcome-unconfirmed";
      },
    ],
    [
      "turn",
      (s: typeof session) => {
        s.live.status = "running";
      },
    ],
    [
      "compacting",
      (s: typeof session) => {
        s.live.activity = "compacting";
      },
    ],
    [
      "approvals",
      (s: typeof session) => {
        s.live.approvals = [{}];
      },
    ],
    [
      "questions",
      (s: typeof session) => {
        s.live.questions = [{}];
      },
    ],
    [
      "access",
      (s: typeof session) => {
        s.access.status = "pending";
      },
    ],
    [
      "protocol",
      (s: typeof session) => {
        s.access.protocolVersion = 1;
      },
    ],
    [
      "send",
      (s: typeof session) => {
        s.access.device.send = false;
      },
    ],
  ] as const)(
    "explains the %s gate next to the disabled action without sending",
    async (reason, mutate) => {
      const view = await show();
      fireEvent.click(screen.getByRole("checkbox"));
      const button = screen.getByRole("button", { name: "Hand over to AgentKib" });
      await waitFor(() => expect(button).toBeEnabled());
      mutate(session);
      view.rerender(<ManagedTasks initialOpen />);
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleDescription(managedControlCopy["en-US"][reason]);
      expect(screen.getByText(managedControlCopy["en-US"][reason])).toBeVisible();
      fireEvent.click(button);
      expect(mutations()).toEqual([]);
    },
  );
  it("explains confirmation before allowing a verified handoff with its original id and fingerprint", async () => {
    await show();
    const button = screen.getByRole("button", { name: "Hand over to AgentKib" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(managedControlCopy["en-US"].confirmation);
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(button).toBeEnabled());
    expect(button).not.toHaveAttribute("aria-describedby");
    fireEvent.click(button);
    await waitFor(() => expect(session.refresh).toHaveBeenCalledWith(true));
    expect(mutations()).toEqual([
      [
        "managed/adopt",
        expect.objectContaining({
          sessionId: "session",
          agent: "claude-code",
          handoffConfirmed: true,
          handoffFingerprint: "verified-history",
          bootId: "boot",
          requestId: expect.any(String),
        }),
      ],
    ]);
  });
  it("distinguishes history verification in progress from a completed check without proof", async () => {
    let complete!: (value: { sessionId: string; handoffFingerprint: string | undefined }) => void;
    session.client.managedInspect.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    await show();
    fireEvent.click(screen.getByRole("checkbox"));
    const button = screen.getByRole("button", { name: "Hand over to AgentKib" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(managedControlCopy["en-US"].fingerprintLoading);
    await act(async () => complete({ sessionId: "session", handoffFingerprint: undefined }));
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(managedControlCopy["en-US"].fingerprintUnavailable);
    expect(mutations()).toEqual([]);
  });
  it.each(managementLocales)(
    "invalidates reviewed Claude handoff proof across original-terminal binding changes in $locale",
    async (copy) => {
      session.locale = copy.locale;
      const view = render(<ManagedTasks initialOpen />);
      const initial = await screen.findByRole("button", { name: copy.handoff });
      fireEvent.click(screen.getByRole("checkbox"));
      await waitFor(() => expect(initial).toBeEnabled());
      session.client.managedInspect.mockImplementation(async () => ({
        sessionId: "session",
        handoffFingerprint:
          session.live.executionMode === "claude-follower" ? undefined : "history-after-disconnect",
      }));
      session.live.executionMode = "claude-follower";
      session.live.reason = "claude-follower-send-unverified";
      view.rerender(<ManagedTasks initialOpen />);
      expect(screen.queryByRole("button", { name: copy.handoff })).toBeNull();
      session.live.executionMode = "managed-resume";
      session.live.reason = "handoff-required";
      view.rerender(<ManagedTasks initialOpen />);
      const next = await screen.findByRole("button", { name: copy.handoff });
      expect(screen.getByRole("checkbox")).not.toBeChecked();
      expect(next).toBeDisabled();
      fireEvent.click(screen.getByRole("checkbox"));
      await waitFor(() => expect(next).toBeEnabled());
      fireEvent.click(next);
      await waitFor(() => expect(mutations()).toHaveLength(1));
      expect(mutations()[0][1]).toMatchObject({
        sessionId: "session",
        handoffConfirmed: true,
        handoffFingerprint: "history-after-disconnect",
      });
    },
  );
  it("does not revive a late inspection from before an original-terminal connection", async () => {
    let finish!: (value: { sessionId: string; handoffFingerprint: string }) => void;
    session.client.managedInspect.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const view = await show();
    session.live.executionMode = "claude-follower";
    session.live.reason = "claude-follower-send-unverified";
    view.rerender(<ManagedTasks initialOpen />);
    session.client.managedInspect.mockResolvedValue({
      sessionId: "session",
      handoffFingerprint: "history-after-disconnect",
    });
    session.live.executionMode = "managed-resume";
    session.live.reason = "handoff-required";
    view.rerender(<ManagedTasks initialOpen />);
    await act(async () =>
      finish({ sessionId: "session", handoffFingerprint: "history-before-connect" }),
    );
    const next = await screen.findByRole("button", { name: "Hand over to AgentKib" });
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(next).toBeEnabled());
    fireEvent.click(next);
    await waitFor(() => expect(mutations()).toHaveLength(1));
    expect(mutations()[0][1]).toMatchObject({ handoffFingerprint: "history-after-disconnect" });
  });
  it("invalidates confirmed proof when the original-terminal connection generation changes", async () => {
    session.live.connectionGeneration = "first-binding";
    const view = await show();
    fireEvent.click(screen.getByRole("checkbox"));
    const handoff = screen.getByRole("button", { name: "Hand over to AgentKib" });
    await waitFor(() => expect(handoff).toBeEnabled());
    session.client.managedInspect.mockResolvedValue({
      sessionId: "session",
      handoffFingerprint: "new-binding-history",
    });
    session.live.connectionGeneration = "next-binding";
    view.rerender(<ManagedTasks initialOpen />);
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(handoff).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(handoff).toBeEnabled());
    fireEvent.click(handoff);
    await waitFor(() => expect(mutations()).toHaveLength(1));
    expect(mutations()[0][1]).toMatchObject({ handoffFingerprint: "new-binding-history" });
  });
  it("checks fresh history after a managed Claude session is returned to its original client", async () => {
    session.live.executionMode = "claude-managed";
    session.client.managedInspect.mockResolvedValue({
      sessionId: "session",
      handoffFingerprint: undefined,
    });
    const view = render(<ManagedTasks initialOpen />);
    await screen.findByRole("button", { name: "Return to original client" });
    await waitFor(() => expect(session.client.managedInspect).toHaveBeenCalledTimes(1));
    session.client.managedInspect.mockResolvedValue({
      sessionId: "session",
      handoffFingerprint: "returned-session-history",
    });
    session.live.status = "released";
    view.rerender(<ManagedTasks initialOpen />);
    const handoff = await screen.findByRole("button", { name: "Hand over to AgentKib" });
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(handoff).toBeEnabled());
    fireEvent.click(handoff);
    await waitFor(() => expect(mutations()).toHaveLength(1));
    expect(mutations()[0][1]).toMatchObject({ handoffFingerprint: "returned-session-history" });
  });
  it("keeps a saved unknown outcome locked through original-terminal ownership transitions", async () => {
    rememberPending(pendingScope(session.origin, session.access.device.id), {
      kind: "adopt",
      requestId: "saved-request",
      sessionId: "session",
      agent: "claude-code",
    });
    const view = await show();
    await screen.findByText(managementLocales[0].pending);
    session.live.executionMode = "claude-follower";
    session.live.reason = "claude-follower-send-unverified";
    view.rerender(<ManagedTasks initialOpen />);
    session.live.executionMode = "managed-resume";
    session.live.reason = "handoff-required";
    view.rerender(<ManagedTasks initialOpen />);
    expect(await screen.findByText(managementLocales[0].pending)).toBeVisible();
    fireEvent.click(screen.getByRole("checkbox"));
    const handoff = screen.getByRole("button", { name: "Hand over to AgentKib" });
    expect(handoff).toBeDisabled();
    fireEvent.click(handoff);
    expect(mutations()).toEqual([]);
  });
  it.each(managementLocales)(
    "rechecks changed Claude history and resets confirmation when operations reopen in $locale",
    async (copy) => {
      session.locale = copy.locale;
      const content = (active: boolean) => (
        <ManagedTasks active={active} renderContent={(children) => (active ? children : null)} />
      );
      const view = render(content(true));
      const first = await screen.findByRole("button", { name: copy.handoff });
      fireEvent.click(screen.getByRole("checkbox"));
      await waitFor(() => expect(first).toBeEnabled());
      expect(session.client.managedInspect).toHaveBeenCalledTimes(1);
      view.rerender(content(false));
      expect(screen.queryByRole("checkbox")).toBeNull();
      let finish!: (value: { sessionId: string; handoffFingerprint: string }) => void;
      session.client.managedInspect.mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
      view.rerender(content(true));
      const next = await screen.findByRole("button", { name: copy.handoff });
      expect(screen.getByRole("checkbox")).not.toBeChecked();
      fireEvent.click(screen.getByRole("checkbox"));
      expect(next).toBeDisabled();
      expect(next).toHaveAccessibleDescription(managedControlCopy[copy.locale].fingerprintLoading);
      fireEvent.click(next);
      expect(mutations()).toEqual([]);
      await act(async () =>
        finish({ sessionId: "session", handoffFingerprint: "history-after-native-turn" }),
      );
      await waitFor(() => expect(next).toBeEnabled());
      fireEvent.click(next);
      await waitFor(() => expect(mutations()).toHaveLength(1));
      expect(mutations()[0]).toEqual([
        "managed/adopt",
        expect.objectContaining({
          sessionId: "session",
          handoffConfirmed: true,
          handoffFingerprint: "history-after-native-turn",
        }),
      ]);
      expect(session.client.managedInspect).toHaveBeenCalledTimes(2);
    },
  );
  it.each(managementLocales)(
    "preserves unknown-outcome protection when operations reopen in $locale",
    async (copy) => {
      session.locale = copy.locale;
      rememberPending(pendingScope(session.origin, session.access.device.id), {
        kind: "adopt",
        requestId: "saved-request",
        sessionId: "session",
        agent: "claude-code",
      });
      const content = (active: boolean) => (
        <ManagedTasks active={active} renderContent={(children) => (active ? children : null)} />
      );
      const view = render(content(true));
      await screen.findByText(copy.pending);
      view.rerender(content(false));
      view.rerender(content(true));
      await screen.findByText(copy.pending);
      const handoff = await screen.findByRole("button", { name: copy.handoff });
      expect(handoff).toBeDisabled();
      fireEvent.click(screen.getByRole("checkbox"));
      fireEvent.click(handoff);
      expect(mutations()).toEqual([]);
      expect(session.refresh).not.toHaveBeenCalled();
    },
  );
  it("keeps an inspection failure visible and supplies a retry path without handing over", async () => {
    session.client.managedInspect.mockRejectedValue(new Error("inspection failed"));
    await show();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Connection lost. Verify the task list before retrying.",
    );
    const button = screen.getByRole("button", { name: "Hand over to AgentKib" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(managedControlCopy["en-US"].fingerprintUnavailable);
    expect(mutations()).toEqual([]);
  });
  it("shows a readable request error with the original code in collapsed details", async () => {
    session.client.managedInspect.mockRejectedValue(
      new ApiError(503, "inspection_unavailable", "not-dispatched"),
    );
    await show();
    const alert = await screen.findByRole("alert");
    expect(alert.querySelector("p")).toHaveTextContent("The execution management operation failed");
    expect(alert.querySelector("p")).not.toHaveTextContent("inspection_unavailable");
    expect(alert.querySelector("code")).toHaveTextContent("inspection_unavailable");
    expect(alert.querySelector("details")).not.toHaveAttribute("open");
  });
  it("explains that an original-terminal connection must be disconnected before handoff", async () => {
    session.live.executionMode = "claude-follower";
    render(<ManagedTasks initialOpen />);
    expect(
      await screen.findByText("Disconnect the original terminal before handing over to AgentKib."),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Hand over to AgentKib" })).not.toBeInTheDocument();
    expect(mutations()).toEqual([]);
  });
  it("retains the execution-tool error and supplies a next step", async () => {
    session.client.request.mockResolvedValue({
      ...options,
      available: false,
      reason: "tool-not-found",
    });
    await show();
    const code = screen.getByText("tool-not-found");
    expect(code.closest("details")).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText("Error details"));
    expect(code.closest("details")).toHaveAttribute("open");
    const button = screen.getByRole("button", { name: "Hand over to AgentKib" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(managedControlCopy["en-US"].tool);
    expect(mutations()).toEqual([]);
  });
  it.each(["codex", "claude-code"] as const)(
    "explains compaction for %s handoff and release without changing either gate",
    async (agent) => {
      session.current.agent = agent;
      session.live.activity = "compacting";
      const view = await show();
      fireEvent.click(screen.getByRole("checkbox"));
      const adopt = screen.getByRole("button", { name: "Hand over to AgentKib" });
      expect(adopt).toBeDisabled();
      expect(adopt).toHaveAccessibleDescription(managedControlCopy["en-US"].compacting);
      fireEvent.click(adopt);
      session.live.executionMode = agent === "codex" ? "codex-managed" : "claude-managed";
      view.rerender(<ManagedTasks initialOpen />);
      const release = screen.getByRole("button", { name: "Return to original client" });
      expect(release).toBeDisabled();
      expect(release).toHaveAccessibleDescription(managedControlCopy["en-US"].compacting);
      fireEvent.click(release);
      expect(mutations()).toEqual([]);
    },
  );
  it("explains an in-flight release and dispatches only once", async () => {
    session.live.executionMode = "claude-managed";
    session.client.request.mockImplementation((path: string) =>
      path.startsWith("managed/options") ? Promise.resolve(options) : new Promise(() => {}),
    );
    render(<ManagedTasks initialOpen />);
    const button = await screen.findByRole("button", { name: "Return to original client" });
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(managedControlCopy["en-US"].processing);
    fireEvent.click(button);
    expect(mutations()).toHaveLength(1);
    expect(mutations()[0][0]).toBe("managed/release");
  });
  it("localizes the management title and blocked-state explanation in all four languages", async () => {
    const view = await show();
    session.live.activity = "compacting";
    for (const [locale, label, title] of [
      ["en-US", "Hand over to AgentKib", "Execution management"],
      ["zh-CN", "交给 AgentKib", "执行管理"],
      ["zh-TW", "交給 AgentKib", "執行管理"],
      ["ja-JP", "AgentKib に引き渡す", "実行管理"],
    ] as const) {
      session.locale = locale;
      view.rerender(<ManagedTasks initialOpen />);
      expect(screen.getByRole("heading", { name: title })).toBeVisible();
      const button = screen.getByRole("button", { name: label });
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleDescription(managedControlCopy[locale].compacting);
    }
    expect(mutations()).toEqual([]);
  });
  it.each(managementLocales)(
    "renders the Claude default note and explains the host in $locale without starting a task",
    async (copy) => {
      session.locale = copy.locale;
      render(<ManagedTasks create initialOpen />);
      fireEvent.change(screen.getByRole("combobox", { name: copy.agent }), {
        target: { value: "claude-code" },
      });
      expect(await screen.findByText(copy.note)).toBeVisible();
      expect(screen.getByRole("dialog")).toHaveTextContent(copy.host);
      expect(screen.getByRole("button", { name: copy.create })).toBeEnabled();
      expect(mutations()).toEqual([]);
    },
  );
  it.each(managementLocales)(
    "keeps original-terminal connections outside managed handoff in $locale",
    async (copy) => {
      session.locale = copy.locale;
      session.live.executionMode = "claude-follower";
      render(<ManagedTasks initialOpen />);
      expect(await screen.findByText(copy.notHandedOver)).toBeVisible();
      expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: copy.handoff })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: copy.release })).not.toBeInTheDocument();
      expect(screen.queryByText(managedControlCopy[copy.locale].ownership)).not.toBeInTheDocument();
      expect(mutations()).toEqual([]);
    },
  );
  it.each(managementLocales)(
    "describes handoff ownership without claiming an idle session is running in $locale",
    async (copy) => {
      session.locale = copy.locale;
      const view = render(<ManagedTasks initialOpen />);
      await screen.findByRole("button", { name: copy.handoff });
      expect(screen.getByText(copy.notHandedOver)).toBeVisible();
      expect(session.live.status).toBe("idle");
      session.live.executionMode = "claude-managed";
      view.rerender(<ManagedTasks initialOpen />);
      expect(screen.getByText(copy.handedOver)).toBeVisible();
      expect(screen.getByRole("button", { name: copy.release })).toBeEnabled();
      expect(screen.queryByText(copy.notHandedOver)).toBeNull();
      expect(mutations()).toEqual([]);
    },
  );
  it.each(managementLocales)(
    "explains an unconfirmed saved request in $locale without replaying it",
    async (copy) => {
      session.locale = copy.locale;
      const requestId = "11111111-1111-4111-8111-111111111111";
      rememberPending(pendingScope(session.origin, session.access.device.id), {
        requestId,
        sessionId: session.selected,
        kind: "adopt",
        agent: "claude-code",
      });
      render(<ManagedTasks initialOpen />);
      expect(await screen.findByText(copy.pending)).toBeVisible();
      expect(screen.getByText(copy.checking)).toBeVisible();
      const handoff = await screen.findByRole("button", { name: copy.handoff });
      expect(handoff).toBeDisabled();
      fireEvent.click(handoff);
      await waitFor(() => expect(session.client.receipt).toHaveBeenCalledWith(requestId));
      expect(mutations()).toEqual([]);
    },
  );
});
