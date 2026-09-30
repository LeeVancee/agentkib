import { createInterface } from "node:readline";
import { TypeScriptBackend } from "@agentkib/backend";
import { RUNTIME_METHODS } from "./generated/runtime-protocol";

const backend = new TypeScriptBackend();
const pending = new Set<Promise<void>>();
let closing = false;
function shutdown(request: unknown): boolean {
  return (
    typeof request === "object" &&
    request !== null &&
    "method" in request &&
    request.method === RUNTIME_METHODS.shutdown
  );
}
function dispatch(request: unknown, send: (response: unknown) => Promise<void>): void {
  if (closing) return;
  const stopping = shutdown(request);
  if (stopping) closing = true;
  const task = backend
    .handleAsync(request)
    .then(async (response) => {
      if (stopping) await Promise.allSettled([...pending].filter((value) => value !== task));
      await send(response);
      if (stopping) process.exit(0);
    })
    .finally(() => pending.delete(task))
    .catch(() => {
      closing = true;
      backend.close();
      process.exit(1);
    });
  pending.add(task);
}
if (process.parentPort) {
  process.parentPort.on("message", ({ data }) =>
    dispatch(data, async (response) => process.parentPort!.postMessage(response)),
  );
} else {
  const input = createInterface({ input: process.stdin });
  const send = (response: unknown) =>
    new Promise<void>((resolve) =>
      process.stdout.write(`${JSON.stringify(response)}\n`, () => resolve()),
    );
  input.on("line", (line) => {
    let request: unknown;
    try {
      request = JSON.parse(line);
    } catch {
      void send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    dispatch(request, send);
  });
  input.on("close", () => {
    closing = true;
    void Promise.allSettled([...pending]).then(() => {
      backend.close();
      process.exit(0);
    });
  });
}
