import { mkdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import path from "node:path";

export const CURRENT_SCHEMA_VERSION = 10;

export interface OpenDatabaseOptions {
  busyTimeoutMs?: number;
}

/** Open an AgentKib database and apply only the existing Rust schema migrations. */
export function openDatabase(filePath: string, options: OpenDatabaseOptions = {}): DatabaseSync {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const database = new DatabaseSync(filePath);
  try {
    database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    database.exec(
      `PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs ?? 5_000))};`,
    );
    migrateDatabase(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function migrateDatabase(database: DatabaseSync): void {
  const current = readSchemaVersion(database);
  if (current === undefined || current < 2) runMigration(database, 2, MIGRATION_2);
  if (current === undefined || current < 3) runMigration(database, 3, MIGRATION_3);
  if (current === undefined || current < 4) runMigration(database, 4, MIGRATION_4);
  if (current === undefined || current < 5) runMigration(database, 5, MIGRATION_5);
  if (current === undefined || current < 6) runMigration(database, 6, MIGRATION_6);
  if (current === undefined || current < 7) runMigration(database, 7, MIGRATION_7);
  if (current === undefined || current < 8) runMigration(database, 8, MIGRATION_8);
  if (current === undefined || current < 9) runMigration(database, 9, MIGRATION_9);
  if (current === undefined || current < 10) {
    database.exec("BEGIN IMMEDIATE;");
    try {
      normalizeLegacyWorkspaceTimestamps(database);
      database
        .prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schema_version', '10')")
        .run();
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
  }
  // Keep the public schema version aligned with the Rust runtime's version 10.
  // The installation-to-server association is an additive compatibility column;
  // older databases can receive it without changing the shared schema version.
  if (!hasColumn(database, "mcp_installations", "server_id"))
    database.exec("ALTER TABLE mcp_installations ADD COLUMN server_id TEXT;");
  database.exec(
    "CREATE INDEX IF NOT EXISTS idx_usage_events_session_precision " +
      "ON usage_events(session_hash, date_precision);",
  );
}

function readSchemaVersion(database: DatabaseSync): number | undefined {
  try {
    const row = database
      .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
      .get() as { value?: unknown } | undefined;
    const value = row?.value;
    return typeof value === "string" && /^\d+$/.test(value) ? Number(value) : undefined;
  } catch {
    return undefined;
  }
}

function runMigration(database: DatabaseSync, version: number, sql: string): void {
  database.exec("BEGIN IMMEDIATE;");
  try {
    database.exec(sql);
    database
      .prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schema_version', ?)")
      .run(String(version));
    database.exec("COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

function normalizeLegacyWorkspaceTimestamps(database: DatabaseSync): void {
  for (const [table, columns, keyColumns] of [
    ["workspaces", ["id", "last_active_at"], ["id"]],
    [
      "workspace_sources",
      ["workspace_id", "agent", "evidence", "last_active_at"],
      ["workspace_id", "agent", "evidence"],
    ],
  ] as const) {
    if (!hasColumn(database, table, "last_active_at")) continue;
    const rows = database
      .prepare(`SELECT ${columns.join(", ")} FROM ${table} WHERE last_active_at IS NOT NULL`)
      .all() as Array<Record<string, unknown>>;
    const set = database.prepare(
      `UPDATE ${table} SET last_active_at = ? WHERE ${keyColumns.map((key) => `${key} = ?`).join(" AND ")}`,
    );
    for (const row of rows) {
      const normalized = decodeLegacyTime(row.last_active_at);
      set.run(...([normalized, ...keyColumns.map((key) => row[key])] as SQLInputValue[]));
    }
  }
}

function hasColumn(database: DatabaseSync, table: string, column: string): boolean {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>).some(
    (row) => row.name === column,
  );
}

function decodeLegacyTime(value: unknown): string | null {
  if (typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.valueOf())) return date.toISOString();
    if (/^-?\d+$/.test(value)) return decodeUnixTime(Number(value));
  }
  if (typeof value === "number" && Number.isFinite(value)) return decodeUnixTime(value);
  return null;
}

function decodeUnixTime(value: number): string | null {
  const milliseconds = Math.abs(value) >= 100_000_000_000 ? value : value * 1_000;
  const date = new Date(milliseconds);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

const MIGRATION_2 = `
CREATE TABLE IF NOT EXISTS memories (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, memory_type TEXT NOT NULL, content TEXT NOT NULL,
 status TEXT NOT NULL, source_agent TEXT, source_thread TEXT, source_reference TEXT,
 created_at TEXT NOT NULL, approved_at TEXT, invalidated_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_memories_project_status ON memories(project_id, status);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED, project_id UNINDEXED, content);
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
 INSERT INTO memories_fts(id, project_id, content) VALUES (new.id, new.project_id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content ON memories BEGIN
 DELETE FROM memories_fts WHERE id = old.id;
 INSERT INTO memories_fts(id, project_id, content) VALUES (new.id, new.project_id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
 DELETE FROM memories_fts WHERE id = old.id;
END;
CREATE TABLE IF NOT EXISTS audit_events (
 id TEXT PRIMARY KEY, project_id TEXT, action TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workspaces (
 id TEXT PRIMARY KEY, canonical_path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
 repository_group_id TEXT, manifest_workspace_id TEXT, status TEXT NOT NULL,
 asset_count INTEGER NOT NULL DEFAULT 0, warning_count INTEGER NOT NULL DEFAULT 0,
 last_active_at TEXT, last_discovered_at TEXT NOT NULL, last_scanned_at TEXT
);
CREATE TABLE IF NOT EXISTS workspace_sources (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 agent TEXT NOT NULL, evidence TEXT NOT NULL, session_count INTEGER NOT NULL DEFAULT 0,
 last_active_at TEXT, PRIMARY KEY(workspace_id, agent, evidence)
);
CREATE TABLE IF NOT EXISTS catalog_assets (
 id TEXT PRIMARY KEY, scope TEXT NOT NULL, workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
 agent TEXT, kind TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL, summary TEXT NOT NULL,
 size INTEGER NOT NULL DEFAULT 0, modified_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_catalog_assets_workspace ON catalog_assets(workspace_id);
CREATE INDEX IF NOT EXISTS idx_catalog_assets_search ON catalog_assets(name, path, summary);
CREATE TABLE IF NOT EXISTS agent_installations (
 agent TEXT PRIMARY KEY, installed INTEGER NOT NULL, configured INTEGER NOT NULL,
 version TEXT, home TEXT, warnings TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scan_roots (
 id TEXT PRIMARY KEY, canonical_path TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL DEFAULT 1,
 max_depth INTEGER NOT NULL DEFAULT 5, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS excluded_workspaces (canonical_path TEXT PRIMARY KEY, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS discovery_runs (
 id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT NOT NULL,
 discovered_count INTEGER NOT NULL, removed_count INTEGER NOT NULL, errors TEXT NOT NULL
);`;

const MIGRATION_3 = `
CREATE TABLE IF NOT EXISTS usage_events (
 source_key TEXT PRIMARY KEY, surface_agent TEXT NOT NULL, workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
 occurred_at TEXT, day TEXT, model TEXT, input_tokens INTEGER NOT NULL DEFAULT 0,
 output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
 cache_write_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0,
 total_tokens INTEGER NOT NULL DEFAULT 0, session_hash TEXT, session_count INTEGER NOT NULL DEFAULT 0,
 date_precision TEXT NOT NULL, quality TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_events_day_agent ON usage_events(day, surface_agent);
CREATE INDEX IF NOT EXISTS idx_usage_events_workspace ON usage_events(workspace_id);
CREATE TABLE IF NOT EXISTS usage_daily (
 day TEXT NOT NULL, surface_agent TEXT NOT NULL, workspace_id TEXT NOT NULL DEFAULT '',
 input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
 cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
 reasoning_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0,
 session_count INTEGER NOT NULL DEFAULT 0, quality TEXT NOT NULL,
 PRIMARY KEY(day, surface_agent, workspace_id)
);
CREATE TABLE IF NOT EXISTS git_commits (
 repository_group_id TEXT NOT NULL, commit_hash TEXT NOT NULL, authored_at TEXT NOT NULL, day TEXT NOT NULL,
 author_identity_hash TEXT NOT NULL, is_mine INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(repository_group_id, commit_hash)
);
CREATE INDEX IF NOT EXISTS idx_git_commits_day ON git_commits(day);
CREATE TABLE IF NOT EXISTS commit_attributions (
 repository_group_id TEXT NOT NULL, commit_hash TEXT NOT NULL, agent TEXT NOT NULL,
 confidence TEXT NOT NULL, method TEXT NOT NULL, PRIMARY KEY(repository_group_id, commit_hash, agent)
);
CREATE TABLE IF NOT EXISTS git_identities (
 id TEXT PRIMARY KEY, identity_hash TEXT NOT NULL UNIQUE, source TEXT NOT NULL,
 label TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS insight_cursors (
 provider TEXT PRIMARY KEY, cursor_json TEXT, available INTEGER NOT NULL DEFAULT 0, quality TEXT NOT NULL,
 coverage_from TEXT, coverage_to TEXT, imported_events INTEGER NOT NULL DEFAULT 0,
 error TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS achievement_unlocks (
 code TEXT PRIMARY KEY, unlocked_at TEXT NOT NULL, rule_version INTEGER NOT NULL
);`;

const MIGRATION_4 = `
ALTER TABLE catalog_assets ADD COLUMN summary_key TEXT;
ALTER TABLE catalog_assets ADD COLUMN summary_params TEXT NOT NULL DEFAULT '{}';
ALTER TABLE insight_cursors ADD COLUMN error_key TEXT;
ALTER TABLE insight_cursors ADD COLUMN error_params TEXT NOT NULL DEFAULT '{}';
UPDATE catalog_assets SET summary_key = CASE summary
 WHEN 'AgentKib 公共指令' THEN 'assets.summary.sharedInstructions'
 WHEN '公共 Skill' THEN 'assets.summary.sharedSkill'
 WHEN '公共 MCP Connection' THEN 'assets.summary.sharedConnection'
 ELSE summary_key END;`;

const MIGRATION_5 = `
CREATE TABLE IF NOT EXISTS mcp_installations (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, package_kind TEXT NOT NULL, identifier TEXT NOT NULL,
 version TEXT, install_path TEXT, status TEXT NOT NULL, installed_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mcp_registry_cache (
 name TEXT PRIMARY KEY, entry_json TEXT NOT NULL, schema_version TEXT NOT NULL, etag TEXT, cached_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mcp_tool_cache (
 server_id TEXT NOT NULL, tool_name TEXT NOT NULL, descriptor_json TEXT NOT NULL,
 probed_at TEXT NOT NULL, PRIMARY KEY(server_id, tool_name)
);
CREATE TABLE IF NOT EXISTS mcp_runtime_snapshots (
 config_hash TEXT PRIMARY KEY, server_id TEXT NOT NULL, snapshot_json TEXT NOT NULL, updated_at TEXT NOT NULL
);`;

const MIGRATION_6 = `
CREATE TABLE IF NOT EXISTS workspaces (
 id TEXT PRIMARY KEY, canonical_path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
 repository_group_id TEXT, manifest_workspace_id TEXT, status TEXT NOT NULL,
 asset_count INTEGER NOT NULL DEFAULT 0, warning_count INTEGER NOT NULL DEFAULT 0,
 last_active_at TEXT, last_discovered_at TEXT NOT NULL, last_scanned_at TEXT
);
UPDATE workspaces SET status = 'healthy' WHERE status = 'needs-import';`;

const MIGRATION_7 = `
CREATE TABLE IF NOT EXISTS quota_snapshot (
 id INTEGER PRIMARY KEY CHECK (id = 1), snapshot_json TEXT, backend TEXT NOT NULL,
 backend_version TEXT, generated_at TEXT, fetched_at TEXT, stale_after_seconds INTEGER,
 last_attempt_at TEXT NOT NULL, last_success_at TEXT, error_key TEXT, error_detail TEXT
);`;

const MIGRATION_8 = `
CREATE TABLE IF NOT EXISTS workspace_storage (
 workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE, snapshot_json TEXT,
 last_attempt_at TEXT NOT NULL, last_success_at TEXT, error_key TEXT, error_detail TEXT
);`;

const MIGRATION_9 = `
CREATE TABLE IF NOT EXISTS conversation_sessions (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 agent TEXT NOT NULL, title TEXT, created_at TEXT, updated_at TEXT, message_count INTEGER,
 git_branch TEXT, archived INTEGER NOT NULL DEFAULT 0, sidechain INTEGER NOT NULL DEFAULT 0,
 availability TEXT NOT NULL, last_indexed_at TEXT NOT NULL, UNIQUE(workspace_id, agent, id)
);
CREATE INDEX IF NOT EXISTS idx_conversation_sessions_workspace_updated
 ON conversation_sessions(workspace_id, updated_at DESC, created_at DESC);
CREATE TABLE IF NOT EXISTS conversation_index_status (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, agent TEXT NOT NULL,
 session_count INTEGER NOT NULL DEFAULT 0, last_attempt_at TEXT NOT NULL, last_success_at TEXT,
 error_key TEXT, error_detail TEXT, PRIMARY KEY(workspace_id, agent)
);`;
