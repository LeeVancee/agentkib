/** Offline native Codex 0.155.1 multi-client protocol probe. No personal configuration or auth. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createNativeProbeDiagnostics } from "./native-probe-diagnostics.mjs";
import WebSocket, { WebSocketServer } from "ws";

export const PINNED_CODEX = {
  version: "codex-cli 0.155.1",
  sha256: "8eaf1ad12fe6bf89b1710330f58900014322c7c5af677e43be116d8ac5fc0a9e",
};
export const SYNTHETIC_MODEL = "gpt-5.6-terra";
const FRAME_LIMIT = 4 * 1024 * 1024;
const TIMEOUT = 15_000;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Compatibility export for the existing Codex probe regression suite. */
export const createProbeDiagnostics = (context) =>
  createNativeProbeDiagnostics({ ...context, binaryPlaceholder: "$CODEX_BINARY" });

/** Deliberately owns only a transport: close never stops an external app-server. */
export class SharedRpcClient extends EventEmitter {
  constructor(send, close, log = () => {}) {
    super();
    this.sendFrame = send;
    this.closeTransport = close;
    this.log = log;
    this.frames = [];
    this.pending = new Map();
    this.sequence = 0;
    this.closed = false;
    this.transportClosed = false;
  }

  receive(raw) {
    if (this.closed) return;
    try {
      if (Buffer.byteLength(raw) > FRAME_LIMIT) throw new Error("frame-limit");
      const frame = JSON.parse(raw.toString());
      if (!frame || typeof frame !== "object" || Array.isArray(frame))
        throw new Error("invalid-frame");
      this.log("in", frame);
      this.frames.push(frame);
      if (this.frames.length > 20_000) throw new Error("event-limit");
      if ("id" in frame && typeof frame.method !== "string") {
        const pending = this.pending.get(frame.id);
        if (pending) {
          this.pending.delete(frame.id);
          clearTimeout(pending.timer);
          if (frame.error) pending.reject(new Error(JSON.stringify(frame.error)));
          else if (!("result" in frame)) pending.reject(new Error("invalid-response"));
          else pending.resolve(frame.result);
        }
      }
      this.emit("frame", frame);
    } catch (error) {
      this.fail(error);
    }
  }

  write(frame) {
    if (this.closed) throw new Error("connection-closed");
    const raw = JSON.stringify(frame);
    if (Buffer.byteLength(raw) > FRAME_LIMIT) throw new Error("frame-limit");
    this.log("out", frame);
    this.sendFrame(raw);
  }

  request(method, params = {}, timeout = TIMEOUT) {
    if (this.closed) return Promise.reject(new Error("connection-closed"));
    if (this.pending.size >= 128) return Promise.reject(new Error("request-limit"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("request-timeout: " + method));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async initialize(name) {
    const result = await this.request("initialize", {
      clientInfo: { name, title: "AgentKib isolated shared-server probe", version: "0.18.0" },
      capabilities: { experimentalApi: true },
    });
    this.write({ method: "initialized", params: {} });
    return result;
  }

  waitFor(predicate, after = 0, timeout = TIMEOUT) {
    const found = this.frames.slice(after).find(predicate);
    if (found) return Promise.resolve(found);
    if (this.closed) return Promise.reject(new Error("connection-closed"));
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.off("frame", check);
        this.off("closed", ended);
      };
      const check = (frame) => {
        if (predicate(frame)) {
          cleanup();
          resolve(frame);
        }
      };
      const ended = (error) => {
        cleanup();
        reject(error);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("event-timeout"));
      }, timeout);
      this.on("frame", check);
      this.on("closed", ended);
    });
  }

  fail(error = new Error("connection-closed")) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit("closed", error);
  }

  close() {
    if (this.transportClosed) return;
    this.transportClosed = true;
    this.fail();
    this.closeTransport();
  }
}

export async function connectUnix(endpoint, log) {
  // The pinned server rejects an unsupported extension offer rather than ignoring it.
  const socket = new WebSocket("ws+unix://" + endpoint + ":/", {
    perMessageDeflate: false,
    maxPayload: FRAME_LIMIT,
    handshakeTimeout: TIMEOUT,
  });
  const client = new SharedRpcClient(
    (frame) => socket.send(frame),
    () => socket.terminate(),
    log,
  );
  socket.on("message", (raw) => client.receive(raw));
  socket.on("error", (error) => client.fail(error));
  socket.on("close", () => client.fail());
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return client;
}

/** Fault boundary: forward one turn/start, suppress its native ACK, then disconnect. */
export async function createAckLossProxy(endpoint, upstreamEndpoint, log = () => {}) {
  const server = createServer();
  const websocket = new WebSocketServer({ server, perMessageDeflate: false });
  const connections = new Set();
  let armed = false;
  let dropped;
  websocket.on("connection", (downstream) => {
    connections.add(downstream);
    const upstream = new WebSocket("ws+unix://" + upstreamEndpoint + ":/", {
      perMessageDeflate: false,
      maxPayload: FRAME_LIMIT,
    });
    connections.add(upstream);
    const queued = [];
    let lostId;
    downstream.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      log("client-to-server", frame);
      if (armed && frame.method === "turn/start") {
        armed = false;
        lostId = frame.id;
      }
      if (upstream.readyState === WebSocket.OPEN) upstream.send(raw.toString());
      else queued.push(raw.toString());
    });
    upstream.on("open", () => {
      for (const raw of queued) upstream.send(raw);
      queued.length = 0;
    });
    upstream.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      if (lostId !== undefined && frame.id === lostId && !frame.method) {
        dropped = { requestId: lostId, frame };
        log("suppressed-ack", frame);
        // The caller has received neither the ACK nor a delta. This close is
        // induced by the transport boundary, after the real server accepted it.
        downstream.terminate();
        upstream.terminate();
        return;
      }
      // No event from this turn can reach the caller before the lost ACK.
      if (lostId !== undefined) {
        log("suppressed-before-ack", frame);
        return;
      }
      if (downstream.readyState === WebSocket.OPEN) downstream.send(raw.toString());
    });
    const closePair = () => {
      connections.delete(downstream);
      connections.delete(upstream);
      downstream.terminate();
      upstream.terminate();
    };
    downstream.on("error", closePair);
    upstream.on("error", closePair);
    downstream.on("close", closePair);
    upstream.on("close", closePair);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
  return {
    arm: () => {
      armed = true;
    },
    dropped: () => dropped,
    close: async () => {
      for (const socket of connections) socket.terminate();
      await new Promise((resolve) => websocket.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export function responseEvents(text, id = randomUUID()) {
  const item = {
    id: "msg_" + id,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const response = {
    id: "resp_" + id,
    object: "response",
    status: "completed",
    model: SYNTHETIC_MODEL,
    output: [item],
    usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
  };
  return [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_text.done",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      text,
    },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ];
}

function functionEvents(name, args) {
  const item = {
    id: "fc_" + randomUUID(),
    type: "function_call",
    call_id: "call_" + randomUUID(),
    name,
    arguments: JSON.stringify(args),
    status: "completed",
  };
  return [
    {
      type: "response.created",
      response: { id: "resp_" + randomUUID(), status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, arguments: "", status: "in_progress" },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: item.id,
      output_index: 0,
      delta: item.arguments,
    },
    {
      type: "response.function_call_arguments.done",
      item_id: item.id,
      output_index: 0,
      arguments: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_" + randomUUID(),
        status: "completed",
        output: [item],
        usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
      },
    },
  ];
}

/** Accepts only a queued synthetic case. It has no upstream forwarding implementation. */
export async function createResponsesFixture(log = () => {}) {
  const cases = [];
  const requests = [];
  const sockets = new Set();
  const activeResponses = new Set();
  const server = createServer(async (request, response) => {
    let bytes = 0;
    const chunks = [];
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > FRAME_LIMIT) {
        response.writeHead(413).end();
        return;
      }
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks);
    let body;
    try {
      body = JSON.parse(raw.toString() || "{}");
    } catch {
      response.writeHead(400).end("Invalid synthetic payload");
      return;
    }
    const entry = { method: request.method, path: request.url, sha256: sha256(raw), body };
    requests.push(entry);
    log(entry);
    if (request.method !== "POST" || request.url !== "/responses" || !cases.length) {
      response.writeHead(403).end("No synthetic case admitted");
      return;
    }
    if (!body || body.stream !== true || body.model !== SYNTHETIC_MODEL) {
      response.writeHead(400).end("Unexpected synthetic model or stream mode");
      return;
    }
    const lastUser = Array.isArray(body.input)
      ? body.input.filter((item) => item.role === "user").at(-1)
      : null;
    const lastText =
      typeof lastUser?.content === "string"
        ? lastUser.content
        : (lastUser?.content ?? [])
            .filter((item) => item.type === "input_text")
            .map((item) => item.text)
            .join("");
    if (cases[0].expectedPrompt && cases[0].expectedPrompt !== lastText) {
      response.writeHead(403).end("Unplanned synthetic prompt");
      return;
    }
    const next = cases.shift();
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    response.flushHeaders();
    const events = next.events ?? responseEvents(next.text ?? "synthetic shared response");
    const send = (event) =>
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    if (next.hold) {
      for (const event of events.slice(0, 3)) send(event);
      activeResponses.add(response);
      next.release = () => {
        if (response.destroyed) return;
        for (const event of events.slice(3)) send(event);
        response.end();
      };
      response.once("close", () => activeResponses.delete(response));
      next.received?.(entry);
    } else {
      for (const event of events) send(event);
      response.end();
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    enqueue: (value) => {
      cases.push(value);
      return value;
    },
    close: async () => {
      for (const response of activeResponses) response.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function execute(binary, args, env, cwd, timeout = TIMEOUT) {
  const child = spawn(binary, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
  const buffers = [[], []];
  child.stdout.on("data", (chunk) => buffers[0].push(chunk));
  child.stderr.on("data", (chunk) => buffers[1].push(chunk));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("command-timeout"));
    }, timeout);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code) reject(new Error(Buffer.concat(buffers[1]).toString()));
      else resolve(Buffer.concat(buffers[0]).toString());
    });
  });
}

function isolatedEnv(root) {
  return {
    HOME: path.join(root, "home"),
    CODEX_HOME: path.join(root, "codex"),
    PATH: "/usr/bin:/bin",
    TERM: "xterm-256color",
    LANG: "en_US.UTF-8",
    RUST_LOG: "info",
    AGENTKIB_SYNTHETIC_KEY: "local-fixture-not-a-credential",
  };
}

function configFor(url) {
  return {
    model: SYNTHETIC_MODEL,
    model_provider: "agentkib-probe",
    check_for_update_on_startup: false,
    cli_auth_credentials_store: "file",
    "model_providers.agentkib-probe.name": "AgentKib offline synthetic fixture",
    "model_providers.agentkib-probe.base_url": url,
    "model_providers.agentkib-probe.env_key": "AGENTKIB_SYNTHETIC_KEY",
    "model_providers.agentkib-probe.wire_api": "responses",
    "model_providers.agentkib-probe.requires_openai_auth": false,
    "model_providers.agentkib-probe.supports_websockets": false,
    "model_providers.agentkib-probe.request_max_retries": 0,
    "model_providers.agentkib-probe.stream_max_retries": 0,
    "features.shell_snapshot": false,
    "features.code_mode": false,
    "features.apps": false,
    "features.skills": false,
    "features.goals": false,
    "agents.enabled": false,
    web_search: "disabled",
    approval_policy: "on-request",
    approvals_reviewer: "user",
    sandbox_mode: "read-only",
  };
}

function configArgs(config) {
  return Object.entries(config).flatMap(([key, value]) => [
    "-c",
    key + "=" + JSON.stringify(value),
  ]);
}
function notification(method, threadId, turnId) {
  return (frame) =>
    frame.method === method &&
    frame.params?.threadId === threadId &&
    (!turnId || (frame.params.turnId ?? frame.params.turn?.id) === turnId);
}

async function stopOwned(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("close", resolve));
  child.kill("SIGTERM");
  let timer;
  await Promise.race([
    exited,
    new Promise((resolve) => {
      timer = setTimeout(resolve, 3000);
    }),
  ]);
  clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

async function connectWhenReady(endpoint, child, log) {
  const deadline = Date.now() + TIMEOUT;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("server-exited-before-listen");
    try {
      return await connectUnix(endpoint, log);
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("listener-timeout: " + lastError?.message);
}

async function recoveryChecks({
  a,
  b,
  clients,
  fixture,
  endpoint,
  root,
  workspace,
  log,
  check,
  report,
}) {
  const started = await a.request("thread/start", {
    cwd: workspace,
    historyMode: "legacy",
    approvalPolicy: "on-request",
    sandbox: "read-only",
  });
  const threadId = started.thread.id;
  report.threadId = threadId;
  fixture.enqueue({ text: "recovery-only seed history" });
  const seed = await a.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "Persist the isolated recovery fixture." }],
  });
  await a.waitFor(notification("turn/completed", threadId, seed.turn.id));
  await b.request("thread/resume", { threadId });
  await check("lost-turn-start-ack-readback-no-replay", async () => {
    const proxyPath = path.join(root, "lost-ack.sock");
    const proxy = await createAckLossProxy(proxyPath, endpoint, log("ack-loss-proxy"));
    const origin = await connectUnix(proxyPath, log("ack-loss-origin"));
    clients.push(origin);
    try {
      await origin.initialize("agentkib_shared_probe_ack_loss");
      await origin.request("thread/resume", { threadId });
      const before = await b.request("thread/read", { threadId, includeTurns: true });
      const fromOrigin = origin.frames.length,
        fromObserver = b.frames.length;
      const count = fixture.requests.length;
      const prompt = "lost-ack-prompt-" + randomUUID();
      const text = "lost-ack-result-" + randomUUID();
      const held = fixture.enqueue({ text, expectedPrompt: prompt, hold: true });
      proxy.arm();
      await assert.rejects(
        origin.request("turn/start", { threadId, input: [{ type: "text", text: prompt }] }),
        /connection-closed/,
      );
      const loss = proxy.dropped();
      assert(loss?.frame.result?.turn?.id, "native success ACK was not intercepted");
      const turnId = loss.frame.result.turn.id;
      assert(
        !origin.frames
          .slice(fromOrigin)
          .some(
            (frame) => frame.id === loss.requestId || frame.method === "item/agentMessage/delta",
          ),
        "origin received an ACK or delta before disconnect",
      );
      await b.waitFor(notification("turn/started", threadId, turnId), fromObserver);
      await b.waitFor(notification("item/agentMessage/delta", threadId, turnId), fromObserver);
      const active = await b.request("thread/read", { threadId, includeTurns: true });
      assert.equal(active.thread.turns.filter((turn) => turn.id === turnId).length, 1);
      assert.equal(active.thread.turns.find((turn) => turn.id === turnId).status, "inProgress");
      assert.equal(active.thread.turns.length, before.thread.turns.length + 1);
      assert.equal(fixture.requests.length - count, 1);
      held.release();
      const complete = await b.waitFor(
        notification("turn/completed", threadId, turnId),
        fromObserver,
      );
      assert.equal(complete.params.turn.status, "completed");
      const fresh = await connectUnix(endpoint, log("ack-loss-fresh"));
      clients.push(fresh);
      await fresh.initialize("agentkib_shared_probe_ack_loss_fresh");
      await fresh.request("thread/resume", { threadId });
      const after = await fresh.request("thread/read", { threadId, includeTurns: true });
      assert.equal(after.thread.turns.length, before.thread.turns.length + 1);
      const restored = after.thread.turns.find((turn) => turn.id === turnId);
      assert.equal(restored?.status, "completed");
      assert(
        restored.items.some((item) => item.type === "agentMessage" && item.text === text),
        "full native answer not recovered",
      );
      assert.equal(fixture.requests.length - count, 1, "readback or resume repeated inference");
      return {
        threadId,
        turnId,
        requestId: loss.requestId,
        originReceivedAck: false,
        originReceivedDelta: false,
        originalOutcome: "unknown-at-disconnect",
        nativeTurnRecovered: true,
        nativeTurnCountIncrease: 1,
        requestCount: 1,
        replayedTurnStart: false,
      };
    } finally {
      origin.close();
      await proxy.close();
    }
  });
  await check("loaded-thread-resume-running-active-goal", async () => {
    const objective = "Isolated goal attachment check; do not execute tools.";
    const paused = await b.request("thread/goal/set", {
      threadId,
      objective,
      status: "paused",
      tokenBudget: 100,
    });
    assert.equal(paused.goal.status, "paused");
    const count = fixture.requests.length;
    const activationIndex = b.frames.length;
    const held = fixture.enqueue({ text: "held native goal continuation", hold: true });
    try {
      const active = await b.request("thread/goal/set", { threadId, status: "active" });
      assert.equal(active.goal.status, "active");
      const started = await b.waitFor(notification("turn/started", threadId), activationIndex);
      const turnId = started.params.turn.id;
      await b.waitFor(notification("item/agentMessage/delta", threadId, turnId), activationIndex);
      report.goalActivation = {
        requestCount: fixture.requests.length - count,
        goal: (await b.request("thread/goal/get", { threadId })).goal,
        nativeTurnStarts: b.frames
          .slice(activationIndex)
          .filter(notification("turn/started", threadId)),
      };
      assert.equal(
        fixture.requests.length - count,
        1,
        "goal activation did not produce exactly one held turn",
      );
      const attachIndex = b.frames.length;
      const loaded = await b.request("thread/loaded/list", {});
      assert.equal(loaded.data.filter((id) => id === threadId).length, 1);
      const resumed = await b.request("thread/resume", { threadId });
      assert.equal(resumed.thread.id, threadId);
      const fresh = await connectUnix(endpoint, log("goal-fresh"));
      clients.push(fresh);
      await fresh.initialize("agentkib_shared_probe_goal_fresh");
      await fresh.request("thread/resume", { threadId });
      await fresh.request("thread/read", { threadId, includeTurns: true });
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const goal = (await fresh.request("thread/goal/get", { threadId })).goal;
      assert.equal(goal.status, "active");
      assert.equal(goal.objective, objective);
      assert.equal(fixture.requests.length, count + 1, "loaded/resume caused an inference request");
      assert.equal(
        b.frames.slice(attachIndex).filter(notification("turn/started", threadId)).length,
        0,
      );
      const read = await fresh.request("thread/read", { threadId, includeTurns: true });
      assert.equal(
        read.thread.turns.filter((turn) => turn.id === turnId && turn.status === "inProgress")
          .length,
        1,
      );
      // Pause is an explicit isolated lifecycle operation, not proof that an
      // idle active goal can be loaded without continuation.
      await b.request("thread/goal/set", { threadId, status: "paused" });
      held.release();
      await b.waitFor(notification("turn/completed", threadId, turnId), activationIndex);
      report.checks.push({
        name: "idle-active-goal-attach",
        status: "not-run",
        reason:
          "Native thread/goal/set(active) immediately starts a continuation. No public defer flag exists on this binary's ThreadResumeParams; an idle active-goal prerequisite was not established.",
      });
      return {
        threadId,
        turnId,
        goalStatus: goal.status,
        objective,
        observationMs: 3000,
        existingAndFreshConnections: true,
        inferenceRequests: 0,
        activationInferenceRequests: 1,
        goalFeatureEnabled: true,
      };
    } finally {
      await b.request("thread/goal/set", { threadId, status: "paused" });
      await b.request("thread/goal/clear", { threadId });
    }
  });
  await check("loaded-thread-resume-paused-goal", async () => {
    const goal = await b.request("thread/goal/set", {
      threadId,
      objective: "Paused isolated attachment check",
      status: "paused",
      tokenBudget: 100,
    });
    const count = fixture.requests.length;
    const from = b.frames.length;
    try {
      await b.request("thread/loaded/list", {});
      await b.request("thread/resume", { threadId });
      const fresh = await connectUnix(endpoint, log("paused-goal-fresh"));
      clients.push(fresh);
      await fresh.initialize("agentkib_shared_probe_paused_goal_fresh");
      await fresh.request("thread/resume", { threadId });
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const read = await fresh.request("thread/goal/get", { threadId });
      assert.deepEqual(read.goal, goal.goal);
      assert.equal(fixture.requests.length, count);
      assert.equal(b.frames.slice(from).filter(notification("turn/started", threadId)).length, 0);
      return {
        threadId,
        goalStatus: "paused",
        observationMs: 3000,
        inferenceRequests: 0,
        goalFeatureEnabled: true,
      };
    } finally {
      await b.request("thread/goal/clear", { threadId });
    }
  });
}

export async function runProbe(options) {
  const context = {
    binaryPaths: [options.codex],
    repository: fileURLToPath(new URL("../../../", import.meta.url)),
    evidenceDir: options.evidenceDir,
    home: homedir(),
  };
  try {
    return await runNativeProbe(options, context);
  } catch (error) {
    // Setup/cleanup failures can escape the report path. Never hand a caller or
    // Node's uncaught-error printer a stack containing private execution paths.
    throw createProbeDiagnostics(context).error(error);
  }
}

async function runNativeProbe({ codex, evidenceDir, recoveryOnly = false }, context) {
  if (process.platform !== "darwin")
    throw new Error("Native acceptance requires macOS; protocol regression tests are portable");
  const source = await fs.realpath(codex);
  context.binaryPaths.push(source);
  assert.equal(sha256(await fs.readFile(source)), PINNED_CODEX.sha256, "unexpected Codex binary");
  await fs.mkdir(evidenceDir, { mode: 0o700 });
  const root = await fs.mkdtemp("/private/tmp/ak-cx-");
  context.root = root;
  for (const name of ["home", "codex", "workspace"])
    await fs.mkdir(path.join(root, name), { mode: 0o700 });
  const env = isolatedEnv(root);
  const workspace = path.join(root, "workspace");
  const binary = path.join(evidenceDir, "codex-0.155.1");
  await fs.copyFile(source, binary, 1);
  await fs.chmod(binary, 0o700);
  await fs.copyFile(fileURLToPath(import.meta.url), path.join(evidenceDir, "runner.mjs"), 1);
  await fs.copyFile(
    fileURLToPath(new URL("./native-probe-diagnostics.mjs", import.meta.url)),
    path.join(evidenceDir, "native-probe-diagnostics.mjs"),
    1,
  );
  await fs.copyFile(
    fileURLToPath(new URL("./fixtures/codex-shared-server-tui.py", import.meta.url)),
    path.join(evidenceDir, "tui.py"),
    1,
  );
  const report = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    binary: source,
    binarySha256: PINNED_CODEX.sha256,
    root,
    version: PINNED_CODEX.version,
    realModelRequests: 0,
    checks: [],
    errors: [],
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    mode: recoveryOnly ? "recovery-only" : "full",
    diagnosticPathsRedacted: true,
    // These are private execution inputs, not diagnostic files for sharing.
    privateExecutionArtifacts: ["codex-0.155.1", "sandbox.sb"],
  };
  const { repository } = context;
  const diagnostics = createProbeDiagnostics(context);
  report.sourceHead = (
    await execute("/usr/bin/git", ["rev-parse", "HEAD"], env, repository)
  ).trim();
  report.dirtyFiles = (await execute("/usr/bin/git", ["status", "--short"], env, repository))
    .trim()
    .split("\n")
    .filter(Boolean);
  const transcripts = {};
  const log = (name) => (direction, frame) => {
    (transcripts[name] ??= []).push({ direction, frame });
  };
  let fixture, server;
  const serverOutput = [];
  const clients = [];
  const check = async (name, fn) => {
    try {
      const evidence = await fn();
      report.checks.push({ name, status: "passed", ...evidence });
    } catch (error) {
      report.checks.push({ name, status: "blocked", reason: error.message });
    }
    await diagnostics.writeJson(path.join(evidenceDir, "result.json"), report);
  };
  try {
    assert.equal(
      (await execute(binary, ["--version"], env, workspace)).trim(),
      PINNED_CODEX.version,
    );
    for (const [name, args] of Object.entries({
      cli: ["--help"],
      server: ["app-server", "--help"],
      daemon: ["app-server", "daemon", "--help"],
      proxy: ["app-server", "proxy", "--help"],
      resume: ["resume", "--help"],
    }))
      await diagnostics.writeText(
        path.join(evidenceDir, name + "-help.txt"),
        await execute(binary, args, env, workspace),
      );
    for (const experimental of [false, true]) {
      const out = path.join(evidenceDir, experimental ? "schema-experimental" : "schema-stable");
      await execute(
        binary,
        [
          "app-server",
          "generate-json-schema",
          ...(experimental ? ["--experimental"] : []),
          "--out",
          out,
        ],
        env,
        workspace,
      );
    }
    fixture = await createResponsesFixture((entry) => {
      (transcripts.http ??= []).push(entry);
    });
    const endpoint = path.join(root, "server.sock");
    const sandbox =
      '(version 1)(allow default)(deny network*)(allow network-outbound (remote ip "localhost:' +
      new URL(fixture.url).port +
      '"))(allow network* (local unix-socket (subpath ' +
      JSON.stringify(root) +
      ")))(allow network* (remote unix-socket (subpath " +
      JSON.stringify(root) +
      ")))";
    // The sandbox is an exact private execution input. Do not redact paths used by sandbox-exec.
    await fs.writeFile(path.join(evidenceDir, "sandbox.sb"), sandbox, { mode: 0o600 });
    await check("external-egress-denied", async () => {
      const output = await execute(
        "/usr/bin/sandbox-exec",
        [
          "-p",
          sandbox,
          "/usr/bin/python3",
          "-c",
          'import socket,errno; s=socket.socket(); e=s.connect_ex(("192.0.2.1",443)); assert e in (errno.EPERM,errno.EACCES), e; print("denied")',
        ],
        env,
        workspace,
      );
      assert.equal(output.trim(), "denied");
      return { externalConnectionPermitted: false };
    });
    assert.equal(
      report.checks.at(-1).status,
      "passed",
      "External egress must be blocked before native turns",
    );
    const args = [
      "-p",
      sandbox,
      binary,
      ...configArgs({
        ...configFor(fixture.url),
        ...(recoveryOnly ? { "features.goals": true } : {}),
      }),
      "app-server",
      "--listen",
      "unix://" + endpoint,
    ];
    server = spawn("/usr/bin/sandbox-exec", args, {
      cwd: workspace,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.on("data", (chunk) => serverOutput.push(chunk));
    server.stderr.on("data", (chunk) => serverOutput.push(chunk));
    report.serverPid = server.pid;
    await diagnostics.writeJson(path.join(evidenceDir, "command.json"), {
      binary,
      args,
      env,
      workspace,
    });
    const a = await connectWhenReady(endpoint, server, log("a"));
    clients.push(a);
    await a.initialize("agentkib_shared_probe_a");
    const b = await connectUnix(endpoint, log("b"));
    clients.push(b);
    await b.initialize("agentkib_shared_probe_b");
    if (recoveryOnly) {
      await recoveryChecks({
        a,
        b,
        clients,
        fixture,
        endpoint,
        root,
        workspace,
        log,
        check,
        report,
      });
      report.syntheticRequests = fixture.requests.length;
      report.checks.push({
        name: "real-single-turn",
        status: "not-run",
        reason: "Offline recovery-only phase; no provider authorization read",
      });
      return report;
    }
    const started = await a.request("thread/start", {
      cwd: workspace,
      historyMode: "legacy",
      approvalPolicy: "on-request",
      sandbox: "read-only",
    });
    const threadId = started.thread.id;
    report.threadId = threadId;
    await check("empty-thread-attach", async () => {
      const resumed = await b.request("thread/resume", { threadId });
      assert.equal(resumed.thread.id, threadId);
    });
    fixture.enqueue({ text: "shared-seed-history" });
    const seedIndex = a.frames.length;
    const seed = await a.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "Create synthetic initial history; no tools." }],
    });
    const seedCompleted = await a.waitFor(
      notification("turn/completed", threadId, seed.turn.id),
      seedIndex,
    );
    assert.equal(seedCompleted.params.turn.status, "completed");
    await check("same-live-thread", async () => {
      const resumed = await b.request("thread/resume", { threadId });
      for (const key of [
        "model",
        "modelProvider",
        "cwd",
        "approvalPolicy",
        "approvalsReviewer",
        "sandbox",
      ])
        assert.deepEqual(resumed[key], started[key], key + " changed on attach");
      const loaded = await b.request("thread/loaded/list", {});
      assert.equal(loaded.data.filter((id) => id === threadId).length, 1);
      assert.equal(resumed.thread.id, threadId);
      const endpointStat = await fs.stat(endpoint);
      return {
        threadId,
        endpoint,
        socketOwner: endpointStat.uid,
        mode: endpointStat.mode & 0o777,
        loaded: loaded.data,
      };
    });
    await check("cross-client-stream", async () => {
      const text = "synthetic-shared-" + randomUUID();
      fixture.enqueue({ text });
      const indexA = a.frames.length,
        indexB = b.frames.length,
        count = fixture.requests.length;
      const turn = await a.request("turn/start", {
        threadId,
        input: [{ type: "text", text: "Synthetic local transport test; do not use tools." }],
      });
      await Promise.all([
        a.waitFor(notification("turn/completed", threadId, turn.turn.id), indexA),
        b.waitFor(notification("turn/completed", threadId, turn.turn.id), indexB),
      ]);
      for (const [client, index] of [
        [a, indexA],
        [b, indexB],
      ])
        assert.equal(
          client.frames
            .slice(index)
            .filter(notification("item/agentMessage/delta", threadId, turn.turn.id))
            .map((frame) => frame.params.delta)
            .join(""),
          text,
        );
      assert.equal(fixture.requests.length - count, 1);
      return { turnId: turn.turn.id, requestCount: 1, text };
    });
    await check("cross-client-interrupt", async () => {
      fixture.enqueue({ text: "holding local stream", hold: true });
      const indexA = a.frames.length,
        indexB = b.frames.length,
        count = fixture.requests.length;
      const turn = await a.request("turn/start", {
        threadId,
        input: [{ type: "text", text: "Hold synthetic stream." }],
      });
      await b.waitFor(notification("item/agentMessage/delta", threadId, turn.turn.id), indexB);
      await b.request("turn/interrupt", { threadId, turnId: turn.turn.id });
      const results = await Promise.all([
        a.waitFor(notification("turn/completed", threadId, turn.turn.id), indexA),
        b.waitFor(notification("turn/completed", threadId, turn.turn.id), indexB),
      ]);
      assert(results.every((frame) => frame.params.turn.status === "interrupted"));
      assert.equal(fixture.requests.length - count, 1);
      return { turnId: turn.turn.id, requestCount: 1, turnStatus: "interrupted" };
    });
    await check("disconnect-keeps-native-executor", async () => {
      const held = fixture.enqueue({ text: "response survives subscriber disconnect", hold: true });
      const indexB = b.frames.length,
        count = fixture.requests.length;
      const turn = await a.request("turn/start", {
        threadId,
        input: [
          { type: "text", text: "Disconnect originating subscriber during synthetic stream." },
        ],
      });
      await b.waitFor(notification("item/agentMessage/delta", threadId, turn.turn.id), indexB);
      a.close();
      assert.equal(server.exitCode, null);
      held.release();
      const completed = await b.waitFor(
        notification("turn/completed", threadId, turn.turn.id),
        indexB,
      );
      assert.equal(completed.params.turn.status, "completed");
      const c = await connectUnix(endpoint, log("reconnected"));
      clients.push(c);
      await c.initialize("agentkib_shared_probe_reconnected");
      const resumed = await c.request("thread/resume", { threadId });
      assert.equal(resumed.thread.id, threadId);
      assert.equal(fixture.requests.length - count, 1);
      return {
        turnId: turn.turn.id,
        requestCount: 1,
        reconnectedSameId: true,
        serverSurvived: true,
      };
    });
    for (const kind of ["approval", "question"])
      await check("cross-client-" + kind, async () => {
        const observer = clients.find((client) => client !== b && !client.closed);
        assert(observer, "second live subscriber missing");
        const method =
          kind === "approval"
            ? "item/commandExecution/requestApproval"
            : "item/tool/requestUserInput";
        fixture.enqueue({
          events:
            kind === "approval"
              ? functionEvents("exec_command", {
                  cmd: "printf 'agentkib-isolated-approval'",
                  sandbox_permissions: "require_escalated",
                  justification: "Synthetic native protocol check; decline this command.",
                })
              : functionEvents("request_user_input", {
                  questions: [
                    {
                      id: "shared_choice",
                      header: "Synthetic",
                      question: "Choose synthetic answer",
                      options: [
                        { label: "Alpha", description: "First synthetic option" },
                        { label: "Beta", description: "Second synthetic option" },
                      ],
                    },
                  ],
                }),
        });
        fixture.enqueue({ text: "synthetic tool decision completed" });
        const startB = b.frames.length,
          startObserver = observer.frames.length,
          count = fixture.requests.length;
        const turn = await b.request("turn/start", {
          threadId,
          input: [{ type: "text", text: "Synthetic " + kind + " routing check." }],
          ...(kind === "question"
            ? {
                collaborationMode: {
                  mode: "plan",
                  settings: {
                    model: SYNTHETIC_MODEL,
                    reasoning_effort: "medium",
                    developer_instructions: null,
                  },
                },
              }
            : {}),
        });
        const pending = await b.waitFor(
          (frame) =>
            frame.method === method &&
            frame.params?.threadId === threadId &&
            frame.params?.turnId === turn.turn.id,
          startB,
        );
        await observer.request("thread/read", { threadId });
        const otherRequest = observer.frames
          .slice(startObserver)
          .find((frame) => frame.method === method && frame.id === pending.id);
        report[kind + "Routing"] = {
          originReceived: true,
          observerReceived: Boolean(otherRequest),
          requestId: pending.id,
          turnId: turn.turn.id,
        };
        const responder = otherRequest ? observer : b;
        responder.write({
          id: pending.id,
          result:
            kind === "approval"
              ? { decision: "decline" }
              : { answers: { shared_choice: { answers: ["Alpha"] } } },
        });
        const completed = await b.waitFor(
          notification("turn/completed", threadId, turn.turn.id),
          startB,
        );
        assert.equal(completed.params.turn.status, "completed");
        assert.equal(fixture.requests.length - count, 2);
        if (kind === "approval")
          assert(
            b.frames
              .slice(startB)
              .some(
                (frame) =>
                  frame.method === "item/completed" &&
                  frame.params?.item?.type === "commandExecution" &&
                  frame.params.item.status === "declined",
              ),
            "command not confirmed declined",
          );
        const resolution = (frame) =>
          frame.method === "serverRequest/resolved" && frame.params?.requestId === pending.id;
        await b.waitFor(resolution, startB);
        await observer.waitFor(resolution, startObserver);
        assert(
          otherRequest,
          "native server did not expose pending " + kind + " to second subscriber",
        );
        responder.write({
          id: pending.id,
          result:
            kind === "approval"
              ? { decision: "decline" }
              : { answers: { shared_choice: { answers: ["Beta"] } } },
        });
        await responder.request("thread/read", { threadId });
        assert.equal(fixture.requests.length - count, 2, "stale answer started an extra request");
        return {
          turnId: turn.turn.id,
          requestCount: 2,
          observerAnswered: true,
          bothResolved: true,
          staleAnswerDispatchedAgain: false,
          ...(kind === "approval" ? { commandExecuted: false } : {}),
        };
      });
    await check("pending-approval-origin-disconnect", async () => {
      const origin = await connectUnix(endpoint, log("approval-origin"));
      clients.push(origin);
      await origin.initialize("agentkib_shared_probe_approval_origin");
      await origin.request("thread/resume", { threadId });
      fixture.enqueue({
        events: functionEvents("exec_command", {
          cmd: "printf 'agentkib-isolated-disconnect'",
          sandbox_permissions: "require_escalated",
          justification: "Synthetic origin disconnect test; decline.",
        }),
      });
      fixture.enqueue({ text: "observer completed pending decision" });
      const index = b.frames.length,
        count = fixture.requests.length;
      const turn = await origin.request("turn/start", {
        threadId,
        input: [{ type: "text", text: "Synthetic pending approval origin disconnect." }],
      });
      const pending = await b.waitFor(
        (frame) =>
          frame.method === "item/commandExecution/requestApproval" &&
          frame.params?.turnId === turn.turn.id,
        index,
      );
      origin.close();
      b.write({ id: pending.id, result: { decision: "decline" } });
      const completed = await b.waitFor(
        notification("turn/completed", threadId, turn.turn.id),
        index,
      );
      assert.equal(completed.params.turn.status, "completed");
      assert.equal(fixture.requests.length - count, 2);
      return {
        turnId: turn.turn.id,
        originDisconnected: true,
        observerCompleted: true,
        requestCount: 2,
      };
    });
    await check("native-proxy", async () => {
      const child = spawn(
        binary,
        ["-c", 'cli_auth_credentials_store="file"', "app-server", "proxy", "--sock", endpoint],
        { env, cwd: workspace, stdio: ["pipe", "pipe", "pipe"] },
      );
      const proxyErrors = [];
      child.stderr.on("data", (raw) => proxyErrors.push(raw));
      let buffer = "";
      const client = new SharedRpcClient(
        (frame) => child.stdin.write(frame + "\n"),
        () => child.stdin.end(),
        log("proxy"),
      );
      clients.push(client);
      child.stdout.on("data", (raw) => {
        buffer += raw.toString();
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          client.receive(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
        }
      });
      child.on("close", () => client.fail());
      child.on("error", (error) => client.fail(error));
      try {
        await client.initialize("agentkib_shared_probe_proxy");
        const result = await client.request("thread/read", { threadId });
        assert.equal(result.thread.id, threadId);
        return { sameThreadId: true };
      } finally {
        client.close();
        await stopOwned(child);
        await diagnostics.writeText(
          path.join(evidenceDir, "proxy.log"),
          Buffer.concat(proxyErrors),
        );
      }
    });
    await check("native-tui", async () => {
      // A pre-existing native title avoids TUI background title generation.
      await b.request("thread/name/set", { threadId, name: "AgentKib offline shared probe" });
      const python = "/usr/bin/python3";
      const helper = fileURLToPath(
        new URL("./fixtures/codex-shared-server-tui.py", import.meta.url),
      );
      const terminal = spawn(
        python,
        [
          "-u",
          helper,
          "/usr/bin/sandbox-exec",
          "-p",
          sandbox,
          binary,
          "-c",
          'cli_auth_credentials_store="file"',
          "resume",
          "--remote",
          "unix://" + endpoint,
          "--no-alt-screen",
          threadId,
        ],
        { cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"] },
      );
      const updates = new EventEmitter();
      let output = "";
      terminal.stdout.on("data", (raw) => {
        output += raw.toString();
        updates.emit("output");
      });
      terminal.stderr.on("data", (raw) => {
        output += raw.toString();
        updates.emit("output");
      });
      const waitText = (text) => {
        if (output.includes(text)) return Promise.resolve();
        return new Promise((resolve, reject) => {
          const cleanup = () => {
            clearTimeout(timer);
            updates.off("output", inspect);
            terminal.off("close", ended);
          };
          const inspect = () => {
            if (output.includes(text)) {
              cleanup();
              resolve();
            }
          };
          const ended = () => {
            cleanup();
            reject(new Error("native-tui-exited-before-history"));
          };
          const timer = setTimeout(() => {
            cleanup();
            reject(new Error("native-tui-output-timeout: " + text));
          }, 35_000);
          updates.on("output", inspect);
          terminal.once("close", ended);
        });
      };
      try {
        await waitText("shared-seed-history");
        const text = "TUI-SHARED-" + randomUUID().slice(0, 8);
        const inboundPrompt = "Show synthetic response in original native terminal.";
        fixture.enqueue({ text, expectedPrompt: inboundPrompt });
        const count = fixture.requests.length;
        const indexB = b.frames.length;
        const turn = await b.request("turn/start", {
          threadId,
          input: [{ type: "text", text: inboundPrompt }],
        });
        await b.waitFor(notification("turn/completed", threadId, turn.turn.id), indexB);
        await waitText(text);
        assert.equal(fixture.requests.length - count, 1);
        const nativeText = "TUI-ORIGIN-" + randomUUID().slice(0, 8);
        const terminalPrompt = "native-terminal-origin-" + randomUUID().slice(0, 8);
        fixture.enqueue({ text: nativeText, expectedPrompt: terminalPrompt });
        const nativeIndex = b.frames.length,
          nativeCount = fixture.requests.length;
        terminal.stdin.write("\x1b[200~" + terminalPrompt + "\x1b[201~");
        await waitText(terminalPrompt);
        terminal.stdin.write("\r");
        await b.waitFor(notification("turn/completed", threadId), nativeIndex);
        await waitText(nativeText);
        assert.equal(fixture.requests.length - nativeCount, 1);
        return {
          nativeTerminalRead: true,
          terminalOriginatedTurn: true,
          sameThreadId: threadId,
          requestCount: 2,
          syntheticModel: SYNTHETIC_MODEL,
        };
      } finally {
        await stopOwned(terminal);
        await diagnostics.writeText(path.join(evidenceDir, "native-tui.log"), output);
      }
    });
    await check("pending-request-reconnect", async () => {
      const origin = await connectUnix(endpoint, log("pending-origin"));
      clients.push(origin);
      await origin.initialize("agentkib_shared_probe_pending_origin");
      const isolated = await origin.request("thread/start", {
        cwd: workspace,
        approvalPolicy: "on-request",
        sandbox: "read-only",
        historyMode: "legacy",
      });
      const pendingThread = isolated.thread.id;
      fixture.enqueue({
        events: functionEvents("exec_command", {
          cmd: "printf 'agentkib-isolated-reconnect'",
          sandbox_permissions: "require_escalated",
          justification: "Synthetic pending request reconnect; decline.",
        }),
      });
      fixture.enqueue({ text: "reconnected subscriber completed pending decision" });
      const count = fixture.requests.length;
      const turn = await origin.request("turn/start", {
        threadId: pendingThread,
        input: [{ type: "text", text: "Synthetic pending request reconnect." }],
      });
      const pending = await origin.waitFor(
        (frame) =>
          frame.method === "item/commandExecution/requestApproval" &&
          frame.params?.turnId === turn.turn.id,
      );
      origin.close();
      const restored = await connectUnix(endpoint, log("pending-restored"));
      clients.push(restored);
      await restored.initialize("agentkib_shared_probe_pending_restored");
      const resume = await restored.request("thread/resume", { threadId: pendingThread });
      report.pendingReconnect = {
        threadId: pendingThread,
        turnId: turn.turn.id,
        originalRequestId: pending.id,
        resumedStatus: resume.thread.status,
      };
      try {
        const replay = await restored.waitFor(
          (frame) =>
            frame.method === "item/commandExecution/requestApproval" &&
            frame.params?.turnId === turn.turn.id,
          0,
          3000,
        );
        assert.equal(replay.id, pending.id);
        restored.write({ id: replay.id, result: { decision: "decline" } });
        const done = await restored.waitFor(
          notification("turn/completed", pendingThread, turn.turn.id),
        );
        assert.equal(done.params.turn.status, "completed");
        assert.equal(fixture.requests.length - count, 2);
        return {
          pendingThread,
          turnId: turn.turn.id,
          freshPendingRequestDelivered: true,
          requestCount: 2,
        };
      } finally {
        const read = await restored.request("thread/read", {
          threadId: pendingThread,
          includeTurns: true,
        });
        if (
          read.thread.turns.some(
            (value) => value.id === turn.turn.id && value.status === "inProgress",
          )
        ) {
          const from = restored.frames.length;
          await restored.request("turn/interrupt", {
            threadId: pendingThread,
            turnId: turn.turn.id,
          });
          await restored.waitFor(notification("turn/completed", pendingThread, turn.turn.id), from);
        }
      }
    });
    await check("owned-server-restart-readback", async () => {
      const before = await b.request("thread/read", { threadId, includeTurns: true });
      const requestCount = fixture.requests.length;
      const originalPid = server.pid;
      for (const client of clients) client.close();
      await stopOwned(server);
      assert(server.exitCode !== null || server.signalCode !== null);
      server = spawn("/usr/bin/sandbox-exec", args, {
        cwd: workspace,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      server.stdout.on("data", (raw) => serverOutput.push(raw));
      server.stderr.on("data", (raw) => serverOutput.push(raw));
      const restored = await connectWhenReady(endpoint, server, log("server-restarted"));
      clients.push(restored);
      await restored.initialize("agentkib_shared_probe_after_restart");
      const after = await restored.request("thread/read", { threadId, includeTurns: true });
      assert.equal(after.thread.id, threadId);
      assert.deepEqual(
        after.thread.turns,
        before.thread.turns,
        "native history changed across server restart",
      );
      const resumed = await restored.request("thread/resume", { threadId });
      assert.equal(resumed.thread.id, threadId);
      assert.equal(fixture.requests.length, requestCount, "read-only restart invoked inference");
      report.restartedServerPid = server.pid;
      return {
        originalPid,
        restartedPid: server.pid,
        exactHistoryPreserved: true,
        sameThreadId: true,
        inferenceRequests: 0,
      };
    });
    report.syntheticRequests = fixture.requests.length;
    report.checks.push({
      name: "real-single-turn",
      status: "not-run",
      reason: "Offline phase; no provider authorization read",
    });
    await diagnostics.writeText(path.join(evidenceDir, "server.log"), Buffer.concat(serverOutput));
  } catch (error) {
    report.errors.push(error.stack ?? error.message);
  } finally {
    for (const client of clients) client.close();
    if (server) await stopOwned(server);
    if (fixture) await fixture.close();
    await diagnostics.writeText(path.join(evidenceDir, "server.log"), Buffer.concat(serverOutput));
    report.finishedAt = new Date().toISOString();
    report.ownedServerExited = !server || server.exitCode !== null || server.signalCode !== null;
    report.installedBinaryUnchanged = sha256(await fs.readFile(source)) === PINNED_CODEX.sha256;
    // Recovery-only returns this same object through finally. Redact it only after
    // checks and cleanup so callers/stdout cannot receive a private diagnostic copy.
    Object.assign(report, diagnostics.sanitize(report));
    for (const [name, frames] of Object.entries(transcripts))
      await diagnostics.writeJsonLines(path.join(evidenceDir, name + ".jsonl"), frames);
    await diagnostics.writeJson(path.join(evidenceDir, "result.json"), report);
    const inventory = [];
    const collect = async (directory) => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) await collect(filename);
        else if (entry.isFile()) {
          const bytes = await fs.readFile(filename);
          inventory.push({
            path: path.relative(evidenceDir, filename),
            bytes: bytes.length,
            sha256: sha256(bytes),
          });
        }
      }
    };
    await collect(evidenceDir);
    await diagnostics.writeJson(
      path.join(evidenceDir, "sha256-manifest.json"),
      inventory.sort((left, right) => left.path.localeCompare(right.path)),
    );
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = Object.fromEntries(
    process.argv
      .slice(2)
      .reduce(
        (pairs, value, index, values) =>
          index % 2 ? pairs : [...pairs, [value, values[index + 1]]],
        [],
      ),
  );
  if (
    !options["--codex"] ||
    !options["--evidence-dir"] ||
    Object.keys(options).some((key) => !["--codex", "--evidence-dir", "--mode"].includes(key)) ||
    (options["--mode"] !== undefined && options["--mode"] !== "recovery-only")
  ) {
    console.error(
      "Usage: node verify-codex-shared-server.mjs --codex /absolute/codex --evidence-dir /new/private/evidence [--mode recovery-only]",
    );
    process.exitCode = 2;
  } else {
    const codex = path.resolve(options["--codex"]);
    const evidenceDir = path.resolve(options["--evidence-dir"]);
    const diagnostics = createProbeDiagnostics({
      binaryPaths: [codex],
      repository: fileURLToPath(new URL("../../../", import.meta.url)),
      evidenceDir,
      home: homedir(),
    });
    try {
      const result = await runProbe({
        codex,
        evidenceDir,
        recoveryOnly: options["--mode"] === "recovery-only",
      });
      console.log(JSON.stringify(diagnostics.sanitize(result), null, 2));
      process.exitCode = result.errors.length ? 1 : 0;
    } catch (error) {
      console.error(diagnostics.text(error));
      process.exitCode = 1;
    }
  }
}
