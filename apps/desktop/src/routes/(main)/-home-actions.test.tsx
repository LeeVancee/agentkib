// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { Suspense } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { initializeI18n, tr } from "@/core/i18n";
import type { RuntimeInfo, WorkspaceSummary } from "@/core/types";
import {
  AppNavigationProvider,
  type AppNavigationContextValue,
} from "@/features/app/AppNavigationContext";
import { useAppNavigation } from "@/features/app/useAppNavigation";
import { homeKeys } from "@/features/home/home-query";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import { useAppStore } from "@/stores/app-store";
import { Route } from "./index";

const doubles = vi.hoisted(() => ({
  navigate: vi.fn(),
  notify: vi.fn(),
  location: { pathname: "/", href: "/" },
  search: {},
  emptyListQuery: { data: [], isPending: false, isSuccess: true, isError: false },
  workspaces: [] as WorkspaceSummary[],
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: unknown) => ({ options }),
  useNavigate: () => doubles.navigate,
  useLocation: () => doubles.location,
  useSearch: () => doubles.search,
}));
vi.mock("@/components/AppDialogProvider", () => ({
  useAppDialogs: () => ({ notify: doubles.notify, confirm: vi.fn().mockResolvedValue(true) }),
}));
vi.mock("@/core/api", () => ({
  api: {
    pickDirectory: vi.fn(),
    addWorkspace: vi.fn(),
    addScanRoot: vi.fn(),
    requestRefresh: vi.fn(),
  },
}));
vi.mock("@/core/desktop", () => ({
  desktopApi: () => ({ benchmark: { mark: vi.fn().mockResolvedValue(undefined) } }),
}));
vi.mock("@/features/sessions/conversation-catalog", () => ({
  useConversationCatalog: () => ({ sessions: [] }),
}));
vi.mock("@/features/home/home-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/home/home-query")>()),
  useHomeWorkspaces: () => ({ ...doubles.emptyListQuery, data: doubles.workspaces }),
  useHomeMemories: () => doubles.emptyListQuery,
  useHomeRefreshJobs: () => doubles.emptyListQuery,
  useHomeInstallations: () => doubles.emptyListQuery,
  useHomeActivity: () => doubles.emptyListQuery,
  useHomeCatalog: () => doubles.emptyListQuery,
  useHomeDoctorSummaries: () => ({ ...doubles.emptyListQuery, data: {} }),
  useHomeDiscovery: () => ({ ...doubles.emptyListQuery, data: undefined }),
  useHomeInsightsSummary: () => ({ ...doubles.emptyListQuery, data: undefined }),
}));

const workspace: WorkspaceSummary = {
  id: "workspace",
  name: "Workspace",
  path: "/project",
  status: "healthy",
  sources: [],
  asset_count: 0,
  warning_count: 0,
};

function Harness() {
  const app = useAppNavigation({ kind: "global", page: "home" });
  const Component = Route.options.component!;
  return (
    <AppNavigationProvider value={{ app } as AppNavigationContextValue}>
      <Component />
    </AppNavigationProvider>
  );
}

async function renderHome() {
  // Wait for route splitting before checking the rendered UI's readiness.
  await Route.options.component!.preload?.();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);
  await act(async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <Suspense fallback={null}>
          <Harness />
        </Suspense>
      </QueryClientProvider>,
    );
  });
  await screen.findByRole("button", { name: tr("home.addWorkspace") });
  return { invalidate };
}

describe("home add actions", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => {
    vi.clearAllMocks();
    doubles.workspaces = [];
    useAppStore.setState(useAppStore.getInitialState(), true);
    useAppStore.setState({ runtime: { session_index_enabled: false } as RuntimeInfo });
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true);
    doubles.notify.mockResolvedValue(undefined);
    doubles.navigate.mockResolvedValue(undefined);
    vi.mocked(api.pickDirectory).mockResolvedValue("/project");
    vi.mocked(api.addWorkspace).mockResolvedValue(workspace);
    vi.mocked(api.addScanRoot).mockResolvedValue({} as Awaited<ReturnType<typeof api.addScanRoot>>);
    vi.mocked(api.requestRefresh).mockResolvedValue(
      {} as Awaited<ReturnType<typeof api.requestRefresh>>,
    );
  });
  afterEach(cleanup);

  it("opens the existing activity log instead of navigating to Insights", async () => {
    doubles.workspaces = [workspace];
    await renderHome();
    const activity = screen.getByRole("region", { name: tr("home.recentActivity") });
    fireEvent.click(within(activity).getByRole("button", { name: tr("home.viewAll") }));
    await waitFor(() =>
      expect(doubles.navigate).toHaveBeenCalledExactlyOnceWith({
        to: "/settings",
        search: { settingsSection: "diagnostics", settingsTarget: "diagnostics-activity" },
      }),
    );
  });

  it("adds a single workspace through the shared safe navigation flow", async () => {
    const { invalidate } = await renderHome();
    fireEvent.click(screen.getByRole("button", { name: tr("home.addWorkspace") }));
    await waitFor(() =>
      expect(doubles.navigate).toHaveBeenCalledWith({
        to: "/workspace/$workspaceId",
        params: { workspaceId: workspace.id },
        search: {},
      }),
    );
    expect(api.pickDirectory).toHaveBeenCalledWith(tr("dialog.addWorkspace"));
    expect(api.addWorkspace).toHaveBeenCalledWith("/project");
    expect(api.addScanRoot).not.toHaveBeenCalled();
    expect(api.requestRefresh).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: homeKeys.all });
    expect(useWorkspaceStore.getState().selectedWorkspace).toEqual(workspace);
  });

  it("adds a scan folder and refreshes discovery without opening a workspace", async () => {
    const { invalidate } = await renderHome();
    fireEvent.click(screen.getByRole("button", { name: tr("home.addScanRoot") }));
    await waitFor(() => expect(api.requestRefresh).toHaveBeenCalledWith("discovery", true));
    expect(api.pickDirectory).toHaveBeenCalledWith(tr("dialog.addScanRoot"));
    expect(api.addScanRoot).toHaveBeenCalledWith("/project", 5);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: homeKeys.scanRoots() });
    expect(api.addWorkspace).not.toHaveBeenCalled();
    expect(doubles.navigate).not.toHaveBeenCalled();
  });

  it("keeps the existing apply guard before selecting a workspace", async () => {
    useWorkspaceStore.setState({ applyingChanges: true });
    await renderHome();
    fireEvent.click(screen.getByRole("button", { name: tr("home.addWorkspace") }));
    await waitFor(() =>
      expect(doubles.notify).toHaveBeenCalledWith(tr("workspace.changesApplying")),
    );
    expect(api.pickDirectory).not.toHaveBeenCalled();
    expect(api.addWorkspace).not.toHaveBeenCalled();
    expect(doubles.navigate).not.toHaveBeenCalled();
  });

  it("shows add failures inline and re-enables the actions for retry", async () => {
    vi.mocked(api.addScanRoot).mockRejectedValueOnce(new Error("scan folder denied"));
    await renderHome();
    fireEvent.click(screen.getByRole("button", { name: tr("home.addScanRoot") }));
    expect(await screen.findByRole("alert")).toHaveTextContent("scan folder denied");
    expect(screen.getByRole("button", { name: tr("home.addScanRoot") })).toBeEnabled();
    expect(api.requestRefresh).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: tr("home.addScanRoot") }));
    await waitFor(() => expect(api.requestRefresh).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does nothing after cancelling the directory picker", async () => {
    vi.mocked(api.pickDirectory).mockResolvedValue(undefined);
    await renderHome();
    fireEvent.click(screen.getByRole("button", { name: tr("home.addWorkspace") }));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: tr("home.addScanRoot") }));
    await act(async () => {});
    expect(api.pickDirectory).toHaveBeenCalledTimes(2);
    expect(api.addWorkspace).not.toHaveBeenCalled();
    expect(api.addScanRoot).not.toHaveBeenCalled();
    expect(doubles.navigate).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
