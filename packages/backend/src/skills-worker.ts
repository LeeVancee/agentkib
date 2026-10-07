import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BackendTaskError,
  BoundedTaskQueue,
  type TaskContext,
  type TaskWorkspace,
} from "./task-executor";

type Workspace = { id: string; path: string };
export function skillWorkspaces(values: unknown[]): Workspace[] {
  return values.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const row = value as Record<string, unknown>;
    return typeof row.id === "string" && typeof row.path === "string"
      ? [{ id: row.id, path: row.path }]
      : [];
  });
}
type Pending = { task: TaskContext; resolve(value: unknown): void; reject(error: Error): void };

/** Skills state, scans and hashing live in one worker; only its bounded admission queue lives here. */
export class SkillsWorker {
  readonly #worker: Worker;
  readonly #queue: BoundedTaskQueue;
  #pending?: Pending;
  #failure?: BackendTaskError;
  #closing?: Promise<void>;
  constructor(
    environment: NodeJS.ProcessEnv,
    dataDir: string,
    readonly workspaces: () => unknown[],
    options: { filename?: string; timeoutMs?: number } = {},
  ) {
    const directory =
      typeof __dirname === "string" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
    this.#queue = new BoundedTaskQueue({ name: "Skills", timeoutMs: options.timeoutMs });
    this.#worker = new Worker(options.filename ?? path.join(directory, "backend-skills.cjs"), {
      workerData: { environment, dataDir },
    });
    this.#worker.on("message", (message: unknown) => this.#message(message));
    this.#worker.on("error", () => this.#failed());
    this.#worker.on("exit", () => {
      if (!this.#closing || this.#pending) this.#failed();
    });
  }
  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.#failure) return Promise.reject(this.#failure);
    return this.#queue.run(
      (task) =>
        new Promise((resolve, reject) => {
          if (this.#failure) {
            reject(this.#failure);
            return;
          }
          const cancel = () =>
            this.#worker.postMessage({
              type: "cancel",
              id: task.id,
              reason:
                task.signal.reason instanceof BackendTaskError
                  ? task.signal.reason.reason
                  : "backend-closing",
            });
          this.#pending = {
            task,
            resolve: (value) => {
              task.signal.removeEventListener("abort", cancel);
              resolve(value);
            },
            reject: (error) => {
              task.signal.removeEventListener("abort", cancel);
              reject(error);
            },
          };
          task.signal.addEventListener("abort", cancel, { once: true });
          try {
            task.checkpoint();
            this.#worker.postMessage({
              type: "run",
              id: task.id,
              deadlineAt: task.deadlineAt,
              method,
              params,
              workspaces: skillWorkspaces(this.workspaces()),
            });
          } catch (error) {
            this.#pending = undefined;
            task.signal.removeEventListener("abort", cancel);
            reject(error);
          }
        }),
    );
  }
  #message(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const message = value as Record<string, unknown>;
    const pending = this.#pending;
    if (!pending || message.id !== pending.task.id) return;
    if (message.type === "verify-workspace") {
      const scope = message.scope as TaskWorkspace | undefined;
      let valid = false;
      try {
        valid = Boolean(
          scope &&
          skillWorkspaces(this.workspaces()).some(
            (workspace) =>
              workspace.id === scope.workspaceId && workspace.path === scope.workspacePath,
          ),
        );
      } catch {
        /* Missing ownership is not permission to write the old target. */
      }
      this.#worker.postMessage({
        type: "workspace-result",
        id: pending.task.id,
        checkId: message.checkId,
        valid,
      });
      return;
    }
    if (message.type === "result") {
      this.#pending = undefined;
      pending.resolve(message.result);
    } else if (message.type === "error") {
      this.#pending = undefined;
      const detail =
        typeof message.message === "string" ? message.message : "Skill operation failed";
      pending.reject(
        message.reason === "deadline-exceeded" || message.reason === "backend-closing"
          ? new BackendTaskError(message.reason, detail)
          : new Error(detail),
      );
    }
  }
  #failed(): void {
    this.#failure ??= new BackendTaskError(
      "worker-failed",
      "Skill worker stopped; the operation was not replayed. Check local state before a new operation.",
    );
    this.#queue.stop();
    const pending = this.#pending;
    this.#pending = undefined;
    pending?.reject(this.#failure);
  }
  stop(): void {
    this.#queue.stop();
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.stop();
    this.#closing = (async () => {
      await this.#queue.drain();
      // No producer or writer remains. Closing the port lets the worker exit normally.
      if (!this.#failure) {
        const exited = new Promise<void>((resolve) => this.#worker.once("exit", () => resolve()));
        this.#worker.postMessage({ type: "close" });
        await exited;
      }
    })();
    return this.#closing;
  }
}
