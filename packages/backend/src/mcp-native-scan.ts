import type { McpDiagnosticMessage } from "@agentkib/runtime-protocol";
import { McpDiagnosticError, mcpDiagnostic } from "./mcp-diagnostics";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENTS } from "./rpc";
import {
  claudeGlobalConfigFile,
  claudeGlobalConfigGate,
  claudeManagedDir,
  resolveClaudeConfig,
  type ClaudeGlobalConfigGate,
} from "./claude-config";
import { hasClaudeProjects, readClaudeProjectEntry } from "./claude-project-config";
import { resolveRepoRoot } from "./claude-memory";
import { readClaudeSettings, type ClaudeSettings, type McpPolicyEntry } from "./claude-settings";
import { isSensitiveExternalPath } from "./context-claude";
import { defaultIo } from "./context-claude-sources";
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
/** Test seam: `managedDir` replaces the organization policy folder, `null` means there is none. */
export type NativeMcpScanOptions = { managedDir?: string | null };
type CandidateContext = {
  output: Candidate[];
  project?: string;
  home: string;
  opencodeHome: string;
  grokHome?: string;
  environment: NodeJS.ProcessEnv;
  options: NativeMcpScanOptions;
  /** A readable managed-mcp.json exists: Claude Code then loads no other MCP servers. */
  claudeManaged: boolean;
  /** Names this project switched off with `/mcp`, from its local entry only. */
  claudeDisabled: Set<string>;
  /** The settings files, read once per scan: approvals and policy come from them. */
  claudeSettings?: ClaudeSettings;
  /** The raw definition behind each Claude candidate, kept in memory for the policy match only. */
  raw: Map<string, JsonObject | undefined>;
  /** Names of servers the organization provides through `managedMcpServers`. */
  claudeProvided: Set<string>;
};
const claudeConfigUnusableWarning =
  "AgentKib cannot tell which Claude configuration file is in use (CLAUDE_CONFIG_DIR is unusable, or a legacy .config.json exists), so what is shown from this file may not match Claude Code, and migration is turned off for it.";
const nativeConfigUnavailableKey = "mcp.manage.diagnostic.native_config_unavailable";
const claudeDiagnosticText = {
  native_overridden_by_local:
    "Overridden: Claude Code uses the local-scope server with the same name instead.",
  native_overridden_if_approved:
    "Overridden if the same-named server in .mcp.json is approved, which it is not yet, or only in a way that depends on trusting the folder.",
  native_inactive_exclusive:
    "Not loaded: a managed-mcp.json on this machine gives your organization exclusive control over MCP servers.",
  native_disabled_for_project: "Disabled for this project in Claude Code (/mcp).",
  native_project_approved:
    "Approved in your Claude Code settings; Claude Code loads this .mcp.json server.",
  native_project_approved_if_trusted:
    "Approved in a project or local settings file, which Claude Code applies only once you trust the folder. AgentKib cannot see that decision.",
  native_project_pending:
    "Pending approval: no Claude Code settings file approves this .mcp.json server yet, so Claude Code asks before it loads it.",
  native_project_rejected:
    "Rejected by disabledMcpjsonServers in a Claude Code settings file; Claude Code does not load this server.",
  native_overridden_by_project:
    "Overridden: the approved same-named server in .mcp.json is used instead.",
  native_overridden_by_managed_setting:
    "Overridden: your organization provides a server with this name through managedMcpServers.",
  native_policy_denied:
    "Blocked by a deniedMcpServers entry in Claude Code settings; Claude Code does not load it.",
  native_policy_not_allowed:
    "Not on the allowedMcpServers list in Claude Code settings; Claude Code does not load it.",
} as const;
// Claude Code's own precedence, strongest first (mcp page, "Scope hierarchy and precedence").
const claudeScopeRank: Record<string, number> = { managed: 0, local: 1, project: 2, home: 3 };
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
  options: NativeMcpScanOptions = {},
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
    options,
    claudeManaged: false,
    claudeDisabled: new Set(),
    raw: new Map(),
    claudeProvided: new Set(),
    ...(isDirectory(grokRoot) ? { grokHome: canonicalPath(grokRoot) } : {}),
  };
  if (project) scanProject(context, project);
  scanHome(context);
  scanOpenCodeHome(context);
  scanGrokHome(context);
  scanClaudeManaged(context);
  scanClaudeSettings(context, environment);

  const seen = new Set<string>();
  const result = context.output.filter((candidate) => {
    if (candidate.name === "agentkib" || seen.has(candidate.id)) return false;
    seen.add(candidate.id);
    return true;
  });
  markLayeredOpenCode(result);
  markClaudeConfigUnusable(result, claudeGlobalConfigGate(resolveClaudeConfig(environment, home)));
  annotateClaudePrecedence(result, context);
  result.sort(
    (left, right) =>
      AGENTS.indexOf(left.agent) - AGENTS.indexOf(right.agent) ||
      compareUtf8(left.name, right.name) ||
      (left.agent === "claude-code" && right.agent === "claude-code"
        ? scopeRank(left.scope) - scopeRank(right.scope)
        : 0),
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
  const claudeFile = claudeGlobalConfigFile(resolveClaudeConfig(context.environment, home), home);
  scanSafely(context, "claude-code", "home", claudeFile, () =>
    scanClaudeGlobalFile(claudeFile, context),
  );
  for (const [agent, file] of [
    ["cursor", path.join(home, ".cursor/mcp.json")],
    ["antigravity", path.join(home, ".gemini/config/mcp_config.json")],
  ] as const) {
    scanSafely(context, agent, "home", file, () => scanConfig(file, agent, "home", context));
  }
  scanSafely(context, "open-claw", "home", "OpenClaw selected profile", () =>
    scanConfig(agentMcpHome("open-claw", context.environment).config, "open-claw", "home", context),
  );
  scanSafely(context, "hermes", "home", "Hermes selected profile", () =>
    scanConfig(agentMcpHome("hermes", context.environment).config, "hermes", "home", context),
  );
}

/**
 * Claude Code's global configuration file holds two scopes: `mcpServers` at the top is "user", and
 * `projects[<path>].mcpServers` is "local". Both come from one read, so an unreadable file fails
 * both together, and nothing of any other project's entry is looked at.
 */
function scanClaudeGlobalFile(file: string, context: CandidateContext): void {
  const snapshot = readNativeMcpSnapshot(file, "claude-code");
  if (!snapshot) return;
  collectJsonServers(file, "claude-code", "home", snapshot, context);
  if (!context.project || !hasClaudeProjects(snapshot.root)) return;
  const entry = readClaudeProjectEntry(
    snapshot.root,
    claudeProjectKeys(context.project),
    process.platform,
  );
  if (!entry) return;
  for (const name of entry.disabledMcpServers) context.claudeDisabled.add(name);
  collectReadonlyServers(file, "local", entry.mcpServers, context);
}

/**
 * The paths Claude Code may have used as this project's key: the repository root (the documented
 * key for trust; a work tree maps to its main work tree) and the workspace root. Which one holds
 * the MCP entry is not documented, so both are tried in that order.
 */
function claudeProjectKeys(project: string): string[] {
  const { base } = resolveRepoRoot(project, { io: defaultIo, platform: process.platform });
  return base === project ? [project] : [base, project];
}

/**
 * Settings files hold three things the MCP view needs: the `managedMcpServers` an organization
 * provides, and (read in `annotateClaudePrecedence`) the approval state of `.mcp.json` servers and
 * the allow and deny lists. Nothing is written back.
 */
function scanClaudeSettings(context: CandidateContext, environment: NodeJS.ProcessEnv): void {
  const root = context.project ?? context.home;
  const settings = readClaudeSettings({
    root,
    cwd: root,
    environment,
    mode: "full",
    managedDir: context.options.managedDir,
    sensitive: isSensitiveExternalPath,
    withoutProject: !context.project,
  });
  context.claudeSettings = settings;
  const file = settings.managedServersFile();
  const servers = settings.mcpPolicy().managedServers;
  if (!file || !Object.keys(servers).length) return;
  for (const name of Object.keys(servers)) context.claudeProvided.add(name);
  scanSafely(context, "claude-code", "managed", file, () =>
    collectReadonlyServers(file, "managed", servers as JsonObject, context),
  );
}

function scanClaudeManaged(context: CandidateContext): void {
  const directory =
    context.options.managedDir === undefined ? claudeManagedDir() : context.options.managedDir;
  if (!directory) return;
  const file = path.join(directory, "managed-mcp.json");
  scanSafely(context, "claude-code", "managed", file, () => {
    const snapshot = readNativeMcpSnapshot(file, "claude-code");
    if (!snapshot) return;
    // Present and parsed, even with no servers: that is how an organization turns them all off.
    context.claudeManaged = true;
    collectReadonlyServers(file, "managed", snapshot.servers, context);
  });
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
    const { endpoint, transport, hasSecretValues } = jsonServerShape(server);
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
    if (agent === "claude-code") context.raw.set(result.id, server);
    context.output.push(result);
  }
}

function jsonServerShape(server: JsonObject | undefined) {
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
  return { endpoint, transport, hasSecretValues };
}

/**
 * Servers of a Claude scope AgentKib only shows (local, managed). They are never collected or
 * migrated, so `supported` stays false and the existing guards reject them. The endpoint goes
 * through the same public view as every other candidate: credentials are never shown, only whether
 * there are any.
 */
function collectReadonlyServers(
  file: string,
  scope: "local" | "managed",
  servers: JsonObject | undefined,
  context: CandidateContext,
): void {
  if (!servers) return;
  const sourcePath = canonicalPath(file);
  for (const [name, raw] of Object.entries(servers)) {
    const server = asObject(raw);
    const shape = jsonServerShape(server);
    const text = `Read-only: this ${scope}-scope server is shown for reference. AgentKib does not collect or migrate it.`;
    const result: Candidate = {
      // The scope is part of the id: a local and a user server of one name share a file.
      id: createHash("sha256").update(`${sourcePath}:${scope}:${name}`).digest("hex").slice(0, 24),
      agent: "claude-code",
      scope,
      name,
      source_path: sourcePath,
      transport: shape.transport,
      endpoint: shape.endpoint,
      has_secret_values: shape.hasSecretValues,
      supported: false,
      warnings: [text],
      warning_messages: [mcpDiagnostic("native_readonly_scope", { scope })],
    };
    try {
      const publicConfig = publicMcpConfig(normalizeMcpImport(name, raw, "claude-code", true));
      result.endpoint =
        publicConfig.transport === "stdio" ? publicConfig.command : publicConfig.url;
    } catch {
      result.endpoint = "unavailable";
      result.warnings.push(
        "Unsupported native MCP fields or inline credentials; review the original configuration",
      );
      result.warning_messages!.push(mcpDiagnostic("native_review_configuration"));
    }
    context.raw.set(result.id, server);
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

/**
 * Entries read from Claude's global config file are only trustworthy while that file is certain to
 * be the one Claude Code reads. Otherwise they stay visible but cannot be collected or migrated.
 */
function markClaudeConfigUnusable(candidates: Candidate[], gate: ClaudeGlobalConfigGate): void {
  if (gate.usable) return;
  for (const candidate of candidates) {
    // Local entries come from the same file as user ones.
    if (candidate.agent !== "claude-code" || !["home", "local"].includes(candidate.scope)) continue;
    candidate.supported = false;
    addDiagnostic(candidate, claudeConfigUnusableWarning, "native_claude_config_unusable");
  }
}

function addDiagnostic(
  candidate: Candidate,
  text: string,
  code: string,
  params?: McpDiagnosticMessage["params"],
): void {
  // Same index in both lists: the panel shows warning_messages[i] and falls back to warnings[i].
  if (candidate.warnings.includes(text)) return;
  candidate.warnings.push(text);
  candidate.warning_messages!.push(mcpDiagnostic(code, params));
}

const scopeRank = (scope: string) => claudeScopeRank[scope] ?? 4;

type ProjectApproval = "approved" | "approved_if_trusted" | "pending" | "rejected";

/**
 * Whether Claude Code loads a `.mcp.json` server (mcp page, "Project server approvals"). An
 * approval is `enableAllProjectMcpServers` or an `enabledMcpjsonServers` entry; a
 * `disabledMcpjsonServers` entry in any file rejects. Approvals in user and managed settings count
 * at once; those in the project's or the local file wait for the workspace trust decision, which
 * AgentKib cannot see.
 */
function projectApproval(settings: ClaudeSettings | undefined, name: string): ProjectApproval {
  if (!settings) return "pending";
  const approvals = settings.mcpApprovals();
  if (approvals.disabled.has(name)) return "rejected";
  const layers = [
    ...(approvals.enableAll?.value ? [approvals.enableAll.layer] : []),
    ...(approvals.enabled.get(name) ?? []),
  ];
  if (!layers.length) return "pending";
  return layers.some((layer) => layer === "user" || layer === "managed")
    ? "approved"
    : "approved_if_trusted";
}

const wildcardMatches = (pattern: string, text: string) =>
  new RegExp(
    `^${pattern
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  ).test(text);

/** One allow or deny entry against one server: by label, by URL (with `*`), or by exact command. */
function policyMatches(
  entry: McpPolicyEntry,
  name: string,
  server: JsonObject | undefined,
): boolean {
  if (entry.serverName !== undefined) return entry.serverName === name;
  if (entry.serverUrl !== undefined) {
    const url = stringField(server, ["url", "serverUrl"]);
    return url !== undefined && wildcardMatches(entry.serverUrl, url);
  }
  if (entry.serverCommand) {
    const command = server?.command;
    const args = Array.isArray(server?.args) ? (server!.args as unknown[]) : [];
    const line =
      typeof command === "string"
        ? [command, ...args]
        : Array.isArray(command)
          ? [...command, ...args]
          : undefined;
    return (
      line !== undefined &&
      line.length === entry.serverCommand.length &&
      line.every((part, index) => part === entry.serverCommand![index])
    );
  }
  return false;
}

/**
 * Which same-named Claude Code server wins, by Claude Code's own order: a server of the
 * organization's `managedMcpServers`, then local, project, user. Nothing is hidden: a losing entry
 * stays in the list with the reason. Approval of `.mcp.json` servers and the allow and deny lists
 * come from the settings files. managed-mcp.json switches the other servers off entirely, and a
 * server from plugins or claude.ai connectors never beats one of these.
 */
function annotateClaudePrecedence(candidates: Candidate[], context: CandidateContext): void {
  const claude = candidates.filter(
    (candidate) =>
      candidate.agent === "claude-code" &&
      !candidate.warning_messages?.some((message) => message.key === nativeConfigUnavailableKey),
  );
  const scopesByName = new Map<string, Set<string>>();
  for (const candidate of claude)
    scopesByName.set(
      candidate.name,
      (scopesByName.get(candidate.name) ?? new Set()).add(candidate.scope),
    );
  const note = (candidate: Candidate, code: keyof typeof claudeDiagnosticText) =>
    addDiagnostic(candidate, claudeDiagnosticText[code], code);
  const policy = context.claudeSettings?.mcpPolicy();
  for (const candidate of claude) {
    if (candidate.scope === "project") {
      const state = projectApproval(context.claudeSettings, candidate.name);
      note(candidate, `native_project_${state}` as keyof typeof claudeDiagnosticText);
    }
    if (candidate.scope !== "managed") {
      const scopes = scopesByName.get(candidate.name)!;
      if (context.claudeProvided.has(candidate.name))
        note(candidate, "native_overridden_by_managed_setting");
      else if (context.claudeManaged) note(candidate, "native_inactive_exclusive");
      else if (candidate.scope !== "local" && scopes.has("local"))
        note(candidate, "native_overridden_by_local");
      else if (candidate.scope === "home" && scopes.has("project")) {
        const state = projectApproval(context.claudeSettings, candidate.name);
        if (state === "approved") note(candidate, "native_overridden_by_project");
        else if (state !== "rejected") note(candidate, "native_overridden_if_approved");
      }
      if (context.claudeDisabled.has(candidate.name))
        note(candidate, "native_disabled_for_project");
    }
    if (!policy) continue;
    const server = context.raw.get(candidate.id);
    if (policy.denied.some((entry) => policyMatches(entry, candidate.name, server)))
      note(candidate, "native_policy_denied");
    // managed-mcp.json and managedMcpServers need no allowlist entry; the deny list still applies.
    else if (
      candidate.scope !== "managed" &&
      policy.allowed &&
      !policy.allowed.some((entry) => policyMatches(entry, candidate.name, server))
    )
      note(candidate, "native_policy_not_allowed");
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
