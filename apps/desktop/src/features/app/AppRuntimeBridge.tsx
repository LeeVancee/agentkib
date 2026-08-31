import { useEffect, useRef } from "react";
import { api } from "@/core/api";
import { desktopApi } from "@/core/desktop";
import { changeLocale, localizeMessage, tr } from "@/core/i18n";
import { applyTheme } from "@/core/theme";
import { useAppDialogs } from "@/components/AppDialogProvider";
import { useAppStore } from "@/stores/app-store";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import { useHomeQueryEvents } from "@/features/home/home-query";
import { useInsightsQueryEvents } from "@/features/insights/insights-query";
import { useQuotaQueryEvents } from "@/features/quota/quota-query";
import type { AppMenuCommandRequest, AppNavigationRequest, EffectiveTheme } from "@/core/types";

export function AppRuntimeBridge() {
  const dialogs = useAppDialogs();
  const appStore = useAppStore();
  const workspaceStore = useWorkspaceStore();
  const { setRuntime, setNavigationRequest, setMenuCommand } = appStore;
  const { setMessage, applyingChanges } = workspaceStore;
  const quitPromptOpen = useRef(false);

  useQuotaQueryEvents();
  useHomeQueryEvents();
  useInsightsQueryEvents();

  useEffect(() => {
    let disposed = false;
    const desktop = desktopApi();
    const onThemeChanged = (theme: EffectiveTheme) => {
      setRuntime((current) => {
        if (!current || current.theme_preference !== "system") return current;
        applyTheme(theme);
        return { ...current, effective_theme: theme };
      });
    };
    const unsubscribers = [
      desktop.events.onNavigate((request: AppNavigationRequest) => setNavigationRequest(request)),
      desktop.events.onMenuCommand((request: AppMenuCommandRequest) => setMenuCommand(request)),
      desktop.events.onThemeChanged(onThemeChanged),
    ];
    void (async () => {
      try {
        const legacy = localStorage.getItem("agentkib.project");
        if (legacy) {
          await api.addWorkspace(legacy);
          localStorage.removeItem("agentkib.project");
        }
        const nextRuntime = await api.runtime();
        if (!disposed) {
          setRuntime(nextRuntime);
          applyTheme(nextRuntime.effective_theme);
          await changeLocale(nextRuntime.effective_locale);
        }
      } catch (error) {
        if (!disposed) setMessage(localizeMessage(error));
      }
    })();
    return () => {
      disposed = true;
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [setMenuCommand, setMessage, setNavigationRequest, setRuntime]);

  useEffect(() => {
    const refreshRuntime = () => {
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
  }, [setRuntime]);

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
