import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { backendError } from "../contracts.js";
import { z } from "zod";
export type QuotaBackend = "codex-bar-cli" | "win-codex-bar";
export type QuotaFreshness = "fresh" | "stale" | "unavailable";
export interface CollectorCapabilities {
  platform_supported: boolean;
  sidecar_available: boolean;
  multi_account: boolean;
  credits: boolean;
}
export interface QuotaWindow {
  kind: string;
  label: string;
  used_percent: number;
  remaining_percent: number;
  reset_at?: string;
}
export interface QuotaProvider {
  id: string;
  name: string;
  enabled: boolean;
  source?: string;
  status?: { level: string; label: string; updated_at?: string };
  identity?: { account_email?: string; plan?: string };
  windows: QuotaWindow[];
  credits?: { remaining: number; unit: string };
  error?: string;
  updated_at?: string;
  accounts?: unknown[];
}
export interface QuotaSnapshot {
  schema_version: number;
  backend: QuotaBackend;
  backend_version?: string;
  generated_at: string;
  fetched_at: string;
  stale_after_seconds: number;
  freshness: QuotaFreshness;
  providers: QuotaProvider[];
}
export function refreshFreshness(snapshot: QuotaSnapshot, now = new Date()): QuotaSnapshot {
  const stale =
    now.getTime() >
    Date.parse(snapshot.generated_at) + Math.max(1, snapshot.stale_after_seconds) * 1000;
  return { ...snapshot, freshness: stale ? "stale" : "fresh" };
}
export function selectBackend(platform = process.platform): QuotaBackend {
  return platform === "win32" ? "win-codex-bar" : "codex-bar-cli";
}
export function sanitizeDiagnostic(value: string): string {
  return value
    .replace(/(token|secret|password|api[_-]?key)\s*[=:]\s*[^\s]+/gi, "$1=[REDACTED]")
    .slice(0, 2000);
}
export interface CommandOutput {
  stdout: string;
  stderr: string;
  success: boolean;
}
export interface CommandRunner {
  run(args: string[], timeoutMs: number, signal?: AbortSignal): Promise<CommandOutput>;
}
const quotaWindowSchema = z
  .object({
    kind: z.string(),
    label: z.string(),
    usedPercent: z.number().finite(),
    remainingPercent: z.number().finite(),
    resetAt: z.string().optional(),
  })
  .passthrough();
const quotaProviderSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    enabled: z.boolean(),
    source: z.string().optional(),
    status: z
      .object({
        level: z.string(),
        label: z.string(),
        updatedAt: z.string().optional(),
      })
      .nullable()
      .optional(),
    identity: z
      .object({ accountEmail: z.string().optional(), plan: z.string().optional() })
      .nullable()
      .optional(),
    windows: z.array(quotaWindowSchema).default([]),
    credits: z
      .object({ remaining: z.number().finite(), unit: z.string() })
      .nullable()
      .optional(),
    error: z.unknown().optional(),
    updatedAt: z.string().optional(),
    accounts: z
      .array(
        z
          .object({
            id: z.string(),
            label: z.string(),
            active: z.boolean(),
            identity: z
              .object({ accountEmail: z.string().optional(), plan: z.string().optional() })
              .nullable()
              .optional(),
            windows: z.array(quotaWindowSchema).default([]),
            error: z.unknown().optional(),
            updatedAt: z.string().optional(),
          })
          .passthrough(),
      )
      .nullish()
      .transform((value) => value ?? []),
  })
  .passthrough();
const dashboardSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z.string(),
    staleAfterSeconds: z.number().finite().nonnegative().default(300),
    host: z.object({ codexBarVersion: z.string().nullish() }).passthrough().optional(),
    providers: z.array(quotaProviderSchema).default([]),
  })
  .passthrough();
export class NodeQuotaRunner implements CommandRunner {
  constructor(
    private readonly executable: string,
    private readonly configPath?: string,
  ) {}
  async run(args: string[], timeoutMs: number, signal?: AbortSignal): Promise<CommandOutput> {
    try {
      const result = await promisify(execFile)(this.executable, args, {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        signal,
        env: this.configPath
          ? { ...process.env, CODEXBAR_CONFIG: this.configPath }
          : process.env,
      });
      return { stdout: result.stdout, stderr: result.stderr, success: true };
    } catch (error) {
      if (signal?.aborted) throw backendError("CANCELLED", "Quota collection cancelled");
      return {
        stdout: String((error as { stdout?: string }).stdout ?? ""),
        stderr: String((error as { stderr?: string }).stderr ?? ""),
        success: false,
      };
    }
  }
}
export async function collectQuota(
  runner: CommandRunner,
  backend = selectBackend(),
  timeoutMs = 30_000,
  signal?: AbortSignal,
): Promise<QuotaSnapshot> {
  const output = await runner.run(
    ["dashboard", "--identity", "full", "--timeout", backend === "win-codex-bar" ? "12" : "25"],
    timeoutMs,
    signal,
  );
  if (!output.success)
    throw backendError(
      "IO",
      `Quota collector command failed: ${sanitizeDiagnostic(output.stderr)}`,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.stdout);
  } catch {
    throw backendError("VALIDATION", "Quota collector returned invalid JSON");
  }
  const result = dashboardSchema.safeParse(parsed);
  if (!result.success || Number.isNaN(Date.parse(result.data?.generatedAt ?? "")))
    throw backendError("VALIDATION", "Quota collector returned invalid dashboard JSON");
  const raw = result.data;
  const identity = (value: { accountEmail?: string; plan?: string } | null | undefined) =>
    value
      ? {
          ...(value.accountEmail ? { account_email: value.accountEmail } : {}),
          ...(value.plan ? { plan: value.plan } : {}),
        }
      : undefined;
  const diagnostic = (value: unknown): string | undefined => {
    if (typeof value === "string") return sanitizeDiagnostic(value);
    if (value && typeof value === "object" && "message" in value) {
      const message = (value as { message?: unknown }).message;
      if (typeof message === "string") return sanitizeDiagnostic(message);
    }
    return value === undefined || value === null ? undefined : "Provider unavailable";
  };
  const windows = (items: Array<z.infer<typeof quotaWindowSchema>>) =>
    items.map((window) => ({
      kind: window.kind,
      label: window.label,
      used_percent: window.usedPercent,
      remaining_percent: window.remainingPercent,
      reset_at: window.resetAt,
    }));
  const snapshot: QuotaSnapshot = {
    schema_version: 1,
    backend,
    backend_version: raw.host?.codexBarVersion ?? undefined,
    generated_at: raw.generatedAt,
    fetched_at: new Date().toISOString(),
    stale_after_seconds: raw.staleAfterSeconds,
    freshness: "fresh",
    providers: raw.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      enabled: provider.enabled,
      source: provider.source,
      status: provider.status
        ? {
            level: provider.status.level,
            label: provider.status.label,
            updated_at: provider.status.updatedAt,
          }
        : undefined,
      identity: identity(provider.identity),
      windows: windows(provider.windows),
      credits: provider.credits
        ? { remaining: provider.credits.remaining, unit: provider.credits.unit }
        : undefined,
      error: diagnostic(provider.error),
      updated_at: provider.updatedAt,
      accounts: provider.accounts.map((account) => ({
        id: account.id,
        label: account.label,
        active: account.active,
        identity: identity(account.identity),
        windows: windows(account.windows),
        error: diagnostic(account.error),
        updated_at: account.updatedAt,
      })),
    })),
  };
  return refreshFreshness(snapshot);
}
