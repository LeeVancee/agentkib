// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionController } from "./use-session-controller";
import { ClaudeBridgePanel } from "./claude-bridge-panel";

const state = vi.hoisted(() => ({ session: {} as SessionController, request: vi.fn() }));
vi.mock("./session-context", () => ({ useSession: () => state.session }));
vi.mock("@/core/desktop", () => ({ desktopApi: () => ({ claude: { request: state.request } }) }));

const status = (sessionId = "s") => ({
  supported: true,
  connected: false,
  sessionId,
  version: "2.1.301",
  pluginDirectory: "/isolated/plugin",
  installInstructions: "Install isolated plugin",
});
const challenge = {
  challenge: "one-time-code",
  expiresAt: new Date(Date.now() + 120_000).toISOString(),
  instructions: "/agentkib:connect one-time-code",
};
beforeEach(() => {
  state.request.mockReset();
  state.session = {
    selected: "s",
    current: { id: "s", agent: "claude-code" },
    locale: "zh-CN",
    access: {
      status: "approved",
      protocolVersion: 2,
      experimentalEnabled: true,
      device: { manage: true },
    },
    online: true,
    controlReady: true,
    busy: false,
    live: { sessionId: "s", status: "idle", executionMode: "managed-resume" },
    refresh: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionController;
  state.request.mockImplementation(async ({ operation, sessionId }) =>
    operation === "bridge-status"
      ? status(sessionId)
      : operation === "bridge-challenge"
        ? challenge
        : { disconnected: true },
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Claude terminal connection management", () => {
  it("can revoke when status lookup fails and the pending outcome is unknown", async () => {
    state.session.live = { ...state.session.live!, executionMode: "claude-follower" };
    state.request.mockImplementation(async ({ operation }) => {
      if (operation === "bridge-status") throw new Error("claude_session_unavailable");
      return { disconnected: true };
    });
    const view = render(<ClaudeBridgePanel active />);
    await screen.findByRole("alert");
    state.session = {
      ...state.session,
      notice: "uncertain",
      busy: true,
      live: { ...state.session.live!, status: "outcome-unknown" },
    } as SessionController;
    view.rerender(<ClaudeBridgePanel active />);
    expect(screen.getByRole("button", { name: "生成一次性连接码" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "断开原终端连接" }));
    expect(
      state.request.mock.calls.some(([request]) => request.operation === "bridge-disconnect"),
    ).toBe(false);
    fireEvent.click(await screen.findByRole("button", { name: "确认断开" }));
    await waitFor(() =>
      expect(state.request).toHaveBeenCalledWith({
        operation: "bridge-disconnect",
        sessionId: "s",
      }),
    );
    expect(state.session.refresh).toHaveBeenCalledOnce();
  });
  it("keeps revocation available when the source is unavailable for a new connection", async () => {
    state.session.live = { ...state.session.live!, executionMode: "claude-follower" };
    state.request.mockImplementation(async ({ operation, sessionId }) =>
      operation === "bridge-status"
        ? {
            ...status(sessionId),
            connected: true,
            supported: false,
            reason: "claude-bridge-session-unavailable",
          }
        : { disconnected: true },
    );
    render(<ClaudeBridgePanel active />);
    await screen.findByText("Install isolated plugin");
    expect(screen.getByRole("button", { name: "生成一次性连接码" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "断开原终端连接" }));
    expect(
      state.request.mock.calls.some(([request]) => request.operation === "bridge-disconnect"),
    ).toBe(false);
    fireEvent.click(await screen.findByRole("button", { name: "确认断开" }));
    await waitFor(() => expect(state.session.refresh).toHaveBeenCalled());
    expect(state.request).toHaveBeenCalledWith({ operation: "bridge-disconnect", sessionId: "s" });
  });
  it("only reads status when opened, and creates a challenge without adopting or sending", async () => {
    const view = render(<ClaudeBridgePanel active={false} />);
    expect(state.request).not.toHaveBeenCalled();
    view.rerender(<ClaudeBridgePanel active />);
    await screen.findByText("Install isolated plugin");
    fireEvent.click(screen.getByRole("button", { name: "生成一次性连接码" }));
    fireEvent.click(screen.getByRole("button", { name: "生成一次性连接码" }));
    await screen.findByText("one-time-code", { selector: "code" });
    expect(state.request.mock.calls.map(([request]) => request.operation)).toEqual([
      "bridge-status",
      "bridge-challenge",
    ]);
    expect(state.session.refresh).not.toHaveBeenCalled();
  });
  it("clears the revoked connection code after a successful disconnect", async () => {
    const view = render(<ClaudeBridgePanel active />);
    await screen.findByText("Install isolated plugin");
    fireEvent.click(screen.getByRole("button", { name: "生成一次性连接码" }));
    await screen.findByText("one-time-code", { selector: "code" });
    expect(screen.getByRole("button", { name: "断开原终端连接" })).toBeDisabled();
    state.session.live = { ...state.session.live!, executionMode: "claude-follower" };
    view.rerender(<ClaudeBridgePanel active />);
    fireEvent.click(screen.getByRole("button", { name: "断开原终端连接" }));
    expect(
      state.request.mock.calls.some(([request]) => request.operation === "bridge-disconnect"),
    ).toBe(false);
    fireEvent.click(await screen.findByRole("button", { name: "确认断开" }));
    await waitFor(() => expect(state.session.refresh).toHaveBeenCalled());
    expect(screen.queryByText("one-time-code", { selector: "code" })).not.toBeInTheDocument();
    expect(state.request).toHaveBeenCalledWith({ operation: "bridge-disconnect", sessionId: "s" });
  });
  it("copies installation instructions, connection command and code with feedback", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<ClaudeBridgePanel active />);
    await screen.findByText("Install isolated plugin");
    fireEvent.click(screen.getByRole("button", { name: "复制安装命令" }));
    await screen.findByText("复制安装命令 · 已复制");
    expect(writeText).toHaveBeenLastCalledWith("Install isolated plugin");
    fireEvent.click(screen.getByRole("button", { name: "生成一次性连接码" }));
    await screen.findByText("one-time-code", { selector: "code" });
    fireEvent.click(screen.getByRole("button", { name: "复制连接命令" }));
    await screen.findByText("复制连接命令 · 已复制");
    expect(writeText).toHaveBeenLastCalledWith(challenge.instructions);
    fireEvent.click(screen.getByRole("button", { name: "复制连接码" }));
    await screen.findByText("复制连接码 · 已复制");
    expect(writeText).toHaveBeenLastCalledWith(challenge.challenge);
    expect(screen.getByText("连接码只用于你自己的终端，请勿发给他人。")).toBeVisible();
    writeText.mockRejectedValueOnce(new Error("clipboard unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "复制连接码" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("复制失败，请手动选择并复制。");
  });
  it("keeps a valid code through explicit status refresh, busy and uncertain transitions", async () => {
    const view = render(<ClaudeBridgePanel active />);
    await screen.findByText("Install isolated plugin");
    fireEvent.click(screen.getByRole("button", { name: "生成一次性连接码" }));
    await screen.findByText("one-time-code", { selector: "code" });
    fireEvent.click(screen.getByRole("button", { name: "检查连接" }));
    await waitFor(() => expect(state.request).toHaveBeenCalledTimes(3));
    expect(screen.getByText("one-time-code", { selector: "code" })).toBeVisible();
    state.session = { ...state.session, busy: true, notice: "uncertain" };
    view.rerender(<ClaudeBridgePanel active />);
    expect(screen.getByText("one-time-code", { selector: "code" })).toBeVisible();
    state.session = { ...state.session, busy: false, notice: undefined };
    view.rerender(<ClaudeBridgePanel active />);
    await waitFor(() => expect(state.request).toHaveBeenCalledTimes(4));
    expect(screen.getByText("one-time-code", { selector: "code" })).toBeVisible();
  });
  it("retains the code but disables a new challenge after a failed status refresh", async () => {
    render(<ClaudeBridgePanel active />);
    await screen.findByText("Install isolated plugin");
    fireEvent.click(screen.getByRole("button", { name: "生成一次性连接码" }));
    await screen.findByText("one-time-code", { selector: "code" });
    state.request.mockRejectedValueOnce(new Error("status unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "检查连接" }));
    await screen.findByRole("alert");
    expect(screen.getByText("one-time-code", { selector: "code" })).toBeVisible();
    expect(screen.getByRole("button", { name: "生成一次性连接码" })).toBeDisabled();
  });
  it.each([
    ["platform-unsupported", "连接原 Claude 终端仅支持 macOS。请在 macOS 主机上操作。"],
    [
      "claude-bridge-unavailable",
      "原终端桥接服务无法启动。请检查主机日志并重新启动 AgentKib 后重试。",
    ],
  ])("explains %s and the required CLI version", async (reason, explanation) => {
    state.request.mockResolvedValue({ ...status(), supported: false, reason });
    render(<ClaudeBridgePanel active />);
    expect(await screen.findByText(explanation)).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("需要 Claude Code 2.1.301");
    expect(screen.getByRole("button", { name: "生成一次性连接码" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "断开原终端连接" })).toBeDisabled();
  });
  it("polls connection failures after code expiry and clears the code only on a confirmed connection", async () => {
    vi.useFakeTimers();
    let result = { ...status(), connectionError: undefined as string | undefined };
    state.request.mockImplementation(async ({ operation }) =>
      operation === "bridge-status"
        ? result
        : { ...challenge, expiresAt: new Date(Date.now() + 1000).toISOString() },
    );
    render(<ClaudeBridgePanel active />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "生成一次性连接码" }));
    await act(async () => {});
    expect(screen.getByText("one-time-code", { selector: "code" })).toBeVisible();
    result = { ...result, connectionError: "bridge-version-mismatch" };
    await act(async () => vi.advanceTimersByTime(2500));
    expect(screen.getByRole("alert")).toHaveTextContent("Claude Code 或插件版本不匹配");
    expect(screen.queryByText("one-time-code", { selector: "code" })).not.toBeInTheDocument();
    result = { ...result, connectionError: "expired-bridge-challenge" };
    await act(async () => vi.advanceTimersByTime(2500));
    expect(screen.getByRole("alert")).toHaveTextContent("连接码已过期，请重新生成。");
    result = { ...result, connected: true, connectionError: undefined };
    await act(async () => vi.advanceTimersByTime(2500));
    expect(state.session.refresh).toHaveBeenCalledExactlyOnceWith(true);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("requires disconnecting an existing terminal before a fresh code can be generated", async () => {
    vi.useFakeTimers();
    state.request.mockResolvedValue({ ...status(), connected: true });
    render(<ClaudeBridgePanel active />);
    await act(async () => {});
    const generate = screen.getByRole("button", { name: "生成一次性连接码" });
    expect(generate).toBeDisabled();
    expect(screen.getByText("若要生成新的连接码，请先断开当前原终端连接。")).toBeVisible();
    fireEvent.click(generate);
    await act(async () => vi.advanceTimersByTime(2500));
    expect(
      state.request.mock.calls.every(([request]) => request.operation === "bridge-status"),
    ).toBe(true);
    expect(state.session.refresh).toHaveBeenCalledExactlyOnceWith(true);
    expect(screen.getByRole("button", { name: "断开原终端连接" })).toBeEnabled();
  });
  it("does not display a late challenge for a different session", async () => {
    let resolve!: (value: unknown) => void;
    state.request.mockImplementation(async ({ operation, sessionId }) =>
      operation === "bridge-status"
        ? status(sessionId)
        : new Promise((done) => {
            resolve = done;
          }),
    );
    const view = render(<ClaudeBridgePanel active />);
    await screen.findByText("Install isolated plugin");
    fireEvent.click(screen.getByRole("button", { name: "生成一次性连接码" }));
    state.session = {
      ...state.session,
      selected: "other",
      current: { ...state.session.current!, id: "other" },
    };
    view.rerender(<ClaudeBridgePanel active />);
    await act(async () => resolve(challenge));
    expect(screen.queryByText("one-time-code", { selector: "code" })).not.toBeInTheDocument();
  });
  it("removes the connection code when its finite expiry is reached", async () => {
    vi.useFakeTimers();
    state.request.mockImplementation(async ({ operation, sessionId }) =>
      operation === "bridge-status"
        ? status(sessionId)
        : {
            ...challenge,
            expiresAt: new Date(Date.now() + 120_000).toISOString(),
          },
    );
    render(<ClaudeBridgePanel active />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "生成一次性连接码" }));
    await act(async () => {});
    expect(screen.getByText("one-time-code", { selector: "code" })).toBeVisible();
    act(() => vi.advanceTimersByTime(120_000));
    expect(screen.queryByText("one-time-code", { selector: "code" })).not.toBeInTheDocument();
    expect(screen.getByText("连接码已过期，请重新生成。")).toBeVisible();
  });
  it.each(["offline", "revoked"])("clears a challenge when %s", async (reason) => {
    const view = render(<ClaudeBridgePanel active />);
    await screen.findByText("Install isolated plugin");
    fireEvent.click(screen.getByRole("button", { name: "生成一次性连接码" }));
    await screen.findByText("one-time-code", { selector: "code" });
    state.session = {
      ...state.session,
      ...(reason === "offline"
        ? { online: false }
        : reason === "revoked"
          ? {
              access: {
                ...state.session.access!,
                device: { ...state.session.access!.device!, manage: false },
              },
            }
          : { notice: "uncertain" }),
    };
    view.rerender(<ClaudeBridgePanel active />);
    expect(screen.queryByText("one-time-code", { selector: "code" })).not.toBeInTheDocument();
    expect(
      state.request.mock.calls.some(([request]) => request.operation === "bridge-disconnect"),
    ).toBe(false);
  });
  it("disables pairing for an unsupported CLI and rejects mismatched status identities", async () => {
    state.request.mockResolvedValue({ ...status(), supported: false });
    const view = render(<ClaudeBridgePanel active />);
    await screen.findByText("Install isolated plugin");
    expect(screen.getByRole("button", { name: "生成一次性连接码" })).toBeDisabled();
    state.request.mockResolvedValue(status("wrong"));
    fireEvent.click(screen.getByRole("button", { name: "检查连接" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "生成一次性连接码" })).toBeDisabled();
    view.unmount();
  });
});
