/** @jsxImportSource octane */

// @vitest-environment jsdom

import type { ReactNode } from "octane";
import { act, cleanup, renderHook } from "@octanejs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationIndexStatus,
  ConversationSessionSummary,
  RuntimeInfo,
  WorkspaceSummary,
} from "@/core/types";
import { useAppStore } from "@/stores/app-store";
import { api } from "@/core/api";
import { SessionHubProvider, useSessionHub } from "./SessionHubContext";
import { useSessionViewStore } from "./session-view-store";
import { SESSION_REFRESH_EVENT } from "./session-refresh";
import { useRemoteStore } from "@/features/remote/remote-store";
import { useRemoteCatalogStore, remoteRecordId } from "@/features/remote/remote-catalog-store";

const doubles = vi.hoisted(() => ({
  navigate: vi.fn(),
  catalog: vi.fn(),
  search: {} as { sessionId?: string },
  workspaceQuery: {
    data: [] as WorkspaceSummary[],
    isPending: false,
    error: null as Error | null,
    refetch: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@octanejs/tanstack-router", () => ({
  useNavigate: () => doubles.navigate,
  useSearch: () => doubles.search,
}));
vi.mock("@/features/home/home-query", () => ({
  useHomeWorkspaces: () => doubles.workspaceQuery,
}));
vi.mock("./useSessionCatalog", () => ({
  useSessionCatalog: (...args: unknown[]) => doubles.catalog(...args),
}));

const workspace = {
  id: "workspace",
  name: "Project",
  path: "/projects/example",
} as WorkspaceSummary;
const session: ConversationSessionSummary = {
  id: "session",
  workspace_id: workspace.id,
  agent: "codex",
  title: "Review navigation",
  archived: false,
  sidechain: false,
  availability: "readable",
};

function catalogState() {
  return {
    sessions: [] as ConversationSessionSummary[],
    statuses: [] as ConversationIndexStatus[],
    errors: {} as Record<string, string>,
    loading: false,
    refreshing: false,
    ready: true,
    refresh: vi.fn().mockResolvedValue(undefined),
  };
}
function wrapper({ children }: { children: ReactNode }) {
  return <SessionHubProvider>{children}</SessionHubProvider>;
}
function clearedSearch() {
  const navigation = doubles.navigate.mock.calls[0]?.[0] as {
    to: string;
    replace: boolean;
    search: (previous: Record<string, unknown>) => Record<string, unknown>;
  };
  expect(navigation.to).toBe("/sessions");
  expect(navigation.replace).toBe(true);
  return navigation.search({ sessionId: session.id, unrelated: "retained" });
}

describe("SessionHubProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.getState().reset();
    useRemoteStore.setState({ snapshot: null });
    useRemoteCatalogStore.setState({ catalogs: {}, errors: {}, revision: 0 });
    useAppStore.getState().setRuntime({ session_index_enabled: true } as RuntimeInfo);
    useSessionViewStore.getState().resetFilters();
    doubles.search = { sessionId: session.id };
    doubles.workspaceQuery = {
      data: [workspace],
      isPending: false,
      error: null,
      refetch: vi.fn().mockResolvedValue(undefined),
    };
    doubles.catalog.mockReturnValue(catalogState());
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("keeps context available but pauses reads and refresh listeners outside the session route", () => {
    const { result } = renderHook(useSessionHub, {
      wrapper: ({ children }) => <SessionHubProvider active={false}>{children}</SessionHubProvider>,
    });
    expect(result.current.enabled).toBe(false);
    expect(doubles.catalog).toHaveBeenLastCalledWith([workspace], false);
    act(() => window.dispatchEvent(new Event(SESSION_REFRESH_EVENT)));
    expect(doubles.catalog.mock.results[0].value.refresh).not.toHaveBeenCalled();
    expect(doubles.navigate).not.toHaveBeenCalled();
  });

  it("reads and natively refreshes remote history with local indexing disabled and local workspaces pending", async () => {
    useAppStore.getState().setRuntime({ session_index_enabled: false } as RuntimeInfo);
    doubles.workspaceQuery.isPending = true;
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
            status: "online",
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
    doubles.search = { sessionId: remoteRecordId("host", session.id) };
    const { result } = renderHook(useSessionHub, { wrapper });
    expect(result.current.enabled).toBe(true);
    expect(result.current.localEnabled).toBe(false);
    expect(result.current.workspacesLoading).toBe(false);
    expect(result.current.selected?.remote?.host_id).toBe("host");
    expect(result.current.selectedWorkspace?.remote?.host_name).toBe("Laptop");
    expect(doubles.catalog).toHaveBeenLastCalledWith([workspace], false);
    const request = vi.spyOn(api, "remoteRequest").mockResolvedValue({
      workspaces: [workspace],
      sessions: [{ ...session, title: "Updated remotely" }],
    });
    const revision = result.current.historyRevision;
    await act(async () => window.dispatchEvent(new Event(SESSION_REFRESH_EVENT)));
    expect(request).toHaveBeenCalledExactlyOnceWith({ operation: "catalog", id: "host" });
    expect(doubles.catalog.mock.results[0].value.refresh).not.toHaveBeenCalled();
    expect(result.current.selected?.title).toBe("Updated remotely");
    expect(result.current.historyRevision).toBe(revision + 1);
    act(() => useSessionViewStore.getState().setHost("local"));
    expect(result.current.selected).toBeUndefined();
    act(() =>
      useSessionViewStore.getState().revealSession({
        ...session,
        id: remoteRecordId("host", session.id),
        workspace_id: remoteRecordId("host", workspace.id),
        remote: {
          host_id: "host",
          host_name: "Laptop",
          original_id: session.id,
          online: true,
          last_synced_at: "2026-09-07T00:00:00Z",
        },
      }),
    );
    expect(useSessionViewStore.getState().host).toBe("all");
    expect(result.current.selected?.remote?.host_id).toBe("host");
  });

  it("retains a deep link on partial read failure, then selects it when retry recovers", () => {
    const catalog = { ...catalogState(), errors: { [workspace.id]: "Cannot read index" } };
    doubles.catalog.mockReturnValue(catalog);
    const { result, rerender } = renderHook(() => useSessionHub(), { wrapper });
    expect(result.current.selected).toBeUndefined();
    expect(doubles.navigate).not.toHaveBeenCalled();

    // A manual retry clears the old errors before the fresh records arrive.
    doubles.catalog.mockReturnValue({ ...catalogState(), refreshing: true });
    rerender();
    expect(result.current.selected).toBeUndefined();
    expect(doubles.navigate).not.toHaveBeenCalled();

    doubles.catalog.mockReturnValue({ ...catalogState(), sessions: [session] });
    rerender();
    expect(result.current.selected).toEqual(session);
    expect(result.current.selectedWorkspace).toEqual(workspace);
    expect(doubles.navigate).not.toHaveBeenCalled();
  });

  it("clears a known session excluded by filters even if another workspace failed", () => {
    doubles.catalog.mockReturnValue({
      ...catalogState(),
      sessions: [session],
      refreshing: true,
      errors: { another: "Cannot read index" },
    });
    useSessionViewStore.getState().setAgent("claude-code");
    const { result } = renderHook(() => useSessionHub(), { wrapper });
    expect(result.current.filtered).toEqual([]);
    expect(doubles.navigate).toHaveBeenCalledOnce();
    expect(clearedSearch()).toEqual({ sessionId: undefined, unrelated: "retained" });
  });

  it("reveals an auxiliary deep link once, then honors a user hiding it", () => {
    const auxiliary = {
      ...session,
      id: "auxiliary-session",
      origin: "auxiliary" as const,
      spawned_by_session_id: session.id,
    };
    doubles.search = { sessionId: auxiliary.id };
    doubles.catalog.mockReturnValue({ ...catalogState(), sessions: [auxiliary] });
    const { result } = renderHook(() => useSessionHub(), { wrapper });
    expect(result.current.selected).toEqual(auxiliary);
    expect(useSessionViewStore.getState().showAuxiliary).toBe(true);
    act(() => useSessionViewStore.getState().setShowAuxiliary(false));
    expect(result.current.selected).toBeUndefined();
    expect(doubles.navigate).toHaveBeenCalledOnce();
  });

  it("clears a truly missing session only after the complete initial load", () => {
    doubles.catalog.mockReturnValue({ ...catalogState(), ready: false, refreshing: true });
    const { rerender } = renderHook(() => useSessionHub(), { wrapper });
    expect(doubles.navigate).not.toHaveBeenCalled();
    doubles.catalog.mockReturnValue(catalogState());
    rerender();
    expect(doubles.navigate).toHaveBeenCalledOnce();
    expect(clearedSearch()).toEqual({ sessionId: undefined, unrelated: "retained" });
  });

  it("does not clear the selected URL while indexing is disabled", () => {
    useAppStore.getState().setRuntime({ session_index_enabled: false } as RuntimeInfo);
    const { result } = renderHook(() => useSessionHub(), { wrapper });
    expect(doubles.catalog).toHaveBeenLastCalledWith([workspace], false);
    expect(result.current.enabled).toBe(false);
    expect(result.current.selected).toBeUndefined();
    expect(doubles.navigate).not.toHaveBeenCalled();
  });

  it("does not enable indexing or clear the selected URL before runtime initialization", () => {
    useAppStore.getState().setRuntime(undefined);
    const { result } = renderHook(() => useSessionHub(), { wrapper });
    expect(doubles.catalog).toHaveBeenLastCalledWith([workspace], false);
    expect(result.current.runtimeReady).toBe(false);
    expect(doubles.navigate).not.toHaveBeenCalled();
  });

  it("retains the selected URL while workspace loading fails or is still pending", () => {
    doubles.workspaceQuery.isPending = true;
    const { rerender } = renderHook(() => useSessionHub(), { wrapper });
    expect(doubles.navigate).not.toHaveBeenCalled();
    doubles.workspaceQuery.isPending = false;
    doubles.workspaceQuery.error = new Error("Workspace list unavailable");
    rerender();
    expect(doubles.navigate).not.toHaveBeenCalled();
  });

  it("increments history revision once after each completed refresh, not on unrelated renders", async () => {
    doubles.search = {};
    const catalog = catalogState();
    doubles.catalog.mockReturnValue(catalog);
    const { result, rerender } = renderHook(() => useSessionHub(), { wrapper });
    expect(result.current.historyRevision).toBe(0);
    doubles.catalog.mockReturnValue({ ...catalog, refreshing: true });
    rerender();
    expect(result.current.historyRevision).toBe(0);
    doubles.catalog.mockReturnValue(catalog);
    await act(async () => {
      rerender();
      await Promise.resolve();
    });
    expect(result.current.historyRevision).toBe(1);
    rerender();
    expect(result.current.historyRevision).toBe(1);
    doubles.catalog.mockReturnValue({ ...catalog, refreshing: true });
    rerender();
    doubles.catalog.mockReturnValue(catalog);
    await act(async () => {
      rerender();
      await Promise.resolve();
    });
    expect(result.current.historyRevision).toBe(2);
  });

  it("does not increment history revision when disabling indexing interrupts a refresh", () => {
    doubles.search = {};
    doubles.catalog.mockReturnValue({ ...catalogState(), refreshing: true });
    const { result, rerender } = renderHook(() => useSessionHub(), { wrapper });
    act(() => {
      useAppStore.getState().setRuntime({ session_index_enabled: false } as RuntimeInfo);
      doubles.catalog.mockReturnValue(catalogState());
      rerender();
    });
    expect(result.current.historyRevision).toBe(0);
  });

  it("delegates native refresh events to the current catalog callback and cleans up on unmount", async () => {
    doubles.search = {};
    const first = catalogState();
    doubles.catalog.mockReturnValue(first);
    const { rerender, unmount } = renderHook(() => useSessionHub(), { wrapper });
    await act(async () => window.dispatchEvent(new Event(SESSION_REFRESH_EVENT)));
    expect(first.refresh).toHaveBeenCalledOnce();

    const replacement = catalogState();
    doubles.catalog.mockReturnValue(replacement);
    rerender();
    await act(async () => window.dispatchEvent(new Event(SESSION_REFRESH_EVENT)));
    expect(first.refresh).toHaveBeenCalledOnce();
    expect(replacement.refresh).toHaveBeenCalledOnce();
    unmount();
    await act(async () => window.dispatchEvent(new Event(SESSION_REFRESH_EVENT)));
    expect(replacement.refresh).toHaveBeenCalledOnce();
  });

  it("preserves unrelated search parameters for selection and overview navigation", () => {
    doubles.search = {};
    const { result } = renderHook(() => useSessionHub(), { wrapper });
    act(() => result.current.select(session.id));
    const selectedNavigation = doubles.navigate.mock.calls[0][0] as {
      search: (previous: Record<string, unknown>) => Record<string, unknown>;
    };
    expect(selectedNavigation.search({ unrelated: "retained" })).toEqual({
      unrelated: "retained",
      sessionId: session.id,
    });
    act(() => result.current.select(undefined, true));
    const overviewNavigation = doubles.navigate.mock.calls[1][0] as {
      replace: boolean;
      search: (previous: Record<string, unknown>) => Record<string, unknown>;
    };
    expect(overviewNavigation.replace).toBe(true);
    expect(overviewNavigation.search({ sessionId: session.id })).toEqual({ sessionId: undefined });
  });
});
