/** @jsxImportSource octane */

import { useEffect, useRef, useState } from "octane";
import { useQueryClient } from "@octanejs/tanstack-query";
import { AlertTriangle, RefreshCw } from "@octanejs/lucide";
import { Button } from "@/components/ui/button";
import { api } from "@/core/api";
import { desktopApi } from "@/core/desktop";
import { cacheEffectiveLocale, changeLocale, localizeMessage, tr } from "@/core/i18n";
import { applyTheme, cacheEffectiveTheme } from "@/core/theme";
import { useAppDialogs } from "@/components/AppDialogProvider";
import { useAppStore } from "@/stores/app-store";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import { useHomeQueryEvents } from "@/features/home/home-query.tsx";
import { useInsightsQueryEvents } from "@/features/insights/insights-query.tsx";
import { useQuotaQueryEvents } from "@/features/quota/quota-query.tsx";
import type { AppMenuCommandRequest, AppNavigationRequest, EffectiveTheme } from "@/core/types";
import type { DesktopRuntimeStatus } from "../../../electron/api";

export function AppRuntimeBridge() {
  const dialogs = useAppDialogs();
  const queryClient = useQueryClient();
  const appStore = useAppStore();
  const workspaceStore = useWorkspaceStore();
  const { setRuntime, setNavigationRequest, setMenuCommand } = appStore;
  const { setMessage, applyingChanges } = workspaceStore;
  const quitPromptOpen = useRef(false);
  const previousRuntimeState = useRef<DesktopRuntimeStatus["state"] | undefined>(undefined);
  const [runtimeStatus, setRuntimeStatus] = useState<DesktopRuntimeStatus>();
  const [retrying, setRetrying] = useState(false);

  useQuotaQueryEvents();
  useHomeQueryEvents();
  useInsightsQueryEvents();

  useEffect(() => {
    let disposed = false;
    let initialSyncPending = true;
    const desktop = desktopApi();
    const synchronizeRuntime = async () => {
      const nextRuntime = await api.runtime();
      if (disposed) return;
      setRuntime(nextRuntime);
      applyTheme(nextRuntime.effective_theme);
      cacheEffectiveTheme(nextRuntime.effective_theme, nextRuntime.theme_preference);
      cacheEffectiveLocale(nextRuntime.effective_locale, nextRuntime.locale_preference);
      await changeLocale(nextRuntime.effective_locale);
    };
    const onThemeChanged = (theme: EffectiveTheme) => {
      setRuntime((current) => {
        if (!current || current.theme_preference !== "system") return current;
        applyTheme(theme);
        cacheEffectiveTheme(theme, "system");
        return { ...current, effective_theme: theme };
      });
    };
    const onRuntimeStatus = (status: DesktopRuntimeStatus) => {
      const previous = previousRuntimeState.current;
      previousRuntimeState.current = status.state;
      setRuntimeStatus(status);
      if (status.state === "ready" && previous && previous !== "ready" && !initialSyncPending) {
        void synchronizeRuntime()
          .then(() => queryClient.invalidateQueries())
          .catch((error: unknown) => {
            if (!disposed) setMessage(localizeMessage(error));
          });
      }
    };
    const unsubscribers = [
      desktop.events.onNavigate((request: AppNavigationRequest) => setNavigationRequest(request)),
      desktop.events.onMenuCommand((request: AppMenuCommandRequest) => setMenuCommand(request)),
      desktop.events.onThemeChanged(onThemeChanged),
      desktop.events.onRuntimeStatus(onRuntimeStatus),
    ];
    void (async () => {
      try {
        onRuntimeStatus(await desktop.runtime.status());
        const legacy = localStorage.getItem("agentkib.project");
        if (legacy) {
          try {
            await api.addWorkspace(legacy);
            localStorage.removeItem("agentkib.project");
          } catch (error) {
            if (!disposed) setMessage(localizeMessage(error));
          }
        }
        await synchronizeRuntime();
      } catch (error) {
        if (!disposed) setMessage(localizeMessage(error));
      } finally {
        initialSyncPending = false;
      }
    })();
    return () => {
      disposed = true;
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [queryClient, setMenuCommand, setMessage, setNavigationRequest, setRuntime]);

  useEffect(() => {
    const refreshRuntime = () => {
      void api
        .runtime()
        .then(async (nextRuntime) => {
          setRuntime(nextRuntime);
          applyTheme(nextRuntime.effective_theme);
          cacheEffectiveTheme(nextRuntime.effective_theme, nextRuntime.theme_preference);
          cacheEffectiveLocale(nextRuntime.effective_locale, nextRuntime.locale_preference);
          await changeLocale(nextRuntime.effective_locale);
        })
        .catch(() => undefined);
    };
    window.addEventListener("focus", refreshRuntime);
    return () => window.removeEventListener("focus", refreshRuntime);
  }, [setRuntime]);

  const hasUnsavedDraft = Boolean(
    workspaceStore.manifest &&
    workspaceStore.baselineManifest &&
    JSON.stringify(workspaceStore.manifest) !== workspaceStore.baselineManifest,
  );
  const hasAnyUnsavedDraft =
    hasUnsavedDraft || Object.keys(workspaceStore.workspaceDrafts).length > 0;
  const quitState = useRef({ hasUnsavedDraft: hasAnyUnsavedDraft, applyingChanges });
  useEffect(() => {
    quitState.current = { hasUnsavedDraft: hasAnyUnsavedDraft, applyingChanges };
  }, [applyingChanges, hasAnyUnsavedDraft]);
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

  if (runtimeStatus?.state !== "failed") return null;

  return (
    <div
      role="alert"
      className="fixed left-1/2 top-16 z-50 flex max-w-[min(560px,calc(100vw-32px))] -translate-x-1/2 items-center gap-3 rounded-xl border border-destructive/30 bg-background/95 px-4 py-3 text-sm shadow-lg backdrop-blur"
    >
      <AlertTriangle className="shrink-0 text-destructive" size={18} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{tr("runtime.startFailed")}</p>
        {runtimeStatus.error && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground" title={runtimeStatus.error}>
            {runtimeStatus.error}
          </p>
        )}
      </div>
      <Button
        disabled={retrying}
        onClick={() => {
          setRetrying(true);
          void desktopApi()
            .runtime.retry()
            .catch((error: unknown) => setMessage(localizeMessage(error)))
            .finally(() => setRetrying(false));
        }}
      >
        <RefreshCw className={retrying ? "animate-spin" : undefined} size={15} />
        {tr(retrying ? "runtime.retrying" : "runtime.retry")}
      </Button>
    </div>
  );
}
