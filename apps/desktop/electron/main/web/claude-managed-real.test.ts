// @vitest-environment node
// Opt-in: one billed turn at most. Never rerun an attempted directory.
import { it, expect } from "vitest";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, access, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { deflateSync } from "node:zlib";
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
  approvals: { requestId: string | number; turnId: string; toolName?: string; input?: unknown }[];
};
type ConversationEventPage = { events: { kind: string; content?: string }[] };

const enabled = process.env.AGENTKIB_CLAUDE_NATIVE_DIR;
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
function png() {
  function chunk(name: string, payload: Buffer) {
    const data = Buffer.concat([Buffer.from(name), payload]);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const size = Buffer.alloc(4);
    size.writeUInt32BE(payload.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, data, checksum]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(32, 0);
  header.writeUInt32BE(32, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc(32 * (1 + 32 * 3));
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) rows[y * 97 + 1 + x * 3 + 2] = 255;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

it.skipIf(!enabled)(
  "Claude native owner create, image/file turn, Web readback and Runtime restart",
  async () => {
    const requestedRoot = resolve(enabled!);
    if (
      !requestedRoot.startsWith("/tmp/agentkib-claude-v1-native") &&
      !requestedRoot.startsWith("/private/tmp/agentkib-claude-v1-native")
    )
      throw new Error("isolated_native_directory_required");
    const root = await mkdir(requestedRoot, { recursive: true, mode: 0o700 }).then(() =>
      realpath(requestedRoot),
    );
    if (
      !root.startsWith("/tmp/agentkib-claude-v1-native") &&
      !root.startsWith("/private/tmp/agentkib-claude-v1-native")
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
    const requestedModel = process.env.AGENTKIB_CLAUDE_NATIVE_MODEL;
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
    };
    const home = join(root, "home"),
      config = join(root, "claude-config"),
      workspace = join(root, "workspace"),
      bin = join(root, "bin");
    await Promise.all(
      [home, config, workspace, bin].map((dir) => mkdir(dir, { recursive: true, mode: 0o700 })),
    );
    const launches = join(root, "model-launches");
    await writeFile(
      join(bin, "claude"),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then exec '${executable}' "$@"; fi\nprintf 'launch\\n' >> '${launches}'\nexec '${executable}' --settings '${settings}' --safe-mode --setting-sources '' --strict-mcp-config --max-budget-usd 0.50 ${requestedModel ? `--model '${requestedModel}' ` : ""}"$@"\n`,
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
      const marker = randomUUID();
      const file = Buffer.from(
        `Synthetic acceptance secret marker: ${marker}. Project decision: storage namespace cobalt-lake.\n`,
      );
      const fileAttachment = (await service.localClaude({
        operation: "upload",
        sessionId,
        name: "context-fixture.txt",
        mime: "text/plain",
        bytes: file,
      })) as { id: string };
      const imageAttachment = (await service.localClaude({
        operation: "upload",
        sessionId,
        name: "color.png",
        mime: "image/png",
        bytes: png(),
      })) as { id: string };
      const before = (await service.localClaude({ operation: "live", sessionId })) as Live;
      const sendId = randomUUID();
      result.modelSends = 1;
      const accepted = (await service.localClaude({
        operation: "send",
        sessionId,
        requestId: sendId,
        expectedRevision: before.revision,
        text: "Read only the attached text file. Return the exact secret marker and project decision from its content, then name the solid color in the attached image. The marker is not in this prompt. Do not write files or run commands. Reply briefly.",
        attachmentIds: [fileAttachment.id, imageAttachment.id],
      })) as { accepted: boolean; error?: string };
      result.sendAccepted = accepted.accepted;
      if (!accepted.accepted) throw new Error(accepted.error ?? "send_not_accepted");
      const approved = new Set<string | number>();
      let live: Live = before;
      while (Date.now() - started < 90000) {
        live = (await service.localClaude({ operation: "live", sessionId })) as Live;
        for (const item of live.approvals) {
          if (approved.has(item.requestId)) continue;
          const input = item.input as { file_path?: string } | undefined;
          const allowed =
            item.toolName === "Read" &&
            typeof input?.file_path === "string" &&
            resolve(input.file_path).startsWith(`${root}/`);
          approved.add(item.requestId);
          await service.localClaude({
            operation: "approve",
            sessionId,
            requestId: randomUUID(),
            expectedRevision: live.revision,
            turnId: item.turnId,
            approvalId: item.requestId,
            decision: allowed ? "allow" : "deny",
          });
        }
        if (live.status === "idle" || live.status === "outcome-unknown") break;
        await new Promise((done) => setTimeout(done, 200));
      }
      result.status = live.status;
      result.reason = live.reason;
      result.model = live.model;
      result.usage = live.tokenUsage;
      result.approvalCount = approved.size;
      const events = (await service.localClaude({
        operation: "events",
        sessionId,
      })) as ConversationEventPage;
      const reply =
        events.events
          .filter((event) => event.kind === "agent-message")
          .map((event) => event.content ?? "")
          .join("\n") ||
        live.streamText ||
        "";
      result.reply = reply;
      result.markerPresent = reply.includes(marker);
      result.decisionPresent = reply.includes("cobalt-lake");
      result.imageColorPresent = /blue|蓝|藍/i.test(reply);
      result.webEvents = (
        await web(`events?sessionId=${encodeURIComponent(sessionId)}`)
      ).events.length;
      if (live.status !== "idle")
        throw new Error(
          live.status === "outcome-unknown" ? "native_outcome_unknown" : "native_timeout",
        );
      await stop();
      start();
      await rpc("agentkib.handshake", {
        protocolVersion: PROTOCOL_VERSION,
        client: { name: "agentkib-native-acceptance", version: "0.12.0" },
      });
      const restored = (await service.localClaude({
        operation: "events",
        sessionId,
      })) as ConversationEventPage;
      result.runtimeRestartHistory = restored.events.some((event) =>
        event.content?.includes(marker),
      );
      expect(result.markerPresent).toBe(true);
      expect(result.decisionPresent).toBe(true);
      expect(result.imageColorPresent).toBe(true);
      expect(result.runtimeRestartHistory).toBe(true);
    } catch (e) {
      result.failure = e instanceof Error ? e.message : "native_acceptance_failed";
      throw e;
    } finally {
      await service?.shutdown();
      await stop();
      result.settingsUnchanged = sha(await readFile(settings)) === settingsBefore;
      result.elapsedMs = Date.now() - started;
      result.launchCount = await readFile(launches, "utf8").then(
        (value) => value.trim().split("\n").length,
        () => 0,
      );
      await writeFile(join(root, "results.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
    }
  },
  120000,
);
