import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useEffect, useId, useState, type ComponentType } from "react";
import {
  Bot,
  Boxes,
  ChevronDown,
  Code2,
  FolderGit2,
  GitCommitHorizontal,
  GitCompareArrows,
  LayoutDashboard,
  Menu,
  MessageSquareText,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import { tr } from "../core/i18n";
import { cn } from "@/lib/utils";
import { SidebarBrand } from "./SidebarBrand";
import {
  ariaShortcut,
  currentAppPlatform,
  getShortcutDefinition,
  type ShortcutId,
} from "@/core/keyboard-shortcuts";
import type { WorkspaceSummary } from "@/core/types";
import type { GlobalPage, Page } from "@/features/app/app-route";

export interface SidebarEntry<T extends string> {
  id: T;
  label: string;
  icon: ComponentType<{ size?: number }>;
  badge?: number;
  shortcut?: ShortcutId;
}

export type AgentFilter = "all" | "enabled" | "available" | "updates";

export type AppSidebarContext =
  | {
      kind: "global";
      recentWorkspaces: WorkspaceSummary[];
      onOpenWorkspace: (workspace: WorkspaceSummary) => void;
    }
  | {
      kind: "workspace";
      workspace?: WorkspaceSummary;
      page: Page;
      changeCount: number;
      onWorkspaceNavigate: (page: Page) => void;
    }
  | {
      kind: "agents";
      filter: AgentFilter;
      onFilterChange: (filter: AgentFilter) => void;
    };

const workspaceTaskEntries = [
  ["overview", "nav.overview", LayoutDashboard],
  ["sessions", "nav.sessions", MessageSquareText],
  ["assets", "nav.assets", Boxes],
] as const;

const workspaceDevelopmentEntries = [
  ["git", "nav.git", GitCommitHorizontal],
  ["context", "nav.context", Code2],
  ["doctor", "nav.doctor", ShieldCheck],
] as const;

const agentFilters: Array<[AgentFilter, string]> = [
  ["all", "agents.filter.all"],
  ["enabled", "agents.filter.enabled"],
  ["available", "agents.filter.available"],
  ["updates", "agents.filter.updates"],
];

function SidebarSectionLabel({ children }: { children: string }) {
  return <div className="app-sidebar-section-label">{children}</div>;
}

export function AppSidebar(props: {
  active: GlobalPage;
  entries: SidebarEntry<GlobalPage>[];
  onNavigate: (page: GlobalPage) => void;
  onSettings: () => void;
  onBrandClick: () => void;
  collapsed: boolean;
  context?: AppSidebarContext;
  onCollapsedChange?: (collapsed: boolean) => void;
}) {
  const { active, entries, onNavigate, onSettings, onBrandClick, collapsed, context } = props;
  const [mobileOpen, setMobileOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(
    () =>
      active === "catalog" ||
      active === "quota" ||
      active === "insights" ||
      context?.kind === "global",
  );
  const sidebarId = useId();
  const platform = currentAppPlatform();
  const primaryIds: GlobalPage[] = ["home", "workspaces", "agents"];
  const toolIds: GlobalPage[] = ["catalog", "quota", "insights"];
  const primaryEntries = entries.filter((entry) => primaryIds.includes(entry.id));
  const toolEntries = entries.filter((entry) => toolIds.includes(entry.id));

  useEffect(() => {
    setToolsOpen(
      active === "catalog" ||
        active === "quota" ||
        active === "insights" ||
        context?.kind === "global",
    );
  }, [active, context?.kind]);

  useEffect(() => {
    if (!mobileOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mobileOpen]);

  const navigate = (page: GlobalPage) => {
    setMobileOpen(false);
    onNavigate(page);
  };

  const renderNavigationEntry = ({
    id,
    label,
    icon: Icon,
    badge,
    shortcut,
  }: SidebarEntry<GlobalPage>) => {
    const shortcutDefinition = shortcut ? getShortcutDefinition(shortcut) : undefined;
    return (
      <Button
        key={id}
        variant="bare"
        size="content"
        className={cn("app-sidebar-item", active === id && "app-sidebar-item-active")}
        aria-current={active === id ? "page" : undefined}
        aria-label={tr(label)}
        aria-keyshortcuts={
          shortcutDefinition ? ariaShortcut(shortcutDefinition, platform) : undefined
        }
        title={tr(label)}
        onClick={() => navigate(id)}
      >
        <span className="app-sidebar-item-icon">
          <Icon size={17} />
        </span>
        <span className="app-sidebar-item-label min-w-0 flex-1 truncate text-left">
          {tr(label)}
        </span>
        {badge ? <em className="app-sidebar-item-badge">{badge}</em> : null}
      </Button>
    );
  };

  return (
    <>
      <Button
        variant="bare"
        size="content"
        className={cn("sidebar-mobile-trigger", mobileOpen && "invisible")}
        type="button"
        aria-expanded={mobileOpen}
        aria-controls={sidebarId}
        aria-label={tr("common.primaryNavigation")}
        onClick={() => setMobileOpen(true)}
      >
        <Menu size={19} />
      </Button>
      {mobileOpen && (
        <Button
          variant="bare"
          size="content"
          className="sidebar-mobile-backdrop"
          type="button"
          aria-label={tr("common.close")}
          onClick={() => setMobileOpen(false)}
        />
      )}
      <aside
        id={sidebarId}
        className={cn(
          "app-sidebar",
          collapsed && "app-sidebar-collapsed",
          mobileOpen && "app-sidebar-open",
        )}
      >
        <div className="app-sidebar-content">
          <div className="app-sidebar-header">
            <SidebarBrand
              onClick={() => {
                setMobileOpen(false);
                onBrandClick();
              }}
            />
          </div>
          <nav className="app-sidebar-nav" aria-label={tr("common.primaryNavigation")}>
            <div className="app-sidebar-group">{primaryEntries.map(renderNavigationEntry)}</div>

            {context?.kind === "global" && context.recentWorkspaces.length > 0 && (
              <div className="app-sidebar-group app-sidebar-context-group">
                <SidebarSectionLabel>{tr("home.recentWorkspaces")}</SidebarSectionLabel>
                {context.recentWorkspaces.slice(0, 5).map((workspace) => (
                  <Button
                    key={workspace.id}
                    variant="bare"
                    size="content"
                    className="app-sidebar-item app-sidebar-context-item"
                    title={workspace.name}
                    onClick={() => {
                      setMobileOpen(false);
                      context.onOpenWorkspace(workspace);
                    }}
                  >
                    <span className="app-sidebar-item-icon">
                      <FolderGit2 size={16} />
                    </span>
                    <span className="app-sidebar-item-label min-w-0 flex-1 truncate text-left">
                      {workspace.name}
                    </span>
                    {workspace.status === "attention" ? (
                      <span
                        className="app-sidebar-status-dot"
                        aria-label={tr("status.workspace.attention")}
                      />
                    ) : null}
                  </Button>
                ))}
              </div>
            )}

            {context?.kind === "workspace" && (
              <div className="app-sidebar-group app-sidebar-context-group">
                <SidebarSectionLabel>{tr("nav.workspaces")}</SidebarSectionLabel>
                <div className="app-sidebar-workspace" title={context.workspace?.name}>
                  <FolderGit2 size={16} />
                  <span>{context.workspace?.name ?? tr("common.loading")}</span>
                </div>
                <SidebarSectionLabel>{tr("sidebar.tasks")}</SidebarSectionLabel>
                {workspaceTaskEntries.map(([id, label, Icon]) => (
                  <Button
                    key={id}
                    variant="bare"
                    size="content"
                    className={cn(
                      "app-sidebar-item",
                      context.page === id && "app-sidebar-item-active",
                    )}
                    onClick={() => context.onWorkspaceNavigate(id)}
                  >
                    <span className="app-sidebar-item-icon">
                      <Icon size={16} />
                    </span>
                    <span className="app-sidebar-item-label min-w-0 flex-1 truncate text-left">
                      {tr(label)}
                    </span>
                  </Button>
                ))}
                <SidebarSectionLabel>{tr("sidebar.development")}</SidebarSectionLabel>
                {workspaceDevelopmentEntries.map(([id, label, Icon]) => (
                  <Button
                    key={id}
                    variant="bare"
                    size="content"
                    className={cn(
                      "app-sidebar-item",
                      context.page === id && "app-sidebar-item-active",
                    )}
                    onClick={() => context.onWorkspaceNavigate(id)}
                  >
                    <span className="app-sidebar-item-icon">
                      <Icon size={16} />
                    </span>
                    <span className="app-sidebar-item-label min-w-0 flex-1 truncate text-left">
                      {tr(label)}
                    </span>
                  </Button>
                ))}
                {context.changeCount > 0 && (
                  <Button
                    variant="bare"
                    size="content"
                    className={cn(
                      "app-sidebar-item",
                      context.page === "changes" && "app-sidebar-item-active",
                    )}
                    onClick={() => context.onWorkspaceNavigate("changes")}
                  >
                    <span className="app-sidebar-item-icon">
                      <GitCompareArrows size={16} />
                    </span>
                    <span className="app-sidebar-item-label min-w-0 flex-1 truncate text-left">
                      {tr("nav.changes")}
                    </span>
                    <em className="app-sidebar-item-badge">{context.changeCount}</em>
                  </Button>
                )}
              </div>
            )}

            {context?.kind === "agents" && (
              <div className="app-sidebar-group app-sidebar-context-group">
                <SidebarSectionLabel>{tr("agents.filters")}</SidebarSectionLabel>
                {agentFilters.map(([id, label]) => (
                  <Button
                    key={id}
                    variant="bare"
                    size="content"
                    className={cn(
                      "app-sidebar-item",
                      context.filter === id && "app-sidebar-item-active",
                    )}
                    onClick={() => context.onFilterChange(id)}
                  >
                    <span className="app-sidebar-item-icon">
                      {id === "all" ? <Bot size={16} /> : <SlidersHorizontal size={16} />}
                    </span>
                    <span className="app-sidebar-item-label min-w-0 flex-1 truncate text-left">
                      {tr(label)}
                    </span>
                  </Button>
                ))}
              </div>
            )}

            <Collapsible open={toolsOpen} onOpenChange={setToolsOpen}>
              <div className="app-sidebar-group app-sidebar-tools">
                <CollapsibleTrigger
                  render={
                    <Button variant="bare" size="content" className="app-sidebar-section-trigger" />
                  }
                >
                  <span>{tr("sidebar.tools")}</span>
                  <ChevronDown
                    className={cn("transition-transform", toolsOpen && "rotate-180")}
                    size={14}
                  />
                </CollapsibleTrigger>
                <CollapsibleContent className="app-sidebar-collapsible-content">
                  {toolEntries.map(renderNavigationEntry)}
                </CollapsibleContent>
              </div>
            </Collapsible>
          </nav>
          <div className="app-sidebar-footer">
            <Button
              variant="bare"
              size="content"
              className="app-sidebar-item app-sidebar-settings-entry"
              type="button"
              aria-label={tr("nav.settings")}
              title={tr("nav.settings")}
              aria-keyshortcuts={ariaShortcut(getShortcutDefinition("open-settings"), platform)}
              onClick={() => {
                setMobileOpen(false);
                onSettings();
              }}
            >
              <span className="app-sidebar-item-icon">
                <Settings size={18} />
              </span>
              <span className="app-sidebar-item-label min-w-0 flex-1 text-left">
                <strong>{tr("nav.settings")}</strong>
                <small>{tr("sidebar.settingsDescription")}</small>
              </span>
            </Button>
          </div>
        </div>
      </aside>
    </>
  );
}
