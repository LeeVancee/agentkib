import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { ExternalLink, Gauge, RefreshCw, Settings2 } from "lucide-react";
import { api } from "@/core/api";
import { changeLocale, formatRelativeTime, localizeMessage, tr } from "@/core/i18n";
import {
  compareQuotaProviders,
  isQuotaProviderSupported,
  lowestRemaining,
  visibleQuotaWindows,
} from "@/features/quota/quota";
import { applyTheme } from "@/core/theme";
import { isTauriRuntime } from "@/core/platform";
import type {
  EffectiveTheme,
  QuotaPopoverPreferences,
  QuotaProvider,
  QuotaSnapshot,
  RefreshJobStatus,
} from "@/core/types";
import { ProviderIcon, QuotaWindowRow } from "./QuotaDisplay";
import { QuotaAutoRefreshPrompt } from "./QuotaAutoRefreshPrompt";
import { cn } from "@/lib/utils";

export function QuotaPopover() {
  const [snapshot, setSnapshot] = useState<QuotaSnapshot>();
  const [preferences, setPreferences] = useState<QuotaPopoverPreferences>({
    hidden_providers: [],
    hidden_windows: [],
  });
  const [selectedId, setSelectedId] = useState("");
  const [refreshJob, setRefreshJob] = useState<RefreshJobStatus>();
  const [error, setError] = useState("");
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(false);
  const [promptSeen, setPromptSeen] = useState(false);
  const initialRefreshRequested = useRef(false);

  const load = async () => {
    const [nextSnapshot, nextPreferences, jobs, runtime] = await Promise.all([
      api.quotaSnapshot(),
      api.quotaPopoverPreferences(),
      api.refreshStatus(),
      api.runtime(),
    ]);
    setSnapshot(nextSnapshot);
    setPreferences(nextPreferences);
    setAutoRefreshEnabled(runtime.quota_auto_refresh_enabled);
    setPromptSeen(runtime.quota_auto_refresh_prompt_seen);
    const job = jobs.find((item) => item.kind === "quota");
    setRefreshJob(job);
    return {
      snapshot: nextSnapshot,
      job,
      autoRefreshEnabled: runtime.quota_auto_refresh_enabled,
      promptSeen: runtime.quota_auto_refresh_prompt_seen,
    };
  };

  useEffect(() => {
    let disposed = false;
    let unlistenQuota: (() => void) | undefined;
    let unlistenRefresh: (() => void) | undefined;
    let unlistenPreferences: (() => void) | undefined;
    let unlistenQuotaAutoRefresh: (() => void) | undefined;
    let unlistenQuotaAutoRefreshPrompt: (() => void) | undefined;
    void (async () => {
      if (!isTauriRuntime()) {
        const current = await load();
        if (
          current.autoRefreshEnabled &&
          !initialRefreshRequested.current &&
          (!current.snapshot || current.snapshot.freshness !== "fresh")
        ) {
          initialRefreshRequested.current = true;
          const receipt = await api.requestRefresh("quota", false);
          setRefreshJob(receipt.status);
          if (receipt.status.state === "succeeded") await load();
        }
        return;
      }
      [
        unlistenQuota,
        unlistenRefresh,
        unlistenPreferences,
        unlistenQuotaAutoRefresh,
        unlistenQuotaAutoRefreshPrompt,
      ] =
        await Promise.all([
        listen<QuotaSnapshot>("agentkib:quota-updated", ({ payload }) => {
          if (!disposed) setSnapshot(payload);
        }),
        listen<RefreshJobStatus>("agentkib:refresh-state", ({ payload }) => {
          if (disposed || payload.kind !== "quota") return;
          setRefreshJob(payload);
          if (payload.state === "failed") setError(payload.error ?? tr("errors.quotaUnavailable"));
          if (payload.state === "succeeded") setError("");
        }),
        listen<QuotaPopoverPreferences>(
          "agentkib:quota-popover-preferences-updated",
          ({ payload }) => {
            if (!disposed) setPreferences(payload);
          },
        ),
        listen<boolean>("agentkib:quota-auto-refresh-updated", ({ payload }) => {
          if (!disposed) setAutoRefreshEnabled(payload);
        }),
          listen<boolean>("agentkib:quota-auto-refresh-prompt-updated", ({ payload }) => {
            if (!disposed) setPromptSeen(payload);
          }),
        ]);
      const current = await load();
      if (
        !disposed &&
        current.autoRefreshEnabled &&
        !initialRefreshRequested.current &&
        (!current.snapshot || current.snapshot.freshness !== "fresh") &&
        !["queued", "running", "backoff"].includes(current.job?.state ?? "")
      ) {
        initialRefreshRequested.current = true;
        const receipt = await api.requestRefresh("quota", false);
        setRefreshJob(receipt.status);
      }
    })().catch((reason) => {
      if (!disposed) setError(localizeMessage(reason));
    });
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") void getCurrentWindow().hide();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      disposed = true;
      unlistenQuota?.();
      unlistenRefresh?.();
      unlistenPreferences?.();
      unlistenQuotaAutoRefresh?.();
      unlistenQuotaAutoRefreshPrompt?.();
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const refreshActive = refreshJob?.state === "queued" || refreshJob?.state === "running";
  useEffect(() => {
    if (!refreshActive) return;
    let disposed = false;
    const poll = async () => {
      try {
        const jobs = await api.refreshStatus();
        if (disposed) return;
        const job = jobs.find((item) => item.kind === "quota");
        if (!job) return;
        setRefreshJob(job);
        if (job.state === "failed") setError(job.error ?? tr("errors.quotaUnavailable"));
        if (job.state === "succeeded") {
          setError("");
          const current = await api.quotaSnapshot();
          if (!disposed) setSnapshot(current);
        }
      } catch (reason) {
        if (!disposed) setError(localizeMessage(reason));
      }
    };
    const timer = window.setInterval(() => void poll(), 1_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [refreshActive, refreshJob?.request_id]);

  useEffect(() => {
    let disposed = false;
    let unlistenTheme: (() => void) | undefined;
    const syncAppearance = async () => {
      try {
        const runtime = await api.runtime();
        if (disposed) return;
        applyTheme(runtime.effective_theme);
        await changeLocale(runtime.effective_locale);
      } catch {
        // The main bootstrap already supplied a safe browser/system fallback.
      }
    };
    void listen<EffectiveTheme>("tauri://theme-changed", ({ payload }) => applyTheme(payload)).then(
      (dispose) => {
        if (disposed) dispose();
        else unlistenTheme = dispose;
      },
    );
    window.addEventListener("focus", syncAppearance);
    return () => {
      disposed = true;
      unlistenTheme?.();
      window.removeEventListener("focus", syncAppearance);
    };
  }, []);

  const providers = useMemo(
    () =>
      (snapshot?.providers ?? [])
        .filter(isQuotaProviderSupported)
        .filter((provider) => visibleQuotaWindows(provider, preferences).length > 0)
        .sort(compareQuotaProviders),
    [preferences, snapshot],
  );

  useEffect(() => {
    if (!providers.length) return;
    if (!providers.some((provider) => provider.id === selectedId)) setSelectedId(providers[0].id);
  }, [providers, selectedId]);

  const selected = providers.find((provider) => provider.id === selectedId);
  const windows = selected ? visibleQuotaWindows(selected, preferences) : [];
  const busy = refreshActive;
  const refresh = async () => {
    setError("");
    try {
      const receipt = await api.refreshQuota();
      setRefreshJob(receipt.status);
      if (receipt.status.state === "succeeded") await load();
    } catch (reason) {
      setError(localizeMessage(reason));
    }
  };
  const markPromptSeen = async () => {
    const nextRuntime = await api.setQuotaAutoRefreshPromptSeen(true);
    setPromptSeen(nextRuntime.quota_auto_refresh_prompt_seen);
    setAutoRefreshEnabled(nextRuntime.quota_auto_refresh_enabled);
  };
  const enableAutoRefresh = async () => {
    const nextRuntime = await api.setQuotaAutoRefreshEnabled(true);
    setPromptSeen(nextRuntime.quota_auto_refresh_prompt_seen);
    setAutoRefreshEnabled(nextRuntime.quota_auto_refresh_enabled);
  };
  const openDashboard = async (
    provider?: QuotaProvider,
    configure = false,
    windowIndex?: number,
  ) => {
    const item = windowIndex === undefined ? undefined : windows[windowIndex];
    await api.openQuotaDashboard(provider?.id, item?.selector, configure);
  };

  return (
    <main className="fixed inset-0 grid grid-rows-[48px_auto_minmax(0,1fr)_48px] overflow-hidden bg-background text-foreground">
      <header
        className="flex items-center gap-2 border-b border-border px-3"
        data-tauri-drag-region
      >
        <strong>{tr("nav.quota")}</strong>
        {snapshot && (
          <span
            className={cn(
              "ml-auto text-xs text-muted-foreground",
              snapshot.freshness === "stale" && "text-amber-600",
            )}
          >
            {snapshot.freshness === "stale"
              ? tr("quota.freshness.stale")
              : tr("quota.updated", { time: formatRelativeTime(snapshot.fetched_at) })}
          </span>
        )}
        <Button
          variant="outline"
          size="icon"
          type="button"
          onClick={() => void refresh()}
          disabled={busy}
          aria-label={tr("quota.refresh")}
        >
          <RefreshCw size={15} className={busy ? "animate-spin" : ""} />
        </Button>
      </header>

      {providers.length > 0 && (
        <Tabs value={selectedId} onValueChange={setSelectedId}>
          <TabsList
            className="segmented-control w-full gap-1 p-2"
            variant="default"
            aria-label={tr("quota.providers")}
          >
            {providers.map((provider) => {
              const remaining = lowestRemaining(provider);
              return (
                <TabsTrigger
                  className="segmented-control-item h-auto min-w-[72px] flex-none flex-col gap-1 px-1 py-2 text-xs"
                  key={provider.id}
                  value={provider.id}
                >
                  <ProviderIcon provider={provider} />
                  <span className="max-w-[68px] truncate">{provider.name}</span>
                  <i className="h-0.5 w-10 overflow-hidden rounded-full bg-muted">
                    <b
                      className={cn(
                        "block h-full bg-primary",
                        remaining !== undefined && remaining < 30 && "bg-amber-500",
                      )}
                      style={{ width: `${remaining ?? 0}%` }}
                    />
                  </i>
                </TabsTrigger>
              );
            })}
          </TabsList>
        </Tabs>
      )}

      <section className="overflow-y-auto p-4">
        {!autoRefreshEnabled && !promptSeen && (
          <QuotaAutoRefreshPrompt
            compact
            onEnableAutoRefresh={enableAutoRefresh}
            onNotNow={markPromptSeen}
          />
        )}
        {!snapshot && (
          <div className="grid min-h-[300px] place-content-center justify-items-center gap-2 text-center text-muted-foreground">
            <Gauge size={25} />
            <strong className="text-sm text-foreground">
              {busy ? tr("quota.refreshRunning") : tr("quota.empty")}
            </strong>
            {error && <small className="max-w-[270px] text-xs leading-relaxed">{error}</small>}
          </div>
        )}
        {snapshot && !providers.length && (
          <div className="grid min-h-[300px] place-content-center justify-items-center gap-2 text-center text-muted-foreground">
            <Gauge size={25} />
            <strong className="text-sm text-foreground">{tr("quota.popoverEmpty")}</strong>
            <small className="max-w-[270px] text-xs leading-relaxed">
              {tr("quota.popoverEmptyHint")}
            </small>
          </div>
        )}
        {selected && (
          <>
            <div className="flex items-center gap-2.5 pb-2">
              <ProviderIcon provider={selected} />
              <div className="min-w-0">
                <h1 className="m-0 text-lg">{selected.name}</h1>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                  {selected.identity?.account_email ?? selected.identity?.plan ?? "—"}
                </span>
              </div>
            </div>
            <div>
              {windows.map((item, index) => (
                <div key={item.key}>
                  {item.accountLabel && (
                    <small className="mt-3 block text-xs text-muted-foreground">
                      {item.accountLabel}
                    </small>
                  )}
                  <QuotaWindowRow
                    item={item}
                    onOpen={() => void openDashboard(selected, false, index)}
                  />
                </div>
              ))}
            </div>
            {selected.error && (
              <Collapsible className="mt-3 text-xs text-amber-600">
                <CollapsibleTrigger className="w-fit cursor-pointer bg-transparent">
                  {tr("quota.partialData")}
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 text-muted-foreground">
                    {selected.error}
                  </pre>
                </CollapsibleContent>
              </Collapsible>
            )}
          </>
        )}
      </section>

      <footer className="flex items-center justify-between border-t border-border px-2 py-1.5">
        <Button type="button" onClick={() => void openDashboard(selected)}>
          <ExternalLink size={15} />
          {tr("quota.openDashboard")}
        </Button>
        <Button type="button" onClick={() => void openDashboard(selected, true)}>
          <Settings2 size={15} />
          {tr("quota.popoverSettings")}
        </Button>
      </footer>
    </main>
  );
}
