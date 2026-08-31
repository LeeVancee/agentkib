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
      if ((key === "env" || key === "headers") && item && typeof item === "object") {
        return [
          key,
          Object.fromEntries(
            Object.entries(item).map(([name, secret]) => [
              name,
              typeof secret === "string" && secret.length > 0 ? "[REDACTED]" : secret,
            ]),
          ),
        ];
      }
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
  if (path.basename(file) === "mcp.local.json" && path.basename(path.dirname(file)) === ".agentkib") {
    const ignoreFile = path.join(path.dirname(file), ".gitignore");
    const existing = await readFile(ignoreFile, "utf8").catch(() => "");
    if (!existing.split(/\r?\n/).some((line) => line.trim() === "mcp.local.json")) {
      await writeFile(ignoreFile, `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}mcp.local.json\n`, { mode: 0o600 });
    }
  }
}
export function localMcpConfigPath(file: string): string {
  return path.join(path.dirname(file), "mcp.local.json");
}
export async function loadEffectiveMcpConfig(file: string): Promise<McpConfig> {
  const publicConfig = await loadMcpConfig(file);
  const privateConfig = await loadMcpConfig(localMcpConfigPath(file));
  const localById = new Map(privateConfig.servers.map((server) => [server.id, server]));
  const servers = publicConfig.servers.map((server) => {
    const local = localById.get(server.id);
    if (!local) return server;
    return {
      ...server,
      enabled: local.enabled,
      allow_tools: local.allow_tools.length ? local.allow_tools : server.allow_tools,
      lan_allow_tools: local.lan_allow_tools.length ? local.lan_allow_tools : server.lan_allow_tools,
      targets: local.targets.length ? local.targets : server.targets,
      transport:
        server.transport.transport === "stdio" && local.transport.transport === "stdio"
          ? { ...server.transport, env: local.transport.env, cwd: local.transport.cwd ?? server.transport.cwd }
          : server.transport.transport !== "stdio" && local.transport.transport !== "stdio"
            ? { ...server.transport, headers: local.transport.headers }
            : server.transport,
    };
  });
  for (const local of privateConfig.servers) {
    if (!publicConfig.servers.some((server) => server.id === local.id)) servers.push(local);
  }
  return { ...publicConfig, servers };
}
export async function saveMcpLocalValues(
  file: string,
  serverId: string,
  env: Record<string, string>,
  headers: Record<string, string>,
): Promise<McpServer> {
  const effective = await loadEffectiveMcpConfig(file);
  const server = effective.servers.find((item) => item.id === serverId);
  if (!server) throw backendError("NOT_FOUND", `MCP server not found: ${serverId}`);
  const localFile = localMcpConfigPath(file);
  const local = await loadMcpConfig(localFile);
  const privateServer: McpServer = {
    ...server,
    transport:
      server.transport.transport === "stdio"
        ? { ...server.transport, env }
        : { ...server.transport, headers },
  };
  await saveMcpConfig(localFile, {
    ...local,
    servers: [...local.servers.filter((item) => item.id !== serverId), privateServer],
  });
  return maskSecrets(privateServer) as McpServer;
}
export async function listMcpServers(file: string): Promise<McpServer[]> {
  return (await loadEffectiveMcpConfig(file)).servers.map((server) => maskSecrets(server) as McpServer);
}
export async function getMcpServer(file: string, id: string): Promise<McpServer> {
  const server = (await loadEffectiveMcpConfig(file)).servers.find((item) => item.id === id);
  if (!server) throw backendError("NOT_FOUND", `MCP server not found: ${id}`);
  return maskSecrets(server) as McpServer;
}
export async function removeMcpServer(file: string, id: string): Promise<void> {
  const config = await loadMcpConfig(file);
  const localFile = localMcpConfigPath(file);
  const local = await loadMcpConfig(localFile);
  if (!config.servers.some((server) => server.id === id) && !local.servers.some((server) => server.id === id))
    throw backendError("NOT_FOUND", `MCP server not found: ${id}`);
  if (config.servers.some((server) => server.id === id))
    await saveMcpConfig(file, { ...config, servers: config.servers.filter((server) => server.id !== id) });
  if (local.servers.some((server) => server.id === id))
    await saveMcpConfig(localFile, { ...local, servers: local.servers.filter((server) => server.id !== id) });
}
