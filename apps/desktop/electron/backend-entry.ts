import { createInterface } from "node:readline";
import { TypeScriptBackend } from "@agentkib/backend";
import { RUNTIME_METHODS } from "./generated/runtime-protocol";

const backend = new TypeScriptBackend();

function shuttingDown(request: unknown): boolean {
  return (
    typeof request === "object" &&
    request !== null &&
    "method" in request &&
    request.method === RUNTIME_METHODS.shutdown
  );
}

if (process.parentPort) {
  process.parentPort.on("message", ({ data }) => {
    process.parentPort!.postMessage(backend.handle(data));
    if (shuttingDown(data)) setImmediate(() => process.exit(0));
  });
} else {
  // Identical handlers can run headlessly for differential tests and future CLI use.
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    let request: unknown;
    try {
      request = JSON.parse(line);
    } catch {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`,
      );
      return;
    }
    process.stdout.write(`${JSON.stringify(backend.handle(request))}\n`, () => {
      if (shuttingDown(request)) process.exit(0);
    });
  });
  input.on("close", () => {
    backend.close();
    process.exit(0);
  });
}
