import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export const SHARED_SCHEMA_VERSION = 15;
type Row = Record<string, unknown>;
const AGENTS = [
  "codex",
  "claude-code",
  "cursor",
  "opencode",
  "openclaw",
  "hermes",
  "grok-build",
  "antigravity",
  "deepseek-harness",
];
const EVIDENCE = ["session-cwd", "configured-workspace", "scan-marker", "manual"];

/** During coexistence Rust alone migrates and writes SQLite; TS reads the shared schema. */
export class BackendStore {
  readonly #database: DatabaseSync;

  constructor(databasePath: string) {
    this.#database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      this.#database.exec("PRAGMA busy_timeout = 5000; PRAGMA query_only = ON;");
      const row = this.#database
        .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
        .get();
      if (row?.value !== String(SHARED_SCHEMA_VERSION)) {
        throw new Error(
          `TypeScript backend requires shared database schema ${SHARED_SCHEMA_VERSION}; received ${String(row?.value)}`,
        );
      }
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
      ).map((row) => ({
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
      }));
      this.#database.exec("COMMIT;");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
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

/** Match chrono's UTC serialization without dropping sub-millisecond precision. */
export function timestamp(value: unknown, permissive = false): string | null {
  if (value === null || value === undefined) return null;
  if (
    (typeof value === "bigint" || (typeof value === "string" && /^[+-]?\d+$/.test(value))) &&
    permissive
  ) {
    const time = Number(value);
    const date = new Date(Math.abs(time) >= 100_000_000_000 ? time : time * 1000);
    return Number.isNaN(date.valueOf()) ? null : date.toISOString().replace(".000Z", "Z");
  }
  if (typeof value === "string") {
    const match =
      /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}:\d{2}):(\d{2})(?:\.(\d{1,9}))?([Zz]|[+-]\d{2}:\d{2})$/.exec(
        value,
      );
    if (match) {
      const leapSecond = match[3] === "60";
      const local = `${match[1]}T${match[2]}:${leapSecond ? "59" : match[3]}`;
      const wallClock = new Date(`${local}Z`);
      const date = new Date(`${local}${match[5].toUpperCase()}`);
      // Date normalizes dates such as February 30; chrono rejects them.
      if (
        !Number.isNaN(date.valueOf()) &&
        !Number.isNaN(wallClock.valueOf()) &&
        wallClock.toISOString().slice(0, 19) === local
      ) {
        const nanos = (match[4] ?? "").padEnd(9, "0");
        const fraction =
          Number(nanos) === 0
            ? ""
            : `.${nanos.slice(0, nanos.endsWith("000000") ? 3 : nanos.endsWith("000") ? 6 : 9)}`;
        const utc = date.toISOString().slice(0, 19);
        return `${leapSecond ? `${utc.slice(0, 17)}60` : utc}${fraction}Z`;
      }
    }
  }
  if (permissive) return null;
  throw new Error("Invalid stored timestamp");
}

function storedChoice(value: unknown, choices: string[]): string {
  if (typeof value !== "string" || !choices.includes(value))
    throw new Error(`Invalid stored enum value: ${String(value)}`);
  return value;
}
