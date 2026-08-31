import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { BackendError, backendError } from "../contracts.js";
export const StdioTransport = z
  .object({
    transport: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    cwd: z.string().optional(),
  })
  .passthrough();
export const HttpTransport = z
  .object({
    transport: z.enum(["streamable-http", "sse"]),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).default({}),
  })
  .passthrough();
export const McpServer = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    enabled: z.boolean().default(true),
    allow_tools: z.array(z.string()).default([]),
    lan_allow_tools: z.array(z.string()).default([]),
    targets: z.array(z.string()).default([]),
    transport: z.discriminatedUnion("transport", [StdioTransport, HttpTransport]),
  })
  .passthrough();
export const McpConfig = z
  .object({ schema_version: z.number().int().default(1), servers: z.array(McpServer).default([]) })
  .passthrough()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    for (const [index, server] of value.servers.entries()) {
      if (ids.has(server.id))
        context.addIssue({
          code: "custom",
          path: ["servers", index, "id"],
          message: "MCP server ids must be unique",
        });
      ids.add(server.id);
    }
  });
export type McpServer = z.infer<typeof McpServer>;
export type McpConfig = z.infer<typeof McpConfig>;
export function maskSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      const secret = /token|secret|password|api[_-]?key|authorization|cookie/i.test(key);
      return [key, secret ? "[REDACTED]" : maskSecrets(item)];
    }),
  );
}
export async function loadMcpConfig(file: string): Promise<McpConfig> {
  try {
    return McpConfig.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return McpConfig.parse({});
    if (error instanceof BackendError) throw error;
    throw backendError("VALIDATION", "MCP config is invalid");
  }
}
export async function saveMcpConfig(file: string, config: McpConfig): Promise<void> {
  const parsed = McpConfig.parse(config);
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, JSON.stringify(parsed, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, file);
}
export async function listMcpServers(file: string): Promise<McpServer[]> {
  return (await loadMcpConfig(file)).servers.map((server) => maskSecrets(server) as McpServer);
}
export async function getMcpServer(file: string, id: string): Promise<McpServer> {
  const server = (await loadMcpConfig(file)).servers.find((item) => item.id === id);
  if (!server) throw backendError("NOT_FOUND", `MCP server not found: ${id}`);
  return maskSecrets(server) as McpServer;
}
export async function removeMcpServer(file: string, id: string): Promise<void> {
  const config = await loadMcpConfig(file);
  if (!config.servers.some((server) => server.id === id))
    throw backendError("NOT_FOUND", `MCP server not found: ${id}`);
  await saveMcpConfig(file, {
    ...config,
    servers: config.servers.filter((server) => server.id !== id),
  });
}
