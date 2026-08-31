import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./database.js";
import { canonicalize, canonicalizeAllowMissing } from "../platform/path.js";
import { stat } from "node:fs/promises";
import { BackendError, backendError } from "../contracts.js";
import type {
  AddWorkspaceInput,
  ExcludedWorkspace,
  Memory,
  ProposeMemoryInput,
  Workspace,
  MemoryStatus,
} from "../domain/types.js";

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
