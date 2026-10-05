import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationEvent } from "@agentkib/web-client";
import { dictionaries } from "../../i18n";
import { SessionReader } from "./session-reader";
import { useSession } from "./session-context";
import { webLayoutCopy } from "./web-layout-copy";

vi.mock("./session-context", () => ({ useSession: vi.fn() }));
vi.mock("./session-operations", () => ({ SessionOperations: () => null }));
vi.mock("./artifact-browser", () => ({ ArtifactBrowser: () => null }));

let state: ReturnType<typeof useSession>;
function message(id: string, content: string): ConversationEvent {
  return { id, content, kind: "agent-message", attachment_count: 0, truncated: false };
}
const latest = webLayoutCopy["zh-CN"].newMessages;

beforeEach(() => {
  state = {
    selected: "first",
    liveContentVersion: 0,
    access: { protocolVersion: 2, experimentalEnabled: false },
    current: { id: "first", agent: "codex" },
    t: dictionaries["zh-CN"],
    locale: "zh-CN",
    page: { events: [message("tail", "First answer")], warnings: [], next_cursor: "older" },
    scroll: { current: null },
    earlier: vi.fn(),
    setModal: vi.fn(),
  } as unknown as ReturnType<typeof useSession>;
  vi.mocked(useSession).mockImplementation(() => state);
});
afterEach(cleanup);

function viewport(height = 1200) {
  const node = state.scroll.current!;
  Object.defineProperties(node, {
    scrollHeight: { value: height, configurable: true },
    clientHeight: { value: 300, configurable: true },
  });
  return node;
}
function moveTo(top: number) {
  const node = viewport();
  node.scrollTop = top;
  fireEvent.scroll(node);
  return node;
}

describe("conversation reading position", () => {
  it("keeps the reading position and offers an accessible jump for an appended reply", () => {
    const view = render(<SessionReader />);
    const node = moveTo(250);
    state = {
      ...state,
      page: { ...state.page!, events: [...state.page!.events, message("new", "New answer")] },
      liveContentVersion: state.liveContentVersion + 1,
    };
    view.rerender(<SessionReader />);
    expect(node.scrollTop).toBe(250);
    const jump = screen.getByRole("button", { name: latest });
    expect(jump.closest('[role="status"]')).not.toBeNull();
    jump.focus();
    expect(jump).toHaveFocus();
    fireEvent.click(jump);
    expect(node.scrollTop).toBe(node.scrollHeight);
    expect(screen.queryByRole("button", { name: latest })).not.toBeInTheDocument();
    state = {
      ...state,
      page: { ...state.page!, events: [...state.page!.events, message("newer", "Next answer")] },
      liveContentVersion: state.liveContentVersion + 1,
    };
    viewport(1500);
    view.rerender(<SessionReader />);
    expect(node.scrollTop).toBe(1500);
  });

  it("does not report earlier pages or replay of the same tail as new messages", () => {
    const view = render(<SessionReader />);
    const node = moveTo(100);
    fireEvent.click(screen.getByRole("button", { name: dictionaries["zh-CN"].earlier }));
    expect(state.earlier).toHaveBeenCalledOnce();
    state = {
      ...state,
      page: {
        ...state.page!,
        events: [message("older", "Old answer"), message("tail", "First answer")],
      },
    };
    view.rerender(<SessionReader />);
    expect(node.scrollTop).toBe(100);
    expect(screen.queryByRole("button", { name: latest })).not.toBeInTheDocument();
  });

  it("notifies once for incremental text and clears the notice near the bottom", () => {
    const view = render(<SessionReader />);
    const node = moveTo(100);
    state = {
      ...state,
      page: { ...state.page!, events: [message("tail", "First answer continues")] },
      liveContentVersion: state.liveContentVersion + 1,
    };
    view.rerender(<SessionReader />);
    expect(screen.getAllByRole("button", { name: latest })).toHaveLength(1);
    expect(node.scrollTop).toBe(100);
    node.scrollTop = 850;
    fireEvent.scroll(node);
    expect(screen.queryByRole("button", { name: latest })).not.toBeInTheDocument();
    viewport(1400);
    state = {
      ...state,
      page: { ...state.page!, events: [message("tail", "First answer continues again")] },
      liveContentVersion: state.liveContentVersion + 1,
    };
    view.rerender(<SessionReader />);
    expect(node.scrollTop).toBe(1400);
  });

  it("notifies for a text delta even when another tool follows that message", () => {
    const tool: ConversationEvent = {
      ...message("tool", ""),
      kind: "tool-summary",
      tool_name: "shell",
    };
    state = { ...state, page: { ...state.page!, events: [...state.page!.events, tool] } };
    const view = render(<SessionReader />);
    const node = moveTo(100);
    state = {
      ...state,
      page: { ...state.page!, events: [message("tail", "First answer continues"), tool] },
      liveContentVersion: state.liveContentVersion + 1,
    };
    view.rerender(<SessionReader />);
    expect(screen.getByRole("button", { name: latest })).toBeVisible();
    expect(node.scrollTop).toBe(100);
  });

  it("handles fallback streaming and resets following when switching conversations", () => {
    const view = render(<SessionReader />);
    const node = moveTo(100);
    state = {
      ...state,
      live: {
        sessionId: "first",
        status: "running",
        revision: 1,
        sendEnabled: false,
        approvals: [],
        streamText: "Live answer",
      },
      liveContentVersion: state.liveContentVersion + 1,
    };
    view.rerender(<SessionReader />);
    expect(screen.getByRole("button", { name: latest })).toBeVisible();
    expect(node.scrollTop).toBe(100);
    state = {
      ...state,
      selected: "second",
      live: undefined,
      page: { events: [message("second-tail", "Another conversation")], warnings: [] },
    };
    view.rerender(<SessionReader />);
    expect(screen.queryByRole("button", { name: latest })).not.toBeInTheDocument();
    expect(node.scrollTop).toBe(1200);
  });
});
