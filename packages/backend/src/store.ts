import { SessionStore } from "./session-store";
import { Insights } from "./insights";
import { Sql } from "./sql";
import { Catalog } from "./catalog";
import { existsSync } from "node:fs";
import { WorkspaceStore } from "./workspace-store";
import { timestamp } from "./timestamps";
export { timestamp } from "./timestamps";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export const SHARED_SCHEMA_VERSION = 15;
type Row = Record<string, unknown>;
const AGENTS = [
  "codex",
  "claude-code",
  "cursor",
  "opencode",
  "open-claw",
  "hermes",
  "grok-build",
  "antigravity",
  "deepseek-harness",
];
const EVIDENCE = ["session-cwd", "configured-workspace", "scan-marker", "manual"];

/** Rust owns schema upgrades; each migrated module owns its writes to shared schema 15. */
export class BackendStore {
  readonly #database: DatabaseSync;
  readonly workspaces: WorkspaceStore;
  readonly sql: Sql;
  readonly catalog: Catalog;
  readonly insights: Insights;
  readonly sessions: SessionStore;

  constructor(databasePath: string) {
    if (!existsSync(databasePath)) throw new Error("Shared database has not been initialized");
    this.#database = new DatabaseSync(databasePath);
    try {
      this.#database.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
      const row = this.#database
        .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
        .get();
      if (row?.value !== String(SHARED_SCHEMA_VERSION)) {
        throw new Error(
          `TypeScript backend requires shared database schema ${SHARED_SCHEMA_VERSION}; received ${String(row?.value)}`,
        );
      }
      this.workspaces = new WorkspaceStore(this.#database);
      this.sql = new Sql(this.#database);
      this.catalog = new Catalog(this.sql);
      this.insights = new Insights(this.sql);
      this.sessions = new SessionStore(this.sql, (id) => this.workspacePath(id));
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  close(): void {
    this.#database.close();
  }

  listWorkspaces(): unknown[] {
    this.#database.exec("BEGIN;");
    try {
      const result = this.#rows(
        "SELECT id, canonical_path, name, repository_group_id, manifest_workspace_id, status, asset_count, warning_count, last_active_at, last_scanned_at FROM workspaces ORDER BY COALESCE(last_active_at, last_scanned_at) DESC, name ASC",
      ).map((row) => this.#workspace(row));
      this.#database.exec("COMMIT;");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  workspacePath(id: string): string {
    const row = this.#rows(
      "SELECT canonical_path FROM workspaces WHERE id = ? OR manifest_workspace_id = ? LIMIT 1",
      id,
      id,
    )[0];
    if (!row) throw new Error("Workspace does not exist");
    return String(row.canonical_path);
  }

  getWorkspace(id: string): unknown {
    const row = this.#rows(
      "SELECT id, canonical_path, name, repository_group_id, manifest_workspace_id, status, asset_count, warning_count, last_active_at, last_scanned_at FROM workspaces WHERE id = ?",
      id,
    )[0];
    if (!row) throw new Error("Workspace does not exist");
    return this.#workspace(row);
  }

  #workspace(row: Row) {
    return {
      id: row.id,
      path: row.canonical_path,
      name: row.name,
      repository_group_id: row.repository_group_id,
      manifest_workspace_id: row.manifest_workspace_id,
      status: storedChoice(row.status, ["healthy", "attention"]),
      asset_count: Math.max(0, Number(row.asset_count)),
      warning_count: Math.max(0, Number(row.warning_count)),
      last_active_at: timestamp(row.last_active_at, true),
      last_scanned_at: timestamp(row.last_scanned_at, true),
      sources: this.#rows(
        "SELECT agent, evidence, session_count, last_active_at, session_cwds FROM workspace_sources WHERE workspace_id = ? ORDER BY last_active_at DESC",
        String(row.id),
      ).map((source) => {
        const cwds: unknown = JSON.parse(String(source.session_cwds));
        if (!Array.isArray(cwds) || cwds.some((cwd) => typeof cwd !== "string"))
          throw new Error("Invalid stored session working directories");
        return {
          agent: source.agent === "" ? null : storedChoice(source.agent, AGENTS),
          evidence: storedChoice(source.evidence, EVIDENCE),
          session_count: Math.max(0, Number(source.session_count)),
          last_active_at: timestamp(source.last_active_at, true),
          ...(cwds.length ? { session_cwds: cwds } : {}),
        };
      }),
    };
  }

  listActivity(limit: number): unknown[] {
    return this.#rows(
      "SELECT id, project_id, action, detail, created_at FROM audit_events ORDER BY created_at DESC LIMIT ?",
      Math.min(500, Math.max(1, limit)),
    ).map((row) => ({ ...row, created_at: timestamp(row.created_at) }));
  }

  listScanRoots(): unknown[] {
    return this.#rows(
      "SELECT id, canonical_path, enabled, max_depth, created_at FROM scan_roots ORDER BY created_at ASC",
    ).map((row) => ({
      id: row.id,
      path: row.canonical_path,
      enabled: Number(row.enabled) !== 0,
      max_depth: Number(row.max_depth),
      created_at: timestamp(row.created_at),
    }));
  }

  listExcludedWorkspaces(): unknown[] {
    return this.#rows(
      "SELECT canonical_path, created_at FROM excluded_workspaces ORDER BY created_at DESC",
    ).map((row) => ({ path: row.canonical_path, created_at: timestamp(row.created_at) }));
  }

  #rows(sql: string, ...params: SQLInputValue[]): Row[] {
    const statement = this.#database.prepare(sql);
    statement.setReadBigInts(true);
    return statement.all(...params);
  }
}

function storedChoice(value: unknown, choices: string[]): string {
  if (typeof value !== "string" || !choices.includes(value))
    throw new Error(`Invalid stored enum value: ${String(value)}`);
  return value;
}
