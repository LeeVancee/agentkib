import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../core/api";
import { GlobalSettings } from "@/features/settings/GlobalSettings";
import { SettingsContentSkeleton } from "@/features/settings/SettingsSkeleton";
import { localizeMessage, tr } from "../core/i18n";
import type { SettingsSection } from "@/features/settings/SettingsSidebar";
import { useAppStore } from "../stores/app-store";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import type { CloseBehavior, RuntimeInfo } from "../core/types";

type SettingsSearch = { settingsSection?: SettingsSection };

function SettingsRoute() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as SettingsSearch;
  const section = search.settingsSection ?? "general";
  const runtime = useAppStore((state) => state.runtime);
  const workspacesLoaded = useAppStore((state) => state.workspacesLoaded);
  const setRuntime = useAppStore((state) => state.setRuntime);
  const workspaces = useAppStore((state) => state.workspaces);
  const discovery = useAppStore((state) => state.discovery);
  const insightsStatus = useAppStore((state) => state.insightsStatus);
  const quotaStatus = useAppStore((state) => state.quotaStatus);
  const remoteGateways = useAppStore((state) => state.remoteGateways);
  const setRemoteGateways = useAppStore((state) => state.setRemoteGateways);
  const scanRoots = useAppStore((state) => state.scanRoots);
  const setScanRoots = useAppStore((state) => state.setScanRoots);
  const excluded = useAppStore((state) => state.excluded);
  const setExcluded = useAppStore((state) => state.setExcluded);
  const activity = useAppStore((state) => state.activity);
  const { message, setMessage } = useWorkspaceStore();

  const setSection = (nextSection: SettingsSection) => {
    void navigate({
      to: "/settings",
      search: (current) => ({ ...current, settingsSection: nextSection }) as never,
    });
  };

  const run = async (operation: () => Promise<void>) => {
    setMessage("");
    try {
      await operation();
    } catch (error) {
      setMessage(localizeMessage(error));
    }
  };

  const addRoot = () =>
    run(async () => {
      const selected = await open({
        directory: true,
        multiple: false,
        title: tr("dialog.addScanRoot"),
      });
      if (typeof selected !== "string") return;
      await api.addScanRoot(selected, 5);
      setScanRoots(await api.scanRoots());
      await api.requestRefresh("discovery", true);
    });

  const removeRoot = (id: string) =>
    run(async () => {
      await api.removeScanRoot(id);
      setScanRoots(await api.scanRoots());
      await api.requestRefresh("discovery", true);
    });

  const restoreExcluded = (path: string) =>
    run(async () => {
      await api.restoreExcludedWorkspace(path);
      setExcluded(await api.excludedWorkspaces());
      await api.requestRefresh("discovery", true);
    });

  const changeCloseBehavior = (behavior?: CloseBehavior) =>
    run(async () => {
      await api.setCloseBehavior(behavior);
      setRuntime(await api.runtime());
    });

  const refreshRemoteGateways = () =>
    run(async () => {
      setRemoteGateways(await api.remoteGateways());
    });

  const changeRuntime = (nextRuntime: RuntimeInfo) => setRuntime(nextRuntime);
  const restartOnboarding = () =>
    run(async () => {
      setRuntime(await api.updateOnboarding({ event: "restarted" }));
    });

  return (
    <>
      {!runtime && !workspacesLoaded ? (
        <SettingsContentSkeleton />
      ) : (
        <GlobalSettings
          section={section}
          runtime={runtime}
          workspaces={workspaces}
          discovery={discovery}
          insightsStatus={insightsStatus}
          quotaStatus={quotaStatus}
          remoteGateways={remoteGateways}
          scanRoots={scanRoots}
          excluded={excluded}
          activity={activity}
          onAddRoot={addRoot}
          onRemoveRoot={removeRoot}
          onRestore={restoreExcluded}
          onCloseBehaviorChanged={changeCloseBehavior}
          onLocaleChanged={changeRuntime}
          onOnboardingRestarted={restartOnboarding}
          onRemoteGatewaysChanged={refreshRemoteGateways}
        />
      )}
    </>
  );
}

export const Route = createFileRoute("/settings")({ component: SettingsRoute });
