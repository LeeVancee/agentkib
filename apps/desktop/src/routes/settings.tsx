import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { CircleAlert } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { cn } from "@/lib/utils";
import { api } from "../core/api";
import { GlobalSettings } from "@/features/settings/GlobalSettings";
import { SettingsContentSkeleton } from "@/features/settings/SettingsSkeleton";
import { localizeMessage, tr } from "../core/i18n";
import { SettingsSidebar, type SettingsSection } from "@/features/settings/SettingsSidebar";
import { WindowToolbar } from "@/components/WindowToolbar";
import { useAppStore } from "../stores/app-store";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import type { CloseBehavior, RuntimeInfo } from "../core/types";

type SettingsSearch = { settingsSection?: SettingsSection };

function SettingsRoute() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as SettingsSearch;
  const section = search.settingsSection ?? "general";
  const runtime = useAppStore((state) => state.runtime);
  const sidebarCollapsed = useAppStore((state) => state.sidebarCollapsed);
  const setSidebarCollapsed = useAppStore((state) => state.setSidebarCollapsed);
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
    <div
      className={cn(
        "group app-shell !grid !h-full !w-full !min-h-0 !overflow-hidden",
        sidebarCollapsed && "app-shell-sidebar-collapsed",
      )}
    >
      <WindowToolbar />
      <SettingsSidebar
        active={section}
        collapsed={sidebarCollapsed}
        onSelect={setSection}
        onBack={() => void navigate({ to: "/" })}
        onSettings={() => setSection("general")}
        onCollapsedChange={setSidebarCollapsed}
      />
      <main
        className={cn(
          "app-shell-main !col-start-2 !row-start-3 !flex !min-h-0 !min-w-0 !h-full !flex-col !overflow-hidden !text-sm",
          `settings-section-${section}`,
        )}
      >
        <div className="page-scroll-container min-h-0 flex-1">
          {message && (
            <div className="mx-7 mt-3 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              <CircleAlert size={17} />
              {message}
            </div>
          )}
          <section
            className={cn(
              "mx-auto grid w-full max-w-[1180px] gap-5 px-7 pb-10 pt-[22px] max-[900px]:px-[18px]",
              section === "general" && "pt-4",
            )}
          >
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
          </section>
        </div>
      </main>
    </div>
  );
}

export const Route = createFileRoute("/settings")({ component: SettingsRoute });
