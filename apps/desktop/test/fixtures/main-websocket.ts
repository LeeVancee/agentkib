import assert from "node:assert/strict";
import { once } from "node:events";
import { createRequire } from "node:module";
import WebSocket, { WebSocketServer } from "ws";

async function main() {
  const runtimeRequire = createRequire(process.argv[1]);
  assert.throws(() => runtimeRequire.resolve("ws"), { code: "MODULE_NOT_FOUND" });

  // This constructor crashed at startup when Vite selected ws's browser stub.
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  let client: WebSocket | undefined;
  try {
    server.on("connection", (socket, request) => {
      assert.equal(request.headers.upgrade, "websocket");
      socket.once("message", (data, isBinary) => socket.send(data, { binary: isBinary }));
    });
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");

    client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await once(client, "open");
    const response = once(client, "message");
    client.send("agentkib standalone echo");
    const [data, isBinary] = await response;
    assert.equal(data.toString(), "agentkib standalone echo");
    assert.equal(isBinary, false);
  } finally {
    client?.terminate();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  console.log("standalone WebSocket echo passed");
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
