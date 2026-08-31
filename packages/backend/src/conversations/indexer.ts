import { lstat, readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
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
  if (agent === "codex") await indexCodex(homeDir(), workspace);
  else if (agent === "claude-code") await indexClaude(homeDir(), workspace);
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

  async function indexCodex(home: string, project: string): Promise<void> {
    const roots = [path.join(home, ".codex"), path.join(home, "Library", "Application Support", "Codex")];
    const databases = new Set<string>();
    for (const root of roots) {
      for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
        if (entry.isFile() && /^(state_.*|.*state.*)\.sqlite$/.test(entry.name)) databases.add(path.join(root, entry.name));
      }
    }
    for (const databasePath of databases) {
      let database: DatabaseSync;
      try { database = new DatabaseSync(databasePath, { readOnly: true }); }
      catch (error) { errors.push(`Could not open Codex session database: ${databasePath}`); continue; }
      try {
        const columns = new Set((database.prepare("PRAGMA table_info(threads)").all() as Array<{ name?: unknown }>).map((row) => String(row.name)));
        if (!columns.has("id") || !columns.has("cwd") || !columns.has("rollout_path")) continue;
        const expr = (names: string[], fallback: string) => names.find((name) => columns.has(name)) ?? fallback;
        const rows = database.prepare(`SELECT id, rollout_path, cwd, ${expr(["name", "title", "preview"], "''")} title, ${expr(["created_at_ms", "created_at"], "NULL")} created, ${expr(["recency_at_ms", "updated_at_ms", "recency_at", "updated_at"], "NULL")} updated, ${expr(["git_branch"], "NULL")} branch, ${expr(["archived"], "0")} archived FROM threads`).all() as Array<Record<string, unknown>>;
        for (const row of rows) {
          const cwd = String(row.cwd ?? "");
          if (!sameWorkspace(cwd, project)) continue;
          const transcript = path.isAbsolute(String(row.rollout_path ?? "")) ? String(row.rollout_path) : path.join(home, String(row.rollout_path ?? ""));
          sessions.push({
            id: String(row.id), native_ref: transcript, workspace_id: project, agent,
            title: typeof row.title === "string" ? row.title.slice(0, 200) : undefined,
            created_at: timestamp(row.created), updated_at: timestamp(row.updated),
            git_branch: typeof row.branch === "string" ? row.branch : undefined,
            archived: Number(row.archived ?? 0) !== 0, sidechain: false,
            availability: await lstat(transcript).then((info) => info.isFile() ? "readable" : "metadata-only").catch(() => "metadata-only"),
          });
        }
      } catch { errors.push(`Could not read Codex sessions: ${databasePath}`); }
      finally { database.close(); }
    }
  }

  async function indexClaude(home: string, project: string): Promise<void> {
    const root = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"), "projects");
    const files: string[] = [];
    await collectFiles(root, 3, files);
    for (const file of files.filter((value) => value.endsWith(".jsonl"))) {
      try {
        const content = (await readFile(file, "utf8")).slice(0, HEADER_LIMIT);
        const lines = content.split(/\r?\n/).filter(Boolean);
        const values = lines.slice(0, 64).flatMap((line) => { try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; } });
        const projectPath = values.map((value) => value.projectPath ?? value.project_path ?? value.cwd).find((value): value is string => typeof value === "string");
        if (projectPath && !sameWorkspace(projectPath, project)) continue;
        if (!projectPath && !file.includes(project.replaceAll(path.sep, "-"))) continue;
        const first = values[0] ?? {};
        const id = String(first.sessionId ?? first.session_id ?? first.id ?? path.basename(file, ".jsonl"));
        sessions.push({ id, native_ref: file, workspace_id: project, agent, title: typeof first.summary === "string" ? first.summary.slice(0, 200) : typeof first.title === "string" ? first.title.slice(0, 200) : undefined, created_at: typeof first.timestamp === "string" ? first.timestamp : undefined, updated_at: typeof first.timestamp === "string" ? first.timestamp : undefined, message_count: lines.length, archived: false, sidechain: Boolean(first.isSidechain), availability: "readable" });
      } catch { errors.push(`Could not read Claude transcript: ${file}`); }
    }
  }

  async function collectFiles(directory: string, depth: number, output: string[]): Promise<void> {
    if (depth < 0) return;
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await collectFiles(full, depth - 1, output);
      else if (entry.isFile()) output.push(full);
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

function homeDir(): string { return homedir(); }
function sameWorkspace(left: string, right: string): boolean {
  const a = path.resolve(left), b = path.resolve(right);
  return a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);
}
function timestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(Math.abs(value) > 100_000_000_000 ? value : value * 1000);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value === "string") { const date = new Date(value); return Number.isNaN(date.getTime()) ? undefined : date.toISOString(); }
  return undefined;
}
