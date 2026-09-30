// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { ClaudeSessionPanel } from "./ClaudeSessionPanel";
import type { Live } from "../../../../../packages/web-client/src/index";
vi.mock("@/core/api", () => ({ api: { claudeRequest: vi.fn() } }));
vi.mock("@/core/useI18n", () => ({ useI18n: () => ({ locale }) }));
vi.mock("@/components/MarkdownContent", () => ({
  MarkdownContent: ({ content }: { content: string }) => <p>{content}</p>,
}));
let live: Live;
let locale = "en-US";
let polling: (() => void)[];
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
beforeEach(() => {
  localStorage.clear();
  locale = "en-US";
  polling = [];
  vi.spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => {
    polling.push(callback);
    return 1;
  }) as typeof setInterval);
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
            features: { attachments: { available: true }, files: { available: true } },
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
  });
  it("opens files from the session panel and clears them when host access is lost", async () => {
    mount();
    await screen.findByText("Synthetic history");
    expect(screen.getByRole("combobox", { name: "Session" })).toHaveTextContent(
      "Synthetic session",
    );
    expect(calls("files")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Files and artifacts" }));
    await screen.findByRole("button", { name: "result.txt" });
    expect(calls("files")).toEqual([[{ operation: "files", sessionId: "session" }]]);
    const original = vi.mocked(api.claudeRequest).getMockImplementation()!;
    vi.mocked(api.claudeRequest).mockImplementation((value) =>
      value.operation === "live" ? Promise.reject(new Error("host_offline")) : original(value),
    );
    await act(async () => polling.forEach((poll) => poll()));
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
    fireEvent.click(screen.getByRole("button", { name: "Prepare handoff" }));
    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Hand over to AgentKib" }));
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
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "only once" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("lost_response");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    view.unmount();
    mount();
    await screen.findByText("Synthetic history");
    await act(async () => polling.forEach((poll) => poll()));
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
    await screen.findByRole("button", { name: "Allow" });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(calls("approve")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Review approval" }));
    live = { ...live, revision: 2, approvals: [] };
    await act(async () => polling.forEach((poll) => poll()));
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
      const blue = await screen.findByRole("checkbox", { name: "Blue" });
      fireEvent.click(blue);
      const custom = screen.getByLabelText("Choose a color Custom answer");
      fireEvent.change(custom, { target: { value: "Other color" } });
      if (multiSelect) expect(blue).toBeChecked();
      else expect(blue).not.toBeChecked();
      fireEvent.click(screen.getByRole("checkbox", { name: "Green" }));
      expect(custom).toHaveValue(multiSelect ? "Other color" : "");
      const submit = screen.getByRole("button", { name: "Submit answers" });
      expect(submit).toBeEnabled();
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
    fireEvent.change(screen.getByLabelText("Add images or files"), { target: { files: [file] } });
    await screen.findByText("fixture.txt");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
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
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "first" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(replies).toHaveLength(1));
  admitted = String(calls("send")[0][0].requestId);
  first.unmount();
  mount();
  await screen.findByText("Synthetic history");
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "second" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(replies).toHaveLength(2));
  const newer = String(calls("send")[1][0].requestId);
  await act(async () => replies[0]({ accepted: true, sessionId: "session" }));
  expect(
    JSON.parse(localStorage.getItem("agentkib:claude-owner-pending:v1:workspace")!).requestId,
  ).toBe(newer);
  await act(async () => replies[1]({ accepted: true, sessionId: "session" }));
});
