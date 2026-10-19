import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexAppServerError,
  CodexAppServerSession,
} from "../../../packages/backend/src/codex-app-server";
import { CodexFollowerBridge } from "../../../packages/backend/src/codex-follower-bridge";
import { CodexRuntimePreflight } from "../../../packages/backend/src/codex-runtime-preflight";
import { readControlReceipt } from "../../../packages/backend/src/control-receipt";
import {
  claimManagedCommand,
  dispatchManagedCommand,
  readManagedRecord,
  readUnknownManagedCommands,
} from "../../../packages/backend/src/managed-ledger";
import { ManagedCodexState } from "../../../packages/backend/src/managed-codex-state";
import {
  acquireManagedSessionLease,
  acquirePortableFileLease,
} from "../../../packages/backend/src/managed-session-lock";
import type { SessionReaders } from "../../../packages/backend/src/session-readers";
import { BackendStore } from "../../../packages/backend/src/store";
import { WebReadRequests } from "../../../packages/backend/src/web-read";

const nativeId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const forkId = "aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff";
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agentkib-codex-auto-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"),
    workspace = path.join(root, "project");
  mkdirSync(home);
  mkdirSync(workspace);
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const executable = path.join(bin, process.platform === "win32" ? "codex.exe" : "codex");
  writeFileSync(executable, "fixture executable");
  chmodSync(executable, 0o700);
  const store = new BackendStore(path.join(root, "agentkib.db"));
  cleanups.push(() => store.close());
  store.sql.run(
    "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
    "workspace",
    workspace,
    "Fixture",
    "healthy",
    "2026-10-19T00:00:00Z",
  );
  const summary = {
    id: "indexed-session",
    workspace_id: "workspace",
    agent: "codex",
    title: "Original",
    sidechain: false,
    archived: false,
  };
  vi.spyOn(store.sessions, "get").mockImplementation((id) =>
    id === summary.id ? (summary as ReturnType<typeof store.sessions.get>) : undefined,
  );
  const readers = {
    codexHome: () => home,
    resolve: vi.fn(async () => ({
      summary,
      native: { agent: "codex", native_ref: nativeId },
      workspace,
    })),
    verifiedCodexControlIds: () => new Set([nativeId]),
  } as unknown as SessionReaders;
  const version = vi
    .spyOn(CodexRuntimePreflight.prototype, "check")
    .mockResolvedValue({ executable, reason: null });
  const follower = vi
    .spyOn(CodexFollowerBridge, "connect")
    .mockRejectedValue(new Error("must-not-follow-desktop"));
  let nativeFailure: unknown;
  const methods: string[] = [];
  const servers: OfflineServer[] = [];
  class OfflineServer extends EventEmitter {
    connected = true;
    closed = false;
    closeFailure?: Error;
    async request(method: string, params: unknown, dispatch?: () => void): Promise<unknown> {
      dispatch?.();
      methods.push(method);
      if (method === "thread/resume" && nativeFailure) throw nativeFailure;
      if (method === "model/list")
        return { data: [{ model: "model-a", isDefault: true, supportedReasoningEfforts: [] }] };
      if (method === "thread/goal/get") return { goal: null };
      if (method === "skills/list") return { data: [] };
      if (method === "thread/read")
        return {
          thread: {
            id: nativeId,
            cwd: workspace,
            status: { type: "idle" },
            turns: [{ id: "finished-turn", status: "completed", items: [] }],
          },
        };
      if (method === "turn/start") return { turn: { id: "new-turn", status: "inProgress" } };
      if (method === "turn/steer") return { turnId: "new-turn" };
      if (method === "thread/queue/add")
        return {
          queuedSubmission: {
            id: "queued",
            clientUserMessageId: (params as Record<string, unknown>).clientUserMessageId,
          },
        };
      if (method === "thread/queue/list") return { data: [], nextCursor: null };
      if (["thread/resume", "thread/start", "thread/fork"].includes(method))
        return {
          thread: {
            id: method === "thread/fork" ? forkId : nativeId,
            cwd: workspace,
            status: { type: "idle" },
            turns: [],
          },
          cwd: workspace,
          model: "model-a",
          reasoningEffort: null,
          serviceTier: null,
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: { type: "workspaceWrite", writableRoots: [workspace], networkAccess: false },
        };
      throw new Error(`unexpected-native-method:${method}`);
    }
    async close() {
      this.connected = false;
      if (this.closeFailure) throw this.closeFailure;
      this.closed = true;
      this.emit("close");
    }
    respond() {}
    complete() {
      this.emit("notification", {
        method: "turn/completed",
        params: { threadId: nativeId, turn: { id: "new-turn", status: "completed" } },
      });
    }
    activateGoal() {
      this.emit("notification", {
        method: "thread/goal/updated",
        params: { threadId: nativeId, goal: { objective: "Continue the task", status: "active" } },
      });
    }
  }
  const start = vi
    .spyOn(CodexAppServerSession, "start")
    .mockImplementation(
      async (_executable, _workspace, _home, _environment, _notification, onStarted) => {
        const server = new OfflineServer();
        onStarted?.(server as unknown as CodexAppServerSession);
        servers.push(server);
        return server as unknown as CodexAppServerSession;
      },
    );
  let observed = true;
  const web = new WebReadRequests(
    store,
    readers,
    root,
    () => 0n,
    { CODEX_HOME: home, PATH: bin },
    undefined,
    () => observed,
  );
  cleanups.push(() => web.closeAsync());
  const live = () =>
    web.request({ operation: "live", sessionId: summary.id, experimentalEnabled: true });
  const sendWithState = (
    state: Awaited<ReturnType<typeof live>>,
    fields: Record<string, unknown> = {},
  ) =>
    web.managedControl({
      operation: "send",
      sessionId: summary.id,
      requestId: randomUUID(),
      deviceId: "fixture",
      runtimeBootId: state.runtimeBootId,
      expectedRevision: state.revision,
      experimentalEnabled: true,
      text: "Continue",
      ...fields,
    });
  const send = async (fields: Record<string, unknown> = {}) => sendWithState(await live(), fields);
  return {
    root,
    home,
    workspace,
    summary,
    store,
    web,
    live,
    send,
    sendWithState,
    methods,
    servers,
    version,
    follower,
    start,
    setFailure: (error: unknown) => {
      nativeFailure = error;
    },
    leave: () => {
      observed = false;
    },
    observe: () => {
      observed = true;
    },
  };
}

describe("Codex automatic CLI continuation", () => {
  it("reads an inactive session without a runner and automatically adopts on send", async () => {
    const f = fixture();
    expect(await f.live()).toMatchObject({
      status: "idle",
      executionLocation: null,
      sendEnabled: true,
      ownershipReason: null,
    });
    expect(f.start).not.toHaveBeenCalled();
    expect(await f.send()).toMatchObject({ accepted: true });
    expect(f.methods).toContain("thread/resume");
    expect(f.methods).toContain("turn/start");
    expect(f.follower).not.toHaveBeenCalled();
    expect(await f.live()).toMatchObject({ executionLocation: "agentkib" });
  });

  it("reports a definite writer refusal without an unknown command or follower fallback", async () => {
    const f = fixture();
    f.setFailure(
      new CodexAppServerError({
        code: -32600,
        message: `thread ${nativeId} already has an active writer`,
      }),
    );
    const result = await f.send();
    expect(result).toMatchObject({
      accepted: false,
      completed: false,
      controlOutcome: "not-dispatched",
      reason: "codex-owner-busy",
    });
    expect(readUnknownManagedCommands(f.root, f.summary.id)).toEqual([]);
    expect(await f.live()).toMatchObject({
      executionLocation: "external",
      ownershipReason: "codex-owner-busy",
      sendEnabled: false,
    });
    expect(f.follower).not.toHaveBeenCalled();
    expect(f.methods).not.toContain("turn/start");
  });

  it("keeps an observed unknown outcome above a cached writer conflict in catalog without another ownership probe", async () => {
    const f = fixture();
    vi.spyOn(f.store.sessions, "list").mockReturnValue([
      f.summary as ReturnType<typeof f.store.sessions.list>[number],
    ]);
    const lockDirectory = path.join(f.home, "thread-writer-locks");
    mkdirSync(lockDirectory, { recursive: true });
    const release = acquirePortableFileLease(path.join(lockDirectory, `${nativeId}.lock`));
    cleanups.push(release);
    expect(await f.live()).toMatchObject({ reason: "codex-owner-busy" });
    const requestId = randomUUID();
    claimManagedCommand(f.root, requestId, f.summary.id, "synthetic-unknown", "fixture", {
      operation: "send",
    });
    dispatchManagedCommand(f.root, requestId);
    expect(await f.live()).toMatchObject({
      reason: "control-outcome-unconfirmed",
      sendEnabled: false,
    });
    f.version.mockClear();
    const methods = [...f.methods];
    const catalog = (await f.web.request({ operation: "catalog" })) as {
      sessions: Array<Record<string, unknown>>;
    };
    expect(catalog.sessions.find((row) => row.id === f.summary.id)?.continuation).toMatchObject({
      reason: "control-outcome-unconfirmed",
      ownershipReason: null,
    });
    expect(f.version).not.toHaveBeenCalled();
    expect(f.methods).toEqual(methods);
  });
  it("keeps a lost resume uncertain without stranding the original unsent message's receipt", async () => {
    const f = fixture();
    f.setFailure(new Error("Codex app-server request timed out"));
    const requestId = randomUUID();
    expect(await f.send({ requestId })).toMatchObject({
      requestId,
      controlOutcome: "not-dispatched",
      reason: "control-outcome-unconfirmed",
    });
    expect(readUnknownManagedCommands(f.root, f.summary.id)).toHaveLength(1);
    expect(readControlReceipt(f.root, { requestId, deviceId: "fixture" })).toMatchObject({
      found: true,
      status: "not-dispatched",
      operation: "send",
      ack: { controlOutcome: "not-dispatched" },
    });
    const child = readUnknownManagedCommands(f.root, f.summary.id)[0]!;
    expect(
      readControlReceipt(f.root, { requestId: child.requestId, deviceId: "fixture" }),
    ).toMatchObject({ found: true, status: "unknown" });
    expect(await f.live()).toMatchObject({
      reason: "control-outcome-unconfirmed",
      sendEnabled: false,
    });
    expect(await f.send()).toMatchObject({
      controlOutcome: "not-dispatched",
      reason: "control-outcome-unconfirmed",
    });
    expect(f.methods.filter((method) => method === "thread/resume")).toHaveLength(1);
    expect(f.follower).not.toHaveBeenCalled();
    expect(
      await f.web.managedReconcile({
        operation: "reconcile",
        sessionId: f.summary.id,
        requestId: randomUUID(),
        deviceId: "fixture",
      }),
    ).toMatchObject({ reconciled: true });
    expect(readUnknownManagedCommands(f.root, f.summary.id)).toEqual([]);
    expect(f.methods).not.toContain("turn/start");
    f.setFailure(undefined);
    expect(await f.send()).toMatchObject({ accepted: true });
    expect(f.methods.filter((method) => method === "turn/start")).toHaveLength(1);
  });

  it("forks a busy source through a reader without resuming or changing the source", async () => {
    const f = fixture();
    const directory = path.join(f.home, "thread-writer-locks");
    mkdirSync(directory);
    const release = acquirePortableFileLease(path.join(directory, `${nativeId}.lock`));
    cleanups.push(release);
    const state = await f.live();
    expect(state).toMatchObject({ reason: "codex-owner-busy" });
    const result = await f.web.managedControl({
      operation: "fork",
      sessionId: f.summary.id,
      requestId: randomUUID(),
      deviceId: "fixture",
      runtimeBootId: state.runtimeBootId,
      expectedRevision: state.revision,
      experimentalEnabled: true,
    });
    expect(result).toMatchObject({ accepted: true, sourceSessionId: f.summary.id });
    expect(f.methods).toContain("thread/read");
    expect(f.methods).toContain("thread/fork");
    expect(f.methods).not.toContain("thread/resume");
    expect(readManagedRecord(f.root, f.summary.id)).toBeNull();
    expect(f.follower).not.toHaveBeenCalled();
    const catalog = (await f.web.request({ operation: "catalog" })) as {
      sessions: Array<Record<string, unknown>>;
    };
    expect(catalog.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: result.sessionId,
          forked_from_session_id: f.summary.id,
        }),
      ]),
    );
  });

  it("releases after a completed turn is idle and automatically resumes an old released adoption", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.send();
    f.servers[0]!.complete();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(f.servers[0]!.connected).toBe(false);
    expect(readManagedRecord(f.root, f.summary.id)).toMatchObject({
      adopted: true,
      released: true,
    });
    expect(await f.live()).toMatchObject({ sendEnabled: true, executionLocation: null });
    expect(await f.send()).toMatchObject({ accepted: true });
    expect(f.methods.filter((method) => method === "thread/resume")).toHaveLength(2);
  });

  it.each([false, true])(
    "waits for the active turn after the last subscriber leaves, then releases (active goal: %s)",
    async (activeGoal) => {
      vi.useFakeTimers();
      const f = fixture();
      await f.send();
      if (activeGoal) f.servers[0]!.activateGoal();
      expect(await f.live()).toMatchObject({ status: "running" });
      f.leave();
      await vi.advanceTimersByTimeAsync(61_000);
      expect(f.servers[0]!.connected).toBe(true);
      expect(f.methods).not.toContain("turn/interrupt");
      f.servers[0]!.complete();
      if (activeGoal) expect(await f.live()).toMatchObject({ goal: { status: "active" } });
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.servers[0]!.connected).toBe(false);
      expect(readManagedRecord(f.root, f.summary.id)).toMatchObject({ released: true });
    },
  );

  it("preserves an idle active goal while a subscriber still observes the session", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.send();
    f.servers[0]!.activateGoal();
    f.servers[0]!.complete();
    expect(await f.live()).toMatchObject({ status: "idle", goal: { status: "active" } });
    await vi.advanceTimersByTimeAsync(61_000);
    expect(f.servers[0]!.connected).toBe(true);
    expect(f.methods).not.toContain("turn/interrupt");
  });

  it.each([
    ["spawn", false],
    ["spawn", true],
    ["preflight", false],
    ["preflight", true],
  ] as const)(
    "remembers a subscriber leaving during %s (active goal: %s)",
    async (phase, activeGoal) => {
      vi.useFakeTimers();
      const f = fixture();
      const state = await f.live();
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      if (phase === "spawn") {
        const implementation = f.start.getMockImplementation()!;
        f.start.mockImplementation(async (...args) => {
          entered();
          await gate;
          return implementation(...args);
        });
      } else {
        f.version.mockImplementationOnce(async () => {
          entered();
          await gate;
          return { reason: null };
        });
      }
      const pending = f.sendWithState(state);
      await started;
      f.leave();
      await vi.advanceTimersByTimeAsync(3000);
      release();
      expect(await pending).toMatchObject({ accepted: true });
      if (activeGoal) f.servers[0]!.activateGoal();
      await vi.advanceTimersByTimeAsync(61_000);
      expect(f.servers[0]!.connected).toBe(true);
      expect(f.methods).not.toContain("turn/interrupt");
      f.servers[0]!.complete();
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.servers[0]!.connected).toBe(false);
    },
  );

  it.each([false, true])(
    "does not invent a departing subscriber for background startup (active goal: %s)",
    async (activeGoal) => {
      vi.useFakeTimers();
      const f = fixture();
      f.leave();
      // Historical observations without a runner or an admitted control do not survive.
      f.web.observeSession(f.summary.id);
      await f.send();
      if (activeGoal) f.servers[0]!.activateGoal();
      f.servers[0]!.complete();
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.servers[0]!.connected).toBe(true);
      await vi.advanceTimersByTimeAsync(61_000);
      expect(f.servers[0]!.connected).toBe(activeGoal);
      expect(f.methods).not.toContain("turn/interrupt");
    },
  );

  it("records a short subscription during startup until the last concurrent control finishes", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.leave();
    const state = await f.live();
    const implementation = f.start.getMockImplementation()!;
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.start.mockImplementation(async (...args) => {
      entered();
      await gate;
      return implementation(...args);
    });
    const pending = f.sendWithState(state);
    await started;
    f.web.observeSession(f.summary.id);
    expect(await f.sendWithState(state, { operation: "stop" })).toMatchObject({
      accepted: false,
      controlOutcome: "not-dispatched",
    });
    release();
    expect(await pending).toMatchObject({ accepted: true });
    f.servers[0]!.activateGoal();
    f.servers[0]!.complete();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.servers[0]!.connected).toBe(false);
    expect(f.methods).not.toContain("turn/interrupt");
  });

  it("retains a short subscription between constructing and registering the startup runner", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.leave();
    const state = await f.live();
    const hydrate = ManagedCodexState.prototype.hydrate;
    let observed = false;
    vi.spyOn(ManagedCodexState.prototype, "hydrate").mockImplementationOnce(function (
      this: ManagedCodexState,
      ...args
    ) {
      const result = hydrate.apply(this, args);
      // Attach constructs its return value synchronously after hydration; this
      // runs before its awaiting caller can register that runner.
      queueMicrotask(() => {
        observed = true;
        f.web.observeSession(f.summary.id);
      });
      return result;
    });
    expect(await f.sendWithState(state)).toMatchObject({ accepted: true });
    expect(observed).toBe(true);
    f.servers[0]!.activateGoal();
    f.servers[0]!.complete();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.servers[0]!.connected).toBe(false);
    expect(f.methods).not.toContain("turn/interrupt");
  });

  it.each(["subscription", "live"] as const)(
    "records an existing runner observation through %s before the next timer tick",
    async (via) => {
      vi.useFakeTimers();
      const f = fixture();
      f.leave();
      await f.send();
      if (via === "subscription") f.web.observeSession(f.summary.id);
      else {
        f.observe();
        await f.live();
        f.leave();
      }
      f.servers[0]!.activateGoal();
      f.servers[0]!.complete();
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.servers[0]!.connected).toBe(false);
    },
  );

  it("keeps the runner and lease fenced when shutdown is not confirmed, then cleans up on real close", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.send();
    const server = f.servers[0]!;
    server.complete();
    server.closeFailure = new Error("process did not close after termination");
    await vi.advanceTimersByTimeAsync(61_000);
    expect(server.connected).toBe(false);
    expect(await f.live()).toMatchObject({
      reason: "control-outcome-unconfirmed",
      executionLocation: "agentkib",
      sendEnabled: false,
    });
    expect(() => acquireManagedSessionLease(f.root, f.summary.id)).toThrow(
      "session-managed-by-another-runtime",
    );
    expect(await f.send()).toMatchObject({
      controlOutcome: "not-dispatched",
      reason: "control-outcome-unconfirmed",
    });
    server.closed = true;
    server.emit("close");
    const release = acquireManagedSessionLease(f.root, f.summary.id);
    release();
    expect(await f.live()).toMatchObject({ executionLocation: null, sendEnabled: true });
  });

  it("keeps an old CLI read only and rejects sending with a correlated reason", async () => {
    const f = fixture();
    f.version.mockResolvedValue({
      executable: "/fixture/codex",
      reason: "codex-cli-version-too-old",
    });
    expect(await f.live()).toMatchObject({
      sendEnabled: false,
      reason: "codex-cli-version-too-old",
    });
    expect(await f.send()).toMatchObject({
      controlOutcome: "not-dispatched",
      reason: "codex-cli-version-too-old",
    });
    expect(f.start).not.toHaveBeenCalled();
  });

  it("refreshes ownership after the other writer leaves without changing the source", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const directory = path.join(f.home, "thread-writer-locks");
    mkdirSync(directory);
    const release = acquirePortableFileLease(path.join(directory, `${nativeId}.lock`));
    try {
      expect(await f.live()).toMatchObject({ ownershipReason: "codex-owner-busy" });
    } finally {
      release();
    }
    await vi.advanceTimersByTimeAsync(4000);
    expect(await f.live()).toMatchObject({
      ownershipReason: null,
      executionLocation: null,
      sendEnabled: true,
    });
    expect(f.start).not.toHaveBeenCalled();
  });

  it("uses metadata-only app-server readers for inspection, settings, resources and goals", async () => {
    const f = fixture();
    expect(
      await f.web.managedReconcile({
        operation: "reconcile",
        sessionId: f.summary.id,
        deviceId: "fixture",
        requestId: randomUUID(),
      }),
    ).toMatchObject({ reconciled: true });
    expect(
      await f.web.managedSettingsState({ operation: "settings-state", sessionId: f.summary.id }),
    ).toMatchObject({ available: true });
    expect(await f.web.request({ operation: "resources", sessionId: f.summary.id })).toMatchObject({
      available: true,
      executionMode: "codex-managed",
    });
    expect(await f.web.request({ operation: "goal", sessionId: f.summary.id })).toMatchObject({
      available: true,
      executionMode: "codex-managed",
    });
    expect(f.methods).not.toContain("thread/resume");
    expect(f.follower).not.toHaveBeenCalled();
    expect(f.servers.every((server) => !server.connected)).toBe(true);
  });

  it("preserves native steering and automatically consumed queue operations", async () => {
    const f = fixture();
    await f.send();
    const state = await f.live();
    const base = {
      sessionId: f.summary.id,
      deviceId: "fixture",
      runtimeBootId: state.runtimeBootId,
      expectedRevision: state.revision,
      experimentalEnabled: true,
      turnId: "new-turn",
      text: "More",
    };
    expect(
      await f.web.managedControl({ ...base, operation: "steer", requestId: randomUUID() }),
    ).toMatchObject({ accepted: true });
    expect(
      await f.web.managedControl({ ...base, operation: "queue-add", requestId: randomUUID() }),
    ).toMatchObject({ accepted: true });
    expect(f.methods).toContain("turn/steer");
    expect(f.methods).toContain("thread/queue/add");
  });

  it("keeps a missing CLI distinct from an old CLI", async () => {
    const f = fixture();
    f.version.mockResolvedValue({ reason: "codex-cli-unavailable" });
    expect(await f.live()).toMatchObject({ reason: "codex-cli-unavailable", sendEnabled: false });
    expect(await f.send()).toMatchObject({
      controlOutcome: "not-dispatched",
      reason: "codex-cli-unavailable",
    });
    expect(f.start).not.toHaveBeenCalled();
  });
});
