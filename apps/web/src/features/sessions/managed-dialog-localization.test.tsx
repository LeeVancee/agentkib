import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManagedTasks } from "@/features/conversation/features/sessions/managed-tasks";
import type { Locale } from "@/features/conversation/i18n";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("@/features/conversation/features/sessions/session-context", () => ({
  useSession: () => session,
}));

function makeSession(locale: Locale = "en-US") {
  return {
    origin: "",
    selected: "session",
    current: { id: "session", agent: "codex" },
    live: {
      sessionId: "session",
      executionMode: "external",
      status: "idle",
      approvals: [],
      questions: [],
    },
    capabilities: { sessionId: "session", features: { adopt: { available: true } } },
    access: {
      status: "approved",
      protocolVersion: 2,
      bootId: "boot",
      experimentalEnabled: true,
      device: { id: "device", manage: true, send: true },
    },
    client: {
      request: vi.fn(async (_path: string) => ({
        available: true,
        workspaces: [
          { id: "workspace", name: "Project" },
          { id: "other", name: "Other project" },
        ],
        models: [],
      })),
      receipt: vi.fn(),
    },
    online: true,
    controlReady: true,
    busy: false,
    locale,
    refresh: vi.fn(),
  };
}
let session: ReturnType<typeof makeSession>;

const locales = [
  { locale: "en-US", close: "Close", management: "Execution management", create: "New task" },
  { locale: "zh-CN", close: "关闭", management: "执行管理", create: "新建任务" },
  { locale: "zh-TW", close: "關閉", management: "執行管理", create: "新增任務" },
  { locale: "ja-JP", close: "閉じる", management: "実行管理", create: "タスクを作成" },
] as const;

beforeEach(() => {
  sessionStorage.clear();
  session = makeSession();
  navigate.mockClear();
});
afterEach(cleanup);

describe("actual managed task dialogs", () => {
  describe.each([false, true])("create=%s", (create) => {
    it.each(locales)("localizes the close control in $locale", async (copy) => {
      session = makeSession(copy.locale);
      const onDismiss = vi.fn();
      render(<ManagedTasks create={create} onDismiss={onDismiss} />);
      const trigger = screen.getByRole("button", {
        name: create ? copy.create : copy.management,
      });
      fireEvent.click(trigger);
      const dialog = await screen.findByRole("dialog", {
        name: create ? copy.create : copy.management,
      });
      await waitFor(() => expect(session.client.request).toHaveBeenCalledOnce());

      fireEvent.click(within(dialog).getByRole("button", { name: copy.close }));

      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(onDismiss).toHaveBeenCalledOnce();
      expect(session.client.request.mock.calls.map(([path]) => path)).toEqual(["managed/options"]);
      expect(navigate).not.toHaveBeenCalled();
      expect(session.client.receipt).not.toHaveBeenCalled();
    });
  });

  it("updates the accessible close label without replacing an open form or its selection", async () => {
    const view = render(<ManagedTasks create />);
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    const dialog = await screen.findByRole("dialog", { name: "New task" });
    const workspace = await screen.findByRole("combobox", { name: "Workspace" });
    fireEvent.change(workspace, { target: { value: "other" } });
    session.locale = "ja-JP";

    view.rerender(<ManagedTasks create />);

    expect(screen.getByRole("dialog", { name: "タスクを作成" })).toBe(dialog);
    expect(screen.getByRole("combobox", { name: "ワークスペース" })).toBe(workspace);
    expect(workspace).toHaveValue("other");
    expect(within(dialog).getByRole("button", { name: "閉じる" })).toBeEnabled();
    expect(within(dialog).queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
    expect(session.client.request).toHaveBeenCalledOnce();
  });

  it("retains Escape dismissal and returns focus to the originating trigger", async () => {
    const onDismiss = vi.fn();
    render(<ManagedTasks onDismiss={onDismiss} />);
    const trigger = screen.getByRole("button", { name: "Execution management" });
    trigger.focus();
    fireEvent.click(trigger);
    await screen.findByRole("dialog", { name: "Execution management" });
    await waitFor(() => expect(session.client.request).toHaveBeenCalledOnce());

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape", code: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(session.client.request.mock.calls.map(([path]) => path)).toEqual(["managed/options"]);
  });
});
