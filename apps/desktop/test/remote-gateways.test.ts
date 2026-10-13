import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { RemoteGateways } from "../../../packages/backend/src/remote-gateways";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const METHODS = ["agents.list", "sessions.list", "agents.files.list", "skills.status"];

async function fakeOpenClaw(failureMessage = "missing scope operator.read") {
  const failing = new Set<string>();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) client.terminate();
        server.close(() => resolve());
      }),
  );
  server.on("connection", (socket) => {
    const send = (value: unknown) => socket.send(JSON.stringify(value));
    send({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "nonce", ts: Date.now() },
    });
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as { id: string; method: string };
      const respond = (payload: unknown) =>
        send({ type: "res", id: request.id, ok: true, payload });
      if (failing.has(request.method))
        return send({ type: "res", id: request.id, ok: false, error: { message: failureMessage } });
      switch (request.method) {
        case "connect":
          return respond({
            server: { version: "9.9.9" },
            auth: {},
            features: { methods: METHODS },
          });
        case "agents.list":
          return respond({
            agents: [{ id: "main", name: "Main", workspace: "/work/main" }],
          });
        case "agents.files.list":
          return respond({ files: [{ path: "AGENTS.md", name: "AGENTS.md", size: 12 }] });
        case "skills.status":
          return respond({ skills: [{ name: "demo", path: "skills/demo" }] });
        case "sessions.list":
          return respond({
            sessions: [
              { agentId: "main", workspace: "/work/main", updatedAt: "2026-10-01T00:00:00Z" },
            ],
          });
        default:
          return send({ type: "res", id: request.id, ok: false, error: { message: "unknown" } });
      }
    });
  });
  const { port } = server.address() as AddressInfo;
  return { url: `ws://127.0.0.1:${port}`, failing };
}

async function fixture(options: { secret?: string; failureMessage?: string } = {}) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "agentkib-gateways-"));
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const gateway = await fakeOpenClaw(options.failureMessage);
  const gateways = new RemoteGateways(dataDir);
  const saved = await gateways.save({
    kind: "open-claw",
    name: "Fixture gateway",
    url: gateway.url,
    auth_kind: options.secret ? "token" : "none",
    secret: options.secret,
  });
  return { gateway, refresh: () => gateways.refresh({ id: saved.id }) };
}

describe("OpenClaw gateway refresh", () => {
  it("reports a fully readable gateway without an error", async () => {
    const f = await fixture();
    const summary = await f.refresh();
    expect(summary.state).toBe("connected");
    expect(summary.session_count).toBe(1);
    expect(summary.assets.map((asset) => asset.name).sort()).toEqual(["AGENTS.md", "demo"]);
    expect(summary).not.toHaveProperty("last_error");
  });

  it("stays connected but reports the failure when an optional request is rejected", async () => {
    const f = await fixture();
    f.gateway.failing.add("sessions.list");
    const summary = await f.refresh();
    expect(summary.state).toBe("connected");
    expect(summary.assets).toHaveLength(2);
    expect(summary.session_count).toBe(0);
    expect(summary.last_error).toMatch(/incomplete/i);
    expect(summary.last_error).toContain("Gateway method sessions.list failed: missing scope");
  });

  it("counts every rejected request and keeps the first reason", async () => {
    const f = await fixture();
    f.gateway.failing.add("agents.files.list");
    f.gateway.failing.add("skills.status");
    const summary = await f.refresh();
    expect(summary.state).toBe("connected");
    expect(summary.assets).toEqual([]);
    expect(summary.last_error).toMatch(/2 requests failed/);
    expect(summary.last_error).toContain("Gateway method agents.files.list failed");
  });

  it("clears the incomplete-data notice once a later refresh reads everything", async () => {
    const f = await fixture();
    f.gateway.failing.add("sessions.list");
    expect((await f.refresh()).last_error).toBeTruthy();
    f.gateway.failing.clear();
    const recovered = await f.refresh();
    expect(recovered.state).toBe("connected");
    expect(recovered).not.toHaveProperty("last_error");
    expect(recovered.session_count).toBe(1);
  });

  it("redacts the stored secret from a gateway-provided failure reason", async () => {
    const secret = "shared-secret-value";
    const f = await fixture({ secret, failureMessage: `rejected token ${secret}` });
    f.gateway.failing.add("sessions.list");
    const summary = await f.refresh();
    expect(summary.last_error).not.toContain(secret);
    expect(summary.last_error).toContain("[redacted]");
  });
});
