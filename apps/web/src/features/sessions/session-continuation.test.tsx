import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  sessionContinuationCopy,
  SessionContinuationChoice,
  SessionContinuationReadOnly,
  SessionContinuationStatus,
} from "@agentkib/session-ui";

const localizedChoices = [
  {
    locale: "zh-CN",
    fork: "分支会话并继续",
    returnTo: "回 Codex 继续",
    choice: "这条会话正在 Codex 中使用。为避免两边同时写入，请选择：",
    hint: '原会话不受影响，新会话会标"分支自 Project"',
    quit: "只关掉 Codex 的窗口可能不够，完全退出应用后才能在这里继续",
    placeholder: "继续这条会话…",
    starting: "正在启动…",
    running: "在 AgentKib 中运行",
    viewOnly: "仅可查看",
  },
  {
    locale: "zh-TW",
    fork: "分支對話並繼續",
    returnTo: "回 Codex 繼續",
    choice: "這段對話正在 Codex 中使用。為避免兩邊同時寫入，請選擇：",
    hint: "原對話不受影響，新對話會標「分支自 Project」",
    quit: "只關閉 Codex 的視窗可能不夠，完全結束應用程式後才能在這裡繼續",
    placeholder: "繼續這段對話…",
    starting: "正在啟動…",
    running: "在 AgentKib 中執行",
    viewOnly: "僅可查看",
  },
  {
    locale: "ja-JP",
    fork: "会話を分岐して続ける",
    returnTo: "Codex で続ける",
    choice: "この会話は Codex で使用中です。同時に書き込まれないよう、操作を選んでください：",
    hint: "元の会話には影響しません。新しい会話には「Project から分岐」と表示されます。",
    quit: "Codex のウィンドウを閉じるだけでは不十分な場合があります。ここで続けるには、アプリを完全に終了してください。",
    placeholder: "この会話を続ける…",
    starting: "起動中…",
    running: "AgentKib で実行中",
    viewOnly: "閲覧のみ",
  },
  {
    locale: "en-US",
    fork: "Fork and continue",
    returnTo: "Continue in Codex",
    choice: "This session is in use in Codex. To avoid both sides writing at once, choose:",
    hint: 'The original session stays as is. The new one is marked "Forked from Project".',
    quit: "Closing the Codex window may not be enough. Quit the app completely to continue here.",
    placeholder: "Continue this session…",
    starting: "Starting…",
    running: "Running in AgentKib",
    viewOnly: "View only",
  },
];

afterEach(cleanup);

describe("shared session continuation choice", () => {
  it.each(localizedChoices)("renders usable choices in $locale", async (copy) => {
    const onFork = vi.fn(async () => {});
    const onReturn = vi.fn();
    const pluginAction = vi.fn();
    render(
      <SessionContinuationChoice
        locale={copy.locale}
        agent="Codex"
        title="Project"
        onFork={onFork}
        onReturn={onReturn}
        pluginAction={pluginAction}
      />,
    );

    const group = screen.getByRole("group", { name: copy.choice });
    expect(group).toHaveTextContent(copy.quit);
    const fork = screen.getByRole("button", { name: copy.fork });
    expect(fork).toHaveAccessibleDescription(copy.hint);
    expect(fork).toHaveAttribute("type", "button");
    expect(fork).toHaveClass("min-h-11", "whitespace-normal", "w-full", "sm:w-auto");
    expect(fork.parentElement?.parentElement).toHaveClass("flex-wrap");
    const returnTo = screen.getByRole("button", { name: copy.returnTo });
    expect(returnTo).toHaveClass("min-h-11");
    expect(screen.getAllByRole("button")).toHaveLength(2);

    fireEvent.click(fork);
    fireEvent.click(returnTo);
    expect(onFork).toHaveBeenCalledOnce();
    expect(onReturn).toHaveBeenCalledOnce();
    expect(pluginAction).not.toHaveBeenCalled();
  });

  it("disables every action while a choice is being applied", () => {
    const action = vi.fn();
    render(
      <SessionContinuationChoice
        locale="en-US"
        agent="Claude Code"
        title="Project"
        onFork={action}
        onReturn={action}
        pluginAction={action}
        disabled
      />,
    );
    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(action).not.toHaveBeenCalled();
  });

  it("keeps returning to Codex available when forking is unavailable", () => {
    const onFork = vi.fn();
    const onReturn = vi.fn();
    render(
      <SessionContinuationChoice
        locale="en-US"
        agent="Codex"
        title="Project"
        onFork={onFork}
        onReturn={onReturn}
        forkDisabled
      />,
    );
    const fork = screen.getByRole("button", { name: "Fork and continue" });
    const returnTo = screen.getByRole("button", { name: "Continue in Codex" });
    expect(fork).toBeDisabled();
    expect(returnTo).toBeEnabled();
    fireEvent.click(fork);
    fireEvent.click(returnTo);
    expect(onFork).not.toHaveBeenCalled();
    expect(onReturn).toHaveBeenCalledOnce();
  });

  it("offers the optional terminal plugin action only for Claude Code", () => {
    const pluginAction = vi.fn();
    const props = {
      locale: "en-US",
      agent: "Claude Code" as const,
      title: "Project",
      onFork: vi.fn(),
      onReturn: vi.fn(),
    };
    const view = render(<SessionContinuationChoice {...props} />);
    expect(screen.getAllByRole("button")).toHaveLength(2);
    view.rerender(<SessionContinuationChoice {...props} pluginAction={pluginAction} />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Install the connection plugin to connect automatically",
      }),
    );
    expect(pluginAction).toHaveBeenCalledOnce();
    expect(screen.queryByText(/Closing the Codex window/)).not.toBeInTheDocument();
  });
});

const readOnlyLocales = [
  {
    locale: "zh-CN",
    copy: "复制续接命令",
    copied: "续接命令已复制",
    help: "在运行 AgentKib 的电脑上打开终端（Windows 请使用 PowerShell），粘贴并运行续接命令。如果原客户端仍占用这条会话，请先在原客户端继续。",
  },
  {
    locale: "zh-TW",
    copy: "複製續接命令",
    copied: "續接命令已複製",
    help: "在執行 AgentKib 的電腦上開啟終端（Windows 請使用 PowerShell），貼上並執行續接命令。如果原客戶端仍在使用這段對話，請先在原客戶端繼續。",
  },
  {
    locale: "ja-JP",
    copy: "再開コマンドをコピー",
    copied: "再開コマンドをコピーしました",
    help: "AgentKib を実行しているコンピューターでターミナル（Windows では PowerShell）を開き、再開コマンドを貼り付けて実行してください。元のクライアントでこの会話を使用中の場合は、先にそちらで続けてください。",
  },
  {
    locale: "en-US",
    copy: "Copy resume command",
    copied: "Resume command copied",
    help: "On the computer running AgentKib, open a terminal (use PowerShell on Windows), paste the resume command and run it. If this session is still in use in the original client, continue there first.",
  },
];

describe("shared read-only session continuation", () => {
  const command = "cd '/tmp/Project with spaces'\ncodex resume 'synthetic-session'";
  let clipboardBefore: PropertyDescriptor | undefined;
  function setClipboard(writeText?: (text: string) => Promise<void>) {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: writeText ? { writeText } : undefined,
    });
  }
  beforeEach(() => {
    clipboardBefore = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  });
  afterEach(() => {
    if (clipboardBefore) Object.defineProperty(navigator, "clipboard", clipboardBefore);
    else Reflect.deleteProperty(navigator, "clipboard");
  });

  it.each(readOnlyLocales)("preloads and copies the exact command in $locale", async (copy) => {
    const writeText = vi.fn(async () => {});
    setClipboard(writeText);
    const loadCommand = vi.fn(async (_signal: AbortSignal) => command);
    render(
      <SessionContinuationReadOnly
        locale={copy.locale}
        reason="Session restriction"
        loadCommand={loadCommand}
      />,
    );
    const button = screen.getByRole("button", { name: copy.copy });
    expect(button).toBeDisabled();
    expect(button).toHaveClass("min-h-11", "w-full", "sm:w-auto");
    expect(screen.getAllByText("Session restriction")).toHaveLength(1);
    expect(screen.getByRole("group")).toHaveAccessibleDescription(copy.help);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByText(command)).not.toBeInTheDocument();
    await waitFor(() => expect(button).toBeEnabled());
    expect(loadCommand).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal));
    expect(writeText).not.toHaveBeenCalled();

    fireEvent.click(button);
    expect(button).toBeDisabled();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(copy.copied));

    expect(writeText).toHaveBeenCalledExactlyOnceWith(command);
    expect(button).toBeEnabled();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("allows a failed preload to be retried without exposing its original error", async () => {
    const loadCommand = vi
      .fn<(signal: AbortSignal) => Promise<string>>()
      .mockRejectedValueOnce(new Error("private command lookup failure"))
      .mockResolvedValueOnce(command);
    render(<SessionContinuationReadOnly locale="en-US" loadCommand={loadCommand} />);
    const copy = screen.getByRole("button", { name: "Copy resume command" });
    await screen.findByText("Could not load the resume command. Try again.");
    expect(copy).toBeDisabled();
    expect(screen.queryByText(/private command/)).not.toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "Reload command" });
    expect(retry).toHaveClass("min-h-11");
    fireEvent.click(retry);
    expect(copy).toBeDisabled();
    await waitFor(() => expect(copy).toBeEnabled());
    expect(loadCommand).toHaveBeenCalledTimes(2);
    expect(loadCommand.mock.calls[0]![0].aborted).toBe(true);
    expect(
      screen.queryByText("Could not load the resume command. Try again."),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it.each(["rejected", "missing"])(
    "reveals an accessible manual copy field only after the clipboard is %s",
    async (clipboard) => {
      const writeText = vi.fn().mockRejectedValue(new Error("private clipboard denial"));
      setClipboard(clipboard === "rejected" ? writeText : undefined);
      render(<SessionContinuationReadOnly locale="en-US" loadCommand={async () => command} />);
      const copy = screen.getByRole("button", { name: "Copy resume command" });
      await waitFor(() => expect(copy).toBeEnabled());
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
      fireEvent.click(copy);

      const field = await screen.findByRole("textbox", { name: "Resume command (manual copy)" });
      expect(field).toHaveValue(command);
      expect(field).toHaveAttribute("readonly");
      expect(screen.getByRole("status")).toHaveTextContent(
        "Could not copy automatically. Copy the command below manually.",
      );
      expect(screen.queryByText(/private clipboard/)).not.toBeInTheDocument();
    },
  );

  it("aborts an old preload and ignores its result when the session changes", async () => {
    let finishOld!: (value: string) => void;
    let finishNew!: (value: string) => void;
    const oldLoader = vi.fn(
      (_signal: AbortSignal) =>
        new Promise<string>((resolve) => {
          finishOld = resolve;
        }),
    );
    const newLoader = vi.fn(
      (_signal: AbortSignal) =>
        new Promise<string>((resolve) => {
          finishNew = resolve;
        }),
    );
    const view = render(
      <SessionContinuationReadOnly locale="en-US" reason="Old session" loadCommand={oldLoader} />,
    );
    view.rerender(
      <SessionContinuationReadOnly locale="en-US" reason="New session" loadCommand={newLoader} />,
    );
    expect(oldLoader.mock.calls[0]![0].aborted).toBe(true);
    await act(async () => finishOld("old command"));
    expect(screen.getByRole("button", { name: "Copy resume command" })).toBeDisabled();
    expect(screen.queryByText("Old session")).not.toBeInTheDocument();
    await act(async () => finishNew(command));
    expect(screen.getByRole("button", { name: "Copy resume command" })).toBeEnabled();
    view.unmount();
    expect(newLoader.mock.calls[0]![0].aborted).toBe(true);
  });

  it("aborts a pending preload on unmount", async () => {
    let finish!: (value: string) => void;
    const loadCommand = vi.fn(
      (_signal: AbortSignal) =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(<SessionContinuationReadOnly locale="en-US" loadCommand={loadCommand} />);
    view.unmount();
    expect(loadCommand.mock.calls[0]![0].aborted).toBe(true);
    await act(async () => finish(command));
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it.each(["resolved", "rejected"])(
    "ignores an older %s clipboard result after copying from a new session",
    async (outcome) => {
      let resolveOld!: () => void;
      let rejectOld!: (error: Error) => void;
      const oldCopy = new Promise<void>((resolve, reject) => {
        resolveOld = resolve;
        rejectOld = reject;
      });
      const writeText = vi.fn().mockReturnValueOnce(oldCopy).mockResolvedValueOnce(undefined);
      setClipboard(writeText);
      const oldLoader = async () => "old command";
      const newLoader = async () => command;
      const view = render(<SessionContinuationReadOnly locale="en-US" loadCommand={oldLoader} />);
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Copy resume command" })).toBeEnabled(),
      );
      fireEvent.click(screen.getByRole("button", { name: "Copy resume command" }));
      expect(screen.getByRole("button", { name: "Copy resume command" })).toBeDisabled();
      view.rerender(<SessionContinuationReadOnly locale="en-US" loadCommand={newLoader} />);
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Copy resume command" })).toBeEnabled(),
      );
      fireEvent.click(screen.getByRole("button", { name: "Copy resume command" }));
      await screen.findByText("Resume command copied");
      await act(async () => {
        if (outcome === "resolved") resolveOld();
        else rejectOld(new Error("obsolete clipboard denial"));
      });

      expect(writeText).toHaveBeenNthCalledWith(1, "old command");
      expect(writeText).toHaveBeenNthCalledWith(2, command);
      expect(screen.getByRole("status")).toHaveTextContent("Resume command copied");
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    },
  );

  it("omits empty reasons and does not add another view-only title", async () => {
    render(
      <SessionContinuationReadOnly locale="en-US" reason="  " loadCommand={async () => command} />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Copy resume command" })).toBeEnabled(),
    );
    expect(screen.queryByText("View only")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });
});

describe("shared session continuation status and copy", () => {
  it.each(localizedChoices)("renders each status in $locale", (expected) => {
    const copy = sessionContinuationCopy(expected.locale);
    expect(copy.placeholder).toBe(expected.placeholder);
    const view = render(<SessionContinuationStatus label={copy.starting} loading />);
    expect(screen.getByRole("status")).toHaveTextContent(expected.starting);
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status").firstElementChild).toHaveClass("animate-spin");

    view.rerender(<SessionContinuationStatus label={copy.running} active className="gap-2" />);
    expect(screen.getByRole("status")).toHaveTextContent(expected.running);
    expect(screen.getByRole("status")).toHaveClass("text-primary", "gap-2");
    expect(screen.getByRole("status")).not.toHaveAttribute("aria-busy");

    view.rerender(<SessionContinuationStatus label={copy.viewOnly} />);
    expect(screen.getByRole("status")).toHaveTextContent(expected.viewOnly);
    expect(screen.getByRole("status")).toHaveClass("text-muted-foreground");
  });

  it.each([null, undefined, "", "   "])("omits an absent label (%s)", (label) => {
    const { container } = render(<SessionContinuationStatus label={label} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("uses English for unsupported locales", () => {
    expect(sessionContinuationCopy("fr-FR").placeholder).toBe("Continue this session…");
  });
});
