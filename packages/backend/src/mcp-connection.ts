import { randomUUID } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import JSON5 from "json5";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import {
  isAlias,
  isMap,
  isNode,
  isScalar,
  parseDocument,
  stringify as stringifyYaml,
  visit,
  type Alias,
  type Document,
  type Node,
  type YAMLMap,
} from "yaml";
import { z } from "zod";
import { pushChange, type ChangeSet } from "./change-plan";
import {
  connectionJson,
  finiteJson,
  managedConfigPath,
  sortedJson,
  type Connection,
} from "./config-merge";
import { hash, safeTarget } from "./doctor-files";
import { canonicalProject, readText } from "./files";
import { BUILTIN_MCP_TOOLS } from "./mcp-builtin";
import { userHome } from "./mcp-config-read";
import { manifestPath, parseManifest } from "./manifest";
import type { BackendStore } from "./store";
import { utcNow } from "./workspaces";

export const MCP_CONNECTION_AGENTS = [
  "codex",
  "claude-code",
  "cursor",
  "opencode",
  "open-claw",
  "hermes",
  "grok-build",
  "antigravity",
] as const;
export type McpConnectionAgent = (typeof MCP_CONNECTION_AGENTS)[number];
type ObjectValue = Record<string, unknown>;
type WorkspaceStore = Pick<BackendStore, "getWorkspace">;
type HubStatus = { running: boolean; port: number };
export interface McpConnectionInfo {
  workspace_id: string;
  target_agent: McpConnectionAgent;
  url: string;
  config: string;
  target: string;
  format: "json" | "toml" | "yaml";
  scope: "project" | "agent-home";
  hub_running: boolean;
}
const requestSchema = z.object({
  workspaceId: z.string().min(1),
  targetAgent: z.enum(MCP_CONNECTION_AGENTS),
});
const TOML_START = "# agentkib:managed:start";
const TOML_END = "# agentkib:managed:end";
const isObject = (value: unknown): value is ObjectValue => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  // Configuration tables are mappings; TOML dates are scalar objects.
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
};
const encodeSegment = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

function readOptional(target: string): string | null {
  try {
    return readText(target, 8 * 1024 * 1024);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Could not read MCP configuration: ${target}`, { cause: error });
  }
}

function pushSnapshot(
  changes: ChangeSet["changes"],
  target: string,
  before: string | null,
  after: string,
  scope: "project" | "agent-home",
  risk: "low" | "medium" | "high",
  validator: string,
): void {
  pushChange(changes, target, after, scope, risk, validator);
  if (changes.at(-1)!.original_hash !== (before === null ? null : hash(before)))
    throw new Error(`MCP configuration changed while planning; retry: ${target}`);
}

function connectionContext(
  value: unknown,
  store: WorkspaceStore,
  hub: HubStatus,
  environment: NodeJS.ProcessEnv,
) {
  const request = requestSchema.parse(value);
  if (!request.workspaceId.trim() || [".", ".."].includes(request.workspaceId))
    throw new Error("Workspace id is required");
  const workspace = store.getWorkspace(request.workspaceId);
  if (!isObject(workspace) || typeof workspace.path !== "string")
    throw new Error("Workspace does not exist");
  // Manifest aliases can be shared by clones; use the exact registered workspace and its path.
  const project = canonicalProject(workspace.path);
  const workspaceId = request.workspaceId;
  if (!Number.isInteger(hub.port) || hub.port < 1 || hub.port > 65535)
    throw new Error("MCP Hub settings are unavailable");
  const agent = request.targetAgent;
  const home = userHome(environment);
  const targets = {
    codex: [path.join(project, ".codex/config.toml"), "toml", "project"],
    "claude-code": [path.join(project, ".mcp.json"), "json", "project"],
    cursor: [path.join(project, ".cursor/mcp.json"), "json", "project"],
    opencode: [managedConfigPath(project), "json", "project"],
    "open-claw": [path.join(home, ".openclaw/openclaw.json"), "json", "agent-home"],
    hermes: [path.join(home, ".hermes/config.yaml"), "yaml", "agent-home"],
    "grok-build": [path.join(project, ".grok/config.toml"), "toml", "project"],
    antigravity: [path.join(project, ".agents/mcp_config.json"), "json", "project"],
  } as const;
  const [target, format, scope] = targets[agent];
  const url = `http://127.0.0.1:${hub.port}/mcp/v1/workspaces/${encodeSegment(workspaceId)}/agents/${agent}`;
  const connection: Connection = {
    name: "agentkib",
    transport: "http",
    url,
    env: {},
    allow_tools: [],
    targets: [agent],
  };
  const entry = connectionJson(connection, agent) as ObjectValue;
  let config: string;
  if (format === "toml") config = stringifyToml({ mcp_servers: { agentkib: { url } } });
  else if (format === "yaml") config = stringifyYaml({ mcp_servers: { agentkib: entry } });
  else {
    const root =
      agent === "opencode"
        ? { mcp: { agentkib: entry } }
        : agent === "open-claw"
          ? { mcp: { servers: { agentkib: entry } } }
          : { mcpServers: { agentkib: entry } };
    config = JSON.stringify(root, null, 2) + "\n";
  }
  const info: McpConnectionInfo = {
    workspace_id: workspaceId,
    target_agent: agent,
    url,
    config,
    target,
    format,
    scope,
    hub_running: hub.running,
  };
  return { info, project, home, entry };
}

export function mcpConnectionInfo(
  value: unknown,
  store: WorkspaceStore,
  hub: HubStatus,
  environment: NodeJS.ProcessEnv,
): McpConnectionInfo {
  return connectionContext(value, store, hub, environment).info;
}

function recognizedGateway(value: unknown, agent: McpConnectionAgent): value is ObjectValue {
  if (!isObject(value)) return false;
  const endpoint = value[agent === "antigravity" ? "serverUrl" : "url"];
  if (typeof endpoint !== "string") return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  const match = /^\/mcp\/v1\/workspaces\/([^/]+)\/agents\/([^/]+)$/.exec(url.pathname);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    (url.port !== "" && Number(url.port) < 1) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !match ||
    match[2] !== agent
  )
    return false;
  try {
    const id = decodeURIComponent(match[1]!);
    if (!id.trim() || [".", ".."].includes(id) || encodeSegment(id) !== match[1]) return false;
  } catch {
    return false;
  }
  if (
    agent === "claude-code" &&
    value.type !== undefined &&
    value.type !== "http" &&
    value.type !== "streamable-http"
  )
    return false;
  if (agent === "opencode" && value.type !== undefined && value.type !== "remote") return false;
  if (
    agent === "open-claw" &&
    value.transport !== undefined &&
    value.transport !== "streamable-http"
  )
    return false;
  return true;
}

function mergeGateway(
  existing: unknown,
  entry: ObjectValue,
  agent: McpConnectionAgent,
): ObjectValue {
  if (existing !== undefined && !recognizedGateway(existing, agent))
    throw new Error(
      `MCP configuration already contains an unmanaged server named agentkib. Rename it before connecting AgentKib: ${agent}`,
    );
  const next = existing === undefined ? {} : { ...(existing as ObjectValue) };
  // A recognized Hub entry keeps client-specific headers, timeouts and tool filters.
  for (const field of ["command", "args", "cwd"]) delete next[field];
  for (const [key, item] of Object.entries(entry))
    Object.defineProperty(next, key, {
      value: item,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  return next;
}

function child(root: ObjectValue, key: string): ObjectValue {
  if (!Object.hasOwn(root, key))
    Object.defineProperty(root, key, {
      value: {},
      enumerable: true,
      writable: true,
      configurable: true,
    });
  if (!isObject(root[key])) throw new Error(`MCP configuration ${key} must be an object`);
  return root[key];
}

function mergeJsonConnection(
  before: string | null,
  info: McpConnectionInfo,
  entry: ObjectValue,
): string {
  let parsed: unknown;
  try {
    parsed =
      info.target.endsWith(".jsonc") || info.target_agent === "open-claw"
        ? JSON5.parse(before ?? "{}")
        : JSON.parse(before ?? "{}");
  } catch (error) {
    throw new Error(`Invalid MCP JSON configuration: ${info.target}`, { cause: error });
  }
  finiteJson(parsed);
  if (!isObject(parsed)) throw new Error("MCP JSON root must be an object");
  const original = sortedJson(parsed);
  const servers =
    info.target_agent === "opencode"
      ? child(parsed, "mcp")
      : info.target_agent === "open-claw"
        ? child(child(parsed, "mcp"), "servers")
        : child(parsed, "mcpServers");
  servers.agentkib = mergeGateway(servers.agentkib, entry, info.target_agent);
  const after = sortedJson(parsed);
  return before !== null && after === original ? before : after;
}

function mergeTomlConnection(before: string | null, info: McpConnectionInfo): string {
  const existing = before ?? "";
  let root: ObjectValue;
  try {
    root = parseToml(existing) as ObjectValue;
  } catch (error) {
    throw new Error(`Invalid MCP TOML configuration: ${info.target}`, { cause: error });
  }
  const starts = existing.split(TOML_START).length - 1,
    ends = existing.split(TOML_END).length - 1;
  if (starts !== ends || starts > 1)
    throw new Error("AgentKib-managed MCP block is incomplete or ambiguous");
  const entry = { url: info.url };
  const fullServers = child(root, "mcp_servers");
  const preserveOrSerialize = (after: string, gateway: ObjectValue): string => {
    fullServers.agentkib = gateway;
    const serialized = stringifyToml(root);
    // Reparse to compare TOML values with the same null-prototype table representation.
    const expected = parseToml(serialized);
    try {
      if (isDeepStrictEqual(parseToml(after), expected)) return after;
    } catch {
      // Appending a table can invalidate an existing inline table.
    }
    // A comment marker does not end a table: replacing a block can also move trailing keys.
    return serialized;
  };
  if (!starts) {
    const servers = root.mcp_servers;
    if (servers !== undefined && !isObject(servers)) throw new Error("mcp_servers must be a table");
    if (isObject(servers) && Object.hasOwn(servers, "agentkib")) {
      const original = sortedJson(root);
      servers.agentkib = mergeGateway(servers.agentkib, entry, info.target_agent);
      return sortedJson(root) === original ? existing : stringifyToml(root);
    }
    const block = `${TOML_START}\n${stringifyToml({ mcp_servers: { agentkib: entry } }).trimEnd()}\n${TOML_END}\n`;
    return preserveOrSerialize(
      existing.trim() ? `${existing.trimEnd()}\n\n${block}` : block,
      entry,
    );
  }
  const start = existing.indexOf(TOML_START),
    contentStart = start + TOML_START.length,
    end = existing.indexOf(TOML_END);
  if (end < contentStart) throw new Error("AgentKib-managed MCP block is incomplete");
  const managed = parseToml(existing.slice(contentStart, end)) as ObjectValue;
  const servers = child(managed, "mcp_servers");
  // Ownership and extensions belong to the full table, including fields outside the markers.
  const gateway = mergeGateway(fullServers.agentkib, entry, info.target_agent);
  if (sortedJson(fullServers.agentkib) === sortedJson(gateway)) return existing;
  servers.agentkib = gateway;
  const block = `${TOML_START}\n${stringifyToml(managed).trimEnd()}\n${TOML_END}`;
  return preserveOrSerialize(
    existing.slice(0, start) + block + existing.slice(end + TOML_END.length),
    gateway,
  );
}

function yamlAliasCopies(doc: Document) {
  const aliasComments = (copy: Node, alias: Alias): Node => {
    copy.commentBefore =
      [alias.commentBefore, copy.commentBefore].filter(Boolean).join("\n") || null;
    copy.comment = [copy.comment, alias.comment].filter(Boolean).join("\n") || null;
    copy.spaceBefore = alias.spaceBefore ?? copy.spaceBefore;
    return copy;
  };
  const copying = new Set<Node>();
  const detachedCopy = (source: Node): Node => {
    if (copying.has(source)) throw new Error("Invalid YAML configuration: cyclic aliases");
    copying.add(source);
    try {
      const sources: Node[] = [];
      visit(source, {
        Alias: (_key, alias) => {
          const target = alias.resolve(doc);
          if (!target) throw new Error(`Invalid YAML alias: ${alias.source}`);
          sources.push(target);
        },
      });
      const copy = source.clone() as Node;
      visit(copy, {
        Value: (_key, node) => {
          delete node.anchor;
        },
      });
      let index = 0;
      visit(copy, {
        Alias: (_key, alias) => aliasComments(detachedCopy(sources[index++]!), alias),
      });
      return copy;
    } finally {
      copying.delete(source);
    }
  };
  const isolateAliases = (changed: Set<Node>, selected = new Set<Alias>()) => {
    // Resolve every copy in the original document, before moving or changing shared anchors.
    const snapshots = new Map<Alias, Node>();
    visit(doc, {
      Alias: (_key, alias) => {
        const source = alias.resolve(doc);
        if (source && (changed.has(source) || selected.has(alias)))
          snapshots.set(alias, aliasComments(detachedCopy(source), alias));
      },
    });
    visit(doc, { Alias: (_key, alias) => snapshots.get(alias) });
  };
  return { aliasComments, detachedCopy, isolateAliases };
}

function yamlPairAt(doc: Document, mapping: YAMLMap, key: string, ambiguity: string) {
  // Literal map lookups do not resolve aliases used as keys, while toJS() does.
  const pairs = mapping.items.filter((pair) => {
    const node = isAlias(pair.key) ? pair.key.resolve(doc) : pair.key;
    return isScalar(node) && node.value === key;
  });
  if (pairs.length > 1) throw new Error(`${ambiguity}: ${key}`);
  return pairs[0];
}

function mergeYamlConnection(
  before: string | null,
  info: McpConnectionInfo,
  entry: ObjectValue,
): string {
  const doc = parseDocument(before ?? "{}", { uniqueKeys: true });
  if (doc.errors.length || !isMap(doc.contents))
    throw new Error(`Invalid MCP YAML configuration: ${info.target}`);
  // Resolve with the document so aliases in the gateway and its extensions keep their values.
  const original = doc.toJS();
  const pending: Array<[unknown, boolean]> = [[original, false]],
    active = new Set<object>(),
    visited = new Set<object>();
  while (pending.length) {
    const [value, leaving] = pending.pop()!;
    if (value === null || typeof value !== "object") continue;
    if (leaving) {
      active.delete(value);
      visited.add(value);
    } else {
      if (active.has(value)) throw new Error("Invalid MCP YAML configuration: cyclic aliases");
      if (visited.has(value)) continue;
      active.add(value);
      pending.push([value, true]);
      for (const child of Object.values(value)) pending.push([child, false]);
    }
  }
  const pairAt = (mapping: YAMLMap, key: string) =>
    yamlPairAt(doc, mapping, key, "Hermes MCP YAML has ambiguous key");
  const sourceMap = (node: unknown): YAMLMap | undefined => {
    const source = isAlias(node) ? node.resolve(doc) : node;
    if (source === undefined) return undefined;
    if (!isMap(source)) throw new Error("Hermes MCP configuration must contain mappings");
    return source;
  };
  const serversPair = pairAt(doc.contents, "mcp_servers");
  if (Object.hasOwn(original, "mcp_servers") && !isObject(original.mcp_servers))
    throw new Error("Hermes mcp_servers must be an object");
  const sourceServers = sourceMap(serversPair?.value);
  const value = original.mcp_servers?.agentkib;
  const next = mergeGateway(value, entry, info.target_agent);
  const sourceGateway = sourceMap(sourceServers && pairAt(sourceServers, "agentkib")?.value);
  const fieldNames = new Set(["command", "args", "cwd", ...Object.keys(entry)]);
  // Reject semantic duplicate keys even when the endpoint is already up to date.
  if (sourceGateway) for (const key of fieldNames) pairAt(sourceGateway, key);
  if (before !== null && isDeepStrictEqual(value, next)) return before;

  const { aliasComments, detachedCopy, isolateAliases } = yamlAliasCopies(doc);
  const independentMap = (node: unknown) => {
    const source = isAlias(node) ? node.resolve(doc) : node;
    if (!isMap(source)) throw new Error("Hermes mcp_servers must be an object");
    // A moved subtree must resolve its aliases at the original position, before shadowing anchors.
    return isAlias(node) ? aliasComments(detachedCopy(source), node) : source;
  };
  const servers =
    serversPair === undefined
      ? doc.createNode(original.mcp_servers ?? {})
      : independentMap(serversPair.value);
  if (!isMap(servers)) throw new Error("Hermes mcp_servers must be an object");
  // Use the actual key node so aliases keep their identity, comments and position.
  doc.set(serversPair?.key ?? "mcp_servers", servers);
  const gatewayPair = pairAt(servers, "agentkib"),
    old = gatewayPair?.value;
  const gateway = old === undefined ? doc.createNode(value ?? {}) : independentMap(old);
  if (!isMap(gateway)) throw new Error("Hermes agentkib must be an object");
  servers.set(gatewayPair?.key ?? "agentkib", gateway);

  const changed = new Set<Node>([servers, gateway]);
  const updates = Object.entries(entry).filter(
    ([key, item]) => !isDeepStrictEqual(value?.[key], item),
  );
  for (const key of ["command", "args", "cwd", ...updates.map(([key]) => key)]) {
    const pair = pairAt(gateway, key),
      node = pair?.value;
    if (isNode(node))
      visit(node, {
        Node: (_key, child) => {
          changed.add(child);
        },
      });
    if (["command", "args", "cwd"].includes(key) && isNode(pair?.key)) changed.add(pair.key);
  }
  // Snapshot only aliases to nodes that will change, before touching shared anchors.
  isolateAliases(changed);
  for (const key of ["command", "args", "cwd"]) {
    const pair = pairAt(gateway, key);
    if (pair) gateway.delete(pair.key);
  }
  for (const [key, item] of updates) {
    const pair = pairAt(gateway, key),
      old = pair?.value;
    gateway.set(pair?.key ?? key, isAlias(old) ? aliasComments(doc.createNode(item), old) : item);
  }
  const after = doc.toString(),
    output = parseDocument(after, { uniqueKeys: true });
  if (output.errors.length)
    throw new Error("Invalid MCP YAML configuration after merging", { cause: output.errors[0] });
  const result = output.toJS(),
    expected = {
      ...original,
      mcp_servers: { ...original.mcp_servers, agentkib: next },
    };
  if (!isDeepStrictEqual(result, expected))
    throw new Error("MCP YAML merge would change unrelated configuration");
  return before !== null && isDeepStrictEqual(result, original) ? before : after;
}

function updateRecordedHash(
  changes: ChangeSet["changes"],
  project: string,
  info: McpConnectionInfo,
): void {
  const target = manifestPath(project);
  if (!safeTarget(project, target)) throw new Error(`Unsafe manifest path: ${target}`);
  const before = readOptional(target);
  if (before === null) return;
  const manifest = parseManifest(before);
  const hashes = manifest.adapters[info.target_agent]?.generated_hashes;
  const connection = changes.find((change) => change.target === info.target);
  if (!hashes || !connection) return;
  const generatedHash = hash(connection.after);
  const keys = Object.keys(hashes).filter(
    (key) => path.resolve(project, key) === info.target && hashes[key] !== generatedHash,
  );
  if (!keys.length) return;
  const doc = parseDocument(before, { uniqueKeys: true });
  const changed = new Set<Node>(),
    selected = new Set<Alias>();
  const valueAt = (mapping: YAMLMap, key: string, selectKey: boolean) => {
    const pair = yamlPairAt(doc, mapping, key, "manifest.yaml has ambiguous hash path key");
    if (selectKey && isAlias(pair?.key)) selected.add(pair.key);
    return pair?.value;
  };
  let current: unknown = doc.contents;
  let detachedPath = false;
  for (const segment of ["adapters", info.target_agent, "generated_hashes"]) {
    if (!isMap(current)) throw new Error("manifest.yaml hash path must contain mappings");
    const node = valueAt(current, segment, !detachedPath);
    const source = isAlias(node) ? node.resolve(doc) : node;
    if (!isMap(source)) throw new Error("manifest.yaml hash path must contain mappings");
    if (!detachedPath) {
      if (isAlias(node)) {
        // Detaching the first alias also isolates the rest of this path from its source.
        selected.add(node);
        detachedPath = true;
      } else changed.add(source);
    }
    current = source;
  }
  if (!isMap(current)) throw new Error("manifest.yaml generated_hashes must be a mapping");
  for (const key of keys) {
    const node = valueAt(current, key, !detachedPath);
    if (!detachedPath) {
      if (isAlias(node)) selected.add(node);
      else if (isNode(node)) changed.add(node);
    }
  }
  // Other clients and extensions may reference any ancestor or scalar being updated.
  yamlAliasCopies(doc).isolateAliases(changed, selected);
  for (const key of keys)
    doc.setIn(["adapters", info.target_agent, "generated_hashes", key], generatedHash);
  const after = doc.toString();
  // Expanding aliases can reveal duplicate keys outside the hash path as well.
  parseManifest(after);
  if (after !== before) pushSnapshot(changes, target, before, after, "project", "low", "yaml");
}

export function planMcpConnection(
  value: unknown,
  store: WorkspaceStore,
  hub: HubStatus,
  environment: NodeJS.ProcessEnv,
): ChangeSet {
  const { info, project, home, entry } = connectionContext(value, store, hub, environment);
  if (!safeTarget(info.scope === "project" ? project : canonicalProject(home), info.target))
    throw new Error(`Unsafe MCP configuration path: ${info.target}`);
  const before = readOptional(info.target);
  const after =
    info.format === "toml"
      ? mergeTomlConnection(before, info)
      : info.format === "yaml"
        ? mergeYamlConnection(before, info, entry)
        : mergeJsonConnection(before, info, entry);
  const changes: ChangeSet["changes"] = [];
  if (before !== after)
    pushSnapshot(
      changes,
      info.target,
      before,
      after,
      info.scope,
      info.scope === "agent-home" ? "high" : "medium",
      info.target.endsWith(".jsonc") ? "jsonc" : info.format,
    );
  updateRecordedHash(changes, project, info);
  return {
    id: randomUUID(),
    project_root: project,
    created_at: utcNow(),
    changes,
    requires_home_approval: changes.some((change) => change.scope === "agent-home"),
  };
}

export async function verifyMcpConnection(
  value: unknown,
  store: WorkspaceStore,
  hubStatus: HubStatus | (() => HubStatus),
  environment: NodeJS.ProcessEnv,
) {
  const hub = typeof hubStatus === "function" ? hubStatus() : hubStatus;
  const { info } = connectionContext(value, store, hub, environment);
  if (!hub.running) throw new Error("AgentKib MCP Hub is not running");
  const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
  ]);
  const deadline = AbortSignal.timeout(15_000);
  const transport = new StreamableHTTPClientTransport(new URL(info.url), {
    // Session deletion gets a separate small budget even when verification timed out.
    fetch: (input, init) =>
      fetch(input, {
        ...init,
        signal:
          init?.method === "DELETE"
            ? AbortSignal.timeout(1_500)
            : AbortSignal.any([deadline, ...(init?.signal ? [init.signal] : [])]),
      }),
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 0,
      maxReconnectionDelay: 0,
      reconnectionDelayGrowFactor: 1,
    },
  });
  const client = new Client({ name: "agentkib-connection-check", version: "0.13.0" });
  let verification: {
    url: string;
    checked_at: string;
    builtin_tools: number;
    external_tools: string[];
  };
  try {
    await client.connect(transport, { timeout: 15_000, signal: deadline });
    const names = new Set<string>(),
      cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const result = await client.listTools(cursor ? { cursor } : {}, {
        timeout: 15_000,
        signal: deadline,
      });
      for (const tool of result.tools) names.add(tool.name);
      cursor = result.nextCursor;
      if (!cursor) break;
      if (cursors.has(cursor) || page === 99)
        throw new Error("MCP tool listing exceeded the pagination limit");
      cursors.add(cursor);
    }
    const builtinNames = new Set<string>(BUILTIN_MCP_TOOLS.map((tool) => tool.name));
    verification = {
      url: info.url,
      checked_at: utcNow(),
      builtin_tools: [...names].filter((name) => builtinNames.has(name)).length,
      external_tools: [...names].filter((name) => !builtinNames.has(name)).sort(),
    };
  } catch (error) {
    if (deadline.aborted)
      throw new Error("MCP connection verification timed out after 15 seconds", { cause: error });
    throw error;
  } finally {
    try {
      await transport.terminateSession();
    } catch {
      /* A closed or expired Hub session cannot always acknowledge DELETE. */
    }
    await client.close();
  }
  const currentHub = typeof hubStatus === "function" ? hubStatus() : hubStatus;
  if (!currentHub.running || currentHub.port !== hub.port)
    throw new Error("AgentKib MCP Hub endpoint changed during verification; retry");
  return verification;
}
