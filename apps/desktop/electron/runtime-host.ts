import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import {
  PROTOCOL_VERSION,
  RUNTIME_METHODS,
  type RuntimeHandshakeResult,
  type RuntimeRpcError,
} from "./generated/runtime-protocol";

const HEALTHY_RUNTIME_RESET_MS = 30_000;

interface RuntimeHostOptions {
  executablePath: string;
  clientVersion: string;
  environment?: NodeJS.ProcessEnv;
  maxRestarts?: number;
  shutdownTimeoutMs?: number;
}

interface RpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: RuntimeRpcError;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class RuntimeRequestError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(error: RuntimeRpcError) {
    const detail =
      typeof error.data === "object" &&
      error.data !== null &&
      "detail" in error.data &&
      typeof error.data.detail === "string"
        ? error.data.detail
        : undefined;
    super(detail ? `${error.message}: ${detail}` : error.message);
    this.name = "RuntimeRequestError";
    this.code = error.code;
    this.data = error.data;
  }
}

export class DesktopRuntimeHost extends EventEmitter {
  readonly #options: Required<Pick<RuntimeHostOptions, "maxRestarts" | "shutdownTimeoutMs">> &
    Omit<RuntimeHostOptions, "maxRestarts" | "shutdownTimeoutMs">;
  readonly #pending = new Map<number, PendingRequest>();
  #child?: ChildProcessWithoutNullStreams;
  #nextRequestId = 1;
  #restartCount = 0;
  #lastReadyAt = 0;
  #restartTimer?: NodeJS.Timeout;
  #stopping = false;

  constructor(options: RuntimeHostOptions) {
    super();
    this.#options = {
      maxRestarts: 3,
      shutdownTimeoutMs: 2_000,
      ...options,
    };
  }

  async start(): Promise<RuntimeHandshakeResult> {
    if (this.#child) throw new Error("AgentKib runtime is already running");
    this.#stopping = false;
    this.#restartCount = 0;
    this.#lastReadyAt = 0;
    return this.#spawnAndHandshake();
  }

  async request<TResult>(method: string, params: unknown): Promise<TResult> {
    const child = this.#child;
    if (!child || child.exitCode !== null) throw new Error("AgentKib runtime is not running");

    const id = this.#nextRequestId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });

    return new Promise<TResult>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      child.stdin.write(`${payload}\n`, (error) => {
        if (!error) return;
        this.#pending.delete(id);
        reject(error);
      });
    });
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#restartTimer) clearTimeout(this.#restartTimer);

    const child = this.#child;
    if (!child || child.exitCode !== null) return;

    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      await this.request(RUNTIME_METHODS.shutdown, {});
    } catch {
      // An already-failed runtime still needs the bounded termination path below.
    }

    await Promise.race([exited, delay(this.#options.shutdownTimeoutMs)]);
    if (child.exitCode === null) child.kill();
  }

  async #spawnAndHandshake(): Promise<RuntimeHandshakeResult> {
    const child = spawn(this.#options.executablePath, [], {
      env: { ...process.env, ...this.#options.environment },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child = child;

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => process.stderr.write(`[agentkib-runtime] ${chunk}`));

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.#handleLine(line));
    child.once("exit", (code, signal) => this.#handleExit(child, code, signal));

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });

    const handshake = await this.request<RuntimeHandshakeResult>(RUNTIME_METHODS.handshake, {
      protocolVersion: PROTOCOL_VERSION,
      client: { name: "agentkib-electron", version: this.#options.clientVersion },
    });
    if (handshake.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(
        `Runtime returned protocol ${handshake.protocolVersion}; expected ${PROTOCOL_VERSION}`,
      );
    }

    this.#lastReadyAt = Date.now();
    this.emit("ready", handshake);
    return handshake;
  }

  #handleLine(line: string): void {
    let message: RpcResponse & { method?: string; params?: unknown };
    try {
      message = JSON.parse(line) as RpcResponse & { method?: string; params?: unknown };
    } catch (error) {
      this.emit("protocol-error", new Error(`Invalid runtime JSON: ${String(error)}`));
      return;
    }

    if (typeof message.id !== "number") {
      if (message.method) this.emit("notification", message.method, message.params);
      return;
    }

    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (message.error) pending.reject(new RuntimeRequestError(message.error));
    else pending.resolve(message.result);
  }

  #handleExit(
    child: ChildProcessWithoutNullStreams,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.#child !== child) return;
    this.#child = undefined;
    const error = new Error(
      `AgentKib runtime exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}`,
    );
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.emit("exit", { code, signal, expected: this.#stopping });

    if (this.#lastReadyAt > 0 && Date.now() - this.#lastReadyAt >= HEALTHY_RUNTIME_RESET_MS) {
      this.#restartCount = 0;
    }
    this.#lastReadyAt = 0;

    if (this.#stopping || this.#restartCount >= this.#options.maxRestarts) {
      if (!this.#stopping) this.emit("crash-loop", error);
      return;
    }

    const backoffMs = 250 * 2 ** this.#restartCount;
    this.#restartCount += 1;
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined;
      void this.#spawnAndHandshake().catch((restartError: unknown) => {
        this.emit("restart-error", restartError);
      });
    }, backoffMs);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
