import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { UsageQuality } from "./types.js";

/** Providers implemented by the Rust insights collector but kept separate from
 * the first TypeScript rollout until the runtime wiring is enabled. */
export type ExtraSurfaceAgent = "open-claw" | "hermes" | "deepseek-harness";

export interface ExtraUsageEventRecord {
  source_key: string;
  surface_agent: ExtraSurfaceAgent;
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

export interface ExtraUsageBatch {
  agent: ExtraSurfaceAgent;
  fingerprint: string;
  events: ExtraUsageEventRecord[];
  available: boolean;
  quality: UsageQuality;
  coverage_from?: string;
  coverage_to?: string;
  error?: string;
}

const execFileAsync = promisify(execFile);

/** Collect the providers that are not part of usage.ts's initial Codex/Claude pass. */
export async function collectExtraUsage(home = homedir()): Promise<ExtraUsageBatch[]> {
  return Promise.all([
    collectOpenClawUsage(),
    collectHermesUsage(home),
    collectDeepSeekUsage(home),
  ]);
}

export async function collectOpenClawUsage(): Promise<ExtraUsageBatch> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "openclaw",
      ["gateway", "usage-cost", "--all-agents", "--json"],
      { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 },
    ));
  } catch {
    return unavailable("open-claw", "OpenClaw local usage-cost query is unavailable");
  }

  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return unavailable("open-claw", "OpenClaw usage-cost output was not valid JSON");
  }
  const events: ExtraUsageEventRecord[] = [];
  collectOpenClawValues(value, undefined, events, "root");
  return finishBatch("open-claw", hashText(stdout), events);
}

function collectOpenClawValues(
  value: unknown,
  inheritedAgent: string | undefined,
  events: ExtraUsageEventRecord[],
  key: string,
): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) =>
      collectOpenClawValues(child, inheritedAgent, events, `${key}:${index}`),
    );
    return;
  }
  const object = asRecord(value);
  if (!object) return;

  const agent = stringValue(object.agent) ?? stringValue(object.agentId) ?? inheritedAgent;
  const day = parseDay(stringValue(object.date) ?? stringValue(object.day));
  const total = numberValue(object.totalTokens ?? object.total_tokens ?? object.tokens);
  if (day && total > 0) {
    const model = stringValue(object.model) ?? "all";
    const channel = stringValue(object.channel) ?? "all";
    events.push({
      source_key: `openclaw:${day}:${agent ?? "all"}:${model}:${channel}`,
      surface_agent: "open-claw",
      day,
      model: model === "all" ? undefined : model,
      input_tokens: numberValue(object.inputTokens),
      output_tokens: numberValue(object.outputTokens),
      cache_read_tokens: numberValue(object.cacheReadTokens),
      cache_write_tokens: numberValue(object.cacheWriteTokens),
      reasoning_tokens: numberValue(object.reasoningTokens),
      total_tokens: total,
      session_count: numberValue(object.sessions),
      date_precision: "day",
      quality: "exact",
    });
    return;
  }
  for (const [childKey, child] of Object.entries(object)) {
    collectOpenClawValues(child, agent, events, `${key}:${childKey}`);
  }
}

async function collectHermesUsage(home: string): Promise<ExtraUsageBatch> {
  const paths = await hermesStateDatabases(home);
  const fingerprint = await fingerprintFiles(paths);
  if (!paths.length)
    return unavailable("hermes", "Hermes is not installed or state.db was not found", fingerprint);

  const events: ExtraUsageEventRecord[] = [];
  for (const databasePath of paths) {
    let database: DatabaseSync;
    try {
      database = new DatabaseSync(databasePath, { readOnly: true });
    } catch {
      continue;
    }
    try {
      const columns = new Set(
        (database.prepare("PRAGMA table_info(sessions)").all() as Array<{ name?: unknown }>).map(
          (row) => String(row.name ?? ""),
        ),
      );
      if (!columns.size) continue;
      const select = (name: string, aliases: string[]): string => {
        const found = aliases.find((candidate) => columns.has(candidate));
        return found ? `\`${found.replaceAll("`", "")}\`` : "NULL";
      };
      const rows = database
        .prepare(
          `SELECT ${select("id", ["id", "session_id"])} id,
            ${select("cwd", ["cwd", "working_directory", "project_path"])} cwd,
            ${select("timestamp", ["updated_at", "created_at", "timestamp"])} timestamp,
            ${select("model", ["model"])} model,
            ${select("input", ["input_tokens"])} input_tokens,
            ${select("output", ["output_tokens"])} output_tokens,
            ${select("cache_read", ["cache_read_tokens"])} cache_read_tokens,
            ${select("cache_write", ["cache_write_tokens"])} cache_write_tokens,
            ${select("reasoning", ["reasoning_tokens"])} reasoning_tokens
           FROM sessions`,
        )
        .all() as Array<Record<string, unknown>>;
      rows.forEach((row, index) => {
        const input = numberValue(row.input_tokens);
        const output = numberValue(row.output_tokens);
        const cacheRead = numberValue(row.cache_read_tokens);
        const cacheWrite = numberValue(row.cache_write_tokens);
        const reasoning = numberValue(row.reasoning_tokens);
        const total = input + output;
        if (!total) return;
        const occurred = timestamp(row.timestamp);
        const id = stringValue(row.id) ?? String(index);
        events.push({
          source_key: `hermes:${databasePath}:${id}`,
          surface_agent: "hermes",
          workspace_path: stringValue(row.cwd),
          occurred_at: occurred,
          day: occurred ? localDay(occurred) : undefined,
          model: stringValue(row.model),
          input_tokens: input,
          output_tokens: output,
          cache_read_tokens: cacheRead,
          cache_write_tokens: cacheWrite,
          reasoning_tokens: reasoning,
          total_tokens: total,
          session_key: stringValue(row.id),
          session_count: 1,
          date_precision: occurred ? "exact" : "aggregate",
          quality: "exact",
        });
      });
    } catch {
      // A profile can be created by a newer Hermes version; skip only that profile.
    } finally {
      database.close();
    }
  }
  return finishBatch(
    "hermes",
    fingerprint,
    events,
    events.length ? undefined : "Hermes state.db does not contain usable session statistics",
  );
}

async function hermesStateDatabases(home: string): Promise<string[]> {
  const root = path.join(home, ".hermes");
  const output: string[] = [];
  const rootState = path.join(root, "state.db");
  if (await isFile(rootState)) output.push(rootState);
  const profiles = path.join(root, "profiles");
  await collectStateDatabases(profiles, 0, output);
  return [...new Set(output)].sort();
}

async function collectStateDatabases(
  directory: string,
  depth: number,
  output: string[],
): Promise<void> {
  if (depth > 3) return;
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === "state.db") output.push(full);
    else if (entry.isDirectory()) await collectStateDatabases(full, depth + 1, output);
  }
}

async function collectDeepSeekUsage(home: string): Promise<ExtraUsageBatch> {
  const root = process.env.DSH_HOME ?? path.join(home, ".dsh");
  const file = path.join(root, "storages", "session_projcache.json");
  const fingerprint = await fingerprintFiles([file]);
  const raw = await readFile(file, "utf8").catch(() => undefined);
  if (!raw)
    return unavailable(
      "deepseek-harness",
      "DeepSeek Harness projection cache was not found",
      fingerprint,
    );
  const value = parseJson(raw);
  const unit = asRecord(value?.unit);
  if (unit?.name !== "session_projcache" || numberValue(unit.version) !== 3) {
    return unavailable(
      "deepseek-harness",
      "DeepSeek Harness projection cache version is not supported",
      fingerprint,
    );
  }
  const sessions = asRecord(asRecord(value?.tables)?.sessions);
  if (!sessions)
    return unavailable(
      "deepseek-harness",
      "DeepSeek Harness projection cache has no sessions table",
      fingerprint,
    );
  const events: ExtraUsageEventRecord[] = [];
  for (const [sessionId, recordValue] of Object.entries(sessions)) {
    const record = asRecord(recordValue);
    const tokenRow = asRecord(asRecord(record?.rows)?.tokenUsage);
    if (numberValue(tokenRow?.ver) !== 1) continue;
    const totals = asRecord(asRecord(tokenRow?.val)?.totals);
    if (!totals) continue;
    const input = numberValue(totals.uncachedInputTokens);
    const output = numberValue(totals.outputTokens);
    const cacheRead = numberValue(totals.cacheReadTokens);
    const cacheWrite = numberValue(totals.cacheWriteTokens);
    const total = input + output + cacheRead + cacheWrite;
    if (!total) continue;
    events.push({
      source_key: `deepseek-harness:${sessionId}`,
      surface_agent: "deepseek-harness",
      workspace_path: stringValue(asRecord(record?.identity)?.cwd),
      input_tokens: input,
      output_tokens: output,
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
      reasoning_tokens: 0,
      total_tokens: total,
      session_key: sessionId,
      session_count: 1,
      date_precision: "aggregate",
      quality: "incomplete",
    });
  }
  return finishBatch(
    "deepseek-harness",
    fingerprint,
    events,
    events.length ? undefined : "DeepSeek Harness projection cache has no usable Token data",
  );
}

function finishBatch(
  agent: ExtraSurfaceAgent,
  fingerprint: string,
  events: ExtraUsageEventRecord[],
  error?: string,
): ExtraUsageBatch {
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
    error,
  };
}

function unavailable(agent: ExtraSurfaceAgent, error: string, fingerprint = ""): ExtraUsageBatch {
  return { agent, fingerprint, events: [], available: false, quality: "incomplete", error };
}

async function fingerprintFiles(files: string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const file of [...files].sort()) {
    const metadata = await stat(file).catch(() => undefined);
    hash
      .update(file)
      .update(String(metadata?.size ?? 0))
      .update(String(metadata?.mtimeMs ?? 0));
  }
  return hash.digest("hex");
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function isFile(file: string): Promise<boolean> {
  return (await stat(file).catch(() => undefined))?.isFile() ?? false;
}

function parseJson(value: string): Record<string, any> | undefined {
  try {
    return asRecord(JSON.parse(value));
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

function parseDay(value: string | undefined): string | undefined {
  return value && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : undefined;
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

function localDay(value: string): string {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
