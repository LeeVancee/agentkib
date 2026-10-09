import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { stringify as stringifyToml } from "smol-toml";
import { stringify as stringifyYaml } from "yaml";
import type { Agent } from "./doctor-files";
import { safeTarget } from "./doctor-files";
import { pushChange, type ChangeSet, type FileChange } from "./change-plan";
import { effectiveMcp, mcpDocumentSchema, type McpServer } from "./mcp-config-read";
import type { McpManager } from "./mcp";
import type { NativeMcpCandidate, NativeMcpSnapshot } from "./mcp-native-scan";
import { readNativeMcpImports, scanNativeMcp } from "./mcp-native-scan";
import type { BackendStore } from "./store";
import { loadManifest } from "./manifest";
import { canonicalize, pathIdentity } from "./paths";
import { resolveWorkspaceIdentity } from "./workspace-identity";
import { hash } from "./doctor-files";
import { replaceNativeMcpServers } from "./mcp-native-document";

type JsonObject = Record<string, unknown>;

export async function planNativeMcpMigration(
  params: unknown,
  store: BackendStore,
  manager: McpManager,
  environment: NodeJS.ProcessEnv,
): Promise<ChangeSet> {
  const request = params as {
    project?: unknown;
    candidateIds?: unknown;
    mcpHubStatus?: unknown;
    collectedOnly?: unknown;
  } | null;
  if (!request || typeof request.project !== "string") throw new Error("Project is required");
  if (!Array.isArray(request.candidateIds) || request.candidateIds.length === 0)
    throw new Error("Select at least one native MCP candidate");
  if (!request.candidateIds.every((id) => typeof id === "string"))
    throw new Error("Candidate IDs must be strings");
  const candidateIds = request.candidateIds as string[];
  const uniqueIds = new Set(candidateIds);
  if (uniqueIds.size !== candidateIds.length) throw new Error("Duplicate native MCP candidate ID");

  const project = registeredProject(store, request.project);
  const candidates = scanNativeMcp({ project }, store, environment);
  const selected = candidateIds.map((id) => candidates.find((item) => item.id === id));
  if (selected.some((item) => !item)) throw new Error("Native MCP candidates changed; scan again");
  const chosen = selected as NativeMcpCandidate[];
  if (chosen.some((item) => !item.supported))
    throw new Error("Unsupported native MCP candidates cannot be migrated automatically");
  const imports = readNativeMcpImports(chosen, project).map((result) => {
    if ("error" in result) throw result.error;
    return result;
  });
  const sourceSnapshots = new Map(
    imports.map(({ candidate, snapshot }) => [candidate.source_path, snapshot]),
  );

  const hub = asObject(request.mcpHubStatus);
  if (
    !hub ||
    typeof hub.port !== "number" ||
    !Number.isInteger(hub.port) ||
    hub.port < 1 ||
    hub.port > 65535
  )
    throw new Error("MCP Hub settings are unavailable");
  const registration = store.sql
    .rows("SELECT id,canonical_path FROM workspaces")
    .filter((row) => pathIdentity(String(row.canonical_path)) === pathIdentity(project));
  if (registration.length !== 1) throw new Error("Workspace ownership is ambiguous");
  const registeredId = String(registration[0]!.id);
  const workspaceId =
    request.collectedOnly === true ? registeredId : loadManifest(project).workspace.id;
  const gateway = `http://127.0.0.1:${hub.port}/mcp/v1/workspaces/${encodeSegment(workspaceId)}/agents/{agent}`;
  const effective = effectiveMcp(project, environment);
  const effectiveFingerprint = hash(JSON.stringify(effective));
  const servers: McpServer[] = [];
  const serverIds = new Set<string>();
  for (const { candidate, snapshot, server: normalized } of imports) {
    if (request.collectedOnly === true) {
      const matching = effective.filter(
        (item) =>
          item.native_source?.candidate_id === candidate.id &&
          item.native_source.agent === candidate.agent,
      );
      if (matching.length !== 1)
        throw new Error(`Collect this exact native definition before migration: ${candidate.name}`);
      const collected = matching[0]!;
      if (collected.native_source?.fingerprint !== normalized.native_source?.fingerprint)
        throw new Error("Native source changed since collection; collect and review again");
      const connection = (server: McpServer) =>
        server.transport === "stdio"
          ? [server.transport, server.command, server.args, server.cwd ?? null]
          : [server.transport, server.url];
      if (JSON.stringify(connection(collected)) !== JSON.stringify(connection(normalized)))
        throw new Error("Collected MCP connection differs from its native source");
      if (
        !collected.enabled ||
        (collected.targets.length && !collected.targets.includes(candidate.agent))
      )
        throw new Error(`Enable the collected server for ${candidate.agent} before migration`);
      if (
        normalized.required_env?.some((key) => !Object.hasOwn(collected.env, key)) ||
        normalized.required_headers?.some((key) => !Object.hasOwn(collected.headers, key))
      )
        throw new Error("Enter all required private values before migration");
      if (JSON.stringify(collected.allow_tools) !== JSON.stringify(normalized.allow_tools))
        throw new Error("Native and collected tool allow lists differ; review before migration");
      assertMigrationGateway(candidate, snapshot, store, registeredId);
      if (!manager.hasCurrentProbe(collected.id, project))
        throw new Error("Probe the current collected configuration before migration");
      servers.push(collected);
      continue;
    }
    const server = migrationServer(candidate, snapshot, normalized);
    if (!server.id)
      throw new Error(`Native MCP server name cannot be converted to an ID: ${candidate.name}`);
    if (serverIds.has(server.id))
      throw new Error(`Selected native MCP servers map to the same AgentKib ID: ${server.id}`);
    serverIds.add(server.id);
    if (server.transport === "sse")
      throw new Error("Legacy SSE server must be converted before migration");
    if (candidate.has_secret_values) {
      const entered = effective.find(
        (item) =>
          item.name === candidate.name &&
          (Object.keys(item.env).length > 0 ||
            Object.keys(item.headers).length > 0 ||
            item.oauth_credentials != null),
      );
      if (!entered)
        throw new Error(
          `Re-enter local secret values and probe \`${candidate.name}\` before removing its native configuration`,
        );
      server.env = entered.env;
      server.headers = entered.headers;
      server.oauth_credentials = entered.oauth_credentials;
    }
    await manager.probeConfig(server);
    servers.push(server);
  }

  // Probes may yield to external edits or switch the selected native profile.
  // This new scan checks every source once; never reuse the pre-probe snapshot.
  const currentCandidates = scanNativeMcp({ project }, store, environment);
  if (
    imports.some(
      ({ candidate, snapshot }) =>
        !currentCandidates.some(
          (current) =>
            current.id === candidate.id &&
            current.agent === candidate.agent &&
            current.supported &&
            current.fingerprint === snapshot.fingerprint,
        ),
    ) ||
    (request.collectedOnly === true &&
      (hash(JSON.stringify(effectiveMcp(project, environment))) !== effectiveFingerprint ||
        resolveWorkspaceIdentity(store, registeredId).project !== project))
  )
    throw new Error("MCP source, workspace, or collected configuration changed during probe");

  const configPath = path.join(project, ".agentkib/mcp.json");
  if (!safeTarget(project, configPath)) throw new Error(`Unsafe MCP config path: ${configPath}`);
  const before = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const parsed = before.trim()
    ? mcpDocumentSchema.parse(JSON.parse(before))
    : mcpDocumentSchema.parse({ schema_version: 1, servers: [] });
  for (const server of servers) {
    const publicServer = { ...server, env: {}, headers: {}, oauth_credentials: undefined };
    const index = parsed.servers.findIndex((item) => item.id === publicServer.id);
    if (index < 0) parsed.servers.push(publicServer);
    else parsed.servers[index] = publicServer;
  }
  parsed.servers.sort((left, right) => left.name.localeCompare(right.name));
  const changes: FileChange[] = [];
  const publicJson = JSON.stringify(parsed, null, 2) + "\n";
  if (request.collectedOnly !== true && before !== publicJson)
    pushChange(changes, configPath, publicJson, "project", "medium", "json");

  const bySource = new Map<string, NativeMcpCandidate[]>();
  for (const candidate of chosen) {
    const group = bySource.get(candidate.source_path) ?? [];
    group.push(candidate);
    bySource.set(candidate.source_path, group);
  }
  for (const [source, sourceCandidates] of [...bySource].sort(([a], [b]) => a.localeCompare(b))) {
    const snapshot = sourceSnapshots.get(source)!,
      sourceBefore = snapshot.content;
    if (readFileSync(source, "utf8") !== sourceBefore)
      throw new Error("Native source changed during migration planning; scan again");
    const sourceAfter = rewriteSource(snapshot, sourceCandidates, gateway);
    if (sourceBefore === sourceAfter) continue;
    const inProject = isWithin(source, project);
    if (inProject && !safeTarget(project, source))
      throw new Error(`Unsafe native MCP config path: ${source}`);
    pushChange(
      changes,
      source,
      sourceAfter,
      inProject ? "project" : "agent-home",
      inProject ? "medium" : "high",
      validatorFor(source),
    );
    const change = changes.at(-1)!;
    change.before = sourceBefore;
    change.original_hash = hash(sourceBefore);
  }
  if (
    request.collectedOnly === true &&
    (hash(JSON.stringify(effectiveMcp(project, environment))) !== effectiveFingerprint ||
      resolveWorkspaceIdentity(store, registeredId).project !== project ||
      [...sourceSnapshots].some(
        ([file, snapshot]) => readFileSync(file, "utf8") !== snapshot.content,
      ))
  )
    throw new Error("MCP source or configuration changed while planning migration");
  return {
    id: randomUUID(),
    project_root: project,
    created_at: new Date().toISOString(),
    requires_home_approval: changes.some((item) => item.scope === "agent-home"),
    changes,
  };
}

function assertMigrationGateway(
  candidate: NativeMcpCandidate,
  snapshot: NativeMcpSnapshot,
  store: BackendStore,
  registeredId: string,
): void {
  const container = snapshot.servers;
  if (!container || !Object.hasOwn(container, "agentkib")) return;
  try {
    const gateway = asObject(container.agentkib);
    if (!gateway) throw new Error("invalid gateway entry");
    const raw = gateway.url ?? gateway.serverUrl;
    if (typeof raw !== "string") throw new Error("missing URL");
    const url = new URL(raw),
      parts = url.pathname.match(/^\/mcp\/v1\/workspaces\/([^/]+)\/agents\/([^/]+)$/);
    if (
      url.protocol !== "http:" ||
      !["localhost", "127.0.0.1"].includes(url.hostname) ||
      !url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !parts ||
      parts[2] !== candidate.agent ||
      resolveWorkspaceIdentity(store, decodeURIComponent(parts[1]!)).registeredId !== registeredId
    )
      throw new Error("wrong binding");
    if (gateway.disabled === true || gateway.enabled === false) throw new Error("disabled gateway");
    if (
      Object.keys(gateway).some(
        (key) => !["url", "serverUrl", "transport", "type", "enabled", "disabled"].includes(key),
      )
    )
      throw new Error("custom gateway settings");
  } catch {
    throw new Error(
      "Existing agentkib connection needs explicit connection repair or rebinding before migration",
    );
  }
}

function migrationServer(
  candidate: NativeMcpCandidate,
  snapshot: NativeMcpSnapshot,
  normalized: McpServer,
): McpServer {
  const container = snapshot.servers;
  const raw = asObject(container?.[candidate.name]);
  if (!raw) throw new Error(`Native MCP candidate no longer exists: ${candidate.name}`);
  let transport: JsonObject;
  if (candidate.agent === "opencode") {
    if (raw.type === "remote") {
      if (typeof raw.url !== "string") throw new Error("OpenCode MCP URL is missing");
      if (raw.oauth !== undefined)
        throw new Error("OpenCode OAuth configuration cannot be migrated automatically");
      transport = { transport: "streamable-http", url: raw.url };
    } else if (
      raw.type === "local" &&
      Array.isArray(raw.command) &&
      raw.command.every((part) => typeof part === "string") &&
      raw.command.length
    ) {
      const [command, ...args] = raw.command as string[];
      transport = { transport: "stdio", command: command!, args };
    } else throw new Error("Unsupported OpenCode MCP configuration");
  } else {
    const url = string(raw.url) ?? string(raw.serverUrl);
    if (url) {
      const type = string(raw.transport) ?? string(raw.type);
      transport =
        type === "sse" ? { transport: "sse", url } : { transport: "streamable-http", url };
    } else {
      const command = string(raw.command);
      if (!command) throw new Error("Native MCP command is missing");
      transport = {
        transport: "stdio",
        command,
        args: strings(raw.args),
        ...(string(raw.cwd) ? { cwd: string(raw.cwd)! } : {}),
      };
    }
  }
  if (transport.transport === "stdio") {
    if (normalized.transport !== "stdio") throw new Error("Native MCP transport changed");
    transport.cwd = normalized.cwd;
  }
  const id = candidate.name
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .toLowerCase()
    .replace(/^-+|-+$/g, "");
  const server = mcpDocumentSchema.parse({
    schema_version: 1,
    servers: [
      {
        id,
        name: candidate.name,
        enabled: candidate.agent === "opencode" ? raw.enabled !== false : true,
        ...transport,
        env: candidate.agent === "opencode" ? stringMap(raw.environment) : {},
        headers: stringMap(raw.headers),
        targets: [candidate.agent],
        allow_tools:
          candidate.agent === "codex" || candidate.agent === "grok-build"
            ? strings(raw.enabled_tools)
            : candidate.agent === "antigravity"
              ? antigravityTools(raw)
              : [],
        lan_allow_tools: [],
        supports_parallel_tool_calls: false,
      },
    ],
  }).servers[0];
  if (!server) throw new Error("Native MCP configuration could not be converted");
  return server;
}

function rewriteSource(
  snapshot: NativeMcpSnapshot,
  candidates: NativeMcpCandidate[],
  gateway: string,
): string {
  const agent = candidates[0]?.agent;
  if (!agent || candidates.some((candidate) => candidate.agent !== agent))
    throw new Error("Native MCP source contains inconsistent Agent types");
  const names = new Set(candidates.map((candidate) => candidate.name));
  const { format, root, servers: originalServers } = snapshot;
  if (!originalServers)
    throw new Error(
      format === "toml"
        ? "TOML mcp_servers table is missing"
        : "Native MCP server object is missing",
    );
  // YAML anchors may share this map with unrelated settings. Edit an isolated
  // container, then replace only the MCP path instead of mutating those aliases.
  const servers = { ...originalServers },
    value = replaceNativeMcpServers(root, agent, servers);
  if (format === "toml") {
    for (const name of names) delete servers[name];
    delete servers.agentkib;
    const output = stringifyToml(value).replace(/\n*$/, "\n");
    return `${output}\n# agentkib:managed:start\n[mcp_servers.agentkib]\nurl = ${JSON.stringify(gatewayFor(gateway, agent))}\n# agentkib:managed:end\n`;
  }
  for (const name of names) delete servers[name];
  const url = gatewayFor(gateway, agent);
  const gatewayEntry: JsonObject = { url };
  if (agent === "claude-code") gatewayEntry.type = "http";
  if (agent === "open-claw") gatewayEntry.transport = "streamable-http";
  if (agent === "opencode") Object.assign(gatewayEntry, { type: "remote", enabled: true });
  if (agent === "antigravity") {
    delete gatewayEntry.url;
    gatewayEntry.serverUrl = url;
    const existing = asObject(servers.agentkib);
    if (
      existing &&
      JSON.stringify(existing) !== JSON.stringify(gatewayEntry) &&
      !isPriorAntigravityGateway(existing, url)
    )
      throw new Error(
        "Antigravity MCP `agentkib` entry is not the planned gateway; reconcile it before migrating other servers",
      );
  }
  servers.agentkib = gatewayEntry;
  if (format === "yaml") return stringifyYaml(value);
  return JSON.stringify(value, null, 2) + "\n";
}

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}
function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
function stringMap(value: unknown): Record<string, string> {
  const object = asObject(value);
  return object
    ? Object.fromEntries(
        Object.entries(object).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : {};
}
function antigravityTools(server: JsonObject): string[] {
  if (server.disabled === true) return [];
  if (server.enabledTools === undefined) return [];
  const enabled = strings(server.enabledTools);
  const disabled = new Set(strings(server.disabledTools));
  return enabled.filter((tool) => !disabled.has(tool));
}
function gatewayFor(template: string, agent: Agent): string {
  return template.replace("{agent}", agent);
}
function isPriorAntigravityGateway(existing: JsonObject, plannedUrl: string): boolean {
  if (
    !Object.keys(existing).every((key) => key === "serverUrl" || key === "disabled") ||
    (existing.disabled !== undefined && existing.disabled !== false) ||
    typeof existing.serverUrl !== "string"
  )
    return false;
  try {
    const oldUrl = new URL(existing.serverUrl);
    const newUrl = new URL(plannedUrl);
    const workspace = newUrl.pathname
      .replace(/^\/mcp\/v1\/workspaces\//, "")
      .replace(/\/agents\/antigravity$/, "");
    return (
      newUrl.pathname.endsWith("/agents/antigravity") &&
      workspace.length > 0 &&
      !workspace.includes("/") &&
      oldUrl.protocol === "http:" &&
      newUrl.protocol === "http:" &&
      (oldUrl.hostname === "127.0.0.1" || oldUrl.hostname === "localhost") &&
      oldUrl.hostname === newUrl.hostname &&
      Boolean(oldUrl.port) &&
      Boolean(newUrl.port) &&
      !oldUrl.username &&
      !oldUrl.password &&
      !oldUrl.search &&
      !oldUrl.hash &&
      !newUrl.username &&
      !newUrl.password &&
      !newUrl.search &&
      !newUrl.hash &&
      oldUrl.pathname === newUrl.pathname
    );
  } catch {
    return false;
  }
}
function encodeSegment(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
function registeredProject(store: BackendStore, value: string): string {
  const project = canonicalize(value);
  if (
    !store.sql
      .rows("SELECT canonical_path FROM workspaces")
      .some((row) => pathIdentity(String(row.canonical_path)) === pathIdentity(project))
  )
    throw new Error("MCP project scope must be a registered AgentKib workspace");
  return project;
}
function isWithin(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}
function validatorFor(source: string): string {
  if (/\.toml$/i.test(source)) return "toml";
  if (/\.ya?ml$/i.test(source)) return "yaml";
  return "json";
}
