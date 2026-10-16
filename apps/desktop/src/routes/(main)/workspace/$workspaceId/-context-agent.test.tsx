// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { AGENT_LABELS } from "@/core/agents";
import { initializeI18n, tr } from "@/core/i18n";
import type {
  AgentDetection,
  AgentKind,
  ContextPreview,
  WorkspaceScan,
  WorkspaceSummary,
} from "@/core/types";
import { appSearchSchema } from "@/features/app/app-search-schema";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import { ContextPage, Route } from "./context";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const router = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...router,
    createFileRoute: () => (options: unknown) => ({ options }),
    useParams: () => router.useParams({ strict: false }),
  };
});
vi.mock("@/core/api", () => ({ api: { context: vi.fn() } }));
const workspace: WorkspaceSummary = {
  id: "one",
  name: "One",
  path: "/one",
  status: "healthy",
  asset_count: 0,
  warning_count: 0,
  sources: [],
};
const other: WorkspaceSummary = { ...workspace, id: "two", name: "Two", path: "/two" };
function detected(agent: AgentKind, value = true): AgentDetection {
  return { agent, detected: value, asset_count: value ? 1 : 0, warnings: [] };
}
function scan(agents: AgentDetection[], root = workspace.path): WorkspaceScan {
  return { root, manifest_exists: true, agents, assets: [], warnings: [] };
}
function preview(project: string, cwd: string, agent: AgentKind): ContextPreview {
  return {
    project,
    cwd,
    agent,
    sections: [],
    warnings: [],
    visible_skills: [`${agent}:${cwd}`],
    visible_connections: [],
    approved_memories: [],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function start(
  search = "",
  currentScan: WorkspaceScan | null = scan([detected("claude-code")]),
) {
  useWorkspaceStore.setState({
    project: workspace.path,
    selectedWorkspace: workspace,
    scan: currentScan ?? undefined,
  });
  const root = createRootRoute({ validateSearch: appSearchSchema, component: Outlet });
  const route = createRoute({
    getParentRoute: () => root,
    path: "/workspace/$workspaceId/context",
    component: Route.options.component,
  });
  const history = createMemoryHistory({ initialEntries: [`/workspace/one/context${search}`] });
  const router = createRouter({ routeTree: root.addChildren([route]), history });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, router, history };
}
async function choose(agent: AgentKind) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: tr("context.agent") }));
  await user.click(await screen.findByRole("option", { name: AGENT_LABELS[agent] }));
}
beforeEach(async () => {
  await initializeI18n("en-US");
  vi.clearAllMocks();
  useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true);
  vi.mocked(api.context).mockImplementation(async (project, cwd, agent) =>
    preview(project, cwd, agent),
  );
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("workspace Context Agent selection", () => {
  it.each(["claude-code", "cursor", "deepseek-harness"] as const)(
    "starts a detected %s workspace without first requesting Codex",
    async (agent) => {
      await start("", scan([detected("codex", false), detected(agent)]));
      expect(await screen.findByText(`${agent}:/one`)).toBeVisible();
      expect(screen.getByRole("combobox", { name: tr("context.agent") })).toHaveTextContent(
        AGENT_LABELS[agent],
      );
      expect(api.context).toHaveBeenCalledExactlyOnceWith("/one", "/one", agent);
    },
  );
  it("uses scan order, skips unsupported detections and retains the existing fallback when none match", async () => {
    const unknown = {
      agent: "future-agent",
      detected: true,
      asset_count: 1,
      warnings: [],
    } as unknown as AgentDetection;
    await start("", scan([unknown, detected("cursor"), detected("claude-code")]));
    expect(await screen.findByText("cursor:/one")).toBeVisible();
    await act(async () =>
      useWorkspaceStore.getState().setScan(scan([unknown, detected("claude-code", false)])),
    );
    expect(await screen.findByText("codex:/one")).toBeVisible();
    expect(api.context).toHaveBeenLastCalledWith("/one", "/one", "codex");
  });
  it.each(["codex", "grok-build"] as const)(
    "respects an explicit supported %s URL even when it is not detected",
    async (agent) => {
      await start(`?agent=${agent}`);
      expect(await screen.findByText(`${agent}:/one`)).toBeVisible();
      expect(api.context).toHaveBeenCalledExactlyOnceWith("/one", "/one", agent);
    },
  );
  it.each(["unknown", "%5B%22codex%22%5D"])(
    "ignores the unsupported URL agent %s",
    async (value) => {
      await start(`?agent=${value}`);
      expect(await screen.findByText("claude-code:/one")).toBeVisible();
      expect(api.context).toHaveBeenCalledExactlyOnceWith("/one", "/one", "claude-code");
    },
  );
  it("stores manual selection in the URL, keeps other parameters and follows back/forward without reviving stale local selection", async () => {
    const { router, history } = await start("?sessionId=kept&workspaceAssetSection=native");
    await screen.findByText("claude-code:/one");
    await choose("cursor");
    await screen.findByText("cursor:/one");
    expect(router.state.location.search).toMatchObject({
      agent: "cursor",
      sessionId: "kept",
      workspaceAssetSection: "native",
    });
    await act(async () => useWorkspaceStore.getState().setScan(scan([detected("codex")])));
    expect(screen.getByRole("combobox", { name: tr("context.agent") })).toHaveTextContent("Cursor");
    expect(api.context).not.toHaveBeenCalledWith("/one", "/one", "codex");
    await act(async () => history.back());
    await screen.findByText("codex:/one");
    await act(async () => history.forward());
    await screen.findByText("cursor:/one");
  });
  it("waits for a matching scan instead of requesting a temporary default after an empty or failed initial load", async () => {
    await start("", null);
    await act(async () => {});
    expect(api.context).not.toHaveBeenCalled();
    await act(async () => useWorkspaceStore.setState({ busy: false, message: "Scan failed" }));
    expect(api.context).not.toHaveBeenCalled();
    await act(async () => useWorkspaceStore.getState().setScan(scan([detected("cursor")], "/old")));
    expect(api.context).not.toHaveBeenCalled();
    await act(async () => useWorkspaceStore.getState().setScan(scan([detected("claude-code")])));
    expect(await screen.findByText("claude-code:/one")).toBeVisible();
    expect(api.context).toHaveBeenCalledExactlyOnceWith("/one", "/one", "claude-code");
  });
  it("clears the old Agent preview while an updated automatic selection is resolving", async () => {
    await start();
    await screen.findByText("claude-code:/one");
    const pending = deferred<ContextPreview>();
    vi.mocked(api.context).mockReturnValueOnce(pending.promise);
    await act(async () => useWorkspaceStore.getState().setScan(scan([detected("cursor")])));
    expect(screen.queryByText("claude-code:/one")).not.toBeInTheDocument();
    expect(api.context).toHaveBeenLastCalledWith("/one", "/one", "cursor");
    await act(async () => pending.resolve(preview("/one", "/one", "cursor")));
    expect(await screen.findByText("cursor:/one")).toBeVisible();
  });
  it("allows another Agent after a context error without falling back to Codex", async () => {
    vi.mocked(api.context).mockRejectedValueOnce(new Error("Context read failed"));
    await start();
    expect(await screen.findByText("Error: Context read failed")).toBeVisible();
    expect(screen.getByRole("combobox", { name: tr("context.agent") })).toHaveTextContent(
      "Claude Code",
    );
    await choose("cursor");
    expect(await screen.findByText("cursor:/one")).toBeVisible();
    expect(screen.queryByText("Error: Context read failed")).not.toBeInTheDocument();
    expect(api.context).not.toHaveBeenCalledWith("/one", "/one", "codex");
  });
  it("does not use old workspace detection, cwd, or a late context result during a workspace switch", async () => {
    const pending = deferred<ContextPreview>();
    vi.mocked(api.context).mockReturnValueOnce(pending.promise);
    const { router } = await start();
    await waitFor(() => expect(api.context).toHaveBeenCalledOnce());
    await act(async () =>
      router.navigate({
        to: "/workspace/$workspaceId/context",
        params: { workspaceId: "two" },
        search: {},
      }),
    );
    expect(api.context).toHaveBeenCalledTimes(1);
    await act(async () =>
      useWorkspaceStore.setState({ project: other.path, selectedWorkspace: other }),
    );
    expect(api.context).toHaveBeenCalledTimes(1);
    await act(async () =>
      useWorkspaceStore.getState().setScan(scan([detected("cursor")], other.path)),
    );
    expect(await screen.findByText("cursor:/two")).toBeVisible();
    expect(api.context).toHaveBeenLastCalledWith("/two", "/two", "cursor");
    await act(async () => pending.resolve(preview("/one", "/one", "claude-code")));
    expect(screen.queryByText("claude-code:/one")).not.toBeInTheDocument();
    expect(screen.getByLabelText(tr("context.workingDirectory"))).toHaveValue("/two");
  });
  it("drops an uncommitted working-directory debounce when the project changes", async () => {
    const { router } = await start();
    await screen.findByText("claude-code:/one");
    fireEvent.change(screen.getByLabelText(tr("context.workingDirectory")), {
      target: { value: "/one/nested" },
    });
    await act(async () => {
      useWorkspaceStore.setState({
        project: other.path,
        selectedWorkspace: other,
        scan: scan([detected("cursor")], other.path),
      });
      await router.navigate({
        to: "/workspace/$workspaceId/context",
        params: { workspaceId: "two" },
        search: {},
      });
    });
    await screen.findByText("cursor:/two");
    await act(async () => new Promise((done) => setTimeout(done, 400)));
    expect(api.context).not.toHaveBeenCalledWith("/one", "/one/nested", "claude-code");
    expect(api.context).not.toHaveBeenCalledWith("/two", "/one/nested", "cursor");
  });
  it("keeps manual choices in a router-free host and resets them for another project", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const page = (project: string) => (
      <QueryClientProvider client={client}>
        <ContextPage
          project={project}
          agents={[detected("claude-code")]}
          onOpenInstructions={() => {}}
        />
      </QueryClientProvider>
    );
    const view = render(page("/one"));
    await screen.findByText("claude-code:/one");
    await choose("cursor");
    await screen.findByText("cursor:/one");
    view.rerender(page("/two"));
    expect(await screen.findByText("claude-code:/two")).toBeVisible();
    expect(api.context).toHaveBeenLastCalledWith("/two", "/two", "claude-code");
  });
});
