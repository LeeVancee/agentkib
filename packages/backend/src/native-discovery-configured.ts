import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import JSON5 from "json5";
import { normalizeDiscoveryCandidates } from "./discovery-scan-roots";
import { isReparseOrSymlink } from "./native-files";
import { fileTime } from "./asset-scanner";
import { userHome } from "./mcp-config-read";
import { jsonTimestamp } from "./session-history";
import { Sql } from "./sql";
import { isProbeWorkspace } from "./paths";
import { GrokSessions } from "./grok-sessions";
import { OpenClawSessions } from "./openclaw-sessions";
import { HermesSessions } from "./hermes-sessions";
import { utcNow, type DiscoveryCandidate } from "./workspaces";

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

interface ProviderResult {
  candidates: DiscoveryCandidate[];
  errors: string[];
  status: string;
  reasons: string[];
}

/** Discovery adapters for providers whose workspace index is independent of conversation history. */
export function discoverConfiguredWorkspaces(environment: NodeJS.ProcessEnv) {
  const candidates: DiscoveryCandidate[] = [],
    errors: string[] = [],
    source_diagnostics: Record<string, unknown>[] = [];
  const roots: {
    agent: string;
    source: string;
    path: string;
    read: (root: string) => ProviderResult;
  }[] = [
    {
      agent: "codex",
      source: "state-db",
      path: codexHome(environment),
      read: (home: string) => readCodex(home),
    },
    {
      agent: "claude-code",
      source: "history-and-index",
      path: environment.CLAUDE_CONFIG_DIR ?? path.join(userHome(environment), ".claude"),
      read: (home: string) => readClaude(home),
    },
    {
      agent: "open-claw",
      source: "config-and-sessions",
      path: environment.OPENCLAW_STATE_DIR ?? path.join(userHome(environment), ".openclaw"),
      read: (home: string) => readOpenClaw(home, environment),
    },
    {
      agent: "hermes",
      source: "profiles-and-state",
      path: environment.HERMES_HOME ?? path.join(userHome(environment), ".hermes"),
      read: (_home: string) => readHermes(environment),
    },
    {
      agent: "grok-build",
      source: "sessions-and-archives",
      path: environment.GROK_HOME ?? path.join(userHome(environment), ".grok"),
      read: (_home: string) => readGrok(environment),
    },
    {
      agent: "cursor",
      source: "workspace-storage",
      path: cursorStorage(environment),
      read: (root: string) => readCursor(root),
    },
    {
      agent: "deepseek-harness",
      source: "workspace-storage",
      path: path.join(deepseekHome(environment), "storages/workspace.json"),
      read: (file: string) => readDeepSeek(file),
    },
  ];

  for (const item of roots) {
    const started_at = utcNow();
    try {
      const result = item.read(item.path),
        finished_at = utcNow();
      candidates.push(...result.candidates);
      source_diagnostics.push({
        agent: item.agent,
        source: item.source,
        path: item.path,
        started_at,
        finished_at,
        candidate_count: result.candidates.length,
        included_count: null,
        skipped_count: null,
        status: result.status,
        reasons: result.reasons,
      });
      errors.push(
        ...result.errors.map((error) => `${item.agent} workspace discovery failed: ${error}`),
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error),
        finished_at = utcNow();
      source_diagnostics.push({
        agent: item.agent,
        source: item.source,
        path: item.path,
        started_at,
        finished_at,
        candidate_count: null,
        included_count: null,
        skipped_count: null,
        status: detail.toLowerCase().includes("permission") ? "permission-denied" : "failed",
        reasons: [
          detail.toLowerCase().includes("permission") ? "permission-denied" : "source-read-failed",
        ],
      });
      errors.push(`${item.agent} workspace discovery failed: ${detail}`);
    }
  }
  return {
    candidates: normalizeDiscoveryCandidates(candidates, environment),
    errors,
    source_diagnostics,
  };
}

function cursorStorage(environment: NodeJS.ProcessEnv): string {
  const home = userHome(environment),
    configured = environment.XDG_CONFIG_HOME,
    config = configured && path.isAbsolute(configured) ? configured : path.join(home, ".config"),
    data =
      environment.CURSOR_DATA_DIR ??
      (process.platform === "linux"
        ? path.join(config, "Cursor")
        : process.platform === "win32"
          ? path.join(environment.APPDATA ?? path.join(home, "AppData/Roaming"), "Cursor")
          : path.join(home, "Library/Application Support/Cursor"));
  return path.join(data, "User/workspaceStorage");
}

function deepseekHome(environment: NodeJS.ProcessEnv): string {
  return environment.DSH_HOME ?? path.join(userHome(environment), ".dsh");
}

function codexHome(environment: NodeJS.ProcessEnv): string {
  return environment.CODEX_HOME ?? path.join(userHome(environment), ".codex");
}

function readClaude(home: string): ProviderResult {
  const activity = new Map<
      string,
      { ids: Set<string>; anonymous: number; last_active_at: string | null }
    >(),
    merge = (workspace: string, sessionId: string | null, at: string | null) => {
      if (isProbeWorkspace(workspace)) return;
      let value = activity.get(workspace);
      if (!value) {
        value = { ids: new Set(), anonymous: 0, last_active_at: null };
        activity.set(workspace, value);
      }
      if (sessionId === null) value.anonymous++;
      else value.ids.add(sessionId);
      if (at && (!value.last_active_at || at > value.last_active_at)) value.last_active_at = at;
    };
  try {
    for (const line of readFileSync(path.join(home, "history.jsonl"), "utf8").split(/\r?\n/)) {
      if (!line) continue;
      let row: Record<string, unknown> | null;
      try {
        row = asRecord(JSON.parse(line));
      } catch {
        continue;
      }
      if (typeof row?.project !== "string") continue;
      merge(row.project, sessionId(row), jsonTimestamp(row.timestamp));
    }
  } catch {}
  const projects = path.join(home, "projects");
  if (statRoot(projects))
    walkFiles(projects, 3, (file) => {
      if (path.basename(file) !== "sessions-index.json") return;
      const document = JSON.parse(readFileSync(file, "utf8")),
        rows = Array.isArray(document?.entries)
          ? document.entries
          : Array.isArray(document)
            ? document
            : [];
      for (const item of rows) {
        const row = asRecord(item);
        if (typeof row?.projectPath !== "string") continue;
        const modified = row.modified ?? row.modifiedAt ?? row.lastActivityAt;
        merge(row.projectPath, sessionId(row), jsonTimestamp(modified));
      }
    });
  const candidates = [...activity.entries()].map(([cwd, value]) =>
    candidate(
      cwd,
      "claude-code",
      "session-cwd",
      value.last_active_at,
      false,
      Math.min(Number.MAX_SAFE_INTEGER, value.ids.size + value.anonymous),
    ),
  );
  return {
    candidates,
    errors: [],
    status: candidates.length ? "succeeded" : "empty",
    reasons: [],
  };
}

function sessionId(value: Record<string, unknown>): string | null {
  for (const key of ["sessionId", "session_id", "id"])
    if (typeof value[key] === "string") return value[key] as string;
  return null;
}

function readGrok(environment: NodeJS.ProcessEnv): ProviderResult {
  const result = new GrokSessions(environment).list(null),
    candidates = result.sessions.flatMap(({ cwd, session }) =>
      cwd
        ? [
            {
              ...candidate(cwd, "grok-build", "session-cwd", session.updated_at, false, 1),
              session_cwds: [cwd],
            },
          ]
        : [],
    );
  return {
    candidates,
    errors: [],
    status: result.incomplete ? "partial" : candidates.length ? "succeeded" : "empty",
    reasons: result.incomplete ? ["source-read-failed"] : [],
  };
}

function readOpenClaw(home: string, environment: NodeJS.ProcessEnv): ProviderResult {
  const candidates: DiscoveryCandidate[] = [],
    errors: string[] = [],
    config = path.join(home, "openclaw.json");
  try {
    const root = asRecord(JSON5.parse(readFileSync(config, "utf8")));
    if (!root) throw new Error("OpenClaw configuration must be an object");
    const agents = asRecord(root.agents),
      defaults = asRecord(agents?.defaults),
      add = (value: unknown) => {
        if (typeof value !== "string") return;
        const expanded =
          value === "~"
            ? userHome(environment)
            : value.startsWith("~/")
              ? path.join(userHome(environment), value.slice(2))
              : value;
        candidates.push(
          candidate(
            path.isAbsolute(expanded) ? expanded : path.resolve(home, expanded),
            "open-claw",
            "configured-workspace",
            null,
            true,
          ),
        );
      };
    add(defaults?.workspace);
    for (const key of ["list", "entries"])
      for (const item of Array.isArray(agents?.[key]) ? agents[key] : [])
        add(asRecord(item)?.workspace);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(String(error));
  }
  const result = new OpenClawSessions(environment).list(null);
  for (const { cwd, session } of result.sessions) {
    if (!cwd) continue;
    candidates.push({
      ...candidate(cwd, "open-claw", "session-cwd", session.updated_at, false, 1),
      session_cwds: [cwd],
    });
  }
  const incomplete = result.incomplete || errors.length > 0;
  return {
    candidates,
    errors,
    status: incomplete ? "partial" : candidates.length ? "succeeded" : "empty",
    reasons: incomplete ? ["source-read-failed"] : [],
  };
}

function readHermes(environment: NodeJS.ProcessEnv): ProviderResult {
  const result = new HermesSessions(environment).list(null),
    candidates = result.sessions.flatMap(({ cwd, session }) =>
      cwd
        ? [
            {
              ...candidate(cwd, "hermes", "session-cwd", session.updated_at, false, 1),
              session_cwds: [cwd],
            },
          ]
        : [],
    );
  return {
    candidates,
    errors: [],
    status: result.incomplete ? "partial" : candidates.length ? "succeeded" : "empty",
    reasons: result.incomplete ? ["source-read-failed"] : [],
  };
}

function walkFiles(root: string, maxDepth: number, visit: (file: string) => void): void {
  const base = statRoot(root);
  if (!base) return;
  const stack = [{ directory: root, depth: 0 }];
  while (stack.length) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current.directory, { withFileTypes: true })) {
      const value = path.join(current.directory, entry.name),
        metadata = lstatSync(value, { bigint: true });
      if (isReparseOrSymlink(value, metadata) || metadata.dev !== base.device) continue;
      if (metadata.isFile()) visit(value);
      else if (metadata.isDirectory() && current.depth + 1 < maxDepth)
        stack.push({ directory: value, depth: current.depth + 1 });
    }
  }
}

function readCodex(home: string): ProviderResult {
  let metadata;
  try {
    metadata = lstatSync(home);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { candidates: [], errors: [], status: "missing", reasons: ["missing-directory"] };
    throw error;
  }
  if (isReparseOrSymlink(home, metadata) || !metadata.isDirectory())
    return { candidates: [], errors: [], status: "empty", reasons: [] };
  const files = readdirSync(home)
      .filter((name) => name.startsWith("state_") && name.endsWith(".sqlite"))
      .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .map((name) => path.join(home, name)),
    candidates: DiscoveryCandidate[] = [];
  for (const file of files) {
    const database = new DatabaseSync(file, { readOnly: true });
    try {
      const sql = new Sql(database),
        columns = new Set(sql.rows("PRAGMA table_info(threads)").map((row) => String(row.name)));
      if (!columns.has("cwd")) continue;
      const timestamps = ["recency_at", "updated_at", "created_at"].filter((name) =>
          columns.has(name),
        ),
        timestampExpression =
          timestamps.length === 0
            ? "NULL"
            : timestamps.length === 1
              ? `MAX(${timestamps[0]})`
              : `MAX(COALESCE(${timestamps.join(", ")}))`,
        rows = sql.rows(
          `SELECT cwd, ${timestampExpression} AS updated, COUNT(*) AS count FROM threads WHERE cwd IS NOT NULL AND cwd != '' GROUP BY cwd`,
        );
      for (const row of rows) {
        if (typeof row.cwd !== "string") throw new Error("Codex workspace path is invalid");
        candidates.push(
          candidate(
            row.cwd,
            "codex",
            "session-cwd",
            integerTimestamp(row.updated),
            false,
            count(row.count),
          ),
        );
      }
    } finally {
      database.close();
    }
  }
  return {
    candidates,
    errors: [],
    status: candidates.length ? "succeeded" : "empty",
    reasons: [],
  };
}

function readCursor(storage: string) {
  const started = statRoot(storage),
    candidates: DiscoveryCandidate[] = [],
    errors: string[] = [];
  if (started === null)
    return {
      candidates,
      errors,
      status: "missing",
      reasons: ["missing-directory"],
    };
  let directories: string[];
  try {
    directories = readdirSync(storage, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => path.join(storage, entry.name));
  } catch (error) {
    throw error;
  }
  for (const directory of directories) {
    const file = path.join(directory, "workspace.json");
    try {
      const metadata = lstatSync(directory, { bigint: true });
      if (isReparseOrSymlink(directory, metadata) || metadata.dev !== started.device) continue;
      const fileMetadata = lstatSync(file, { bigint: true });
      if (isReparseOrSymlink(file, fileMetadata) || !fileMetadata.isFile()) continue;
      const parsed = asRecord(JSON.parse(readFileSync(file, "utf8"))),
        uri = parsed?.folder ?? parsed?.workspace,
        workspace = typeof uri === "string" ? fileUriPath(uri) : null;
      if (!workspace) continue;
      candidates.push(candidate(workspace, "cursor", "configured-workspace", fileTime(file)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(String(error));
    }
  }
  return {
    candidates,
    errors,
    status: errors.length ? "partial" : candidates.length ? "succeeded" : "empty",
    reasons: errors.length ? ["source-read-failed"] : [],
  };
}

function readDeepSeek(file: string) {
  let metadata;
  try {
    metadata = lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { candidates: [], errors: [], status: "missing", reasons: ["missing-file"] };
    throw error;
  }
  if (isReparseOrSymlink(file, metadata))
    return { candidates: [], errors: [], status: "missing", reasons: ["unsafe-source"] };
  if (!metadata.isFile())
    return { candidates: [], errors: [], status: "missing", reasons: ["missing-file"] };
  const document = asRecord(JSON.parse(readFileSync(file, "utf8"))),
    unit = asRecord(document?.unit),
    tables = asRecord(document?.tables),
    records = asRecord(tables?.workspaces);
  if (unit?.name !== "workspace" || unit.version !== 2)
    throw new Error("DeepSeek Harness workspace storage version is not supported");
  if (!records) throw new Error("DeepSeek Harness workspace storage has no workspaces table");
  const candidates = Object.values(records).flatMap((recordValue) => {
    const row = asRecord(recordValue);
    if (typeof row?.path !== "string") return [];
    const discovered = candidate(
        row.path,
        "deepseek-harness",
        "configured-workspace",
        jsonTimestamp(row.updatedAt),
        true,
      ),
      count = Array.isArray(row.sessionIds) ? row.sessionIds.length : 0;
    discovered.session_count = count;
    discovered.display_name = typeof row.title === "string" && row.title.trim() ? row.title : null;
    return [discovered];
  });
  return {
    candidates,
    errors: [],
    status: candidates.length ? "succeeded" : "empty",
    reasons: [],
  };
}

function candidate(
  value: string,
  agent: string,
  evidence: string,
  last_active_at: string | null,
  explicit = false,
  session_count = 0,
): DiscoveryCandidate {
  return {
    path: value,
    source_agent: agent,
    evidence,
    last_active_at,
    session_count,
    repository_group_id: null,
    explicit_workspace: explicit,
  } satisfies DiscoveryCandidate;
}

function count(value: unknown): number {
  if (typeof value === "bigint")
    return Number(
      value > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : value,
    );
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function integerTimestamp(value: unknown): string | null {
  if (typeof value === "bigint") {
    if (value <= 0n) return null;
    const milliseconds = value > 10_000_000_000n ? Number(value) : Number(value) * 1000,
      date = new Date(milliseconds);
    return Number.isFinite(date.valueOf()) ? date.toISOString().replace(".000Z", "Z") : null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value > 10_000_000_000 ? value : value * 1000);
  return Number.isFinite(date.valueOf()) ? date.toISOString().replace(".000Z", "Z") : null;
}

function fileUriPath(value: string): string | null {
  if (!value.startsWith("file://")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value.slice("file://".length));
  } catch {
    return null;
  }
  if (process.platform !== "win32") return decoded;
  let normalized = decoded.replaceAll("/", "\\");
  if (normalized.startsWith("localhost\\")) normalized = normalized.slice("localhost\\".length);
  if (normalized.startsWith("\\\\")) return normalized;
  if (/^\\[A-Za-z]:/.test(normalized)) return normalized.slice(1);
  if (/^[A-Za-z]:/.test(normalized)) return normalized;
  return `\\\\${normalized}`;
}

function statRoot(value: string): { device: bigint } | null {
  try {
    const metadata = lstatSync(value, { bigint: true });
    if (isReparseOrSymlink(value, metadata) || !metadata.isDirectory()) return null;
    return { device: metadata.dev };
  } catch {
    return null;
  }
}
