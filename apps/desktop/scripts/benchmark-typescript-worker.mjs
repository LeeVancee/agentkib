import { Worker, MessageChannel } from "node:worker_threads";
import readline from "node:readline";

const workerPath = process.argv[2];
if (!workerPath) throw new Error("TypeScript worker bundle path is required");

const workerOptions = JSON.parse(process.env.AGENTKIB_TS_WORKER_OPTIONS ?? "{}");
const worker = new Worker(workerPath, { workerData: workerOptions });
const channel = new MessageChannel();
const externalIds = new Map();
let shuttingDown = false;

worker.postMessage({ type: "connect", port: channel.port1 }, [channel.port1]);
channel.port2.on("message", (response) => {
  const externalId = externalIds.get(response.id);
  if (externalId === undefined) return;
  externalIds.delete(response.id);
  process.stdout.write(`${JSON.stringify({ ...response, id: externalId })}\n`);
  if (shuttingDown) {
    channel.port2.close();
    void worker.terminate().finally(() => process.exit(0));
  }
});
channel.port2.start();

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  const workerId = String(request.id);
  externalIds.set(workerId, request.id);
  if (request.method === "agentkib.shutdown") shuttingDown = true;
  channel.port2.postMessage({
    id: workerId,
    method: request.method,
    ...(request.params === undefined ? {} : { params: request.params }),
  });
});

worker.once("error", (error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exit(1);
});
worker.once("exit", (code) => {
  if (!shuttingDown && code !== 0) process.exit(code);
});
