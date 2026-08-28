// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "@/core/i18n";
import { useAppStore } from "@/stores/app-store";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import type { Manifest, WorkspaceSummary } from "@/core/types";
import { useAppNavigation } from "./useAppNavigation";

const testDoubles = vi.hoisted(() => ({
  navigate: vi.fn(),
  notify: vi.fn().mockResolvedValue(undefined),
  confirm: vi.fn().mockResolvedValue(false),
  requestSecrets: vi.fn(),
  open: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useLocation: () => ({ pathname: "/" }),
  useNavigate: () => testDoubles.navigate,
  useSearch: () => ({}),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: testDoubles.open }));

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
    useAppStore.getState().reset();
    useWorkspaceStore.getState().resetWorkspace();
    testDoubles.navigate.mockReset();
    testDoubles.notify.mockReset().mockResolvedValue(undefined);
    testDoubles.confirm.mockReset().mockResolvedValue(false);
    testDoubles.open.mockReset();
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
    useWorkspaceStore.setState({ selectedWorkspace: workspace, workspaceDrafts: { [workspace.id]: draft } });

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
});
