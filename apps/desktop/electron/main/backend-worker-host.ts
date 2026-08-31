import { Worker, MessageChannel } from "node:worker_threads";
import { EventEmitter } from "node:events";
import path from "node:path";
import { BackendWorkerClient } from "@agentkib/backend";
import type { RuntimeHandshakeResult } from "../generated/runtime-protocol";

export interface BackendWorkerHostOptions {
  workerUrl: URL | string;
  database_path: string;
  scan_roots?: Array<{ path: string; max_depth?: number }>;
  quota_executable?: string;
  quota_config_path?: string;
  mcp_config_path?: string;
  gateway_config_path?: string;
  mcp_registry_path?: string;
  timeoutMs?: number;
}
export function backendWorkerUrl(): string {
  return path.join(__dirname, "backend-worker.cjs");
}

/** Electron-main adapter; startup wiring remains owned by main/index. */
export class BackendWorkerHost extends EventEmitter {
  readonly client: BackendWorkerClient;
  readonly worker: Worker;
  private stopped = false;
  constructor(options: BackendWorkerHostOptions) {
    super();
    this.worker = new Worker(options.workerUrl, {
      workerData: {
        database_path: options.database_path,
        scan_roots: options.scan_roots,
        quota_executable: options.quota_executable,
        quota_config_path: options.quota_config_path,
        mcp_config_path: options.mcp_config_path,
        gateway_config_path: options.gateway_config_path,
        mcp_registry_path: options.mcp_registry_path,
      },
    });
    const channel = new MessageChannel();
    this.worker.postMessage({ type: "connect", port: channel.port1 }, [channel.port1]);
    this.client = new BackendWorkerClient(channel.port2, { timeoutMs: options.timeoutMs });
    this.worker.once("error", (error) => {
      this.emit("crash-loop", error);
      void this.stop();
    });
    this.worker.once("exit", (code) => {
      this.emit("exit", { code, signal: null, expected: this.stopped });
      if (code !== 0) void this.stop();
    });
  }
  async start(): Promise<RuntimeHandshakeResult> {
    const handshake = (await this.client.handshake()) as RuntimeHandshakeResult;
    this.emit("ready", handshake);
    return handshake;
  }
  request<T = unknown>(
    method: string,
    params?: unknown,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<T> {
    return this.client.request<T>(method, params, options);
  }
  handshake(): ReturnType<BackendWorkerClient["handshake"]> {
    return this.client.handshake();
  }
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.client.shutdown().catch(() => undefined);
    await this.worker.terminate();
  }
}
