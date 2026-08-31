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
  const unique = new Map<string, ConversationSessionSummary>();
  for (const session of sessions) {
    const key = `${session.agent}:${session.id}`;
    const previous = unique.get(key);
    if (!previous || (previous.availability !== "readable" && session.availability === "readable"))
      unique.set(key, session);
  }
  sessions.splice(0, sessions.length, ...unique.values());
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
    const sessionCountBefore = sessions.length;
    const codexHome = path.resolve(process.env.CODEX_HOME ?? path.join(home, ".codex"));
    const roots = [codexHome, path.join(codexHome, "sqlite")];
    const currentDatabases = await codexDatabasesIn(roots[0]);
    const databases = currentDatabases.length ? currentDatabases : await codexDatabasesIn(roots[1]);
    // The desktop Codex build has also used this Application Support location;
    // include it as a compatibility source without reviving the legacy sqlite
    // database when current databases are available.
    if (!databases.length)
      databases.push(
        ...(await codexDatabasesIn(path.join(home, "Library", "Application Support", "Codex"))),
      );
    // Older Codex integrations exposed project-local JSONL transcripts. Keep this
    // read-only fallback so existing workspaces remain visible while native SQLite
    // indexing is unavailable.
    if (!databases.length || sessions.length === sessionCountBefore)
      await walk(path.join(project, ".codex"), 0);
    for (const databasePath of new Set(databases)) {
      let database: DatabaseSync;
      try {
        database = new DatabaseSync(databasePath, { readOnly: true });
      } catch (error) {
        errors.push(`Could not open Codex session database: ${databasePath}`);
        continue;
      }
      try {
        const columns = new Set(
          (database.prepare("PRAGMA table_info(threads)").all() as Array<{ name?: unknown }>).map(
            (row) => String(row.name),
          ),
        );
        if (!columns.has("id") || !columns.has("cwd") || !columns.has("rollout_path")) continue;
        const expr = (names: string[], fallback: string) => {
          const existing = names.filter((name) => columns.has(name));
          if (!existing.length) return fallback;
          return existing.length === 1 ? existing[0] : `COALESCE(${existing.join(", ")})`;
        };
        const rows = database
          .prepare(
            `SELECT id, rollout_path, cwd, ${expr(["name", "title", "preview"], "''")} title, ${expr(["created_at_ms", "created_at"], "NULL")} created, ${expr(["recency_at_ms", "updated_at_ms", "recency_at", "updated_at"], "NULL")} updated, ${expr(["git_branch"], "NULL")} branch, ${expr(["archived"], "0")} archived FROM threads`,
          )
          .all() as Array<Record<string, unknown>>;
        for (const row of rows) {
          const cwd = String(row.cwd ?? "");
          if (!sameWorkspace(cwd, project)) continue;
          const transcript = path.isAbsolute(String(row.rollout_path ?? ""))
            ? String(row.rollout_path)
            : path.join(codexHome, String(row.rollout_path ?? ""));
          sessions.push({
            id: String(row.id),
            native_ref: transcript,
            workspace_id: project,
            agent,
            title: sanitizeSessionTitle(row.title),
            created_at: timestamp(row.created),
            updated_at: timestamp(row.updated),
            git_branch: typeof row.branch === "string" ? row.branch : undefined,
            archived: Number(row.archived ?? 0) !== 0,
            sidechain: false,
            availability: await lstat(transcript)
              .then((info) => (info.isFile() ? "readable" : "metadata-only"))
              .catch(() => "metadata-only"),
          });
        }
      } catch {
        errors.push(`Could not read Codex sessions: ${databasePath}`);
      } finally {
        database.close();
      }
    }
  }

  async function codexDatabasesIn(directory: string): Promise<string[]> {
    return (await readdir(directory, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isFile() && /^state_.*\.sqlite$/.test(entry.name))
      .map((entry) => path.join(directory, entry.name));
  }

  async function indexClaude(home: string, project: string): Promise<void> {
    const root = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"), "projects");
    const files: string[] = [];
    await collectFiles(root, 3, files);
    const indexed = new Map<string, ConversationSessionSummary>();
    for (const file of files.filter((value) => path.basename(value) === "sessions-index.json")) {
      try {
        const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
        if (Number(parsed.version ?? 1) !== 1) continue;
        const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
        for (const entry of entries) {
          if (!entry || typeof entry !== "object") continue;
          const value = entry as Record<string, unknown>;
          const projectPath = String(value.projectPath ?? "");
          if (!projectPath || !sameWorkspace(projectPath, project)) continue;
          const id = String(value.sessionId ?? "");
          if (!id) continue;
          const transcript =
            typeof value.fullPath === "string"
              ? value.fullPath
              : path.join(path.dirname(file), `${id}.jsonl`);
          indexed.set(id, {
            id,
            native_ref: transcript,
            workspace_id: project,
            agent,
            title: sanitizeSessionTitle(value.summary ?? value.firstPrompt),
            created_at: timestamp(value.created),
            updated_at: timestamp(value.modified ?? value.fileMtime),
            message_count: typeof value.messageCount === "number" ? value.messageCount : undefined,
            git_branch: typeof value.gitBranch === "string" ? value.gitBranch : undefined,
            archived: false,
            sidechain: value.isSidechain === true,
            availability: await lstat(transcript)
              .then((info) => (info.isFile() ? "readable" : "metadata-only"))
              .catch(() => "metadata-only"),
          });
        }
      } catch {
        errors.push(`Could not read Claude session index: ${file}`);
      }
    }
    for (const file of files.filter((value) => value.endsWith(".jsonl"))) {
      try {
        const content = (await readFile(file, "utf8")).slice(0, HEADER_LIMIT);
        const lines = content.split(/\r?\n/).filter(Boolean);
        const values = lines.slice(0, 64).flatMap((line) => {
          try {
            return [JSON.parse(line) as Record<string, unknown>];
          } catch {
            return [];
          }
        });
        const projectPath = values
          .map((value) => value.projectPath ?? value.project_path ?? value.cwd)
          .find((value): value is string => typeof value === "string");
        if (projectPath && !sameWorkspace(projectPath, project)) continue;
        if (!projectPath && !file.includes(project.replaceAll(path.sep, "-"))) continue;
        const first = values[0] ?? {};
        const id = String(
          first.sessionId ?? first.session_id ?? first.id ?? path.basename(file, ".jsonl"),
        );
        const existing = indexed.get(id);
        indexed.set(id, {
          id,
          native_ref: file,
          workspace_id: project,
          agent,
          title: existing?.title ?? sanitizeSessionTitle(first.summary ?? first.title),
          created_at: existing?.created_at ?? timestamp(first.timestamp),
          updated_at: latestTimestamp(existing?.updated_at, timestamp(first.timestamp)),
          message_count: existing?.message_count ?? lines.length,
          git_branch:
            existing?.git_branch ??
            (typeof first.gitBranch === "string" ? first.gitBranch : undefined),
          archived: existing?.archived ?? false,
          sidechain: existing?.sidechain ?? Boolean(first.isSidechain),
          availability: "readable",
        });
      } catch {
        errors.push(`Could not read Claude transcript: ${file}`);
      }
    }
    const historyFile = path.join(path.dirname(root), "history.jsonl");
    for (const line of (await readFile(historyFile, "utf8").catch(() => ""))
      .split(/\r?\n/)
      .filter(Boolean)) {
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        const id = typeof value.sessionId === "string" ? value.sessionId : undefined;
        const session = id ? indexed.get(id) : undefined;
        if (session)
          session.updated_at = latestTimestamp(session.updated_at, timestamp(value.timestamp));
      } catch {
        errors.push(`Could not parse Claude history: ${historyFile}`);
        break;
      }
    }
    sessions.push(...indexed.values());
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
        title: sanitizeSessionTitle(first.title),
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

function homeDir(): string {
  return homedir();
}
function sanitizeSessionTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .split(/\s+/u)
    .join(" ");
  return normalized ? normalized.slice(0, 200) : undefined;
}
function sameWorkspace(left: string, right: string): boolean {
  const a = path.resolve(left),
    b = path.resolve(right);
  return a === b || a.startsWith(`${b}${path.sep}`);
}
function timestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(Math.abs(value) > 100_000_000_000 ? value : value * 1000);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return undefined;
}
function latestTimestamp(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return left >= right ? left : right;
}
