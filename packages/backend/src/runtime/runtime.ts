import { z } from "zod";
import { BackendStore } from "../store/store.js";
import { scanWorkspace } from "../workspace/scanner.js";
import { loadManifest } from "../workspace/manifest.js";
import { defaultManifest } from "../adapters/manifest.js";
import { workspaceSummary, history, commitFiles, diff } from "../git/git.js";
import type { GitDiffRequest } from "../git/git.js";
import { discover } from "../discovery/discovery.js";
import { diagnoseWorkspace } from "../doctor/doctor.js";
import { listWorkspaceSessions } from "../conversations/indexer.js";
import { parseTranscript } from "../conversations/transcript.js";
import { prepareHandoff, sanitizeHandoffContent } from "../conversations/handoff.js";
import { planChangeSet, applyChangeSet } from "../changes/changeset.js";
import type { ChangeSet } from "../changes/changeset.js";
import { scanStorage } from "../storage/storage.js";
import { collectQuota, NodeQuotaRunner, selectBackend } from "../quota/quota.js";
import { backendError } from "../contracts.js";
import type { BackendMethodRegistry } from "../worker/host.js";
import {
  McpRuntimeHub,
  loadMcpConfig,
  listMcpServers,
  getMcpServer,
  saveMcpConfig,
  removeMcpServer,
  McpServer,
} from "../mcp/index.js";
import { loadGatewayConfig, listGateways, saveGatewayConfig, Gateway } from "../gateways/index.js";
import {
  planObsidianOpen,
  ObsidianVault,
  createWorkspaceLink,
  validateVaultPath,
  WorkspaceLink,
} from "../obsidian/index.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
const id = z.object({ id: z.string() });
export interface BackendRuntimeOptions {
  database_path: string;
  scan_roots?: Array<{ path: string; max_depth?: number }>;
  quota_executable?: string;
  mcp_config_path?: string;
  gateway_config_path?: string;
  mcp_registry_path?: string;
}
export function createBackendRuntime(options: BackendRuntimeOptions) {
  const store = BackendStore.open(options.database_path);
  const mcpHub = new McpRuntimeHub();
  const defaultMcpFile =
    options.mcp_config_path ?? path.join(path.dirname(options.database_path), "mcp.json");
  const defaultGatewayFile =
    options.gateway_config_path ?? path.join(path.dirname(options.database_path), "gateways.json");
  const defaultMcpRegistryFile =
    options.mcp_registry_path ??
    path.join(path.dirname(options.database_path), "mcp-registry.json");
  let latestQuota: Awaited<ReturnType<typeof collectQuota>> | undefined;
  let storageAbort: AbortController | undefined;
  let quotaPreferences: {
    hidden_providers: string[];
    hidden_windows: Array<Record<string, unknown>>;
  } = { hidden_providers: [], hidden_windows: [] };
  const obsidianVaults: ObsidianVault[] = [];
  const obsidianLinks: WorkspaceLink[] = [];
  type RegistryEntry = {
    name: string;
    description: string;
    version: string;
    package_kind: "npm" | "pypi" | "remote" | "local";
    identifier: string;
    runtime_hint?: string;
    url?: string;
    required_env: string[];
    runtime_arguments: string[];
    package_arguments: string[];
  };
  const mcpRegistry: RegistryEntry[] = [];
  const mcpInstallations = new Map<
    string,
    {
      id: string;
      name: string;
      package_kind: RegistryEntry["package_kind"];
      identifier: string;
      version?: string;
      install_path?: string;
      status: string;
      installed_at: string;
      updated_at: string;
      server_id: string;
    }
  >();
  const scanRoots = [...(options.scan_roots ?? [])];
  let runtimeSettings = {
    close_behavior: undefined as "minimize-to-tray" | "quit" | undefined,
    locale_preference: undefined as string | undefined,
    theme_preference: "system" as "system" | "light" | "dark",
    app_icon_preference: "white" as "white" | "black",
    quota_auto_refresh_enabled: false,
    quota_prompt_seen: false,
  };
  let insightsRefreshedAt: string | undefined;
  const resolveMcpFile = (params: unknown): string => {
    const value = z
      .object({ file: z.string().optional(), project: z.string().nullable().optional() })
      .parse(params);
    if (value.file) return value.file;
    if (value.project) return path.join(value.project, "mcp.json");
    return defaultMcpFile;
  };
  const resolveGatewayFile = (params: unknown): string => {
    const value = z.object({ file: z.string().optional() }).parse(params);
    return value.file ?? defaultGatewayFile;
  };
  const normalizeMcpServer = (input: unknown): McpServer => {
    const raw = z.record(z.string(), z.unknown()).parse(input);
    if (typeof raw.transport === "string") {
      const transport = raw.transport;
      const nested =
        transport === "stdio"
          ? {
              transport,
              command: raw.command,
              args: raw.args ?? [],
              env: raw.env ?? {},
              cwd: raw.cwd,
            }
          : { transport, url: raw.url, headers: raw.headers ?? {} };
      return McpServer.parse({ ...raw, transport: nested });
    }
    return McpServer.parse(raw);
  };
  const publicMcpServer = (server: McpServer): unknown => {
    const transport = server.transport;
    const { transport: _nested, ...details } = transport;
    return { ...server, ...details, transport: transport.transport };
  };
  const hubStatus = () => {
    const runtimes = mcpHub.status();
    return {
      running: true,
      bind_address: "127.0.0.1",
      port: 0,
      lan_enabled: false,
      accessible_addresses: [],
      runtime_count: runtimes.length,
      error_count: runtimes.filter((runtime) => runtime.state === "error").length,
      last_error: runtimes.find((runtime) => runtime.error)?.error,
    };
  };
  const findSession = async (sessionId: string) => {
    for (const workspace of store.listWorkspaces()) {
      for (const agent of ["codex", "claude-code"] as const) {
        const result = await listWorkspaceSessions(workspace.canonical_path, agent);
        const session = result.sessions.find((item) => item.id === sessionId);
        if (session) return session;
      }
    }
    throw backendError("NOT_FOUND", `Session not found: ${sessionId}`);
  };
  const publicWorkspace = (value: ReturnType<BackendStore["listWorkspaces"]>) =>
    value.map((workspace) => ({ ...workspace, path: workspace.canonical_path, sources: [] }));
  const registry: Record<string, (params: unknown, signal: AbortSignal) => unknown> = {
    "runtime.info": () => ({
      app_name: "AgentKib",
      app_version: "0.5.0",
      app_channel: "development",
      updates_enabled: false,
      data_dir: path.dirname(options.database_path),
      database_path: options.database_path,
      mcp_package_root: path.join(path.dirname(options.database_path), "mcp-packages"),
      mcp_hub: hubStatus(),
      mcp_network: { port: 0, lan_enabled: false, lan_risk_accepted: false },
      ...runtimeSettings,
      protocolVersion: 1,
      runtime: { name: "@agentkib/backend", version: "0.5.0" },
      pid: process.pid,
    }),
    "workspaces.list": () => publicWorkspace(store.listWorkspaces()),
    "workspace.scan": async (params, signal) => {
      const value = z
        .object({ project: z.string().optional(), root: z.string().optional() })
        .refine((item) => item.project || item.root)
        .parse(params);
      if (signal.aborted) throw backendError("CANCELLED", "Workspace scan cancelled");
      return scanWorkspace(value.project ?? value.root!);
    },
    "workspace.prepareManifest": async (params) => {
      const value = z.object({ project: z.string() }).parse(params);
      try {
        return await loadManifest(value.project);
      } catch (error) {
        if ((error as { code?: string }).code !== "NOT_FOUND") throw error;
        return defaultManifest(value.project);
      }
    },
    "workspace.refresh": async (params, signal) => {
      const value = z.object({ id: z.string() }).parse(params);
      const workspace = store.getWorkspace(value.id);
      if (signal.aborted) throw backendError("CANCELLED", "Workspace refresh cancelled");
      return scanWorkspace(workspace.canonical_path);
    },
    "workspace.doctorReport": async (params) => {
      const value = z.object({ id: z.string() }).parse(params);
      const workspace = store.getWorkspace(value.id);
      return diagnoseWorkspace(workspace.canonical_path, workspace.id);
    },
    "workspace.sessions": async (params) => {
      const value = z.object({ workspaceId: z.string() }).parse(params);
      const workspace = store.getWorkspace(value.workspaceId);
      const [codex, claude] = await Promise.all([
        listWorkspaceSessions(workspace.canonical_path, "codex"),
        listWorkspaceSessions(workspace.canonical_path, "claude-code"),
      ]);
      return [...codex.sessions, ...claude.sessions].sort(
        (a, b) =>
          (b.updated_at ?? "").localeCompare(a.updated_at ?? "") || a.id.localeCompare(b.id),
      );
    },
    "workspace.sessionStatus": async (params) => {
      const value = z.object({ workspaceId: z.string() }).parse(params);
      const workspace = store.getWorkspace(value.workspaceId);
      const [codex, claude] = await Promise.all([
        listWorkspaceSessions(workspace.canonical_path, "codex"),
        listWorkspaceSessions(workspace.canonical_path, "claude-code"),
      ]);
      return [codex.status, claude.status];
    },
    "workspace.refreshSessions": async (params, signal) => {
      if (signal.aborted) throw backendError("CANCELLED", "Session refresh cancelled");
      return registry["workspace.sessions"](params, signal);
    },
    "session.events": async (params) => {
      const value = z
        .object({
          sessionId: z.string(),
          cursor: z.string().optional(),
          limit: z.number().int().positive().max(500).optional(),
        })
        .parse(params);
      let session: { id: string; native_ref?: string; agent: "codex" | "claude-code" } | undefined;
      for (const workspace of store.listWorkspaces()) {
        const sessions = (await registry["workspace.sessions"](
          { workspaceId: workspace.id },
          new AbortController().signal,
        )) as Array<{ id: string; native_ref?: string; agent: "codex" | "claude-code" }>;
        session = sessions.find((item) => item.id === value.sessionId);
        if (session) break;
      }
      if (!session?.native_ref)
        throw backendError("NOT_FOUND", `Session not found: ${value.sessionId}`);
      return parseTranscript(
        session.native_ref,
        session.agent,
        Number(value.cursor ?? 0),
        value.limit ?? 300,
      );
    },
    "sessions.prepareHandoff": async (params) => {
      const value = z.object({ request: z.record(z.string(), z.unknown()) }).parse(params);
      const request = value.request as {
        session_id: string;
        target_agent:
          | "codex"
          | "claude-code"
          | "cursor"
          | "open-claw"
          | "hermes"
          | "deepseek-harness";
        format: "markdown" | "json";
      };
      const source = await findSession(request.session_id);
      if (!source.native_ref)
        throw backendError("NOT_FOUND", "Conversation transcript is not available");
      const events = await parseTranscript(source.native_ref, source.agent, 0, 300);
      return prepareHandoff(
        source,
        request,
        { messages: events.events, omitted_tool_count: 0, warnings: events.warnings },
        process.env.HOME,
      );
    },
    "sessions.sanitizeHandoff": (params) => {
      const value = z
        .object({ format: z.enum(["markdown", "json"]), editedContent: z.string() })
        .parse(params);
      return sanitizeHandoffContent(value.editedContent, process.env.HOME).content;
    },
    "sessions.summarizeHandoff": async (params) => {
      const value = z.object({ request: z.record(z.string(), z.unknown()) }).parse(params);
      const request = value.request as {
        session_id: string;
        target_agent:
          | "codex"
          | "claude-code"
          | "cursor"
          | "open-claw"
          | "hermes"
          | "deepseek-harness";
        format: "markdown" | "json";
      };
      const source = await findSession(request.session_id);
      if (!source.native_ref)
        throw backendError("NOT_FOUND", "Conversation transcript is not available");
      const events = await parseTranscript(source.native_ref, source.agent, 0, 300);
      const selected = events.events.slice(-20);
      const result = prepareHandoff(
        source,
        request,
        {
          messages: selected,
          omitted_tool_count: Math.max(0, events.events.length - selected.length),
          warnings: events.warnings,
        },
        process.env.HOME,
      );
      if (result.status === "ready")
        return { ...result.draft, context_source: "model-summary" as const };
      throw backendError("VALIDATION", "Handoff could not be summarized within limits");
    },
    "sessions.planHandoff": (params) => {
      const value = z
        .object({
          workspaceId: z.string(),
          filename: z.string(),
          format: z.enum(["markdown", "json"]),
          editedContent: z.string(),
          targetAgent: z.string(),
        })
        .parse(params);
      if (!/^[A-Za-z0-9._-]+\.(md|json)$/.test(value.filename))
        throw backendError("VALIDATION", "Invalid handoff filename");
      const project = store.workspacePath(value.workspaceId);
      const target = path.join(project, ".agentkib", "handoffs", value.filename);
      return {
        change_set: planChangeSet(project, [
          {
            target,
            scope: "project",
            before: "",
            after: value.editedContent,
            risk: "low",
            validator: value.format === "json" ? "json" : "markdown",
          },
        ]),
        launch_request: {
          workspace_id: value.workspaceId,
          filename: value.filename,
          target_agent: value.targetAgent,
        },
      };
    },
    "sessions.continueHandoff": async (params) => {
      const value = z
        .object({
          changeSet: z.record(z.string(), z.unknown()),
          launchRequest: z.record(z.string(), z.unknown()),
        })
        .parse(params);
      await applyChangeSet(
        value.changeSet as unknown as ChangeSet,
        path.join(path.dirname(options.database_path), "backups"),
        false,
      );
      return {
        status: "launched",
        receipt: { target_agent: String(value.launchRequest.target_agent), terminal: "pending" },
      };
    },
    "sessions.launchHandoff": (params) => {
      const value = z.object({ target_agent: z.string() }).passthrough().parse(params);
      return { target_agent: value.target_agent, terminal: "pending" };
    },
    "workspace.openers": () => [
      { id: "file-manager", name: "File manager", category: "file-manager", preferred: true },
      { id: "terminal", name: "Terminal", category: "terminal", preferred: false },
    ],
    "workspace.openWith": (params) => {
      const value = z
        .object({ workspaceId: z.string(), openerId: z.string().optional() })
        .parse(params);
      const workspace = store.getWorkspace(value.workspaceId);
      return { action: "open-path", path: workspace.canonical_path, opener_id: value.openerId };
    },
    "workspace.resolveContext": async (params) => {
      const value = z
        .object({ project: z.string(), cwd: z.string(), agent: z.string() })
        .parse(params);
      const manifest = await loadManifest(value.project).catch(() =>
        defaultManifest(value.project),
      );
      return {
        agent: value.agent,
        project: value.project,
        cwd: value.cwd,
        sections: [
          {
            source: "manifest",
            scope: "shared",
            content: manifest.instructions.shared,
            precedence: 0,
          },
        ],
        visible_skills: manifest.skills.map((skill) => skill.name),
        visible_connections: manifest.connections.map((connection) => connection.name),
        approved_memories: [],
        warnings: [],
      };
    },
    "workspace.add": async (params) =>
      store
        .addWorkspace(
          z
            .object({
              path: z.string().optional(),
              project: z.string().optional(),
              name: z.string().optional(),
              status: z.enum(["healthy", "attention"]).optional(),
            })
            .refine((value) => value.path || value.project, "Workspace path is required")
            .transform((value) => ({ ...value, path: value.path ?? value.project! }))
            .parse(params),
        )
        .then((workspace) => ({ ...workspace, path: workspace.canonical_path, sources: [] })),
    "workspace.exclude": (params) => {
      store.excludeWorkspace(id.parse(params).id);
      return { ok: true };
    },
    "workspace.restore": async (params) => {
      await store.restoreExcludedWorkspace(z.object({ path: z.string() }).parse(params).path);
      return { ok: true };
    },
    "workspace.restoreExcluded": async (params) => {
      await store.restoreExcludedWorkspace(z.object({ path: z.string() }).parse(params).path);
      return { ok: true };
    },
    "workspace.gitSummary": async (params) => {
      const value = z.object({ workspaceId: z.string() }).parse(params);
      return workspaceSummary(store.workspacePath(value.workspaceId));
    },
    "workspace.gitHistory": async (params) => {
      const value = z
        .object({ workspaceId: z.string(), query: z.record(z.string(), z.unknown()).default({}) })
        .parse(params);
      const query = value.query as {
        limit?: number;
        path?: string;
        author?: string;
        since?: string;
        until?: string;
      };
      return history(store.workspacePath(value.workspaceId), query);
    },
    "workspace.gitCommitFiles": async (params) => {
      const value = z.object({ workspaceId: z.string(), oid: z.string() }).parse(params);
      return commitFiles(store.workspacePath(value.workspaceId), value.oid);
    },
    "workspace.gitDiff": async (params) => {
      const value = z
        .object({ workspaceId: z.string(), request: z.record(z.string(), z.unknown()) })
        .parse(params);
      return diff(
        store.workspacePath(value.workspaceId),
        value.request as unknown as GitDiffRequest,
      );
    },
    "discovery.scan": async (_params, signal) => {
      if (signal.aborted) throw backendError("CANCELLED", "Discovery cancelled");
      return discover(scanRoots);
    },
    "discovery.report": async (_params, signal) => {
      if (signal.aborted) throw backendError("CANCELLED", "Discovery report cancelled");
      const started = new Date().toISOString();
      const result = await discover(scanRoots);
      return {
        started_at: started,
        finished_at: new Date().toISOString(),
        discovered_count: result.candidates.length,
        removed_count: 0,
        errors: result.errors,
      };
    },
    "discovery.refresh": async (_params, signal) => registry["discovery.report"]({}, signal),
    "discovery.listScanRoots": () =>
      scanRoots.map((root, index) => ({
        id: `${index}:${root.path}`,
        path: root.path,
        enabled: true,
        max_depth: root.max_depth ?? 5,
        created_at: new Date(0).toISOString(),
      })),
    "discovery.addScanRoot": (params) => {
      const value = z
        .object({ path: z.string(), maxDepth: z.number().int().positive().max(8) })
        .parse(params);
      if (!scanRoots.some((root) => path.resolve(root.path) === path.resolve(value.path)))
        scanRoots.push({ path: value.path, max_depth: value.maxDepth });
      return { ok: true };
    },
    "discovery.removeScanRoot": (params) => {
      const value = z.object({ id: z.string() }).parse(params);
      const index = scanRoots.findIndex((root, index) => `${index}:${root.path}` === value.id);
      if (index >= 0) scanRoots.splice(index, 1);
      return { ok: true };
    },
    "discovery.listExcludedWorkspaces": () =>
      store
        .listExcludedWorkspaces()
        .map((item) => ({ path: item.canonical_path, created_at: item.created_at })),
    "storage.scan": async (params, signal) => {
      const value = z
        .object({
          id: z.string(),
          name: z.string(),
          path: z.string(),
          excluded_roots: z.array(z.string()).optional(),
        })
        .parse(params);
      return scanStorage(value, value.excluded_roots ?? [], signal);
    },
    "memories.propose": async (params) => {
      const value = z
        .object({
          project: z.string(),
          proposal: z.object({
            memory_type: z.enum([
              "user_preference",
              "project_fact",
              "decision",
              "constraint",
              "failed_attempt",
              "open_loop",
              "task_state",
              "agent_observation",
            ]),
            content: z.string(),
            source_agent: z.string().optional(),
            source_thread: z.string().optional(),
            source_reference: z.string().optional(),
          }),
        })
        .parse(params);
      const manifest = await loadManifest(value.project);
      return store.proposeMemory({ ...value.proposal, project_id: manifest.workspace.id });
    },
    "memories.list": async (params) => {
      const value = z
        .object({
          project: z.string(),
          status: z.enum(["pending", "approved", "rejected", "invalidated"]).nullable().optional(),
        })
        .parse(params);
      const manifest = await loadManifest(value.project);
      return store.listMemories(manifest.workspace.id, value.status ?? undefined);
    },
    "memories.search": async (params) => {
      const value = z
        .object({
          project: z.string(),
          query: z.string(),
          limit: z.number().int().positive().max(500).optional(),
        })
        .parse(params);
      const manifest = await loadManifest(value.project);
      return store.searchMemories(manifest.workspace.id, value.query, value.limit);
    },
    "memories.review": (params) => {
      const value = z
        .object({
          id: z.string(),
          status: z.enum(["approved", "rejected", "invalidated"]),
          edited_content: z.string().optional(),
        })
        .parse(params);
      return store.reviewMemory(value.id, value.status, value.edited_content);
    },
    "changes.plan": (params) => {
      const value = z
        .object({
          project: z.string(),
          manifest: z.record(z.string(), z.unknown()),
          includeHome: z.boolean(),
        })
        .parse(params);
      void value.manifest;
      void value.includeHome;
      return planChangeSet(value.project, []);
    },
    "changes.apply": async (params) => {
      const value = z
        .object({ changeSet: z.record(z.string(), z.unknown()), approveHome: z.boolean() })
        .parse(params);
      return applyChangeSet(
        value.changeSet as unknown as ChangeSet,
        path.join(path.dirname(options.database_path), "backups"),
        value.approveHome,
      );
    },
    "insights.status": () => ({
      providers: ["codex", "claude-code"].map((agent) => ({
        agent,
        available: false,
        quality: "incomplete",
        imported_events: 0,
      })),
      refreshed_at: insightsRefreshedAt,
      running: false,
    }),
    "insights.refresh": () => {
      insightsRefreshedAt = new Date().toISOString();
      return registry["insights.status"]({}, new AbortController().signal);
    },
    "insights.summary": () => ({
      total_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_tokens: 0,
      reasoning_tokens: 0,
      session_count: 0,
      my_commits: 0,
      all_commits: 0,
      attributed_commits: 0,
      active_days: 0,
      current_streak: 0,
      longest_streak: 0,
      quality: "incomplete",
      refreshed_at: insightsRefreshedAt,
    }),
    "insights.view": () => ({
      summary: registry["insights.summary"]({}, new AbortController().signal),
      heatmap: [],
      agents: [],
      models: [],
      workspaces: [],
      repositories: [],
      achievements: [],
      status: registry["insights.status"]({}, new AbortController().signal),
    }),
    "insights.heatmap": () => [],
    "insights.agentUsage": () => [],
    "insights.modelUsage": () => [],
    "insights.workspaceUsage": () => [],
    "insights.repositoryCommits": () => [],
    "insights.achievements": () => [],
    "insights.gitIdentities": () => [],
    "insights.addGitIdentityAlias": (params) => {
      const value = z.object({ email: z.string().email() }).parse(params);
      return { id: value.email, label: value.email, source: "runtime", enabled: true };
    },
    "insights.setGitIdentityEnabled": (params) => {
      z.object({ id: z.string(), enabled: z.boolean() }).parse(params);
      return { ok: true };
    },
    "settings.setCloseBehavior": (params) => {
      runtimeSettings.close_behavior =
        z.object({ value: z.enum(["minimize-to-tray", "quit"]).nullable() }).parse(params).value ??
        undefined;
      return registry["runtime.info"]({}, new AbortController().signal);
    },
    "settings.setLocale": (params) => {
      runtimeSettings.locale_preference = z
        .object({ preference: z.string() })
        .parse(params).preference;
      return registry["runtime.info"]({}, new AbortController().signal);
    },
    "settings.setThemePreference": (params) => {
      runtimeSettings.theme_preference = z
        .object({ preference: z.enum(["system", "light", "dark"]) })
        .parse(params).preference;
      return registry["runtime.info"]({}, new AbortController().signal);
    },
    "settings.setAppIconPreference": (params) => {
      runtimeSettings.app_icon_preference = z
        .object({ preference: z.enum(["white", "black"]) })
        .parse(params).preference;
      return registry["runtime.info"]({}, new AbortController().signal);
    },
    "quota.collect": async (_params, signal) =>
      collectQuota(
        new NodeQuotaRunner(options.quota_executable ?? "codexbar-cli"),
        undefined,
        30_000,
        signal,
      ).then((snapshot) => {
        latestQuota = snapshot;
        return snapshot;
      }),
  };
  Object.assign(registry, {
    "mcp.hubStatus": () => hubStatus(),
    "mcp.listServers": async (params: unknown) =>
      (await listMcpServers(resolveMcpFile(params))).map((server) => publicMcpServer(server)),
    "mcp.getServer": async (params: unknown) => {
      const value = z
        .object({ id: z.string().optional(), serverId: z.string().optional() })
        .parse(params);
      return publicMcpServer(
        await getMcpServer(resolveMcpFile(params), value.id ?? value.serverId!),
      );
    },
    "mcp.saveServer": async (params: unknown) => {
      const value = z.object({ server: z.unknown() }).parse(params);
      const server = normalizeMcpServer(value.server);
      const file = resolveMcpFile(params);
      const config = await loadMcpConfig(file).catch(() => ({
        schema_version: 1,
        servers: [],
      }));
      await saveMcpConfig(file, {
        ...config,
        servers: [...config.servers.filter((item) => item.id !== server.id), server],
      });
      return publicMcpServer(server);
    },
    "mcp.saveLocalValues": async (params: unknown) => {
      const value = z
        .object({
          serverId: z.string(),
          env: z.record(z.string(), z.string()),
          headers: z.record(z.string(), z.string()),
        })
        .parse(params);
      const file = resolveMcpFile(params);
      const config = await loadMcpConfig(file);
      const server = config.servers.find((item) => item.id === value.serverId);
      if (!server) throw backendError("NOT_FOUND", `MCP server not found: ${value.serverId}`);
      const transport =
        server.transport.transport === "stdio"
          ? { ...server.transport, env: value.env }
          : { ...server.transport, headers: value.headers };
      await saveMcpConfig(file, {
        ...config,
        servers: config.servers.map((item) =>
          item.id === server.id ? { ...item, transport } : item,
        ),
      });
      return publicMcpServer({ ...server, transport });
    },
    "mcp.removeServer": async (params: unknown) => {
      const value = z
        .object({ id: z.string().optional(), serverId: z.string().optional() })
        .parse(params);
      await removeMcpServer(resolveMcpFile(params), value.id ?? value.serverId!);
      return { ok: true };
    },
    "mcp.listRuntimes": () =>
      mcpHub
        .status()
        .map((runtime) => ({ ...runtime, server_name: runtime.server_id, config_hash: "" })),
    "mcp.stopRuntime": async (params: unknown) => {
      const value = z
        .object({
          server_id: z.string().nullable().optional(),
          serverId: z.string().nullable().optional(),
        })
        .parse(params);
      const serverId = value.server_id ?? value.serverId;
      if (serverId) await mcpHub.stop(serverId);
      return { ok: true };
    },
    "mcp.probeRuntime": async (params: unknown, signal: AbortSignal) => {
      const value = z
        .object({ id: z.string().optional(), serverId: z.string().optional() })
        .parse(params);
      const config = await loadMcpConfig(resolveMcpFile(params));
      const server = config.servers.find((item) => item.id === (value.id ?? value.serverId));
      if (!server)
        throw backendError("NOT_FOUND", `MCP server not found: ${value.id ?? value.serverId}`);
      const tools = await mcpHub.listTools(server, signal);
      return { ok: true, tools };
    },
    "mcp.restartRuntime": async (params: unknown, signal: AbortSignal) => {
      const value = z
        .object({ id: z.string().optional(), serverId: z.string().optional() })
        .parse(params);
      const serverId = value.id ?? value.serverId;
      if (!serverId) throw backendError("VALIDATION", "MCP server id is required");
      await mcpHub.stop(serverId);
      const config = await loadMcpConfig(resolveMcpFile(params));
      const server = config.servers.find((item) => item.id === serverId);
      if (!server) throw backendError("NOT_FOUND", `MCP server not found: ${serverId}`);
      return mcpHub.start(server, signal);
    },
    "mcp.updateNetwork": (params: unknown) => {
      const value = z.object({ settings: z.record(z.string(), z.unknown()) }).parse(params);
      return { ...value.settings, ...hubStatus() };
    },
    "mcp.searchRegistry": (params: unknown) => {
      const value = z.object({ query: z.string().default("") }).parse(params);
      const query = value.query.toLowerCase();
      return mcpRegistry.filter((entry) =>
        `${entry.name} ${entry.description} ${entry.identifier}`.toLowerCase().includes(query),
      );
    },
    "mcp.refreshRegistry": async (params: unknown) => {
      try {
        const parsed = z
          .array(z.record(z.string(), z.unknown()))
          .parse(JSON.parse(await readFile(defaultMcpRegistryFile, "utf8")));
        const entries = parsed.map(
          (entry) =>
            z
              .object({
                name: z.string(),
                description: z.string(),
                version: z.string(),
                package_kind: z.enum(["npm", "pypi", "remote", "local"]),
                identifier: z.string(),
                runtime_hint: z.string().optional(),
                url: z.string().url().optional(),
                required_env: z.array(z.string()).default([]),
                runtime_arguments: z.array(z.string()).default([]),
                package_arguments: z.array(z.string()).default([]),
              })
              .parse(entry) as RegistryEntry,
        );
        mcpRegistry.splice(0, mcpRegistry.length, ...entries);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw backendError("VALIDATION", "MCP registry cache is invalid");
      }
      return registry["mcp.searchRegistry"](params, new AbortController().signal);
    },
    "mcp.install": async (params: unknown) => {
      const value = z
        .object({
          entry: z.record(z.string(), z.unknown()),
          project: z.string().nullable().optional(),
        })
        .parse(params);
      const entry = z
        .object({
          name: z.string(),
          description: z.string(),
          version: z.string(),
          package_kind: z.enum(["npm", "pypi", "remote", "local"]),
          identifier: z.string(),
          runtime_hint: z.string().optional(),
          url: z.string().url().optional(),
          required_env: z.array(z.string()).default([]),
          runtime_arguments: z.array(z.string()).default([]),
          package_arguments: z.array(z.string()).default([]),
        })
        .parse(value.entry) as RegistryEntry;
      if (entry.package_kind === "remote" && !entry.url)
        throw backendError("VALIDATION", "Remote MCP entries require a URL");
      const serverId = `${entry.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID().slice(0, 8)}`;
      const server: McpServer =
        entry.package_kind === "remote"
          ? {
              id: serverId,
              name: entry.name,
              enabled: true,
              allow_tools: [],
              lan_allow_tools: [],
              targets: [],
              transport: { transport: "streamable-http" as const, url: entry.url!, headers: {} },
            }
          : {
              id: serverId,
              name: entry.name,
              enabled: true,
              allow_tools: [],
              lan_allow_tools: [],
              targets: [],
              transport: {
                transport: "stdio" as const,
                command:
                  entry.package_kind === "npm"
                    ? "npx"
                    : entry.package_kind === "pypi"
                      ? "uvx"
                      : entry.identifier,
                args:
                  entry.package_kind === "npm"
                    ? [
                        "-y",
                        `${entry.identifier}@${entry.version}`,
                        ...entry.package_arguments,
                        ...entry.runtime_arguments,
                      ]
                    : [entry.identifier, ...entry.package_arguments, ...entry.runtime_arguments],
                env: {},
              },
            };
      const file = resolveMcpFile({ project: value.project });
      const config = await loadMcpConfig(file);
      await saveMcpConfig(file, { ...config, servers: [...config.servers, server] });
      const now = new Date().toISOString();
      const installation = {
        id: randomUUID(),
        name: entry.name,
        package_kind: entry.package_kind,
        identifier: entry.identifier,
        version: entry.version,
        status: "configured",
        installed_at: now,
        updated_at: now,
        server_id: server.id,
      };
      mcpInstallations.set(installation.id, installation);
      return {
        installation: { ...installation, server_id: undefined },
        server: publicMcpServer(server),
        tools: [],
      };
    },
    "mcp.update": async (params: unknown) => {
      const value = z
        .object({
          installationId: z.string(),
          entry: z.record(z.string(), z.unknown()),
          project: z.string().nullable().optional(),
        })
        .parse(params);
      const current = mcpInstallations.get(value.installationId);
      if (!current)
        throw backendError("NOT_FOUND", `MCP installation not found: ${value.installationId}`);
      const result = (await registry["mcp.install"](
        { entry: value.entry, project: value.project },
        new AbortController().signal,
      )) as { installation: unknown; server: unknown; tools: unknown[] };
      mcpInstallations.delete(value.installationId);
      return result;
    },
    "mcp.listInstallations": () =>
      [...mcpInstallations.values()].map(
        ({ server_id: _serverId, ...installation }) => installation,
      ),
    "mcp.uninstall": async (params: unknown) => {
      const value = z.object({ installationId: z.string() }).parse(params);
      const current = mcpInstallations.get(value.installationId);
      if (!current)
        throw backendError("NOT_FOUND", `MCP installation not found: ${value.installationId}`);
      mcpInstallations.delete(value.installationId);
      return { ok: true };
    },
    "mcp.scanNative": () => [],
    "mcp.planMigration": (params: unknown) => {
      const value = z
        .object({ project: z.string(), candidateIds: z.array(z.string()) })
        .parse(params);
      return planChangeSet(value.project, []);
    },
    "gateways.list": async (params: unknown) =>
      (await listGateways(resolveGatewayFile(params))).map((gateway) => ({
        id: gateway.id,
        kind: (gateway as Gateway & { kind?: string }).kind ?? "open-claw",
        name: gateway.name,
        url: gateway.base_url,
        auth_kind:
          (gateway as Gateway & { auth_kind?: string }).auth_kind ??
          (gateway.token ? "token" : "none"),
        username: (gateway as Gateway & { username?: string }).username,
        has_credentials: Boolean(gateway.token),
        state: "pending",
        capabilities: [],
        session_count: 0,
        workspaces: [],
        assets: [],
      })),
    "gateways.save": async (params: unknown) => {
      const value = z
        .object({
          gateway: Gateway.optional(),
          input: z.record(z.string(), z.unknown()).optional(),
        })
        .parse(params);
      const raw = value.gateway ?? value.input;
      if (!raw) throw backendError("VALIDATION", "Gateway input is required");
      const input = z.record(z.string(), z.unknown()).parse(raw);
      const file = resolveGatewayFile(params);
      const config = await loadGatewayConfig(file).catch(() => ({
        schema_version: 1,
        gateways: [],
      }));
      const existing = input.id ? config.gateways.find((item) => item.id === input.id) : undefined;
      const gateway = Gateway.parse({
        ...input,
        id: input.id ?? randomUUID(),
        base_url: input.base_url ?? input.url,
        token: input.token ?? input.secret ?? existing?.token,
      });
      await saveGatewayConfig(file, {
        ...config,
        gateways: [...config.gateways.filter((item) => item.id !== gateway.id), gateway],
      });
      return {
        id: gateway.id,
        kind: (gateway as Gateway & { kind?: string }).kind ?? "open-claw",
        name: gateway.name,
        url: gateway.base_url,
        auth_kind:
          (gateway as Gateway & { auth_kind?: string }).auth_kind ??
          (gateway.token ? "token" : "none"),
        username: (gateway as Gateway & { username?: string }).username,
        has_credentials: Boolean(gateway.token),
        state: "pending",
        capabilities: [],
        session_count: 0,
        workspaces: [],
        assets: [],
      };
    },
    "gateways.remove": async (params: unknown) => {
      const value = z.object({ id: z.string() }).parse(params);
      const config = await loadGatewayConfig(resolveGatewayFile(params));
      await saveGatewayConfig(resolveGatewayFile(params), {
        ...config,
        gateways: config.gateways.filter((item) => item.id !== value.id),
      });
      return { ok: true };
    },
    "gateways.refresh": async (params: unknown) => {
      const value = z.object({ id: z.string() }).parse(params);
      const gateways = await registry["gateways.list"]({}, new AbortController().signal);
      const gateway = (gateways as Array<{ id: string }>).find((item) => item.id === value.id);
      if (!gateway) throw backendError("NOT_FOUND", `Gateway not found: ${value.id}`);
      return gateway;
    },
    "obsidian.open": (params: unknown) => {
      const value = z
        .object({ vault: ObsidianVault.optional(), relative_path: z.string().optional() })
        .parse(params);
      if (!value.vault) return { action: "unavailable" };
      return planObsidianOpen(value.vault, value.relative_path);
    },
    "obsidian.integration": () => ({
      installation: { installed: false, cli_available: false },
      vaults: obsidianVaults,
      workspace_links: obsidianLinks.map((link) => ({
        workspace_id: link.workspace_id,
        vault_path: link.vault_path,
        target_path: link.relative_path,
      })),
    }),
    "obsidian.addVault": async (params: unknown) => {
      const value = z.object({ path: z.string() }).parse(params);
      const canonical = await validateVaultPath(value.path);
      const vault = ObsidianVault.parse({
        path: canonical,
        name: path.basename(canonical),
        source: "manual",
      });
      if (!obsidianVaults.some((item) => item.path === vault.path)) obsidianVaults.push(vault);
      return registry["obsidian.integration"]({}, new AbortController().signal);
    },
    "obsidian.linkWorkspace": async (params: unknown) => {
      const value = z
        .object({
          workspaceId: z.string(),
          vaultPath: z.string(),
          relativeTarget: z.string().optional(),
        })
        .parse(params);
      const workspace = store.getWorkspace(value.workspaceId);
      const vault = ObsidianVault.parse({
        path: value.vaultPath,
        name: path.basename(value.vaultPath),
        source: "manual",
      });
      const link = await createWorkspaceLink(
        workspace.canonical_path,
        vault,
        workspace.id,
        value.relativeTarget ?? workspace.name,
      );
      const existing = obsidianLinks.findIndex((item) => item.workspace_id === workspace.id);
      if (existing >= 0) obsidianLinks[existing] = link;
      else obsidianLinks.push(link);
      return {
        workspace_id: link.workspace_id,
        vault_path: link.vault_path,
        target_path: link.relative_path,
      };
    },
    "obsidian.unlinkWorkspace": (params: unknown) => {
      const value = z.object({ id: z.string() }).parse(params);
      const index = obsidianLinks.findIndex((item) => item.workspace_id === value.id);
      if (index >= 0) obsidianLinks.splice(index, 1);
      return { ok: true };
    },
    "obsidian.openWorkspace": (params: unknown) => {
      const value = z.object({ id: z.string() }).parse(params);
      const link = obsidianLinks.find((item) => item.workspace_id === value.id);
      if (!link) throw backendError("NOT_FOUND", `Obsidian link not found: ${value.id}`);
      return planObsidianOpen(
        { path: link.vault_path, name: path.basename(link.vault_path), source: "manual" },
        link.relative_path,
      );
    },
    "quota.snapshot": () => latestQuota,
    "quota.collectorStatus": () => ({
      backend: selectBackend(),
      platform_supported: true,
      sidecar_available: Boolean(options.quota_executable),
      running: false,
      config_source: "runtime",
    }),
    "quota.preferences": () => quotaPreferences,
    "quota.setPreferences": (params: unknown) => {
      const value = z
        .object({
          preferences: z.object({
            hidden_providers: z.array(z.string()),
            hidden_windows: z.array(z.record(z.string(), z.unknown())),
          }),
        })
        .parse(params);
      quotaPreferences = value.preferences;
      return quotaPreferences;
    },
    "quota.setAutoRefresh": (params: unknown) => {
      runtimeSettings.quota_auto_refresh_enabled = z
        .object({ value: z.boolean() })
        .parse(params).value;
      return registry["runtime.info"]({}, new AbortController().signal);
    },
    "quota.setPromptSeen": (params: unknown) => {
      runtimeSettings.quota_prompt_seen = z.object({ value: z.boolean() }).parse(params).value;
      return registry["runtime.info"]({}, new AbortController().signal);
    },
    "quota.refresh": async (_params: unknown, signal: AbortSignal) =>
      registry["quota.collect"]({}, signal),
    "storage.overview": async (_params: unknown, signal: AbortSignal) => {
      const workspaces = store.listWorkspaces();
      const controller = new AbortController();
      storageAbort = controller;
      const cancel = () => controller.abort();
      signal.addEventListener("abort", cancel, { once: true });
      try {
        const snapshots = await Promise.all(
          workspaces.map((item) =>
            scanStorage(
              { id: item.id, name: item.name, path: item.canonical_path },
              [],
              controller.signal,
            ),
          ),
        );
        return {
          total_workspace_count: workspaces.length,
          scanned_workspace_count: snapshots.filter((item) => item.quality !== "unavailable")
            .length,
          allocated_bytes: snapshots.reduce((sum, item) => sum + item.allocated_bytes, 0),
          logical_bytes: snapshots.reduce((sum, item) => sum + item.logical_bytes, 0),
          regenerable_bytes: snapshots.reduce((sum, item) => sum + item.regenerable_bytes, 0),
          agent_asset_bytes: snapshots.reduce((sum, item) => sum + item.agent_asset_bytes, 0),
          workspaces: snapshots,
        };
      } finally {
        signal.removeEventListener("abort", cancel);
        if (storageAbort === controller) storageAbort = undefined;
      }
    },
    "storage.refresh": async (_params: unknown, signal: AbortSignal) =>
      registry["storage.overview"]({}, signal),
    "storage.children": async (params: unknown, signal: AbortSignal) => {
      const value = z
        .object({
          workspaceId: z.string(),
          relativePath: z.string().default(""),
          relative_path: z.string().optional(),
        })
        .parse(params);
      const workspace = store.getWorkspace(value.workspaceId);
      const snapshot = await scanStorage(
        { id: workspace.id, name: workspace.name, path: workspace.canonical_path },
        [],
        signal,
      );
      let node = snapshot.root;
      for (const segment of (value.relative_path ?? value.relativePath)
        .split(/[\\/]/)
        .filter(Boolean))
        node = node?.children.find((child) => child.name === segment);
      if (!node) throw backendError("NOT_FOUND", "Storage path not found");
      return node;
    },
    "storage.resolvePath": (params: unknown) => {
      const value = z
        .object({
          workspaceId: z.string(),
          relativePath: z.string().default(""),
          relative_path: z.string().optional(),
        })
        .parse(params);
      const workspace = store.getWorkspace(value.workspaceId);
      const relativePath = value.relative_path ?? value.relativePath;
      const resolved = path.resolve(workspace.canonical_path, relativePath);
      const relative = path.relative(workspace.canonical_path, resolved);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        throw backendError("VALIDATION", "Storage path escapes workspace");
      return resolved;
    },
    "storage.cancel": () => {
      storageAbort?.abort();
      return { ok: true };
    },
  });
  return {
    registry: registry as BackendMethodRegistry,
    close: async () => {
      await mcpHub.shutdown();
      store.close();
    },
  };
}
export function createBackendRegistry(options: BackendRuntimeOptions): BackendMethodRegistry {
  return createBackendRuntime(options).registry;
}
