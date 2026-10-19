// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestedConversationPanel } from "./session-view-store";
import { DesktopConversationPane } from "./DesktopConversationPane";

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  refresh: vi.fn(),
  creating: vi.fn(),
  reveal: vi.fn(),
  revision: 0,
  requestedPanel: undefined as RequestedConversationPanel | undefined,
  consumePanel: vi.fn(),
  selected: undefined as { id: string; indexedSessionIds?: string[] } | undefined,
}));
vi.mock("@/core/useI18n", () => ({
  useI18n: () => ({ locale: "en-US", tr: (key: string) => key, localizeMessage: String }),
}));
vi.mock("@/core/conversation-bridge", () => ({ createDesktopConversationClient: () => ({}) }));
vi.mock("./SessionHubContext", () => ({
  useSessionHub: () => ({
    select: mocks.select,
    selected: mocks.selected,
    conversationRefreshRevision: mocks.revision,
  }),
}));
vi.mock("./conversation-catalog", () => ({ refreshConversationCatalog: mocks.refresh }));
vi.mock("./session-view-store", () => ({
  useSessionViewStore: Object.assign(
    (selector: (state: { requestedPanel?: RequestedConversationPanel }) => unknown) =>
      selector({ requestedPanel: mocks.requestedPanel }),
    {
      getState: () => ({
        revealSession: mocks.reveal,
        setCreatingConversation: mocks.creating,
        consumePanel: mocks.consumePanel,
      }),
    },
  ),
}));
vi.mock("./conversation/conversation", () => ({
  EmbeddedConversation: ({
    onSessionChange,
    onCreateClosed,
    refreshRevision,
    initialPanel,
    onInitialPanelConsumed,
  }: {
    onSessionChange: (id?: string) => void;
    onCreateClosed: () => void;
    refreshRevision?: number;
    initialPanel?: string;
    onInitialPanelConsumed?: () => void;
  }) => (
    <>
      <button onClick={() => onSessionChange("fork")}>Open fork</button>
      <button onClick={() => onSessionChange(undefined)}>Clear selection</button>
      <button onClick={onCreateClosed}>Cancel creation</button>
      <output>{refreshRevision}</output>
      {initialPanel && <button onClick={onInitialPanelConsumed}>{initialPanel}</button>}
    </>
  ),
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.revision = 0;
  mocks.requestedPanel = undefined;
  mocks.selected = undefined;
});
afterEach(cleanup);

describe("desktop conversation navigation", () => {
  it("forwards explicit toolbar refreshes to the mounted conversation", async () => {
    mocks.revision = 2;
    const view = render(<DesktopConversationPane sessionId="original" />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("2"));
    mocks.revision = 3;
    view.rerender(<DesktopConversationPane sessionId="original" />);
    expect(screen.getByRole("status").textContent).toBe("3");
  });
  it("does not steal a newer selection when a fork catalog refresh resolves late", async () => {
    let resolve!: (sessions: { id: string }[]) => void;
    mocks.refresh.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const view = render(<DesktopConversationPane sessionId="original" />);
    fireEvent.click(await screen.findByText("Open fork"));
    view.rerender(<DesktopConversationPane sessionId="new-selection" />);
    await act(async () => {
      resolve([{ id: "fork" }]);
    });
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.reveal).not.toHaveBeenCalled();
  });

  it("reveals a successfully created session and lets cancellation leave creation mode", async () => {
    mocks.refresh.mockResolvedValue([{ id: "fork" }]);
    render(<DesktopConversationPane create />);
    fireEvent.click(await screen.findByText("Open fork"));
    await waitFor(() => expect(mocks.select).toHaveBeenCalledWith("fork"));
    expect(mocks.reveal).toHaveBeenCalledWith({ id: "fork" });
    fireEvent.click(screen.getByText("Cancel creation"));
    expect(mocks.creating).toHaveBeenLastCalledWith(false);
  });

  it("clears the desktop selection and invalidates a pending fork navigation", async () => {
    let resolve!: (sessions: { id: string }[]) => void;
    mocks.refresh.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    render(<DesktopConversationPane sessionId="original" />);
    fireEvent.click(await screen.findByText("Open fork"));
    fireEvent.click(screen.getByText("Clear selection"));
    expect(mocks.select).toHaveBeenCalledWith();
    await act(async () => {
      resolve([{ id: "fork" }]);
    });
    expect(mocks.select).toHaveBeenCalledTimes(1);
    expect(mocks.reveal).not.toHaveBeenCalled();
  });
  it("retains a queued terminal destination until the matching lazy conversation consumes it", async () => {
    const request = { sessionId: "target", panel: "terminal" as const };
    mocks.requestedPanel = request;
    const view = render(<DesktopConversationPane sessionId="other" />);
    await screen.findByText("Open fork");
    expect(screen.queryByRole("button", { name: "terminal" })).not.toBeInTheDocument();
    expect(mocks.consumePanel).not.toHaveBeenCalled();
    view.rerender(<DesktopConversationPane sessionId="target" />);
    fireEvent.click(await screen.findByRole("button", { name: "terminal" }));
    expect(mocks.consumePanel).toHaveBeenCalledExactlyOnceWith(request);
  });
  it("recognizes an indexed alias after the hub selects its canonical session", async () => {
    const request = { sessionId: "indexed", panel: "terminal" as const };
    mocks.requestedPanel = request;
    mocks.selected = { id: "managed", indexedSessionIds: ["indexed"] };
    render(<DesktopConversationPane sessionId="managed" />);
    fireEvent.click(await screen.findByRole("button", { name: "terminal" }));
    expect(mocks.consumePanel).toHaveBeenCalledExactlyOnceWith(request);
  });
});
