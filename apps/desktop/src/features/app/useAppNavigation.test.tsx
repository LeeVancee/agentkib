// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "@/core/i18n";
import { useAppStore } from "@/stores/app-store";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import type { Manifest, WorkspaceSummary } from "@/core/types";
import { useAppNavigation } from "./useAppNavigation";
import type { AppHistoryEntry } from "./useAppHistory";

const testDoubles = vi.hoisted(() => ({
  navigate: vi.fn(),
  notify: vi.fn().mockResolvedValue(undefined),
  confirm: vi.fn().mockResolvedValue(false),
  requestSecrets: vi.fn(),
  open: vi.fn(),
  agentTools: vi.fn(),
  location: { pathname: "/" },
  search: {} as Record<string, string>,
}));

const homeHistoryEntry: AppHistoryEntry = {
  key: "home",
  href: "/",
  pathname: "/",
  search: "",
  hash: "",
  browserIndex: 0,
};

vi.mock("@tanstack/react-router", () => ({
  useLocation: () => testDoubles.location,
  useNavigate: () => testDoubles.navigate,
  useSearch: () => testDoubles.search,
}));

vi.mock("@/components/AppDialogProvider", () => ({
  useAppDialogs: () => ({
    notify: testDoubles.notify,
    confirm: testDoubles.confirm,
    requestSecrets: testDoubles.requestSecrets,
  }),
}));

describe("useAppNavigation guards", () => {
  beforeAll(async () => initializeI18n("en-US"));

  beforeEach(() => {
    Object.defineProperty(window, "agentkibDesktop", {
      configurable: true,
      value: {
        shell: { openDirectory: testDoubles.open },
        home: { agentTools: testDoubles.agentTools },
      },
    });
    useAppStore.getState().reset();
    useWorkspaceStore.getState().resetWorkspace();
    testDoubles.navigate.mockReset();
    testDoubles.notify.mockReset().mockResolvedValue(undefined);
    testDoubles.confirm.mockReset().mockResolvedValue(false);
    testDoubles.open.mockReset();
    testDoubles.agentTools.mockReset();
    testDoubles.location.pathname = "/";
    testDoubles.search = {};
  });

  afterEach(cleanup);

  it("opens settings without discarding the current workspace draft", () => {
    const workspace: WorkspaceSummary = {
      id: "workspace-1",
      path: "C:/workspace",
      name: "Workspace",
      status: "healthy",
      asset_count: 0,
      warning_count: 0,
      sources: [],
    };
    const draft = {} as Manifest;
    useWorkspaceStore.setState({
      selectedWorkspace: workspace,
      workspaceDrafts: { [workspace.id]: draft },
    });

    const { result } = renderHook(() => useAppNavigation());

    act(() => result.current.openSettings());

    expect(testDoubles.navigate).toHaveBeenCalledOnce();
    expect(testDoubles.navigate.mock.calls[0][0].to).toBe("/settings");
    expect(testDoubles.navigate.mock.calls[0][0].search({})).toEqual({
      settingsSection: "general",
    });
    expect(useWorkspaceStore.getState().selectedWorkspace?.id).toBe(workspace.id);
    expect(useWorkspaceStore.getState().workspaceDrafts[workspace.id]).toBe(draft);
    expect(testDoubles.notify).not.toHaveBeenCalled();
  });

  it("uses the same guarded settings action for native navigation requests", () => {
    useAppStore.setState({
      navigationRequest: { page: "settings", settings_section: "privacy" },
    });

    renderHook(() => useAppNavigation());

    expect(testDoubles.navigate).toHaveBeenCalledOnce();
    expect(testDoubles.navigate.mock.calls[0][0].search({})).toEqual({
      settingsSection: "privacy",
    });
    expect(useAppStore.getState().navigationRequest).toBeUndefined();
  });

  it("blocks settings navigation while a ChangeSet is applying", () => {
    useWorkspaceStore.setState({ applyingChanges: true });
    const { result } = renderHook(() => useAppNavigation());

    act(() => result.current.openSettings("diagnostics"));

    expect(testDoubles.navigate).not.toHaveBeenCalled();
    expect(testDoubles.notify).toHaveBeenCalledOnce();
  });

  it("blocks adding a workspace before opening the directory picker", async () => {
    useWorkspaceStore.setState({ applyingChanges: true });
    const { result } = renderHook(() => useAppNavigation());

    await act(async () => result.current.addWorkspace());

    expect(testDoubles.open).not.toHaveBeenCalled();
    expect(testDoubles.notify).toHaveBeenCalledOnce();
  });

  it("blocks direct workspace navigation while a ChangeSet is applying", async () => {
    const currentWorkspace: WorkspaceSummary = {
      id: "workspace-1",
      path: "C:/workspace-1",
      name: "Current workspace",
      status: "healthy",
      asset_count: 0,
      warning_count: 0,
      sources: [],
    };
    const nextWorkspace: WorkspaceSummary = {
      ...currentWorkspace,
      id: "workspace-2",
      path: "C:/workspace-2",
      name: "Next workspace",
    };
    useWorkspaceStore.setState({ applyingChanges: true, selectedWorkspace: currentWorkspace });
    const { result } = renderHook(() => useAppNavigation());

    await act(async () => result.current.openWorkspace(nextWorkspace));

    expect(testDoubles.navigate).not.toHaveBeenCalled();
    expect(testDoubles.notify).toHaveBeenCalledOnce();
    expect(useWorkspaceStore.getState().selectedWorkspace).toBe(currentWorkspace);
    expect(useWorkspaceStore.getState().applyingChanges).toBe(true);
  });

  it("rechecks the ChangeSet state after the directory picker", async () => {
    testDoubles.open.mockImplementation(async () => {
      useWorkspaceStore.setState({ applyingChanges: true });
      return "C:/new-workspace";
    });
    const { result } = renderHook(() => useAppNavigation());

    await act(async () => result.current.addWorkspace());

    expect(testDoubles.open).toHaveBeenCalledOnce();
    expect(testDoubles.notify).toHaveBeenCalledOnce();
  });

  it("blocks history navigation while a ChangeSet is applying", async () => {
    useWorkspaceStore.setState({ applyingChanges: true });
    const { result } = renderHook(() => useAppNavigation());

    await act(async () => {
      expect(await result.current.prepareHistoryNavigation(homeHistoryEntry)).toBe(false);
    });

    expect(testDoubles.notify).toHaveBeenCalledOnce();
  });

  it("keeps history and workspace state when leaving a draft is cancelled", async () => {
    const workspace: WorkspaceSummary = {
      id: "workspace-1",
      path: "C:/workspace",
      name: "Workspace",
      status: "healthy",
      asset_count: 0,
      warning_count: 0,
      sources: [],
    };
    useWorkspaceStore.setState({
      selectedWorkspace: workspace,
      project: workspace.path,
      manifest: {} as Manifest,
      baselineManifest: '{"version":0}',
    });
    const { result } = renderHook(() => useAppNavigation());

    await act(async () => {
      expect(await result.current.prepareHistoryNavigation(homeHistoryEntry)).toBe(false);
    });

    expect(testDoubles.confirm).toHaveBeenCalledOnce();
    expect(useWorkspaceStore.getState().selectedWorkspace).toBe(workspace);
    expect(testDoubles.navigate).not.toHaveBeenCalled();
  });

  it("clears workspace state after confirming protected history navigation", async () => {
    const workspace: WorkspaceSummary = {
      id: "workspace-1",
      path: "C:/workspace",
      name: "Workspace",
      status: "healthy",
      asset_count: 0,
      warning_count: 0,
      sources: [],
    };
    testDoubles.confirm.mockResolvedValue(true);
    useWorkspaceStore.setState({
      selectedWorkspace: workspace,
      project: workspace.path,
      manifest: {} as Manifest,
      baselineManifest: '{"version":0}',
    });
    const { result } = renderHook(() => useAppNavigation());

    await act(async () => {
      expect(await result.current.prepareHistoryNavigation(homeHistoryEntry)).toBe(true);
    });

    expect(useWorkspaceStore.getState().selectedWorkspace).toBeUndefined();
    expect(useWorkspaceStore.getState().project).toBe("");
    expect(testDoubles.navigate).not.toHaveBeenCalled();
  });

  it("reports tool refresh failures without rejecting the toolbar action", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    testDoubles.location.pathname = "/settings";
    testDoubles.search = { settingsSection: "tools" };
    testDoubles.agentTools.mockRejectedValueOnce(new Error("refresh unavailable"));
    const { result } = renderHook(() => useAppNavigation(), { wrapper });

    await act(async () => result.current.refreshCurrentView());

    expect(testDoubles.agentTools).toHaveBeenCalledWith(true);
    expect(useWorkspaceStore.getState().message).toContain("refresh unavailable");
    queryClient.clear();
  });

  it("clears a previous tool refresh error and updates the cache", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const snapshot = { tools: [], detected_at: "2026-09-03T00:00:00Z" };
    testDoubles.location.pathname = "/settings";
    testDoubles.search = { settingsSection: "tools" };
    testDoubles.agentTools.mockResolvedValueOnce(snapshot);
    useWorkspaceStore.setState({ message: "previous error" });
    const { result } = renderHook(() => useAppNavigation(), { wrapper });

    await act(async () => result.current.refreshCurrentView());

    expect(useWorkspaceStore.getState().message).toBe("");
    expect(queryClient.getQueryData(["settings", "agent-tools"])).toBe(snapshot);
    queryClient.clear();
  });
});
