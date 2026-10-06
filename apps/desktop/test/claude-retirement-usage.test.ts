import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeManagedReadOwner } from "../../../packages/backend/src/claude-managed-read";
import {
  ClaudeManagedRunnerProcess,
  type ClaudeRunnerSnapshot,
} from "../../../packages/backend/src/claude-managed-runner";
import type { Commands } from "../../../packages/backend/src/commands";
import type { SessionReaders } from "../../../packages/backend/src/session-readers";
import type { BackendStore } from "../../../packages/backend/src/store";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

function fixture() {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "agentkib-claude-retire-")));
  const home = path.join(directory, "home");
  const workspace = path.join(directory, "workspace");
  const bin = path.join(directory, "bin");
  const dataHome = path.join(directory, "xdg-data");
  const claudeHome = path.join(home, ".claude");
  for (const target of [home, workspace, bin, dataHome, claudeHome])
    mkdirSync(target, { mode: 0o700 });
  const executable = path.join(bin, "claude");
  // Only this temporary Node program is started; no installed Agent or user config is read.
  writeFileSync(
    executable,
    `#!${process.execPath}\n${String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
input.on("line", (line) => {
  const value = JSON.parse(line);
  if (value.type === "control_request") {
    send({ type: "control_response", response: {
      subtype: "success", request_id: value.request_id,
    } });
  } else if (value.type === "user") {
    send({ type: "assistant", parent_tool_use_id: null, message: {
      id: value.uuid, model: "synthetic-model", usage: { input_tokens: 10 }, content: [],
    } });
    send({ type: "result", subtype: "success", modelUsage: {
      "synthetic-model": { contextWindow: 100 },
    } });
  }
});
`}`,
    { mode: 0o700 },
  );
  const environment = {
    PATH: bin,
    HOME: home,
    XDG_DATA_HOME: dataHome,
    CLAUDE_CONFIG_DIR: claudeHome,
  };
  cleanups.push(async () => rmSync(directory, { recursive: true, force: true }));
  return { directory, home, workspace, bin, executable, environment };
}

function expectStaleUsage(value: unknown, reportId: number | undefined) {
  expect(value).toMatchObject({
    available: true,
    state: "stale",
    reason: "connection-unavailable",
    usedTokens: 10,
    contextWindow: 100,
    reportId,
  });
  expect(value).not.toHaveProperty("percent");
}

describe.skipIf(!["darwin", "linux"].includes(process.platform))(
  "Claude worker retirement context usage",
  () => {
    it("publishes stale usage on retirement and restores readiness only after explicit restart", async () => {
      const f = fixture();
      const snapshots: ClaudeRunnerSnapshot[] = [];
      const runner = new ClaudeManagedRunnerProcess(
        f.workspace,
        randomUUID(),
        true,
        0,
        f.environment,
        (snapshot) => snapshots.push(snapshot),
      );
      cleanups.push(() => runner.shutdown());

      await runner.send(f.executable, "first report", randomUUID(), 0);
      await expect.poll(() => runner.snapshot().status).toBe("idle");
      const before = runner.snapshot();
      expect(before.usage).toMatchObject({ state: "ready", percent: 10, reportId: 1 });
      const reportGeneration = before.usage.reportGeneration;
      expect(reportGeneration).toBeGreaterThan(0);
      expect(runner.hasWorker).toBe(true);
      snapshots.length = 0;

      await expect(runner.retireIfInactive()).resolves.toBe(true);
      expect(runner.hasWorker).toBe(false);
      const retired = runner.snapshot();
      expectStaleUsage(retired.usage, before.usage.reportId);
      expect(retired.usage.reportGeneration).toBe(reportGeneration);
      expect(retired.status).toBe("idle");
      expect(retired.sendEnabled).toBe(true);
      expect(retired.revision).toBeGreaterThan(before.revision);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]?.usage).toEqual(retired.usage);
      expect(runner.retireIfInactive()).toBeNull();
      expect(snapshots).toHaveLength(1);

      await runner.send(f.executable, "new ordinary report", randomUUID(), retired.revision);
      await expect.poll(() => runner.snapshot().status).toBe("idle");
      expect(runner.hasWorker).toBe(true);
      expect(runner.snapshot().usage).toMatchObject({
        state: "ready",
        percent: 10,
        reportId: 2,
        reportGeneration,
      });
      expect(snapshots.at(-1)?.usage).toEqual(runner.snapshot().usage);
    });

    it("keeps confirmed worker cleanup when the retirement snapshot listener fails", async () => {
      const f = fixture();
      let failListener = false;
      const runner = new ClaudeManagedRunnerProcess(
        f.workspace,
        randomUUID(),
        true,
        0,
        f.environment,
        () => {
          if (failListener) throw new Error("synthetic retirement listener failure");
        },
      );
      cleanups.push(() => runner.shutdown());
      await runner.send(f.executable, "ordinary report", randomUUID(), 0);
      await expect.poll(() => runner.snapshot().status).toBe("idle");
      failListener = true;

      await expect(runner.retireIfInactive()).resolves.toBe(true);
      expect(runner.hasWorker).toBe(false);
      expect(runner.isRetiring).toBe(false);
      expect(runner.cleanupError).toBeNull();
      expect(runner.snapshot()).toMatchObject({
        status: "outcome-unknown",
        sendEnabled: false,
        reason: "synthetic retirement listener failure",
      });
      await expect(runner.shutdown()).resolves.toBeUndefined();
    });

    it("keeps HTTP live, usage reads, and events consistent when another session retires a retained runner", async () => {
      const f = fixture();
      const events: Array<{ id: string; type: string; live: Record<string, unknown> }> = [];
      const run = vi.fn(async (_command: string, args: string[]) => {
        expect(args).toEqual(["--version"]);
        return { success: true, bytes: Buffer.from("2.1.286 (Claude Code)\n") };
      });
      const owner = new ClaudeManagedReadOwner(
        { workspacePath: () => f.workspace } as unknown as BackendStore,
        {
          verifiedClaudeControlTarget: () => {
            throw new Error("no synthetic transcript");
          },
        } as unknown as SessionReaders,
        { run } as unknown as Commands,
        f.directory,
        f.environment,
        randomUUID(),
        {
          publish: (id, type, _payload, live) => events.push({ id, type, live }),
          alias: () => undefined,
        },
      );
      cleanups.push(() => owner.shutdown());
      const send = vi.spyOn(ClaudeManagedRunnerProcess.prototype, "send");
      const create = () => {
        const sessionId = randomUUID();
        const sourceSessionId = randomUUID();
        const directory = path.join(f.directory, "claude-managed");
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        writeFileSync(
          path.join(directory, `${sessionId}.json`),
          JSON.stringify({
            version: 1,
            id: sessionId,
            workspaceId: "workspace",
            workspace: f.workspace,
            registeredWorkspace: f.workspace,
            home: f.environment.CLAUDE_CONFIG_DIR,
            nativeId: sourceSessionId,
            title: "Synthetic",
            createdAt: new Date().toISOString(),
            adopted: false,
            released: false,
            fresh: true,
            fingerprint: null,
            completedRequests: [],
            snapshot: {
              status: "idle",
              revision: 0,
              turnId: null,
              sendEnabled: true,
              stopEnabled: false,
              approvals: [],
              questions: [],
              streamText: "",
            },
          }),
          { mode: 0o600 },
        );
        return { sessionId, sourceSessionId };
      };
      const dispatch = async (id: string) => {
        const live = await owner.live(id, true);
        await expect(
          owner.request({
            operation: "send",
            sessionId: id,
            requestId: randomUUID(),
            deviceId: "agentkib-local-owner",
            runtimeBootId: owner.bootId,
            expectedRevision: live.revision,
            experimentalEnabled: true,
            text: "synthetic ordinary request",
          }),
        ).resolves.toMatchObject({ accepted: true, controlOutcome: "accepted" });
        await expect.poll(async () => (await owner.live(id, true)).status).toBe("idle");
      };
      const first = create();
      await dispatch(first.sessionId);
      const before = await owner.live(first.sessionId, true);
      expect(before.usage).toMatchObject({ state: "ready", percent: 10, reportId: 1 });
      const reportGeneration = (before.usage as Record<string, unknown>).reportGeneration;
      expect(reportGeneration).toBeGreaterThan(0);
      const firstRunner = send.mock.contexts.find(
        (runner) => runner.sessionId === first.sourceSessionId,
      );
      expect(firstRunner?.hasWorker).toBe(true);
      const eventOffset = events.length;

      const second = create();
      await dispatch(second.sessionId);
      expect(firstRunner?.hasWorker).toBe(false);
      const retired = await owner.live(first.sessionId, true);
      expect(retired.status).toBe("idle");
      expect(retired.sendEnabled).toBe(true);
      expectStaleUsage(retired.usage, 1);
      expect((retired.usage as Record<string, unknown>).reportGeneration).toBe(reportGeneration);
      const usage = await owner.request({ operation: "usage", sessionId: first.sessionId });
      expectStaleUsage(usage, 1);
      expect((usage as Record<string, unknown>).reportGeneration).toBe(reportGeneration);
      const retirementEvent = events
        .slice(eventOffset)
        .find((event) => event.id === first.sessionId && event.type === "state");
      expect(retirementEvent?.live.usage).toEqual(retired.usage);
      expect(retirementEvent?.live.revision).toEqual(retired.revision);
      expect(firstRunner?.hasWorker).toBe(false);
      expect(send).toHaveBeenCalledTimes(2);

      await dispatch(first.sessionId);
      expect(send.mock.contexts[2]).toBe(firstRunner);
      expect(firstRunner?.hasWorker).toBe(true);
      const restarted = await owner.live(first.sessionId, true);
      expect(restarted.usage).toMatchObject({
        state: "ready",
        percent: 10,
        reportId: 2,
        reportGeneration,
      });
      expect(events.findLast((event) => event.id === first.sessionId)?.live.usage).toEqual(
        restarted.usage,
      );
    });
  },
);
