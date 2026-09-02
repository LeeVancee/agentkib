import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentToolSnapshot } from "@/core/types";
import { api } from "@/core/api";
import { acquireAgentToolsExecution, agentToolsKey, refreshAgentTools } from "./agent-tools-query";

vi.mock("@/core/api", () => ({
  api: { agentTools: vi.fn() },
}));

const snapshot: AgentToolSnapshot = {
  tools: [],
  checked_at: "2026-09-03T00:00:00Z",
  cache_status: "fresh",
  errors: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("agent tools query coordination", () => {
  beforeEach(() => vi.mocked(api.agentTools).mockReset());

  it("shares concurrent forced refreshes", async () => {
    const pending = deferred<AgentToolSnapshot>();
    vi.mocked(api.agentTools).mockReturnValueOnce(pending.promise);
    const firstClient = new QueryClient();
    const secondClient = new QueryClient();

    const first = refreshAgentTools(firstClient);
    const second = refreshAgentTools(secondClient);
    expect(api.agentTools).toHaveBeenCalledOnce();

    pending.resolve(snapshot);
    await expect(Promise.all([first, second])).resolves.toEqual([snapshot, snapshot]);
    expect(firstClient.getQueryData(agentToolsKey)).toBe(snapshot);
    expect(secondClient.getQueryData(agentToolsKey)).toBe(snapshot);
  });

  it("defers and merges refreshes while an execution owns the coordinator", async () => {
    vi.mocked(api.agentTools).mockResolvedValueOnce(snapshot);
    const release = await acquireAgentToolsExecution();
    expect(release).toBeTypeOf("function");
    const firstClient = new QueryClient();
    const secondClient = new QueryClient();

    const first = refreshAgentTools(firstClient);
    const second = refreshAgentTools(secondClient);
    expect(api.agentTools).not.toHaveBeenCalled();

    release?.();
    await expect(Promise.all([first, second])).resolves.toEqual([snapshot, snapshot]);
    expect(api.agentTools).toHaveBeenCalledOnce();
  });
});
