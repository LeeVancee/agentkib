// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
// Warm the real lazy module so this suite measures interaction, not the first transform deadline.
import "./conversation/conversation";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WebClient,
  type Access,
  type ConversationClientBridge,
  type Live,
} from "@agentkib/web-client";
import { initializeI18n, changeLocale, tr } from "@/core/i18n";
import type { AgentKind, ConversationSessionSummary, WorkspaceSummary } from "@/core/types";
import { useAppStore } from "@/stores/app-store";
import { useSessionHub } from "./SessionHubContext";
import { SessionHubPage } from "./SessionHubPage";
import { SessionWindowToolbar } from "./SessionWindowToolbar";
import { useSessionViewStore } from "./session-view-store";
import { codexCopy } from "./conversation/features/sessions/codex-copy";
import { useSessionController } from "./conversation/features/sessions/use-session-controller";

const doubles = vi.hoisted(() => ({
  client: undefined as WebClient | undefined,
  desktop: true,
  catalog: vi.fn(),
}));
vi.mock("@/core/conversation-bridge", () => ({
  createDesktopConversationClient: () => doubles.client,
  hasDesktopConversation: () => doubles.desktop,
}));
vi.mock("./SessionHubContext", () => ({ useSessionHub: vi.fn() }));
vi.mock("./conversation-catalog", () => ({ refreshConversationCatalog: doubles.catalog }));
vi.mock("@/core/api", () => ({
  api: {
    sessionSourceCapability: vi.fn(async () => ({ status: "unsupported" })),
    sessionEvents: vi.fn(async () => ({ events: [], warnings: [] })),
  },
}));
vi.mock("@/features/remote/remote-catalog-store", () => ({
  readRemoteHistory: vi.fn(async () => ({ events: [], warnings: [] })),
}));

const workspace = { id: "workspace", name: "Project", path: "/project" } as WorkspaceSummary;
let hub: ReturnType<typeof useSessionHub>;
function fixture(agent: AgentKind = "codex", files = true, readOnly = false) {
  const summary: ConversationSessionSummary = {
    id: "session",
    workspace_id: workspace.id,
    agent,
    title: "Review UI actions",
    availability: "readable",
    archived: false,
    sidechain: false,
    origin: "interactive",
  };
  const access: Access = {
    status: "approved",
    protocolVersion: 2,
    csrfToken: "test",
    bootId: "boot",
    experimentalEnabled: !readOnly,
    device: {
      id: "desktop",
      name: "Desktop",
      accessMode: "full",
      send: !readOnly,
      approve: !readOnly,
      manage: !readOnly,
      advancedControl: !readOnly,
      ...(files ? { files: true } : {}),
    },
  };
  const live: Live = {
    sessionId: summary.id,
    status: "idle",
    revision: 1,
    executionMode: agent === "claude-code" ? "claude-managed" : "codex-managed",
    sendEnabled: !readOnly,
    approvals: [],
    questions: [],
  };
  const request = vi.fn(async (path: string, _body?: unknown) => {
    const operation = path.split("?")[0];
    if (operation === "access") return access;
    if (operation === "catalog")
      return { indexEnabled: true, sessions: [summary], workspaces: [workspace] };
    if (operation === "events")
      return {
        events: [
          {
            id: "history",
            kind: "agent-message",
            content: "Loaded session body",
            attachment_count: 0,
            truncated: false,
          },
        ],
        warnings: [],
      };
    if (operation === "live") return live;
    if (operation === "codex/session-settings" || operation === "managed/settings")
      return {
        sessionId: summary.id,
        revision: 1,
        available: false,
        current: { modelId: "", effort: "", mode: "default" },
        defaults: { modelId: "", effort: "" },
        writable: {
          model: { available: false },
          effort: { available: false },
          mode: { available: false },
        },
        options: { models: [], collaborationModes: [], policies: [], serviceTiers: [] },
      };
    if (operation === "codex/goals" || operation === "managed/goals")
      return { sessionId: summary.id, revision: 1, available: false, actions: {} };
    if (operation.endsWith("/capabilities"))
      return {
        sessionId: summary.id,
        executionMode: live.executionMode,
        status: "idle",
        features: {
          send: { available: !readOnly },
          rename: { available: !readOnly },
          inspect: { available: true },
        },
      };
    if (operation === "files/workspaces")
      return { workspaces: [{ id: workspace.id, name: workspace.name }] };
    if (operation === "artifacts") return { artifacts: [] };
    return { available: false, data: [], models: [], workspaces: [], features: {} };
  });
  const bridge: ConversationClientBridge = {
    async request<T>(path: string, body?: unknown) {
      return (await request(path, body)) as T;
    },
    stream(id, handlers) {
      let closed = false;
      queueMicrotask(() => {
        if (closed) return;
        handlers.open();
        if (id)
          handlers.event(
            "session-event",
            JSON.stringify({
              protocolVersion: 2,
              subscriptionId: id,
              sessionId: id,
              runtimeBootId: "runtime",
              epoch: "epoch",
              seq: 0,
              cursor: "cursor",
              type: "snapshot",
              payload: { live: { ...live, sessionId: id } },
            }),
          );
      });
      return () => {
        closed = true;
      };
    },
    uploadAttachment: vi.fn(),
  };
  const client = new WebClient(undefined, { type: "same-origin" }, bridge);
  return { client, request, summary, live };
}
function setHub(selected: ConversationSessionSummary | undefined) {
  hub = {
    remoteHosts: [],
    remoteErrors: {},
    localEnabled: false,
    workspaces: [workspace],
    sessions: selected ? [selected] : [],
    filtered: selected ? [selected] : [],
    selected,
    selectedWorkspace: workspace,
    statuses: [],
    errors: {},
    loading: false,
    refreshing: false,
    ready: true,
    historyRevision: 0,
    conversationRefreshRevision: 0,
    runtimeReady: true,
    enabled: true,
    workspacesLoading: false,
    workspacesError: "",
    catalogError: "",
    hiddenSessionNotice: false,
    select: vi.fn(),
    selectionVersion: () => 0,
    refresh: vi.fn().mockResolvedValue(undefined),
    retryWorkspaces: vi.fn(),
  };
}
async function mount(
  f: ReturnType<typeof fixture>,
  selected: ConversationSessionSummary | null = f.summary,
) {
  doubles.client = f.client;
  doubles.catalog.mockResolvedValue([f.summary]);
  setHub(selected ?? undefined);
  const root = createRootRoute({
    component: () => (
      <>
        <SessionWindowToolbar />
        {hub.selected && <SessionHubPage />}
      </>
    ),
  });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
  });
}
function viewport(width: number) {
  vi.spyOn(window, "innerWidth", "get").mockReturnValue(width);
  vi.spyOn(window, "matchMedia").mockImplementation((media) => ({
    media,
    matches: media.includes("1280px") && width >= 1280,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  }));
}
const mutations = (f: ReturnType<typeof fixture>) =>
  f.request.mock.calls.filter(([, body]) => body !== undefined);
beforeAll(() => initializeI18n("en-US"));
beforeEach(() => {
  sessionStorage.clear();
  doubles.desktop = true;
  doubles.catalog.mockReset();
  useAppStore.getState().reset();
  useSessionViewStore.getState().setCreatingConversation(false);
  useSessionViewStore.getState().resetFilters();
  vi.mocked(useSessionHub).mockImplementation(() => hub);
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await changeLocale("en-US");
});

describe("desktop direct conversation tools", () => {
  it("does not replay a prior retirement from another client and shows a new retirement during this visit", async () => {
    const f = fixture("claude-code");
    Object.assign(f.live, {
      continuationNotice: "background-ended",
      continuationNoticeId: "old-retirement",
    });
    const { result } = renderHook(() => useSessionController({ client: f.client }));
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));
    await act(async () => result.current.choose("session"));
    expect(result.current.live?.continuationNotice).toBeNull();
    Object.assign(f.live, { continuationNoticeId: "new-retirement" });
    await act(async () => result.current.refresh());
    expect(result.current.live?.continuationNotice).toBe("background-ended");
    expect(result.current.live?.continuationNoticeId).toBe("new-retirement");
  });
  it.each([
    ["zh-CN", "文件与产物", "会话操作"],
    ["zh-TW", "檔案與產物", "對話操作"],
    ["en-US", "Files & artifacts", "Session actions"],
    ["ja-JP", "ファイルと成果物", "会話の操作"],
  ] as const)(
    "opens both real panels directly with keyboard at narrow width in %s and retains the draft",
    async (locale, filesName, actionsName) => {
      await changeLocale(locale);
      viewport(390);
      const f = fixture();
      await mount(f);
      await screen.findByText("Loaded session body");
      expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
      expect(document.querySelectorAll("[data-conversation-toolbar]")).toHaveLength(1);
      const files = screen.getByRole("button", { name: filesName });
      const actions = screen.getByRole("button", { name: actionsName });
      expect(files).toBeVisible();
      expect(actions).toBeVisible();
      expect(files.closest(".desktop-conversation")?.className).not.toMatch(
        /data-conversation-toolbar.*(?:hidden|h-0)/,
      );
      expect(screen.getAllByRole("button", { name: filesName })).toHaveLength(1);
      expect(screen.getAllByRole("button", { name: actionsName })).toHaveLength(1);
      const draft = screen.getByRole("textbox", { name: tr("conversation.message") });
      fireEvent.change(draft, { target: { value: "Keep this draft" } });
      const user = userEvent.setup();
      for (let tab = 0; tab < 12 && document.activeElement !== files; tab++) await user.tab();
      expect(files).toHaveFocus();
      await user.keyboard("{Enter}");
      expect(await screen.findByRole("dialog", { name: filesName })).toBeVisible();
      await waitFor(() =>
        expect(f.request.mock.calls.some(([path]) => path === "files/workspaces")).toBe(true),
      );
      await user.keyboard("{Escape}");
      await waitFor(() => expect(files).toHaveFocus());
      expect(files).toHaveAttribute("aria-expanded", "false");
      await user.tab();
      expect(actions).toHaveFocus();
      await user.keyboard(" ");
      expect(await screen.findByRole("dialog", { name: actionsName })).toBeVisible();
      expect(actions).toHaveAttribute("aria-expanded", "true");
      await user.keyboard("{Escape}");
      await waitFor(() => expect(actions).toHaveFocus());
      expect(draft).toHaveValue("Keep this draft");
      await user.click(screen.getByRole("button", { name: tr("common.moreActions") }));
      const menu = await screen.findByRole("menu");
      expect(within(menu).queryByRole("menuitem", { name: filesName })).toBeNull();
      expect(within(menu).queryByRole("menuitem", { name: actionsName })).toBeNull();
      expect(mutations(f)).toEqual([]);
    },
  );
  it.each(["claude-code", "antigravity"] as const)(
    "keeps the existing %s action panel reachable directly",
    async (agent) => {
      viewport(1440);
      const f = fixture(agent);
      await mount(f);
      await screen.findByText("Loaded session body");
      await userEvent.setup().click(screen.getByRole("button", { name: "Session actions" }));
      expect(await screen.findByRole("dialog", { name: "Session actions" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Details" })).toBeVisible();
      expect(mutations(f)).toEqual([]);
    },
  );
  it("omits files without the actual file grant and retains read-only inspection with write controls disabled", async () => {
    viewport(390);
    const f = fixture("codex", false, true);
    await mount(f);
    await screen.findByText("Loaded session body");
    expect(screen.queryByRole("button", { name: "Files & artifacts" })).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "Session actions" }));
    const dialog = await screen.findByRole("dialog", { name: "Session actions" });
    fireEvent.change(within(dialog).getByLabelText(codexCopy["en-US"].name), {
      target: { value: "Changed title" },
    });
    const rename = within(dialog).getByRole("button", { name: "Rename" });
    expect(rename).toBeDisabled();
    fireEvent.click(rename);
    expect(within(dialog).getByRole("button", { name: "Details" })).toBeEnabled();
    expect(f.request.mock.calls.some(([path]) => /^(files\/|artifacts)/.test(path))).toBe(false);
    expect(mutations(f)).toEqual([]);
  });
  it.each(["remote", "metadata", "unsupported-agent", "no-desktop", "no-selection"])(
    "does not register local tools for %s history",
    async (boundary) => {
      const f = fixture();
      const selected =
        boundary === "metadata"
          ? { ...f.summary, availability: "metadata-only" as const }
          : boundary === "unsupported-agent"
            ? { ...f.summary, agent: "cursor" as const }
            : boundary === "remote"
              ? {
                  ...f.summary,
                  remote: {
                    host_id: "remote-host",
                    host_name: "Host",
                    original_id: "session",
                    online: true,
                    last_synced_at: "2026-10-16T00:00:00Z",
                  },
                }
              : boundary === "no-selection"
                ? null
                : f.summary;
      if (boundary === "no-desktop") doubles.desktop = false;
      await mount(f, selected);
      expect(screen.queryByRole("button", { name: "Files & artifacts" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Session actions" })).toBeNull();
      expect(document.querySelector("[data-conversation-toolbar]")).toBeNull();
      expect(f.request).not.toHaveBeenCalled();
    },
  );
});
