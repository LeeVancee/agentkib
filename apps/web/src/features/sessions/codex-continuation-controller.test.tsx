import { act, cleanup, renderHook } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  WebClient,
  type ConversationEventPage,
  type ConversationSessionSummary,
  type Live,
  type ResolvedHistoryReference,
} from "@agentkib/web-client";
import { useSessionController } from "@/features/conversation/features/sessions/use-session-controller";
import {
  pendingScope,
  readPending,
  rememberPending,
} from "@/features/conversation/features/sessions/pending-controls";

vi.mock("@/features/conversation/features/preferences/use-appearance", () => ({
  useAppearance: () => {},
}));
vi.mock("@/features/conversation/features/sessions/use-session-live", () => ({
  useSessionLive: ({
    selected,
    streamReady,
    refreshRequired,
    hasDurablePending,
    setControlReady,
  }: {
    selected: string;
    streamReady: { current: boolean };
    refreshRequired: { current: boolean };
    hasDurablePending: (id: string) => boolean;
    setControlReady: (ready: boolean) => void;
  }) => {
    useEffect(() => {
      streamReady.current = !!selected;
      setControlReady(!!selected && !refreshRequired.current && !hasDurablePending(selected));
    }, [selected, streamReady, refreshRequired, hasDurablePending, setControlReady]);
  },
}));

const history: ConversationEventPage = { events: [], warnings: [] };
const summary = (
  id: string,
  agent: "codex" | "claude-code" = "codex",
): ConversationSessionSummary => ({
  id,
  agent,
  title: id,
  workspace_id: "workspace",
  availability: "readable",
  archived: false,
  sidechain: false,
});
const baseIdle = (sessionId: string, agent: "codex" | "claude-code" = "codex"): Live => ({
  sessionId,
  revision: 1,
  status: "idle",
  executionMode: agent === "codex" ? "codex-managed" : "claude-managed",
  sendEnabled: true,
  approvals: [],
  questions: [],
});
const baseOccupied = (sessionId: string, agent: "codex" | "claude-code" = "codex"): Live => ({
  ...baseIdle(sessionId, agent),
  status: "unsupported",
  sendEnabled: false,
  reason: agent === "codex" ? "codex-owner-busy" : "claude-owner-busy",
  ownershipReason: agent === "codex" ? "codex-owner-busy" : "claude-owner-busy",
});

function baseFixture(initial: Live, agent: "codex" | "claude-code") {
  const client = new WebClient();
  const scope = pendingScope(client.origin, "device");
  const sessions = [summary("original", agent), summary("other", agent)];
  const liveById = new Map<string, Live>([["original", initial]]);
  vi.spyOn(client, "access").mockResolvedValue({
    status: "approved",
    protocolVersion: 2,
    csrfToken: "synthetic-test",
    bootId: "boot",
    experimentalEnabled: true,
    device: {
      id: "device",
      name: "Browser",
      send: true,
      approve: true,
      manage: true,
      accessMode: "full",
    },
  });
  vi.spyOn(client, "catalog").mockImplementation(async () => ({
    indexEnabled: true,
    sessions: [...sessions],
  }));
  const events = vi.spyOn(client, "events").mockResolvedValue(history);
  const live = vi
    .spyOn(client, "live")
    .mockImplementation(async (id) => liveById.get(id) ?? baseIdle(id, agent));
  vi.spyOn(client, "stream").mockImplementation(() => () => {});
  const receipt = vi
    .spyOn(client, "receipt")
    .mockImplementation(async (requestId) => ({ found: false, requestId }));
  vi.spyOn(client, "sessionCapabilities").mockImplementation(async (sessionId) => ({
    sessionId,
    executionMode: agent === "codex" ? "codex-managed" : "claude-managed",
    status: "idle",
    features: { fork: { available: true } },
  }));
  const request = vi.spyOn(client, "request").mockImplementation(async (path) => {
    if (path === (agent === "codex" ? "codex/fork" : "managed/action")) {
      sessions.push(summary("forked", agent));
      return { accepted: true, sessionId: "forked" };
    }
    return { accepted: true };
  });
  return { client, scope, sessions, liveById, events, live, receipt, request };
}

async function open(host: ReturnType<typeof baseFixture>) {
  const view = renderHook(() => useSessionController({ client: host.client }));
  await act(async () => {});
  expect(view.result.current.sessions).toHaveLength(2);
  await act(async () => view.result.current.choose("original"));
  await act(async () => {});
  expect(view.result.current.capabilities?.features.fork?.available).toBe(true);
  return view;
}

beforeEach(() => sessionStorage.clear());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each(["codex", "claude-code"] as const)(
  "%s continuation in the production controller",
  (agent) => {
    const idle = (id: string) => baseIdle(id, agent);
    const occupied = (id: string) => baseOccupied(id, agent);
    const fixture = (initial = idle("original")) => baseFixture(initial, agent);
    const ownerReason = agent === "codex" ? "codex-owner-busy" : "claude-owner-busy";
    it("shows the pending first message while the host starts and clears it only after acceptance", async () => {
      const host = fixture();
      const { result } = await open(host);
      await act(async () => result.current.setMessage("First continued message"));
      let accept!: (value: { accepted: true }) => void;
      host.request.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            accept = resolve;
          }),
      );
      let sending!: Promise<boolean | undefined>;
      await act(async () => {
        sending = result.current.control("send");
      });
      expect(result.current.pendingSend).toMatchObject({
        sessionId: "original",
        text: "First continued message",
      });
      expect(result.current.message).toBe("First continued message");
      expect(result.current.canSend).toBe(false);
      expect(readPending(host.scope)).toEqual([
        expect.objectContaining({ sessionId: "original", kind: "send" }),
      ]);
      await act(async () => accept({ accepted: true }));
      await expect(sending).resolves.toBe(true);
      expect(result.current.pendingSend).toBeUndefined();
      expect(result.current.message).toBe("");
      expect(readPending(host.scope)).toEqual([]);
      expect(host.request).toHaveBeenCalledOnce();
    });
    it("preserves a rejected draft and clears its receipt after a not-dispatched writer conflict", async () => {
      const host = fixture();
      const { result } = await open(host);
      await act(async () => result.current.setMessage("  Keep this draft  "));
      host.request.mockImplementation(async (path) => {
        expect(path).toBe("send");
        expect(readPending(host.scope)).toEqual([
          expect.objectContaining({ sessionId: "original", kind: "send" }),
        ]);
        host.liveById.set("original", occupied("original"));
        throw new ApiError(409, ownerReason, "not-dispatched");
      });

      await act(async () => result.current.control("send"));

      expect(host.request).toHaveBeenCalledExactlyOnceWith(
        "send",
        expect.objectContaining({ sessionId: "original", text: "Keep this draft" }),
      );
      expect(result.current.message).toBe("  Keep this draft  ");
      expect(result.current.notice).toBe("notDispatched");
      expect(result.current.pendingSend).toBeUndefined();
      expect(result.current.live?.ownershipReason).toBe(ownerReason);
      expect(result.current.canSend).toBe(false);
      expect(readPending(host.scope)).toEqual([]);
    });

    it("checks an occupied session every four seconds and restores sending when its owner leaves", async () => {
      vi.useFakeTimers();
      const host = fixture(occupied("original"));
      const { result } = await open(host);
      expect(result.current.canSend).toBe(false);
      host.live.mockClear();
      host.liveById.set("original", idle("original"));

      await act(async () => vi.advanceTimersByTimeAsync(3999));
      expect(host.live).not.toHaveBeenCalled();
      await act(async () => vi.advanceTimersByTimeAsync(1));

      expect(host.live).toHaveBeenCalledExactlyOnceWith("original");
      expect(result.current.live?.ownershipReason).not.toBe(ownerReason);
      expect(result.current.canSend).toBe(true);
      expect(host.request).not.toHaveBeenCalled();
    });

    it("checks the new selection while an older session's occupancy read is still pending", async () => {
      const host = fixture(occupied("original"));
      host.liveById.set("other", occupied("other"));
      const { result } = await open(host);
      let finishOldRead!: (state: Live) => void;
      host.live.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOldRead = resolve;
          }),
      );
      let oldCheck!: Promise<void>;
      await act(async () => {
        oldCheck = result.current.checkContinuation();
      });
      expect(host.live).toHaveBeenLastCalledWith("original");
      await act(async () => result.current.choose("other"));
      expect(result.current.canSend).toBe(false);
      host.live.mockClear();
      host.liveById.set("other", idle("other"));

      await act(async () => result.current.checkContinuation());

      expect(host.live).toHaveBeenCalledExactlyOnceWith("other");
      expect(result.current.canSend).toBe(true);
      await act(async () => finishOldRead(occupied("original")));
      await oldCheck;
      expect(result.current.selected).toBe("other");
      expect(result.current.live?.sessionId).toBe("other");
      expect(result.current.canSend).toBe(true);
    });

    it("forks with the original draft and preserves edits made while the new branch loads", async () => {
      const host = fixture(occupied("original"));
      const { result } = await open(host);
      let finishHistory!: (page: ConversationEventPage) => void;
      host.events.mockImplementation(async (id) =>
        id === "forked"
          ? new Promise((resolve) => {
              finishHistory = resolve;
            })
          : history,
      );
      await act(async () => result.current.setMessage("  Original draft A  "));
      let completion!: Promise<string | undefined>;
      await act(async () => {
        completion = result.current.forkContinuation();
      });
      expect(result.current.selected).toBe("forked");
      expect(result.current.message).toBe("  Original draft A  ");
      expect(host.request).toHaveBeenCalledExactlyOnceWith(
        agent === "codex" ? "codex/fork" : "managed/action",
        expect.objectContaining({ sessionId: "original", requestId: expect.any(String) }),
      );
      await act(async () => result.current.setMessage("New branch draft B"));
      await act(async () => finishHistory(history));
      await expect(completion).resolves.toBe("forked");
      expect(result.current.message).toBe("New branch draft B");
      expect(readPending(host.scope)).toEqual([]);
    });

    it("transfers quoted history and file drafts once with the selected branch generation", async () => {
      const host = fixture(occupied("original"));
      const { result } = await open(host);
      const reference: ResolvedHistoryReference = {
        reference: {
          sessionId: "original",
          recordId: "record",
          chunkId: "chunk",
          sourceRevision: "revision",
          start: 0,
          end: 5,
          contentHash: "hash",
        },
        title: "Quoted history",
        agent,
        kind: "assistant",
        toolName: null,
        content: "quote",
      };
      const file = new File(["private draft"], "draft.txt");
      await act(async () => {
        result.current.setHistoryReferences([reference]);
        result.current.setMessage("");
      });
      await act(async () =>
        result.current.forkContinuation({
          files: [file],
          resources: [{ id: "source-only", name: "README", kind: "file", available: true }],
        }),
      );
      expect(result.current.selected).toBe("forked");
      expect(result.current.message).toBe("");
      expect(result.current.historyReferences).toEqual([reference]);
      expect(result.current.takeContinuationDraft("other")).toBeUndefined();
      const restored = result.current.takeContinuationDraft("forked");
      expect(restored?.files).toEqual([file]);
      expect(restored?.historyReferences).toEqual([reference]);
      expect(result.current.takeContinuationDraft("forked")).toBeUndefined();
      expect(host.request).toHaveBeenCalledOnce();
      expect(sessionStorage.getItem(host.scope) ?? "").not.toContain("private draft");
    });
    it("discards an unconsumed bundle when navigating away instead of restoring it on a later visit", async () => {
      const host = fixture(occupied("original"));
      const { result } = await open(host);
      const file = new File(["draft"], "old.txt");
      await act(async () => result.current.forkContinuation({ files: [file], resources: [] }));
      await act(async () => result.current.choose("other"));
      await act(async () => result.current.choose("forked"));
      expect(result.current.takeContinuationDraft("forked")).toBeUndefined();
    });
    it("does not complete stale branch navigation after switching away and back to the same branch", async () => {
      const host = fixture(occupied("original"));
      const { result } = await open(host);
      let finishFirstRead!: (page: ConversationEventPage) => void;
      let branchReads = 0;
      host.events.mockImplementation(async (id) =>
        id === "forked" && ++branchReads === 1
          ? new Promise((resolve) => {
              finishFirstRead = resolve;
            })
          : history,
      );
      await act(async () => result.current.setMessage("Original draft A"));
      let completion!: Promise<string | undefined>;
      await act(async () => {
        completion = result.current.forkContinuation();
      });
      expect(result.current.selected).toBe("forked");
      await act(async () => result.current.choose("other"));
      await act(async () => result.current.choose("forked"));
      await act(async () => result.current.setMessage("New selection draft B"));
      await act(async () => finishFirstRead(history));

      await expect(completion).resolves.toBeUndefined();
      expect(result.current.selected).toBe("forked");
      expect(result.current.message).toBe("New selection draft B");
      expect(host.request).toHaveBeenCalledOnce();
    });

    it("keeps an unknown request fenced when checking occupancy or requesting a fork", async () => {
      const host = fixture(occupied("original"));
      const requestId = crypto.randomUUID();
      rememberPending(host.scope, { requestId, sessionId: "original", kind: "send" });
      const { result } = await open(host);
      await act(async () => result.current.setMessage("Keep the fenced draft"));
      host.live.mockClear();

      await act(async () => result.current.checkContinuation());
      await act(async () => result.current.forkContinuation());

      expect(host.receipt).toHaveBeenCalledWith(requestId);
      expect(host.live).not.toHaveBeenCalled();
      expect(host.request).not.toHaveBeenCalled();
      expect(result.current.selected).toBe("original");
      expect(result.current.message).toBe("Keep the fenced draft");
      expect(result.current.canSend).toBe(false);
      expect(readPending(host.scope)).toEqual([
        expect.objectContaining({ requestId, sessionId: "original", kind: "send" }),
      ]);
    });
  },
);
