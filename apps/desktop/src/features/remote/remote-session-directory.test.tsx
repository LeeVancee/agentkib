// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteStatus } from "@/core/remote-types";
import type { RuntimeInfo } from "@/core/types";
import { initializeI18n } from "@/core/i18n";
import { useAppStore } from "@/stores/app-store";
import { SessionHubProvider, useSessionHub } from "@/features/sessions/SessionHubContext";
import { useSessionViewStore } from "@/features/sessions/session-view-store";
import { invalidateRemoteHost, refreshRemoteCatalog, remoteRecordId } from "./remote-catalog-store";
import { useRemoteStore } from "./remote-store";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  navigate: vi.fn(),
  search: {} as { sessionId?: string },
  workspaces: [],
  sessions: [],
}));
vi.mock("@/core/api", () => ({ api: { remoteRequest: mocks.request } }));
vi.mock("@/core/useI18n", () => ({ useI18n: () => ({ localizeMessage: String }) }));
vi.mock("@/core/conversation-bridge", () => ({ hasDesktopConversation: () => false }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  useSearch: () => mocks.search,
}));
vi.mock("@/features/home/home-query", () => ({
  useHomeWorkspaces: () => ({ data: mocks.workspaces, isPending: false, refetch: vi.fn() }),
}));
vi.mock("@/features/sessions/useSessionCatalog", () => ({
  useSessionCatalog: () => ({
    sessions: mocks.sessions,
    ready: true,
    refreshing: false,
    errors: {},
    refresh: vi.fn(),
  }),
}));
vi.mock("@/features/sessions/conversation-catalog", () => ({
  useConversationCatalog: () => ({ sessions: mocks.sessions, ready: true }),
  refreshConversationCatalog: vi.fn(),
}));

const hostId = "paired-host";
const status: RemoteStatus = {
  local: { id: "local", name: "Controller", enabled: false, address: null },
  interfaces: [],
  discovered: [],
  pending: [],
  authorized: [],
  connections: [
    {
      id: hostId,
      name: "Host",
      address: "192.168.1.3:42987",
      status: "online",
      last_seen: 1,
      error: null,
    },
  ],
  pairing_code: null,
  pairing_expires_at: null,
};
const base = {
  workspace_id: "workspace",
  agent: "codex",
  archived: false,
  sidechain: false,
  availability: "readable",
};
const serverCatalog = {
  workspaces: [{ id: "workspace", name: "Project", path: "/project" }],
  sessions: [
    { ...base, id: "managed-native-index", title: "Managed continuation", origin: "interactive" },
    { ...base, id: "unowned-exec", title: "Execution", origin: "execution" },
    { ...base, id: "auxiliary", title: "Auxiliary", origin: "auxiliary" },
    { ...base, id: "unknown", title: "Unknown source", origin: "unknown" },
  ],
};

function Directory() {
  const hub = useSessionHub();
  return (
    <>
      {hub.hiddenSessionNotice && <p>Hidden record notice</p>}
      <output data-testid="selected">{hub.selected?.id ?? "none"}</output>
      <output data-testid="original">{hub.selected?.remote?.original_id ?? "none"}</output>
      {hub.filtered.map(({ id, title }) => (
        <button key={id}>{title}</button>
      ))}
    </>
  );
}

describe("paired remote native index links", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(async () => {
    vi.clearAllMocks();
    invalidateRemoteHost(hostId);
    mocks.search = {};
    useAppStore.getState().setRuntime({ session_index_enabled: false } as RuntimeInfo);
    useSessionViewStore.getState().resetFilters();
    useRemoteStore.setState({ snapshot: status });
    mocks.request.mockResolvedValue(serverCatalog);
    await refreshRemoteCatalog(hostId, true);
  });
  afterEach(() => {
    cleanup();
    invalidateRemoteHost(hostId);
  });

  it("opens the original native alias link after server ownership projection without rewriting its ID", () => {
    const nativeId = "managed-native-index";
    const originalLink = remoteRecordId(hostId, nativeId);
    mocks.search = { sessionId: originalLink };
    render(
      <SessionHubProvider>
        <Directory />
      </SessionHubProvider>,
    );
    expect(screen.getByTestId("selected").textContent).toBe(originalLink);
    expect(screen.getByTestId("original").textContent).toBe(nativeId);
    expect(screen.getByRole("button", { name: "Managed continuation" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Unknown source" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Execution" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Auxiliary" })).toBeNull();
    expect(screen.queryByText("Hidden record notice")).toBeNull();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it.each(["unowned-exec", "auxiliary"])(
    "returns a hidden %s native index link to the directory",
    (nativeId) => {
      mocks.search = { sessionId: remoteRecordId(hostId, nativeId) };
      render(
        <SessionHubProvider>
          <Directory />
        </SessionHubProvider>,
      );
      expect(screen.getByTestId("selected").textContent).toBe("none");
      expect(screen.getByText("Hidden record notice")).toBeTruthy();
      expect(mocks.navigate).toHaveBeenCalledOnce();
      expect(mocks.navigate.mock.calls[0][0].search(mocks.search)).toEqual({
        sessionId: undefined,
      });
      expect(mocks.request).toHaveBeenCalledExactlyOnceWith({ operation: "catalog", id: hostId });
    },
  );
});
