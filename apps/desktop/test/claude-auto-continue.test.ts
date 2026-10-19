import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeManagedReadOwner } from "../../../packages/backend/src/claude-managed-read";
import { ClaudeManagedRunnerProcess } from "../../../packages/backend/src/claude-managed-runner";
import { ClaudeSessionOwnerProbe } from "../../../packages/backend/src/claude-session-owner";
import { acquirePortableFileLease } from "../../../packages/backend/src/managed-session-lock";
import type { Commands } from "../../../packages/backend/src/commands";
import type { SessionReaders } from "../../../packages/backend/src/session-readers";
import type { BackendStore } from "../../../packages/backend/src/store";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});

function fixture(
  options: {
    idleTimeoutMs?: number;
    maintenanceIntervalMs?: number;
    isSessionObserved?: (id: string) => boolean;
  } = {},
) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agentkib-claude-auto-")));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const config = path.join(home, ".claude");
  const bin = path.join(root, "bin");
  for (const directory of [home, workspace, config, bin]) mkdirSync(directory, { mode: 0o700 });
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const executable = path.join(bin, "claude");
  const log = path.join(root, "frames.jsonl");
  const ready = path.join(root, "external-ready");
  const resultGate = path.join(root, "result-gate");
  const agentsFile = path.join(root, "agents.json");
  const externalProcesses = new Map<number, string[]>();
  writeFileSync(agentsFile, "[]");
  // All processes use this isolated fixture. It never reads the installed CLI or user home.
  writeFileSync(
    executable,
    `#!${process.execPath}\n${String.raw`
const fs = require("node:fs");
if (process.env.AUTO_EXTERNAL === "1") {
  fs.writeFileSync(process.env.AUTO_READY, String(process.pid));
  setInterval(() => {}, 1000);
} else if (process.argv[2] === "agents") {
  process.stdout.write(fs.readFileSync(process.env.AUTO_AGENTS, "utf8"));
} else if (process.argv[2] === "--version") {
  process.stdout.write("2.1.302 (Claude Code)\n");
} else {
  const log = (value) => fs.appendFileSync(process.env.AUTO_LOG, JSON.stringify(value) + "\n");
  const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
  log({ started: true, pid: process.pid, args: process.argv.slice(2) });
  require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
    const frame = JSON.parse(line);
    log(frame);
    if (frame.type === "control_request") {
      send({ type: "control_response", response: {
        subtype: "success", request_id: frame.request_id,
        response: { models: [], commands: [] },
      } });
    } else if (frame.type === "user") {
      const transcript = process.env.CLAUDE_CONFIG_DIR + "/" + frame.session_id + ".jsonl";
      fs.appendFileSync(transcript, JSON.stringify({ type: "user", uuid: frame.uuid,
        sessionId: frame.session_id, cwd: process.cwd(), message: frame.message }) + "\n");
      const finish = () => {
        send({ type: "assistant", parent_tool_use_id: null, message: {
          id: frame.uuid, model: "synthetic-model", usage: { input_tokens: 10 }, content: [],
        } });
        send({ type: "result", subtype: "success", usage: { input_tokens: 10, output_tokens: 1 },
          modelUsage: { "synthetic-model": { contextWindow: 100 } } });
      };
      if (frame.message.content === "hold result") {
        const timer = setInterval(() => {
          if (fs.existsSync(process.env.AUTO_RESULT_GATE)) { clearInterval(timer); finish(); }
        }, 10);
      } else finish();
    }
  });
}
`}`,
    { mode: 0o700 },
  );
  const environment = {
    PATH: bin,
    HOME: home,
    CLAUDE_CONFIG_DIR: config,
    XDG_DATA_HOME: path.join(home, "data"),
    AUTO_LOG: log,
    AUTO_READY: ready,
    AUTO_RESULT_GATE: resultGate,
    AUTO_AGENTS: agentsFile,
  };
  const events: Array<{ id: string; type: string; live: Record<string, unknown> }> = [];
  const owner = new ClaudeManagedReadOwner(
    {
      workspacePath: () => workspace,
      sessions: { id: (_agent: string, id: string) => id },
    } as unknown as BackendStore,
    {
      verifiedClaudeControlTarget: (id: string) => path.join(config, `${id}.jsonl`),
    } as unknown as SessionReaders,
    {
      run: vi.fn(async (command: string, args: string[]) => ({
        success: true,
        bytes:
          command === "/bin/ps"
            ? processTable()
            : Buffer.from(
                args[0] === "agents" ? readFileSync(agentsFile, "utf8") : "2.1.302 (Claude Code)\n",
              ),
      })),
    } as unknown as Commands,
    root,
    environment,
    randomUUID(),
    {
      publish: (id, type, _payload, live) => events.push({ id, type, live }),
      alias: () => undefined,
    },
    options,
  );
  cleanups.push(() => owner.shutdown());
  const sends = vi.spyOn(ClaudeManagedRunnerProcess.prototype, "send");
  const frames = (): Array<Record<string, unknown>> =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  // The probe gets only the fixture's real live processes. Its full OS output parser is covered
  // separately; repeated whole-machine scans would make these lifecycle tests depend on load.
  const processTable = () => {
    const processes = new Map(externalProcesses);
    for (const frame of frames())
      if (frame.started) processes.set(Number(frame.pid), frame.args as string[]);
    const rows: string[] = [];
    for (const [pid, args] of processes) {
      try {
        process.kill(pid, 0);
      } catch {
        continue;
      }
      rows.push(`${pid} Mon Oct 19 00:00:00 2026 ${executable} ${args.join(" ")}`);
    }
    return Buffer.from(rows.join("\n"));
  };
  const create = () => {
    const id = randomUUID();
    const nativeId = randomUUID();
    const directory = path.join(root, "claude-managed");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(directory, `${id}.json`),
      JSON.stringify({
        version: 1,
        id,
        workspaceId: "workspace",
        workspace,
        registeredWorkspace: workspace,
        home: config,
        nativeId,
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
    return { id, nativeId };
  };
  const control = async (id: string, operation = "send", fields: Record<string, unknown> = {}) => {
    const live = await owner.live(id, true);
    return owner.request({
      operation,
      sessionId: id,
      requestId: randomUUID(),
      deviceId: "agentkib-local-owner",
      runtimeBootId: owner.bootId,
      expectedRevision: live.revision,
      experimentalEnabled: true,
      ...(operation === "send" ? { text: "synthetic message" } : {}),
      ...fields,
    });
  };
  const dispatch = async (id: string) => {
    await expect(control(id)).resolves.toMatchObject({ accepted: true });
    await expect.poll(async () => (await owner.live(id, true)).status).toBe("idle");
  };
  const runner = (nativeId: string) => {
    const result = sends.mock.contexts.findLast((candidate) => candidate.sessionId === nativeId);
    expect(result).toBeDefined();
    return result!;
  };
  const startExternal = async (nativeId: string, registeredKind?: "interactive" | "background") => {
    rmSync(ready, { force: true });
    const child = spawn(executable, registeredKind ? [] : [`--session-id=${nativeId}`], {
      cwd: workspace,
      env: { ...environment, AUTO_EXTERNAL: "1" },
      stdio: "ignore",
    });
    cleanups.push(() => stop(child));
    await expect.poll(() => existsSync(ready)).toBe(true);
    expect(child.pid).toBeGreaterThan(0);
    externalProcesses.set(child.pid!, registeredKind ? [] : [`--session-id=${nativeId}`]);
    if (registeredKind) {
      expect(child.spawnargs.at(-1)).toBe(executable);
      writeFileSync(
        agentsFile,
        JSON.stringify([
          {
            pid: child.pid,
            sessionId: nativeId,
            cwd: workspace,
            kind: registeredKind,
            status: "idle",
            startedAt: Date.now(),
          },
        ]),
      );
    }
    return child;
  };
  return {
    root,
    owner,
    create,
    control,
    dispatch,
    runner,
    frames,
    startExternal,
    resultGate,
    events,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await exited;
}

async function rejectedControl(action: Promise<unknown>) {
  try {
    return await action;
  } catch (error) {
    return { accepted: false, error: error instanceof Error ? error.message : String(error) };
  }
}

describe.skipIf(!["darwin", "linux"].includes(process.platform))(
  "Claude automatic continuation ownership boundaries (offline CLI)",
  () => {
    it("rechecks an external writer before restarting a retained retired runner", async () => {
      const f = fixture();
      const session = f.create();
      await f.dispatch(session.id);
      const retained = f.runner(session.nativeId);
      await expect(retained.retireIfInactive()).resolves.toBe(true);
      expect(retained.hasWorker).toBe(false);
      const before = f.frames();
      const external = await f.startExternal(session.nativeId);

      const rejected = await rejectedControl(f.control(session.id));

      expect(rejected).toMatchObject({ accepted: false });
      expect(JSON.stringify(rejected)).toMatch(/claude-owner-busy|active in an external process/);
      expect(retained.hasWorker).toBe(false);
      expect(f.frames().filter((frame) => frame.started)).toHaveLength(
        before.filter((frame) => frame.started).length,
      );
      expect(f.frames().filter((frame) => frame.type === "user")).toHaveLength(
        before.filter((frame) => frame.type === "user").length,
      );

      await stop(external);
      await f.dispatch(session.id);
      expect(f.frames().filter((frame) => frame.type === "user")).toHaveLength(2);
    });

    it("also rejects external ownership before the first worker starts", async () => {
      const f = fixture();
      const session = f.create();
      await f.startExternal(session.nativeId);

      const rejected = await rejectedControl(f.control(session.id));

      expect(rejected).toMatchObject({ accepted: false });
      expect(JSON.stringify(rejected)).toMatch(/claude-owner-busy|active in an external process/);
      expect(f.frames()).toEqual([]);
    });

    it.each(["interactive", "background"] as const)(
      "rejects a registered %s owner with no resume arguments before restarting",
      async (kind) => {
        const f = fixture();
        const session = f.create();
        await f.dispatch(session.id);
        const retained = f.runner(session.nativeId);
        await expect(retained.retireIfInactive()).resolves.toBe(true);
        const before = f.frames();
        await f.startExternal(session.nativeId, kind);

        const rejected = await rejectedControl(f.control(session.id));

        expect(rejected).toMatchObject({ accepted: false });
        expect(JSON.stringify(rejected)).toContain(
          kind === "background" ? "claude-background-session-running" : "claude-owner-busy",
        );
        expect(retained.hasWorker).toBe(false);
        expect(f.frames()).toEqual(before);
      },
    );

    it("checks ownership again when a queued message prepares a retired runner", async () => {
      const f = fixture();
      const session = f.create();
      await f.dispatch(session.id);
      await f.control(session.id, "queue-add", { text: "queued continuation" });
      const schedule = (await f.owner.request({
        operation: "schedule-list",
        sessionId: session.id,
      })) as {
        sessions: Array<{
          next: { itemId: string; requestId: string; deviceId: string } | null;
        }>;
      };
      const next = schedule.sessions[0]!.next!;
      expect(next.deviceId).toBe("agentkib-local-owner");
      await f.control(session.id, "queue-pause");
      const retained = f.runner(session.nativeId);
      await expect(retained.retireIfInactive()).resolves.toBe(true);
      const before = f.frames();
      const external = await f.startExternal(session.nativeId);
      const resume = () => f.control(session.id, "queue-resume");
      const prepare = async () => {
        const live = await f.owner.live(session.id, true);
        return f.owner.request({
          operation: "schedule-prepare",
          sessionId: session.id,
          ...next,
          runtimeBootId: f.owner.bootId,
          expectedRevision: live.revision,
        });
      };

      const rejected = await rejectedControl(
        (async () => {
          await resume();
          return prepare();
        })(),
      );

      expect(rejected).toMatchObject({ accepted: false });
      expect(JSON.stringify(rejected)).toMatch(/claude-owner-busy|active in an external process/);
      expect(retained.hasWorker).toBe(false);
      expect(f.frames()).toEqual(before);

      await stop(external);
      await expect(resume()).resolves.toMatchObject({ accepted: true });
      const permit = (await prepare()) as Record<string, unknown>;
      expect(permit).toMatchObject({ accepted: true, deviceId: "agentkib-local-owner" });
      const { accepted: _accepted, expiresAt: _expiresAt, ...request } = permit;
      await expect(
        f.owner.request({ operation: "schedule-dispatch", ...request }),
      ).resolves.toMatchObject({ accepted: true });
      await expect.poll(() => f.frames().filter((frame) => frame.type === "user")).toHaveLength(2);
    });

    it("defaults to ten idle minutes and restarts automatically after the worker ends", async () => {
      const clock = Date.now.bind(Date);
      let offset = 0;
      vi.spyOn(Date, "now").mockImplementation(() => clock() + offset);
      const f = fixture({ maintenanceIntervalMs: 10 });
      const session = f.create();
      await f.dispatch(session.id);
      const retained = f.runner(session.nativeId);

      offset = 590_000;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(retained.hasWorker).toBe(true);

      offset = 600_001;
      await expect.poll(() => retained.hasWorker).toBe(false);
      expect(await f.owner.live(session.id, true)).toMatchObject({
        sendEnabled: true,
        executionLocation: null,
        continuationNotice: "background-ended",
      });
      await f.dispatch(session.id);
      expect(f.frames().filter((frame) => frame.started)).toHaveLength(2);
      expect(f.frames().filter((frame) => frame.type === "user")).toHaveLength(2);
    });

    it("honors a configured idle timeout", async () => {
      const f = fixture({ idleTimeoutMs: 40, maintenanceIntervalMs: 10 });
      const session = f.create();
      await f.dispatch(session.id);

      await expect.poll(() => f.runner(session.nativeId).hasWorker).toBe(false);
      expect(f.frames().filter((frame) => frame.started)).toHaveLength(1);
    });

    it("does not treat an unobserved background session as a subscriber leaving", async () => {
      const f = fixture({
        idleTimeoutMs: 60_000,
        maintenanceIntervalMs: 10,
        isSessionObserved: () => false,
      });
      const session = f.create();
      await f.dispatch(session.id);

      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(f.runner(session.nativeId).hasWorker).toBe(true);
    });

    it("keeps the worker while any subscriber remains and ends after the last one leaves", async () => {
      let subscribers = 2;
      const f = fixture({
        idleTimeoutMs: 60_000,
        maintenanceIntervalMs: 10,
        isSessionObserved: () => subscribers > 0,
      });
      const session = f.create();
      await f.dispatch(session.id);
      const retained = f.runner(session.nativeId);
      subscribers = 1;
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(retained.hasWorker).toBe(true);

      subscribers = 0;

      await expect.poll(() => retained.hasWorker).toBe(false);
      expect(await f.owner.live(session.id, true)).toMatchObject({ sendEnabled: true });
    });

    it("preserves a running turn after leaving and ends the worker only after completion", async () => {
      let observed = true;
      const f = fixture({
        idleTimeoutMs: 30,
        maintenanceIntervalMs: 10,
        isSessionObserved: () => observed,
      });
      const session = f.create();
      await expect(f.control(session.id, "send", { text: "hold result" })).resolves.toMatchObject({
        accepted: true,
      });
      await expect.poll(async () => (await f.owner.live(session.id, true)).status).toBe("running");
      const retained = f.runner(session.nativeId);
      observed = false;
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(retained.hasWorker).toBe(true);
      expect(await f.owner.live(session.id, true)).toMatchObject({ status: "running" });

      writeFileSync(f.resultGate, "complete");

      await expect.poll(() => retained.hasWorker).toBe(false);
      expect(await f.owner.live(session.id, true)).toMatchObject({
        status: "idle",
        sendEnabled: true,
      });
    });

    it("stops its running worker when an external owner appears and exposes a conflict", async () => {
      const probe = vi
        .spyOn(ClaudeSessionOwnerProbe.prototype, "check")
        .mockResolvedValue({ kind: "idle" });
      const f = fixture({ maintenanceIntervalMs: 10 });
      const session = f.create();
      await expect(f.control(session.id, "send", { text: "hold result" })).resolves.toMatchObject({
        accepted: true,
      });
      await expect.poll(async () => (await f.owner.live(session.id, true)).status).toBe("running");
      const retained = f.runner(session.nativeId);
      const workerPid = retained.processId;
      probe.mockResolvedValue({ kind: "interactive", pid: process.pid, source: "registry" });

      await expect.poll(() => retained.hasWorker).toBe(false);

      const live = await f.owner.live(session.id, true);
      expect(live).toMatchObject({ sendEnabled: false, executionLocation: "external" });
      expect(JSON.stringify(live)).toContain("owner-opened-elsewhere");
      expect(probe).toHaveBeenCalledWith(session.nativeId, workerPid);
      expect(f.frames().filter((frame) => frame.type === "user")).toHaveLength(1);
    });

    it("checks every restart rather than retaining a prior idle ownership result", async () => {
      const f = fixture();
      const session = f.create();
      await f.dispatch(session.id);
      for (let cycle = 0; cycle < 2; cycle++) {
        const retained = f.runner(session.nativeId);
        await expect(retained.retireIfInactive()).resolves.toBe(true);
        const before = f.frames();
        const external = await f.startExternal(session.nativeId);

        const rejected = await rejectedControl(f.control(session.id));

        expect(rejected).toMatchObject({ accepted: false });
        expect(JSON.stringify(rejected)).toMatch(/claude-owner-busy|active in an external process/);
        expect(retained.hasWorker).toBe(false);
        expect(f.frames()).toEqual(before);
        await stop(external);
        await f.dispatch(session.id);
      }
      expect(f.frames().filter((frame) => frame.started)).toHaveLength(3);
      expect(f.frames().filter((frame) => frame.type === "user")).toHaveLength(3);
    }, 15_000);

    it("rechecks ownership at the actual startup boundary after a successful send preflight", async () => {
      let externalAppeared = false;
      const originalSend = ClaudeManagedRunnerProcess.prototype.send;
      vi.spyOn(ClaudeSessionOwnerProbe.prototype, "check").mockImplementation(async () =>
        externalAppeared
          ? { kind: "interactive", pid: process.pid, source: "agents" }
          : { kind: "idle" },
      );
      const f = fixture();
      const session = f.create();
      vi.spyOn(ClaudeManagedRunnerProcess.prototype, "send").mockImplementation(function (...args) {
        externalAppeared = true;
        return originalSend.apply(this, args);
      });

      const rejected = await rejectedControl(f.control(session.id));

      expect(rejected).toMatchObject({ accepted: false, controlOutcome: "not-dispatched" });
      expect(JSON.stringify(rejected)).toContain("claude-owner-busy");
      expect(f.frames()).toEqual([]);
      expect(f.runner(session.nativeId).hasWorker).toBe(false);
    });

    it("does not restart a retired worker when the external ownership check is unavailable", async () => {
      const probe = vi
        .spyOn(ClaudeSessionOwnerProbe.prototype, "check")
        .mockResolvedValue({ kind: "idle" });
      const f = fixture();
      const session = f.create();
      await f.dispatch(session.id);
      const retained = f.runner(session.nativeId);
      await expect(retained.retireIfInactive()).resolves.toBe(true);
      const before = f.frames();
      probe.mockRejectedValue(new Error("claude-owner-check-unavailable"));

      const rejected = await rejectedControl(f.control(session.id));

      expect(rejected).toMatchObject({ accepted: false });
      expect(JSON.stringify(rejected)).toContain("claude-owner-check-unavailable");
      expect(retained.hasWorker).toBe(false);
      expect(f.frames()).toEqual(before);
    });

    it("replays an accepted send before adoption after release, even when an external owner is now active", async () => {
      const f = fixture();
      const session = f.create();
      const live = await f.owner.live(session.id, true);
      const originalRequest = {
        operation: "send",
        sessionId: session.id,
        requestId: randomUUID(),
        deviceId: "agentkib-local-owner",
        runtimeBootId: f.owner.bootId,
        expectedRevision: live.revision,
        experimentalEnabled: true,
        text: "original accepted message",
      };
      const receipt = await f.owner.request(originalRequest);
      expect(receipt).toMatchObject({ accepted: true });
      await expect.poll(async () => (await f.owner.live(session.id, true)).status).toBe("idle");
      const beforeRelease = await f.owner.live(session.id, true);
      await expect(
        f.owner.request({
          operation: "release",
          sessionId: session.id,
          requestId: randomUUID(),
          deviceId: "agentkib-local-owner",
          runtimeBootId: f.owner.bootId,
          expectedRevision: beforeRelease.revision,
        }),
      ).resolves.toMatchObject({ accepted: true });
      const external = await f.startExternal(session.nativeId);
      const before = f.frames();

      await expect(f.owner.request(originalRequest)).resolves.toEqual(receipt);

      expect(f.frames()).toEqual(before);
      expect(
        JSON.parse(readFileSync(path.join(f.root, "claude-managed", `${session.id}.json`), "utf8")),
      ).toMatchObject({ released: true });
      await expect(
        f.owner.request({ ...originalRequest, text: "different input" }),
      ).rejects.toThrow("request-id-reused-with-different-input");
      const newSend = await rejectedControl(f.control(session.id));
      expect(newSend).toMatchObject({ accepted: false, controlOutcome: "not-dispatched" });
      expect(JSON.stringify(newSend)).toContain("claude-owner-busy");
      expect(f.frames()).toEqual(before);

      await stop(external);
      await f.dispatch(session.id);
      expect(f.frames().filter((frame) => frame.type === "user")).toHaveLength(2);
    });

    it("counts each initializing worker once while retaining the eight-worker limit", async () => {
      const f = fixture();
      const initialized = deferred();
      cleanups.push(() => initialized.resolve());
      const workers = new Set<ClaudeManagedRunnerProcess>();
      // Model the interval after spawn and before initialize resolves: both the physical worker
      // and the pending reservation refer to the same session, consuming exactly one slot.
      vi.spyOn(ClaudeManagedRunnerProcess.prototype, "hasWorker", "get").mockImplementation(
        function () {
          return workers.has(this);
        },
      );
      vi.spyOn(ClaudeManagedRunnerProcess.prototype, "send").mockImplementation(async function () {
        workers.add(this);
        try {
          await initialized.promise;
        } finally {
          workers.delete(this);
        }
      });
      const pending: Promise<unknown>[] = [];
      for (let index = 0; index < 8; index++) {
        const session = f.create();
        pending.push(rejectedControl(f.control(session.id)));
        await expect.poll(() => workers.size).toBe(index + 1);
      }
      const ninth = f.create();

      const rejected = await rejectedControl(f.control(ninth.id));

      expect(rejected).toMatchObject({ accepted: false });
      expect(JSON.stringify(rejected)).toContain("Claude-runner-limit");
      expect(workers.size).toBe(8);
      initialized.resolve();
      expect(await Promise.all(pending)).toEqual(
        Array.from({ length: 8 }, () => expect.objectContaining({ accepted: true })),
      );
      expect(workers.size).toBe(0);
    });

    it("stops immediately and does not steer after detecting an external owner during a running turn", async () => {
      const probe = vi
        .spyOn(ClaudeSessionOwnerProbe.prototype, "check")
        .mockResolvedValue({ kind: "idle" });
      // A one-minute tick makes this assert the control path's immediate handling, rather than
      // succeeding because a later maintenance check eventually notices the same conflict.
      const f = fixture({ maintenanceIntervalMs: 60_000 });
      const session = f.create();
      await expect(f.control(session.id, "send", { text: "hold result" })).resolves.toMatchObject({
        accepted: true,
      });
      await expect.poll(async () => (await f.owner.live(session.id, true)).status).toBe("running");
      const retained = f.runner(session.nativeId);
      const before = await f.owner.live(session.id, true);
      probe.mockResolvedValue({ kind: "interactive", pid: process.pid, source: "registry" });
      const clock = Date.now.bind(Date);
      vi.spyOn(Date, "now").mockImplementation(() => clock() + 61_000);
      const busyCapabilities = await f.owner.capabilities(session.id, true);
      expect(retained.hasWorker).toBe(true);

      const rejected = await rejectedControl(
        f.control(session.id, "steer", {
          text: "must not reach the worker",
          turnId: before.turnId,
        }),
      );

      expect(rejected).toMatchObject({ accepted: false, controlOutcome: "not-dispatched" });
      expect(JSON.stringify(rejected)).toContain("claude-owner-busy");
      expect(retained.hasWorker).toBe(false);
      expect(f.frames().filter((frame) => frame.type === "user")).toHaveLength(1);
      expect(await f.owner.live(session.id, true)).toMatchObject({
        sendEnabled: false,
        ownershipReason: "owner-opened-elsewhere",
        executionLocation: "external",
      });
      const capabilities = await f.owner.capabilities(session.id, true);
      for (const projected of [busyCapabilities, capabilities])
        expect(projected).toMatchObject({
          features: {
            steer: { available: false },
            approve: { available: false },
            answer: { available: false },
          },
        });
    });

    it("does not start a worker or retain leases after shutdown during the startup owner check", async () => {
      const entered = deferred();
      const gate = deferred();
      const originalSend = ClaudeManagedRunnerProcess.prototype.send;
      let atStartup = false;
      let blocked = false;
      vi.spyOn(ClaudeSessionOwnerProbe.prototype, "check").mockImplementation(async () => {
        if (atStartup && !blocked) {
          blocked = true;
          entered.resolve();
          await gate.promise;
        }
        return { kind: "idle" };
      });
      const f = fixture();
      cleanups.push(() => gate.resolve());
      const session = f.create();
      vi.spyOn(ClaudeManagedRunnerProcess.prototype, "send").mockImplementation(function (...args) {
        atStartup = true;
        return originalSend.apply(this, args);
      });
      const pending = rejectedControl(f.control(session.id));
      await expect(
        Promise.race([
          entered.promise.then(() => "entered"),
          pending.then((outcome) => JSON.stringify(outcome)),
        ]),
      ).resolves.toBe("entered");
      const retained = f.runner(session.nativeId);
      // Even a failing assertion must clean up a worker wrongly created after owner shutdown.
      cleanups.push(() => retained.shutdown());

      const shutdown = f.owner.shutdown();
      await new Promise<void>((resolve) => setImmediate(resolve));
      gate.resolve();
      const [outcome] = await Promise.all([pending, shutdown]);

      expect(outcome).toMatchObject({ accepted: false, controlOutcome: "not-dispatched" });
      expect(retained.hasWorker).toBe(false);
      expect(f.frames()).toEqual([]);
      const dataHome =
        process.platform === "darwin"
          ? path.join(f.root, "home", "Library", "Application Support")
          : path.join(f.root, "home", "data");
      for (const lock of [
        path.join(f.root, "claude-managed", `${session.id}.lock`),
        path.join(dataHome, "agentkib", "claude-runner-locks", `${session.nativeId}.lock`),
      ]) {
        if (!existsSync(lock)) continue;
        const release = acquirePortableFileLease(lock);
        release();
      }
    });

    it("publishes starting during the owner check and remembers a subscriber that leaves before startup completes", async () => {
      const entered = deferred();
      const gate = deferred();
      const originalSend = ClaudeManagedRunnerProcess.prototype.send;
      let atStartup = false;
      let blocked = false;
      let observed = true;
      vi.spyOn(ClaudeSessionOwnerProbe.prototype, "check").mockImplementation(async () => {
        if (atStartup && !blocked) {
          blocked = true;
          entered.resolve();
          await gate.promise;
        }
        return { kind: "idle" };
      });
      const f = fixture({
        idleTimeoutMs: 60_000,
        maintenanceIntervalMs: 10,
        isSessionObserved: () => observed,
      });
      cleanups.push(() => gate.resolve());
      const session = f.create();
      vi.spyOn(ClaudeManagedRunnerProcess.prototype, "send").mockImplementation(function (...args) {
        atStartup = true;
        return originalSend.apply(this, args);
      });
      const pending = rejectedControl(f.control(session.id));
      await expect(
        Promise.race([
          entered.promise.then(() => "entered"),
          pending.then((outcome) => JSON.stringify(outcome)),
        ]),
      ).resolves.toBe("entered");
      const retained = f.runner(session.nativeId);
      cleanups.push(() => retained.shutdown());
      f.owner.observeSession(session.id);
      const starting = await f.owner.live(session.id, true);
      observed = false;
      gate.resolve();
      const outcome = await pending;

      expect(starting).toMatchObject({
        status: "starting",
        executionLocation: "agentkib",
        sendEnabled: false,
      });
      expect(f.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: session.id,
            type: "state",
            live: expect.objectContaining({ status: "starting", executionLocation: "agentkib" }),
          }),
        ]),
      );
      expect(outcome).toMatchObject({ accepted: true });
      await expect.poll(() => retained.hasWorker).toBe(false);
      expect(f.frames().filter((frame) => frame.type === "user")).toHaveLength(1);
    });
  },
);
