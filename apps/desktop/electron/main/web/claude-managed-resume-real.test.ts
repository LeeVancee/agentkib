// @vitest-environment node
// Opt-in native resume acceptance: one new user turn, never rerun an attempted directory.
import { it, expect } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { PROTOCOL_VERSION } from "../../generated/runtime-protocol";
import { WebAccessService } from "./service";
import { approveLegacyBrowser } from "./legacy-pairing-fixture";

const enabled = process.env.AGENTKIB_CLAUDE_RESUME_DIR;
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
async function freePort() {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}
type Live = {
  revision: number;
  status: string;
  streamText?: string;
  model?: string;
  tokenUsage?: unknown;
  approvals: unknown[];
  questions: unknown[];
};
type Page = { events: { kind: string; content?: string }[] };
it.skipIf(!enabled)(
  "native same UUID release/adopt, Web resume and exact replay across restart",
  async () => {
    const root = resolve(enabled!);
    if (!root.startsWith("/private/tmp/agentkib-claude-resume-"))
      throw new Error("isolated_attempt_required");
    await mkdir(root, { recursive: true, mode: 0o700 });
    if ((await realpath(root)) !== root) throw new Error("symlink_attempt_rejected");
    await writeFile(
      join(root, "attempt.json"),
      JSON.stringify({ started: new Date().toISOString(), maxNewUserTurns: 1 }),
      { flag: "wx", mode: 0o600 },
    );
    const source = "/private/tmp/agentkib-claude-v1-native-2026-09-30-deepseek";
    const old = JSON.parse(await readFile(join(source, "results.json"), "utf8")) as {
      sessionId: string;
      sourceSessionId: string;
      reply: string;
      runtimeExit: { code: number };
    };
    const marker = old.reply.match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
    )?.[0];
    if (!marker || old.runtimeExit.code !== 0) throw new Error("prior_case_not_stopped");
    const processes = execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" });
    if (
      processes
        .split("\n")
        .some((line) => line.includes(old.sourceSessionId) && /claude/.test(line))
    )
      throw new Error("original_cli_still_running");
    const config = join(source, "claude-config"),
      workspace = join(source, "workspace"),
      bin = join(root, "bin");
    await mkdir(bin, { mode: 0o700 });
    const settings = "/Users/kouzen/.claude/settings.json";
    const settingsBefore = sha(await readFile(settings));
    const launches = join(root, "model-launches");
    await writeFile(
      join(bin, "claude"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then exec '/Users/kouzen/.local/bin/claude' "$@"; fi
printf 'launch\\n' >> '${launches}'
exec '/Users/kouzen/.local/bin/claude' --settings '${settings}' --safe-mode --setting-sources '' --strict-mcp-config --max-budget-usd 0.50 --model 'deepseek-v4-pro' "$@"
`,
      { mode: 0o700 },
    );
    const runtimePath = resolve(
      process.env.AGENTKIB_NATIVE_RUNTIME ?? "../../target/debug/agentkib-runtime",
    );
    const env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: config,
      AGENTKIB_BENCHMARK_DATA_DIR: join(source, "runtime-data"),
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    };
    await writeFile(
      join(env.AGENTKIB_BENCHMARK_DATA_DIR, "preferences.json"),
      JSON.stringify({
        mcp_network: { port: await freePort(), lan_enabled: false, lan_risk_accepted: false },
      }),
      { mode: 0o600 },
    );
    const record = JSON.parse(
      await readFile(
        join(env.AGENTKIB_BENCHMARK_DATA_DIR, "claude-managed", `${old.sessionId}.json`),
        "utf8",
      ),
    ) as { workspaceId: string };
    const projectDir = join(
      config,
      "projects",
      "-private-tmp-agentkib-claude-v1-native-2026-09-30-deepseek-workspace",
    );
    const transcript = join(projectDir, `${old.sourceSessionId}.jsonl`);
    const prefix = await readFile(transcript);
    const sessionFilesBefore = (await readdir(projectDir))
      .filter((x) => x.endsWith(".jsonl"))
      .sort();
    const result: Record<string, unknown> = {
      started: new Date().toISOString(),
      root,
      source,
      sessionId: old.sessionId,
      nativeId: old.sourceSessionId,
      model: "deepseek-v4-pro",
      modelSends: 0,
      originalProcessAbsent: true,
      prefixSha256: sha(prefix),
      runtimeSha256: sha(await readFile(runtimePath)),
    };
    let sequence = 0;
    let child: ReturnType<typeof spawn>;
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
    async function handshake() {
      await rpc("agentkib.handshake", {
        protocolVersion: PROTOCOL_VERSION,
        client: { name: "agentkib-native-resume-acceptance", version: "0.12.0" },
      });
    }
    try {
      start();
      await handshake();
      service = new WebAccessService({
        dataDir: join(root, "web-data"),
        staticDir: workspace,
        runtimeRequest: (params) => rpc("web.request", params),
        claudeManagedRequest: (params) => rpc("claude.managed", params),
        receiptRequest: (params) => rpc("control.receipt", params),
        workspaceRequest: async () => [
          { id: record.workspaceId, name: "Isolated resume", path: workspace },
        ],
        verifiedClaudeManaged: true,
      });
      await service.initialize();
      const port = await freePort();
      await service.request({
        operation: "configure",
        enabled: true,
        port,
        externalOrigin: "",
        experimentalEnabled: true,
        allowedWorkspaceIds: [record.workspaceId],
      });
      const origin = `http://127.0.0.1:${port}`;
      const initial = await fetch(`${origin}/api/web/v1/access`);
      const cookie = initial.headers.get("set-cookie")!.split(";")[0];
      const access = (await initial.json()) as { csrfToken: string; bootId: string };
      await approveLegacyBrowser(service, cookie, {
        send: true,
        approve: true,
        manage: true,
        files: true,
        attachments: true,
      });
      async function web<T>(path: string, body?: unknown): Promise<T> {
        const response = await fetch(`${origin}/api/web/v1/${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            Cookie: cookie,
            Origin: origin,
            "X-CSRF-Token": access.csrfToken,
            "Content-Type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const value = await response.json();
        if (!response.ok) throw new Error(`web_${response.status}_${JSON.stringify(value)}`);
        return value as T;
      }
      const sessionId = old.sessionId;
      const initialLive = await web<Live>(`live?sessionId=${sessionId}`);
      expect(initialLive.status).toBe("idle");
      const released = await web<{ accepted: boolean }>("managed/release", {
        agent: "claude-code",
        sessionId,
        requestId: randomUUID(),
        bootId: access.bootId,
        expectedRevision: initialLive.revision,
      });
      expect(released.accepted).toBe(true);
      const inspection = await web<{ handoffFingerprint: string }>(
        `managed/inspect?agent=claude-code&sessionId=${sessionId}`,
      );
      const adopted = await web<{ accepted: boolean; sourceSessionId: string }>("managed/adopt", {
        agent: "claude-code",
        sessionId,
        requestId: randomUUID(),
        bootId: access.bootId,
        handoffConfirmed: true,
        handoffFingerprint: inspection.handoffFingerprint,
      });
      expect(adopted.accepted).toBe(true);
      result.releaseInspectAdopt = true;
      expect(await readFile(transcript)).toEqual(prefix);
      const before = await web<Live>(`live?sessionId=${sessionId}`);
      const eventsBefore = await web<Page>(`events?sessionId=${sessionId}`);
      const requestId = randomUUID();
      const body = {
        sessionId,
        requestId,
        bootId: access.bootId,
        expectedRevision: before.revision,
        text: "Without reading files or using tools, recall from our previous conversation the exact secret marker and the chosen project storage namespace. Reply with those two values only. The answers are intentionally absent from this message.",
      };
      result.requestId = requestId;
      await writeFile(join(root, "request.json"), JSON.stringify(body), { mode: 0o600 });
      result.modelSends = 1;
      const ack = await web<{ accepted: boolean }>("send", body);
      expect(ack.accepted).toBe(true);
      const replay = await web<{ accepted: boolean }>("send", body);
      expect(replay.accepted).toBe(true);
      result.immediateReplayAccepted = true;
      let live: Live = before;
      while (Date.now() - started < 90000) {
        live = await web<Live>(`live?sessionId=${sessionId}`);
        if (live.approvals.length || live.questions.length)
          throw new Error("unexpected_native_interaction");
        if (live.status === "idle" || live.status === "outcome-unknown") break;
        await new Promise((done) => setTimeout(done, 200));
      }
      result.status = live.status;
      result.reportedModel = live.model;
      result.usage = live.tokenUsage;
      const events = await web<Page>(`events?sessionId=${sessionId}`);
      const newEvents = events.events.slice(eventsBefore.events.length);
      const reply =
        newEvents
          .filter((x) => x.kind === "agent-message")
          .map((x) => x.content ?? "")
          .join("\n") ||
        live.streamText ||
        "";
      result.reply = reply;
      result.markerPresent = reply.includes(marker);
      result.decisionPresent = reply.includes("cobalt-lake");
      const after = await readFile(transcript);
      result.originalPrefixUnchanged = after.subarray(0, prefix.length).equals(prefix);
      const appended = after
        .subarray(prefix.length)
        .toString("utf8")
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } },
        );
      result.appendedUserTurns = appended.filter(
        (x) => x.type === "user" && (JSON.stringify(x.message?.content) ?? "").includes(body.text),
      ).length;
      result.nativeToolUses = appended.filter((x) =>
        (JSON.stringify(x.message?.content) ?? "").includes('"type":"tool_use"'),
      ).length;
      result.noNewNativeSession =
        JSON.stringify((await readdir(projectDir)).filter((x) => x.endsWith(".jsonl")).sort()) ===
        JSON.stringify(sessionFilesBefore);
      expect(live.status).toBe("idle");
      expect(result.markerPresent).toBe(true);
      expect(result.decisionPresent).toBe(true);
      expect(result.originalPrefixUnchanged).toBe(true);
      expect(result.appendedUserTurns).toBe(1);
      expect(result.nativeToolUses).toBe(0);
      expect(result.noNewNativeSession).toBe(true);
      await stop();
      start();
      await handshake();
      const restored = await web<Page>(`events?sessionId=${sessionId}`);
      result.restartHistorySame = JSON.stringify(restored.events) === JSON.stringify(events.events);
      expect(result.restartHistorySame).toBe(true);
      const restartedReplay = await web<{ accepted: boolean }>("send", body);
      expect(restartedReplay.accepted).toBe(true);
      result.replayAfterRestartAccepted = true;
      expect(await readFile(transcript)).toEqual(after);
      result.replayAfterRestartHistoryUnchanged = true;
      result.passed = true;
    } catch (error) {
      result.failure = error instanceof Error ? error.message : "native_resume_failed";
      throw error;
    } finally {
      await service?.shutdown();
      await stop();
      result.settingsUnchanged = sha(await readFile(settings)) === settingsBefore;
      result.elapsedMs = Date.now() - started;
      result.launchCount = await readFile(launches, "utf8").then(
        (v) => v.trim().split("\n").length,
        () => 0,
      );
      await writeFile(join(root, "results.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
      expect(result.settingsUnchanged).toBe(true);
      expect(result.launchCount).toBe(1);
    }
  },
  120000,
);
