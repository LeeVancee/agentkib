import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClaudeManagedRunnerProcess,
  ClaudeUndispatchedError,
} from "../../../packages/backend/src/claude-managed-runner";
import { ClaudeManagedReadOwner } from "../../../packages/backend/src/claude-managed-read";
import { openManagedLedger } from "../../../packages/backend/src/managed-ledger";
import {
  claimManagedCommand,
  dispatchManagedCommand,
} from "../../../packages/backend/src/managed-ledger";
import { MacOwnedProcessTree } from "../../../packages/backend/src/mac-owned-process-tree";
import * as leases from "../../../packages/backend/src/managed-session-lock";
import { Duplex } from "node:stream";
import type { BackendStore } from "../../../packages/backend/src/store";
import type { SessionReaders } from "../../../packages/backend/src/session-readers";
import type { Commands } from "../../../packages/backend/src/commands";
import { processAlive, type FakeClaudePlan } from "./fixtures/claude-fake-cli";
import { createStartupClaude } from "./fixtures/claude-startup-cli";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fixture(plan: FakeClaudePlan) {
  const f = createStartupClaude();
  f.setPlan(plan);
  cleanups.push(() => rmSync(f.root, { recursive: true, force: true }));
  const runner = new ClaudeManagedRunnerProcess(
    f.workspace,
    randomUUID(),
    true,
    0,
    f.environment,
    () => undefined,
    true,
    undefined,
    { controlTimeoutMs: 300 },
  );
  cleanups.push(() => runner.shutdown().catch(() => undefined));
  return { ...f, runner };
}

function host(f: ReturnType<typeof fixture>) {
  const owner = new ClaudeManagedReadOwner(
    {
      workspacePath: () => f.workspace,
      sessions: { id: (_agent: string, id: string) => id },
    } as unknown as BackendStore,
    {
      verifiedClaudeControlTarget: (id: string) => path.join(f.config, `${id}.jsonl`),
    } as unknown as SessionReaders,
    {
      run: vi.fn(async (command: string, args: string[]) => ({
        success: true,
        bytes: Buffer.from(
          command === "/bin/ps" ? "" : args[0] === "agents" ? "[]\n" : "2.1.303 (Claude Code)\n",
        ),
      })),
    } as unknown as Commands,
    f.root,
    f.environment,
    randomUUID(),
    { publish: () => undefined, alias: () => undefined },
  );
  cleanups.push(() => owner.shutdown());
  return owner;
}

async function create(owner: ClaudeManagedReadOwner) {
  return (await owner.request({
    operation: "create",
    workspaceId: "workspace",
    requestId: randomUUID(),
    deviceId: "browser-device",
  })) as { sessionId: string };
}

async function send(owner: ClaudeManagedReadOwner, id: string, requestId = randomUUID()) {
  const live = (await owner.live(id, true)) as { revision: number };
  return owner.request({
    operation: "send",
    sessionId: id,
    deviceId: "browser-device",
    requestId,
    runtimeBootId: owner.bootId,
    expectedRevision: live.revision,
    experimentalEnabled: true,
    text: "synthetic draft",
  });
}

describe.skipIf(!["darwin", "linux"].includes(process.platform))("Claude startup recovery", () => {
  it("restores an explicit settings initialize timeout after confirmed cleanup without a user frame", async () => {
    const f = fixture({ silentInitialize: true });
    await expect(f.runner.prepare(f.executable)).rejects.toThrow("Claude initialize timed out");
    expect(f.runner.hasWorker).toBe(false);
    expect(f.runner.snapshot()).toMatchObject({ status: "idle", sendEnabled: true });
    expect(f.frames().filter((frame) => frame.type === "user")).toEqual([]);
    f.setPlan({});
    await expect(f.runner.prepare(f.executable)).resolves.toMatchObject({
      settingsAcknowledged: true,
    });
  }, 30_000);

  it("keeps a settings initialize protocol failure unknown", async () => {
    const f = fixture({ beforeInitialize: [{ __raw: "invalid frame" }], silentInitialize: true });
    await expect(f.runner.prepare(f.executable)).rejects.toThrow();
    expect(f.evidence()).toContain("bad-frame");
    expect(f.runner.snapshot().status).toBe("outcome-unknown");
    expect(f.frames().filter((frame) => frame.type === "user")).toEqual([]);
  }, 30_000);
  it("restores an undispatched initialize timeout after confirming worker cleanup, then permits a new send", async () => {
    const f = fixture({ silentInitialize: true });
    const dispatched = vi.fn();
    await expect(
      f.runner.send(f.executable, "synthetic draft", randomUUID(), 0, dispatched),
    ).rejects.toBeInstanceOf(ClaudeUndispatchedError);
    expect(dispatched).not.toHaveBeenCalled();
    expect(f.frames().filter((frame) => frame.type === "user")).toEqual([]);
    expect(f.runner.hasWorker).toBe(false);
    expect(f.runner.snapshot()).toMatchObject({
      status: "idle",
      sendEnabled: true,
      turnId: "",
      reason: "Claude initialize timed out",
    });
    f.setPlan({});
    await f.runner.send(
      f.executable,
      "synthetic draft",
      randomUUID(),
      f.runner.snapshot().revision,
      dispatched,
    );
    await expect.poll(() => f.runner.snapshot().status).toBe("idle");
    expect(dispatched).toHaveBeenCalledTimes(1);
    expect(f.frames().filter((frame) => frame.type === "user")).toHaveLength(1);
  }, 30_000);

  it.each(["send", "prepare"] as const)(
    "restores a failed %s initialize write only after the owned tree is gone",
    async (operation) => {
      const f = fixture({});
      const original = Duplex.prototype.write;
      const writing = vi.spyOn(Duplex.prototype, "write").mockImplementation(function (
        this: Duplex,
        ...args: Parameters<Duplex["write"]>
      ) {
        const chunk = args[0];
        if (Buffer.isBuffer(chunk) && chunk.includes(Buffer.from('"subtype":"initialize"'))) {
          const callback = args.at(-1);
          queueMicrotask(() => {
            if (typeof callback === "function")
              callback(new Error("synthetic initialize write failure"));
          });
          return false;
        }
        return Reflect.apply(original, this, args);
      });
      await expect(
        operation === "send"
          ? f.runner.send(f.executable, "synthetic draft", randomUUID(), 0)
          : f.runner.prepare(f.executable),
      ).rejects.toBeInstanceOf(operation === "send" ? ClaudeUndispatchedError : Error);
      writing.mockRestore();
      expect(f.runner.hasWorker).toBe(false);
      expect(f.runner.snapshot()).toMatchObject({
        status: "idle",
        reason: "synthetic initialize write failure",
      });
      expect(f.frames().filter((frame) => frame.type === "user")).toEqual([]);
    },
    30_000,
  );

  it.skipIf(process.platform !== "darwin")(
    "keeps cleanup failure unknown and does not publish a cleanup receipt",
    async () => {
      const f = fixture({ silentInitialize: true });
      const proof = vi.fn();
      const stop = vi
        .spyOn(MacOwnedProcessTree.prototype, "terminate")
        .mockRejectedValueOnce(new Error("synthetic tree cleanup failure"));
      const runner = new ClaudeManagedRunnerProcess(
        f.workspace,
        randomUUID(),
        true,
        0,
        f.environment,
        () => undefined,
        true,
        undefined,
        { controlTimeoutMs: 300, onUndispatchedStartup: proof },
      );
      cleanups.push(() => runner.shutdown().catch(() => undefined));
      await expect(runner.send(f.executable, "synthetic draft", randomUUID(), 0)).rejects.toThrow(
        "cleanup",
      );
      expect(runner.snapshot().status).toBe("outcome-unknown");
      expect(proof).not.toHaveBeenCalled();
      expect(runner.hasWorker).toBe(true);
      stop.mockRestore();
    },
    30_000,
  );

  it("keeps a failed durable proof write unknown even when physical cleanup succeeded", async () => {
    const f = fixture({ silentInitialize: true });
    const runner = new ClaudeManagedRunnerProcess(
      f.workspace,
      randomUUID(),
      true,
      0,
      f.environment,
      () => undefined,
      true,
      undefined,
      {
        controlTimeoutMs: 300,
        onUndispatchedStartup: () => {
          throw new Error("synthetic proof write failure");
        },
      },
    );
    cleanups.push(() => runner.shutdown().catch(() => undefined));
    await expect(runner.send(f.executable, "synthetic draft", randomUUID(), 0)).rejects.toThrow(
      "synthetic proof write failure",
    );
    expect(runner.hasWorker).toBe(false);
    expect(runner.snapshot().status).toBe("outcome-unknown");
  }, 30_000);

  it.skipIf(process.platform !== "darwin")(
    "keeps a pre-initialize root exit unknown when descendant capture cannot be confirmed",
    async () => {
      const f = fixture({ beforeInitialize: [{ __exit: true }], silentInitialize: true });
      const terminate = MacOwnedProcessTree.prototype.terminate;
      vi.spyOn(MacOwnedProcessTree.prototype, "terminate").mockImplementation(
        async function (this: MacOwnedProcessTree, child) {
          // Force the root-exit ordering without weakening the real tree capture assertion.
          if (child.exitCode === null && child.signalCode === null) await once(child, "close");
          return terminate.call(this, child);
        },
      );
      await expect(f.runner.send(f.executable, "synthetic draft", randomUUID(), 0)).rejects.toThrow(
        "owned root exited before frozen capture",
      );
      expect(f.runner.snapshot().status).toBe("outcome-unknown");
      expect(f.runner.cleanupError).toContain("owned root exited before frozen capture");
      expect(f.runner.processId).not.toBeNull();
      expect(processAlive(f.runner.processId!)).toBe(false);
      expect(f.frames().filter((frame) => frame.type === "user")).toEqual([]);
    },
    30_000,
  );

  it("keeps protocol drift before initialization unknown", async () => {
    const f = fixture({ beforeInitialize: [{ __raw: "invalid frame" }], silentInitialize: true });
    await expect(
      f.runner.send(f.executable, "synthetic draft", randomUUID(), 0),
    ).rejects.not.toBeInstanceOf(ClaudeUndispatchedError);
    expect(f.evidence()).toContain("bad-frame");
    expect(f.runner.snapshot().status).toBe("outcome-unknown");
    expect(f.frames().filter((frame) => frame.type === "user")).toEqual([]);
  }, 30_000);

  it("keeps a dispatched user turn unknown even without a host dispatch callback", async () => {
    const f = fixture({ onUser: [{ __closeOutput: true }], noResult: true });
    await f.runner.send(f.executable, "synthetic draft", randomUUID(), 0).catch(() => undefined);
    await expect.poll(() => f.runner.snapshot().status).toBe("outcome-unknown");
    expect(f.frames().filter((frame) => frame.type === "user")).toHaveLength(1);
    expect(f.evidence()).toContain("close-user");
  }, 30_000);

  it("finishes a pre-initialize stream failure as not-dispatched and keeps the session usable after restart", async () => {
    const f = fixture({ beforeInitialize: [{ __closeOutput: true }], silentInitialize: true });
    const owner = host(f);
    const { sessionId } = await create(owner);
    const requestId = randomUUID();
    expect(await send(owner, sessionId, requestId)).toMatchObject({
      accepted: false,
      controlOutcome: "not-dispatched",
    });
    expect(await owner.live(sessionId, true)).toMatchObject({ status: "idle", sendEnabled: true });
    const database = openManagedLedger(f.root)!;
    try {
      const row = database
        .prepare("SELECT phase,result FROM managed_commands WHERE request_id=?")
        .get(requestId) as { phase: string; result: string };
      expect(row.phase).toBe("resolved");
      expect(JSON.parse(row.result)).toMatchObject({ controlOutcome: "not-dispatched" });
    } finally {
      database.close();
    }
    await owner.shutdown();
    const restarted = host(f);
    expect(await restarted.live(sessionId, true)).toMatchObject({
      status: "idle",
      sendEnabled: true,
    });
    f.setPlan({});
    expect(await send(restarted, sessionId)).toMatchObject({ accepted: true });
    await expect.poll(async () => (await restarted.live(sessionId, true)).status).toBe("idle");
  }, 30_000);

  it.each([
    "valid",
    "resolved-outcome",
    "restored-metadata",
    "native-id",
    "generation",
    "revision",
    "cleanup",
    "dispatched",
    "user-dispatched",
    "other-command",
    "new-owner-completed",
  ] as const)(
    "recovers an interrupted durable startup only with matching cleanup proof: %s",
    async (kind) => {
      const f = fixture({ beforeInitialize: [{ __closeOutput: true }], silentInitialize: true });
      const owner = host(f);
      const { sessionId } = await create(owner);
      const requestId = randomUUID();
      expect(await send(owner, sessionId, requestId)).toMatchObject({
        controlOutcome: "not-dispatched",
      });
      await owner.shutdown();
      const database = openManagedLedger(f.root)!;
      const file = path.join(f.root, "claude-managed", `${sessionId}.json`);
      const record = JSON.parse(readFileSync(file, "utf8"));
      const recoverable = ["valid", "resolved-outcome", "restored-metadata"].includes(kind);
      try {
        const row = database
          .prepare("SELECT evidence,result FROM managed_commands WHERE request_id=?")
          .get(requestId) as { evidence: string; result: string };
        expect(row.evidence).not.toContain("synthetic draft");
        const evidence = JSON.parse(row.evidence);
        const proof = evidence.startupCleanup;
        expect(proof).toMatchObject({ cleanupConfirmed: true, userDispatched: false });
        if (kind !== "restored-metadata") {
          record.snapshot.status = "outcome-unknown";
          record.snapshot.revision = proof.failedRevision;
          record.snapshot.turnId = requestId;
        }
        if (kind === "native-id") proof.nativeId = randomUUID();
        if (kind === "generation") proof.recordCreatedAt = "old record generation";
        if (kind === "revision") record.snapshot.revision++;
        if (kind === "cleanup") proof.cleanupConfirmed = false;
        if (kind === "user-dispatched") proof.userDispatched = true;
        database
          .prepare("UPDATE managed_commands SET phase=?,result=?,evidence=? WHERE request_id=?")
          .run(
            kind === "resolved-outcome"
              ? "resolved"
              : kind === "dispatched"
                ? "dispatched"
                : "prepared",
            kind === "resolved-outcome" ? row.result : null,
            JSON.stringify(evidence),
            requestId,
          );
      } finally {
        database.close();
      }
      writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
      if (kind === "other-command") {
        const other = randomUUID();
        claimManagedCommand(
          f.root,
          other,
          sessionId,
          "synthetic independent mutation",
          "browser-device",
          { operation: "settings" },
        );
        dispatchManagedCommand(f.root, other);
      }
      const restarted = host(f);
      const laterTurnId = randomUUID();
      if (kind === "new-owner-completed") {
        const acquire = leases.acquirePortableFileLease;
        let updated = false;
        vi.spyOn(leases, "acquirePortableFileLease").mockImplementation((lock) => {
          if (!updated && lock === file.replace(/\.json$/, ".lock")) {
            updated = true;
            const release = acquire(lock);
            try {
              // Another runtime writes and releases between our metadata read and lease.
              const latest = JSON.parse(readFileSync(file, "utf8"));
              latest.title = "Later owner title";
              latest.snapshot = {
                ...latest.snapshot,
                status: "idle",
                revision: latest.snapshot.revision + 10,
                turnId: laterTurnId,
                reason: null,
                sendEnabled: true,
              };
              writeFileSync(file, JSON.stringify(latest), { mode: 0o600 });
            } finally {
              release();
            }
          }
          return acquire(lock);
        });
      }
      expect(await restarted.live(sessionId, true)).toMatchObject(
        kind === "new-owner-completed"
          ? { status: "idle", sendEnabled: true, turnId: laterTurnId }
          : recoverable
            ? { status: "idle", sendEnabled: true, turnId: "", reason: "Claude stream closed" }
            : { status: "outcome-unknown", sendEnabled: false },
      );
      if (kind === "new-owner-completed") {
        expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
          title: "Later owner title",
          snapshot: { turnId: laterTurnId, revision: record.snapshot.revision + 10 },
        });
      }
      expect(f.frames().filter((frame) => frame.type === "user")).toEqual([]);
      if (recoverable) {
        const ledger = openManagedLedger(f.root)!;
        try {
          const row = ledger
            .prepare("SELECT phase,result FROM managed_commands WHERE request_id=?")
            .get(requestId) as { phase: string; result: string };
          expect(row.phase).toBe("resolved");
          expect(JSON.parse(row.result)).toMatchObject({ controlOutcome: "not-dispatched" });
        } finally {
          ledger.close();
        }
      }
    },
    30_000,
  );

  it("keeps a legacy startup failure unknown when it has no verifiable cleanup receipt", async () => {
    const f = fixture({});
    const owner = host(f);
    const { sessionId } = await create(owner);
    await owner.shutdown();
    const file = path.join(f.root, "claude-managed", `${sessionId}.json`);
    const record = JSON.parse(readFileSync(file, "utf8"));
    record.snapshot.status = "outcome-unknown";
    record.snapshot.reason = "Claude initialize timed out";
    writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
    const restarted = host(f);
    expect(await restarted.live(sessionId, true)).toMatchObject({
      status: "outcome-unknown",
      sendEnabled: false,
    });
    expect(f.frames()).toEqual([]);
  });
});
