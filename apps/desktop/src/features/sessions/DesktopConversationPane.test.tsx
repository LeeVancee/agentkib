// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopConversationPane } from "./DesktopConversationPane";

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  refresh: vi.fn(),
  creating: vi.fn(),
  reveal: vi.fn(),
  revision: 0,
}));
vi.mock("@/core/useI18n", () => ({
  useI18n: () => ({ locale: "en-US", tr: (key: string) => key, localizeMessage: String }),
}));
vi.mock("@/core/conversation-bridge", () => ({ createDesktopConversationClient: () => ({}) }));
vi.mock("./SessionHubContext", () => ({
  useSessionHub: () => ({
    select: mocks.select,
    conversationRefreshRevision: mocks.revision,
  }),
}));
vi.mock("./conversation-catalog", () => ({ refreshConversationCatalog: mocks.refresh }));
vi.mock("./session-view-store", () => ({
  useSessionViewStore: {
    getState: () => ({ revealSession: mocks.reveal, setCreatingConversation: mocks.creating }),
  },
}));
vi.mock("@agentkib/conversation-ui/conversation", () => ({
  EmbeddedConversation: ({
    onSessionChange,
    onCreateClosed,
    refreshRevision,
  }: {
    onSessionChange: (id?: string) => void;
    onCreateClosed: () => void;
    refreshRevision?: number;
  }) => (
    <>
      <button onClick={() => onSessionChange("fork")}>Open fork</button>
      <button onClick={() => onSessionChange(undefined)}>Clear selection</button>
      <button onClick={onCreateClosed}>Cancel creation</button>
      <output>{refreshRevision}</output>
    </>
  ),
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.revision = 0;
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
});
