import { createRootRoute, Outlet, useNavigate, useSearch } from "@tanstack/react-router";
import { CircleAlert } from "lucide-react";
import { z } from "zod";
import { AppSidebar, type SidebarEntry } from "@/components/AppSidebar";
import type { SettingsSection } from "@/features/settings/SettingsSidebar";
import { SettingsSidebar } from "@/features/settings/SettingsSidebar";
import type { InsightsSection } from "@/features/insights/InsightsPage";
import type { AgentKind, RefreshJobStatus } from "../core/types";
import { AppRuntimeBridge } from "../features/app/AppRuntimeBridge";
import { AppShell } from "../features/app/AppShell";
import type { GlobalPage, ParsedRoute } from "../features/app/app-route";
import { cn } from "@/lib/utils";
import { useAppNavigation } from "../features/app/useAppNavigation";
import { ShortcutHelpDialog } from "../features/app/ShortcutHelpDialog";
import { ShortcutHelpProvider } from "../features/app/ShortcutHelpContext";
import { useAppShortcuts } from "../features/app/useAppShortcuts";
import { useAppStore } from "../stores/app-store";
import { useState } from "react";

type SettingsSearch = { settingsSection?: SettingsSection };

function RootLayout() {
  const {
    route,
    globalPage,
    message,
    refreshJobs,
    navigation,
    navigateGlobal,
    openSettings,
    refreshCurrentView,
    addWorkspace,
    addScanRoot,
  } = useAppNavigation();
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const setSidebarCollapsed = useAppStore((state) => state.setSidebarCollapsed);

  useAppShortcuts({
    onNavigate: navigateGlobal,
    onOpenSettings: openSettings,
    onRefreshCurrent: refreshCurrentView,
    onAddWorkspace: addWorkspace,
    onAddScanRoot: addScanRoot,
    onToggleSidebar: () => setSidebarCollapsed((value) => !value),
    onOpenHelp: () => setShortcutHelpOpen(true),
    helpOpen: shortcutHelpOpen,
  });

  return (
    <ShortcutHelpProvider openShortcutHelp={() => setShortcutHelpOpen(true)}>
      <AppRuntimeBridge />
      <AppShellRouter
        route={route}
        active={globalPage}
        entries={navigation}
        message={message}
        refreshJobs={refreshJobs}
        onNavigate={navigateGlobal}
        onSettings={openSettings}
      />
      <ShortcutHelpDialog open={shortcutHelpOpen} onOpenChange={setShortcutHelpOpen} />
    </ShortcutHelpProvider>
  );
}

function AppShellRouter({
  route,
  active,
  entries,
  message,
  refreshJobs,
  onNavigate,
  onSettings,
}: {
  route: ParsedRoute;
  active: GlobalPage;
  entries: SidebarEntry<GlobalPage>[];
  message: string;
  refreshJobs: RefreshJobStatus[];
  onNavigate: (page: GlobalPage) => void;
  onSettings: () => void;
}) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as SettingsSearch;
  const sidebarCollapsed = useAppStore((state) => state.sidebarCollapsed);
  const settingsSection = search.settingsSection ?? "general";
  const isSettings = route.kind === "settings";
  const isWorkspace = route.kind === "workspace";
  const discoveryFailure = refreshJobs.find(
    (job) => job.kind === "discovery" && job.state === "failed",
  );

  const setSettingsSection = (section: SettingsSection) => {
    void navigate({
      to: "/settings",
      search: (current) => ({ ...current, settingsSection: section }) as never,
    });
  };

  const sidebar = isSettings ? (
    <SettingsSidebar
      active={settingsSection}
      collapsed={sidebarCollapsed}
      onSelect={setSettingsSection}
      onBack={() => void navigate({ to: "/" })}
      onSettings={() => setSettingsSection("general")}
    />
  ) : (
    <AppSidebar
      active={isWorkspace ? "workspaces" : active}
      collapsed={sidebarCollapsed}
      entries={entries}
      onNavigate={onNavigate}
      onSettings={onSettings}
      onBrandClick={() => onNavigate("home")}
    />
  );

  return (
    <AppShell
      sidebar={sidebar}
      mainClassName={isSettings ? `settings-section-${settingsSection}` : undefined}
    >
      {message && (
        <div className="mx-7 mt-3 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <CircleAlert size={17} />
          {message}
        </div>
      )}
      {!isSettings && active === "workspaces" && discoveryFailure?.error && (
        <div className="mx-7 mt-3 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {discoveryFailure.error}
        </div>
      )}
      <section
        className={cn(
          isSettings
            ? "mx-auto grid w-full max-w-[1180px] gap-5 px-7 pb-10 pt-[22px] max-[900px]:px-[18px]"
            : isWorkspace
              ? "content mx-auto max-w-[1540px] px-7 pb-10 pt-[22px] max-[900px]:px-[18px]"
              : "content mx-auto max-w-[1540px] px-7 pb-10 pt-[14px] max-[900px]:px-[18px]",
          isSettings && settingsSection === "general" && "pt-4",
        )}
      >
        <Outlet />
      </section>
    </AppShell>
  );
}

const quotaWindowSchema = z.object({
  provider_id: z.string(),
  account_id: z.string().optional(),
  kind: z.string(),
  label: z.string(),
});

const gitSubviewSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("commit"), oid: z.string() }),
  z.object({
    kind: z.literal("worktree"),
    path: z.string(),
    diffKind: z.enum(["commit", "worktree", "staged"]),
  }),
]);

const searchSchema = z.object({
  assetSection: z
    .enum(["instructions", "skills", "mcp", "memory", "other"])
    .optional()
    .catch(undefined),
  workspaceAssetSection: z
    .enum(["instructions", "skills", "mcp", "native"])
    .optional()
    .catch(undefined),
  workspaceView: z.enum(["list", "storage"]).optional().catch(undefined),
  settingsSection: z
    .enum([
      "general",
      "discovery",
      "integrations",
      "privacy",
      "diagnostics",
    ] satisfies SettingsSection[])
    .optional()
    .catch(undefined),
  insightsSection: z
    .enum(["overview", "tokens", "commits", "milestones", "sources"] satisfies InsightsSection[])
    .optional()
    .catch(undefined),
  quotaProvider: z.string().optional().catch(undefined),
  quotaWindow: quotaWindowSchema.optional().catch(undefined),
  gitSubview: gitSubviewSchema.optional().catch(undefined),
  agent: z.custom<AgentKind>().optional().catch(undefined),
  configure: z.boolean().optional().catch(undefined),
  doctorVerification: z.enum(["applied"]).optional().catch(undefined),
});

export const Route = createRootRoute({
  validateSearch: searchSchema,
  component: RootLayout,
  notFoundComponent: () => <div>Not found</div>,
});
