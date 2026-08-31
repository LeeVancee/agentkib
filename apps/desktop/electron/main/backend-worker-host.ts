import { Worker, MessageChannel } from "node:worker_threads";
import { BackendWorkerClient } from "@agentkib/backend";

export interface BackendWorkerHostOptions {
  workerUrl: URL | string;
  database_path: string;
  scan_roots?: Array<{ path: string; max_depth?: number }>;
  quota_executable?: string;
  timeoutMs?: number;
}
export function backendWorkerUrl(): URL {
  return new URL("./backend-worker.cjs", import.meta.url);
}

/** Electron-main adapter; startup wiring remains owned by main/index. */
export class BackendWorkerHost {
  readonly client: BackendWorkerClient;
  readonly worker: Worker;
  private stopped = false;
  constructor(options: BackendWorkerHostOptions) {
    this.worker = new Worker(options.workerUrl, {
      workerData: {
        database_path: options.database_path,
        scan_roots: options.scan_roots,
        quota_executable: options.quota_executable,
      },
    });
    const channel = new MessageChannel();
    this.worker.postMessage({ type: "connect", port: channel.port1 }, [channel.port1]);
    this.client = new BackendWorkerClient(channel.port2, { timeoutMs: options.timeoutMs });
    this.worker.once("error", () => {
      void this.stop();
    });
    this.worker.once("exit", (code) => {
      if (code !== 0) void this.stop();
    });
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
