import type {
  DiscoveryReport,
  InsightsStatus,
  QuotaCollectorStatus,
  QuotaSnapshot,
  RefreshJobStatus,
  RefreshKind,
  RefreshReceipt,
  RemoteGatewaySummary,
  RuntimeInfo,
} from "../../src/core/types";
import { RUNTIME_METHODS } from "../generated/runtime-protocol";
import type { DesktopRuntimeHost } from "./runtime-host";

const REFRESH_KINDS: RefreshKind[] = ["discovery", "insights", "gateways", "quota", "storage"];
const SCHEDULER_INTERVAL_MS = 60_000;
const DISCOVERY_INITIAL_DELAY_MS = 3_000;
const GATEWAYS_INITIAL_DELAY_MS = 5_000;
const INSIGHTS_INITIAL_DELAY_MS = 30_000;
const QUOTA_INITIAL_DELAY_MS = 1_000;
const DISCOVERY_MAX_AGE_MS = 15 * 60_000;
const GATEWAYS_MAX_AGE_MS = 15 * 60_000;
const INSIGHTS_MAX_AGE_MS = 30 * 60_000;
const QUOTA_VISIBLE_MAX_AGE_MS = 5 * 60_000;
const QUOTA_BACKGROUND_MAX_AGE_MS = 15 * 60_000;
const QUOTA_RESET_GRACE_MS = 60_000;

interface RefreshCoordinatorOptions {
  runtime(): DesktopRuntimeHost;
  isMainWindowVisible(): boolean;
  onStatus(status: RefreshJobStatus): void;
  onQuotaSnapshot(snapshot: QuotaSnapshot): void;
}

interface JobRecord {
  status: RefreshJobStatus;
  failures: number;
}

export class ElectronRefreshCoordinator {
  readonly #options: RefreshCoordinatorOptions;
  readonly #jobs = new Map<RefreshKind, JobRecord>(
    REFRESH_KINDS.map((kind) => [kind, { status: idleStatus(kind), failures: 0 }]),
  );
  readonly #active = new Map<RefreshKind, Promise<RefreshReceipt>>();
  readonly #timers = new Set<NodeJS.Timeout>();
  #refreshLane: Promise<void> = Promise.resolve();
  #sequence = 1;
  #accepting = false;
  #runtimeAvailable = true;

  constructor(options: RefreshCoordinatorOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#accepting) return;
    this.#accepting = true;
    void this.#seedFreshness()
      .catch(() => undefined)
      .finally(() => {
        if (!this.#accepting) return;
        this.#schedule("quota", QUOTA_INITIAL_DELAY_MS);
        this.#schedule("discovery", DISCOVERY_INITIAL_DELAY_MS);
        this.#schedule("gateways", GATEWAYS_INITIAL_DELAY_MS);
        this.#schedule("insights", INSIGHTS_INITIAL_DELAY_MS);
      });
  }

  stop(): void {
    this.#accepting = false;
    for (const timer of this.#timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    this.#timers.clear();
  }

  setRuntimeAvailable(available: boolean): void {
    this.#runtimeAvailable = available;
    if (!available) return;
    for (const record of this.#jobs.values()) {
      if (record.status.state !== "failed" && record.status.state !== "backoff") continue;
      record.status = {
        ...record.status,
        state: "idle",
        finished_at: undefined,
        error: undefined,
        next_allowed_at: undefined,
      };
      this.#emit(record.status);
    }
    if (this.#accepting) void this.refreshIfDue();
  }

  statuses(): RefreshJobStatus[] {
    return REFRESH_KINDS.map((kind) => ({ ...this.#record(kind).status }));
  }

  request(kind: RefreshKind, force = false): Promise<RefreshReceipt> {
    const active = this.#active.get(kind);
    if (active) {
      const status = { ...this.#record(kind).status };
      return Promise.resolve({
        kind,
        disposition: "already-running",
        request_id: status.request_id ?? this.#requestId(kind),
        status,
      });
    }
    if (!this.#accepting) return Promise.reject(new Error("Refresh coordinator is shutting down"));
    if (!this.#runtimeAvailable) return Promise.reject(new Error("AgentKib runtime is restarting"));

    const record = this.#record(kind);
    const now = Date.now();
    const nextAllowedAt = parseTime(record.status.next_allowed_at);
    if (!force && Number.isFinite(nextAllowedAt) && nextAllowedAt > now) {
      record.status = { ...record.status, state: "backoff" };
      this.#emit(record.status);
      return Promise.resolve({
        kind,
        disposition: "backoff",
        request_id: record.status.request_id ?? this.#requestId(kind),
        status: { ...record.status },
      });
    }

    const requestId = this.#requestId(kind);
    const queuedAt = new Date().toISOString();
    record.status = {
      kind,
      state: "queued",
      request_id: requestId,
      queued_at: queuedAt,
      progress_current: 0,
      progress_total: 1,
    };
    this.#emit(record.status);

    const promise = this.#enqueue(() => this.#execute(kind, requestId));
    this.#active.set(kind, promise);
    void promise
      .finally(() => {
        if (this.#active.get(kind) === promise) this.#active.delete(kind);
      })
      .catch(() => undefined);
    return promise;
  }

  async requestAll(force = false): Promise<RefreshReceipt[]> {
    return Promise.all(
      (["discovery", "insights", "gateways", "quota"] satisfies RefreshKind[]).map((kind) =>
        this.request(kind, force),
      ),
    );
  }

  async refreshIfDue(): Promise<void> {
    if (!this.#accepting || !this.#runtimeAvailable) return;
    const requests: Promise<unknown>[] = [];
    if (this.#isStale("discovery", DISCOVERY_MAX_AGE_MS)) {
      requests.push(this.request("discovery", false));
    }
    if (this.#isStale("insights", INSIGHTS_MAX_AGE_MS)) {
      requests.push(this.request("insights", false));
    }
    const [gatewaysDue, quotaDue] = await Promise.all([
      this.#gatewaysNeedRefresh().catch(() => false),
      this.#quotaNeedsRefresh().catch(() => false),
    ]);
    if (gatewaysDue) requests.push(this.request("gateways", false));
    if (quotaDue) requests.push(this.request("quota", false));
    await Promise.allSettled(requests);
  }

  async #execute(kind: RefreshKind, requestId: string): Promise<RefreshReceipt> {
    const record = this.#record(kind);
    try {
      if (!this.#accepting) throw new Error("Refresh coordinator is shutting down");
      if (!this.#runtimeAvailable) throw new Error("AgentKib runtime is restarting");
      const startedAt = new Date().toISOString();
      record.status = {
        ...record.status,
        state: "running",
        started_at: startedAt,
      };
      this.#emit(record.status);

      if (kind === "gateways") await this.#refreshGateways(record);
      else await this.#requestRuntimeRefresh(kind);
      if (kind === "quota") await this.#emitLatestQuotaSnapshot();

      record.failures = 0;
      record.status = {
        ...record.status,
        state: "succeeded",
        finished_at: new Date().toISOString(),
        progress_current: record.status.progress_total,
        error: undefined,
        next_allowed_at: undefined,
      };
      this.#emit(record.status);
      return {
        kind,
        disposition: "queued",
        request_id: requestId,
        status: { ...record.status },
      };
    } catch (error) {
      record.failures += 1;
      const nextAllowedAt = new Date(Date.now() + backoffDelay(record.failures)).toISOString();
      record.status = {
        ...record.status,
        state: "failed",
        finished_at: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
        next_allowed_at: nextAllowedAt,
      };
      this.#emit(record.status);
      throw error;
    }
  }

  #enqueue(operation: () => Promise<RefreshReceipt>): Promise<RefreshReceipt> {
    const result = this.#refreshLane.catch(() => undefined).then(operation);
    this.#refreshLane = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #requestRuntimeRefresh(kind: Exclude<RefreshKind, "gateways">): Promise<unknown> {
    const method = {
      discovery: RUNTIME_METHODS.refreshDiscovery,
      insights: RUNTIME_METHODS.refreshInsights,
      quota: RUNTIME_METHODS.refreshQuota,
      storage: RUNTIME_METHODS.refreshStorage,
    }[kind];
    return this.#options.runtime().request(method, {});
  }

  async #refreshGateways(record: JobRecord): Promise<void> {
    const runtime = this.#options.runtime();
    const gateways = await runtime.request<RemoteGatewaySummary[]>(
      RUNTIME_METHODS.listRemoteGateways,
      {},
    );
    record.status = {
      ...record.status,
      progress_current: 0,
      progress_total: gateways.length,
    };
    this.#emit(record.status);
    for (const [index, gateway] of gateways.entries()) {
      await runtime.request(RUNTIME_METHODS.refreshRemoteGateway, { id: gateway.id });
      record.status = { ...record.status, progress_current: index + 1 };
      this.#emit(record.status);
    }
  }

  async #emitLatestQuotaSnapshot(): Promise<void> {
    const snapshot = await this.#options
      .runtime()
      .request<QuotaSnapshot | undefined>(RUNTIME_METHODS.quotaSnapshot, {});
    if (snapshot) this.#options.onQuotaSnapshot(snapshot);
  }

  async #seedFreshness(): Promise<void> {
    if (!this.#runtimeAvailable) return;
    const runtime = this.#options.runtime();
    const [discovery, insights, quota, gateways] = await Promise.allSettled([
      runtime.request<DiscoveryReport | undefined>(RUNTIME_METHODS.discoveryReport, {}),
      runtime.request<InsightsStatus>(RUNTIME_METHODS.insightsStatus, {}),
      runtime.request<QuotaCollectorStatus>(RUNTIME_METHODS.quotaCollectorStatus, {}),
      runtime.request<RemoteGatewaySummary[]>(RUNTIME_METHODS.listRemoteGateways, {}),
    ]);
    if (discovery.status === "fulfilled") {
      this.#seed("discovery", discovery.value?.finished_at);
    }
    if (insights.status === "fulfilled") this.#seed("insights", insights.value.refreshed_at);
    if (quota.status === "fulfilled") this.#seed("quota", quota.value.last_success_at);
    if (gateways.status === "fulfilled" && gateways.value.length > 0) {
      const finishedAt = gateways.value
        .map((gateway) => gateway.last_connected_at)
        .filter((value): value is string => Boolean(value))
        .sort()[0];
      if (finishedAt && gateways.value.every((gateway) => gateway.last_connected_at)) {
        this.#seed("gateways", finishedAt);
      }
    }
  }

  #seed(kind: RefreshKind, finishedAt: string | undefined): void {
    if (!finishedAt) return;
    const record = this.#record(kind);
    record.status = { ...idleStatus(kind), state: "succeeded", finished_at: finishedAt };
  }

  #schedule(kind: "discovery" | "insights" | "gateways" | "quota", initialDelay: number): void {
    const initial = setTimeout(() => {
      this.#timers.delete(initial);
      void this.#requestScheduled(kind).catch(() => undefined);
      if (!this.#accepting) return;
      const interval = setInterval(
        () => void this.#requestScheduled(kind).catch(() => undefined),
        SCHEDULER_INTERVAL_MS,
      );
      this.#timers.add(interval);
    }, initialDelay);
    this.#timers.add(initial);
  }

  async #requestScheduled(kind: "discovery" | "insights" | "gateways" | "quota"): Promise<void> {
    if (!this.#accepting || !this.#runtimeAvailable) return;
    if (kind === "gateways") {
      if (await this.#gatewaysNeedRefresh()) await this.request(kind, false).catch(() => undefined);
      return;
    }
    if (kind === "quota") {
      if (await this.#quotaNeedsRefresh()) await this.request(kind, false).catch(() => undefined);
      return;
    }
    const maxAge = kind === "discovery" ? DISCOVERY_MAX_AGE_MS : INSIGHTS_MAX_AGE_MS;
    if (this.#isStale(kind, maxAge)) await this.request(kind, false).catch(() => undefined);
  }

  async #gatewaysNeedRefresh(): Promise<boolean> {
    if (!this.#isStale("gateways", GATEWAYS_MAX_AGE_MS)) return false;
    const gateways = await this.#options
      .runtime()
      .request<RemoteGatewaySummary[]>(RUNTIME_METHODS.listRemoteGateways, {});
    return gateways.length > 0;
  }

  async #quotaNeedsRefresh(): Promise<boolean> {
    const runtime = this.#options.runtime();
    const runtimeInfo = await runtime.request<RuntimeInfo>(RUNTIME_METHODS.runtimeInfo, {});
    if (!runtimeInfo.quota_auto_refresh_enabled) return false;
    const [snapshot, collector] = await Promise.all([
      runtime.request<QuotaSnapshot | undefined>(RUNTIME_METHODS.quotaSnapshot, {}),
      runtime.request<QuotaCollectorStatus>(RUNTIME_METHODS.quotaCollectorStatus, {}),
    ]);
    const lastSuccessAt = parseTime(collector.last_success_at);
    const lowRemaining = snapshot?.providers?.some((provider) => {
      const windows = [
        ...(provider.windows ?? []),
        ...(provider.accounts ?? []).flatMap((account) => account.windows ?? []),
      ];
      return windows.some(
        (window) =>
          typeof window.remaining_percent === "number" &&
          Number.isFinite(window.remaining_percent) &&
          window.remaining_percent <= 20,
      );
    });
    const maxAge =
      this.#options.isMainWindowVisible() || lowRemaining
        ? QUOTA_VISIBLE_MAX_AGE_MS
        : QUOTA_BACKGROUND_MAX_AGE_MS;
    const staleByAge = !Number.isFinite(lastSuccessAt) || Date.now() - lastSuccessAt >= maxAge;
    const resetDue = snapshot?.providers?.some((provider) => {
      const windows = [
        ...(provider.windows ?? []),
        ...(provider.accounts ?? []).flatMap((account) => account.windows ?? []),
      ];
      return windows.some((window) => {
        const resetAt = parseTime(window.reset_at);
        return (
          Number.isFinite(resetAt) &&
          resetAt <= Date.now() - QUOTA_RESET_GRACE_MS &&
          (!Number.isFinite(lastSuccessAt) || lastSuccessAt < resetAt)
        );
      });
    });
    return snapshot?.freshness === "stale" || staleByAge || Boolean(resetDue);
  }

  #isStale(kind: RefreshKind, maxAge: number): boolean {
    const record = this.#record(kind);
    if (record.status.state === "queued" || record.status.state === "running") return false;
    if (record.status.state === "failed" || record.status.state === "backoff") return true;
    const finishedAt = parseTime(record.status.finished_at);
    return !Number.isFinite(finishedAt) || Date.now() - finishedAt >= maxAge;
  }

  #record(kind: RefreshKind): JobRecord {
    const record = this.#jobs.get(kind);
    if (!record) throw new Error(`Unknown refresh kind: ${kind}`);
    return record;
  }

  #requestId(kind: RefreshKind): string {
    return `electron-${kind}-${Date.now()}-${this.#sequence++}`;
  }

  #emit(status: RefreshJobStatus): void {
    if (this.#accepting) this.#options.onStatus({ ...status });
  }
}

function idleStatus(kind: RefreshKind): RefreshJobStatus {
  return { kind, state: "idle" };
}

function parseTime(value: string | undefined): number {
  return value ? Date.parse(value) : Number.NaN;
}

function backoffDelay(failures: number): number {
  if (failures <= 1) return 5 * 60_000;
  if (failures === 2) return 15 * 60_000;
  if (failures === 3) return 30 * 60_000;
  return 60 * 60_000;
}
