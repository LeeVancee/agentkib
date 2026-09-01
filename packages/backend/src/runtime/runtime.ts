import { z } from "zod";
import { BackendStore } from "../store/store.js";
import { scanWorkspace } from "../workspace/scanner.js";
import { loadManifest } from "../workspace/manifest.js";
import { resolveWorkspaceContext } from "../workspace/context.js";
import { defaultManifest } from "../adapters/manifest.js";
import { workspaceSummary, history, commitFiles, diff } from "../git/git.js";
import type { GitDiffRequest } from "../git/git.js";
import { collectGit } from "../insights/git.js";
import { collectUsage } from "../insights/usage.js";
import { planWorkspaceChanges } from "../adapters/changes.js";
import { removeNativeCandidates, scanNativeCandidates } from "../mcp/native.js";
import { discover } from "../discovery/discovery.js";
import { diagnoseWorkspace } from "../doctor/doctor.js";
import { listWorkspaceSessions } from "../conversations/indexer.js";
import { parseTranscript, readHandoffContext } from "../conversations/transcript.js";
import { prepareHandoff, sanitizeHandoffContent } from "../conversations/handoff.js";
import { planChangeSet, applyChangeSet, hashContent } from "../changes/changeset.js";
import type { ChangeSet } from "../changes/changeset.js";
import { scanStorage } from "../storage/storage.js";
import { collectQuota, NodeQuotaRunner, selectBackend } from "../quota/quota.js";
import { backendError } from "../contracts.js";
import { runManaged } from "../process/process.js";
import type { BackendMethodRegistry } from "../worker/host.js";
import {
  McpRuntimeHub,
  loadMcpConfig,
  loadEffectiveMcpConfig,
  listMcpServers,
  getMcpServer,
  saveMcpConfig,
  saveMcpLocalValues,
  removeMcpServer,
  McpServer,
  maskSecrets as maskMcpSecrets,
} from "../mcp/index.js";
import { loadGatewayConfig, listGateways, saveGatewayConfig, Gateway } from "../gateways/index.js";
import {
  planObsidianOpen,
  ObsidianVault,
  createWorkspaceLink,
  validateVaultPath,
  WorkspaceLink,
  saveStoredIntegration,
  ObsidianStored,
} from "../obsidian/index.js";
import path from "node:path";
import { createHmac, randomUUID } from "node:crypto";
import { readFile, rename, writeFile, rm, mkdtemp } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import {
  discoverOAuthServerInfo,
  registerClient,
  startAuthorization,
  exchangeAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";

function buildAchievements(
  summary: {
    total_tokens: number;
    session_count: number;
    my_commits: number;
    active_days: number;
    longest_streak: number;
  },
  workspaceCount: number,
  agentCount = 0,
) {
  const tracks: Array<[string, number[], number]> = [
    [
      "token",
      [
        100_000, 1_000_000, 10_000_000, 100_000_000, 1_000_000_000, 10_000_000_000, 100_000_000_000,
        1_000_000_000_000,
      ],
      summary.total_tokens,
    ],
    ["session", [10, 50, 100, 500, 1_000, 5_000, 10_000], summary.session_count],
    ["commit", [1, 10, 100, 1_000, 5_000, 10_000], summary.my_commits],
    ["active-days", [7, 30, 100, 365, 1_000], summary.active_days],
    ["streak", [3, 7, 14, 30, 60, 100, 180, 365], summary.longest_streak],
    ["workspaces", [1, 5, 10, 25, 50, 100], workspaceCount],
    ["agents", [1, 2, 3, 4, 5], agentCount],
  ];
  const milestones = tracks.flatMap(([category, thresholds, progress]) =>
    thresholds.map((threshold) => ({
      code: `${category}-${threshold}`,
      category,
      threshold,
      progress: Math.min(progress, threshold),
    })),
  );
  return milestones.concat(
    [
      "special-first-changeset",
      "special-first-memory",
      "special-shared-workspace",
      "special-exact-attribution",
      "special-remote-handshake",
      "special-night-owl",
      "special-comeback",
      "special-same-day-delivery",
    ].map((code) => ({ code, category: "special", threshold: 1, progress: 0 })),
  );
}

const HANDOFF_SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    objective: { type: "string" },
    completed_work: { type: "array", items: { type: "string" } },
    decisions: { type: "array", items: { type: "string" } },
    current_state: { type: "string" },
    risks: { type: "array", items: { type: "string" } },
    next_steps: { type: "array", items: { type: "string" } },
  },
  required: ["objective", "completed_work", "decisions", "current_state", "risks", "next_steps"],
} as const;

async function summarizeWithAgent(
  sourceAgent: string,
  input: string,
): Promise<{
  objective: string;
  completed_work: string[];
  decisions: string[];
  current_state: string;
  risks: string[];
  next_steps: string[];
}> {
  const temporary = await mkdtemp(path.join(tmpdir(), "agentkib-handoff-"));
  try {
    const schemaPath = path.join(temporary, "summary-schema.json");
    const outputPath = path.join(temporary, "summary-output.json");
    await writeFile(schemaPath, JSON.stringify(HANDOFF_SUMMARY_SCHEMA));
    const command =
      sourceAgent === "codex" ? "codex" : sourceAgent === "claude-code" ? "claude" : "";
    if (!command)
      throw backendError("VALIDATION", "The source Agent does not support handoff summarization");
    const result = await runManaged(
      sourceAgent === "codex"
        ? {
            executable: command,
            args: [
              "exec",
              "--ephemeral",
              "--sandbox",
              "read-only",
              "--skip-git-repo-check",
              "--ignore-user-config",
              "--ignore-rules",
              "--disable",
              "shell_tool",
              "--disable",
              "unified_exec",
              "--disable",
              "code_mode",
              "--color",
              "never",
              "--output-schema",
              schemaPath,
              "--output-last-message",
              outputPath,
              "-",
            ],
            cwd: temporary,
            input,
            timeoutMs: 120_000,
            maxOutputBytes: 64 * 1024,
          }
        : {
            executable: command,
            args: [
              "-p",
              "--no-session-persistence",
              "--safe-mode",
              "--tools",
              "",
              "--output-format",
              "json",
              "--json-schema",
              JSON.stringify(HANDOFF_SUMMARY_SCHEMA),
            ],
            cwd: temporary,
            input,
            timeoutMs: 120_000,
            maxOutputBytes: 512 * 1024,
          },
    );
    if (result.code !== 0)
      throw backendError(
        "IO",
        `${sourceAgent} handoff summarization failed: ${result.stderr.slice(0, 500)}`,
      );
    const raw = sourceAgent === "codex" ? await readFile(outputPath, "utf8") : result.stdout;
    const envelope = JSON.parse(raw) as Record<string, unknown>;
    const parsed = sourceAgent === "claude-code" ? envelope.structured_output : envelope;
    return z
      .object({
        objective: z.string(),
        completed_work: z.array(z.string()),
        decisions: z.array(z.string()),
        current_state: z.string(),
        risks: z.array(z.string()),
        next_steps: z.array(z.string()),
      })
      .parse(parsed);
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
}

const id = z.object({ id: z.string() });
type RuntimeLocale = "zh-CN" | "zh-TW" | "ja-JP" | "en-US";

function resolveSystemLocale(locale?: string): RuntimeLocale {
  const normalized = locale?.replaceAll("_", "-").toLowerCase() ?? "";
  if (/^(zh|yue)-(hant|tw|hk|mo)(-|$)/.test(normalized)) return "zh-TW";
  if (/^zh-(hans|cn|sg)(-|$)/.test(normalized) || normalized === "zh") return "zh-CN";
  if (normalized === "ja" || normalized.startsWith("ja-")) return "ja-JP";
  if (normalized === "en" || normalized.startsWith("en-")) return "en-US";
  return "en-US";
}

export interface BackendRuntimeOptions {
  database_path: string;
  scan_roots?: Array<{ path: string; max_depth?: number }>;
  /** Locale reported by the desktop host for the "follow system" preference. */
  system_locale?: string;
  quota_executable?: string;
  quota_config_path?: string;
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
  let latestQuota: Awaited<ReturnType<typeof collectQuota>> = {
    schema_version: 1,
    backend: selectBackend(),
    generated_at: new Date(0).toISOString(),
    fetched_at: new Date(0).toISOString(),
    stale_after_seconds: 300,
    freshness: "unavailable",
    providers: [],
  };
  let storageAbort: AbortController | undefined;
  let quotaPreferences: {
    hidden_providers: string[];
    hidden_windows: Array<Record<string, unknown>>;
  } = { hidden_providers: [], hidden_windows: [] };
  const obsidianVaults: ObsidianVault[] = [];
  const obsidianLinks: WorkspaceLink[] = [];
  const obsidianIntegrationFile = path.join(
    path.dirname(options.database_path),
    "obsidian-integration.json",
  );
  let storedObsidian: ObsidianStored = { manual_vaults: [], workspace_links: {} };
  try {
    storedObsidian = ObsidianStored.parse(
      JSON.parse(readFileSync(obsidianIntegrationFile, "utf8")),
    );
  } catch {
    // First run or an unreadable optional integration file.
  }
  for (const vaultPath of storedObsidian.manual_vaults) {
    obsidianVaults.push({ path: vaultPath, name: path.basename(vaultPath), source: "manual" });
  }
  for (const link of Object.values(storedObsidian.workspace_links)) obsidianLinks.push(link);
  const persistObsidian = async () =>
    saveStoredIntegration(obsidianIntegrationFile, {
      manual_vaults: obsidianVaults.map((vault) => vault.path),
      workspace_links: Object.fromEntries(obsidianLinks.map((link) => [link.workspace_id, link])),
    });
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
  const storedInstallations = store.database
    .prepare(
      "SELECT id, name, package_kind, identifier, version, install_path, status, installed_at, updated_at, server_id FROM mcp_installations ORDER BY name",
    )
    .all() as Array<Record<string, unknown>>;
  for (const row of storedInstallations) {
    mcpInstallations.set(String(row.id), {
      id: String(row.id),
      name: String(row.name),
      package_kind: String(row.package_kind) as RegistryEntry["package_kind"],
      identifier: String(row.identifier),
      version: typeof row.version === "string" ? row.version : undefined,
      install_path: typeof row.install_path === "string" ? row.install_path : undefined,
      status: String(row.status),
      installed_at: String(row.installed_at),
      updated_at: String(row.updated_at),
      server_id: typeof row.server_id === "string" ? row.server_id : "",
    });
  }
  const registryEntrySchema = z.object({
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
  });
  const loadMcpRegistry = async (): Promise<void> => {
    try {
      const parsed = z
        .array(z.record(z.string(), z.unknown()))
        .parse(JSON.parse(await readFile(defaultMcpRegistryFile, "utf8")));
      mcpRegistry.splice(
        0,
        mcpRegistry.length,
        ...parsed.map((entry) => registryEntrySchema.parse(entry) as RegistryEntry),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw backendError("VALIDATION", "MCP registry cache is invalid");
    }
  };
  const scanRoots = [...(options.scan_roots ?? [])];
  let runtimeSettings = {
    close_behavior: undefined as "minimize-to-tray" | "quit" | undefined,
    locale_preference: undefined as string | undefined,
    theme_preference: "system" as "system" | "light" | "dark",
    app_icon_preference: "white" as "white" | "black",
    quota_auto_refresh_enabled: false,
    quota_prompt_seen: false,
  };
  let mcpNetwork: {
    port: number;
    lan_enabled: boolean;
    lan_risk_accepted: boolean;
  } = { port: 47_653, lan_enabled: false, lan_risk_accepted: false };
  const preferencesPath = path.join(path.dirname(options.database_path), "preferences.json");
  let sessionIndexEnabled = true;
  let onboarding = {
    version: 1,
    acknowledged_version: 0,
    workspace_id: undefined as string | undefined,
    doctor_completed: false,
    repairable_count: 0,
    repair_applied: false,
  };
  try {
    const root = JSON.parse(readFileSync(preferencesPath, "utf8")) as Record<string, unknown>;
    if (typeof root.session_index_enabled === "boolean")
      sessionIndexEnabled = root.session_index_enabled;
    if (root.close_behavior === "minimize-to-tray" || root.close_behavior === "quit")
      runtimeSettings.close_behavior = root.close_behavior;
    if (
      root.locale_preference === "system" ||
      root.locale_preference === "zh-CN" ||
      root.locale_preference === "zh-TW" ||
      root.locale_preference === "ja-JP" ||
      root.locale_preference === "en-US"
    )
      runtimeSettings.locale_preference = root.locale_preference;
    if (
      root.theme_preference === "system" ||
      root.theme_preference === "light" ||
      root.theme_preference === "dark"
    )
      runtimeSettings.theme_preference = root.theme_preference;
    if (root.app_icon_preference === "white" || root.app_icon_preference === "black")
      runtimeSettings.app_icon_preference = root.app_icon_preference;
    if (typeof root.quota_auto_refresh_enabled === "boolean")
      runtimeSettings.quota_auto_refresh_enabled = root.quota_auto_refresh_enabled;
    if (typeof root.quota_auto_refresh_prompt_seen === "boolean")
      runtimeSettings.quota_prompt_seen = root.quota_auto_refresh_prompt_seen;
    if (root.mcp_network && typeof root.mcp_network === "object") {
      const network = root.mcp_network as Record<string, unknown>;
      if (
        Number.isInteger(network.port) &&
        Number(network.port) >= 1 &&
        Number(network.port) <= 65_535
      )
        mcpNetwork.port = Number(network.port);
      if (typeof network.lan_enabled === "boolean") mcpNetwork.lan_enabled = network.lan_enabled;
      if (typeof network.lan_risk_accepted === "boolean")
        mcpNetwork.lan_risk_accepted = network.lan_risk_accepted;
    }
    if (root.quota_preferences && typeof root.quota_preferences === "object") {
      const quota = root.quota_preferences as Record<string, unknown>;
      if (
        Array.isArray(quota.hidden_providers) &&
        Array.isArray(quota.hidden_windows) &&
        quota.hidden_providers.every((item) => typeof item === "string") &&
        quota.hidden_windows.every((item) => typeof item === "object" && item !== null)
      ) {
        quotaPreferences = {
          hidden_providers: quota.hidden_providers as string[],
          hidden_windows: quota.hidden_windows as Array<Record<string, unknown>>,
        };
      }
    }
    if (root.onboarding && typeof root.onboarding === "object")
      onboarding = { ...onboarding, ...(root.onboarding as Partial<typeof onboarding>) };
  } catch {
    // First run: defaults above are the compatible Rust defaults.
  }
  const persistPreferences = async (updates: Record<string, unknown>): Promise<void> => {
    let root: Record<string, unknown> = {};
    try {
      root = JSON.parse(await readFile(preferencesPath, "utf8")) as Record<string, unknown>;
    } catch {
      // The preferences file is optional on first run.
    }
    const temp = `${preferencesPath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temp, JSON.stringify({ ...root, ...updates }, null, 2) + "\n", { mode: 0o600 });
    await rename(temp, preferencesPath);
  };
  let insightsRefreshedAt: string | undefined;
  let catalogInitialized = false;
  type InsightQuery = {
    from?: string;
    to?: string;
    agent?: string;
    workspace_id?: string;
    repository_group_id?: string;
  };
  const insightQuery = (params: unknown): InsightQuery => {
    const query = z.object({
      from: z.string().optional(),
      to: z.string().optional(),
      agent: z.string().optional(),
      workspace_id: z.string().optional(),
      repository_group_id: z.string().optional(),
    });
    const envelope = z.object({ query: z.unknown().optional() }).safeParse(params);
    return query.parse(
      envelope.success && envelope.data.query !== undefined ? envelope.data.query : (params ?? {}),
    );
  };
  const buildInsightsView = (query: InsightQuery) => {
    const from = query.from ?? `${new Date().getFullYear()}-01-01`;
    const to = query.to ?? new Date().toISOString().slice(0, 10);
    const usage = store.database
      .prepare(
        "SELECT COALESCE(SUM(u.total_tokens),0) total, COALESCE(SUM(u.input_tokens),0) input, COALESCE(SUM(u.output_tokens),0) output, COALESCE(SUM(u.cache_read_tokens + u.cache_write_tokens),0) cache, COALESCE(SUM(u.reasoning_tokens),0) reasoning, COALESCE(SUM(u.session_count),0) sessions, MAX(CASE u.quality WHEN 'incomplete' THEN 2 WHEN 'estimated' THEN 1 ELSE 0 END) quality FROM usage_events u LEFT JOIN workspaces w ON w.id=u.workspace_id WHERE u.day>=? AND u.day<=? AND (? IS NULL OR u.surface_agent=?) AND (? IS NULL OR u.workspace_id=?) AND (? IS NULL OR w.repository_group_id=?)",
      )
      .get(
        from,
        to,
        query.agent ?? null,
        query.agent ?? null,
        query.workspace_id ?? null,
        query.workspace_id ?? null,
        query.repository_group_id ?? null,
        query.repository_group_id ?? null,
      ) as Record<string, unknown>;
    const commits = store.database
      .prepare(
        "SELECT COALESCE(SUM(is_mine),0) my_commits, COUNT(*) all_commits, COALESCE(SUM(EXISTS(SELECT 1 FROM commit_attributions a WHERE a.repository_group_id=c.repository_group_id AND a.commit_hash=c.commit_hash AND a.confidence='exact' AND (? IS NULL OR a.agent=?))),0) attributed_commits FROM git_commits c WHERE c.day>=? AND c.day<=? AND (? IS NULL OR c.repository_group_id=?)",
      )
      .get(
        query.agent ?? null,
        query.agent ?? null,
        from,
        to,
        query.repository_group_id ?? null,
        query.repository_group_id ?? null,
      ) as Record<string, unknown>;
    const heatmap = new Map<
      string,
      {
        date: string;
        tokens: number;
        my_commits: number;
        all_commits: number;
        attributed_commits: number;
        sessions: number;
        quality: "exact" | "estimated" | "incomplete";
      }
    >();
    const firstDay = new Date(`${from}T00:00:00Z`);
    const lastDay = new Date(`${to}T00:00:00Z`);
    if (!Number.isNaN(firstDay.getTime()) && !Number.isNaN(lastDay.getTime())) {
      for (const day = new Date(firstDay); day <= lastDay; day.setUTCDate(day.getUTCDate() + 1)) {
        const date = day.toISOString().slice(0, 10);
        heatmap.set(date, {
          date,
          tokens: 0,
          my_commits: 0,
          all_commits: 0,
          attributed_commits: 0,
          sessions: 0,
          quality: "exact",
        });
      }
    }
    const usageHeatRows = store.database
      .prepare(
        "SELECT u.day, COALESCE(SUM(u.total_tokens),0) tokens, COALESCE(SUM(u.session_count),0) sessions, MAX(CASE u.quality WHEN 'incomplete' THEN 2 WHEN 'estimated' THEN 1 ELSE 0 END) quality FROM usage_events u LEFT JOIN workspaces w ON w.id=u.workspace_id WHERE u.day>=? AND u.day<=? AND (? IS NULL OR u.surface_agent=?) AND (? IS NULL OR u.workspace_id=?) AND (? IS NULL OR w.repository_group_id=?) GROUP BY u.day",
      )
      .all(
        from,
        to,
        query.agent ?? null,
        query.agent ?? null,
        query.workspace_id ?? null,
        query.workspace_id ?? null,
        query.repository_group_id ?? null,
        query.repository_group_id ?? null,
      ) as Array<Record<string, unknown>>;
    for (const row of usageHeatRows) {
      const point = heatmap.get(String(row.day));
      if (!point) continue;
      point.tokens = Number(row.tokens);
      point.sessions = Number(row.sessions);
      point.quality =
        Number(row.quality) === 2
          ? "incomplete"
          : Number(row.quality) === 1
            ? "estimated"
            : "exact";
    }
    const commitHeatRows = store.database
      .prepare(
        "SELECT day, COALESCE(SUM(is_mine),0) my_commits, COUNT(*) all_commits, COALESCE(SUM(EXISTS(SELECT 1 FROM commit_attributions a WHERE a.repository_group_id=git_commits.repository_group_id AND a.commit_hash=git_commits.commit_hash AND a.confidence='exact' AND (? IS NULL OR a.agent=?))),0) attributed_commits FROM git_commits WHERE day>=? AND day<=? AND (? IS NULL OR repository_group_id=?) GROUP BY day ORDER BY day",
      )
      .all(
        query.agent ?? null,
        query.agent ?? null,
        from,
        to,
        query.repository_group_id ?? null,
        query.repository_group_id ?? null,
      ) as Array<Record<string, unknown>>;
    for (const row of commitHeatRows) {
      const point = heatmap.get(String(row.day));
      if (!point) continue;
      point.my_commits = Number(row.my_commits);
      point.all_commits = Number(row.all_commits);
      point.attributed_commits = Number(row.attributed_commits);
    }
    const heatmapPoints = [...heatmap.values()];
    const activeDates = heatmapPoints
      .filter((point) => point.tokens > 0 || point.sessions > 0 || point.my_commits > 0)
      .map((point) => point.date);
    const repositories = store.database
      .prepare(
        "SELECT c.repository_group_id, COALESCE(MIN(w.name),'Repository') name, COALESCE(SUM(c.is_mine),0) my_commits, COUNT(*) all_commits, COALESCE(SUM(EXISTS(SELECT 1 FROM commit_attributions a WHERE a.repository_group_id=c.repository_group_id AND a.commit_hash=c.commit_hash AND a.confidence='exact' AND (? IS NULL OR a.agent=?))),0) attributed_commits FROM git_commits c LEFT JOIN workspaces w ON w.repository_group_id=c.repository_group_id WHERE c.day>=? AND c.day<=? AND (? IS NULL OR c.repository_group_id=?) GROUP BY c.repository_group_id ORDER BY all_commits DESC",
      )
      .all(
        query.agent ?? null,
        query.agent ?? null,
        from,
        to,
        query.repository_group_id ?? null,
        query.repository_group_id ?? null,
      );
    const agents = store.database
      .prepare(
        "SELECT u.surface_agent agent, COALESCE(SUM(u.total_tokens),0) total_tokens, COALESCE(SUM(u.input_tokens),0) input_tokens, COALESCE(SUM(u.output_tokens),0) output_tokens, COALESCE(SUM(u.cache_read_tokens+u.cache_write_tokens),0) cache_tokens, COALESCE(SUM(u.reasoning_tokens),0) reasoning_tokens, COALESCE(SUM(u.session_count),0) session_count FROM usage_events u LEFT JOIN workspaces w ON w.id=u.workspace_id WHERE u.day>=? AND u.day<=? AND (? IS NULL OR u.surface_agent=?) AND (? IS NULL OR u.workspace_id=?) AND (? IS NULL OR w.repository_group_id=?) GROUP BY u.surface_agent ORDER BY total_tokens DESC",
      )
      .all(
        from,
        to,
        query.agent ?? null,
        query.agent ?? null,
        query.workspace_id ?? null,
        query.workspace_id ?? null,
        query.repository_group_id ?? null,
        query.repository_group_id ?? null,
      );
    const models = store.database
      .prepare(
        "SELECT COALESCE(NULLIF(u.model,''),'__unknown_model__') model, COALESCE(SUM(u.total_tokens),0) total_tokens, COALESCE(SUM(u.session_count),0) session_count FROM usage_events u LEFT JOIN workspaces w ON w.id=u.workspace_id WHERE u.day>=? AND u.day<=? AND (? IS NULL OR u.surface_agent=?) AND (? IS NULL OR u.workspace_id=?) AND (? IS NULL OR w.repository_group_id=?) GROUP BY model ORDER BY total_tokens DESC LIMIT 20",
      )
      .all(
        from,
        to,
        query.agent ?? null,
        query.agent ?? null,
        query.workspace_id ?? null,
        query.workspace_id ?? null,
        query.repository_group_id ?? null,
        query.repository_group_id ?? null,
      );
    const workspaces = store.database
      .prepare(
        "SELECT u.workspace_id, COALESCE(w.name,'__unlinked_workspace__') name, COALESCE(SUM(u.total_tokens),0) total_tokens, COALESCE(SUM(u.session_count),0) session_count FROM usage_events u LEFT JOIN workspaces w ON w.id=u.workspace_id WHERE u.day>=? AND u.day<=? AND (? IS NULL OR u.surface_agent=?) AND (? IS NULL OR u.workspace_id=?) AND (? IS NULL OR w.repository_group_id=?) GROUP BY u.workspace_id, w.name HAVING total_tokens>0 OR session_count>0 ORDER BY total_tokens DESC",
      )
      .all(
        from,
        to,
        query.agent ?? null,
        query.agent ?? null,
        query.workspace_id ?? null,
        query.workspace_id ?? null,
        query.repository_group_id ?? null,
        query.repository_group_id ?? null,
      );
    const sortedActive = activeDates.slice().sort();
    let longestStreak = 0;
    let runningStreak = 0;
    let previous: Date | undefined;
    for (const date of sortedActive) {
      const current = new Date(`${date}T00:00:00Z`);
      if (previous && current.getTime() - previous.getTime() === 86_400_000) runningStreak += 1;
      else runningStreak = 1;
      longestStreak = Math.max(longestStreak, runningStreak);
      previous = current;
    }
    let currentStreak = 0;
    if (sortedActive.length) {
      const today = new Date(`${to}T00:00:00Z`);
      const last = new Date(`${sortedActive.at(-1)}T00:00:00Z`);
      if (today.getTime() - last.getTime() <= 86_400_000) {
        currentStreak = 1;
        for (let index = sortedActive.length - 1; index > 0; index -= 1) {
          const a = new Date(`${sortedActive[index]}T00:00:00Z`).getTime();
          const b = new Date(`${sortedActive[index - 1]}T00:00:00Z`).getTime();
          if (a - b !== 86_400_000) break;
          currentStreak += 1;
        }
      }
    }
    const summary = {
      total_tokens: Number(usage.total),
      input_tokens: Number(usage.input),
      output_tokens: Number(usage.output),
      cache_tokens: Number(usage.cache),
      reasoning_tokens: Number(usage.reasoning),
      session_count: Number(usage.sessions),
      my_commits: Number(commits.my_commits),
      all_commits: Number(commits.all_commits),
      attributed_commits: Number(commits.attributed_commits),
      active_days: activeDates.length,
      current_streak: currentStreak,
      longest_streak: longestStreak,
      quality:
        Number(usage.quality) === 2
          ? ("incomplete" as const)
          : Number(usage.quality) === 1
            ? ("estimated" as const)
            : ("exact" as const),
      coverage_from: activeDates[0],
      coverage_to: activeDates.at(-1),
      refreshed_at: insightsRefreshedAt,
    };
    return {
      summary: {
        ...summary,
      },
      heatmap: heatmapPoints,
      agents,
      models,
      workspaces,
      repositories,
      achievements: buildAchievements(
        summary,
        Number(workspaces.length),
        agents.filter(
          (agent) =>
            Number((agent as Record<string, unknown>).total_tokens) > 0 ||
            Number((agent as Record<string, unknown>).session_count) > 0,
        ).length,
      ),
      status: registry["insights.status"]({}, new AbortController().signal),
    };
  };
  const refreshInsights = async () => {
    const usageBatches = await collectUsage();
    for (const batch of usageBatches) store.syncUsageBatch(batch);
    for (const workspace of store.listWorkspaces()) {
      const snapshot = await collectGit(workspace.canonical_path);
      if (snapshot) store.syncGitSnapshot(snapshot);
    }
    insightsRefreshedAt = new Date().toISOString();
    return registry["insights.status"]({}, new AbortController().signal);
  };
  const resolveMcpFile = (params: unknown): string => {
    const value = z
      .object({ file: z.string().optional(), project: z.string().nullable().optional() })
      .parse(params);
    if (value.file) return value.file;
    if (value.project) return path.join(value.project, ".agentkib", "mcp.json");
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
    const safe = maskMcpSecrets(server) as McpServer;
    const transport = safe.transport;
    const { transport: _nested, ...details } = transport;
    const { transport: _serverTransport, ...serverDetails } = safe;
    return { ...serverDetails, ...details, transport: transport.transport };
  };
  let mcpNetworkServer: Server | undefined;
  const pendingMcpOAuth = new Map<
    string,
    {
      serverId: string;
      project?: string;
      authorizationServer: string;
      client: Record<string, unknown>;
      codeVerifier: string;
      redirectUri: string;
    }
  >();
  const hubStatus = () => {
    const runtimes = mcpHub.status();
    return {
      running: true,
      bind_address: mcpNetwork.lan_enabled ? "0.0.0.0" : "127.0.0.1",
      port: mcpNetwork.port,
      lan_enabled: mcpNetwork.lan_enabled,
      accessible_addresses: [
        `http://${mcpNetwork.lan_enabled ? "0.0.0.0" : "127.0.0.1"}:${mcpNetwork.port}`,
      ],
      runtime_count: runtimes.filter((runtime) => runtime.state === "running").length,
      error_count: runtimes.filter((runtime) => runtime.state === "error").length,
      last_error: runtimes.find((runtime) => runtime.error)?.error,
    };
  };
  const startMcpNetwork = async (): Promise<void> => {
    if (mcpNetworkServer) return;
    const host = mcpNetwork.lan_enabled ? "0.0.0.0" : "127.0.0.1";
    const server = createServer(async (request, response) => {
      if (request.url === "/healthz") {
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        response.end("ok");
        return;
      }
      const parsed = new URL(request.url ?? "/", `http://127.0.0.1:${mcpNetwork.port}`);
      const match = parsed.pathname.match(/^\/oauth\/callback\/([^/]+)$/);
      if (request.method === "GET" && match) {
        const state = parsed.searchParams.get("state");
        const code = parsed.searchParams.get("code");
        const pending = state ? pendingMcpOAuth.get(state) : undefined;
        if (!pending || !code) {
          response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
          response.end("AgentKib MCP authorization failed.");
          return;
        }
        try {
          const tokens = await exchangeAuthorization(pending.authorizationServer, {
            clientInformation: pending.client as never,
            authorizationCode: code,
            codeVerifier: pending.codeVerifier,
            redirectUri: pending.redirectUri,
          });
          const file = resolveMcpFile({ project: pending.project });
          const config = await loadMcpConfig(file);
          const serverConfig = config.servers.find((item) => item.id === pending.serverId);
          if (!serverConfig) throw new Error("MCP server no longer exists");
          const localFile = path.join(path.dirname(file), "mcp.local.json");
          const local = await loadMcpConfig(localFile);
          const localServer = { ...serverConfig, oauth_credentials: tokens };
          await saveMcpConfig(localFile, {
            ...local,
            servers: [...local.servers.filter((item) => item.id !== pending.serverId), localServer],
          });
          pendingMcpOAuth.delete(state!);
          response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          response.end("AgentKib MCP authorization completed. You can close this window.");
        } catch {
          pendingMcpOAuth.delete(state!);
          response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
          response.end("AgentKib MCP authorization failed.");
        }
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(mcpNetwork.port, host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    mcpNetworkServer = server;
  };
  const stopMcpNetwork = async (): Promise<void> => {
    const server = mcpNetworkServer;
    mcpNetworkServer = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
    value.map((workspace) => ({
      ...workspace,
      path: workspace.canonical_path,
      sources: store.listWorkspaceSources(workspace.id).map((source) => ({
        ...(typeof source.agent === "string" && source.agent !== "unknown"
          ? { agent: source.agent }
          : {}),
        evidence: source.evidence,
        session_count: Number(source.session_count ?? 0),
        ...(typeof source.last_active_at === "string"
          ? { last_active_at: source.last_active_at }
          : {}),
      })),
    }));
  const scanAndRecord = async (workspacePath: string) => {
    const result = await scanWorkspace(workspacePath);
    const workspace = store
      .listWorkspaces()
      .find((item) => path.resolve(item.canonical_path) === path.resolve(workspacePath));
    if (workspace) store.recordWorkspaceScan(workspace.canonical_path, result);
    return result;
  };
  const ensureCatalog = async () => {
    if (catalogInitialized) return;
    catalogInitialized = true;
    for (const workspace of store.listWorkspaces()) {
      await scanAndRecord(workspace.canonical_path);
    }
  };
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
      mcp_network: mcpNetwork,
      ...runtimeSettings,
      locale_preference: runtimeSettings.locale_preference ?? "system",
      effective_locale:
        (runtimeSettings.locale_preference && runtimeSettings.locale_preference !== "system"
          ? runtimeSettings.locale_preference
          : undefined) ?? resolveSystemLocale(options.system_locale ?? process.env.LANG),
      effective_theme:
        runtimeSettings.theme_preference === "system" ? "light" : runtimeSettings.theme_preference,
      tray_available: true,
      quota_auto_refresh_prompt_seen: runtimeSettings.quota_prompt_seen,
      session_index_enabled: sessionIndexEnabled,
      onboarding,
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
      return scanAndRecord(value.project ?? value.root!);
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
      return scanAndRecord(workspace.canonical_path);
    },
    "workspace.doctorReport": async (params) => {
      const value = z.object({ id: z.string() }).parse(params);
      const workspace = store.getWorkspace(value.id);
      const installedAgents = new Set(
        store
          .listAgentInstallations()
          .filter((installation) => installation.installed)
          .map((installation) => installation.agent)
          .filter((agent): agent is import("../domain/types.js").AgentKind =>
            ["codex", "claude-code", "cursor", "open-claw", "hermes", "deepseek-harness"].includes(
              agent as never,
            ),
          ),
      );
      return diagnoseWorkspace(workspace.canonical_path, workspace.id, { installedAgents });
    },
    "workspace.doctorSummaries": async (params) => {
      const value = z.object({ workspaceIds: z.array(z.string()).max(100) }).parse(params);
      const summaries = await Promise.all(
        value.workspaceIds.map(async (workspaceId) => {
          try {
            const report = await registry["workspace.doctorReport"](
              { id: workspaceId },
              new AbortController().signal,
            );
            return (report as { summary: unknown }).summary;
          } catch {
            return {
              workspace_id: workspaceId,
              error_count: 1,
              warning_count: 0,
              info_count: 0,
              repairable_count: 0,
              checked_at: new Date().toISOString(),
            };
          }
        }),
      );
      return summaries;
    },
    "workspace.sessions": async (params) => {
      const value = z.object({ workspaceId: z.string() }).parse(params);
      if (!sessionIndexEnabled) return [];
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
        value.cursor === undefined ? undefined : Number(value.cursor),
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
      const handoff = await readHandoffContext(source.native_ref, source.agent, source.sidechain);
      return prepareHandoff(source, request, handoff, process.env.HOME);
    },
    "sessions.sanitizeHandoff": (params) => {
      const value = z
        .object({ format: z.enum(["markdown", "json"]), editedContent: z.string() })
        .parse(params);
      return sanitizeHandoffContent(value.editedContent, process.env.HOME).content;
    },
    "sessions.clearIndex": async (params) => {
      const value = z.object({ workspaceId: z.string().optional() }).parse(params);
      if (value.workspaceId) {
        store.database
          .prepare("DELETE FROM conversation_sessions WHERE workspace_id = ?")
          .run(value.workspaceId);
        store.database
          .prepare("DELETE FROM conversation_index_status WHERE workspace_id = ?")
          .run(value.workspaceId);
      } else {
        store.database.exec(
          "DELETE FROM conversation_sessions; DELETE FROM conversation_index_status;",
        );
      }
      return undefined;
    },
    "sessions.setIndexEnabled": async (params) => {
      sessionIndexEnabled = z.object({ value: z.boolean() }).parse(params).value;
      if (!sessionIndexEnabled) await persistPreferences({ session_index_enabled: false });
      else await persistPreferences({ session_index_enabled: true });
      return registry["runtime.info"]({}, new AbortController().signal);
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
      const handoff = await readHandoffContext(source.native_ref, source.agent, source.sidechain);
      const selected = handoff.messages;
      const result = prepareHandoff(
        source,
        request,
        {
          messages: selected,
          omitted_tool_count: handoff.omitted_tool_count,
          warnings: handoff.warnings,
          compact_summary: handoff.compact_summary,
        },
        process.env.HOME,
      );
      if (result.status === "ready") return result.draft;
      const input = selected
        .map(
          (event) =>
            `${event.kind}${event.tool_name ? ` (${event.tool_name})` : ""}: ${event.content ?? ""}`,
        )
        .join("\n\n");
      if (Buffer.byteLength(input) > 1024 * 1024)
        throw backendError(
          "VALIDATION",
          "Conversation exceeds the 1 MiB summary input limit; compact it in the source Agent first",
        );
      const summary = await summarizeWithAgent(source.agent, input);
      const safeSummary = sanitizeHandoffContent(
        [
          `Objective: ${summary.objective}`,
          `Completed work: ${summary.completed_work.join("; ")}`,
          `Decisions: ${summary.decisions.join("; ")}`,
          `Current state: ${summary.current_state}`,
          `Risks: ${summary.risks.join("; ")}`,
          `Next steps: ${summary.next_steps.join("; ")}`,
        ].join("\n"),
        process.env.HOME,
      );
      const generated = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `handoff-${source.agent}-${request.target_agent}-${generated}.${request.format === "json" ? "json" : "md"}`;
      const content =
        request.format === "json"
          ? JSON.stringify(
              {
                session_id: source.id,
                source_agent: source.agent,
                target_agent: request.target_agent,
                summary,
              },
              null,
              2,
            ) + "\n"
          : `# Agent handoff\n\nSource: ${source.agent}\nTarget: ${request.target_agent}\n\n## Summary\n\n${safeSummary.content}\n`;
      if (Buffer.byteLength(content) > 512 * 1024)
        throw backendError("VALIDATION", "Rendered handoff exceeds 512 KiB");
      return {
        filename,
        format: request.format,
        content,
        redaction_count: safeSummary.redaction_count,
        included_message_count: selected.length,
        omitted_tool_count: handoff.omitted_tool_count,
        context_source: "model-summary" as const,
        warnings: handoff.warnings,
      };
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
      const targetAgent = String(value.launchRequest.target_agent);
      if (targetAgent !== "codex" && targetAgent !== "claude-code")
        throw backendError("VALIDATION", "target Agent does not support interactive continuation");
      return {
        status: "launched",
        receipt: { target_agent: targetAgent, terminal: "pending" },
        launch: {
          command: targetAgent === "codex" ? "codex" : "claude",
          args:
            targetAgent === "codex"
              ? [
                  "-c",
                  `developer_instructions='This is a fresh session continuing from a handoff. Before responding to the first user message, read the project-relative file .agentkib/handoffs/${String(value.launchRequest.filename)}.'`,
                ]
              : [
                  "--append-system-prompt",
                  `This is a fresh session continuing from a handoff. Before responding to the first user message, read the project-relative file .agentkib/handoffs/${String(value.launchRequest.filename)}.`,
                ],
          cwd: path.resolve(store.workspacePath(String(value.launchRequest.workspace_id))),
        },
      };
    },
    "sessions.launchHandoff": (params) => {
      const value = z
        .object({ workspace_id: z.string(), filename: z.string(), target_agent: z.string() })
        .parse(params);
      if (!/^[A-Za-z0-9._-]+\.(md|json)$/.test(value.filename))
        throw backendError("VALIDATION", "Invalid handoff filename");
      const targetAgent = value.target_agent;
      if (targetAgent !== "codex" && targetAgent !== "claude-code")
        throw backendError("VALIDATION", "target Agent does not support interactive continuation");
      const project = path.resolve(store.workspacePath(value.workspace_id));
      const handoff = path.join(project, ".agentkib", "handoffs", value.filename);
      try {
        readFileSync(handoff, "utf8");
      } catch {
        throw backendError("NOT_FOUND", "Handoff file not found");
      }
      return {
        target_agent: targetAgent,
        terminal: "pending",
        launch: {
          command: targetAgent === "codex" ? "codex" : "claude",
          args:
            targetAgent === "codex"
              ? [
                  "-c",
                  `developer_instructions='This is a fresh session continuing from a handoff. Before responding to the first user message, read the project-relative file .agentkib/handoffs/${value.filename}.'`,
                ]
              : [
                  "--append-system-prompt",
                  `This is a fresh session continuing from a handoff. Before responding to the first user message, read the project-relative file .agentkib/handoffs/${value.filename}.`,
                ],
          cwd: project,
        },
      };
    },
    "onboarding.update": async (params) => {
      const value = z
        .object({
          event: z.discriminatedUnion("event", [
            z.object({
              event: z.literal("doctor-completed"),
              workspace_id: z.string(),
              repairable_count: z.number().int().nonnegative(),
            }),
            z.object({ event: z.literal("repair-applied"), workspace_id: z.string() }),
            z.object({ event: z.literal("dismissed") }),
            z.object({ event: z.literal("restarted") }),
          ]),
        })
        .parse(params);
      switch (value.event.event) {
        case "doctor-completed":
          if (onboarding.workspace_id !== value.event.workspace_id)
            onboarding.repair_applied = false;
          onboarding = {
            ...onboarding,
            workspace_id: value.event.workspace_id,
            doctor_completed: true,
            repairable_count: value.event.repairable_count,
            acknowledged_version:
              value.event.repairable_count === 0
                ? onboarding.version
                : onboarding.acknowledged_version,
          };
          break;
        case "repair-applied":
          onboarding = {
            ...onboarding,
            workspace_id: value.event.workspace_id,
            repair_applied: true,
          };
          break;
        case "dismissed":
          onboarding = { ...onboarding, acknowledged_version: onboarding.version };
          break;
        case "restarted":
          onboarding = {
            version: 1,
            acknowledged_version: 0,
            workspace_id: undefined,
            doctor_completed: false,
            repairable_count: 0,
            repair_applied: false,
          };
          break;
      }
      await persistPreferences({ onboarding });
      return registry["runtime.info"]({}, new AbortController().signal);
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
        .object({
          project: z.string(),
          cwd: z.string(),
          agent: z.enum([
            "codex",
            "claude-code",
            "cursor",
            "open-claw",
            "hermes",
            "deepseek-harness",
          ]),
        })
        .parse(params);
      const manifest = await loadManifest(value.project).catch(() =>
        defaultManifest(value.project),
      );
      return resolveWorkspaceContext(value.project, value.cwd, value.agent, manifest);
    },
    "workspace.add": async (params) => {
      const workspace = await store.addWorkspace(
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
      );
      await scanAndRecord(workspace.canonical_path);
      return {
        ...workspace,
        path: workspace.canonical_path,
        sources: store.listWorkspaceSources(workspace.id),
      };
    },
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
      const value = z
        .object({ workspaceId: z.string().optional(), id: z.string().optional() })
        .refine((input) => input.workspaceId || input.id, "Workspace id is required")
        .parse(params);
      // JSON-RPC responses must contain an explicit value; `undefined` is
      // rejected by the worker response schema for non-repository workspaces.
      return (await workspaceSummary(store.workspacePath(value.workspaceId ?? value.id!))) ?? null;
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
      return (await history(store.workspacePath(value.workspaceId), query)) ?? null;
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
      for (const candidate of result.candidates) {
        if (signal.aborted) throw backendError("CANCELLED", "Discovery report cancelled");
        await store.upsertDiscoveredWorkspace(candidate);
      }
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
    "changes.plan": async (params) => {
      const value = z
        .object({
          project: z.string(),
          manifest: z.record(z.string(), z.unknown()),
          includeHome: z.boolean(),
        })
        .parse(params);
      return planWorkspaceChanges(
        value.project,
        value.manifest as unknown as import("../domain/types.js").Manifest,
        value.includeHome,
      );
    },
    "agents.listInstallations": () => store.listAgentInstallations(),
    "catalog.searchAssets": async (params) => {
      await ensureCatalog();
      const value = z
        .object({
          query: z.string().default(""),
          agent: z.string().optional(),
          workspace_id: z.string().optional(),
          workspaceId: z.string().optional(),
          limit: z.number().int().positive().max(500).default(500),
        })
        .parse(params);
      return store
        .searchCatalogAssets(
          value.query,
          value.agent,
          value.workspace_id ?? value.workspaceId,
          value.limit,
        )
        .map((row) => ({
          ...row,
          path: String(row.path),
          ...(typeof row.summary_params === "string"
            ? {
                summary_params: (() => {
                  try {
                    const parsed = JSON.parse(row.summary_params);
                    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
                      ? parsed
                      : {};
                  } catch {
                    return {};
                  }
                })(),
              }
            : {}),
        }));
    },
    "memories.listGlobal": (params) => {
      const value = z
        .object({ status: z.enum(["pending", "approved", "rejected", "invalidated"]).optional() })
        .parse(params);
      return store.listGlobalMemories(value.status);
    },
    "activity.list": (params) => {
      const value = z
        .object({ limit: z.number().int().positive().max(500).default(200) })
        .parse(params);
      return store.listActivity(value.limit);
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
    "insights.status": () => {
      const rows = store.database
        .prepare(
          "SELECT provider, available, quality, coverage_from, coverage_to, imported_events, error FROM insight_cursors WHERE provider NOT LIKE 'git:%' ORDER BY provider",
        )
        .all() as Array<Record<string, unknown>>;
      const known = new Map(rows.map((row) => [String(row.provider), row]));
      const providers = [
        "codex",
        "claude-code",
        "cursor",
        "open-claw",
        "hermes",
        "deepseek-harness",
      ].map((agent) => {
        const row = known.get(agent);
        return {
          agent,
          available: Boolean(row?.available),
          quality: String(row?.quality ?? "incomplete"),
          coverage_from: typeof row?.coverage_from === "string" ? row.coverage_from : undefined,
          coverage_to: typeof row?.coverage_to === "string" ? row.coverage_to : undefined,
          imported_events: Number(row?.imported_events ?? 0),
          error: typeof row?.error === "string" ? row.error : undefined,
        };
      });
      return { providers, refreshed_at: insightsRefreshedAt, running: false };
    },
    "insights.refresh": async () => refreshInsights(),
    "insights.summary": (params) => buildInsightsView(insightQuery(params)).summary,
    "insights.view": (params) => buildInsightsView(insightQuery(params)),
    "insights.heatmap": (params) => buildInsightsView(insightQuery(params)).heatmap,
    "insights.agentUsage": (params) => buildInsightsView(insightQuery(params)).agents,
    "insights.modelUsage": (params) => buildInsightsView(insightQuery(params)).models,
    "insights.workspaceUsage": (params) => buildInsightsView(insightQuery(params)).workspaces,
    "insights.repositoryCommits": (params) => buildInsightsView(insightQuery(params)).repositories,
    "insights.achievements": () => {
      const view = buildInsightsView({});
      const workspaceCount = store.database
        .prepare("SELECT COUNT(*) count FROM workspaces WHERE status != 'excluded'")
        .get() as { count: number };
      return buildAchievements(
        view.summary,
        Number(workspaceCount.count),
        view.agents.filter(
          (agent) =>
            Number((agent as Record<string, unknown>).total_tokens) > 0 ||
            Number((agent as Record<string, unknown>).session_count) > 0,
        ).length,
      );
    },
    "insights.gitIdentities": () =>
      (
        store.database
          .prepare("SELECT id, label, source, enabled FROM git_identities ORDER BY source, label")
          .all() as Array<Record<string, unknown>>
      ).map((row) => ({
        id: String(row.id),
        label: String(row.label),
        source: String(row.source),
        enabled: Boolean(row.enabled),
      })),
    "insights.addGitIdentityAlias": (params) => {
      const value = z.object({ email: z.string().email() }).parse(params);
      const salt =
        (
          store.database
            .prepare("SELECT value FROM schema_meta WHERE key = 'insights_salt'")
            .get() as { value?: string } | undefined
        )?.value ?? randomUUID();
      store.database
        .prepare("INSERT OR IGNORE INTO schema_meta(key, value) VALUES ('insights_salt', ?)")
        .run(salt);
      const id = createHmac("sha256", salt).update(value.email.trim().toLowerCase()).digest("hex");
      store.database
        .prepare(
          "INSERT INTO git_identities(id, identity_hash, source, label, enabled, created_at) VALUES (?, ?, 'manual', 'settings.gitIdentityAlias', 1, ?) ON CONFLICT(identity_hash) DO UPDATE SET enabled = 1",
        )
        .run(id, id, new Date().toISOString());
      return { id, label: "settings.gitIdentityAlias", source: "manual", enabled: true };
    },
    "insights.setGitIdentityEnabled": (params) => {
      z.object({ id: z.string(), enabled: z.boolean() }).parse(params);
      return { ok: true };
    },
    "settings.setCloseBehavior": async (params) => {
      runtimeSettings.close_behavior =
        z.object({ value: z.enum(["minimize-to-tray", "quit"]).nullable() }).parse(params).value ??
        undefined;
      await persistPreferences({ close_behavior: runtimeSettings.close_behavior ?? null });
      return registry["runtime.info"]({}, new AbortController().signal);
    },
    "settings.setLocale": async (params) => {
      runtimeSettings.locale_preference = z
        .object({ preference: z.enum(["zh-CN", "zh-TW", "ja-JP", "en-US", "system"]) })
        .parse(params).preference;
      await persistPreferences({ locale_preference: runtimeSettings.locale_preference });
      return registry["runtime.info"]({}, new AbortController().signal);
    },
    "settings.setThemePreference": async (params) => {
      runtimeSettings.theme_preference = z
        .object({ preference: z.enum(["system", "light", "dark"]) })
        .parse(params).preference;
      await persistPreferences({ theme_preference: runtimeSettings.theme_preference });
      return registry["runtime.info"]({}, new AbortController().signal);
    },
    "settings.setAppIconPreference": async (params) => {
      runtimeSettings.app_icon_preference = z
        .object({ preference: z.enum(["white", "black"]) })
        .parse(params).preference;
      await persistPreferences({ app_icon_preference: runtimeSettings.app_icon_preference });
      return registry["runtime.info"]({}, new AbortController().signal);
    },
    "quota.collect": async (_params, signal) =>
      collectQuota(
        new NodeQuotaRunner(options.quota_executable ?? "codexbar-cli", options.quota_config_path),
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
      const publicServer: McpServer = {
        ...server,
        transport:
          server.transport.transport === "stdio"
            ? { ...server.transport, env: {} }
            : { ...server.transport, headers: {} },
      };
      await saveMcpConfig(file, {
        ...config,
        servers: [...config.servers.filter((item) => item.id !== server.id), publicServer],
      });
      return publicMcpServer(publicServer);
    },
    "mcp.saveLocalValues": async (params: unknown) => {
      const value = z
        .object({
          serverId: z.string(),
          env: z.record(z.string(), z.string()),
          headers: z.record(z.string(), z.string()),
        })
        .parse(params);
      return saveMcpLocalValues(
        resolveMcpFile(params),
        value.serverId,
        value.env,
        value.headers,
      ).then(publicMcpServer);
    },
    "mcp.removeServer": async (params: unknown) => {
      const value = z
        .object({ id: z.string().optional(), serverId: z.string().optional() })
        .parse(params);
      await removeMcpServer(resolveMcpFile(params), value.id ?? value.serverId!);
      return { ok: true };
    },
    "mcp.listRuntimes": () =>
      mcpHub.status().map((runtime) => ({
        ...runtime,
        server_name: runtime.server_name ?? runtime.server_id,
        config_hash: runtime.config_hash ?? "",
      })),
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
      const config = await loadEffectiveMcpConfig(resolveMcpFile(params));
      const server = config.servers.find((item) => item.id === (value.id ?? value.serverId));
      if (!server)
        throw backendError("NOT_FOUND", `MCP server not found: ${value.id ?? value.serverId}`);
      const tools = await mcpHub.listTools(server, signal);
      return tools;
    },
    "mcp.startOAuth": async (params: unknown) => {
      const value = z
        .object({ id: z.string().optional(), serverId: z.string().optional() })
        .parse(params);
      const serverId = value.id ?? value.serverId;
      if (!serverId) throw backendError("VALIDATION", "MCP server id is required");
      const config = await loadEffectiveMcpConfig(resolveMcpFile(params));
      const server = config.servers.find((item) => item.id === serverId);
      if (!server) throw backendError("NOT_FOUND", `MCP server not found: ${serverId}`);
      if (server.transport.transport !== "streamable-http")
        throw backendError("VALIDATION", "OAuth is supported only for Streamable HTTP MCP servers");
      await startMcpNetwork().catch((error) => {
        throw backendError("IO", `MCP OAuth callback server could not start: ${String(error)}`);
      });
      const callback = `http://127.0.0.1:${mcpNetwork.port}/oauth/callback/${encodeURIComponent(serverId)}`;
      const transport = server.transport as typeof server.transport & {
        oauth_authorization_url?: string;
        oauth_scope?: string;
      };
      let authorizationServer = server.transport.url;
      let metadata: Awaited<
        ReturnType<typeof discoverOAuthServerInfo>
      >["authorizationServerMetadata"];
      try {
        const discovered = await discoverOAuthServerInfo(server.transport.url);
        authorizationServer = discovered.authorizationServerUrl;
        metadata = discovered.authorizationServerMetadata;
      } catch {
        // Some MCP servers expose an explicit authorization endpoint instead of
        // RFC 8414 metadata; retain that compatibility path.
      }
      const explicit = transport.oauth_authorization_url;
      if (explicit) authorizationServer = explicit;
      const clientMetadata = {
        client_name: "AgentKib",
        redirect_uris: [callback],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      };
      const client = await registerClient(authorizationServer, {
        metadata,
        clientMetadata,
      }).catch(() => ({ client_id: `agentkib-${randomUUID()}` }));
      const state = randomUUID();
      const { authorizationUrl, codeVerifier } = await startAuthorization(authorizationServer, {
        metadata,
        clientInformation: client as never,
        redirectUrl: callback,
        scope: transport.oauth_scope,
        state,
        resource: new URL(server.transport.url),
      });
      pendingMcpOAuth.set(state, {
        serverId,
        project:
          typeof (params as Record<string, unknown>).project === "string"
            ? ((params as Record<string, unknown>).project as string)
            : undefined,
        authorizationServer,
        client,
        codeVerifier,
        redirectUri: callback,
      });
      return { authorization_url: authorizationUrl.toString() };
    },
    "mcp.restartRuntime": async (params: unknown, signal: AbortSignal) => {
      const value = z
        .object({ id: z.string().optional(), serverId: z.string().optional() })
        .parse(params);
      const serverId = value.id ?? value.serverId;
      if (!serverId) throw backendError("VALIDATION", "MCP server id is required");
      await mcpHub.stop(serverId);
      const config = await loadEffectiveMcpConfig(resolveMcpFile(params));
      const server = config.servers.find((item) => item.id === serverId);
      if (!server) throw backendError("NOT_FOUND", `MCP server not found: ${serverId}`);
      return mcpHub.start(server, signal);
    },
    "mcp.updateNetwork": async (params: unknown) => {
      const value = z.object({ settings: z.record(z.string(), z.unknown()) }).parse(params);
      const settings = z
        .object({
          port: z.number().int().min(1).max(65_535),
          lan_enabled: z.boolean(),
          lan_risk_accepted: z.boolean().default(false),
        })
        .parse(value.settings);
      if (settings.lan_enabled && !settings.lan_risk_accepted)
        throw backendError("PERMISSION", "LAN mode requires explicit risk acceptance");
      const previous = mcpNetwork;
      await stopMcpNetwork();
      mcpNetwork = settings;
      try {
        await startMcpNetwork();
        await persistPreferences({ mcp_network: mcpNetwork });
      } catch (error) {
        mcpNetwork = previous;
        await startMcpNetwork().catch(() => undefined);
        throw backendError(
          "IO",
          `MCP Hub could not bind to port ${settings.port}: ${String(error)}`,
        );
      }
      return hubStatus();
    },
    "mcp.searchRegistry": async (params: unknown) => {
      const value = z.object({ query: z.string().default("") }).parse(params);
      if (!mcpRegistry.length) await loadMcpRegistry();
      const query = value.query.toLowerCase();
      return mcpRegistry.filter((entry) =>
        `${entry.name} ${entry.description} ${entry.identifier}`.toLowerCase().includes(query),
      );
    },
    "mcp.refreshRegistry": async (params: unknown) => {
      await loadMcpRegistry();
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
      let installPath: string | undefined;
      if (entry.package_kind === "npm" || entry.package_kind === "pypi") {
        installPath = path.join(
          path.dirname(options.database_path),
          "mcp-packages",
          `${entry.name.replace(/[^A-Za-z0-9._-]+/g, "-")}-${entry.version}`,
        );
        const packageSpec = `${entry.identifier}${entry.version ? (entry.package_kind === "npm" ? `@${entry.version}` : `==${entry.version}`) : ""}`;
        const result =
          entry.package_kind === "npm"
            ? await runManaged({
                executable: "npm",
                args: [
                  "install",
                  "--ignore-scripts",
                  "--no-package-lock",
                  "--prefix",
                  installPath,
                  packageSpec,
                ],
                timeoutMs: 120_000,
              })
            : await runManaged({
                executable: "uv",
                args: ["pip", "install", "--target", installPath, packageSpec],
                timeoutMs: 120_000,
              });
        if (result.code !== 0)
          throw backendError("IO", `${entry.package_kind} MCP package installation failed`);
      }
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
        install_path: installPath,
        status: installPath ? "installed" : "configured",
        installed_at: now,
        updated_at: now,
        server_id: server.id,
      };
      mcpInstallations.set(installation.id, installation);
      store.database
        .prepare(
          "INSERT INTO mcp_installations(id, name, package_kind, identifier, version, install_path, status, installed_at, updated_at, server_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, status = excluded.status, server_id = excluded.server_id",
        )
        .run(
          installation.id,
          installation.name,
          installation.package_kind,
          installation.identifier,
          installation.version ?? null,
          installation.install_path ?? null,
          installation.status,
          installation.installed_at,
          installation.updated_at,
          installation.server_id,
        );
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
      if (current.server_id)
        await removeMcpServer(resolveMcpFile({ project: value.project }), current.server_id).catch(
          () => undefined,
        );
      mcpInstallations.delete(value.installationId);
      store.database
        .prepare("DELETE FROM mcp_installations WHERE id = ?")
        .run(value.installationId);
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
      if (current.server_id) {
        await removeMcpServer(defaultMcpFile, current.server_id).catch(() => undefined);
        for (const workspace of store.listWorkspaces())
          await removeMcpServer(
            resolveMcpFile({ project: workspace.canonical_path }),
            current.server_id,
          ).catch(() => undefined);
      }
      if (current.install_path) await rm(current.install_path, { recursive: true, force: true });
      mcpInstallations.delete(value.installationId);
      store.database
        .prepare("DELETE FROM mcp_installations WHERE id = ?")
        .run(value.installationId);
      return { ok: true };
    },
    "mcp.scanNative": async (params: unknown) => {
      const value = z.object({ project: z.string().optional() }).parse(params);
      return scanNativeCandidates(value.project ?? store.listWorkspaces()[0]?.canonical_path);
    },
    "mcp.planMigration": async (params: unknown) => {
      const value = z
        .object({ project: z.string(), candidateIds: z.array(z.string()) })
        .parse(params);
      if (!value.candidateIds.length)
        throw backendError("VALIDATION", "Select at least one native MCP candidate");
      const candidates = (await registry["mcp.scanNative"](
        { project: value.project },
        new AbortController().signal,
      )) as Array<Record<string, unknown>>;
      const selected = candidates.filter(
        (candidate) => value.candidateIds.includes(String(candidate.id)) && candidate.supported,
      );
      if (selected.length !== value.candidateIds.length)
        throw backendError("CONFLICT", "Native MCP candidates changed; scan again");
      const target = path.join(value.project, ".agentkib", "mcp.json");
      const existing = await loadMcpConfig(target).catch(() => ({
        schema_version: 1,
        servers: [],
      }));
      const servers = selected.map((candidate) => ({
        id: `${String(candidate.agent)}-${String(candidate.name)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")}`,
        name: String(candidate.name),
        enabled: true,
        allow_tools: [],
        lan_allow_tools: [],
        targets: [String(candidate.agent)],
        transport:
          candidate.transport === "http"
            ? {
                transport: "streamable-http" as const,
                url: String(candidate.endpoint),
                headers: {},
              }
            : {
                transport: "stdio" as const,
                command: String(candidate.endpoint),
                args: [],
                env: {},
              },
      }));
      const merged = [
        ...existing.servers.filter((server) => !servers.some((item) => item.name === server.name)),
        ...servers,
      ];
      const changes: Array<import("../changes/changeset.js").FileChange> = [];
      const before = await readFile(target, "utf8").catch(() => "");
      changes.push({
        target,
        scope: "project",
        before,
        ...(before ? { original_hash: hashContent(before) } : {}),
        after: JSON.stringify({ schema_version: 1, servers: merged }, null, 2) + "\n",
        risk: "medium",
        validator: "json",
      });
      for (const source of [
        ...new Set(selected.map((candidate) => String(candidate.source_path))),
      ]) {
        const sourceBefore = await readFile(source, "utf8").catch(() => "");
        try {
          if (!sourceBefore) throw new Error("Native MCP source disappeared");
          const sourceAfter = await removeNativeCandidates(
            source,
            selected.filter((item) => item.source_path === source) as unknown as Array<
              import("../mcp/native.js").NativeMcpCandidate
            >,
          );
          const projectRoot = path.resolve(value.project);
          const sourceScope =
            source === projectRoot || source.startsWith(`${projectRoot}${path.sep}`)
              ? "project"
              : "agent-home";
          changes.push({
            target: source,
            scope: sourceScope,
            before: sourceBefore,
            original_hash: hashContent(sourceBefore),
            after: sourceAfter,
            risk: sourceScope === "agent-home" ? "high" : "medium",
            validator: source.endsWith(".toml")
              ? "toml"
              : source.endsWith(".yaml")
                ? "yaml"
                : "json",
          });
        } catch {
          throw backendError("VALIDATION", `Native MCP configuration is invalid: ${source}`);
        }
      }
      return planChangeSet(value.project, changes);
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
        state: (gateway as Gateway & { state?: string }).state ?? "pending",
        version: (gateway as Gateway & { version?: string }).version,
        capabilities: (gateway as Gateway & { capabilities?: string[] }).capabilities ?? [],
        session_count: Number((gateway as Gateway & { session_count?: number }).session_count ?? 0),
        workspaces: (gateway as Gateway & { workspaces?: unknown[] }).workspaces ?? [],
        assets: (gateway as Gateway & { assets?: unknown[] }).assets ?? [],
      })),
    "gateways.save": async (params: unknown, signal: AbortSignal) => {
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
      const saved = {
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
      // Match Rust's save semantics: persist first, then immediately probe the endpoint.
      try {
        return await registry["gateways.refresh"]({ id: gateway.id }, signal);
      } catch {
        return saved;
      }
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
    "gateways.refresh": async (params: unknown, signal: AbortSignal) => {
      const value = z.object({ id: z.string() }).parse(params);
      const file = resolveGatewayFile(params);
      const config = await loadGatewayConfig(file);
      const gateway = config.gateways.find((item) => item.id === value.id);
      if (!gateway) throw backendError("NOT_FOUND", `Gateway not found: ${value.id}`);
      try {
        const response = await fetch(gateway.base_url, {
          headers: gateway.token ? { Authorization: `Bearer ${gateway.token}` } : {},
          signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        Object.assign(gateway, {
          state: "connected",
          version: typeof body.version === "string" ? body.version : undefined,
          capabilities: Array.isArray(body.capabilities)
            ? body.capabilities.filter((item): item is string => typeof item === "string")
            : [],
          last_connected_at: new Date().toISOString(),
          last_error: undefined,
        });
      } catch (error) {
        Object.assign(gateway, {
          state: "error",
          last_error: error instanceof Error ? error.message : "Gateway refresh failed",
        });
      }
      await saveGatewayConfig(file, config);
      return (
        (await registry["gateways.list"](params, new AbortController().signal)) as Array<
          Record<string, unknown>
        >
      ).find((item) => item.id === value.id);
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
      await persistObsidian();
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
      const knownVault = obsidianVaults.some(
        (item) => path.resolve(item.path) === path.resolve(vault.path),
      );
      if (!knownVault)
        throw backendError("NOT_FOUND", "The Obsidian vault must be added before it can be linked");
      const link = await createWorkspaceLink(
        workspace.canonical_path,
        vault,
        workspace.id,
        value.relativeTarget ?? workspace.name,
      );
      const existing = obsidianLinks.findIndex((item) => item.workspace_id === workspace.id);
      if (existing >= 0) obsidianLinks[existing] = link;
      else obsidianLinks.push(link);
      await persistObsidian();
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
      return persistObsidian().then(() => ({ ok: true }));
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
    "quota.setPreferences": async (params: unknown) => {
      const value = z
        .object({
          preferences: z.object({
            hidden_providers: z.array(z.string()),
            hidden_windows: z.array(z.record(z.string(), z.unknown())),
          }),
        })
        .parse(params);
      quotaPreferences = value.preferences;
      await persistPreferences({ quota_preferences: quotaPreferences });
      return quotaPreferences;
    },
    "quota.setAutoRefresh": async (params: unknown) => {
      runtimeSettings.quota_auto_refresh_enabled = z
        .object({ value: z.boolean() })
        .parse(params).value;
      await persistPreferences({
        quota_auto_refresh_enabled: runtimeSettings.quota_auto_refresh_enabled,
      });
      return registry["runtime.info"]({}, new AbortController().signal);
    },
    "quota.setPromptSeen": async (params: unknown) => {
      runtimeSettings.quota_prompt_seen = z.object({ value: z.boolean() }).parse(params).value;
      await persistPreferences({
        quota_auto_refresh_prompt_seen: runtimeSettings.quota_prompt_seen,
      });
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
      await stopMcpNetwork();
      await mcpHub.shutdown();
      store.close();
    },
  };
}
export function createBackendRegistry(options: BackendRuntimeOptions): BackendMethodRegistry {
  return createBackendRuntime(options).registry;
}
