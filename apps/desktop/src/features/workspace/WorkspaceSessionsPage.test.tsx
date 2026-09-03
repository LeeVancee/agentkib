// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { initializeI18n } from "@/core/i18n";
import type { ConversationSessionSummary, WorkspaceSummary } from "@/core/types";
import { WorkspaceSessionsPage } from "./WorkspaceSessionsPage";

vi.mock("@/core/api", () => ({
  api: {
    workspaceSessions: vi.fn(),
    workspaceSessionStatus: vi.fn(),
    refreshWorkspaceSessions: vi.fn(),
    sessionEvents: vi.fn(),
  },
}));
vi.mock("@/features/agents/AgentIcon", () => ({
  AgentIcon: () => <span data-testid="agent-icon" />,
}));

const workspace = { id: "workspace", name: "Workspace" } as WorkspaceSummary;
const cachedSession = {
  id: "cached-session",
  workspace_id: workspace.id,
  agent: "codex",
  title: "Cached continuation",
  archived: false,
  sidechain: false,
  availability: "readable",
  message_count: null,
} as ConversationSessionSummary;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("WorkspaceSessionsPage", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.workspaceSessions).mockResolvedValue([cachedSession]);
    vi.mocked(api.workspaceSessionStatus).mockResolvedValue([]);
    vi.mocked(api.refreshWorkspaceSessions).mockResolvedValue([cachedSession]);
    vi.mocked(api.sessionEvents).mockResolvedValue({ events: [], warnings: [] });
  });
  afterEach(cleanup);

  it("shows cached sessions before a non-forced background refresh", async () => {
    const background = deferred<ConversationSessionSummary[]>();
    vi.mocked(api.refreshWorkspaceSessions).mockReturnValueOnce(background.promise);

    render(
      <WorkspaceSessionsPage
        workspace={workspace}
        enabled
        targetAgents={["claude-code"]}
        onRuntimeChanged={vi.fn()}
        onHandoffPlanned={vi.fn()}
        onMcpConnectionPlanned={vi.fn()}
      />,
    );

    expect((await screen.findAllByText("Cached continuation")).length).toBeGreaterThan(0);
    expect(api.refreshWorkspaceSessions).toHaveBeenCalledWith(workspace.id, false);

    background.resolve([cachedSession]);
    await waitFor(() =>
      expect((screen.getByLabelText("Refresh sessions") as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it("only uses a forced scan for manual refresh", async () => {
    vi.mocked(api.refreshWorkspaceSessions).mockResolvedValue([cachedSession]);
    render(
      <WorkspaceSessionsPage
        workspace={workspace}
        enabled
        targetAgents={["claude-code"]}
        onRuntimeChanged={vi.fn()}
        onHandoffPlanned={vi.fn()}
        onMcpConnectionPlanned={vi.fn()}
      />,
    );
    const refresh = await screen.findByLabelText("Refresh sessions");
    await waitFor(() => expect((refresh as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(refresh);

    await waitFor(() =>
      expect(api.refreshWorkspaceSessions).toHaveBeenLastCalledWith(workspace.id, true),
    );
  });

  it("does not expose internal context wrappers as titles", async () => {
    vi.mocked(api.workspaceSessions).mockResolvedValue([
      { ...cachedSession, title: "<path>SKILL.md</path><content>internal" },
    ]);
    vi.mocked(api.refreshWorkspaceSessions).mockResolvedValue([
      { ...cachedSession, title: "<path>SKILL.md</path><content>internal" },
    ]);

    render(
      <WorkspaceSessionsPage
        workspace={workspace}
        enabled
        targetAgents={["claude-code"]}
        onRuntimeChanged={vi.fn()}
        onHandoffPlanned={vi.fn()}
        onMcpConnectionPlanned={vi.fn()}
      />,
    );

    expect((await screen.findAllByText("Untitled session")).length).toBeGreaterThan(0);
    expect(screen.queryByText(/SKILL\.md/)).toBeNull();
  });

  it("opens the session selected from the home page and consumes the route target", async () => {
    const selected = { ...cachedSession, id: "selected-session", title: "Selected from home" };
    vi.mocked(api.workspaceSessions).mockResolvedValue([cachedSession, selected]);
    vi.mocked(api.refreshWorkspaceSessions).mockResolvedValue([cachedSession, selected]);
    const onInitialSessionConsumed = vi.fn();

    render(
      <WorkspaceSessionsPage
        workspace={workspace}
        enabled
        initialSessionId={selected.id}
        onInitialSessionConsumed={onInitialSessionConsumed}
        targetAgents={["claude-code"]}
        onRuntimeChanged={vi.fn()}
        onHandoffPlanned={vi.fn()}
        onMcpConnectionPlanned={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.sessionEvents).toHaveBeenCalledWith(selected.id));
    expect(onInitialSessionConsumed).toHaveBeenCalledTimes(1);
  });
});
