// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import {
  SharedRpcClient,
  SYNTHETIC_MODEL,
  connectUnix,
  createAckLossProxy,
  createResponsesFixture,
  createProbeDiagnostics,
  runProbe,
  responseEvents,
} from "../scripts/verify-codex-shared-server.mjs";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
});

describe("shared Codex protocol probe", () => {
  it("redacts diagnostic copies without changing execution data, identity hashes or message text", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ak-cx-diagnostics-"));
    cleanups.push(() => rm(directory, { force: true, recursive: true }));
    const home = "/Users/synthetic-probe-owner";
    const repository = home + "/private/project";
    const evidenceDir = home + "/.codex/tmp/shared-probe";
    const root = "/private/tmp/ak-cx-synthetic";
    const source = "/opt/private-codex-build/bin/codex";
    const sourceAlias = home + "/.local/bin/codex";
    const diagnostics = createProbeDiagnostics({
      binaryPaths: [source, sourceAlias],
      repository,
      evidenceDir,
      root,
      home,
    });
    const command = {
      binary: evidenceDir + "/codex-0.155.1",
      source,
      alias: sourceAlias,
      version: "codex-cli 0.155.1",
      sha256: "8eaf1ad12fe6bf89b1710330f58900014322c7c5af677e43be116d8ac5fc0a9e",
      args: [
        "-p",
        `(allow file-read* (subpath ${JSON.stringify(root)}))`,
        "unix://" + root + "/server.sock",
      ],
      env: { HOME: root + "/home", CODEX_HOME: root + "/codex" },
      workspace: root + "/workspace",
      rpc: {
        method: "thread/start",
        params: { cwd: root + "/workspace", id: "thread-native-uuid" },
        body: JSON.stringify({ cwd: repository + "/src", prompt: "保留完整项目决策 🧭" }),
      },
      error: `Error: cannot read ${home}/.codex/state.sqlite\n    at probe (file://${repository}/apps/desktop/scripts/probe.mjs:12:3)`,
      relative: "apps/desktop/src/main.ts",
      unrelated: home + "-other/file.txt",
      placeholders:
        "$HOME/.codex $WORKTREE/src $EVIDENCE_DIR/result.json $ISOLATED_ROOT/workspace $CODEX_BINARY",
    };
    const original = JSON.stringify(command);
    const hash = createHash("sha256").update(original).digest("hex");
    const safe = diagnostics.sanitize(command);
    expect(safe).toMatchObject({
      binary: "$EVIDENCE_DIR/codex-0.155.1",
      source: "$CODEX_BINARY",
      alias: "$CODEX_BINARY",
      sha256: command.sha256,
      version: command.version,
      workspace: "$ISOLATED_ROOT/workspace",
      env: { HOME: "$ISOLATED_ROOT/home", CODEX_HOME: "$ISOLATED_ROOT/codex" },
      rpc: {
        method: "thread/start",
        params: { cwd: "$ISOLATED_ROOT/workspace", id: "thread-native-uuid" },
        body: JSON.stringify({ cwd: "$WORKTREE/src", prompt: "保留完整项目决策 🧭" }),
      },
      error:
        "Error: cannot read $HOME/.codex/state.sqlite\n    at probe ($WORKTREE/apps/desktop/scripts/probe.mjs:12:3)",
      relative: command.relative,
      unrelated: command.unrelated,
      placeholders: command.placeholders,
    });
    expect(safe.args).toEqual([
      "-p",
      '(allow file-read* (subpath "$ISOLATED_ROOT"))',
      "unix://$ISOLATED_ROOT/server.sock",
    ]);
    expect(diagnostics.sanitize(safe)).toEqual(safe);
    expect(JSON.stringify(command)).toBe(original);
    expect(createHash("sha256").update(JSON.stringify(command)).digest("hex")).toBe(hash);
    await diagnostics.writeJson(path.join(directory, "command.json"), command);
    await diagnostics.writeJsonLines(path.join(directory, "rpc.jsonl"), [command.rpc]);
    await diagnostics.writeText(path.join(directory, "server.log"), Buffer.from(command.error));
    expect(JSON.parse(await readFile(path.join(directory, "command.json"), "utf8"))).toEqual(safe);
    expect(JSON.parse((await readFile(path.join(directory, "rpc.jsonl"), "utf8")).trim())).toEqual(
      safe.rpc,
    );
    expect(await readFile(path.join(directory, "server.log"), "utf8")).toBe(safe.error);
  });

  it("redacts Windows, escaped RPC paths and URI-encoded error stacks once", () => {
    const home = String.raw`C:\Users\synthetic-probe-owner`;
    const repository = home + String.raw`\Private Project\agentkib`;
    const evidenceDir = home + String.raw`\.codex\tmp\shared-probe`;
    const binary = String.raw`D:\custom-build\codex.exe`;
    const root = String.raw`C:\Temp\ak-cx-synthetic`;
    const diagnostics = createProbeDiagnostics({
      binaryPaths: [binary],
      repository,
      evidenceDir,
      root,
      home,
    });
    const rpc = { arguments: JSON.stringify({ cwd: repository + String.raw`\src`, binary }) };
    const safe = diagnostics.sanitize({
      command: { binary, env: { HOME: root + String.raw`\home` }, evidenceDir },
      rpc,
      error: `Error: read ${home}\\.codex\\state.sqlite\n    at probe (file:///C:/Users/synthetic-probe-owner/Private%20Project/agentkib/scripts/probe.mjs:42:2)`,
      forward: "c:/users/synthetic-probe-owner/Private Project/agentkib/src/main.ts",
    });
    expect(safe).toEqual({
      command: {
        binary: "$CODEX_BINARY",
        env: { HOME: String.raw`$ISOLATED_ROOT\home` },
        evidenceDir: "$EVIDENCE_DIR",
      },
      rpc: {
        arguments: JSON.stringify({ cwd: String.raw`$WORKTREE\src`, binary: "$CODEX_BINARY" }),
      },
      error:
        "Error: read $HOME\\.codex\\state.sqlite\n    at probe ($WORKTREE/scripts/probe.mjs:42:2)",
      forward: "$WORKTREE/src/main.ts",
    });
    expect(diagnostics.sanitize(safe)).toEqual(safe);
    expect(JSON.parse(rpc.arguments)).toEqual({ cwd: repository + String.raw`\src`, binary });
  });

  it("sanitizes nested Error values and object keys but leaves stable diagnostic identities unchanged", () => {
    const repository = "/opt/synthetic-probe-project";
    const diagnostics = createProbeDiagnostics({ repository });
    const error = new Error("Failed at " + repository + "/worker.js");
    error.stack = `Error: Failed at ${repository}/worker.js\n    at async run (file://${repository}/worker.js:99:1)`;
    const safe = diagnostics.sanitize({
      [repository + "/message.json"]: { error, threadId: "native-uuid", tool: "exec_command" },
    });
    expect(safe).toMatchObject({
      "$WORKTREE/message.json": {
        error: {
          message: "Failed at $WORKTREE/worker.js",
          stack:
            "Error: Failed at $WORKTREE/worker.js\n    at async run ($WORKTREE/worker.js:99:1)",
        },
        threadId: "native-uuid",
        tool: "exec_command",
      },
    });
    expect(diagnostics.text(error)).toBe(
      "Error: Failed at $WORKTREE/worker.js\n    at async run ($WORKTREE/worker.js:99:1)",
    );
  });

  it("redacts known URI/query/ANSI boundaries and UNC paths without treating percent as a path separator", () => {
    const binary = "/opt/synthetic-build/100%/codex probe";
    const repository = String.raw`\\synthetic-host\private-share\Private Project\agentkib`;
    const diagnostics = createProbeDiagnostics({ binaryPaths: [binary], repository });
    expect(diagnostics.text(`${binary}?mode=probe#result`)).toBe("$CODEX_BINARY?mode=probe#result");
    expect(diagnostics.text(`${binary}#result`)).toBe("$CODEX_BINARY#result");
    expect(diagnostics.text(`\u001b[31m${binary}\u001b[0m`)).toBe(
      "\u001b[31m$CODEX_BINARY\u001b[0m",
    );
    expect(diagnostics.text("file:///opt/synthetic-build/100%25/codex%20probe#result")).toBe(
      "$CODEX_BINARY#result",
    );
    expect(
      diagnostics.text(
        "file://synthetic-host/private-share/Private%20Project/agentkib/src/main.ts",
      ),
    ).toBe("$WORKTREE/src/main.ts");
    expect(diagnostics.text(repository + String.raw`\src\main.ts`)).toBe(
      String.raw`$WORKTREE\src\main.ts`,
    );
    expect(diagnostics.text(binary + "%extra")).toBe("$CODEX_INSTALL_DIR/codex probe%extra");
  });

  it("sanitizes setup failures before a native binary can be started", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ak-cx-no-binary-"));
    cleanups.push(() => rm(directory, { force: true, recursive: true }));
    let failure: Error | undefined;
    try {
      await runProbe({
        codex: path.join(directory, "missing-private-binary"),
        evidenceDir: path.join(directory, "evidence"),
      });
    } catch (error) {
      failure = error as Error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure!.stack).not.toContain(directory);
    expect(failure!.stack).not.toContain(import.meta.dirname);
    if (process.platform === "darwin") {
      expect(failure!.message).toContain("$CODEX_BINARY");
      expect(failure!.stack).toContain("$CODEX_BINARY");
    } else expect(failure!.message).toContain("Native acceptance requires macOS");
  });

  it("redacts custom installation directories using each platform's dirname without matching roots", () => {
    const diagnostics = createProbeDiagnostics({
      binaryPaths: [
        "/opt/synthetic-private/bin/codex",
        String.raw`D:\synthetic-private\bin\codex.exe`,
      ],
    });
    expect(diagnostics.text("install directory /opt/synthetic-private/bin")).toBe(
      "install directory $CODEX_INSTALL_DIR",
    );
    expect(diagnostics.text(String.raw`install directory D:\synthetic-private\bin`)).toBe(
      "install directory $CODEX_INSTALL_DIR",
    );
    expect(diagnostics.text(String.raw`D:\synthetic-private\bin\other.exe`)).toBe(
      String.raw`$CODEX_INSTALL_DIR\other.exe`,
    );
    const roots = createProbeDiagnostics({ binaryPaths: ["/codex", String.raw`Q:\codex.exe`] });
    expect(roots.text("/usr/bin/helper Q:\\other.exe")).toBe("/usr/bin/helper Q:\\other.exe");
  });

  it("disconnect rejects an already dispatched request and never resends it", async () => {
    const sent: unknown[] = [];
    let closed = 0;
    const client = new SharedRpcClient(
      (raw: string) => sent.push(JSON.parse(raw)),
      () => closed++,
    );
    const pending = client.request("turn/start", { threadId: "same-native-thread" });
    const rejected = expect(pending).rejects.toThrow("connection-closed");
    client.close();
    client.close();
    await rejected;
    await expect(client.request("turn/start", {})).rejects.toThrow("connection-closed");
    expect(sent).toEqual([
      { id: 1, method: "turn/start", params: { threadId: "same-native-thread" } },
    ]);
    expect(closed).toBe(1);
    expect(client.pending.size).toBe(0);
  });

  it("rejects malformed input without treating an absent result as success", async () => {
    const client = new SharedRpcClient(
      () => {},
      () => {},
    );
    const pending = client.request("thread/read", {});
    const rejected = expect(pending).rejects.toThrow("invalid-response");
    client.receive(JSON.stringify({ id: 1 }));
    await rejected;
    expect(client.pending.size).toBe(0);
    client.close();
  });

  it("waits for a new turn completion and ignores old terminal events", async () => {
    const client = new SharedRpcClient(
      () => {},
      () => {},
    );
    client.receive(JSON.stringify({ method: "turn/completed", params: { turn: { id: "old" } } }));
    const waiting = client.waitFor(
      (frame: { method: string }) => frame.method === "turn/completed",
      client.frames.length,
    );
    client.receive(JSON.stringify({ method: "turn/completed", params: { turn: { id: "new" } } }));
    await expect(waiting).resolves.toMatchObject({ params: { turn: { id: "new" } } });
    client.close();
  });

  it("closing a borrowed connection does not invoke any stop-server operation", () => {
    const sent: unknown[] = [];
    const client = new SharedRpcClient(
      (raw: string) => sent.push(JSON.parse(raw)),
      () => {},
    );
    client.close();
    expect(sent).toEqual([]);
    expect(client.closed).toBe(true);
  });

  it("timeout keeps the dispatch unique even after a late native response", async () => {
    vi.useFakeTimers();
    const sent: unknown[] = [];
    const client = new SharedRpcClient(
      (raw: string) => sent.push(JSON.parse(raw)),
      () => {},
    );
    const pending = client.request("turn/start", { threadId: "native" }, 100);
    const rejected = expect(pending).rejects.toThrow("request-timeout");
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    client.receive(JSON.stringify({ id: 1, result: { turn: { id: "late-turn" } } }));
    expect(sent).toHaveLength(1);
    expect(client.pending.size).toBe(0);
    client.close();
  });

  it("synthetic response preserves Unicode and emits consistent final text", () => {
    const text = "历史标记：共享执行者 🧭\nproject decision remains unchanged";
    const events = responseEvents(text, "fixture");
    const deltas = events.filter(
      (event: { type: string }) => event.type === "response.output_text.delta",
    );
    expect(deltas.map((event: { delta: string }) => event.delta).join("")).toBe(text);
    expect(events.at(-1)).toMatchObject({
      type: "response.completed",
      response: { status: "completed", output: [{ content: [{ text }] }] },
    });
  });

  it("admits exactly one synthetic request and rejects unplanned follow-up requests", async () => {
    const fixture = await createResponsesFixture();
    cleanups.push(() => fixture.close());
    fixture.enqueue({ text: "one local synthetic response" });
    const init = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stream: true, model: SYNTHETIC_MODEL }),
    };
    const first = await fetch(fixture.url + "/responses", init);
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("one local synthetic response");
    const duplicate = await fetch(fixture.url + "/responses", init);
    expect(duplicate.status).toBe(403);
    expect(await duplicate.text()).toBe("No synthetic case admitted");
    expect(fixture.requests).toHaveLength(2);
  });

  it("rejects background title requests without consuming the intended user response", async () => {
    const fixture = await createResponsesFixture();
    cleanups.push(() => fixture.close());
    fixture.enqueue({ text: "expected reply", expectedPrompt: "exact terminal prompt" });
    const post = (text: string) =>
      fetch(fixture.url + "/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stream: true,
          model: SYNTHETIC_MODEL,
          input: [{ role: "user", content: [{ type: "input_text", text }] }],
        }),
      });
    const background = await post("Generate a task title");
    expect(background.status).toBe(403);
    expect(await background.text()).toBe("Unplanned synthetic prompt");
    const admitted = await post("exact terminal prompt");
    expect(admitted.status).toBe(200);
    expect(await admitted.text()).toContain("expected reply");
    expect(fixture.requests).toHaveLength(2);
  });

  it.skipIf(process.platform === "win32")(
    "drops an armed turn ACK before the caller receives it or a stream delta",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "ak-cx-loss-"));
      cleanups.push(() => rm(directory, { force: true, recursive: true }));
      const endpoint = path.join(directory, "native.sock");
      const proxyEndpoint = path.join(directory, "loss.sock");
      const server = createServer();
      const websocket = new WebSocketServer({ server });
      const received: Array<{ id: number; method: string }> = [];
      websocket.on("connection", (socket) =>
        socket.on("message", (raw) => {
          const request = JSON.parse(raw.toString());
          received.push(request);
          if (!request.id) return;
          socket.send(
            JSON.stringify({
              id: request.id,
              result: request.method === "turn/start" ? { turn: { id: "native-turn" } } : {},
            }),
          );
          if (request.method === "turn/start")
            socket.send(
              JSON.stringify({
                method: "item/agentMessage/delta",
                params: { delta: "must not reach origin" },
              }),
            );
        }),
      );
      await new Promise<void>((resolve) => server.listen(endpoint, resolve));
      cleanups.push(async () => {
        for (const socket of websocket.clients) socket.terminate();
        await new Promise<void>((resolve) => websocket.close(() => resolve()));
        await new Promise<void>((resolve) => server.close(() => resolve()));
      });
      const proxy = await createAckLossProxy(proxyEndpoint, endpoint);
      cleanups.push(() => proxy.close());
      const client = await connectUnix(proxyEndpoint);
      cleanups.push(() => client.close());
      await client.initialize("synthetic-loss-test");
      const before = client.frames.length;
      proxy.arm();
      await expect(client.request("turn/start", { threadId: "native-thread" })).rejects.toThrow(
        "connection-closed",
      );
      expect(proxy.dropped()).toMatchObject({
        requestId: 2,
        frame: { result: { turn: { id: "native-turn" } } },
      });
      expect(client.frames.slice(before)).toEqual([]);
      expect(received.filter((frame) => frame.method === "turn/start")).toHaveLength(1);
    },
  );

  it.skipIf(process.platform === "win32")(
    "uses HTTP Upgrade over a private Unix socket and closes only its client",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "ak-cx-unit-"));
      cleanups.push(() => rm(directory, { force: true, recursive: true }));
      const endpoint = path.join(directory, "server.sock");
      const server = createServer();
      const websocket = new WebSocketServer({ server });
      let offeredExtension: string | undefined;
      websocket.on("connection", (socket, request) => {
        offeredExtension = request.headers["sec-websocket-extensions"];
        socket.on("message", (raw) => {
          const request = JSON.parse(raw.toString());
          socket.send(
            JSON.stringify({ id: request.id, result: { thread: { id: request.params.threadId } } }),
          );
        });
      });
      await new Promise<void>((resolve) => server.listen(endpoint, resolve));
      cleanups.push(async () => {
        for (const socket of websocket.clients) socket.terminate();
        await new Promise<void>((resolve) => websocket.close(() => resolve()));
        await new Promise<void>((resolve) => server.close(() => resolve()));
      });
      const client = await connectUnix(endpoint);
      expect(offeredExtension).toBeUndefined();
      cleanups.push(() => client.close());
      await expect(client.request("thread/read", { threadId: "native-id" })).resolves.toEqual({
        thread: { id: "native-id" },
      });
      client.close();
      expect(server.listening).toBe(true);
      const second = await connectUnix(endpoint);
      cleanups.push(() => second.close());
      await expect(second.request("thread/read", { threadId: "native-id" })).resolves.toEqual({
        thread: { id: "native-id" },
      });
    },
  );
});
