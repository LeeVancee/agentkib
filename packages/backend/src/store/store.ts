import { createHmac, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./database.js";
import { canonicalize, canonicalizeAllowMissing } from "../platform/path.js";
import { stat } from "node:fs/promises";
import path from "node:path";
import { BackendError, backendError } from "../contracts.js";
import type {
  AddWorkspaceInput,
  ExcludedWorkspace,
  Memory,
  ProposeMemoryInput,
  Workspace,
  MemoryStatus,
} from "../domain/types.js";
import type { WorkspaceScan } from "../domain/types.js";
import type { GitRepositorySnapshot } from "../insights/types.js";
import type { UsageBatch } from "../insights/usage.js";

const optional = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
function workspace(row: Record<string, unknown>): Workspace {
  return {
    id: String(row.id),
    canonical_path: String(row.canonical_path),
    name: String(row.name),
    repository_group_id: optional(row.repository_group_id),
    manifest_workspace_id: optional(row.manifest_workspace_id),
    status: String(row.status) as Workspace["status"],
    asset_count: Number(row.asset_count),
    warning_count: Number(row.warning_count),
    last_active_at: optional(row.last_active_at),
    last_discovered_at: String(row.last_discovered_at),
    last_scanned_at: optional(row.last_scanned_at),
  };
}
function memory(row: Record<string, unknown>): Memory {
  return {
    id: String(row.id),
    project_id: String(row.project_id),
    memory_type: String(row.memory_type) as Memory["memory_type"],
    content: String(row.content),
    status: String(row.status) as MemoryStatus,
    source_agent: optional(row.source_agent),
    source_thread: optional(row.source_thread),
    source_reference: optional(row.source_reference),
    created_at: String(row.created_at),
    approved_at: optional(row.approved_at),
    invalidated_by: optional(row.invalidated_by),
  };
}

export class BackendStore {
  constructor(readonly database: DatabaseSync) {}
  static open(filePath: string): BackendStore {
    return new BackendStore(openDatabase(filePath));
  }
  close(): void {
    this.database.close();
  }

  listWorkspaces(): Workspace[] {
    return (
      this.database
        .prepare("SELECT * FROM workspaces ORDER BY name, canonical_path")
        .all() as Array<Record<string, unknown>>
    ).map(workspace);
  }
  getWorkspace(id: string): Workspace {
    const row = this.database.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw backendError("NOT_FOUND", `Workspace not found: ${id}`);
    return workspace(row);
  }
  workspacePath(id: string): string {
    return this.getWorkspace(id).canonical_path;
  }
  recordWorkspaceScan(canonicalPath: string, result: WorkspaceScan): void {
    const now = new Date().toISOString();
    try {
      this.database.exec("BEGIN IMMEDIATE");
      const updated = this.database
        .prepare(
          "UPDATE workspaces SET asset_count = ?, warning_count = ?, last_scanned_at = ? WHERE canonical_path = ?",
        )
        .run(result.assets.length, result.warnings.length, now, canonicalPath);
      if (!updated.changes)
        throw backendError("NOT_FOUND", `Workspace not found: ${canonicalPath}`);
      const row = this.database
        .prepare("SELECT id FROM workspaces WHERE canonical_path = ?")
        .get(canonicalPath) as { id: string };
      this.database.prepare("DELETE FROM catalog_assets WHERE workspace_id = ?").run(row.id);
      const insert = this.database.prepare(
        "INSERT INTO catalog_assets (id, scope, workspace_id, agent, kind, name, path, summary, size, modified_at, summary_key, summary_params) VALUES (?, 'workspace', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const asset of result.assets) {
        insert.run(
          randomUUID(),
          row.id,
          asset.agent,
          asset.kind,
          path.basename(asset.path),
          asset.path,
          asset.summary,
          asset.size,
          now,
          asset.summary_key ?? null,
          JSON.stringify(asset.summary_params ?? {}),
        );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw BackendError.from(error);
    }
  }
  listWorkspaceSources(workspaceId: string): Array<Record<string, unknown>> {
    return this.database
      .prepare(
        "SELECT agent, evidence, session_count, last_active_at FROM workspace_sources WHERE workspace_id = ? ORDER BY agent, evidence",
      )
      .all(workspaceId) as Array<Record<string, unknown>>;
  }
  async upsertDiscoveredWorkspace(candidate: {
    path: string;
    evidence: string;
    source_agent?: string;
    session_count: number;
  }): Promise<void> {
    const canonicalPath = await canonicalizeAllowMissing(candidate.path);
    if (
      this.database
        .prepare("SELECT 1 FROM excluded_workspaces WHERE canonical_path = ?")
        .get(canonicalPath)
    )
      return;
    const now = new Date().toISOString();
    const existing = this.database
      .prepare("SELECT id FROM workspaces WHERE canonical_path = ?")
      .get(canonicalPath) as { id: string } | undefined;
    const id = existing?.id ?? randomUUID();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (existing) {
        this.database
          .prepare("UPDATE workspaces SET last_discovered_at = ? WHERE id = ?")
          .run(now, id);
      } else {
        this.database
          .prepare(
            "INSERT INTO workspaces (id, canonical_path, name, status, last_discovered_at) VALUES (?, ?, ?, 'healthy', ?)",
          )
          .run(id, canonicalPath, path.basename(canonicalPath) || canonicalPath, now);
      }
      this.database
        .prepare(
          "INSERT INTO workspace_sources (workspace_id, agent, evidence, session_count, last_active_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(workspace_id, agent, evidence) DO UPDATE SET session_count = excluded.session_count, last_active_at = excluded.last_active_at",
        )
        .run(
          id,
          candidate.source_agent ?? "codex",
          candidate.evidence,
          candidate.session_count,
          now,
        );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw BackendError.from(error);
    }
  }
  syncGitSnapshot(snapshot: GitRepositorySnapshot): void {
    let salt = (
      this.database.prepare("SELECT value FROM schema_meta WHERE key = 'insights_salt'").get() as
        | { value?: string }
        | undefined
    )?.value;
    if (!salt) {
      salt = `${randomUUID()}${randomUUID()}`;
      this.database
        .prepare("INSERT OR IGNORE INTO schema_meta(key, value) VALUES ('insights_salt', ?)")
        .run(salt);
    }
    const hashIdentity = (email: string) =>
      createHmac("sha256", salt!).update(email.trim().toLowerCase()).digest("hex");
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const identity of snapshot.identities) {
        const identityHash = hashIdentity(identity.email);
        this.database
          .prepare(
            "INSERT INTO git_identities(id, identity_hash, source, label, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?) ON CONFLICT(identity_hash) DO UPDATE SET source = excluded.source, label = excluded.label",
          )
          .run(identityHash, identityHash, identity.source, identity.label, now);
      }
      if (snapshot.changed) {
        this.database
          .prepare("DELETE FROM commit_attributions WHERE repository_group_id = ?")
          .run(snapshot.repository_group_id);
        this.database
          .prepare("DELETE FROM git_commits WHERE repository_group_id = ?")
          .run(snapshot.repository_group_id);
        const insert = this.database.prepare(
          "INSERT INTO git_commits(repository_group_id, commit_hash, authored_at, day, author_identity_hash, is_mine) VALUES (?, ?, ?, ?, ?, EXISTS(SELECT 1 FROM git_identities WHERE identity_hash = ? AND enabled = 1))",
        );
        for (const commit of snapshot.commits) {
          const day = commit.authored_at.slice(0, 10);
          const identityHash = hashIdentity(commit.author_email);
          insert.run(
            snapshot.repository_group_id,
            commit.hash,
            commit.authored_at,
            day,
            identityHash,
            identityHash,
          );
        }
      }
      this.database
        .prepare(
          "UPDATE git_commits SET is_mine = EXISTS(SELECT 1 FROM git_identities WHERE identity_hash = git_commits.author_identity_hash AND enabled = 1)",
        )
        .run();
      this.database
        .prepare(
          "INSERT INTO insight_cursors(provider, cursor_json, available, quality, imported_events, updated_at) VALUES (?, ?, 1, 'exact', ?, ?) ON CONFLICT(provider) DO UPDATE SET cursor_json = excluded.cursor_json, available = 1, quality = 'exact', imported_events = excluded.imported_events, error = NULL, updated_at = excluded.updated_at",
        )
        .run(
          `git:${snapshot.repository_group_id}`,
          snapshot.fingerprint,
          snapshot.commits.length,
          now,
        );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw BackendError.from(error);
    }
  }
  syncUsageBatch(batch: UsageBatch): void {
    const now = new Date().toISOString();
    let salt = (
      this.database.prepare("SELECT value FROM schema_meta WHERE key = 'insights_salt'").get() as
        | { value?: string }
        | undefined
    )?.value;
    if (!salt) {
      salt = `${randomUUID()}${randomUUID()}`;
      this.database
        .prepare("INSERT OR IGNORE INTO schema_meta(key, value) VALUES ('insights_salt', ?)")
        .run(salt);
    }
    const keyed = (value: string) => createHmac("sha256", salt!).update(value).digest("hex");
    const workspaces = this.listWorkspaces();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (batch.available)
        this.database.prepare("DELETE FROM usage_events WHERE surface_agent = ?").run(batch.agent);
      const insert = this.database.prepare(
        "INSERT INTO usage_events(source_key, surface_agent, workspace_id, occurred_at, day, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens, session_hash, session_count, date_precision, quality) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const event of batch.events) {
        const workspaceId = event.workspace_path
          ? workspaces.find(
              (workspace) =>
                path.resolve(workspace.canonical_path) === path.resolve(event.workspace_path!),
            )?.id
          : undefined;
        insert.run(
          keyed(event.source_key),
          event.surface_agent,
          workspaceId ?? null,
          event.occurred_at ?? null,
          event.day ?? null,
          event.model ?? null,
          event.input_tokens,
          event.output_tokens,
          event.cache_read_tokens,
          event.cache_write_tokens,
          event.reasoning_tokens,
          event.total_tokens,
          event.session_key ? keyed(event.session_key) : null,
          event.session_count,
          event.date_precision,
          event.quality,
        );
      }
      this.database
        .prepare(
          "INSERT INTO insight_cursors(provider, cursor_json, available, quality, coverage_from, coverage_to, imported_events, error, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(provider) DO UPDATE SET cursor_json = excluded.cursor_json, available = excluded.available, quality = excluded.quality, coverage_from = excluded.coverage_from, coverage_to = excluded.coverage_to, imported_events = excluded.imported_events, error = excluded.error, updated_at = excluded.updated_at",
        )
        .run(
          batch.agent,
          batch.fingerprint,
          batch.available ? 1 : 0,
          batch.quality,
          batch.coverage_from ?? null,
          batch.coverage_to ?? null,
          batch.events.length,
          batch.error ?? null,
          now,
        );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw BackendError.from(error);
    }
  }
  async addWorkspace(input: AddWorkspaceInput): Promise<Workspace> {
    const canonicalPath = await canonicalize(input.path);
    if (!(await stat(canonicalPath)).isDirectory())
      throw backendError("VALIDATION", "Workspace must be a directory");
    const now = new Date().toISOString();
    const id = randomUUID();
    try {
      this.database.exec("BEGIN IMMEDIATE");
      this.database
        .prepare("DELETE FROM excluded_workspaces WHERE canonical_path = ?")
        .run(canonicalPath);
      this.database
        .prepare(
          "INSERT INTO workspaces (id, canonical_path, name, status, last_discovered_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          id,
          canonicalPath,
          input.name ?? canonicalPath.split(/[\\/]/).pop() ?? canonicalPath,
          input.status ?? "healthy",
          now,
        );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      if (String(error).includes("UNIQUE"))
        throw backendError("CONFLICT", "Workspace path already exists");
      throw BackendError.from(error);
    }
    return this.getWorkspace(id);
  }
  excludeWorkspace(id: string): void {
    const pathValue = this.workspacePath(id);
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(
          "INSERT OR REPLACE INTO excluded_workspaces (canonical_path, created_at) VALUES (?, ?)",
        )
        .run(pathValue, now);
      this.database.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw BackendError.from(error);
    }
  }
  async restoreExcludedWorkspace(pathValue: string): Promise<void> {
    const canonicalPath = await canonicalizeAllowMissing(pathValue);
    this.database
      .prepare("DELETE FROM excluded_workspaces WHERE canonical_path = ?")
      .run(canonicalPath);
  }
  listExcludedWorkspaces(): ExcludedWorkspace[] {
    return this.database
      .prepare(
        "SELECT canonical_path, created_at FROM excluded_workspaces ORDER BY created_at DESC",
      )
      .all() as unknown as ExcludedWorkspace[];
  }

  listAgentInstallations(): Array<{
    agent: string;
    installed: boolean;
    configured: boolean;
    version?: string;
    home?: string;
    warnings: string[];
  }> {
    const rows = this.database
      .prepare(
        "SELECT agent, installed, configured, version, home, warnings FROM agent_installations ORDER BY agent",
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => {
      let warnings: string[] = [];
      try {
        const parsed = JSON.parse(String(row.warnings ?? "[]"));
        if (Array.isArray(parsed))
          warnings = parsed.filter((item): item is string => typeof item === "string");
      } catch {
        warnings = ["Stored installation warnings are invalid"];
      }
      return {
        agent: String(row.agent),
        installed: Boolean(row.installed),
        configured: Boolean(row.configured),
        ...(typeof row.version === "string" ? { version: row.version } : {}),
        ...(typeof row.home === "string" ? { home: row.home } : {}),
        warnings,
      };
    });
  }

  searchCatalogAssets(
    query: string,
    agent?: string,
    workspaceId?: string,
    limit = 500,
  ): Array<Record<string, unknown>> {
    const pattern = `%${query.trim().replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    return this.database
      .prepare(
        "SELECT id, scope, workspace_id, agent, kind, name, path, summary, size, modified_at, summary_key, summary_params FROM catalog_assets WHERE (name LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR COALESCE(summary_key, '') LIKE ? ESCAPE '\\') AND (? IS NULL OR agent = ?) AND (? IS NULL OR workspace_id = ?) ORDER BY modified_at DESC, name ASC LIMIT ?",
      )
      .all(
        pattern,
        pattern,
        pattern,
        pattern,
        agent ?? null,
        agent ?? null,
        workspaceId ?? null,
        workspaceId ?? null,
        Math.min(Math.max(Math.floor(limit), 1), 500),
      ) as Array<Record<string, unknown>>;
  }

  listGlobalMemories(status?: MemoryStatus): Memory[] {
    const rows = status
      ? this.database
          .prepare("SELECT * FROM memories WHERE status = ? ORDER BY created_at DESC")
          .all(status)
      : this.database.prepare("SELECT * FROM memories ORDER BY created_at DESC").all();
    return (rows as Array<Record<string, unknown>>).map(memory);
  }

  listActivity(limit = 200): Array<{
    id: string;
    project_id?: string;
    action: string;
    detail: string;
    created_at: string;
  }> {
    return this.database
      .prepare(
        "SELECT id, project_id, action, detail, created_at FROM audit_events ORDER BY created_at DESC LIMIT ?",
      )
      .all(Math.min(Math.max(Math.floor(limit), 1), 500))
      .map((row) => {
        const value = row as Record<string, unknown>;
        return {
          id: String(value.id),
          ...(typeof value.project_id === "string" ? { project_id: value.project_id } : {}),
          action: String(value.action),
          detail: String(value.detail),
          created_at: String(value.created_at),
        };
      });
  }

  proposeMemory(input: ProposeMemoryInput): Memory {
    if (!input.content.trim()) throw backendError("VALIDATION", "Memory content cannot be empty");
    const id = randomUUID(),
      now = new Date().toISOString();
    this.database
      .prepare(
        "INSERT INTO memories (id, project_id, memory_type, content, status, source_agent, source_thread, source_reference, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)",
      )
      .run(
        id,
        input.project_id,
        input.memory_type,
        input.content.trim(),
        input.source_agent ?? null,
        input.source_thread ?? null,
        input.source_reference ?? null,
        now,
      );
    return this.getMemory(id);
  }
  listMemories(projectId: string, status?: MemoryStatus): Memory[] {
    const rows = status
      ? this.database
          .prepare(
            "SELECT * FROM memories WHERE project_id = ? AND status = ? ORDER BY created_at DESC",
          )
          .all(projectId, status)
      : this.database
          .prepare("SELECT * FROM memories WHERE project_id = ? ORDER BY created_at DESC")
          .all(projectId);
    return (rows as Array<Record<string, unknown>>).map(memory);
  }
  searchMemories(projectId: string, query: string, limit = 50): Memory[] {
    if (!query.trim()) return this.listMemories(projectId, "approved").slice(0, limit);
    const rows = this.database
      .prepare(
        "SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.id WHERE f.project_id = ? AND memories_fts MATCH ? AND m.status = 'approved' ORDER BY rank LIMIT ?",
      )
      .all(projectId, query, limit);
    return (rows as Array<Record<string, unknown>>).map(memory);
  }
  reviewMemory(
    id: string,
    status: Exclude<MemoryStatus, "pending">,
    editedContent?: string,
  ): Memory {
    if (editedContent !== undefined && !editedContent.trim())
      throw backendError("VALIDATION", "Memory content cannot be empty");
    const result = this.database
      .prepare(
        "UPDATE memories SET content = COALESCE(?, content), status = ?, approved_at = CASE WHEN ? = 'approved' THEN ? ELSE approved_at END WHERE id = ?",
      )
      .run(editedContent?.trim() ?? null, status, status, new Date().toISOString(), id);
    if (!result.changes) throw backendError("NOT_FOUND", `Memory not found: ${id}`);
    return this.getMemory(id);
  }
  private getMemory(id: string): Memory {
    const row = this.database.prepare("SELECT * FROM memories WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw backendError("NOT_FOUND", `Memory not found: ${id}`);
    return memory(row);
  }
}
