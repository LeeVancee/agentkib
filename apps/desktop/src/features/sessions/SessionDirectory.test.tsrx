/** @jsxImportSource octane */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@octanejs/testing-library";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n, tr } from "@/core/i18n";
import type { ConversationSessionSummary, WorkspaceSummary } from "@/core/types";
import { SessionDirectory } from "./SessionDirectory";
import { useSessionHub } from "./SessionHubContext";
import { filterSessions } from "./session-catalog";
import { useSessionViewStore } from "./session-view-store";

vi.mock("./SessionHubContext", () => ({ useSessionHub: vi.fn() }));
vi.mock("@/features/agents/AgentIcon", () => ({
  AgentIcon: ({ agent }: { agent: string }) => <span aria-hidden="true">{agent} icon</span>,
}));

const workspaces = [
  { id: "workspace-a", name: "Design kit", path: "/projects/first/design-kit" },
  { id: "workspace-b", name: "Design kit", path: "/projects/second/design-kit" },
] as WorkspaceSummary[];
const first: ConversationSessionSummary = {
  id: "first",
  workspace_id: "workspace-a",
  agent: "codex",
  title: "Check sidebar selection",
  availability: "readable",
  archived: false,
  sidechain: false,
};
const second: ConversationSessionSummary = {
  ...first,
  id: "second",
  workspace_id: "workspace-b",
  agent: "claude-code",
  title: "Inspect token layout",
};
const archived = { ...first, id: "archived", title: "Previous icon review", archived: true };
const metadata = {
  ...second,
  id: "metadata",
  title: "Missing transcript",
  availability: "metadata-only" as const,
};
let hub: ReturnType<typeof useSessionHub>;

function workspaceHeading(workspace: WorkspaceSummary) {
  return screen.getByTitle(`${workspace.name}\n${workspace.path}`, {
    normalizer: (value) => value,
  });
}

describe("SessionDirectory", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionViewStore.setState({
      agent: "all",
      host: "all",
      filter: "current",
      showAuxiliary: false,
      collapsed: {},
      scrollTop: 0,
    });
    hub = {
      remoteHosts: [],
      remoteErrors: {},
      localEnabled: true,
      workspaces,
      sessions: [first, second, archived, metadata],
      filtered: [],
      selected: first,
      selectedWorkspace: workspaces[0],
      statuses: [],
      errors: {},
      loading: false,
      refreshing: false,
      ready: true,
      historyRevision: 0,
      runtimeReady: true,
      enabled: true,
      workspacesLoading: false,
      workspacesError: "",
      select: vi.fn(),
      refresh: vi.fn().mockResolvedValue(undefined),
      retryWorkspaces: vi.fn(),
    };
    vi.mocked(useSessionHub).mockImplementation(() => ({
      ...hub,
      filtered: filterSessions(hub.sessions, hub.workspaces, {
        ...useSessionViewStore.getState(),
        query: "",
      }),
    }));
  });
  afterEach(cleanup);

  it("keeps same-named workspace groups separate and exposes paths and the current session", () => {
    render(<SessionDirectory />);
    expect(screen.getAllByRole("button", { name: /Design kit/ })).toHaveLength(2);
    for (const workspace of workspaces) {
      expect(workspaceHeading(workspace)).toHaveAttribute("aria-expanded", "true");
    }
    const current = screen.getByRole("button", { name: /Check sidebar selection/ });
    expect(current).toHaveAttribute("aria-current", "page");
    expect(current).toHaveTextContent("codex icon");
    expect(current).not.toHaveTextContent("Codex ·");
    expect(current.querySelector("small")).toBeNull();
    expect(current.getAttribute("title")).toContain("Codex ·");
    expect(current.getAttribute("title")).toContain(workspaces[0].path);
    const other = screen.getByRole("button", { name: /Inspect token layout/ });
    expect(other).not.toHaveAttribute("aria-current");
    fireEvent.click(other);
    expect(hub.select).toHaveBeenCalledWith(second.id);
  });

  it("keeps search and filter fields out of the directory and exposes filters in its menu", async () => {
    const user = userEvent.setup();
    const onMenuOpenChange = vi.fn();
    render(<SessionDirectory onMenuOpenChange={onMenuOpenChange} />);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByText("Local history")).toBeNull();
    expect(screen.getByRole("button", { name: /Check sidebar selection/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Inspect token layout/ })).toBeTruthy();
    screen.getByRole("button", { name: tr("sessions.directoryOptions") }).focus();
    await user.keyboard("{ArrowDown}");
    expect(onMenuOpenChange).toHaveBeenLastCalledWith(true, expect.anything());
    expect(screen.getByRole("menu").parentElement).toHaveClass("z-80");
    (await screen.findByRole("menuitem", { name: "Agent filter" })).focus();
    await user.keyboard("{ArrowRight}");
    expect(await screen.findByRole("menuitemradio", { name: "All agents" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(
      screen.getAllByRole("menu").every((menu) => menu.parentElement?.classList.contains("z-80")),
    ).toBe(true);
    screen.getByRole("menuitemradio", { name: "Claude Code" }).focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("button", { name: /Check sidebar selection/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Inspect token layout/ })).toBeTruthy();
    screen.getByRole("button", { name: tr("sessions.directoryOptions") }).focus();
    await user.keyboard("{ArrowDown}");
    (await screen.findByRole("menuitem", { name: "Session history" })).focus();
    await user.keyboard("{ArrowRight}");
    (await screen.findByRole("menuitemradio", { name: "Metadata only" })).focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("button", { name: /Inspect token layout/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Missing transcript/ })).toBeTruthy();
    screen.getByRole("button", { name: tr("sessions.directoryOptions") }).focus();
    await user.keyboard("{ArrowDown}");
    (await screen.findByRole("menuitem", { name: "Reset filters" })).focus();
    await user.keyboard("{Enter}");
    expect(onMenuOpenChange).toHaveBeenLastCalledWith(false, expect.anything());
    expect(useSessionViewStore.getState().agent).toBe("all");
    expect(useSessionViewStore.getState().filter).toBe("current");
    expect(screen.getByRole("button", { name: /Check sidebar selection/ })).toBeTruthy();
  });

  it("shows non-default filter chips and clears them independently", async () => {
    useSessionViewStore.setState({ agent: "claude-code", filter: "metadata" });
    const user = userEvent.setup();
    render(<SessionDirectory />);
    await user.click(
      screen.getByRole("button", { name: `${tr("sessions.clearAgentFilter")}: Claude Code` }),
    );
    expect(useSessionViewStore.getState().agent).toBe("all");
    expect(useSessionViewStore.getState().filter).toBe("metadata");
    expect(screen.getByRole("button", { name: /Missing transcript/ })).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: `${tr("sessions.clearRecordFilter")}: Metadata only` }),
    );
    expect(useSessionViewStore.getState().filter).toBe("current");
    expect(screen.queryByRole("button", { name: /Missing transcript/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Check sidebar selection/ })).toBeTruthy();
  });

  it("collapses one workspace independently and preserves expansion across remounts", () => {
    const { unmount } = render(<SessionDirectory />);
    const heading = workspaceHeading(workspaces[0]);
    expect(heading.querySelector(".lucide-folder-open")).not.toBeNull();
    fireEvent.click(heading);
    expect(heading).toHaveAttribute("aria-expanded", "false");
    expect(heading.querySelector(".lucide-folder")).not.toBeNull();
    expect(heading.querySelector(".lucide-folder-open")).toBeNull();
    expect(screen.queryByRole("button", { name: /Check sidebar selection/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Inspect token layout/ })).toBeTruthy();
    expect(useSessionViewStore.getState().collapsed).toEqual({ "workspace-a": true });
    unmount();
    render(<SessionDirectory />);
    expect(workspaceHeading(workspaces[0])).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(workspaceHeading(workspaces[0]));
    expect(workspaceHeading(workspaces[0]).querySelector(".lucide-folder-open")).not.toBeNull();
    expect(screen.getByRole("button", { name: /Check sidebar selection/ })).toBeTruthy();
  });

  it("supports keyboard collapse and rapid reversal without losing the selected session", async () => {
    const user = userEvent.setup();
    render(<SessionDirectory />);
    const heading = workspaceHeading(workspaces[0]);
    const panelId = heading.getAttribute("aria-controls");
    expect(panelId).toBeTruthy();
    heading.focus();
    await user.keyboard("{Enter}");
    expect(heading).toHaveAttribute("aria-expanded", "false");
    expect(heading).toHaveFocus();
    expect(screen.queryByRole("button", { name: /Check sidebar selection/ })).toBeNull();
    const closingPanel = document.getElementById(panelId!);
    if (closingPanel) {
      expect(closingPanel).toHaveAttribute("inert");
      expect(closingPanel).toHaveAttribute("aria-hidden", "true");
    }
    fireEvent.click(heading);
    fireEvent.click(heading);
    fireEvent.click(heading);
    expect(heading).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById(panelId!)).not.toHaveAttribute("inert");
    expect(screen.getByRole("button", { name: /Check sidebar selection/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(hub.select).not.toHaveBeenCalled();
  });

  it("restores the directory scroll position and records subsequent scrolling", () => {
    useSessionViewStore.setState({ scrollTop: 180 });
    const { container, unmount } = render(<SessionDirectory />);
    const tree = container.querySelector<HTMLDivElement>(".session-directory-tree")!;
    expect(tree.scrollTop).toBe(180);
    fireEvent.scroll(tree, { target: { scrollTop: 240 } });
    expect(useSessionViewStore.getState().scrollTop).toBe(240);
    unmount();
    const remount = render(<SessionDirectory />);
    expect(
      remount.container.querySelector<HTMLDivElement>(".session-directory-tree")?.scrollTop,
    ).toBe(240);
  });

  it("disables filtering when indexing is disabled", () => {
    hub = { ...hub, enabled: false, sessions: [], selected: undefined };
    render(<SessionDirectory />);
    expect(screen.getByRole("button", { name: tr("sessions.directoryOptions") })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Refresh history" })).toBeNull();
    expect(hub.refresh).not.toHaveBeenCalled();
    expect(screen.queryByText("No session history found")).toBeNull();
  });

  it("does not show a directory refresh action", () => {
    const { rerender } = render(<SessionDirectory />);
    expect(screen.queryByRole("button", { name: "Refresh history" })).toBeNull();
    hub = { ...hub, refreshing: true };
    rerender(<SessionDirectory />);
    expect(screen.queryByRole("button", { name: /Refresh history|Scanning/ })).toBeNull();
    expect(hub.refresh).not.toHaveBeenCalled();
  });
});
