import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "@/core/api";
import { refreshGlobalState } from "@/core/global-state";
import { changeLocale, localizeMessage, tr } from "@/core/i18n";
import { applyTheme } from "@/core/theme";
import { isElectronRuntime, isTauriRuntime, normalizePlatform } from "@/core/platform";
import { useAppDialogs } from "@/components/AppDialogProvider";
import { useAppStore } from "@/stores/app-store";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import type {
  AppMenuCommandRequest,
  AppNavigationRequest,
  DiscoveryReport,
  EffectiveTheme,
  InsightsSummary,
  RefreshJobStatus,
  RemoteGatewaySummary,
} from "@/core/types";

const appPlatform = normalizePlatform(import.meta.env.TAURI_ENV_PLATFORM);

export function AppRuntimeBridge() {
  const dialogs = useAppDialogs();
  const appStore = useAppStore();
  const workspaceStore = useWorkspaceStore();
  const {
    setIsFullscreen,
    setRuntime,
    setWorkspaces,
    setWorkspacesLoaded,
    setInstallations,
    setDoctorSummaries,
    setCatalog,
    setDiscovery,
    setRemoteGateways,
    setInsightsSummary,
    setQuotaStatus,
    setNavigationRequest,
    setMenuCommand,
    setRefreshJobs,
  } = appStore;
  const { setMessage, applyingChanges } = workspaceStore;
  const pendingRefreshKinds = useRef(new Set<string>());
  const quitPromptOpen = useRef(false);

  const loadDiscoveryCache = async () => {
    const [nextWorkspaces, nextInstallations, nextCatalog] = await Promise.all([
      api.workspaces(),
      api.agentInstallations(),
      api.catalogAssets(),
    ]);
    setWorkspaces(nextWorkspaces);
    setWorkspacesLoaded(true);
    setInstallations(nextInstallations);
    setCatalog(nextCatalog);
    try {
      const summaries = await api.workspaceDoctorSummaries(
        nextWorkspaces.map((workspace) => workspace.id),
      );
      setDoctorSummaries(
        Object.fromEntries(summaries.map((summary) => [summary.workspace_id, summary])),
      );
    } catch {
      setDoctorSummaries({});
    }
  };

  useEffect(() => {
    const tauriRuntime = isTauriRuntime();
    const electronRuntime = isElectronRuntime();
    if (!tauriRuntime && !electronRuntime) return;

    let disposed = false;
    let refreshReloadTimer: number | undefined;
    let unlisten: (() => void) | undefined;
    let unlistenRefresh: (() => void) | undefined;
    let unlistenInsights: (() => void) | undefined;
    let unlistenGateways: (() => void) | undefined;
    let unlistenQuota: (() => void) | undefined;
    let unlistenQuotaAutoRefresh: (() => void) | undefined;
    let unlistenQuotaAutoRefreshPrompt: (() => void) | undefined;
    let unlistenNavigate: (() => void) | undefined;
    let unlistenMenuCommand: (() => void) | undefined;
    let unlistenTheme: (() => void) | undefined;
    const onElectronNavigate = (event: Event) => {
      const payload = (event as CustomEvent<AppNavigationRequest>).detail;
      if (payload) setNavigationRequest(payload);
    };
    if (electronRuntime) window.addEventListener("agentkib:electron-navigate", onElectronNavigate);
    const onElectronRefreshState = (event: Event) => {
      const status = (event as CustomEvent<RefreshJobStatus>).detail;
      setRefreshJobs((current) => [...current.filter((job) => job.kind !== status.kind), status]);
      if (status.kind === "discovery" && status.state === "succeeded") {
        void loadDiscoveryCache();
      }
    };
    if (electronRuntime) {
      window.addEventListener("agentkib:electron-refresh-state", onElectronRefreshState);
    }
    void (async () => {
      try {
        if (!tauriRuntime) {
          await refreshGlobalState(useAppStore.getState().runtime);
          if (!disposed) setRefreshJobs(await api.refreshStatus());
          return;
        }
        unlisten = await listen<DiscoveryReport>("agentkib:discovery-updated", (event) => {
          setDiscovery(event.payload);
        });
        if (disposed) {
          unlisten?.();
          return;
        }
        unlistenRefresh = await listen<RefreshJobStatus>("agentkib:refresh-state", (event) => {
          setRefreshJobs((current) => [
            ...current.filter((job) => job.kind !== event.payload.kind),
            event.payload,
          ]);
          if (event.payload.kind === "discovery" && event.payload.state === "succeeded") {
            if (document.visibilityState !== "visible") {
              pendingRefreshKinds.current.add("discovery");
              return;
            }
            window.clearTimeout(refreshReloadTimer);
            refreshReloadTimer = window.setTimeout(() => {
              if (!disposed) void loadDiscoveryCache();
            }, 100);
          }
        });
        if (disposed) {
          unlistenRefresh?.();
          return;
        }
        unlistenInsights = await listen<InsightsSummary>("agentkib:insights-updated", (event) => {
          setInsightsSummary(event.payload);
        });
        if (disposed) {
          unlistenInsights?.();
          return;
        }
        unlistenGateways = await listen<RemoteGatewaySummary[]>(
          "agentkib:remote-gateways-updated",
          (event) => {
            setRemoteGateways(event.payload);
          },
        );
        if (disposed) {
          unlistenGateways?.();
          return;
        }
        unlistenQuota = await listen("agentkib:quota-updated", () => {
          void api.quotaCollectorStatus().then((status) => {
            if (!disposed) setQuotaStatus(status);
          });
        });
        if (disposed) {
          unlistenQuota?.();
          return;
        }
        unlistenQuotaAutoRefresh = await listen<boolean>(
          "agentkib:quota-auto-refresh-updated",
          ({ payload }) => {
            setRuntime((current) =>
              current ? { ...current, quota_auto_refresh_enabled: payload } : current,
            );
          },
        );
        if (disposed) {
          unlistenQuotaAutoRefresh?.();
          return;
        }
        unlistenQuotaAutoRefreshPrompt = await listen<boolean>(
          "agentkib:quota-auto-refresh-prompt-updated",
          ({ payload }) => {
            setRuntime((current) =>
              current ? { ...current, quota_auto_refresh_prompt_seen: payload } : current,
            );
          },
        );
        if (disposed) {
          unlistenQuotaAutoRefreshPrompt?.();
          return;
        }
        unlistenNavigate = await listen<AppNavigationRequest>("agentkib:navigate", (event) => {
          setNavigationRequest(event.payload);
        });
        if (disposed) {
          unlistenNavigate?.();
          return;
        }
        unlistenMenuCommand = await listen<AppMenuCommandRequest>(
          "agentkib:app-command",
          (event) => {
            setMenuCommand(event.payload);
          },
        );
        if (disposed) {
          unlistenMenuCommand?.();
          return;
        }
        unlistenTheme = await listen<EffectiveTheme>("tauri://theme-changed", (event) => {
          setRuntime((current) => {
            if (!current || current.theme_preference !== "system") return current;
            applyTheme(event.payload);
            return { ...current, effective_theme: event.payload };
          });
        });
        if (disposed) {
          unlistenTheme?.();
          return;
        }
        if (disposed) return;
        const legacy = localStorage.getItem("agentkib.project");
        if (legacy) {
          await api.addWorkspace(legacy);
          localStorage.removeItem("agentkib.project");
        }
        await refreshGlobalState(useAppStore.getState().runtime);
        if (!disposed) setRefreshJobs(await api.refreshStatus());
      } catch (error) {
        if (!disposed) setMessage(localizeMessage(error));
      }
    })();
    return () => {
      disposed = true;
      window.clearTimeout(refreshReloadTimer);
      unlisten?.();
      unlistenRefresh?.();
      unlistenInsights?.();
      unlistenGateways?.();
      unlistenQuota?.();
      unlistenQuotaAutoRefresh?.();
      unlistenQuotaAutoRefreshPrompt?.();
      unlistenNavigate?.();
      unlistenMenuCommand?.();
      unlistenTheme?.();
      window.removeEventListener("agentkib:electron-refresh-state", onElectronRefreshState);
      window.removeEventListener("agentkib:electron-navigate", onElectronNavigate);
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime() || appPlatform !== "macos") return;

    const appWindow = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const syncFullscreen = async () => {
      try {
        const fullscreen = await appWindow.isFullscreen();
        if (!disposed) setIsFullscreen(fullscreen);
      } catch {
        if (!disposed) setIsFullscreen(false);
      }
    };

    void syncFullscreen();
    void appWindow
      .onResized(() => {
        void syncFullscreen();
      })
      .then((cleanup) => {
        if (disposed) cleanup();
        else unlisten = cleanup;
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const refreshRuntime = () => {
      if (!isTauriRuntime() && !isElectronRuntime()) return;

      if (pendingRefreshKinds.current.delete("discovery")) void loadDiscoveryCache();
      void api
        .runtime()
        .then(async (nextRuntime) => {
          setRuntime(nextRuntime);
          applyTheme(nextRuntime.effective_theme);
          await changeLocale(nextRuntime.effective_locale);
        })
        .catch(() => undefined);
    };
    window.addEventListener("focus", refreshRuntime);
    return () => window.removeEventListener("focus", refreshRuntime);
  }, []);

  const hasUnsavedDraft = Boolean(
    workspaceStore.manifest &&
    workspaceStore.baselineManifest &&
    JSON.stringify(workspaceStore.manifest) !== workspaceStore.baselineManifest,
  );
  const hasAnyUnsavedDraft =
    hasUnsavedDraft || Object.keys(workspaceStore.workspaceDrafts).length > 0;
  const quitState = useRef({ hasUnsavedDraft: hasAnyUnsavedDraft, applyingChanges });
  quitState.current = { hasUnsavedDraft: hasAnyUnsavedDraft, applyingChanges };
  useEffect(() => {
    const tauriRuntime = isTauriRuntime();
    const electronRuntime = isElectronRuntime();
    if (!tauriRuntime && !electronRuntime) return;

    let disposed = false;
    let unlisten: (() => void) | undefined;
    const handleQuitRequest = async () => {
      if (quitPromptOpen.current) return;
      quitPromptOpen.current = true;
      try {
        if (quitState.current.applyingChanges) {
          await dialogs.notify(tr("dialog.quit.changesApplying"));
          return;
        }
        if (
          quitState.current.hasUnsavedDraft &&
          !(await dialogs.confirm({
            description: tr("dialog.quit.discardDraft"),
            tone: "destructive",
          }))
        )
          return;
        await api.quitApp();
      } finally {
        quitPromptOpen.current = false;
      }
    };
    if (electronRuntime) {
      window.addEventListener("agentkib:quit-requested", handleQuitRequest);
    } else {
      void listen("agentkib:quit-requested", handleQuitRequest).then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      });
    }
    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener("agentkib:quit-requested", handleQuitRequest);
    };
  }, [dialogs]);

  return null;
}
