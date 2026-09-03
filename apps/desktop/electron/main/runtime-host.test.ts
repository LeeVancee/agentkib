import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "../generated/runtime-protocol";
import { DesktopRuntimeHost, type RuntimeHostStatus } from "./runtime-host";

const fakeRuntimeSource = String.raw`
const readline = require("node:readline");
const fs = require("node:fs");
const mode = process.env.FAKE_RUNTIME_MODE;
if (mode === "exit-before-handshake") process.exit(12);
if (mode === "restart-once") {
  const marker = process.env.FAKE_RUNTIME_MARKER;
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(marker, "failed");
    process.exit(13);
  }
}
const lines = readline.createInterface({ input: process.stdin });
const respond = (request, result) => process.stdout.write(JSON.stringify({
  jsonrpc: "2.0",
  id: request.id,
  result,
}) + "\n");
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "agentkib.handshake") {
    if (mode === "never-handshake") return;
    const send = () => respond(request, {
      protocolVersion: ${PROTOCOL_VERSION},
      runtime: { name: "fake-runtime", version: "0.0.0" },
      pid: process.pid,
    });
    if (mode === "delayed") setTimeout(send, 60);
    else send();
    return;
  }
  if (request.method === "agentkib.shutdown") {
    if (mode === "ignore-shutdown") return;
    respond(request, null);
    process.exit(0);
  }
  if (request.method === "crash") process.exit(14);
  else respond(request, request.params);
});
`;

describe("DesktopRuntimeHost", () => {
  let directory: string;
  let script: string;
  let hosts: DesktopRuntimeHost[];

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "agentkib-runtime-host-"));
    script = path.join(directory, "fake-runtime.cjs");
    await writeFile(script, fakeRuntimeSource);
    hosts = [];
  });

  afterEach(async () => {
    await Promise.all(hosts.map((host) => host.stop()));
    await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function createHost(mode: () => string, maxRestarts = 3) {
    const marker = path.join(directory, "restart.marker");
    const host = new DesktopRuntimeHost({
      executablePath: process.execPath,
      clientVersion: "test",
      maxRestarts,
      shutdownTimeoutMs: 200,
      spawnProcess: (_executablePath, _args, options) =>
        spawn(process.execPath, [script], {
          ...options,
          env: {
            ...options?.env,
            FAKE_RUNTIME_MODE: mode(),
            FAKE_RUNTIME_MARKER: marker,
          },
        }) as ChildProcessWithoutNullStreams,
    });
    hosts.push(host);
    return host;
  }

  it("queues requests until the handshake succeeds", async () => {
    const host = createHost(() => "delayed");
    const starting = host.start();
    const request = host.request<{ value: number }>("echo", { value: 7 });

    await expect(starting).resolves.toMatchObject({ protocolVersion: PROTOCOL_VERSION });
    await expect(request).resolves.toEqual({ value: 7 });
    expect(host.status.state).toBe("ready");
  });

  it("recovers queued startup requests after a failed first process", async () => {
    const statuses: RuntimeHostStatus[] = [];
    const host = createHost(() => "restart-once");
    host.on("state", (status: RuntimeHostStatus) => statuses.push(status));

    const starting = host.start();
    const request = host.request("echo", { recovered: true });

    await expect(starting).resolves.toMatchObject({ protocolVersion: PROTOCOL_VERSION });
    await expect(request).resolves.toEqual({ recovered: true });
    expect(statuses.some((status) => status.state === "restarting")).toBe(true);
    expect(host.status.state).toBe("ready");
  });

  it("rejects an in-flight request when the runtime exits", async () => {
    const host = createHost(() => "ready", 0);
    await host.start();

    await expect(host.request("crash", {})).rejects.toThrow("exited with code 14");
    await vi.waitFor(() => expect(host.status.state).toBe("failed"));
  });

  it("allows a terminal failure to be retried manually", async () => {
    let mode = "exit-before-handshake";
    const host = createHost(() => mode, 0);

    await expect(host.start()).rejects.toThrow();
    expect(host.status.state).toBe("failed");

    mode = "ready";
    await expect(host.retry()).resolves.toMatchObject({ protocolVersion: PROTOCOL_VERSION });
    expect(host.status.state).toBe("ready");
  });

  it("cancels startup waiters when stopped", async () => {
    const host = createHost(() => "never-handshake");
    const starting = host.start();
    const request = host.request("echo", {});
    const startingResult = expect(starting).rejects.toThrow("stopping");
    const requestResult = expect(request).rejects.toThrow("stopping");

    await host.stop();
    await startingResult;
    await requestResult;
    expect(host.status.state).toBe("stopping");
  });

  it("bounds shutdown when the runtime ignores the shutdown request", async () => {
    const host = createHost(() => "ignore-shutdown");
    await host.start();
    const startedAt = Date.now();

    await host.stop();

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(host.status.state).toBe("stopping");
  });
});
