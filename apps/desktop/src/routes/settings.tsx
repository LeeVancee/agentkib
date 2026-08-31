import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../core/api";
import { GlobalSettings } from "@/features/settings/GlobalSettings";
import { SettingsContentSkeleton } from "@/features/settings/SettingsSkeleton";
import { localizeMessage, tr } from "../core/i18n";
import type { SettingsSection } from "@/features/settings/SettingsSidebar";
import { useAppStore } from "../stores/app-store";
import {
  homeKeys,
  useHomeActivity,
  useHomeDiscovery,
  useHomeExcluded,
  useHomeInsightsStatus,
  useHomeRemoteGateways,
  useHomeScanRoots,
  useHomeWorkspaces,
} from "@/features/home/home-query";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import { useQuotaStatus } from "@/features/quota/quota-query";
import type { CloseBehavior, RuntimeInfo } from "../core/types";

type SettingsSearch = { settingsSection?: SettingsSection };

function SettingsRoute() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const search = useSearch({ strict: false }) as SettingsSearch;
  const section = search.settingsSection ?? "general";
  const runtime = useAppStore((state) => state.runtime);
  const setRuntime = useAppStore((state) => state.setRuntime);
  const { data: workspaces = [], isPending: workspacesPending } = useHomeWorkspaces();
  const { data: discovery } = useHomeDiscovery();
  const { data: insightsStatus } = useHomeInsightsStatus();
  const { data: quotaStatus } = useQuotaStatus();
  const { data: remoteGateways = [] } = useHomeRemoteGateways();
  const { data: scanRoots = [] } = useHomeScanRoots();
  const { data: excluded = [] } = useHomeExcluded();
  const { data: activity = [] } = useHomeActivity();
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
      const selected = await api.pickDirectory(tr("dialog.addScanRoot"));
      if (typeof selected !== "string") return;
      await api.addScanRoot(selected, 5);
      await queryClient.invalidateQueries({ queryKey: homeKeys.scanRoots() });
      await api.requestRefresh("discovery", true);
    });

  const removeRoot = (id: string) =>
    run(async () => {
      await api.removeScanRoot(id);
      await queryClient.invalidateQueries({ queryKey: homeKeys.scanRoots() });
      await api.requestRefresh("discovery", true);
    });

  const restoreExcluded = (path: string) =>
    run(async () => {
      await api.restoreExcludedWorkspace(path);
      await queryClient.invalidateQueries({ queryKey: homeKeys.excluded() });
      await api.requestRefresh("discovery", true);
    });

  const changeCloseBehavior = (behavior?: CloseBehavior) =>
    run(async () => {
      await api.setCloseBehavior(behavior);
      setRuntime(await api.runtime());
    });

  const refreshRemoteGateways = () =>
    run(async () => {
      await queryClient.invalidateQueries({ queryKey: homeKeys.remoteGateways() });
    });

  const changeRuntime = (nextRuntime: RuntimeInfo) => setRuntime(nextRuntime);
  const restartOnboarding = () =>
    run(async () => {
      setRuntime(await api.updateOnboarding({ event: "restarted" }));
    });

  return (
    <>
      {!runtime && workspacesPending ? (
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
