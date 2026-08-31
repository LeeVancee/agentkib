import { describe, expect, test } from "vitest";
import { MessageChannel } from "node:worker_threads";
import { BackendWorkerClient, BackendWorkerHost } from "../src/index.js";

function setup() {
  const channel = new MessageChannel();
  const host = new BackendWorkerHost(channel.port1, {
    echo: (params) => params,
    delay: async (_params, signal) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve("done"), 100);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          },
          { once: true },
        );
      }),
  });
  host.start();
  return { host, client: new BackendWorkerClient(channel.port2, { timeoutMs: 30 }) };
}

describe("backend worker transport", () => {
  test("handshakes and dispatches registered methods", async () => {
    const { client } = setup();
    await expect(client.handshake()).resolves.toMatchObject({
      protocolVersion: 1,
      runtime: { name: "@agentkib/backend" },
      pid: expect.any(Number),
    });
    await expect(client.request("echo", { value: 1 })).resolves.toEqual({ value: 1 });
    await client.shutdown();
  });

  test("returns structured unknown-method errors", async () => {
    const { client } = setup();
    await expect(client.request("missing")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await client.shutdown();
  });

  test("supports timeout and AbortSignal cancellation", async () => {
    const { client } = setup();
    await expect(client.request("delay")).rejects.toMatchObject({ code: "TIMEOUT" });
    const controller = new AbortController();
    const pending = client.request("delay", undefined, {
      signal: controller.signal,
      timeoutMs: 500,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    await client.shutdown();
  });

  test("shuts down and rejects subsequent requests", async () => {
    const { client } = setup();
    await client.shutdown();
    await expect(client.request("echo")).rejects.toMatchObject({ code: "INTERNAL" });
  });
});
