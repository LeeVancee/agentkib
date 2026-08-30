import { useEffect, useRef } from "react";
import { api } from "@/core/api";
import { desktopApi } from "@/core/desktop";
import { refreshGlobalState } from "@/core/global-state";
import { changeLocale, localizeMessage, tr } from "@/core/i18n";
import { applyTheme } from "@/core/theme";
import { useAppDialogs } from "@/components/AppDialogProvider";
import { useAppStore } from "@/stores/app-store";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import type {
  AppMenuCommandRequest,
  AppNavigationRequest,
  EffectiveTheme,
  RefreshJobStatus,
} from "@/core/types";

export function AppRuntimeBridge() {
  const dialogs = useAppDialogs();
  const appStore = useAppStore();
  const workspaceStore = useWorkspaceStore();
  const {
    setRuntime,
    setWorkspaces,
    setWorkspacesLoaded,
    setInstallations,
    setDoctorSummaries,
    setCatalog,
    setDiscovery,
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
    const nextDiscovery = await api.discoveryReport();
    setWorkspaces(nextWorkspaces);
    setWorkspacesLoaded(true);
    setInstallations(nextInstallations);
    setCatalog(nextCatalog);
    if (nextDiscovery) setDiscovery(nextDiscovery);
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
    let disposed = false;
    let refreshReloadTimer: number | undefined;
    const desktop = desktopApi();
    const onRefreshState = (status: RefreshJobStatus) => {
      setRefreshJobs((current) => [...current.filter((job) => job.kind !== status.kind), status]);
      if (status.kind === "discovery" && status.state === "succeeded") {
        if (document.visibilityState !== "visible") {
          pendingRefreshKinds.current.add("discovery");
          return;
        }
        window.clearTimeout(refreshReloadTimer);
        refreshReloadTimer = window.setTimeout(() => {
          if (!disposed) void loadDiscoveryCache();
        }, 100);
      }
    };
    const onThemeChanged = (theme: EffectiveTheme) => {
      setRuntime((current) => {
        if (!current || current.theme_preference !== "system") return current;
        applyTheme(theme);
        return { ...current, effective_theme: theme };
      });
    };
    const unsubscribers = [
      desktop.events.onRefreshState(onRefreshState),
      desktop.events.onNavigate((request: AppNavigationRequest) => setNavigationRequest(request)),
      desktop.events.onMenuCommand((request: AppMenuCommandRequest) => setMenuCommand(request)),
      desktop.events.onThemeChanged(onThemeChanged),
      desktop.events.onQuotaUpdated(() => {
        void api.quotaCollectorStatus().then((status) => {
          if (!disposed) setQuotaStatus(status);
        });
      }),
    ];
    void (async () => {
      try {
        const legacy = localStorage.getItem("agentkib.project");
        if (legacy) {
          await api.addWorkspace(legacy);
          localStorage.removeItem("agentkib.project");
        }
        await refreshGlobalState(useAppStore.getState().runtime);
        const [discovery, refreshJobs] = await Promise.all([
          api.discoveryReport(),
          api.refreshStatus(),
        ]);
        if (!disposed && discovery) setDiscovery(discovery);
        if (!disposed) setRefreshJobs(refreshJobs);
      } catch (error) {
        if (!disposed) setMessage(localizeMessage(error));
      }
    })();
    return () => {
      disposed = true;
      window.clearTimeout(refreshReloadTimer);
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, []);

  useEffect(() => {
    const refreshRuntime = () => {
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
    return desktopApi().events.onQuitRequested(() => void handleQuitRequest());
  }, [dialogs]);

  return null;
}
