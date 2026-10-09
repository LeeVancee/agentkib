import type { McpDiagnosticMessage } from "@agentkib/runtime-protocol";
import { McpDiagnosticError, mcpDiagnostic } from "./mcp-diagnostics";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENTS } from "./rpc";
import type { Agent } from "./doctor-files";
import { canonicalize, pathIdentity } from "./paths";
import { compareUtf8 } from "./workspaces";
import type { BackendStore } from "./store";
import { agentMcpHome, safeAgentHomePath } from "./agent-home";
import { normalizeMcpImport, publicMcpConfig } from "./mcp-import";
import type { McpServer } from "./mcp-config-read";
import { parseNativeMcpDocument } from "./mcp-native-document";

export type NativeMcpCandidate = {
  id: string;
  agent: Agent;
  scope: string;
  name: string;
  source_path: string;
  transport: string;
  endpoint: string;
  has_secret_values: boolean;
  supported: boolean;
  warnings: string[];
  warning_messages?: McpDiagnosticMessage[];
  fingerprint?: string;
};
type Candidate = NativeMcpCandidate;
type JsonObject = Record<string, unknown>;
export type NativeMcpSnapshot = ReturnType<typeof parseNativeMcpDocument> & {
  content: string;
  fingerprint: string;
};
export type NativeMcpImportRead =
  | { candidate: NativeMcpCandidate; snapshot: NativeMcpSnapshot; server: McpServer }
  | { candidate: NativeMcpCandidate; error: unknown };
type CandidateContext = {
  output: Candidate[];
  project?: string;
  home: string;
  opencodeHome: string;
  grokHome?: string;
  environment: NodeJS.ProcessEnv;
};
const workingDirectoryWarning =
  "Native MCP working directory cannot be determined equivalently; review the original configuration";
class NativeWorkingDirectoryError extends McpDiagnosticError {
  constructor() {
    super(workingDirectoryWarning, "native_working_directory");
  }
}

export function scanNativeMcp(
  request: unknown,
  store: BackendStore,
  environment: NodeJS.ProcessEnv,
): Candidate[] {
  const value = request as { project?: unknown } | null;
  const projectValue = value?.project;
  if (projectValue != null && typeof projectValue !== "string")
    throw new Error("Project must be a registered workspace path");
  const project =
    typeof projectValue === "string" ? registeredProject(store, projectValue) : undefined;
  const home = environment.HOME ?? environment.USERPROFILE ?? os.homedir();
  const configRoot = environment.XDG_CONFIG_HOME;
  const opencodeHome = path.join(
    configRoot && path.isAbsolute(configRoot) ? configRoot : path.join(home, ".config"),
    "opencode",
  );
  const grokRoot = environment.GROK_HOME ?? path.join(home, ".grok");
  const context: CandidateContext = {
    output: [],
    project,
    home,
    opencodeHome,
    environment,
    ...(isDirectory(grokRoot) ? { grokHome: canonicalPath(grokRoot) } : {}),
  };
  if (project) scanProject(context, project);
  scanHome(context);
  scanOpenCodeHome(context);
  scanGrokHome(context);

  const seen = new Set<string>();
  const result = context.output.filter((candidate) => {
    if (candidate.name === "agentkib" || seen.has(candidate.id)) return false;
    seen.add(candidate.id);
    return true;
  });
  markLayeredOpenCode(result);
  result.sort(
    (left, right) =>
      AGENTS.indexOf(left.agent) - AGENTS.indexOf(right.agent) ||
      compareUtf8(left.name, right.name),
  );
  return result;
}

function registeredProject(store: BackendStore, value: string): string {
  const canonical = canonicalize(value);
  const registered = store.sql
    .rows("SELECT canonical_path FROM workspaces")
    .some((row) => pathIdentity(String(row.canonical_path)) === pathIdentity(canonical));
  if (!registered) throw new Error("MCP project scope must be a registered AgentKib workspace");
  return canonical;
}

function scanProject(context: CandidateContext, project: string): void {
  for (const [agent, relative] of [
    ["codex", ".codex/config.toml"],
    ["grok-build", ".grok/config.toml"],
  ] as const) {
    const file = path.join(project, relative);
    scanSafely(context, agent, "project", file, () => scanConfig(file, agent, "project", context));
  }
  for (const [agent, relative] of [
    ["claude-code", ".mcp.json"],
    ["cursor", ".cursor/mcp.json"],
    ["antigravity", ".agents/mcp_config.json"],
  ] as const) {
    const file = path.join(project, relative);
    scanSafely(context, agent, "project", file, () => scanConfig(file, agent, "project", context));
  }
  for (const directory of [project, path.join(project, ".opencode")])
    for (const name of ["opencode.json", "opencode.jsonc"]) {
      const file = path.join(directory, name);
      scanSafely(context, "opencode", "project", file, () =>
        scanConfig(file, "opencode", "project", context),
      );
    }
}

function scanHome(context: CandidateContext): void {
  const home = context.home;
  scanSafely(context, "codex", "home", path.join(home, ".codex/config.toml"), () =>
    scanConfig(path.join(home, ".codex/config.toml"), "codex", "home", context),
  );
  for (const [agent, relative] of [
    ["claude-code", ".claude.json"],
    ["cursor", ".cursor/mcp.json"],
    ["antigravity", ".gemini/config/mcp_config.json"],
  ] as const) {
    const file = path.join(home, relative);
    scanSafely(context, agent, "home", file, () => scanConfig(file, agent, "home", context));
  }
  scanSafely(context, "open-claw", "home", "OpenClaw selected profile", () =>
    scanConfig(agentMcpHome("open-claw", context.environment).config, "open-claw", "home", context),
  );
  scanSafely(context, "hermes", "home", "Hermes selected profile", () =>
    scanConfig(agentMcpHome("hermes", context.environment).config, "hermes", "home", context),
  );
}

function scanOpenCodeHome(context: CandidateContext): void {
  for (const name of ["opencode.json", "opencode.jsonc"])
    scanSafely(context, "opencode", "home", path.join(context.opencodeHome, name), () =>
      scanConfig(path.join(context.opencodeHome, name), "opencode", "home", context),
    );
}

function scanGrokHome(context: CandidateContext): void {
  if (context.grokHome)
    scanSafely(context, "grok-build", "home", path.join(context.grokHome, "config.toml"), () =>
      scanConfig(path.join(context.grokHome!, "config.toml"), "grok-build", "home", context),
    );
}

function scanSafely(
  context: CandidateContext,
  agent: Agent,
  scope: string,
  source: string,
  scan: () => void,
) {
  try {
    scan();
  } catch {
    context.output.push({
      id: createHash("sha256").update(`${agent}:${source}`).digest("hex").slice(0, 24),
      agent,
      scope,
      name: "Configuration unavailable",
      source_path: source,
      transport: "unknown",
      endpoint: "unavailable",
      has_secret_values: false,
      supported: false,
      warnings: ["Configuration or active profile is invalid, unsafe, or exceeds the read limit"],
      warning_messages: [mcpDiagnostic("native_config_unavailable")],
    });
  }
}

function scanConfig(file: string, agent: Agent, scope: string, context: CandidateContext): void {
  const snapshot = readNativeMcpSnapshot(file, agent);
  if (!snapshot) return;
  const { format, servers } = snapshot;
  if (format !== "toml") {
    collectJsonServers(file, agent, scope, snapshot, context);
    return;
  }
  if (!servers) return;
  for (const [name, raw] of Object.entries(servers)) {
    const server = asObject(raw);
    const endpoint = stringField(server, ["url", "serverUrl", "command"]) ?? "unavailable";
    context.output.push(
      candidate(
        file,
        agent,
        scope,
        name,
        server && Object.hasOwn(server, "url") ? "http" : "stdio",
        endpoint,
        !!server && ["env", "headers", "http_headers"].some((key) => Object.hasOwn(server, key)),
        snapshot,
        context.project,
      ),
    );
  }
}

function readNativeMcpSnapshot(file: string, agent: Agent): NativeMcpSnapshot | undefined {
  const content = readConfig(file);
  if (content === undefined) return;
  const document = parseNativeMcpDocument(content, agent, file);
  // All candidates from this read share one document and fingerprint. Never keep
  // this snapshot across scans or the fresh reads required by preview and apply.
  return { ...document, content, fingerprint: createHash("sha256").update(content).digest("hex") };
}

function readConfig(file: string): string | undefined {
  try {
    safeAgentHomePath(file);
    const metadata = statSync(file);
    if (!metadata.isFile() || metadata.size > 1024 * 1024)
      throw new Error("Native MCP config must be a regular file of at most 1 MiB");
    const content = readFileSync(file, "utf8");
    return content.trim() ? content : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function collectJsonServers(
  file: string,
  agent: Agent,
  scope: string,
  snapshot: NativeMcpSnapshot,
  context: CandidateContext,
): void {
  const servers = snapshot.servers;
  if (!servers) return;
  for (const [name, raw] of Object.entries(servers)) {
    const server = asObject(raw);
    const endpoint = endpointField(server) ?? "unavailable";
    const declared = stringField(server, ["transport", "type"]);
    const transport =
      declared ??
      (server && (Object.hasOwn(server, "url") || Object.hasOwn(server, "serverUrl"))
        ? "http"
        : "stdio");
    const hasSecretValues =
      (!!server && ["env", "environment", "headers"].some((key) => hasValues(server[key]))) ||
      (!!server && asObject(server.oauth) !== undefined && hasValues(server.oauth));
    const result = candidate(
      file,
      agent,
      scope,
      name,
      transport,
      endpoint,
      hasSecretValues,
      snapshot,
      context.project,
    );
    if (
      (agent === "opencode" && !opencodeServerCanBeMigrated(server)) ||
      (agent === "antigravity" && !antigravityPolicyCanBeMigrated(server))
    ) {
      result.supported = false;
      if (!result.warnings.includes("Unsupported native MCP fields or transport")) {
        result.warnings.push("Unsupported native MCP fields or transport");
        result.warning_messages!.push(mcpDiagnostic("native_unsupported"));
      }
    }
    context.output.push(result);
  }
}

function endpointField(value: JsonObject | undefined): string | undefined {
  for (const key of ["url", "serverUrl", "command"]) {
    const field = value?.[key];
    if (typeof field === "string") return field;
    if (Array.isArray(field) && typeof field[0] === "string") return field[0];
  }
  return undefined;
}

function candidate(
  file: string,
  agent: Agent,
  scope: string,
  name: string,
  transport: string,
  endpoint: string,
  hasSecretValues: boolean,
  snapshot: NativeMcpSnapshot,
  project?: string,
): Candidate {
  const sourcePath = canonicalPath(file);
  const id = createHash("sha256").update(`${sourcePath}:${name}`).digest("hex").slice(0, 24);
  const supported =
    ["stdio", "http", "streamable-http"].includes(transport) ||
    ((agent === "opencode" || agent === "antigravity") && ["local", "remote"].includes(transport));
  const result: Candidate = {
    id,
    agent,
    scope,
    name,
    source_path: sourcePath,
    transport,
    endpoint,
    has_secret_values: hasSecretValues,
    supported,
    warning_messages: hasSecretValues
      ? [mcpDiagnostic("native_secret_required")]
      : supported
        ? []
        : [mcpDiagnostic("native_unsupported")],
    warnings: hasSecretValues
      ? ["Secret values must be re-entered into mcp.local.json"]
      : supported
        ? []
        : ["Unsupported native MCP fields or transport"],
  };
  if (supported) {
    try {
      const server = nativeMcpImportFromSnapshot(result, snapshot, project);
      const publicConfig = publicMcpConfig(server);
      result.endpoint =
        publicConfig.transport === "stdio" ? publicConfig.command : publicConfig.url;
      result.fingerprint = server.native_source!.fingerprint;
    } catch (error) {
      result.supported = false;
      result.endpoint = "unavailable";
      result.warning_messages!.push(
        mcpDiagnostic(
          error instanceof NativeWorkingDirectoryError
            ? "native_working_directory"
            : "native_review_configuration",
        ),
      );
      result.warnings.push(
        error instanceof NativeWorkingDirectoryError
          ? workingDirectoryWarning
          : "Unsupported native MCP fields or inline credentials; review the original configuration",
      );
    }
  } else result.endpoint = "unavailable";
  return result;
}

/** Caller must obtain candidates from a fresh registered-scope scan, never from Renderer paths. */
export function readNativeMcpImport(
  candidate: NativeMcpCandidate,
  project?: string | null,
): McpServer {
  const snapshot = readNativeMcpSnapshot(candidate.source_path, candidate.agent);
  if (!snapshot) throw new Error("Native MCP source is unavailable");
  return nativeMcpImportFromSnapshot(candidate, snapshot, project);
}

/** Host-only batch of freshly scanned candidates. Snapshots live for this call;
 * callers must read again at each preview/apply boundary and after async work. */
export function readNativeMcpImports(
  candidates: NativeMcpCandidate[],
  project?: string | null,
): NativeMcpImportRead[] {
  const snapshots = new Map<string, { snapshot: NativeMcpSnapshot } | { error: unknown }>();
  return candidates.map((candidate) => {
    try {
      if (!candidate.supported) throw new Error("Unsupported native MCP entry");
      const key = JSON.stringify([candidate.source_path, candidate.agent]);
      let result = snapshots.get(key);
      if (!result) {
        try {
          const snapshot = readNativeMcpSnapshot(candidate.source_path, candidate.agent);
          if (!snapshot) throw new Error("Native MCP source is unavailable");
          result = { snapshot };
        } catch (error) {
          result = { error };
        }
        snapshots.set(key, result);
      }
      if ("error" in result) throw result.error;
      return {
        candidate,
        snapshot: result.snapshot,
        server: nativeMcpImportFromSnapshot(candidate, result.snapshot, project),
      };
    } catch (error) {
      return { candidate, error };
    }
  });
}

function nativeMcpImportFromSnapshot(
  candidate: NativeMcpCandidate,
  snapshot: NativeMcpSnapshot,
  project?: string | null,
): McpServer {
  const raw = snapshot.servers?.[candidate.name];
  if (!raw) throw new Error("Native MCP entry no longer exists");
  const server = normalizeMcpImport(candidate.name, raw, candidate.agent, true);
  if (server.transport === "stdio")
    server.cwd = nativeWorkingDirectory(candidate, server.cwd, project);
  server.native_source = {
    candidate_id: candidate.id,
    fingerprint: snapshot.fingerprint,
    agent: candidate.agent,
  };
  return server;
}

function nativeWorkingDirectory(
  candidate: NativeMcpCandidate,
  cwd: string | null | undefined,
  project: string | null | undefined,
): string {
  if (cwd !== undefined) {
    // These clients document an explicit cwd. Other native formats may ignore
    // the same field; accepting it would activate behavior absent in the source.
    if (
      ["codex", "cursor", "antigravity", "open-claw"].includes(candidate.agent) &&
      typeof cwd === "string" &&
      path.isAbsolute(cwd)
    )
      return cwd;
    // Relative paths depend on client-specific resolution; never resolve them
    // against AgentKib's own process directory or a selected unrelated workspace.
    throw new NativeWorkingDirectoryError();
  }
  // Freeze a known project execution context at collection. User-level sources
  // and clients with an unknown launch directory cannot inherit this assumption.
  if (
    candidate.scope === "project" &&
    project &&
    ["claude-code", "opencode"].includes(candidate.agent)
  )
    return project;
  throw new NativeWorkingDirectoryError();
}

function opencodeServerCanBeMigrated(server: JsonObject | undefined): boolean {
  if (!server || (server.enabled !== undefined && typeof server.enabled !== "boolean"))
    return false;
  if (server.type === "local") {
    return (
      Object.keys(server).every((key) =>
        ["type", "command", "environment", "enabled"].includes(key),
      ) &&
      Array.isArray(server.command) &&
      server.command.length > 0 &&
      server.command.every((item) => typeof item === "string") &&
      stringMapValid(server.environment)
    );
  }
  if (server.type === "remote") {
    return (
      Object.keys(server).every((key) =>
        ["type", "url", "enabled", "headers", "oauth"].includes(key),
      ) &&
      typeof server.url === "string" &&
      stringMapValid(server.headers) &&
      server.oauth === undefined
    );
  }
  return false;
}

function antigravityPolicyCanBeMigrated(server: JsonObject | undefined): boolean {
  if (!server) return false;
  const fields = [
    "command",
    "args",
    "env",
    "cwd",
    "serverUrl",
    "url",
    "headers",
    "transport",
    "type",
    "disabled",
    "enabledTools",
    "disabledTools",
  ];
  return (
    Object.keys(server).every((key) => fields.includes(key)) &&
    (server.disabled === undefined || typeof server.disabled === "boolean") &&
    antigravityTransportCanBeMigrated(server) &&
    antigravityAllowToolsCanBeMigrated(server)
  );
}

function antigravityTransportCanBeMigrated(server: JsonObject): boolean {
  const command = server.command;
  const serverUrl = server.serverUrl;
  const legacyUrl = server.url;
  const remoteUrl = serverUrl ?? legacyUrl;
  if (serverUrl !== undefined && legacyUrl !== undefined && serverUrl !== legacyUrl) return false;
  if ((command !== undefined) === (remoteUrl !== undefined)) return false;
  if (command !== undefined && typeof command !== "string") return false;
  if (remoteUrl !== undefined && typeof remoteUrl !== "string") return false;
  if (server.cwd !== undefined && typeof server.cwd !== "string") return false;
  if (
    server.args !== undefined &&
    (!Array.isArray(server.args) || !server.args.every((item) => typeof item === "string"))
  )
    return false;
  if (!stringMapValid(server.env) || !stringMapValid(server.headers)) return false;
  if (server.transport !== undefined && typeof server.transport !== "string") return false;
  if (server.type !== undefined && typeof server.type !== "string") return false;
  if (
    server.transport !== undefined &&
    server.type !== undefined &&
    server.transport !== server.type
  )
    return false;
  const declared = server.transport ?? server.type;
  return command !== undefined
    ? declared === undefined || ["stdio", "local"].includes(String(declared))
    : declared === undefined || ["http", "streamable-http", "remote"].includes(String(declared));
}

function antigravityAllowToolsCanBeMigrated(server: JsonObject): boolean {
  const enabled = optionalStringArray(server.enabledTools);
  const disabled = optionalStringArray(server.disabledTools);
  if (enabled === false || disabled === false) return false;
  const excluded = disabled ?? [];
  if (enabled === undefined) return excluded.length === 0;
  return enabled.length > 0 && enabled.some((tool) => !excluded.includes(tool));
}

function optionalStringArray(value: unknown): string[] | undefined | false {
  if (value === undefined) return undefined;
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : false;
}

function stringMapValid(value: unknown): boolean {
  return (
    value === undefined ||
    (asObject(value) !== undefined &&
      Object.values(value as JsonObject).every((item) => typeof item === "string"))
  );
}

function hasValues(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "object") return Object.keys(value).length > 0;
  if (typeof value === "string") return value.length > 0;
  return true;
}

function markLayeredOpenCode(candidates: Candidate[]): void {
  for (const candidate of candidates) {
    if (candidate.agent !== "opencode") continue;
    const layered = candidates.some(
      (other) =>
        other.agent === "opencode" &&
        other.name === candidate.name &&
        other.source_path !== candidate.source_path,
    );
    if (!layered) continue;
    candidate.supported = false;
    const warning =
      "Layered OpenCode MCP entries with the same name cannot be migrated automatically";
    if (!candidate.warnings.includes(warning)) {
      candidate.warnings.push(warning);
      candidate.warning_messages!.push(mcpDiagnostic("native_layered_opencode"));
    }
  }
}

function stringField(value: JsonObject | undefined, keys: string[]): string | undefined {
  for (const key of keys) if (typeof value?.[key] === "string") return value[key] as string;
  return undefined;
}

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function canonicalPath(value: string): string {
  try {
    return canonicalize(value);
  } catch {
    return path.resolve(value);
  }
}

function isDirectory(value: string): boolean {
  try {
    return statSync(value).isDirectory();
  } catch {
    return false;
  }
}
