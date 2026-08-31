import { WorkerRequest, WorkerResponse, BackendError, backendError } from "../contracts.js";
import type { MessagePort, Worker } from "node:worker_threads";

export interface BackendWorkerClientOptions {
  timeoutMs?: number;
  worker?: Worker;
}
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanup?: () => void;
};

export class BackendWorkerClient {
  private readonly pending = new Map<string, Pending>();
  private readonly timeoutMs: number;
  private readonly ownedWorker?: Worker;
  private closed = false;
  private sequence = 0;
  constructor(
    private readonly port: MessagePort,
    options: BackendWorkerClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.ownedWorker = options.worker;
    this.port.on("message", (value: unknown) => this.receive(value));
    this.port.on("close", () => this.failAll(backendError("INTERNAL", "Backend worker closed")));
    this.port.on("messageerror", () =>
      this.failAll(backendError("INTERNAL", "Backend worker message error")),
    );
    this.port.start();
  }

  request<T = unknown>(
    method: string,
    params?: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.closed) return Promise.reject(backendError("INTERNAL", "Backend worker is shut down"));
    const id = `${Date.now()}-${++this.sequence}`;
    const request = WorkerRequest.parse({
      id,
      method,
      ...(params === undefined ? {} : { params }),
    });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.cleanup?.();
        this.port.postMessage({ id: `${id}-cancel`, method: "__cancel", params: { id } });
        reject(backendError("TIMEOUT", `Backend method timed out: ${method}`));
      }, options.timeoutMs ?? this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      if (options.signal) {
        const cancel = () => {
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          clearTimeout(timer);
          this.port.postMessage({ id: `${id}-cancel`, method: "__cancel", params: { id } });
          reject(backendError("CANCELLED", "Backend operation cancelled"));
        };
        this.pending.get(id)!.cleanup = () => options.signal?.removeEventListener("abort", cancel);
        if (options.signal.aborted) {
          cancel();
          return;
        } else options.signal.addEventListener("abort", cancel, { once: true });
      }
      this.port.postMessage(request);
    });
  }

  handshake(): Promise<{
    protocolVersion: number;
    runtime: { name: string; version: string };
    pid: number;
  }> {
    return this.request("agentkib.handshake");
  }
  async shutdown(): Promise<void> {
    if (this.closed) return;
    try {
      await this.request("agentkib.shutdown", undefined, { timeoutMs: 5_000 });
    } finally {
      this.closed = true;
      this.port.close();
      await this.ownedWorker?.terminate();
    }
  }

  private receive(value: unknown): void {
    const parsed = WorkerResponse.safeParse(value);
    if (!parsed.success || !parsed.data.id) return;
    const pending = this.pending.get(parsed.data.id);
    if (!pending) return;
    this.pending.delete(parsed.data.id);
    clearTimeout(pending.timer);
    pending.cleanup?.();
    if (parsed.data.ok) pending.resolve(parsed.data.result);
    else
      pending.reject(
        new BackendError(
          parsed.data.error ?? { code: "INTERNAL", message: "Backend request failed" },
        ),
      );
  }
  private failAll(error: BackendError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.cleanup?.();
      pending.reject(error);
    }
    this.pending.clear();
  }
}
