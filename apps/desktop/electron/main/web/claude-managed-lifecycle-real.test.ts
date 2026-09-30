// @vitest-environment node
// Opt-in: one billed turn at most. Never rerun an attempted directory.
import { it, expect } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, access, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { PROTOCOL_VERSION } from "../../generated/runtime-protocol";
import { WebAccessService } from "./service";
import { approveLegacyBrowser } from "./legacy-pairing-fixture";
type Live = {
  revision: number;
  status: string;
  reason?: string;
  streamText?: string;
  model?: string;
  tokenUsage?: unknown;
  questions: {
    requestId: string | number;
    turnId: string;
    questions: { id: string; options: { label: string }[] }[];
  }[];
  approvals: { requestId: string | number; turnId: string; toolName?: string; input?: unknown }[];
};
type ConversationEventPage = { events: { kind: string; content?: string }[] };

const enabled = process.env.AGENTKIB_CLAUDE_LIFECYCLE_DIR;
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
it.skipIf(!enabled)(
  "Claude native cancel or abnormal Runtime restart with one user turn",
  async () => {
    const requestedRoot = resolve(enabled!);
    if (
      !requestedRoot.startsWith("/tmp/agentkib-claude-lifecycle") &&
      !requestedRoot.startsWith("/private/tmp/agentkib-claude-lifecycle")
    )
      throw new Error("isolated_native_directory_required");
    const root = await mkdir(requestedRoot, { recursive: true, mode: 0o700 }).then(() =>
      realpath(requestedRoot),
    );
    if (
      !root.startsWith("/tmp/agentkib-claude-lifecycle") &&
      !root.startsWith("/private/tmp/agentkib-claude-lifecycle")
    )
      throw new Error("isolated_native_directory_required");
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(
      join(root, "attempt.json"),
      JSON.stringify({ started: new Date().toISOString(), maxModelSends: 1 }),
      { flag: "wx", mode: 0o600 },
    );
    const settings = "/Users/kouzen/.claude/settings.json";
    const executable = "/Users/kouzen/.local/bin/claude";
    // Explicit acceptance-only override for a model selected by the user in an
    // external configuration manager but not yet written to Claude settings.
    const requestedModel = "deepseek-v4-pro";
    const mode = process.env.AGENTKIB_CLAUDE_LIFECYCLE_MODE;
    if (mode !== "cancel" && mode !== "crash" && mode !== "cancel-question" && mode !== "complete")
      throw new Error("invalid_lifecycle_mode");
    if (requestedModel && !/^[a-zA-Z0-9._/-]{1,160}$/.test(requestedModel))
      throw new Error("invalid_native_model");
    const runtimePath = resolve(
      process.env.AGENTKIB_NATIVE_RUNTIME ?? "../../target/debug/agentkib-runtime",
    );
    const settingsBefore = sha(await readFile(settings));
    const result: Record<string, unknown> = {
      root,
      runtimeSha256: sha(await readFile(runtimePath)),
      started: new Date().toISOString(),
      modelSends: 0,
      requestedModel: requestedModel ?? null,
      mode,
    };
    const config = join(root, "claude-config"),
      workspace = join(root, "workspace"),
      bin = join(root, "bin");
    await Promise.all(
      [config, workspace, bin].map((dir) => mkdir(dir, { recursive: true, mode: 0o700 })),
    );
    const launches = join(root, "model-launches");
    const pidFile = join(root, "owned-cli-pid");
    const captureShim = join(root, "capture-native.py");
    await writeFile(
      captureShim,
      `import json, os, subprocess, sys
p=subprocess.Popen(sys.argv[1:],stdin=sys.stdin,stdout=subprocess.PIPE)
try:
 for row in iter(p.stdout.readline,b''):
  try:
   frame=json.loads(row)
   if frame.get('type')=='system' and (str(frame.get('subtype','')).startswith('task_') or frame.get('subtype')=='background_tasks_changed'):
    with open(${JSON.stringify(join(root, "native-task-frames.jsonl"))},'a') as out: out.write(json.dumps(frame)+'\\n')
   elif frame.get('type')=='assistant':
    blocks=[b for b in frame.get('message',{}).get('content',[]) if b.get('type')=='tool_use']
    if blocks:
     with open(${JSON.stringify(join(root, "native-task-frames.jsonl"))},'a') as out: out.write(json.dumps({'type':'assistant','session_id':frame.get('session_id'),'message':{'content':blocks}})+'\\n')
  except (ValueError,KeyError,AttributeError): pass
  sys.stdout.buffer.write(row);sys.stdout.buffer.flush()
finally:
 p.wait()
sys.exit(p.returncode)
`,
      { mode: 0o600 },
    );
    await writeFile(
      join(bin, "claude"),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then exec '${executable}' "$@"; fi\nprintf 'launch\\n' >> '${launches}'\nprintf '%s\\n' "$$" > '${pidFile}'\nexec /usr/bin/python3 '${captureShim}' '${executable}' --settings '${settings}' --safe-mode --setting-sources '' --strict-mcp-config --max-budget-usd 0.50 ${requestedModel ? `--model '${requestedModel}' ` : ""}"$@"\n`,
      { mode: 0o700 },
    );
    const env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: config,
      AGENTKIB_BENCHMARK_DATA_DIR: join(root, "runtime-data"),
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    };
    await mkdir(env.AGENTKIB_BENCHMARK_DATA_DIR, { recursive: true, mode: 0o700 });
    const mcpPortProbe = createServer();
    await new Promise<void>((done) => mcpPortProbe.listen(0, "127.0.0.1", done));
    const mcpPort = (mcpPortProbe.address() as { port: number }).port;
    await new Promise<void>((done) => mcpPortProbe.close(() => done()));
    await writeFile(
      join(env.AGENTKIB_BENCHMARK_DATA_DIR, "preferences.json"),
      JSON.stringify({
        mcp_network: { port: mcpPort, lan_enabled: false, lan_risk_accepted: false },
      }),
      { mode: 0o600 },
    );
    result.mcpPort = mcpPort;
    let sequence = 0;
    let child!: ReturnType<typeof spawn>;
    const pending = new Map<
      number,
      {
        resolve(value: unknown): void;
        reject(error: Error): void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    function start() {
      child = spawn(runtimePath, [], { cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"] });
      child.stderr!.resume();
      createInterface({ input: child.stdout! }).on("line", (line) => {
        const message = JSON.parse(line) as {
          id: number;
          result?: unknown;
          error?: { message?: string };
        };
        const flight = pending.get(message.id);
        if (!flight) return;
        clearTimeout(flight.timer);
        pending.delete(message.id);
        if (message.error) flight.reject(new Error(message.error.message ?? "runtime_error"));
        else flight.resolve(message.result);
      });
      child.on("exit", (code, signal) => {
        result.runtimeExit = { code, signal };
        for (const flight of pending.values()) {
          clearTimeout(flight.timer);
          flight.reject(new Error("runtime_exited"));
        }
        pending.clear();
      });
    }
    function rpc<T>(method: string, params: unknown): Promise<T> {
      const id = ++sequence;
      result.lastRpcMethod = method;
      result.lastRpcOperation =
        params && typeof params === "object" && "operation" in params
          ? params.operation
          : undefined;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("runtime_timeout"));
        }, 15000);
        pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
        child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    }
    async function stop() {
      if (!child || child.exitCode !== null) return;
      const exiting = new Promise<void>((done) => child.once("exit", () => done()));
      child.stdin!.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      await exiting;
      clearTimeout(timer);
    }
    let service: WebAccessService | undefined;
    const started = Date.now();
    try {
      start();
      await rpc("agentkib.handshake", {
        protocolVersion: PROTOCOL_VERSION,
        client: { name: "agentkib-native-acceptance", version: "0.12.0" },
      });
      const ws = await rpc<{ id: string }>("workspace.add", { path: workspace });
      service = new WebAccessService({
        dataDir: join(root, "web-data"),
        staticDir: workspace,
        runtimeRequest: (params) => rpc("web.request", params),
        claudeManagedRequest: (params) => rpc("claude.managed", params),
        receiptRequest: (params) => rpc("control.receipt", params),
        workspaceRequest: async () => [
          { id: ws.id, name: "Synthetic acceptance", path: workspace },
        ],
        verifiedClaudeManaged: true,
      });
      await service.initialize();
      const server = createServer();
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      const port = (server.address() as { port: number }).port;
      await new Promise<void>((done) => server.close(() => done()));
      await service.request({
        operation: "configure",
        enabled: true,
        port,
        externalOrigin: "",
        experimentalEnabled: true,
        allowedWorkspaceIds: [ws.id],
      });
      const origin = `http://127.0.0.1:${port}`;
      const first = await fetch(`${origin}/api/web/v1/access`);
      const cookie = first.headers.get("set-cookie")!.split(";")[0];
      await approveLegacyBrowser(service, cookie, {
        send: true,
        approve: true,
        manage: true,
        files: true,
        attachments: true,
      });
      const web = async (path: string) => {
        const response = await fetch(`${origin}/api/web/v1/${path}`, {
          headers: { Cookie: cookie },
        });
        if (!response.ok) throw new Error(`web_${response.status}`);
        return response.json();
      };
      const options = (await service.localClaude({ operation: "options" })) as {
        available: boolean;
        cliVersion?: string;
        reason?: string;
      };
      result.cliVersion = options.cliVersion;
      if (!options.available) throw new Error(options.reason ?? "claude_unavailable");
      const created = (await service.localClaude({
        operation: "create",
        workspaceId: ws.id,
        requestId: randomUUID(),
      })) as { accepted: boolean; sessionId: string; sourceSessionId: string };
      expect(created.accepted).toBe(true);
      result.sessionId = created.sessionId;
      result.sourceSessionId = created.sourceSessionId;
      const sessionId = created.sessionId;
      const empty = (await service.localClaude({
        operation: "events",
        sessionId,
      })) as ConversationEventPage;
      expect(empty.events).toHaveLength(0);
      result.emptyWithoutModel = await access(launches).then(
        () => false,
        () => true,
      );
      expect(result.emptyWithoutModel).toBe(true);
      const catalog = await web("catalog");
      expect(catalog.sessions.some((s: { id: string }) => s.id === sessionId)).toBe(true);
      result.webSameSession = true;
      const before = (await service.localClaude({ operation: "live", sessionId })) as Live;
      const sendId = randomUUID();
      result.modelSends = 1;
      const completionMarker = `AGENTKIB_FOREGROUND_${randomUUID()}`;
      const exactCommand =
        mode === "complete" ? `sleep 6; printf '${completionMarker}'` : "sleep 30";
      const text =
        mode === "cancel-question"
          ? "Use AskUserQuestion to ask me to choose exactly one option, amber or teal, for a synthetic theme. Wait for my answer. Do not choose for me and do not use any other tool."
          : `Use Bash to run exactly \`${exactCommand}\` once in the foreground. Do not use background mode, do not run any other command and do not edit any files. After it finishes reply with the exact command output (or DONE if empty).`;
      const accepted = (await service.localClaude({
        operation: "send",
        sessionId,
        requestId: sendId,
        expectedRevision: before.revision,
        text,
      })) as { accepted: boolean };
      expect(accepted.accepted).toBe(true);
      let live: Live = before;
      let cliPid = 0;
      let observedSleep = false;
      let foregroundTaskObserved = false;
      let ownedSleepPid = 0;
      let approvalSeen = false;
      let nativeUserObserved = false;
      let pendingQuestion: Live["questions"][number] | undefined;
      const approved = new Set<string | number>();
      while (Date.now() - started < 60000) {
        live = (await service.localClaude({ operation: "live", sessionId })) as Live;
        cliPid = await readFile(pidFile, "utf8").then(
          (value) => Number(value.trim()),
          () => 0,
        );
        if (mode === "cancel-question" && live.questions.length) {
          pendingQuestion = live.questions[0];
          break;
        }
        if (mode === "crash" && cliPid > 0) {
          const nativeLog = join(
            config,
            "projects",
            workspace.replace(/[^a-zA-Z0-9]/g, "-"),
            `${created.sourceSessionId}.jsonl`,
          );
          nativeUserObserved = await readFile(nativeLog, "utf8").then(
            (value) => value.includes(text),
            () => false,
          );
          if (
            nativeUserObserved &&
            ["running", "waiting-approval", "waiting-input"].includes(live.status)
          )
            break;
        }
        if (mode === "crash" && live.approvals.length) {
          approvalSeen = true;
          break;
        }
        for (const item of live.approvals) {
          if (approved.has(item.requestId)) continue;
          const input = item.input as { command?: string; run_in_background?: boolean } | undefined;
          if (
            item.toolName !== "Bash" ||
            input?.command !== exactCommand ||
            input.run_in_background === true
          )
            throw new Error("unexpected_tool_request");
          approved.add(item.requestId);
          await service.localClaude({
            operation: "approve",
            sessionId,
            requestId: randomUUID(),
            expectedRevision: live.revision,
            turnId: item.turnId,
            approvalId: item.requestId,
            decision: "allow",
          });
        }
        if (cliPid > 0) {
          const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,command="], {
            encoding: "utf8",
          })
            .split("\n")
            .flatMap((line) => {
              const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
              return match
                ? [{ pid: Number(match[1]), parent: Number(match[2]), command: match[3] }]
                : [];
            });
          const descendants = new Set([cliPid]);
          for (let i = 0; i < rows.length; i++) {
            const size = descendants.size;
            for (const row of rows) if (descendants.has(row.parent)) descendants.add(row.pid);
            if (descendants.size === size) break;
          }
          const sleep = rows.find(
            (row) => descendants.has(row.pid) && /^(?:\/bin\/)?sleep 30$/.test(row.command),
          );
          observedSleep = !!sleep;
          ownedSleepPid = sleep?.pid ?? 0;
        }
        if (mode === "complete" && live.status === "idle") break;
        if (mode === "cancel" && observedSleep) {
          foregroundTaskObserved = await readFile(
            join(root, "native-task-frames.jsonl"),
            "utf8",
          ).then(
            (value) =>
              value
                .split("\n")
                .filter(Boolean)
                .some((line) => {
                  const frame = JSON.parse(line);
                  return (
                    frame.type === "system" &&
                    frame.subtype === "task_started" &&
                    frame.task_type === "local_bash" &&
                    frame.is_backgrounded === false
                  );
                }),
            () => false,
          );
        }
        if (
          (mode === "cancel" && observedSleep && foregroundTaskObserved) ||
          (mode === "crash" && observedSleep)
        )
          break;
        if (live.status === "idle" || live.status === "outcome-unknown")
          throw new Error(`premature_${live.status}: ${live.reason ?? ""}`);
        await new Promise((done) => setTimeout(done, 100));
      }
      result.approvalCount = approved.size;
      result.nativeApprovalObserved = approvalSeen;
      result.nativeUserObserved = nativeUserObserved;
      result.nativeSleepObserved = observedSleep;
      result.foregroundTaskObserved = foregroundTaskObserved;
      result.cliPid = cliPid;
      result.ownedSleepPid = ownedSleepPid;
      expect(cliPid).toBeGreaterThan(0);
      if (mode === "complete") {
        expect(live.status).toBe("idle");
        const completedEvents = (await service.localClaude({
          operation: "events",
          sessionId,
        })) as ConversationEventPage;
        const reply = completedEvents.events
          .filter((event) => event.kind === "agent-message")
          .map((event) => event.content ?? "")
          .join("\n");
        result.replyContainsMarker = reply.includes(completionMarker);
        expect(result.replyContainsMarker).toBe(true);
        const frames = (await readFile(join(root, "native-task-frames.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { type: string; subtype?: string });
        result.nativeTaskSubtypes = frames
          .filter((frame) => frame.type === "system")
          .map((frame) => frame.subtype);
        expect(result.nativeTaskSubtypes).toContain("task_started");
        expect(result.nativeTaskSubtypes).toContain("task_notification");
        result.completedState = live.status;
        result.usage = live.tokenUsage;
        await stop();
      } else if (mode === "cancel" || mode === "cancel-question") {
        if (mode === "cancel") {
          expect(observedSleep).toBe(true);
          expect(foregroundTaskObserved).toBe(true);
        } else expect(pendingQuestion).toBeDefined();
        live = (await service.localClaude({ operation: "live", sessionId })) as Live;
        const stopped = (await service.localClaude({
          operation: "stop",
          sessionId,
          requestId: randomUUID(),
          expectedRevision: live.revision,
          turnId: (live as Live & { turnId: string }).turnId,
        })) as { accepted: boolean };
        expect(stopped.accepted).toBe(true);
        const cancelled = (await service.localClaude({ operation: "live", sessionId })) as Live & {
          lastOutcome: string;
        };
        result.cancelledState = cancelled.status;
        result.lastOutcome = cancelled.lastOutcome;
        expect(cancelled.status).toBe("idle");
        expect(cancelled.lastOutcome).toBe("cancelled");
        if (pendingQuestion) {
          result.nativeQuestionObserved = true;
          expect(cancelled.questions).toHaveLength(0);
          const stale = (await service.localClaude({
            operation: "answer",
            sessionId,
            requestId: randomUUID(),
            expectedRevision: live.revision,
            turnId: pendingQuestion.turnId,
            questionId: pendingQuestion.requestId,
            answers: Object.fromEntries(
              pendingQuestion.questions.map((q) => [q.id, [q.options[0].label]]),
            ),
          })) as { accepted: boolean; controlOutcome: string };
          result.staleAnswerRejected =
            stale.accepted === false && stale.controlOutcome === "not-dispatched";
          expect(result.staleAnswerRejected).toBe(true);
        }
      } else {
        expect(nativeUserObserved || approvalSeen || observedSleep).toBe(true);
        const preCrash = (await service.localClaude({ operation: "live", sessionId })) as Live;
        result.preCrashStatus = preCrash.status;
        result.preCrashReason = preCrash.reason ?? null;
        result.preCrashRevision = preCrash.revision;
        expect(["running", "waiting-approval", "waiting-input"]).toContain(preCrash.status);
        const exited = new Promise<void>((done) => child.once("exit", () => done()));
        child.kill("SIGKILL");
        await exited;
        // An abnormal host death cannot run Drop. Clean only the subprocess group
        // captured by our own wrapper before restarting for read-only recovery.
        try {
          process.kill(-cliPid, "SIGTERM");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
        result.forcedRuntimeExit = true;
        start();
        await rpc("agentkib.handshake", {
          protocolVersion: PROTOCOL_VERSION,
          client: { name: "native-crash-recovery", version: "0.12.0" },
        });
        const restored = (await service.localClaude({ operation: "live", sessionId })) as Live & {
          sendEnabled: boolean;
          questions: unknown[];
        };
        result.restoredStatus = restored.status;
        result.sendDisabled = restored.sendEnabled === false;
        result.oldFormsCleared = restored.approvals.length === 0 && restored.questions.length === 0;
        expect(restored.status).toBe("outcome-unknown");
        expect(result.sendDisabled).toBe(true);
        expect(result.oldFormsCleared).toBe(true);
        const receipt = (await service.localClaude({
          operation: "receipt",
          requestId: sendId,
        })) as {
          status: string;
          completionObserved: boolean;
          found: boolean;
          requestId: string;
          sessionId: string;
          operation: string;
        };
        result.receipt = receipt;
        expect(receipt.found).toBe(true);
        expect(receipt.requestId).toBe(sendId);
        expect(receipt.sessionId).toBe(sessionId);
        expect(receipt.operation).toBe("send");
        expect(receipt.completionObserved).toBe(false);
        const reconciled = (await service.localClaude({
          operation: "reconcile",
          sessionId,
          requestId: randomUUID(),
        })) as Record<string, unknown>;
        result.reconcileAccepted = reconciled.accepted;
        const final = (await service.localClaude({ operation: "live", sessionId })) as Live & {
          sendEnabled: boolean;
        };
        expect(final.sendEnabled).toBe(false);
      }
      const deadline = Date.now() + 5000;
      let groupAlive = true;
      while (Date.now() < deadline) {
        // macOS kill(-pgid, 0) can report EPERM after the group has vanished;
        // inspect the process table and distinguish a reaping zombie from execution.
        const processes = execFileSync("/bin/ps", ["-axo", "pid=,pgid=,stat="], {
          encoding: "utf8",
        })
          .split("\n")
          .flatMap((line) => {
            const parts = line.trim().split(/\s+/);
            return parts.length === 3
              ? [{ pid: Number(parts[0]), group: Number(parts[1]), status: parts[2] }]
              : [];
          });
        const remaining = processes.filter(
          (row) =>
            (row.group === cliPid || (ownedSleepPid > 0 && row.pid === ownedSleepPid)) &&
            !row.status.includes("Z"),
        );
        result.remainingOwnedProcesses = remaining;
        if (remaining.length === 0) {
          groupAlive = false;
          break;
        }
        await new Promise((done) => setTimeout(done, 50));
      }
      result.ownedProcessGroupExited = !groupAlive;
      expect(result.ownedProcessGroupExited).toBe(true);
      result.passed = true;
    } catch (e) {
      result.failure = e instanceof Error ? e.message : "native_acceptance_failed";
      throw e;
    } finally {
      await service?.shutdown();
      await stop();
      const ownedPid = await readFile(pidFile, "utf8").then(
        (v) => Number(v.trim()),
        () => 0,
      );
      if (ownedPid > 0) {
        try {
          process.kill(-ownedPid, "SIGTERM");
        } catch {}
      }
      result.settingsUnchanged = sha(await readFile(settings)) === settingsBefore;
      result.elapsedMs = Date.now() - started;
      result.launchCount = await readFile(launches, "utf8").then(
        (value) => value.trim().split("\n").length,
        () => 0,
      );
      await writeFile(join(root, "results.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
      expect(result.settingsUnchanged).toBe(true);
      expect(result.launchCount).toBe(1);
    }
  },
  120000,
);
