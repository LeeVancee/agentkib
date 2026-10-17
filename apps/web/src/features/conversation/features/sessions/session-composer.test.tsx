// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { useState, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UploadedAttachment } from "@agentkib/web-client";
import { SessionComposer } from "./session-composer";
import { composerLayoutCopy } from "./composer-layout-copy";
import { codexCopy } from "./codex-copy";
import type { CodexResource } from "./codex-session-controls";
import type { SessionController } from "./use-session-controller";

const doubles = vi.hoisted(() => ({
  session: {} as Partial<SessionController>,
  control: vi.fn(),
  codexAction: vi.fn(),
  upload: vi.fn(),
}));
vi.mock("./session-context", () => ({
  useSession: () => {
    const [message, setMessage] = useState("");
    return { ...doubles.session, message, setMessage } as SessionController;
  },
}));
vi.mock("./session-panels", () => ({ useSessionPanels: () => null }));
vi.mock("./context-usage", () => ({ ContextUsageGauge: () => null }));
vi.mock("../history/history-search-controls", () => ({ HistoryReferenceChips: () => null }));
vi.mock("./codex-session-controls", () => ({
  CodexComposerControls: ({
    action,
    advancedActions,
    setResources,
  }: {
    action: ReactNode;
    advancedActions: ReactNode;
    setResources: (resources: CodexResource[]) => void;
  }) => (
    <>
      <button
        type="button"
        onClick={() =>
          setResources([{ id: "file", kind: "file", name: "README", available: true }])
        }
      >
        Reference file
      </button>
      {advancedActions}
      {action}
    </>
  ),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function renderComposer(message = "Draft message") {
  const view = render(<SessionComposer />);
  const input = screen.getByRole("textbox", { name: "Message" });
  fireEvent.change(input, { target: { value: message } });
  return { ...view, input, form: input.closest("form")! };
}

const attachment: UploadedAttachment = {
  id: "attachment",
  name: "note.txt",
  mime: "text/plain",
  size: 3,
  version: "1",
};

describe("composer sending shortcuts", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    doubles.control.mockResolvedValue(true);
    doubles.codexAction.mockResolvedValue({ accepted: true });
    doubles.session = {
      selected: "session",
      current: { id: "session", agent: "codex" } as SessionController["current"],
      locale: "en-US",
      t: { message: "Message", send: "Send", stop: "Stop" } as SessionController["t"],
      online: true,
      busy: false,
      controlReady: true,
      canSend: true,
      canStop: false,
      live: {
        sessionId: "session",
        revision: 1,
        sendEnabled: true,
        status: "idle",
        approvals: [],
        questions: [],
      } as SessionController["live"],
      access: {
        protocolVersion: 2,
        experimentalEnabled: true,
        device: { send: true, attachments: true },
      } as SessionController["access"],
      capabilities: {
        sessionId: "session",
        features: {
          attachments: { available: true },
          steer: { available: true },
          "queue-add": { available: true },
        },
      } as SessionController["capabilities"],
      control: doubles.control,
      codexAction: doubles.codexAction,
      client: {
        uploadAttachment: doubles.upload,
        request: vi.fn(),
      } as unknown as SessionController["client"],
    };
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("submits Enter through the same form path as the send button", async () => {
    const { input, form } = renderComposer();
    expect(screen.getByRole("button", { name: "Send" })).toHaveClass("size-11");
    expect(screen.getByRole("button", { name: codexCopy["en-US"].attachment })).toHaveClass(
      "size-11",
    );
    const requestSubmit = vi.spyOn(form, "requestSubmit");
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
    await waitFor(() => expect(input).toHaveValue(""));
    expect(requestSubmit).toHaveBeenCalledTimes(1);
    expect(doubles.control).toHaveBeenCalledExactlyOnceWith(
      "send",
      undefined,
      undefined,
      undefined,
      undefined,
      { attachmentIds: [] },
    );
    expect(doubles.codexAction).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "Second message" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(doubles.control).toHaveBeenCalledTimes(2));
  });

  it("keeps coarse-pointer Enter as a newline and sends only with the button", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
    const { input } = renderComposer();
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(true);
    expect(doubles.control).not.toHaveBeenCalled();
    expect(screen.queryByText(composerLayoutCopy["en-US"].sendShortcut)).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "Line one\nLine two" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(doubles.control).toHaveBeenCalledTimes(1));
  });

  it("leaves Shift+Enter available for the browser's newline input", () => {
    const { input } = renderComposer();
    expect(fireEvent.keyDown(input, { key: "Enter", shiftKey: true })).toBe(true);
    fireEvent.change(input, { target: { value: "Draft message\n" } });
    expect(input).toHaveValue("Draft message\n");
    expect(doubles.control).not.toHaveBeenCalled();
  });

  it.each(["ctrlKey", "metaKey", "altKey"])("leaves %s combinations unchanged", (modifier) => {
    const { input } = renderComposer();
    expect(fireEvent.keyDown(input, { key: "Enter", [modifier]: true })).toBe(true);
    expect(doubles.control).not.toHaveBeenCalled();
  });

  it("does not submit native IME composition or keyCode 229", async () => {
    const { input } = renderComposer("中文草稿");
    expect(fireEvent.keyDown(input, { key: "Enter", isComposing: true })).toBe(true);
    expect(fireEvent.keyDown(input, { key: "Enter", keyCode: 229 })).toBe(true);
    fireEvent.compositionStart(input);
    expect(fireEvent.keyDown(input, { key: "Enter", isComposing: false, keyCode: 13 })).toBe(true);
    expect(doubles.control).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    // WebKit may clear isComposing before the confirming key's keydown.
    expect(fireEvent.keyDown(input, { key: "Enter", isComposing: false, keyCode: 229 })).toBe(true);
    expect(doubles.control).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter", keyCode: 13 });
    await waitFor(() => expect(doubles.control).toHaveBeenCalledTimes(1));
  });

  it("does not send a held Enter key repeatedly", async () => {
    const { input } = renderComposer();
    expect(fireEvent.keyDown(input, { key: "Enter", repeat: true })).toBe(false);
    expect(doubles.control).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(doubles.control).toHaveBeenCalledTimes(1));
  });

  it.each([
    ["not permitted", { canSend: false }],
    ["offline", { online: false, canSend: false }],
    ["busy", { busy: true, canSend: false }],
    [
      "compacting",
      {
        canSend: false,
        live: {
          sessionId: "session",
          status: "idle",
          activity: "compacting",
          approvals: [],
          questions: [],
        },
      },
    ],
    [
      "running",
      {
        canSend: false,
        canStop: true,
        live: { sessionId: "session", status: "running", approvals: [], questions: [] },
      },
    ],
  ] as [string, Partial<SessionController>][])("preserves the %s send gate", (_name, overrides) => {
    doubles.session = { ...doubles.session, ...overrides };
    const { input } = renderComposer();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(doubles.control).not.toHaveBeenCalled();
    expect(doubles.codexAction).not.toHaveBeenCalled();
    expect(screen.queryByText(composerLayoutCopy["en-US"].sendShortcut)).not.toBeInTheDocument();
  });

  it.each(["", " \n "])("does not send an empty text draft (%j)", (message) => {
    const { input } = renderComposer(message);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(doubles.control).not.toHaveBeenCalled();
  });

  it("waits for uploads and permits an attachment-only message once ready", async () => {
    const upload = deferred<UploadedAttachment>();
    doubles.upload.mockReturnValue(upload.promise);
    const { input } = renderComposer("");
    fireEvent.change(screen.getByLabelText(codexCopy["en-US"].attachment), {
      target: { files: [new File(["abc"], "note.txt", { type: "text/plain" })] },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(doubles.control).not.toHaveBeenCalled();
    await act(async () => upload.resolve(attachment));
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(doubles.control).toHaveBeenCalledWith(
        "send",
        undefined,
        undefined,
        undefined,
        undefined,
        { attachmentIds: [attachment.id] },
      ),
    );
  });

  it("keeps failed attachments from dispatching a text message", async () => {
    doubles.upload.mockRejectedValue(new Error("upload failed"));
    const { input } = renderComposer();
    fireEvent.change(screen.getByLabelText(codexCopy["en-US"].attachment), {
      target: { files: [new File(["abc"], "note.txt")] },
    });
    await screen.findByRole("alert");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(doubles.control).not.toHaveBeenCalled();
  });

  it("does not send file references without message text or attachments", () => {
    doubles.session.access = {
      ...doubles.session.access,
      device: { ...doubles.session.access?.device, accessMode: "full" },
    } as SessionController["access"];
    const { input } = renderComposer("");
    fireEvent.click(screen.getByRole("button", { name: "Reference file" }));
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText(composerLayoutCopy["en-US"].resourceNeedsMessage)).toBeVisible();
    expect(doubles.control).not.toHaveBeenCalled();
  });

  it("keeps resource references on the existing send path when text is present", async () => {
    doubles.session.access = {
      ...doubles.session.access,
      device: { ...doubles.session.access?.device, accessMode: "full" },
    } as SessionController["access"];
    const { input } = renderComposer();
    fireEvent.click(screen.getByRole("button", { name: "Reference file" }));
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(doubles.control).toHaveBeenCalledWith(
        "send",
        undefined,
        undefined,
        undefined,
        undefined,
        { attachmentIds: [], resourceIds: ["file"] },
      ),
    );
  });

  it.each(["steer", "queue-add"] as const)(
    "keeps %s behind the existing advanced action",
    async (action) => {
      doubles.session.access = {
        ...doubles.session.access,
        device: { ...doubles.session.access?.device, advancedControl: true },
      } as SessionController["access"];
      doubles.session.canSend = false;
      doubles.session.canStop = true;
      doubles.session.live = {
        sessionId: "session",
        revision: 1,
        sendEnabled: false,
        status: "running",
        turnId: "turn",
        approvals: [],
        questions: [],
      } as SessionController["live"];
      const { input } = renderComposer();
      fireEvent.keyDown(input, { key: "Enter" });
      expect(doubles.control).not.toHaveBeenCalled();
      expect(doubles.codexAction).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Stop" })).toHaveClass("size-11");
      expect(screen.getByRole("button", { name: codexCopy["en-US"].advanced })).toHaveClass(
        "size-11",
      );
      fireEvent.click(screen.getByRole("button", { name: codexCopy["en-US"].advanced }));
      fireEvent.click(
        await screen.findByRole("menuitem", {
          name: action === "steer" ? codexCopy["en-US"].steer : codexCopy["en-US"].queueAdd,
        }),
      );
      await waitFor(() =>
        expect(doubles.codexAction).toHaveBeenCalledWith(action, {
          text: "Draft message",
          ...(action === "steer" ? { turnId: "turn" } : {}),
        }),
      );
      expect(doubles.control).not.toHaveBeenCalled();
    },
  );

  it("keeps queueing available during compaction without sending or steering", async () => {
    doubles.session.access = {
      ...doubles.session.access,
      device: { ...doubles.session.access?.device, advancedControl: true },
    } as SessionController["access"];
    doubles.session.canSend = false;
    doubles.session.live = {
      sessionId: "session",
      revision: 1,
      sendEnabled: false,
      status: "running",
      activity: "compacting",
      approvals: [],
      questions: [],
    } as SessionController["live"];
    const { input } = renderComposer();
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: codexCopy["en-US"].advanced }));
    const steer = await screen.findByRole("menuitem", { name: codexCopy["en-US"].steer });
    expect(steer).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("menuitem", { name: codexCopy["en-US"].queueAdd }));
    await waitFor(() =>
      expect(doubles.codexAction).toHaveBeenCalledExactlyOnceWith("queue-add", {
        text: "Draft message",
      }),
    );
    expect(doubles.control).not.toHaveBeenCalled();
  });

  it("locks concurrent Enter and form submissions before React rerenders", async () => {
    const request = deferred<boolean>();
    doubles.control.mockReturnValueOnce(request.promise);
    const { input, form } = renderComposer();
    act(() => {
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.submit(form);
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(doubles.control).toHaveBeenCalledTimes(1);
    expect(input).toBeDisabled();
    await act(async () => request.resolve(true));
    expect(input).toBeEnabled();
    expect(input).toHaveValue("");
  });

  it("preserves a draft while the outcome is unknown and retries only after not-dispatched", async () => {
    doubles.control.mockResolvedValueOnce(undefined);
    const { input, rerender } = renderComposer();
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => {});
    fireEvent.keyDown(input, { key: "Enter" });
    expect(doubles.control).toHaveBeenCalledTimes(1);
    expect(input).toHaveValue("Draft message");
    expect(input).toBeDisabled();
    doubles.session.notice = "notDispatched";
    rerender(<SessionComposer />);
    expect(input).toBeEnabled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(doubles.control).toHaveBeenCalledTimes(2));
  });

  it("does not let a previous session's response clear a newer pending draft", async () => {
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    doubles.control.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { input, rerender } = renderComposer();
    fireEvent.keyDown(input, { key: "Enter" });
    doubles.session.selected = "second-session";
    rerender(<SessionComposer />);
    fireEvent.change(input, { target: { value: "New session draft" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(doubles.control).toHaveBeenCalledTimes(2);
    await act(async () => first.resolve(true));
    expect(input).toBeDisabled();
    expect(input).toHaveValue("New session draft");
    await act(async () => second.resolve(true));
    expect(input).toBeEnabled();
    expect(input).toHaveValue("");
  });

  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "shows the visible shortcut instruction in %s",
    (locale) => {
      doubles.session.locale = locale;
      const { input } = renderComposer();
      const hint = screen.getByText(composerLayoutCopy[locale].sendShortcut);
      expect(hint).toBeVisible();
      expect(input).toHaveAttribute("aria-describedby", hint.id);
    },
  );
});
