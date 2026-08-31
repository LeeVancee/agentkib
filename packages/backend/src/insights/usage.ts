import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { AgentKind } from "../domain/types.js";
import type { UsageQuality } from "./types.js";
import { collectExtraUsage } from "./usage-extra.js";

export interface UsageEventRecord {
  source_key: string;
  surface_agent: AgentKind;
  workspace_path?: string;
  occurred_at?: string;
  day?: string;
  model?: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  session_key?: string;
  session_count: number;
  date_precision: "exact" | "day" | "aggregate";
  quality: UsageQuality;
}
export interface UsageBatch {
  agent: UsageEventRecord["surface_agent"];
  fingerprint: string;
  events: UsageEventRecord[];
  available: boolean;
  quality: UsageQuality;
  coverage_from?: string;
  coverage_to?: string;
  error?: string;
}

export async function collectUsage(home = homedir()): Promise<UsageBatch[]> {
  const [codex, claude, extra] = await Promise.all([
    collectCodexUsage(home),
    collectClaudeUsage(home),
    collectExtraUsage(home),
  ]);
  return [codex, claude, ...extra];
}

async function collectCodexUsage(home: string): Promise<UsageBatch> {
  const codexHome = path.resolve(process.env.CODEX_HOME ?? path.join(home, ".codex"));
  const files = await collectJsonl(path.join(codexHome, "sessions"));
  const databases = await stateDatabases(codexHome);
  const sourceFiles = [...files, ...databases];
  const fingerprint = `codex-models-v2:${await fingerprintFiles(sourceFiles)}`;
  const sessionModels = await codexSessionModels(codexHome, databases);
  const aggregates = new Map<string, UsageEventRecord>();
  const detailedSessions = new Set<string>();
  for (const file of files) {
    const lines = (await readFile(file, "utf8").catch(() => "")).split(/\r?\n/);
    let workspace: string | undefined;
    let counted = false;
    for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
      const raw = lines[lineNumber];
      if (!raw.includes("token_count") && !raw.includes("session_meta")) continue;
      const value = parseRecord(raw);
      if (!value) continue;
      const payload = asRecord(value.payload);
      const payloadType = typeof payload?.type === "string" ? payload.type : undefined;
      if (payloadType === "session_meta" || value.type === "session_meta") {
        const cwd = payload?.cwd ?? value.cwd;
        if (typeof cwd === "string") workspace = cwd;
        continue;
      }
      if (payloadType !== "token_count") continue;
      const usage =
        asRecord(asRecord(payload?.info)?.last_token_usage) ?? asRecord(payload?.last_token_usage);
      if (!usage) continue;
      const total = numberValue(usage.total_tokens);
      if (!total) continue;
      const occurred = typeof value.timestamp === "string" ? value.timestamp : undefined;
      const day = localDay(occurred);
      const model =
        stringValue(asRecord(payload?.info)?.model) ??
        stringValue(payload?.model) ??
        sessionModels.get(file);
      const sessionKey = file;
      const key = `${sessionKey}\0${day ?? ""}\0${model ?? ""}\0${workspace ?? ""}`;
      const existing = aggregates.get(key);
      const event: UsageEventRecord = existing ?? {
        source_key: `codex-session:${sessionKey}:${day ?? ""}:${model ?? ""}`,
        surface_agent: "codex",
        workspace_path: workspace,
        occurred_at: occurred,
        day,
        model,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        total_tokens: 0,
        session_key: sessionKey,
        session_count: 0,
        date_precision: "exact",
        quality: "exact",
      };
      event.occurred_at = latest(event.occurred_at, occurred);
      event.input_tokens += numberValue(usage.input_tokens);
      event.output_tokens += numberValue(usage.output_tokens);
      event.cache_read_tokens += numberValue(usage.cached_input_tokens);
      event.reasoning_tokens += numberValue(usage.reasoning_output_tokens);
      event.total_tokens += total;
      if (!counted) event.session_count = 1;
      aggregates.set(key, event);
      counted = true;
      detailedSessions.add(file);
    }
  }
  for (const databasePath of databases) {
    let database: DatabaseSync;
    try {
      database = new DatabaseSync(databasePath, { readOnly: true });
    } catch {
      continue;
    }
    try {
      const columns = new Set(
        (database.prepare("PRAGMA table_info(threads)").all() as Array<{ name?: unknown }>).map(
          (row) => String(row.name),
        ),
      );
      if (!columns.has("tokens_used") || !columns.has("updated_at")) continue;
      const rollout = columns.has("rollout_path") ? "rollout_path" : "NULL";
      const model = columns.has("model") ? "model" : "NULL";
      const rows = database
        .prepare(
          `SELECT ${rollout} rollout_path, cwd, updated_at, tokens_used, ${model} model FROM threads WHERE tokens_used > 0`,
        )
        .all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        const total = numberValue(row.tokens_used);
        if (!total) continue;
        const rolloutPath = normalizeCodexPath(stringValue(row.rollout_path), codexHome);
        if (rolloutPath && detailedSessions.has(rolloutPath)) continue;
        const occurred = timestamp(row.updated_at);
        const fallbackKey =
          rolloutPath ?? `${databasePath}:${String(row.cwd ?? "")}:${String(row.updated_at ?? "")}`;
        aggregates.set(`fallback:${fallbackKey}`, {
          source_key: `codex-fallback:${fallbackKey}`,
          surface_agent: "codex",
          workspace_path: stringValue(row.cwd),
          occurred_at: occurred,
          day: localDay(occurred),
          model: stringValue(row.model),
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          reasoning_tokens: 0,
          total_tokens: total,
          session_key: rolloutPath,
          session_count: 1,
          date_precision: "aggregate",
          quality: "incomplete",
        });
      }
    } finally {
      database.close();
    }
  }
  return finishBatch("codex", fingerprint, [...aggregates.values()]);
}

async function codexSessionModels(
  codexHome: string,
  databases: string[],
): Promise<Map<string, string>> {
  const models = new Map<string, string>();
  for (const databasePath of databases) {
    let database: DatabaseSync;
    try {
      database = new DatabaseSync(databasePath, { readOnly: true });
    } catch {
      continue;
    }
    try {
      const columns = new Set(
        (database.prepare("PRAGMA table_info(threads)").all() as Array<{ name?: unknown }>).map(
          (row) => String(row.name),
        ),
      );
      if (!columns.has("rollout_path") || !columns.has("model")) continue;
      const rows = database
        .prepare(
          "SELECT rollout_path, model FROM threads WHERE rollout_path IS NOT NULL AND model IS NOT NULL AND model != ''",
        )
        .all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        const model = stringValue(row.model);
        const rolloutPath = normalizeCodexPath(stringValue(row.rollout_path), codexHome);
        if (model && rolloutPath) models.set(rolloutPath, model);
      }
    } finally {
      database.close();
    }
  }
  return models;
}

function normalizeCodexPath(value: string | undefined, codexHome: string): string | undefined {
  if (!value) return undefined;
  return path.resolve(path.isAbsolute(value) ? value : path.join(codexHome, value));
}

async function collectClaudeUsage(home: string): Promise<UsageBatch> {
  const file = path.join(
    process.env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"),
    "stats-cache.json",
  );
  const fingerprint = await fingerprintFiles([file]);
  const parsed = parseRecord(await readFile(file, "utf8").catch(() => ""));
  if (!parsed)
    return {
      agent: "claude-code",
      fingerprint,
      events: [],
      available: false,
      quality: "incomplete",
      error: "Claude stats cache was not found",
    };
  const events: UsageEventRecord[] = [];
  const dailyTokens = Array.isArray(parsed.dailyModelTokens) ? parsed.dailyModelTokens : [];
  for (const dayValue of dailyTokens) {
    const dayRecord = asRecord(dayValue);
    const day = stringValue(dayRecord?.date);
    if (!day) continue;
    const models = asRecord(dayRecord?.tokensByModel) ?? {};
    for (const [model, value] of Object.entries(models)) {
      const total = numberValue(value);
      if (total)
        events.push({
          source_key: `claude:daily:${day}:${model}`,
          surface_agent: "claude-code",
          day,
          model,
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          reasoning_tokens: 0,
          total_tokens: total,
          session_count: 0,
          date_precision: "day",
          quality: "exact",
        });
    }
  }
  const dailyActivity = Array.isArray(parsed.dailyActivity) ? parsed.dailyActivity : [];
  for (const dayValue of dailyActivity) {
    const dayRecord = asRecord(dayValue);
    const day = stringValue(dayRecord?.date);
    const sessions = numberValue(dayRecord?.sessionCount);
    if (day && sessions)
      events.push({
        source_key: `claude:sessions:${day}`,
        surface_agent: "claude-code",
        day,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        total_tokens: 0,
        session_count: sessions,
        date_precision: "day",
        quality: "exact",
      });
  }
  const modelUsage = asRecord(parsed.modelUsage) ?? {};
  const hasDaily = events.some((event) => event.total_tokens > 0);
  for (const [model, value] of Object.entries(modelUsage)) {
    const usage = asRecord(value);
    const input = numberValue(usage?.inputTokens),
      output = numberValue(usage?.outputTokens),
      cacheRead = numberValue(usage?.cacheReadInputTokens),
      cacheWrite = numberValue(usage?.cacheCreationInputTokens);
    if (input + output + cacheRead + cacheWrite === 0) continue;
    events.push({
      source_key: `claude:model-aggregate:${model}`,
      surface_agent: "claude-code",
      model,
      input_tokens: input,
      output_tokens: output,
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
      reasoning_tokens: 0,
      total_tokens: hasDaily ? 0 : input + output,
      session_count: 0,
      date_precision: "aggregate",
      quality: hasDaily ? "exact" : "incomplete",
    });
  }
  return finishBatch("claude-code", fingerprint, events);
}

function finishBatch(
  agent: UsageEventRecord["surface_agent"],
  fingerprint: string,
  events: UsageEventRecord[],
): UsageBatch {
  const days = events
    .map((event) => event.day)
    .filter((day): day is string => Boolean(day))
    .sort();
  return {
    agent,
    fingerprint,
    events,
    available: events.length > 0,
    quality: events.some((event) => event.quality === "incomplete") ? "incomplete" : "exact",
    coverage_from: days[0],
    coverage_to: days.at(-1),
    error: events.length ? undefined : `${agent} usage data is unavailable`,
  };
}
async function collectJsonl(directory: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await collectJsonl(full)));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) output.push(full);
  }
  return output;
}
async function stateDatabases(directory: string): Promise<string[]> {
  const current = (await readdir(directory, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && /^state_.*\.sqlite$/.test(entry.name))
    .map((entry) => path.join(directory, entry.name));
  if (current.length) return current;
  return (await readdir(path.join(directory, "sqlite"), { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && /^state_.*\.sqlite$/.test(entry.name))
    .map((entry) => path.join(directory, "sqlite", entry.name));
}
async function fingerprintFiles(files: string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    const metadata = await stat(file).catch(() => undefined);
    hash
      .update(file)
      .update(String(metadata?.size ?? 0))
      .update(String(metadata?.mtimeMs ?? 0));
  }
  return hash.digest("hex");
}
function parseRecord(value: string): Record<string, any> | undefined {
  try {
    const parsed = JSON.parse(value);
    return asRecord(parsed);
  } catch {
    return undefined;
  }
}
function asRecord(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : undefined;
}
function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function numberValue(value: unknown): number {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}
function timestamp(value: unknown): string | undefined {
  if (typeof value === "number") {
    const date = new Date(Math.abs(value) > 100_000_000_000 ? value : value * 1000);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return typeof value === "string" && !Number.isNaN(Date.parse(value))
    ? new Date(value).toISOString()
    : undefined;
}
function localDay(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
function latest(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return left > right ? left : right;
}
