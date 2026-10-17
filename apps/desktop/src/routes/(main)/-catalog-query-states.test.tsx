// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Suspense } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { initializeI18n, tr } from "@/core/i18n";
import { homeKeys } from "@/features/home/home-query";
import type { CatalogAsset, MemoryRecord, WorkspaceSummary } from "@/core/types";
import { Route } from "./catalog";

const doubles = vi.hoisted(() => ({
  catalog: vi.fn(),
  workspaces: vi.fn(),
  memories: vi.fn(),
  navigate: vi.fn(),
  search: {
    assetSection: "instructions",
    skillSection: "workspace",
    catalogTarget: undefined as string | undefined,
  },
}));
vi.mock("@/core/api", () => ({
  api: {
    catalogAssets: doubles.catalog,
    workspaces: doubles.workspaces,
    globalMemories: doubles.memories,
    mcpInstallations: async () => [],
    mcpRuntimes: async () => [],
    runtime: async () => null,
  },
}));
vi.mock("@/features/skills/SkillHubPage", () => ({
  SkillHubPage: () => <h2>Available skill library</h2>,
}));
vi.mock("@/features/mcp/McpManagementPanel", () => ({
  McpManagementPanel: () => <h2>Available MCP services</h2>,
}));
vi.mock("@/components/AppDialogProvider", () => ({ useAppDialogs: () => ({}) }));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: unknown) => ({ options }),
  useSearch: () => doubles.search,
  useNavigate: () => doubles.navigate,
}));

const workspace: WorkspaceSummary = {
  id: "one",
  name: "Alpha workspace",
  path: "/alpha",
  status: "healthy",
  asset_count: 1,
  warning_count: 0,
  sources: [],
  manifest_workspace_id: "project-one",
};
const asset: CatalogAsset = {
  id: "policy",
  workspace_id: "one",
  scope: "workspace",
  kind: "instruction",
  name: "Policy Alpha",
  path: "/alpha/AGENTS.md",
  summary: "Project guidance",
  size: 24,
};
const memory: MemoryRecord = {
  id: "memory-one",
  project_id: "project-one",
  memory_type: "project_fact",
  content: "Saved memory",
  status: "pending",
  created_at: "2026-10-16T00:00:00Z",
};
const sources = [
  {
    read: doubles.catalog,
    key: homeKeys.catalog(),
    label: "query.catalog",
    data: [asset],
    section: "instructions",
  },
  {
    read: doubles.workspaces,
    key: homeKeys.workspaces(),
    label: "query.workspaces",
    data: [workspace],
    section: "instructions",
  },
  {
    read: doubles.memories,
    key: homeKeys.memories(),
    label: "query.memories",
    data: [memory],
    section: "memory",
  },
];
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
  if (cached)
    for (const source of sources) {
      client.setQueryData(source.key, source.data);
      source.read.mockResolvedValue(source.data);
    }
  const Component = Route.options.component!;
  const page = () => (
    <QueryClientProvider client={client}>
      <Suspense fallback={null}>
        <Component />
      </Suspense>
    </QueryClientProvider>
  );
  const view = render(page());
  return { client, ...view, refreshSearch: () => view.rerender(page()) };
}
beforeAll(async () => {
  const component = Route.options.component;
  if (component && "preload" in component && typeof component.preload === "function")
    await component.preload();
});
beforeEach(async () => {
  vi.resetAllMocks();
  doubles.search = {
    assetSection: "instructions",
    skillSection: "workspace",
    catalogTarget: undefined,
  };
  doubles.catalog.mockResolvedValue([]);
  doubles.workspaces.mockResolvedValue([]);
  doubles.memories.mockResolvedValue([]);
  await initializeI18n("en-US");
});
afterEach(cleanup);

it("does not show an empty catalog before the initial query settles", async () => {
  const pending = deferred<CatalogAsset[]>();
  doubles.catalog.mockReturnValue(pending.promise);
  start();
  expect(await screen.findByRole("status", { name: tr("loading.assets") })).toBeVisible();
  expect(screen.queryByText(tr("catalog.noMatch"))).not.toBeInTheDocument();
  await act(async () => pending.resolve([]));
  expect(await screen.findByText(tr("catalog.noMatch"))).toBeVisible();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("keeps skills and MCP usable after the initial memory query fails", async () => {
  doubles.memories.mockRejectedValue(new Error("Memory unavailable"));
  const view = start();
  await screen.findByRole("textbox", { name: tr("catalog.searchPlaceholder") });
  await waitFor(() => expect(doubles.memories).toHaveBeenCalled());
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  for (const [section, title] of [
    ["skills", "Available skill library"],
    ["mcp", "Available MCP services"],
  ]) {
    doubles.search.assetSection = section!;
    view.refreshSearch();
    expect(await screen.findByRole("heading", { name: title })).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  }
  doubles.search.assetSection = "memory";
  view.refreshSearch();
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(tr("query.memories"));
  expect(within(alert).getByRole("button", { name: tr("runtime.retry") })).toBeVisible();
  expect(screen.getByRole("navigation")).toBeVisible();
});

it("consumes the MCP network focus target with replace after focusing once", async () => {
  doubles.search.assetSection = "mcp";
  doubles.search.catalogTarget = "mcp-network";
  const view = start();
  const target = await screen.findByLabelText(tr("mcp.network"));
  await waitFor(() => expect(target).toHaveFocus());
  expect(doubles.navigate).toHaveBeenCalledTimes(1);
  const navigation = doubles.navigate.mock.calls[0]![0];
  expect(navigation).toMatchObject({ to: "/catalog", replace: true });
  expect(navigation.search({ assetSection: "mcp", catalogTarget: "mcp-network" })).toEqual({
    assetSection: "mcp",
    catalogTarget: undefined,
  });
  doubles.search.catalogTarget = undefined;
  view.refreshSearch();
  screen.getByRole("button", { name: tr("mcp.manage.advanced") }).focus();
  view.refreshSearch();
  expect(target).not.toHaveFocus();
  expect(doubles.navigate).toHaveBeenCalledTimes(1);
});

it.each(sources)(
  "does not disguise an initial $label failure as empty and retries only that dependency",
  async (source) => {
    doubles.search.assetSection = source.section;
    source.read.mockRejectedValueOnce(new Error("unavailable"));
    start();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(tr(source.label));
    expect(alert).toHaveTextContent(tr("query.initialUnavailable"));
    expect(screen.queryByText(tr("catalog.noMatch"))).not.toBeInTheDocument();
    expect(screen.queryByText(tr("memory.empty"))).not.toBeInTheDocument();
    const initialCounts = sources.map(({ read }) => read.mock.calls.length);
    fireEvent.click(within(alert).getByRole("button", { name: tr("runtime.retry") }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    sources.forEach(({ read }, index) =>
      expect(read).toHaveBeenCalledTimes(initialCounts[index] + (read === source.read ? 1 : 0)),
    );
    expect(doubles.navigate).not.toHaveBeenCalled();
  },
);

it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
  "keeps section navigation and names only active failed dependencies in %s",
  async (locale) => {
    await initializeI18n(locale);
    for (const source of sources) source.read.mockRejectedValue(new Error("unavailable"));
    start();
    await waitFor(() =>
      expect(within(screen.getByRole("alert")).getAllByRole("listitem")).toHaveLength(2),
    );
    const alert = screen.getByRole("alert");
    for (const source of sources.slice(0, 2)) expect(alert).toHaveTextContent(tr(source.label));
    expect(alert).not.toHaveTextContent(tr("query.memories"));
    expect(alert).toHaveTextContent(tr("query.initialUnavailable"));
    expect(screen.getByRole("navigation")).toBeVisible();
    expect(screen.queryByText(tr("catalog.noMatch"))).not.toBeInTheDocument();
    expect(screen.queryByText(tr("memory.empty"))).not.toBeInTheDocument();
  },
);

it.each(sources.slice(0, 2))(
  "keeps cached content and filter state across $label pending/failure and a locked retry",
  async (source) => {
    const { client } = start(true);
    const input = await screen.findByRole("textbox", { name: tr("catalog.searchPlaceholder") });
    fireEvent.change(input, { target: { value: "Policy" } });
    const refresh = deferred<unknown>();
    source.read.mockReturnValueOnce(refresh.promise);
    let pending!: Promise<void>;
    act(() => {
      pending = client.invalidateQueries({ queryKey: source.key });
    });
    expect(input).toHaveValue("Policy");
    expect(screen.getByText("Policy Alpha")).toBeVisible();
    expect(screen.queryByRole("status", { name: tr("loading.assets") })).not.toBeInTheDocument();
    await act(async () => {
      refresh.reject(new Error("refresh failed"));
      await pending;
    });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(tr(source.label));
    expect(alert).toHaveTextContent(tr("query.staleData"));
    expect(screen.getByRole("textbox", { name: tr("catalog.searchPlaceholder") })).toBe(input);
    expect(input).toHaveValue("Policy");
    expect(screen.getByText("Policy Alpha")).toBeVisible();
    const retry = deferred<unknown>();
    source.read.mockReturnValueOnce(retry.promise);
    const button = within(alert).getByRole("button", { name: tr("runtime.retry") });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(source.read).toHaveBeenCalledTimes(2);
    expect(button).toBeDisabled();
    await act(async () => retry.resolve(source.data));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByRole("textbox", { name: tr("catalog.searchPlaceholder") })).toBe(input);
    expect(input).toHaveValue("Policy");
    expect(screen.getByText("Policy Alpha")).toBeVisible();
    expect(doubles.navigate).not.toHaveBeenCalled();
  },
);

it("retains an actual memory review draft across cached refresh failure and retry", async () => {
  doubles.search.assetSection = "memory";
  const { client } = start(true);
  fireEvent.click(await screen.findByRole("button", { name: tr("common.edit") }));
  const editor = screen.getByRole("textbox");
  fireEvent.change(editor, { target: { value: "Unsubmitted memory edit" } });
  doubles.memories.mockRejectedValueOnce(new Error("refresh failed"));
  await act(async () => {
    await client.invalidateQueries({ queryKey: homeKeys.memories() });
  });
  expect(await screen.findByRole("alert")).toHaveTextContent(tr("query.staleData"));
  expect(screen.getByRole("textbox")).toBe(editor);
  expect(editor).toHaveValue("Unsubmitted memory edit");
  expect(screen.queryByText(tr("memory.empty"))).not.toBeInTheDocument();
  fireEvent.click(
    within(screen.getByRole("alert")).getByRole("button", { name: tr("runtime.retry") }),
  );
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(screen.getByRole("textbox")).toBe(editor);
  expect(editor).toHaveValue("Unsubmitted memory edit");
});
