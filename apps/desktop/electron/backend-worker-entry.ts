import { parentPort, workerData } from "node:worker_threads";
import { BackendWorkerHost, createBackendRuntime } from "@agentkib/backend";

if (!parentPort) throw new Error("Backend worker requires parentPort");
const options = workerData as
  | {
      database_path?: string;
      scan_roots?: Array<{ path: string; max_depth?: number }>;
      quota_executable?: string;
      quota_config_path?: string;
      mcp_config_path?: string;
      gateway_config_path?: string;
      mcp_registry_path?: string;
    }
  | undefined;
const runtime = options?.database_path
  ? createBackendRuntime({
      database_path: options.database_path,
      scan_roots: options.scan_roots,
      quota_executable: options.quota_executable,
      quota_config_path: options.quota_config_path,
      mcp_config_path: options.mcp_config_path,
      gateway_config_path: options.gateway_config_path,
      mcp_registry_path: options.mcp_registry_path,
    })
  : undefined;
parentPort.on("message", (value: unknown) => {
  if (
    value &&
    typeof value === "object" &&
    "type" in value &&
    value.type === "connect" &&
    "port" in value
  ) {
    new BackendWorkerHost(
      value.port as import("node:worker_threads").MessagePort,
      runtime?.registry ?? {},
      { onShutdown: runtime?.close },
    ).start();
  }
});
