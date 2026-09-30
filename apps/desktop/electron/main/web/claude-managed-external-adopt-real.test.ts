// @vitest-environment node
// Opt-in: one official CLI source turn plus one adopted Web turn; never rerun attempts.
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

type NativeEntry = {
  type?: string;
  subtype?: string;
  message?: { content?: string | { type: string; id?: string; name?: string; text?: string }[] };
};
const parseEntries = (bytes: Buffer): NativeEntry[] =>
  bytes
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as NativeEntry);
const toolsIn = (entries: NativeEntry[]) =>
  entries
    .flatMap((entry) => (Array.isArray(entry.message?.content) ? entry.message.content : []))
    .filter((block) => block.type === "tool_use")
    .map((block) => ({ id: block.id, name: block.name }));

const enabled = process.env.AGENTKIB_CLAUDE_EXTERNAL_ADOPT_DIR;
const continueUndispatched = process.env.AGENTKIB_CLAUDE_EXTERNAL_ADOPT_CONTINUE === "1";
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
it.skipIf(!enabled)(
  "official external Claude session is discovered and first adopted by native UUID",
  async () => {
    const requestedRoot = resolve(enabled!);
    if (
      !requestedRoot.startsWith("/tmp/agentkib-claude-external-adopt") &&
      !requestedRoot.startsWith("/private/tmp/agentkib-claude-external-adopt")
    )
      throw new Error("isolated_native_directory_required");
    const root = await mkdir(requestedRoot, { recursive: true, mode: 0o700 }).then(() =>
      realpath(requestedRoot),
    );
    if (
      !root.startsWith("/tmp/agentkib-claude-external-adopt") &&
      !root.startsWith("/private/tmp/agentkib-claude-external-adopt")
    )
      throw new Error("isolated_native_directory_required");
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(
      join(root, continueUndispatched ? "continue-attempt.json" : "attempt.json"),
      JSON.stringify({ started: new Date().toISOString(), maxSourceTurns: 1, maxAdoptedTurns: 1 }),
      { flag: "wx", mode: 0o600 },
    );
    const previous = continueUndispatched
      ? (JSON.parse(await readFile(join(root, "results.json"), "utf8")) as Record<string, unknown>)
      : undefined;
    if (
      previous &&
      (previous.launchCount !== 1 ||
        previous.sourceTurns !== 1 ||
        previous.webSendStatus !== 400 ||
        previous.settingsUnchanged !== true)
    )
      throw new Error("continuation_requires_confirmed_pre_dispatch_failure");
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
      sourceTurns: 0,
      adoptedTurns: 0,
      requestedModel: requestedModel ?? null,
      continuationOfUndispatchedPreparation: continueUndispatched,
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
      `#!/bin/sh\nif [ "$1" = "--version" ]; then exec '${executable}' "$@"; fi\nprintf 'launch\\n' >> '${launches}'\nexec '${executable}' --settings '${settings}' --safe-mode --setting-sources '' --permission-mode default --strict-mcp-config --max-budget-usd 0.50 ${requestedModel ? `--model '${requestedModel}' ` : ""}"$@"\n`,
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
      const nativeId = previous ? String(previous.nativeId) : randomUUID();
      const marker = previous
        ? String(previous.sourceReply).match(
            /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
          )![0]
        : randomUUID();
      const decision = previous
        ? String(previous.sourceReply).match(/namespace-[0-9a-f-]{36}/)![0]
        : `namespace-${randomUUID()}`;
      const fixture = join(workspace, "original-context.txt");
      if (!previous) {
        await writeFile(
          fixture,
          `Private synthetic marker: ${marker}\nProject decision: ${decision}\n`,
          { mode: 0o600 },
        );
        result.nativeId = nativeId;
        result.sourceTurns = 1;
        const sourceOutput = await new Promise<string>((done, reject) => {
          const source = spawn(
            join(bin, "claude"),
            [
              "--session-id",
              nativeId,
              "--print",
              "--output-format",
              "json",
              "--tools=Read",
              "--",
              `Read ${fixture} exactly once using Read. This is synthetic project context for future continuation. Reply with the exact private marker and project decision from that file. Do not use any other tools.`,
            ],
            { cwd: workspace, env, stdio: ["ignore", "pipe", "ignore"] },
          );
          let output = "";
          source.stdout!.on("data", (chunk) => {
            output += String(chunk);
          });
          const timer = setTimeout(() => source.kill("SIGKILL"), 120000);
          source.once("error", reject);
          source.once("exit", (code, signal) => {
            clearTimeout(timer);
            result.sourceExit = { code, signal };
            if (code !== 0) reject(new Error("source_cli_failed"));
            else done(output);
          });
        });
        const sourceResult = JSON.parse(sourceOutput) as {
          session_id: string;
          result?: string;
          is_error?: boolean;
          usage?: unknown;
          modelUsage?: unknown;
        };
        result.sourceSessionId = sourceResult.session_id;
        result.sourceUsage = sourceResult.usage;
        result.sourceModelUsage = sourceResult.modelUsage;
        result.sourceReply = sourceResult.result;
        expect(sourceResult.is_error).toBe(false);
        expect(sourceResult.session_id).toBe(nativeId);
        expect(sourceResult.result).toContain(marker);
        expect(sourceResult.result).toContain(decision);
      } else {
        result.nativeId = nativeId;
        result.sourceTurns = 0;
        result.originalEvidence = join(root, "results.json");
      }
      const projects = join(config, "projects");
      const sessionFilesBefore = (await readdir(projects, { recursive: true }))
        .filter((path) => path.endsWith(".jsonl"))
        .sort();
      expect(sessionFilesBefore).toHaveLength(1);
      expect(sessionFilesBefore[0]).toContain(nativeId);
      const transcript = join(projects, sessionFilesBefore[0]);
      const prefix = await readFile(transcript);
      result.sourcePrefixSha256 = sha(prefix);
      result.sourcePrefixBytes = prefix.length;
      if (previous) expect(sha(prefix)).toBe(previous.sourcePrefixSha256);
      const sourceEntries = parseEntries(prefix);
      const sourceTools = toolsIn(sourceEntries);
      expect(sourceTools.map((tool) => tool.name)).toEqual(["Read"]);
      result.sourceTools = sourceTools.map((tool) => tool.name);
      // Official process exit above is the handoff boundary; no AgentKib create was called.
      start();
      await rpc("agentkib.handshake", {
        protocolVersion: PROTOCOL_VERSION,
        client: { name: "agentkib-native-external-adopt", version: "0.12.0" },
      });
      const ws = await rpc<{ id: string }>("workspace.add", { path: workspace });
      await rpc("workspace.refreshSessions", { workspaceId: ws.id, force: true });
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
      const catalog = (await service.localClaude({ operation: "catalog" })) as {
        sessions: { id: string; agent: string; workspace_id: string }[];
      };
      const discovered = catalog.sessions.filter(
        (item) => item.workspace_id === ws.id && item.agent === "claude-code",
      );
      expect(discovered).toHaveLength(1);
      const sessionId = discovered[0].id;
      result.sessionId = sessionId;
      const metadataPath = join(
        env.AGENTKIB_BENCHMARK_DATA_DIR,
        "claude-managed",
        `${sessionId}.json`,
      );
      result.noManagedMetadataBeforeAdopt = await access(metadataPath).then(
        () => false,
        () => true,
      );
      expect(result.noManagedMetadataBeforeAdopt).toBe(!previous);
      const existing = (await service.localClaude({
        operation: "events",
        sessionId,
      })) as ConversationEventPage;
      expect(existing.events.some((event) => event.content?.includes(marker))).toBe(true);
      result.discoveredOriginalHistory = true;
      if (!previous) {
        const inspected = (await service.localClaude({ operation: "inspect", sessionId })) as {
          handoffFingerprint?: string;
          sourceSessionId?: string;
        };
        expect(inspected.handoffFingerprint).toBeTruthy();
        const adopted = (await service.localClaude({
          operation: "adopt",
          sessionId,
          requestId: randomUUID(),
          handoffConfirmed: true,
          handoffFingerprint: inspected.handoffFingerprint,
        })) as { accepted: boolean; sourceSessionId: string; sessionId: string };
        result.adoptAccepted = adopted.accepted;
        expect(adopted.accepted).toBe(true);
        expect(adopted.sourceSessionId).toBe(nativeId);
        expect(adopted.sessionId).toBe(sessionId);
        result.sameNativeUuid = true;
      } else {
        const adoptedMetadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
          nativeId: string;
        };
        expect(adoptedMetadata.nativeId).toBe(nativeId);
        result.sameNativeUuid = true;
      }
      const before = (await web(`live?sessionId=${encodeURIComponent(sessionId)}`)) as Live;
      const prompt =
        "Continue from the conversation history. Recall the exact private synthetic marker and the exact project decision previously read and acknowledged in this session. Return only those two values. Do not call tools, read files, or guess. If unavailable, say unavailable.";
      expect(prompt).not.toContain(marker);
      expect(prompt).not.toContain(decision);
      result.adoptedTurns = 1;
      const requestId = randomUUID();
      result.adoptedRequestId = requestId;
      const sent = await webMutation("send", {
        sessionId,
        requestId,
        expectedRevision: before.revision,
        text: prompt,
      });
      result.webSendStatus = sent.status;
      result.webSendResponse = sent.body;
      result.webSendAccepted = sent.body.accepted;
      expect(sent.status).toBe(200);
      expect(sent.body.accepted).toBe(true);
      let live = before;
      const deadline = Date.now() + 120000;
      do {
        live = (await service.localClaude({ operation: "live", sessionId })) as Live;
        if (live.approvals.length || live.questions?.length)
          throw new Error("unexpected_tool_during_recall");
        if (live.status === "idle" || live.status === "outcome-unknown") break;
        await new Promise((done) => setTimeout(done, 100));
      } while (Date.now() < deadline);
      result.status = live.status;
      result.model = live.model;
      result.adoptedUsage = live.tokenUsage;
      result.reason = live.reason;
      const events = (await web(
        `events?sessionId=${encodeURIComponent(sessionId)}`,
      )) as ConversationEventPage;
      const messages = events.events.filter((event) => event.kind === "agent-message");
      result.webHistoryLatestReply = messages.at(-1)?.content;
      if (live.status !== "idle")
        throw new Error(
          live.status === "outcome-unknown" ? "native_outcome_unknown" : "native_timeout",
        );
      await stop();
      const after = await readFile(transcript);
      // Only appended assistant output proves recall; old history already contains the answer.
      const addedAssistants = parseEntries(after.subarray(prefix.length)).filter(
        (entry) => entry.type === "assistant",
      );
      const newAssistantTexts = addedAssistants
        .flatMap((entry) =>
          typeof entry.message?.content === "string"
            ? [entry.message.content]
            : (entry.message?.content
                ?.filter((block) => block.type === "text")
                .map((block) => block.text ?? "") ?? []),
        )
        .filter(Boolean);
      expect(newAssistantTexts.length).toBeGreaterThan(0);
      const reply = newAssistantTexts.join("\n");
      result.newNativeAssistantCount = newAssistantTexts.length;
      result.reply = reply;
      result.recalledMarker = reply.includes(marker);
      result.recalledDecision = reply.includes(decision);
      result.originalPrefixUnchanged = after.subarray(0, prefix.length).equals(prefix);
      result.noExtraSession =
        JSON.stringify(
          (await readdir(projects, { recursive: true }))
            .filter((path) => path.endsWith(".jsonl"))
            .sort(),
        ) === JSON.stringify(sessionFilesBefore);
      const finalEntries = parseEntries(after);
      const finalTools = toolsIn(finalEntries);
      result.noHistoricalToolReplay = JSON.stringify(finalTools) === JSON.stringify(sourceTools);
      result.totalNativeUserInputs = finalEntries.filter(
        (entry) =>
          entry.type === "user" &&
          (typeof entry.message?.content === "string" ||
            (Array.isArray(entry.message?.content) &&
              entry.message.content.some((block) => block.type === "text"))),
      ).length;
      result.nativeApiErrors = finalEntries.filter((entry) => entry.subtype === "api_error").length;
      expect(result.recalledMarker).toBe(true);
      expect(result.recalledDecision).toBe(true);
      expect(result.originalPrefixUnchanged).toBe(true);
      expect(result.noExtraSession).toBe(true);
      expect(result.noHistoricalToolReplay).toBe(true);
      expect(result.totalNativeUserInputs).toBe(2);
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
      await writeFile(
        join(root, continueUndispatched ? "continuation-results.json" : "results.json"),
        JSON.stringify(result, null, 2),
        { mode: 0o600 },
      );
      expect(result.settingsUnchanged).toBe(true);
      if (!result.failure) expect(result.launchCount).toBe(2);
    }
  },
  270000,
);
