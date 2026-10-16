// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Suspense } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { initializeI18n, tr } from "@/core/i18n";
import { homeKeys } from "@/features/home/home-query";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import type { CatalogAsset, WorkspaceSummary } from "@/core/types";
import { Route } from "./workspaces";

const doubles = vi.hoisted(() => ({
  workspaces: vi.fn(),
  catalog: vi.fn(),
  pick: vi.fn(),
  add: vi.fn(),
  navigate: vi.fn(),
  notify: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock("@/core/api", () => ({
  api: {
    workspaces: doubles.workspaces,
    catalogAssets: doubles.catalog,
    discoveryReport: async () => undefined,
    refreshStatus: async () => [],
    pickDirectory: doubles.pick,
    addWorkspace: doubles.add,
  },
}));
vi.mock("@/components/AppDialogProvider", () => ({
  useAppDialogs: () => ({ notify: doubles.notify, confirm: doubles.confirm }),
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: unknown) => ({ options }),
  useSearch: () => ({ workspaceView: "list" }),
  useNavigate: () => doubles.navigate,
}));
const workspace: WorkspaceSummary = {
  id: "one",
  name: "Alpha workspace",
  path: "/alpha",
  status: "healthy",
  asset_count: 9,
  warning_count: 0,
  sources: [],
};
const asset: CatalogAsset = {
  id: "policy",
  workspace_id: "one",
  scope: "workspace",
  kind: "instruction",
  name: "Policy",
  path: "/alpha/AGENTS.md",
  summary: "Project guidance",
  size: 24,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function start(cached = false) {
  const client = new QueryClient();
  if (cached) {
    client.setQueryData(homeKeys.workspaces(), [workspace]);
    client.setQueryData(homeKeys.catalog(), [asset]);
    doubles.workspaces.mockResolvedValue([workspace]);
    doubles.catalog.mockResolvedValue([asset]);
  }
  const Component = Route.options.component!;
  const view = render(
    <QueryClientProvider client={client}>
      <Suspense fallback={null}>
        <Component />
      </Suspense>
    </QueryClientProvider>,
  );
  return { client, ...view };
}
function countValue() {
  return screen.getByText(tr("workspace.assetsColumn")).parentElement!.querySelector("strong");
}
function workspaceButtonName() {
  return `${workspace.name}, ${tr("workspace.source.manual")}, ${tr(`status.workspace.${workspace.status}`)}`;
}
beforeAll(async () => {
  const component = Route.options.component;
  if (component && "preload" in component && typeof component.preload === "function")
    await component.preload();
});
beforeEach(async () => {
  vi.resetAllMocks();
  doubles.workspaces.mockResolvedValue([]);
  doubles.catalog.mockResolvedValue([]);
  doubles.pick.mockResolvedValue(null);
  doubles.confirm.mockResolvedValue(true);
  useWorkspaceStore.getState().resetWorkspace();
  useWorkspaceStore.getState().setApplyingChanges(false);
  await initializeI18n("en-US");
});
afterEach(cleanup);

it("shows initial loading without claiming no workspaces or no filter matches", async () => {
  const pending = deferred<WorkspaceSummary[]>();
  doubles.workspaces.mockReturnValue(pending.promise);
  start();
  expect(await screen.findByRole("status")).toBeVisible();
  expect(screen.queryByText(tr("workspace.emptyTitle"))).not.toBeInTheDocument();
  expect(screen.queryByText(tr("workspace.noMatch"))).not.toBeInTheDocument();
  await act(async () => pending.resolve([]));
  expect(await screen.findByText(tr("workspace.emptyTitle"))).toBeVisible();
});

it("uses the existing failure state and retries an initially unavailable workspace list", async () => {
  doubles.workspaces.mockRejectedValueOnce(new Error("unavailable"));
  doubles.workspaces.mockResolvedValue([workspace]);
  start();
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(tr("nav.workspaces"));
  expect(screen.queryByText(tr("workspace.emptyTitle"))).not.toBeInTheDocument();
  expect(screen.queryByText(tr("workspace.noMatch"))).not.toBeInTheDocument();
  fireEvent.click(within(alert).getByRole("button", { name: tr("runtime.retry") }));
  expect(await screen.findByRole("button", { name: workspaceButtonName() })).toBeVisible();
  expect(doubles.workspaces).toHaveBeenCalledTimes(2);
  expect(doubles.catalog).toHaveBeenCalledTimes(1);
});

it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
  "explains a truly empty list in %s and keeps one executable add entry",
  async (locale) => {
    await initializeI18n(locale);
    start();
    expect(await screen.findByRole("heading", { name: tr("workspace.emptyTitle") })).toBeVisible();
    expect(
      screen.getByText(tr("workspace.emptyText", { action: tr("workspace.addManually") })),
    ).toBeVisible();
    expect(screen.queryByText(tr("workspace.noMatch"))).not.toBeInTheDocument();
    const buttons = screen.getAllByRole("button", { name: tr("workspace.addManually") });
    expect(buttons).toHaveLength(1);
    doubles.pick.mockResolvedValue("/chosen/project");
    doubles.add.mockResolvedValue({ ...workspace, path: "/chosen/project" });
    doubles.workspaces.mockResolvedValue([{ ...workspace, path: "/chosen/project" }]);
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(doubles.add).toHaveBeenCalledExactlyOnceWith("/chosen/project"));
    await waitFor(() =>
      expect(doubles.navigate).toHaveBeenCalledWith({
        to: "/workspace/$workspaceId",
        params: { workspaceId: "one" },
      }),
    );
    expect(useWorkspaceStore.getState().selectedWorkspace?.path).toBe("/chosen/project");
  },
);

it("preserves a search with no results instead of pretending the whole list is empty", async () => {
  doubles.workspaces.mockResolvedValue([workspace]);
  start();
  const search = await screen.findByRole("textbox", { name: tr("workspace.searchPlaceholder") });
  fireEvent.change(search, { target: { value: "missing-project" } });
  expect(screen.getByText(tr("workspace.noMatch"))).toBeVisible();
  expect(screen.queryByText(tr("workspace.emptyTitle"))).not.toBeInTheDocument();
  expect(search).toHaveValue("missing-project");
  expect(doubles.pick).not.toHaveBeenCalled();
});

it("keeps non-search filter semantics when existing workspaces do not match", async () => {
  doubles.workspaces.mockResolvedValue([workspace]);
  start();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("combobox", { name: tr("workspace.allAgents") }));
  await user.click(await screen.findByRole("option", { name: "Codex" }));
  expect(screen.getByText(tr("workspace.noMatch"))).toBeVisible();
  expect(screen.queryByText(tr("workspace.emptyTitle"))).not.toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: tr("workspace.allAgents") })).toHaveTextContent(
    "Codex",
  );
});

it("preserves the mounted list, search and cached selection on a failed workspace refresh", async () => {
  const { client } = start(true);
  const search = await screen.findByRole("textbox", { name: tr("workspace.searchPlaceholder") });
  fireEvent.change(search, { target: { value: "Alpha" } });
  const pending = deferred<WorkspaceSummary[]>();
  doubles.workspaces.mockReturnValueOnce(pending.promise);
  let refresh!: Promise<void>;
  act(() => {
    refresh = client.invalidateQueries({ queryKey: homeKeys.workspaces() });
  });
  expect(screen.getByRole("textbox", { name: tr("workspace.searchPlaceholder") })).toBe(search);
  expect(screen.getByRole("button", { name: workspaceButtonName() })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await act(async () => {
    pending.reject(new Error("refresh failed"));
    await refresh;
  });
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(tr("query.workspaces"));
  expect(alert).toHaveTextContent(tr("query.staleData"));
  expect(search).toHaveValue("Alpha");
  expect(screen.getByRole("textbox", { name: tr("workspace.searchPlaceholder") })).toBe(search);
  expect(screen.getByRole("button", { name: workspaceButtonName() })).toBeVisible();
  expect(screen.queryByText(tr("workspace.emptyTitle"))).not.toBeInTheDocument();
  fireEvent.click(within(alert).getByRole("button", { name: tr("runtime.retry") }));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(search).toHaveValue("Alpha");
  expect(screen.getByRole("textbox", { name: tr("workspace.searchPlaceholder") })).toBe(search);
});

it("names an initial catalog failure while keeping the real workspace list and an unknown asset count", async () => {
  doubles.workspaces.mockResolvedValue([workspace]);
  doubles.catalog.mockRejectedValueOnce(new Error("catalog failed"));
  start();
  expect(await screen.findByRole("alert")).toHaveTextContent(tr("query.catalog"));
  expect(screen.getByRole("alert")).toHaveTextContent(tr("query.initialUnavailable"));
  expect(screen.getByRole("button", { name: workspaceButtonName() })).toBeVisible();
  expect(countValue()).toHaveTextContent("—");
  doubles.catalog.mockResolvedValue([asset]);
  fireEvent.click(
    within(screen.getByRole("alert")).getByRole("button", { name: tr("runtime.retry") }),
  );
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(countValue()).toHaveTextContent("1");
  expect(doubles.workspaces).toHaveBeenCalledTimes(1);
});

it("retains cached asset counts when the catalog refresh fails and retries only catalog data", async () => {
  const { client } = start(true);
  await screen.findByRole("button", { name: workspaceButtonName() });
  doubles.catalog.mockRejectedValueOnce(new Error("catalog refresh failed"));
  await act(async () => {
    await client.invalidateQueries({ queryKey: homeKeys.catalog() });
  });
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(tr("query.catalog"));
  expect(alert).toHaveTextContent(tr("query.staleData"));
  expect(countValue()).toHaveTextContent("1");
  fireEvent.click(within(alert).getByRole("button", { name: tr("runtime.retry") }));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(countValue()).toHaveTextContent("1");
  expect(doubles.catalog).toHaveBeenCalledTimes(2);
  expect(doubles.workspaces).not.toHaveBeenCalled();
});

it("keeps the existing apply lock when adding from an empty workspace page", async () => {
  start();
  const add = await screen.findByRole("button", { name: tr("workspace.addManually") });
  useWorkspaceStore.getState().setApplyingChanges(true);
  fireEvent.click(add);
  await waitFor(() => expect(doubles.notify).toHaveBeenCalledWith(tr("workspace.changesApplying")));
  expect(doubles.pick).not.toHaveBeenCalled();
  expect(doubles.add).not.toHaveBeenCalled();
});
