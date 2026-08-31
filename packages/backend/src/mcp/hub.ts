import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createHash } from "node:crypto";
import { createMcpProbe } from "./transport.js";
import { McpServer } from "./config.js";
import { BackendError, backendError } from "../contracts.js";
export interface McpRuntimeStatus {
  server_id: string;
  server_name?: string;
  config_hash?: string;
  state: "stopped" | "starting" | "running" | "error";
  started_at?: string;
  last_used_at?: string;
  error?: string;
}
export interface McpToolDescriptor {
  name: string;
  description?: string;
  input_schema: unknown;
  server_id: string;
}
export class McpRuntimeHub {
  private readonly runtimes = new Map<
    string,
    {
      server: McpServer;
      client: Client;
      transport: ReturnType<typeof createMcpProbe>["transport"];
      status: McpRuntimeStatus;
    }
  >();
  private readonly idleTimer: NodeJS.Timeout;
  constructor(private readonly timeoutMs = 15_000) {
    // Match the native runtime's 15 minute idle reaper so stdio children do not
    // survive indefinitely when a workspace is left open.
    this.idleTimer = setInterval(() => void this.reapIdle(), 60_000);
    this.idleTimer.unref();
  }
  status(serverId?: string): McpRuntimeStatus[] {
    const values = [...this.runtimes.values()].map((runtime) => runtime.status);
    return serverId ? values.filter((value) => value.server_id === serverId) : values;
  }
  async start(serverInput: McpServer, signal?: AbortSignal): Promise<McpRuntimeStatus> {
    const server = McpServer.parse(serverInput);
    const existing = this.runtimes.get(server.id);
    if (existing?.status.state === "running") return existing.status;
    const probe = createMcpProbe(server);
    const status: McpRuntimeStatus = {
      server_id: server.id,
      server_name: server.name,
      config_hash: hashServer(server),
      state: "starting",
    };
    this.runtimes.set(server.id, {
      server,
      client: probe.client,
      transport: probe.transport,
      status,
    });
    try {
      await this.withTimeout(probe.client.connect(probe.transport), signal);
      status.state = "running";
      status.started_at = new Date().toISOString();
      return status;
    } catch (error) {
      status.state = "error";
      status.error = error instanceof BackendError ? error.message : "MCP server connection failed";
      await probe.transport.close().catch(() => undefined);
      throw error instanceof BackendError
        ? error
        : backendError(signal?.aborted ? "CANCELLED" : "IO", status.error);
    }
  }
  async listTools(serverInput: McpServer, signal?: AbortSignal): Promise<McpToolDescriptor[]> {
    const server = McpServer.parse(serverInput);
    await this.start(server, signal);
    const runtime = this.runtimes.get(server.id);
    if (!runtime) throw backendError("INTERNAL", "MCP runtime unavailable");
    try {
      const result = await this.withTimeout(runtime.client.listTools(), signal);
      runtime.status.last_used_at = new Date().toISOString();
      return (result.tools ?? [])
        .filter((tool) => !server.allow_tools.length || server.allow_tools.includes(tool.name))
        .map((tool) => ({
          server_id: server.id,
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema,
        }));
    } catch (error) {
      throw error instanceof BackendError
        ? error
        : backendError(signal?.aborted ? "CANCELLED" : "IO", "MCP tool listing failed");
    }
  }
  async stop(serverId: string): Promise<void> {
    const runtime = this.runtimes.get(serverId);
    if (!runtime) return;
    await runtime.client.close().catch(() => undefined);
    await runtime.transport.close().catch(() => undefined);
    runtime.status.state = "stopped";
    this.runtimes.delete(serverId);
  }
  async shutdown(): Promise<void> {
    clearInterval(this.idleTimer);
    await Promise.all([...this.runtimes.keys()].map((id) => this.stop(id)));
  }
  private async reapIdle(): Promise<void> {
    const cutoff = Date.now() - 15 * 60_000;
    for (const [id, runtime] of this.runtimes) {
      const last = runtime.status.last_used_at ?? runtime.status.started_at;
      if (last && Date.parse(last) < cutoff) await this.stop(id);
    }
  }
  private async withTimeout<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw backendError("CANCELLED", "MCP operation cancelled");
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(backendError("TIMEOUT", "MCP operation timed out")),
        this.timeoutMs,
      );
      const cancel = () => {
        clearTimeout(timer);
        reject(backendError("CANCELLED", "MCP operation cancelled"));
      };
      signal?.addEventListener("abort", cancel, { once: true });
      promise.then(
        (value) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancel);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancel);
          reject(error);
        },
      );
    });
  }
}

function hashServer(server: McpServer): string {
  return createHash("sha256").update(JSON.stringify(server)).digest("hex");
}
