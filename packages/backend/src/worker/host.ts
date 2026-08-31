import {
  WorkerNotification,
  WorkerRequest,
  WorkerResponse,
  BackendError,
  backendError,
} from "../contracts.js";
import type { MessagePort } from "node:worker_threads";

export type BackendMethod = (params: unknown, signal: AbortSignal) => unknown | Promise<unknown>;
export type BackendMethodRegistry =
  | ReadonlyMap<string, BackendMethod>
  | Record<string, BackendMethod>;
export interface BackendWorkerHostOptions {
  runtimeName?: string;
  runtimeVersion?: string;
  onShutdown?: () => void | Promise<void>;
}

function lookup(registry: BackendMethodRegistry, method: string): BackendMethod | undefined {
  return registry instanceof Map
    ? registry.get(method)
    : (registry as Record<string, BackendMethod>)[method];
}

export class BackendWorkerHost {
  private readonly active = new Map<string, AbortController>();
  private listening = false;
  constructor(
    private readonly port: MessagePort,
    private readonly registry: BackendMethodRegistry = {},
    private readonly options: BackendWorkerHostOptions = {},
  ) {}

  start(): void {
    if (this.listening) return;
    this.listening = true;
    this.port.on("message", (value: unknown) => {
      void this.handle(value);
    });
    this.port.start();
  }

  async shutdown(): Promise<void> {
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
    await this.options.onShutdown?.();
    this.port.close();
    this.listening = false;
  }

  private async handle(value: unknown): Promise<void> {
    const parsed = WorkerRequest.safeParse(value);
    if (!parsed.success) return;
    const request = parsed.data;
    if (request.method === "__cancel") {
      const id =
        typeof request.params === "object" && request.params !== null && "id" in request.params
          ? String(request.params.id)
          : "";
      this.active.get(id)?.abort();
      return;
    }
    const controller = new AbortController();
    this.active.set(request.id, controller);
    try {
      let result: unknown;
      if (request.method === "handshake" || request.method === "agentkib.handshake")
        result =
          request.method === "handshake"
            ? { protocol: 1, ready: true }
            : {
                protocolVersion: 1,
                runtime: {
                  name: this.options.runtimeName ?? "@agentkib/backend",
                  version: this.options.runtimeVersion ?? "0.5.0",
                },
                pid: process.pid,
              };
      else if (request.method === "shutdown" || request.method === "agentkib.shutdown") {
        result = { ok: true };
        this.reply({ id: request.id, ok: true, result });
        await this.shutdown();
        return;
      } else {
        const method = lookup(this.registry, request.method);
        if (!method) throw backendError("NOT_FOUND", `Unknown backend method: ${request.method}`);
        result = await method(request.params, controller.signal);
      }
      this.reply({ id: request.id, ok: true, result });
    } catch (error) {
      const normalized =
        error instanceof BackendError
          ? error
          : controller.signal.aborted
            ? backendError("CANCELLED", "Backend operation cancelled")
            : BackendError.from(error);
      this.reply({ id: request.id, ok: false, error: normalized.toJSON() });
    } finally {
      this.active.delete(request.id);
    }
  }

  private reply(response: WorkerResponse): void {
    this.port.postMessage(WorkerResponse.parse(response));
  }
  notify(notification: WorkerNotification): void {
    this.port.postMessage(WorkerNotification.parse(notification));
  }
}
