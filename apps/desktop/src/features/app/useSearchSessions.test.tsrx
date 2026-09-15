/** @jsxImportSource octane */

// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@octanejs/testing-library";
import { QueryClient, QueryClientProvider } from "@octanejs/tanstack-query";
import type { ReactNode } from "octane";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import type { ConversationSessionSummary, WorkspaceSummary } from "@/core/types";
import { homeKeys } from "@/features/home/home-query";
import { useSearchSessions } from "./useSearchSessions";

vi.mock("@/core/api", () => ({
  api: {
    workspaceSessions: vi.fn(),
    refreshWorkspaceSessions: vi.fn(),
    workspaceSessionEvents: vi.fn(),
  },
}));

function session(id: string, title = id): ConversationSessionSummary {
  return {
    id: `session-${id}`,
    workspace_id: id,
    title,
    agent: "codex",
    archived: false,
    sidechain: false,
    availability: "readable",
  };
}
function workspace(id: string): WorkspaceSummary {
  return { id, name: "Same workspace" } as WorkspaceSummary;
}
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("useSearchSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.workspaceSessions).mockImplementation(async (id) => [session(id)]);
  });
  afterEach(cleanup);

  it("does not expose or read indexed data while closed or indexing is disabled", () => {
    const { client, wrapper } = setup();
    client.setQueryData(homeKeys.continuations("one"), [session("one")]);
    const { result } = renderHook(() => useSearchSessions([workspace("one")], false), { wrapper });
    expect(result.current.sessions).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(api.workspaceSessions).not.toHaveBeenCalled();
  });

  it("aggregates all distinct workspace IDs, including archived and metadata records, without scanning", async () => {
    const { wrapper } = setup();
    vi.mocked(api.workspaceSessions).mockImplementation(async (id) => [
      {
        ...session(id),
        archived: id === "archived",
        availability: id === "metadata" ? "metadata-only" : "readable",
      },
    ]);
    const list = [workspace("one"), workspace("archived"), workspace("metadata"), workspace("one")];
    const { result } = renderHook(() => useSearchSessions(list, true), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.sessions).toHaveLength(3);
    expect(api.workspaceSessions).toHaveBeenCalledTimes(3);
    expect(api.refreshWorkspaceSessions).not.toHaveBeenCalled();
  });

  it("reuses fresh cache on reopening and keeps results independent of workspace ordering", async () => {
    const { client, wrapper } = setup();
    client.setQueryData(homeKeys.continuations("one"), [session("one")]);
    const { result, rerender } = renderHook(
      ({ enabled, list }) => useSearchSessions(list, enabled),
      { wrapper, initialProps: { enabled: true, list: [workspace("one"), workspace("two")] } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.workspaceSessions).toHaveBeenCalledTimes(1);
    rerender({ enabled: false, list: [workspace("two"), workspace("one")] });
    expect(result.current.sessions).toEqual([]);
    rerender({ enabled: true, list: [workspace("two"), workspace("one")] });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.sessions).toHaveLength(2);
    expect(api.workspaceSessions).toHaveBeenCalledTimes(1);
  });

  it("preserves stale cache on a partial error and retries only failed workspaces", async () => {
    const { client, wrapper } = setup();
    client.setQueryData(homeKeys.continuations("one"), [session("one", "cached")], {
      updatedAt: 1,
    });
    vi.mocked(api.workspaceSessions).mockImplementation(async (id) => {
      if (id === "one") throw new Error("cache read failed");
      return [session(id)];
    });
    const { result } = renderHook(
      () => useSearchSessions([workspace("one"), workspace("two")], true),
      { wrapper },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.sessions).toHaveLength(2);
    expect(result.current.sessions.find(({ workspace_id }) => workspace_id === "one")?.title).toBe(
      "cached",
    );
    expect(result.current.errors.one).toContain("cache read failed");
    vi.mocked(api.workspaceSessions).mockResolvedValue([session("one", "recovered")]);
    await act(async () => result.current.retry());
    expect(result.current.errors).toEqual({});
    expect(api.workspaceSessions).toHaveBeenCalledTimes(3);
    expect(api.workspaceSessions).toHaveBeenLastCalledWith("one");
  });

  it("ignores obsolete results immediately on workspace changes or disabling indexing", async () => {
    const { client, wrapper } = setup();
    const old = deferred<ConversationSessionSummary[]>();
    vi.mocked(api.workspaceSessions).mockImplementation((id) =>
      id === "one" ? old.promise : Promise.resolve([session(id)]),
    );
    const { result, rerender } = renderHook(
      ({ enabled, id }) => useSearchSessions([workspace(id)], enabled),
      { wrapper, initialProps: { enabled: true, id: "one" } },
    );
    rerender({ enabled: true, id: "two" });
    await waitFor(() => expect(result.current.loading).toBe(false));
    rerender({ enabled: false, id: "two" });
    expect(result.current.sessions).toEqual([]);
    await act(async () => old.resolve([session("one")]));
    expect(client.getQueryData(homeKeys.continuations("one"))).toBeUndefined();
    expect(result.current.sessions).toEqual([]);
  });

  it("limits reads to four across reopen and skips queued reads after closing", async () => {
    const { wrapper } = setup();
    const pending = deferred<ConversationSessionSummary[]>();
    let active = 0;
    let maximum = 0;
    vi.mocked(api.workspaceSessions).mockImplementation(async (id) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await pending.promise;
      active -= 1;
      return [session(id)];
    });
    const list = Array.from({ length: 12 }, (_, index) => workspace(String(index)));
    const { result, rerender } = renderHook(({ enabled }) => useSearchSessions(list, enabled), {
      wrapper,
      initialProps: { enabled: true },
    });
    expect(api.workspaceSessions).toHaveBeenCalledTimes(4);
    rerender({ enabled: false });
    rerender({ enabled: true });
    expect(api.workspaceSessions).toHaveBeenCalledTimes(4);
    await act(async () => pending.resolve([]));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(maximum).toBe(4);
    expect(api.workspaceSessions).toHaveBeenCalledTimes(12);
    expect(result.current.sessions).toHaveLength(12);
  });

  it("does not overwrite a newer shared snapshot with an older pending read", async () => {
    const { client, wrapper } = setup();
    const pending = deferred<ConversationSessionSummary[]>();
    vi.mocked(api.workspaceSessions).mockReturnValue(pending.promise);
    const { result } = renderHook(() => useSearchSessions([workspace("one")], true), { wrapper });
    client.setQueryData(homeKeys.continuations("one"), [session("one", "new refresh")]);
    await act(async () => pending.resolve([session("one", "old read")]));
    expect(result.current.sessions[0].title).toBe("new refresh");
    expect(client.getQueryData(homeKeys.continuations("one"))).toEqual([
      session("one", "new refresh"),
    ]);
  });

  it("does not start queued reads or cache pending results once the dialog closes", async () => {
    const { client, wrapper } = setup();
    const pending = deferred<ConversationSessionSummary[]>();
    vi.mocked(api.workspaceSessions).mockReturnValue(pending.promise);
    const list = Array.from({ length: 8 }, (_, index) => workspace(String(index)));
    const { result, rerender } = renderHook(({ enabled }) => useSearchSessions(list, enabled), {
      wrapper,
      initialProps: { enabled: true },
    });
    expect(api.workspaceSessions).toHaveBeenCalledTimes(4);
    rerender({ enabled: false });
    await act(async () => pending.resolve([session("0")]));
    expect(api.workspaceSessions).toHaveBeenCalledTimes(4);
    expect(result.current.sessions).toEqual([]);
    expect(client.getQueryData(homeKeys.continuations("0"))).toBeUndefined();
  });
});
