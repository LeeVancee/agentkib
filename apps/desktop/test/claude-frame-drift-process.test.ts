import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClaudeManagedRunnerProcess,
  ClaudeRunnerState,
  type ClaudeRunnerOptions,
} from "../../../packages/backend/src/claude-managed-runner";
import { ClaudeManagedReadOwner } from "../../../packages/backend/src/claude-managed-read";
import {
  claimManagedCommand,
  dispatchManagedCommand,
} from "../../../packages/backend/src/managed-ledger";
import type { BackendStore } from "../../../packages/backend/src/store";
import type { SessionReaders } from "../../../packages/backend/src/session-readers";
import type { Commands } from "../../../packages/backend/src/commands";
import { createFakeClaude, processAlive, type FakeClaudePlan } from "./fixtures/claude-fake-cli";

// The runner and the host against a scripted stand-in for the CLI that plays hand-made frames.
// No real Claude session is started; that a real CLI sends these frames in this form is NOT
// verified (the shapes still to confirm are listed in docs/CLAUDE-WEB.md).

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Fake = ReturnType<typeof createFakeClaude>;
function fake(plan: FakeClaudePlan = {}) {
  const f = createFakeClaude();
  f.setPlan(plan);
  cleanups.push(() => rmSync(f.root, { recursive: true, force: true }));
  return f;
}
type Event = { type: string; payload: Record<string, any> };
function runnerFor(
  f: Fake,
  options: ClaudeRunnerOptions = {},
  environment: NodeJS.ProcessEnv = f.environment,
) {
  const events: Event[] = [];
  const runner = new ClaudeManagedRunnerProcess(
    f.workspace,
    randomUUID(),
    true,
    0,
    environment,
    () => undefined,
    true,
    (type, payload) => events.push({ type, payload }),
    options,
  );
  cleanups.push(async () => {
    await runner.shutdown().catch(() => undefined);
  });
  return { runner, events };
}
const send = (f: Fake, runner: ClaudeManagedRunnerProcess) =>
  runner.send(f.executable, "synthetic turn", randomUUID(), runner.snapshot().revision);
const settle = (runner: ClaudeManagedRunnerProcess, status: string) =>
  expect.poll(() => runner.snapshot().status, { timeout: 15_000 }).toBe(status);
/** The control responses the fake CLI received on stdin. */
const answers = (f: Fake) => f.frames().filter((frame) => frame.type === "control_response");

const cliFrame = (extra: Record<string, unknown>) => ({
  type: "assistant",
  parent_tool_use_id: null,
  ...extra,
});
const mainBash = (id: string) =>
  cliFrame({
    message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: "sleep 600" } }] },
  });
const result = {
  type: "result",
  subtype: "success",
  is_error: false,
  terminal_reason: "completed",
};

describe.skipIf(!["darwin", "linux"].includes(process.platform))(
  "managed Claude process against frames it does not follow",
  () => {
    it("ignores an unknown frame type, finishes the turn, and writes one log line per type", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const f = fake({ onUser: [{ type: "future_frame" }, { type: "future_frame" }] });
      const { runner } = runnerFor(f, { cliVersion: "2.1.296 (Claude Code)" });
      await send(f, runner);
      await settle(runner, "idle");
      expect(runner.snapshot()).toMatchObject({ lastOutcome: "succeeded", reason: null });
      expect(runner.hasWorker).toBe(true);
      expect(runner.protocolDiagnostics).toEqual({ ignoredFrameTypes: { future_frame: 2 } });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        'Claude Code protocol: ignored frame type "future_frame" (Claude Code 2.1.296)',
      );
    }, 30_000);

    it("goes on when the log line cannot be written", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {
        throw new Error("stderr is gone");
      });
      const f = fake({ onUser: [{ type: "future_frame" }] });
      const { runner } = runnerFor(f);
      await send(f, runner);
      await settle(runner, "idle");
      expect(runner.snapshot()).toMatchObject({ lastOutcome: "succeeded", reason: null });
      expect(runner.hasWorker).toBe(true);
    }, 30_000);

    it("answers an unknown control request with an error before the turn goes on", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const f = fake({
        onUser: [
          {
            type: "control_request",
            request_id: "req-unknown-1",
            request: { subtype: "hook_callback", callback_id: "cb-1", input: { any: "thing" } },
          },
          { __wait: "req-unknown-1" },
        ],
      });
      const { runner } = runnerFor(f);
      await send(f, runner);
      await settle(runner, "idle");
      // The turn can only have finished because the answer reached the CLI first.
      expect(runner.snapshot()).toMatchObject({ lastOutcome: "succeeded", reason: null });
      expect(answers(f)).toEqual([
        {
          type: "control_response",
          response: {
            subtype: "error",
            request_id: "req-unknown-1",
            error: "This request is not supported by AgentKib managed sessions.",
          },
        },
      ]);
      expect(JSON.stringify(f.frames())).not.toContain('"behavior":"allow"');
      expect(runner.protocolDiagnostics.refusedRequests).toEqual({ hook_callback: 1 });
    }, 30_000);

    it("denies a tool that needs its own interface instead of approving it", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const f = fake({
        onUser: [
          {
            type: "control_request",
            request_id: "req-ui-1",
            request: {
              subtype: "can_use_tool",
              tool_name: "ExitPlanMode",
              input: { plan: "do things" },
              tool_use_id: "toolu_plan",
              requires_user_interaction: true,
            },
          },
          { __wait: "req-ui-1" },
        ],
      });
      const { runner } = runnerFor(f);
      await send(f, runner);
      await settle(runner, "idle");
      expect(runner.snapshot()).toMatchObject({ lastOutcome: "succeeded", approvals: [] });
      expect(answers(f)).toEqual([
        {
          type: "control_response",
          response: {
            subtype: "success",
            request_id: "req-ui-1",
            response: {
              behavior: "deny",
              message: expect.stringContaining("Claude Code terminal"),
            },
          },
        },
      ]);
      expect(JSON.stringify(f.frames())).not.toContain('"behavior":"allow"');
    }, 30_000);

    it("shows a permission request with an unknown field, and answers it only when the user decides", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const f = fake({
        onUser: [
          {
            type: "control_request",
            request_id: "req-mcp-1",
            request: {
              subtype: "can_use_tool",
              tool_name: "mcp__docs__search",
              input: { query: "x" },
              tool_use_id: "toolu_mcp",
              mcp_server: { name: "docs" },
            },
          },
          { __wait: "req-mcp-1" },
        ],
      });
      const { runner } = runnerFor(f);
      await send(f, runner);
      await settle(runner, "waiting-approval");
      expect(runner.snapshot().approvals).toMatchObject([
        { requestId: "req-mcp-1", context: { mcp_server: '{"name":"docs"}' } },
      ]);
      expect(answers(f)).toEqual([]);
      const snapshot = runner.snapshot();
      await runner.approve("req-mcp-1", snapshot.turnId, "allow", snapshot.revision);
      await settle(runner, "idle");
      expect(answers(f)).toEqual([
        {
          type: "control_response",
          response: {
            subtype: "success",
            request_id: "req-mcp-1",
            response: { behavior: "allow", updatedInput: { query: "x" } },
          },
        },
      ]);
    }, 30_000);

    it("starts the CLI with background tasks off, over a value in the user's environment", async () => {
      const f = fake();
      const { runner } = runnerFor(
        f,
        {},
        {
          ...f.environment,
          CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "0",
        },
      );
      await send(f, runner);
      await settle(runner, "idle");
      expect(f.frames()[0]).toMatchObject({ env: { background: "1" } });
    }, 30_000);

    it("keeps a sub-agent's prompt out of the conversation and still shows its tool calls", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const promptId = randomUUID();
      const spawn = "toolu_agent";
      const f = fake({
        onUser: [
          cliFrame({
            message: { content: [{ type: "tool_use", id: spawn, name: "Agent", input: {} }] },
          }),
          {
            type: "user",
            parent_tool_use_id: spawn,
            uuid: promptId,
            message: { role: "user", content: "the prompt that drives the sub-agent" },
          },
          cliFrame({
            parent_tool_use_id: spawn,
            uuid: randomUUID(),
            message: {
              id: randomUUID(),
              content: [
                { type: "text", text: "sub-agent narration" },
                { type: "tool_use", id: "toolu_sub_read", name: "Read", input: {} },
              ],
            },
          }),
          {
            type: "user",
            parent_tool_use_id: spawn,
            message: {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: "toolu_sub_read", content: "ok" }],
            },
          },
          {
            type: "user",
            parent_tool_use_id: null,
            message: {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: spawn, content: "done" }],
            },
          },
        ],
      });
      const { runner, events } = runnerFor(f);
      await send(f, runner);
      await settle(runner, "idle");
      const items = events.flatMap(({ type, payload }) =>
        type === "item-upsert" ? [payload] : type === "snapshot" ? (payload.items ?? []) : [],
      ) as Array<Record<string, any>>;
      expect(items.some((item) => item.kind === "user-message")).toBe(false);
      expect(items.some((item) => JSON.stringify(item).includes("sub-agent narration"))).toBe(
        false,
      );
      expect(items.filter((item) => item.id === "toolu_sub_read").at(-1)).toMatchObject({
        kind: "tool-summary",
        tool_name: "Read",
        tool_status: "completed",
      });
      expect(items.filter((item) => item.id === spawn).at(-1)).toMatchObject({
        tool_name: "Agent",
        tool_status: "completed",
      });
      expect(runner.snapshot()).toMatchObject({ lastOutcome: "succeeded", streamText: "" });
    }, 30_000);
  },
);

describe.skipIf(!["darwin", "linux"].includes(process.platform))(
  "managed Claude process that has to stop",
  () => {
    const backgroundBash = (detached: boolean): FakeClaudePlan => ({
      onUser: [
        { __spawn: "same" },
        ...(detached ? [{ __spawn: "detached", detached: true }] : []),
        mainBash("toolu_bg"),
        {
          type: "system",
          subtype: "task_started",
          task_id: "bg-task",
          tool_use_id: "toolu_bg",
          task_type: "local_bash",
          is_backgrounded: true,
        },
      ],
      noResult: true,
    });
    // Only the macOS owned-tree cleanup is specified to reach a child that left the process group.
    const detached = process.platform === "darwin";

    it("stops for a background Bash command with a stated reason and cleans up the whole process tree", async () => {
      const f = fake(backgroundBash(detached));
      const { runner } = runnerFor(f);
      await send(f, runner).catch(() => undefined);
      await settle(runner, "outcome-unknown");
      expect(runner.snapshot().reason).toMatch(/^claude-background-task: /);
      expect(runner.snapshot()).toMatchObject({ sendEnabled: false, stopEnabled: false });
      const pids = ["same", ...(detached ? ["detached"] : [])].map((name) => f.childPid(name)!);
      expect(pids.every((pid) => typeof pid === "number")).toBe(true);
      await expect.poll(() => runner.hasWorker, { timeout: 10_000 }).toBe(false);
      for (const pid of pids)
        await expect.poll(() => processAlive(pid), { timeout: 8000 }).toBe(false);
      expect(runner.cleanupError).toBeNull();
    }, 40_000);

    it("names the version only when the CLI is newer than the verified one", async () => {
      for (const [version, newer] of [
        ["2.1.300 (Claude Code)", true],
        ["2.1.299 (Claude Code)", false],
        [undefined, false],
      ] as const) {
        const f = fake(backgroundBash(false));
        const { runner } = runnerFor(f, version ? { cliVersion: version } : {});
        await send(f, runner).catch(() => undefined);
        await settle(runner, "outcome-unknown");
        const reason = runner.snapshot().reason!;
        expect(reason.startsWith("claude-background-task: ")).toBe(true);
        expect(reason.includes("newer than the 2.1.299 AgentKib verified")).toBe(newer);
        await runner.shutdown().catch(() => undefined);
      }
    }, 60_000);

    it.each<[string, unknown[], string]>([
      [
        "a result with no turn open",
        [result, result],
        "claude-unrequested-turn: Claude result outside an active turn",
      ],
      [
        "a content frame while idle",
        [result, cliFrame({ message: { content: [{ type: "text", text: "late" }] } })],
        "claude-unrequested-turn: Claude assistant frame outside an active turn",
      ],
      ["a line that is not JSON", [{ __raw: "this is not json" }], "claude-protocol-violation: "],
      [
        "a frame for another session",
        [cliFrame({ session_id: randomUUID(), message: { content: [] } })],
        "claude-protocol-violation: Claude session ID changed unexpectedly",
      ],
      [
        "a damaged text delta",
        [
          {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: 5 },
            },
          },
        ],
        "claude-protocol-violation: invalid Claude text delta",
      ],
      [
        "a frame over the 25 MiB limit",
        [{ __huge: true }],
        "claude-protocol-violation: Claude frame exceeds 25 MiB",
      ],
      [
        "a control request that cannot be classified",
        [{ type: "control_request", request_id: "r", request: { subtype: 7 } }],
        "claude-protocol-violation: invalid Claude control request",
      ],
      [
        "a control response nobody asked for",
        [{ type: "control_response", response: { subtype: "success", request_id: "nobody" } }],
        "claude-protocol-violation: unexpected Claude control response",
      ],
    ])(
      "stops for %s with the code that explains it",
      async (_label, frames, reason) => {
        const f = fake({ onUser: frames, noResult: true });
        const { runner } = runnerFor(f);
        await send(f, runner).catch(() => undefined);
        await settle(runner, "outcome-unknown");
        expect(runner.snapshot().reason?.startsWith(reason)).toBe(true);
        await expect.poll(() => runner.hasWorker, { timeout: 10_000 }).toBe(false);
      },
      40_000,
    );

    it("gives an error nobody classified the protocol-violation code, whatever throws it", async () => {
      const original = ClaudeRunnerState.prototype.frame;
      vi.spyOn(ClaudeRunnerState.prototype, "frame").mockImplementation(function (
        this: ClaudeRunnerState,
        frame: unknown,
      ) {
        if ((frame as { type?: string })?.type === "future_x") throw new Error("synthetic failure");
        return original.call(this, frame);
      });
      const f = fake({ onUser: [{ type: "future_x" }], noResult: true });
      const { runner } = runnerFor(f);
      await send(f, runner).catch(() => undefined);
      await settle(runner, "outcome-unknown");
      expect(runner.snapshot().reason).toBe("claude-protocol-violation: synthetic failure");
    }, 40_000);

    it("leaves the failures that are not the CLI's output without a code", async () => {
      const failed = fake({
        onUser: [
          { type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom"] },
        ],
        noResult: true,
      });
      const a = runnerFor(failed);
      await send(failed, a.runner).catch(() => undefined);
      await settle(a.runner, "outcome-unknown");
      expect(a.runner.snapshot().reason).toBe("Claude turn failed: boom");

      const exited = fake({ onUser: [{ __exit: true }] });
      const b = runnerFor(exited);
      await send(exited, b.runner).catch(() => undefined);
      await settle(b.runner, "outcome-unknown");
      expect(b.runner.snapshot().reason).toMatch(/^Claude (process exited|stream closed)/);

      const silent = fake({ silentInitialize: true });
      const c = runnerFor(silent, { controlTimeoutMs: 300 });
      await send(silent, c.runner).then(
        () => {
          throw new Error("expected the initialization to fail");
        },
        (error: Error) => expect(error.message).toBe("Claude initialize timed out"),
      );
      expect(c.runner.snapshot().reason).toBe("Claude initialize timed out");
    }, 60_000);
  },
);

// What the host shows once a session has been stopped, and after a restart.
const deviceId = "browser-device-a";
function hostFor(f: Fake, version = "2.1.296") {
  const commands = {
    run: vi.fn(async () => ({ success: true, bytes: Buffer.from(`${version} (Claude Code)\n`) })),
  } as unknown as Commands;
  const store = {
    workspacePath: () => f.workspace,
    sessions: { id: (_agent: string, id: string) => id },
  } as unknown as BackendStore;
  const sessions = {
    verifiedClaudeControlTarget: (id: string) => path.join(f.config, `${id}.jsonl`),
  } as unknown as SessionReaders;
  const owner = new ClaudeManagedReadOwner(
    store,
    sessions,
    commands,
    f.root,
    f.environment,
    randomUUID(),
    { publish: () => undefined, alias: () => undefined },
  );
  cleanups.push(() => owner.shutdown());
  return owner;
}
const liveOf = async (owner: ClaudeManagedReadOwner, id: string) =>
  (await owner.live(id, true)) as Record<string, any>;
async function request(owner: ClaudeManagedReadOwner, id: string, operation: string, fields = {}) {
  const live = await liveOf(owner, id);
  return owner.request({
    operation,
    sessionId: id,
    deviceId,
    requestId: randomUUID(),
    runtimeBootId: owner.bootId,
    expectedRevision: live.revision,
    experimentalEnabled: true,
    ...fields,
  }) as Promise<Record<string, any>>;
}

describe.skipIf(!["darwin", "linux"].includes(process.platform))(
  "a managed Claude session that AgentKib stopped",
  () => {
    async function stoppedSession() {
      const f = fake({
        onUser: [
          mainBash("toolu_bg"),
          {
            type: "system",
            subtype: "task_started",
            task_id: "bg-task",
            tool_use_id: "toolu_bg",
            task_type: "local_bash",
            is_backgrounded: true,
          },
        ],
        noResult: true,
      });
      const owner = hostFor(f);
      const created = (await owner.request({
        operation: "create",
        workspaceId: "workspace",
        requestId: randomUUID(),
        deviceId,
      })) as Record<string, any>;
      const id = created.sessionId as string;
      await request(owner, id, "send", { text: "synthetic turn" });
      await expect
        .poll(async () => (await liveOf(owner, id)).status, { timeout: 15_000 })
        .toBe("outcome-unknown");
      return { f, owner, id };
    }

    it("is read-only: it explains why, and every later control is refused", async () => {
      const { owner, id } = await stoppedSession();
      const live = await liveOf(owner, id);
      expect(live.reason).toMatch(/^claude-background-task: /);
      expect(live).toMatchObject({ sendEnabled: false, stopEnabled: false });
      for (const operation of ["send", "stop", "approve"])
        await expect(
          request(owner, id, operation, { text: "again", turnId: live.turnId }),
        ).rejects.toThrow("control-outcome-unconfirmed");
      await expect(
        owner.request({
          operation: "release",
          sessionId: id,
          deviceId,
          requestId: randomUUID(),
          runtimeBootId: owner.bootId,
          expectedRevision: live.revision,
        }),
      ).rejects.toThrow("control-outcome-unconfirmed");
      const reconciled = (await owner.request({
        operation: "reconcile",
        sessionId: id,
        deviceId,
        requestId: randomUUID(),
      })) as Record<string, any>;
      expect(reconciled.reconciled).toBe(false);
      expect(reconciled.live.reason).toMatch(/^claude-background-task: /);
    }, 60_000);

    it("keeps the reason after a restart, and falls back to the generic one when a command is also unresolved", async () => {
      const { f, owner, id } = await stoppedSession();
      expect((await liveOf(owner, id)).reason).toMatch(/^claude-background-task: /);
      await owner.shutdown();
      const restarted = hostFor(f);
      const live = await liveOf(restarted, id);
      expect(live.status).toBe("outcome-unknown");
      expect(live.reason).toMatch(/^claude-background-task: /);
      expect(live).toMatchObject({ sendEnabled: false, stopEnabled: false });

      // A command that was handed to the CLI and never resolved matters more than the stated reason.
      const requestId = randomUUID();
      claimManagedCommand(f.root, requestId, id, "fingerprint", deviceId, { operation: "send" });
      dispatchManagedCommand(f.root, requestId);
      await owner.shutdown();
      const unresolved = await liveOf(hostFor(f), id);
      expect(unresolved.reason).toBe("control-outcome-unconfirmed");
    }, 60_000);
  },
);
