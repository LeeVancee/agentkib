import { parentPort } from "node:worker_threads";
import { BackendWorkerHost } from "./host.js";
import { workerData } from "node:worker_threads";
import { createBackendRuntime } from "../runtime/runtime.js";

if (!parentPort) throw new Error("Backend worker requires parentPort");
const options = workerData as
  | {
      database_path?: string;
      scan_roots?: Array<{ path: string; max_depth?: number }>;
      quota_executable?: string;
    }
  | undefined;
const runtime = options?.database_path
  ? createBackendRuntime({
      database_path: options.database_path,
      scan_roots: options.scan_roots,
      quota_executable: options.quota_executable,
    })
  : undefined;
const registry = runtime?.registry ?? {};
parentPort.on("message", (value: unknown) => {
  if (
    value &&
    typeof value === "object" &&
    "type" in value &&
    value.type === "connect" &&
    "port" in value
  ) {
    new BackendWorkerHost(value.port as import("node:worker_threads").MessagePort, registry, {
      onShutdown: runtime?.close,
    }).start();
  }
});
