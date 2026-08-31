import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentKind, ConversationIndexStatus, ConversationSessionSummary } from "./types.js";
const HEADER_LIMIT = 2 * 1024 * 1024;
export async function listWorkspaceSessions(
  workspace: string,
  agent: AgentKind,
): Promise<{ sessions: ConversationSessionSummary[]; status: ConversationIndexStatus }> {
  const attempted = new Date().toISOString(),
    sessions: ConversationSessionSummary[] = [],
    errors: string[] = [];
  const roots =
    agent === "codex"
      ? [path.join(workspace, ".codex")]
      : agent === "claude-code"
        ? [path.join(workspace, ".claude")]
        : [];
  for (const root of roots) await walk(root, 0);
  sessions.sort(
    (a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? "") || a.id.localeCompare(b.id),
  );
  return {
    sessions,
    status: {
      workspace_id: workspace,
      agent,
      freshness: errors.length ? (sessions.length ? "stale" : "unavailable") : "fresh",
      session_count: sessions.length,
      last_attempt_at: attempted,
      last_success_at: errors.length ? undefined : new Date().toISOString(),
      error_key: errors.length ? "conversation.indexPartial" : undefined,
      error_detail: errors.slice(0, 3).join("\n") || undefined,
    },
  };
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > 8) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      errors.push(`Could not read transcript directory: ${directory}`);
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile() && (full.endsWith(".jsonl") || full.endsWith(".json")))
        await inspect(full);
    }
  }
  async function inspect(file: string): Promise<void> {
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) return;
      if (info.size > 256 * 1024 * 1024) {
        errors.push(`Transcript exceeds limit: ${file}`);
        return;
      }
      const content = await readFile(file, "utf8");
      const lines = content.slice(0, HEADER_LIMIT).split(/\r?\n/).filter(Boolean);
      let first: Record<string, unknown> = {};
      for (const line of lines.slice(0, 256)) {
        try {
          first = { ...first, ...(JSON.parse(line) as Record<string, unknown>) };
        } catch {
          break;
        }
      }
      const id = String(first.sessionId ?? first.session_id ?? first.id ?? path.basename(file));
      const created =
        typeof first.createdAt === "string"
          ? first.createdAt
          : typeof first.timestamp === "string"
            ? first.timestamp
            : undefined;
      const updated = typeof first.updatedAt === "string" ? first.updatedAt : created;
      sessions.push({
        id,
        native_ref: file,
        workspace_id: workspace,
        agent,
        title: typeof first.title === "string" ? first.title.slice(0, 200) : undefined,
        created_at: created,
        updated_at: updated,
        message_count: lines.length,
        archived: false,
        sidechain: false,
        availability: "readable",
      });
    } catch {
      sessions.push({
        id: path.basename(file),
        native_ref: file,
        workspace_id: workspace,
        agent,
        archived: false,
        sidechain: false,
        availability: "metadata-only",
      });
      errors.push(`Could not read transcript: ${file}`);
    }
  }
}
