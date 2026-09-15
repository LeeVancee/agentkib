/** @jsxImportSource octane */

// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "octane";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@octanejs/testing-library";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Home } from "@octanejs/lucide";
import { initializeI18n } from "@/core/i18n";
import { useAppStore } from "@/stores/app-store";
import type { ConversationSessionSummary, RuntimeInfo, WorkspaceSummary } from "@/core/types";
import { useSearchSessions } from "./useSearchSessions";
import { useSearchAssets } from "./useSearchAssets";
import { GlobalSearchDialog } from "./GlobalSearchDialog";
import { groupCatalogAssets } from "@/features/catalog/catalog";
import { useSessionViewStore } from "@/features/sessions/session-view-store";
import { useRemoteStore } from "@/features/remote/remote-store";
import { useRemoteCatalogStore, remoteRecordId } from "@/features/remote/remote-catalog-store";

vi.mock("./useSearchSessions", () => ({ useSearchSessions: vi.fn() }));
vi.mock("./useSearchAssets", () => ({ SEARCH_ASSET_LIMIT: 500, useSearchAssets: vi.fn() }));
vi.mock("@/features/agents/AgentIcon", () => ({ AgentIcon: () => <span /> }));
const workspace = { id: "one", name: "Same project", path: "/projects/one" } as WorkspaceSummary;
const session: ConversationSessionSummary = {
  id: "session-one",
  workspace_id: "one",
  agent: "codex",
  title: "Review search",
  availability: "readable",
  archived: true,
  sidechain: false,
};
const props = () => ({
  open: true,
  onOpenChange: vi.fn(),
  entries: [{ id: "home" as const, label: "nav.home", icon: Home }],
  workspaces: [workspace, { ...workspace, id: "two", path: "/projects/two" }],
  onNavigate: vi.fn(),
  onOpenWorkspace: vi.fn(),
  onOpenSession: vi.fn(),
  onSessionSettings: vi.fn(),
});

describe("GlobalSearchDialog", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionViewStore.getState().resetFilters();
    useRemoteStore.setState({ snapshot: null });
    useRemoteCatalogStore.setState({ catalogs: {}, errors: {}, revision: 0 });
    useAppStore.setState({ runtime: { session_index_enabled: true } as RuntimeInfo });
    vi.mocked(useSearchSessions).mockReturnValue({
      sessions: [session],
      loading: false,
      errors: {},
      retry: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(useSearchAssets).mockReturnValue({
      assets: [],
      loading: false,
      error: "",
      limited: false,
      retry: vi.fn(),
    });
  });
  afterEach(cleanup);

  it("searches loaded remote records with host provenance while local indexing is disabled", async () => {
    useAppStore.setState({ runtime: { session_index_enabled: false } as RuntimeInfo });
    vi.mocked(useSearchSessions).mockReturnValue({
      sessions: [],
      errors: {},
      loading: false,
      retry: vi.fn(),
    });
    useRemoteStore.setState({
      snapshot: {
        local: { id: "self", name: "Desktop", enabled: false, address: null },
        interfaces: [],
        discovered: [],
        pending: [],
        authorized: [],
        pairing_code: null,
        pairing_expires_at: null,
        connections: [
          {
            id: "host",
            name: "Laptop",
            address: "192.168.1.5:42987",
            status: "offline",
            last_seen: 1,
            error: null,
          },
        ],
      },
    });
    useRemoteCatalogStore.setState({
      catalogs: {
        host: { workspaces: [workspace], sessions: [session], syncedAt: "2026-09-07T00:00:00Z" },
      },
    });
    const callbacks = props();
    render(<GlobalSearchDialog {...callbacks} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "Review search" } });
    const result = await screen.findByRole("option", { name: /Review search.*Laptop/ });
    fireEvent.click(result);
    expect(callbacks.onOpenSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: remoteRecordId("host", session.id),
        remote: expect.objectContaining({ host_id: "host" }),
      }),
    );
    expect(useSearchSessions).toHaveBeenLastCalledWith(callbacks.workspaces, false);
  });

  it("groups global results, retains same-name workspace paths and opens archived sessions via keyboard", async () => {
    const callbacks = props();
    render(<GlobalSearchDialog {...callbacks} />);
    expect(await screen.findByRole("option", { name: /Review search/ })).toBeVisible();
    expect(screen.getAllByRole("option", { name: /Same project \/projects\// })).toHaveLength(2);
    const search = screen.getByRole("combobox");
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /Same project \/projects\/one/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.keyDown(search, { key: "ArrowUp" });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(callbacks.onOpenSession).toHaveBeenCalledWith(session);
    expect(callbacks.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shares auxiliary source visibility with the session directory", async () => {
    const auxiliary: ConversationSessionSummary = {
      ...session,
      id: "auxiliary-session",
      title: "Auxiliary result",
      origin: "auxiliary",
      spawned_by_session_id: session.id,
    };
    vi.mocked(useSearchSessions).mockReturnValue({
      sessions: [session, auxiliary],
      loading: false,
      errors: {},
      retry: vi.fn().mockResolvedValue(undefined),
    });
    render(<GlobalSearchDialog {...props()} />);
    expect(screen.queryByRole("option", { name: /Auxiliary result/ })).toBeNull();
    act(() => useSessionViewStore.getState().setShowAuxiliary(true));
    expect(await screen.findByRole("option", { name: /Auxiliary result/ })).toBeVisible();
  });

  it("does not read sessions with indexing disabled and offers settings while other results work", async () => {
    useAppStore.setState({ runtime: { session_index_enabled: false } as RuntimeInfo });
    vi.mocked(useSearchSessions).mockReturnValue({
      sessions: [],
      loading: false,
      errors: {},
      retry: vi.fn().mockResolvedValue(undefined),
    });
    const callbacks = props();
    render(<GlobalSearchDialog {...callbacks} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open settings" }));
    expect(useSearchSessions).toHaveBeenLastCalledWith(callbacks.workspaces, false);
    expect(callbacks.onSessionSettings).toHaveBeenCalledOnce();
  });

  it("opens metadata-only asset details, returns to the query, and can open its workspace", async () => {
    const assets = groupCatalogAssets([
      {
        id: "skill",
        scope: "workspace",
        workspace_id: "one",
        kind: "skill",
        name: "Review skill",
        path: "/projects/one/skills/review",
        size: 1024,
        summary: "Read-only metadata",
        agent: "codex",
      },
    ]);
    vi.mocked(useSearchAssets).mockReturnValue({
      assets,
      loading: false,
      error: "",
      limited: true,
      retry: vi.fn(),
    });
    const callbacks = props();
    render(<GlobalSearchDialog {...callbacks} />);
    fireEvent.change(await screen.findByRole("combobox"), { target: { value: "Review" } });
    expect(screen.getByText(/Showing up to 500/)).toBeVisible();
    fireEvent.click(screen.getByRole("option", { name: /Review skill/ }));
    expect(screen.getByText("Read-only metadata")).toBeVisible();
    expect(screen.queryByRole("combobox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to results" }));
    expect(screen.getByRole("combobox")).toHaveValue("Review");
    fireEvent.click(screen.getByRole("option", { name: /Review skill/ }));
    fireEvent.click(screen.getByRole("button", { name: "Open workspace" }));
    expect(callbacks.onOpenWorkspace).toHaveBeenCalledWith(workspace);
  });

  it("shows partial errors alongside usable results and resets the query after any close", async () => {
    const retry = vi.fn().mockResolvedValue(undefined);
    vi.mocked(useSearchSessions).mockReturnValue({
      sessions: [session],
      loading: false,
      errors: { two: "Unavailable" },
      retry,
    });
    const callbacks = props();
    const view = render(<GlobalSearchDialog {...callbacks} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "Review" } });
    view.rerender(<GlobalSearchDialog {...callbacks} open={false} />);
    view.rerender(<GlobalSearchDialog {...callbacks} />);
    expect(await screen.findByRole("combobox")).toHaveValue("");
  });

  it("progressively reveals sessions without excluding later matches", async () => {
    vi.mocked(useSearchSessions).mockReturnValue({
      sessions: Array.from({ length: 25 }, (_, i) => ({
        ...session,
        id: String(i),
        title: `Session ${i}`,
      })),
      loading: false,
      errors: {},
      retry: vi.fn().mockResolvedValue(undefined),
    });
    render(<GlobalSearchDialog {...props()} />);
    expect(
      (await screen.findAllByRole("option")).filter((node) =>
        node.textContent?.startsWith("Session "),
      ),
    ).toHaveLength(20);
    fireEvent.click(screen.getByRole("button", { name: /More Sessions/ }));
    expect(
      screen.getAllByRole("option").filter((node) => node.textContent?.startsWith("Session ")),
    ).toHaveLength(25);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "Session 24" } });
    expect(screen.getByRole("option", { name: /Session 24/ })).toBeVisible();
  });

  it.each([false, true])(
    "restores focus to search or the sidebar toggle on Escape (hidden original: %s)",
    async (hideOriginal) => {
      const callbacks = props();
      function Harness() {
        const [open, setOpen] = React.useState(false);
        return (
          <>
            <button data-global-search-trigger onClick={() => setOpen(true)}>
              Search trigger
            </button>
            <button className="app-sidebar-collapse-button">Expand sidebar</button>
            <GlobalSearchDialog {...callbacks} open={open} onOpenChange={setOpen} />
          </>
        );
      }
      const rect = vi
        .spyOn(HTMLElement.prototype, "getClientRects")
        .mockReturnValue([{ left: 0, top: 0, right: 30, bottom: 30 }] as unknown as DOMRectList);
      render(<Harness />);
      const trigger = screen.getByRole("button", { name: "Search trigger" });
      trigger.focus();
      fireEvent.click(trigger);
      const input = await screen.findByRole("combobox");
      expect(screen.getByRole("dialog")).toHaveClass("z-[101]");
      expect(document.querySelector('[data-slot="dialog-overlay"]')).toHaveClass("z-[100]");
      expect(screen.getAllByRole("option").every((option) => option.tabIndex === -1)).toBe(true);
      if (hideOriginal) trigger.style.visibility = "hidden";
      await act(async () => {
        input.focus();
        fireEvent.keyDown(input, { key: "Escape" });
      });
      await waitFor(() =>
        expect(
          hideOriginal ? screen.getByRole("button", { name: "Expand sidebar" }) : trigger,
        ).toHaveFocus(),
      );
      rect.mockRestore();
    },
  );
});

describe("search session reveal", () => {
  it("only clears obstructing filters, expands the target, and preserves other directory state", () => {
    useSessionViewStore.setState({
      agent: "claude-code",
      filter: "current",
      collapsed: { one: true, two: true },
      scrollTop: 120,
    });
    useSessionViewStore.getState().revealSession(session);
    expect(useSessionViewStore.getState()).toMatchObject({
      agent: "all",
      filter: "all",
      collapsed: { one: false, two: true },
      scrollTop: 120,
    });
    useSessionViewStore.setState({ agent: "codex", filter: "archived" });
    useSessionViewStore.getState().revealSession(session);
    expect(useSessionViewStore.getState()).toMatchObject({ agent: "codex", filter: "archived" });
    useSessionViewStore.getState().resetFilters();
  });
});
