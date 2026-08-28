import { Award, Bot, CircleAlert, FolderGit2, Gauge, Home, Library } from "lucide-react";
import { Outlet } from "@tanstack/react-router";
import { AppSidebar, type SidebarEntry } from "@/components/AppSidebar";
import { AppShell } from "./AppShell";
import type { RefreshJobStatus } from "@/core/types";
import type { GlobalPage } from "./app-route";
import { useAppStore } from "@/stores/app-store";

const globalNav: SidebarEntry<GlobalPage>[] = [
  { id: "home", label: "nav.home", icon: Home, shortcut: "navigate-home" },
  {
    id: "workspaces",
    label: "nav.workspaces",
    icon: FolderGit2,
    shortcut: "navigate-workspaces",
  },
  { id: "catalog", label: "nav.assets", icon: Library, shortcut: "navigate-catalog" },
  { id: "agents", label: "nav.agents", icon: Bot, shortcut: "navigate-agents" },
  { id: "quota", label: "nav.quota", icon: Gauge, shortcut: "navigate-quota" },
  { id: "insights", label: "nav.insights", icon: Award, shortcut: "navigate-insights" },
];

export function createGlobalNavigation(pendingMemoryCount: number): SidebarEntry<GlobalPage>[] {
  return globalNav.map((entry) =>
    entry.id === "catalog" ? { ...entry, badge: pendingMemoryCount } : entry,
  );
}

export function GlobalShell({
  active,
  entries,
  message,
  refreshJobs,
  onNavigate,
  onSettings,
}: {
  active: GlobalPage;
  entries: SidebarEntry<GlobalPage>[];
  message: string;
  refreshJobs: RefreshJobStatus[];
  onNavigate: (page: GlobalPage) => void;
  onSettings: () => void;
}) {
  const sidebarCollapsed = useAppStore((state) => state.sidebarCollapsed);
  const contentClass =
    "content !mx-auto !max-w-[1540px] !px-7 !pb-10 !pt-[14px] max-[900px]:!px-[18px]";
  const discoveryFailure = refreshJobs.find(
    (job) => job.kind === "discovery" && job.state === "failed",
  );

  return (
    <AppShell
      sidebar={
        <AppSidebar
          active={active}
          collapsed={sidebarCollapsed}
          entries={entries}
          onNavigate={onNavigate}
          onSettings={onSettings}
          onBrandClick={() => onNavigate("home")}
        />
      }
    >
      {message && (
        <div className="mx-7 mt-3 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <CircleAlert size={17} />
          {message}
        </div>
      )}
      {active === "workspaces" && discoveryFailure?.error && (
        <div className="mx-7 mt-3 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {discoveryFailure.error}
        </div>
      )}
      <section className={contentClass}>
        <Outlet />
      </section>
    </AppShell>
  );
}
