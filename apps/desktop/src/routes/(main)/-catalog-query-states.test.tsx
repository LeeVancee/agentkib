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
  },
}));
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
  { read: doubles.catalog, key: homeKeys.catalog(), label: "query.catalog", data: [asset] },
  {
    read: doubles.workspaces,
    key: homeKeys.workspaces(),
    label: "query.workspaces",
    data: [workspace],
  },
  { read: doubles.memories, key: homeKeys.memories(), label: "query.memories", data: [memory] },
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
  const view = render(
    <QueryClientProvider client={client}>
      <Suspense fallback={null}>
        <Component />
      </Suspense>
    </QueryClientProvider>,
  );
  return { client, ...view };
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

it.each(sources)(
  "does not disguise an initial $label failure as empty and retries only that dependency",
  async (source) => {
    source.read.mockRejectedValueOnce(new Error("unavailable"));
    start();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(tr(source.label));
    expect(alert).toHaveTextContent(tr("query.initialUnavailable"));
    expect(screen.queryByText(tr("catalog.noMatch"))).not.toBeInTheDocument();
    expect(screen.queryByText(tr("memory.empty"))).not.toBeInTheDocument();
    const initialCounts = sources.map(({ read }) => read.mock.calls.length);
    fireEvent.click(within(alert).getByRole("button", { name: tr("runtime.retry") }));
    await screen.findByRole("textbox", { name: tr("catalog.searchPlaceholder") });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    sources.forEach(({ read }, index) =>
      expect(read).toHaveBeenCalledTimes(initialCounts[index] + (read === source.read ? 1 : 0)),
    );
    expect(doubles.navigate).not.toHaveBeenCalled();
  },
);

it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
  "names all failed dependencies in %s without rendering invented zero counts",
  async (locale) => {
    await initializeI18n(locale);
    for (const source of sources) source.read.mockRejectedValue(new Error("unavailable"));
    start();
    await waitFor(() =>
      expect(within(screen.getByRole("alert")).getAllByRole("listitem")).toHaveLength(3),
    );
    const alert = screen.getByRole("alert");
    for (const source of sources) expect(alert).toHaveTextContent(tr(source.label));
    expect(alert).toHaveTextContent(tr("query.initialUnavailable"));
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.queryByText(tr("catalog.noMatch"))).not.toBeInTheDocument();
    expect(screen.queryByText(tr("memory.empty"))).not.toBeInTheDocument();
  },
);

it.each(sources)(
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
