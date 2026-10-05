// @vitest-environment node
// Opt-in: one billed turn at most. Never rerun an attempted directory.
import { it, expect } from "vitest";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, access, realpath, readdir } from "node:fs/promises";
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
  approvals: { requestId: string | number; turnId: string; toolName?: string; input?: unknown }[];
  questions: {
    requestId: string | number;
    turnId: string;
    supported: boolean;
    questions: { id: string; options: { label: string }[] }[];
  }[];
};
type ConversationEventPage = { events: { kind: string; content?: string }[] };

const enabled = process.env.AGENTKIB_CLAUDE_INTERACTION_DIR;
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
it.skipIf(!enabled)(
  "Claude native owner approval and Web question invalidate opposite-client forms",
  async () => {
    const requestedRoot = resolve(enabled!);
    if (
      !requestedRoot.startsWith("/tmp/agentkib-claude-interaction-native") &&
      !requestedRoot.startsWith("/private/tmp/agentkib-claude-interaction-native")
    )
      throw new Error("isolated_native_directory_required");
    const root = await mkdir(requestedRoot, { recursive: true, mode: 0o700 }).then(() =>
      realpath(requestedRoot),
    );
    if (
      !root.startsWith("/tmp/agentkib-claude-interaction-native") &&
      !root.startsWith("/private/tmp/agentkib-claude-interaction-native")
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
    await mkdir(join(workspace, ".claude"), { mode: 0o700 });
    // Synthetic-test constraint only: never modifies or copies user settings.
    await writeFile(
      join(workspace, ".claude", "settings.local.json"),
      JSON.stringify({
        permissions: { ask: ["Write", "Edit", "Bash"] },
      }),
      { mode: 0o600 },
    );
    result.permissionTestConstraint =
      "isolated local settings ask Write/Edit/Bash; permission-mode default";
    const launches = join(root, "model-launches");
    await writeFile(
      join(bin, "claude"),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then exec '${executable}' "$@"; fi\nprintf 'launch\\n' >> '${launches}'\nexec '${executable}' --settings '${settings}' --safe-mode --setting-sources local --permission-mode default --strict-mcp-config --max-budget-usd 0.50 ${requestedModel ? `--model '${requestedModel}' ` : ""}"$@"\n`,
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
      const accessState = (await first.json()) as { csrfToken: string; bootId: string };
      const webMutation = async (operation: string, body: Record<string, unknown>) => {
        const response = await fetch(`${origin}/api/web/v1/${operation}`, {
          method: "POST",
          headers: {
            Cookie: cookie,
            Origin: origin,
            "Content-Type": "application/json",
            "X-CSRF-Token": accessState.csrfToken,
            "X-AgentKib-Protocol": "2",
          },
          body: JSON.stringify({ ...body, bootId: accessState.bootId }),
        });
        return {
          requestId: body.requestId,
          status: response.status,
          body: (await response.json()) as Record<string, unknown>,
        };
      };
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
      const outputPath = join(workspace, "approved-fixture.txt");
      const before = (await service.localClaude({ operation: "live", sessionId })) as Live;
      const sendId = randomUUID();
      result.modelSends = 1;
      const accepted = (await service.localClaude({
        operation: "send",
        sessionId,
        requestId: sendId,
        expectedRevision: before.revision,
        text: `This is a synthetic tool interaction acceptance test. In this one turn: (1) Use the Write tool exactly once to create ${outputPath} with exactly this content: ${marker}. Do not use Bash or Edit. (2) After the write completes, call AskUserQuestion exactly once with one single-select question: "Which synthetic namespace should this project use?", header "Namespace", and two choices "cobalt-lake" and "amber-ridge", each with a short description. Wait for the answer via the tool, do not choose yourself. (3) Reply briefly with the marker and the chosen namespace, and do no further tools. Do not inspect unrelated files.`,
        attachmentIds: [],
      })) as { accepted: boolean; error?: string };
      result.sendAccepted = accepted.accepted;
      if (!accepted.accepted) throw new Error(accepted.error ?? "send_not_accepted");
      const handled = new Set<string | number>();
      let live: Live = before;
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        live = (await service.localClaude({ operation: "live", sessionId })) as Live;
        result.status = live.status;
        result.reason = live.reason;
        result.model = live.model;
        result.usage = live.tokenUsage;
        for (const item of live.approvals) {
          if (handled.has(item.requestId)) continue;
          const input = item.input as { file_path?: string; content?: string } | undefined;
          const allowed =
            item.toolName === "Write" &&
            input?.file_path === outputPath &&
            input.content?.trim() === marker;
          handled.add(item.requestId);
          const webBefore = (await web(`live?sessionId=${encodeURIComponent(sessionId)}`)) as Live;
          expect(webBefore.revision).toBe(live.revision);
          const body = {
            sessionId,
            expectedRevision: live.revision,
            turnId: item.turnId,
            approvalId: item.requestId,
            decision: allowed ? "allow" : "deny",
          };
          const decision = (await service.localClaude({
            operation: "approve",
            requestId: randomUUID(),
            ...body,
          })) as { accepted: boolean };
          result.ownerApprovalAccepted = decision.accepted;
          result.approvedTool = item.toolName;
          result.approvedExactSyntheticWrite = allowed;
          const staleRequestId = randomUUID();
          const stale = await webMutation("approve", { ...body, requestId: staleRequestId });
          result.staleWebApproval = stale;
          expect(decision.accepted).toBe(true);
          expect(stale.requestId).toBe(staleRequestId);
          expect(stale.status).toBe(409);
          expect(stale.body.error).toBe("stale_state");
          expect(stale.body.controlOutcome).toBe("not-dispatched");
          if (!allowed) throw new Error("unexpected_tool_requested");
        }
        // Re-read because approving can immediately advance the native revision.
        live = (await service.localClaude({ operation: "live", sessionId })) as Live;
        for (const item of live.questions ?? []) {
          if (handled.has(item.requestId)) continue;
          handled.add(item.requestId);
          result.questionSupported = item.supported;
          if (!item.supported) throw new Error("native_question_schema_unsupported");
          const answers = Object.fromEntries(
            item.questions.map((q) => {
              if (!q.options.some((option) => option.label === "cobalt-lake"))
                throw new Error("unexpected_question_options");
              return [q.id, ["cobalt-lake"]];
            }),
          );
          const body = {
            sessionId,
            expectedRevision: live.revision,
            turnId: item.turnId,
            questionId: item.requestId,
            answers,
          };
          const decision = await webMutation("answer", { ...body, requestId: randomUUID() });
          result.webAnswer = decision;
          const staleRequestId = randomUUID();
          const stale = (await service.localClaude({
            operation: "answer",
            ...body,
            requestId: staleRequestId,
          })) as { requestId: string; accepted: boolean; controlOutcome?: string; error?: string };
          result.staleOwnerAnswer = stale;
          expect(decision.status).toBe(200);
          expect(decision.body.accepted).toBe(true);
          expect(stale.requestId).toBe(staleRequestId);
          expect(stale.accepted).toBe(false);
          expect(stale.controlOutcome).toBe("not-dispatched");
        }
        if (live.status === "idle" || live.status === "outcome-unknown") break;
        await new Promise((done) => setTimeout(done, 100));
      }
      result.status = live.status;
      result.reason = live.reason;
      result.model = live.model;
      result.usage = live.tokenUsage;
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
      result.eventKinds = events.events.map((event) => event.kind);
      result.outputMatches = await readFile(outputPath, "utf8").then(
        (value) => value.trim() === marker,
        () => false,
      );
      result.answerInReply = reply.includes("cobalt-lake");
      result.markerInReply = reply.includes(marker);
      result.webEventCount = (
        await web(`events?sessionId=${encodeURIComponent(sessionId)}`)
      ).events.length;
      if (live.status !== "idle")
        throw new Error(
          live.status === "outcome-unknown" ? "native_outcome_unknown" : "native_timeout",
        );
      const projects = join(config, "projects");
      const nativeFiles = (await readdir(projects, { recursive: true })).filter((path) =>
        path.endsWith(`${created.sourceSessionId}.jsonl`),
      );
      expect(nativeFiles).toHaveLength(1);
      const nativeEntries = (await readFile(join(projects, nativeFiles[0]), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              subtype?: string;
              message?: {
                content?:
                  | string
                  | {
                      type: string;
                      id?: string;
                      name?: string;
                      tool_use_id?: string;
                      is_error?: boolean;
                      content?: unknown;
                    }[];
              };
            },
        );
      const nativeBlocks = nativeEntries.flatMap((entry) =>
        Array.isArray(entry.message?.content) ? entry.message.content : [],
      );
      const tools = nativeBlocks.filter((block) => block.type === "tool_use");
      const toolResults = nativeBlocks.filter((block) => block.type === "tool_result");
      result.nativeTools = tools.map((tool) => tool.name);
      result.nativeSuccessfulToolResults = toolResults.filter((entry) => !entry.is_error).length;
      result.nativeApiErrors = nativeEntries.filter(
        (entry) => entry.subtype === "api_error",
      ).length;
      expect(tools.map((tool) => tool.name)).toEqual(["Write", "AskUserQuestion"]);
      for (const tool of tools) {
        expect(toolResults.some((entry) => entry.tool_use_id === tool.id && !entry.is_error)).toBe(
          true,
        );
      }
      expect(result.ownerApprovalAccepted).toBe(true);
      expect(result.outputMatches).toBe(true);
      expect(result.questionSupported).toBe(true);
      expect(result.answerInReply).toBe(true);
      expect(result.markerInReply).toBe(true);
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
      expect(result.settingsUnchanged).toBe(true);
      if (!result.failure) expect(result.launchCount).toBe(1);
    }
  },
  150000,
);
