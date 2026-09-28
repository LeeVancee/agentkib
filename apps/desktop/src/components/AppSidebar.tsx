import { Button } from "@/components/ui/button";
import { SidebarTooltip } from "@/components/ui/tooltip";
import { useEffect, useId, useRef, useState, type ComponentType, type ReactNode } from "react";
import {
  Bot,
  ChevronRight,
  FolderGit2,
  GitCompareArrows,
  Menu,
  MonitorSmartphone,
  Settings,
  SlidersHorizontal,
  Star,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { SidebarBrand } from "./SidebarBrand";
import { SidebarSearchButton } from "./SidebarSearchButton";
import { useAppStore } from "@/stores/app-store";
import {
  ariaShortcut,
  currentAppPlatform,
  getShortcutDefinition,
  type ShortcutId,
} from "@/core/keyboard-shortcuts";
import type { WorkspaceSummary } from "@/core/types";
import type { GlobalPage, Page } from "@/features/app/app-route";
import { useRetainedScroll } from "@/features/app/useRetainedScroll";
import { SidebarPanelTarget } from "@/features/app/SidebarPanel";
import { useSidebarViewStore } from "@/features/app/sidebar-view-store";
import {
  workspaceTaskEntries,
  workspaceDevelopmentEntries,
} from "@/features/workspace/workspace-navigation";
import { SessionDirectory } from "@/features/sessions/SessionDirectory";
import { RemoteConnectionPanel } from "@/features/remote/RemoteConnectionPanel";
import logo from "../../resources/assets/agentkib-icon-mark.png";

export interface SidebarEntry<T extends string> {
  id: T;
  label: string;
  icon: ComponentType<{ size?: number }>;
  badge?: number;
  shortcut?: ShortcutId;
}

export type AgentFilter = "all" | "enabled" | "available";
export type AppSidebarContext =
  | { kind: "sessions" }
  | { kind: "global" }
  | { kind: "agents"; filter: AgentFilter; onFilterChange: (filter: AgentFilter) => void };

const agentFilters: Array<[AgentFilter, string]> = [
  ["all", "agents.filter.all"],
  ["enabled", "agents.filter.enabled"],
  ["available", "agents.filter.available"],
];

export function AppSidebar(props: {
  active: GlobalPage | "settings";
  entries: SidebarEntry<GlobalPage>[];
  onNavigate: (page: GlobalPage) => void;
  onSettings: () => void;
  onRemoteSettings?: () => void;
  onOpenSearch?: () => void;
  searchOpen?: boolean;
  collapsed: boolean;
  context?: AppSidebarContext;
  workspaces?: WorkspaceSummary[];
  favoriteWorkspaceIds?: string[];
  onOpenWorkspace?: (workspace: WorkspaceSummary, page?: Page) => void;
  onCollapsedChange?: (collapsed: boolean) => void;
  activeWorkspaceId?: string;
  workspacePage?: Page;
  changeCount?: number;
  onWorkspaceNavigate?: (page: Page) => void;
  secondary?: ReactNode;
}) {
  const { t: tr } = useTranslation();
  const { active, context, collapsed } = props;
  const hasPanel = ["workspaces", "sessions", "agents", "catalog", "settings"].includes(active);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const sidebarId = useId();
  const panelId = useId();
  const asideRef = useRef<HTMLElement>(null);
  const [scrollOffsets] = useState(() => new Map<string, number>());
  const scrollRef = useRetainedScroll(active, scrollOffsets);
  const setSidebarCollapsed = useAppStore((state) => state.setSidebarCollapsed);
  const expandedWorkspaces = useSidebarViewStore((state) => state.expandedWorkspaces);
  const setWorkspaceExpanded = useSidebarViewStore((state) => state.setWorkspaceExpanded);
  const platform = currentAppPlatform();

  useEffect(() => {
    if (props.searchOpen) setMobileOpen(false);
  }, [props.searchOpen]);
  useEffect(() => {
    if (
      props.activeWorkspaceId &&
      !(props.activeWorkspaceId in useSidebarViewStore.getState().expandedWorkspaces)
    )
      setWorkspaceExpanded(props.activeWorkspaceId, true);
  }, [props.activeWorkspaceId, setWorkspaceExpanded]);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1024px)");
    const closeOnDesktop = () => {
      if (desktop.matches) setMobileOpen(false);
    };
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);

  useEffect(() => {
    const aside = asideRef.current;
    const closeAfterSelection = (event: Event) => {
      if (
        event.target instanceof Element &&
        event.target.closest("[data-sidebar-navigate], [data-session-entry], [role=tab]")
      )
        setMobileOpen(false);
    };
    aside?.addEventListener("click", closeAfterSelection);
    return () => aside?.removeEventListener("click", closeAfterSelection);
  }, []);

  useEffect(() => {
    if (!mobileOpen) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const getButtons = () =>
      Array.from(
        asideRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input, [tabindex="0"], a[href]',
        ) ?? [],
      ).filter((element) => element.getClientRects().length > 0);
    getButtons()[0]?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMobileOpen(false);
      }
      if (event.key !== "Tab" || event.defaultPrevented) return;
      const buttons = getButtons();
      const first = buttons[0];
      const last = buttons.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, [mobileOpen]);

  const expandPanel = () => {
    setSidebarCollapsed(false);
    props.onCollapsedChange?.(false);
  };
  const navigate = (page: GlobalPage) => {
    const needsPanel = ["workspaces", "sessions", "agents", "catalog"].includes(page);
    if (needsPanel) expandPanel();
    else setMobileOpen(false);
    props.onNavigate(page);
  };
  const panelTitle =
    active === "settings"
      ? tr("nav.settings")
      : tr(props.entries.find((entry) => entry.id === active)?.label ?? "nav.workspaces");
  const renderWorkspaceEntry = ({
    page,
    label,
    icon: Icon,
  }: (typeof workspaceTaskEntries)[number] | (typeof workspaceDevelopmentEntries)[number]) => (
    <Button
      key={page}
      variant="bare"
      size="content"
      data-sidebar-navigate
      className={cn(
        "app-sidebar-item workspace-sidebar-child",
        props.workspacePage === page && "app-sidebar-item-active",
      )}
      aria-current={props.workspacePage === page ? "page" : undefined}
      onClick={() => props.onWorkspaceNavigate?.(page)}
    >
      <Icon size={15} />
      <span className="truncate">{tr(label)}</span>
    </Button>
  );

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
        ref={asideRef}
        role={mobileOpen ? "dialog" : undefined}
        aria-modal={mobileOpen || undefined}
        aria-label={tr("common.primaryNavigation")}
        className={cn(
          "app-sidebar app-sidebar-dual",
          active === "sessions" && "app-sidebar-sessions",
          collapsed && "app-sidebar-panel-collapsed",
          !hasPanel && "app-sidebar-no-panel",
          mobileOpen && "app-sidebar-open",
        )}
      >
        <div className="app-activity-bar">
          <div className="activity-bar-brand">
            <img src={logo} alt="" aria-hidden="true" />
            <span className="sr-only">AgentKib</span>
          </div>
          {props.onOpenSearch && (
            <SidebarSearchButton
              onOpenSearch={props.onOpenSearch}
              className="activity-bar-search"
            />
          )}
          <nav className="activity-bar-navigation" aria-label={tr("common.primaryNavigation")}>
            {props.entries.map(({ id, label, icon: Icon, badge, shortcut }) => (
              <SidebarTooltip key={id} label={tr(label)}>
                <Button
                  variant="bare"
                  size="content"
                  className={cn("activity-bar-item", active === id && "activity-bar-item-active")}
                  aria-current={active === id ? "page" : undefined}
                  aria-keyshortcuts={
                    shortcut ? ariaShortcut(getShortcutDefinition(shortcut), platform) : undefined
                  }
                  aria-controls={
                    ["workspaces", "sessions", "agents", "catalog"].includes(id)
                      ? panelId
                      : undefined
                  }
                  onClick={() => navigate(id)}
                >
                  <Icon size={20} />
                  <span className="sr-only">{tr(label)}</span>
                  {!!badge && <em className="activity-bar-badge">{badge}</em>}
                </Button>
              </SidebarTooltip>
            ))}
          </nav>
          <div className="activity-bar-footer">
            <SidebarTooltip label={tr("sessions.remote")}>
              <Button
                variant="bare"
                size="content"
                className="activity-bar-item"
                onClick={() => {
                  setMobileOpen(false);
                  setRemoteOpen(true);
                }}
              >
                <MonitorSmartphone size={19} />
                <span className="sr-only">{tr("sessions.remote")}</span>
              </Button>
            </SidebarTooltip>
            <SidebarTooltip label={tr("nav.settings")}>
              <Button
                variant="bare"
                size="content"
                className={cn(
                  "activity-bar-item",
                  active === "settings" && "activity-bar-item-active",
                )}
                aria-current={active === "settings" ? "page" : undefined}
                aria-keyshortcuts={ariaShortcut(getShortcutDefinition("open-settings"), platform)}
                onClick={() => {
                  expandPanel();
                  props.onSettings();
                }}
              >
                <Settings size={20} />
                <span className="sr-only">{tr("nav.settings")}</span>
              </Button>
            </SidebarTooltip>
            <Button
              variant="bare"
              size="content"
              className="activity-bar-item activity-bar-mobile-close"
              aria-label={tr("common.close")}
              onClick={() => setMobileOpen(false)}
            >
              <X size={19} />
            </Button>
          </div>
        </div>
        <div
          id={panelId}
          className="app-context-sidebar"
          inert={!hasPanel || (collapsed && !mobileOpen)}
        >
          <div className="app-sidebar-content">
            <div className="app-sidebar-header">
              <SidebarBrand />
              <h2 className="context-sidebar-title">{panelTitle}</h2>
            </div>
            <div ref={scrollRef} className="context-sidebar-scroll">
              {active === "workspaces" && (
                <nav
                  className="workspace-sidebar-directory"
                  aria-label={tr("sidebar.allWorkspaces")}
                >
                  {(props.workspaces ?? []).map((workspace) => {
                    const selected = props.activeWorkspaceId === workspace.id;
                    const expanded = expandedWorkspaces[workspace.id] ?? selected;
                    return (
                      <div key={workspace.id} className="workspace-sidebar-group">
                        <div
                          className={cn(
                            "workspace-sidebar-row",
                            selected && "workspace-sidebar-row-active",
                          )}
                        >
                          <Button
                            variant="bare"
                            size="content"
                            className="workspace-sidebar-toggle"
                            aria-label={
                              tr(expanded ? "common.collapseSidebar" : "common.expandSidebar") +
                              ": " +
                              workspace.name
                            }
                            aria-expanded={expanded}
                            onClick={() => setWorkspaceExpanded(workspace.id, !expanded)}
                          >
                            <ChevronRight size={14} className={cn(expanded && "rotate-90")} />
                          </Button>
                          <Button
                            variant="bare"
                            size="content"
                            className="app-sidebar-item workspace-sidebar-name"
                            data-sidebar-navigate
                            title={workspace.name}
                            onClick={() => {
                              setWorkspaceExpanded(workspace.id, true);
                              props.onOpenWorkspace?.(workspace);
                            }}
                          >
                            <FolderGit2 size={16} />
                            <span className="min-w-0 flex-1 truncate text-left">
                              {workspace.name}
                            </span>
                            {workspace.status === "attention" && (
                              <span
                                className="app-sidebar-status-dot"
                                aria-label={tr("status.workspace.attention")}
                              />
                            )}
                            {props.favoriteWorkspaceIds?.includes(workspace.id) && (
                              <Star size={12} className="fill-current opacity-60" />
                            )}
                          </Button>
                        </div>
                        {expanded && (
                          <div className="workspace-sidebar-children">
                            {selected ? (
                              <>
                                {workspaceTaskEntries.map(renderWorkspaceEntry)}
                                <div className="workspace-sidebar-divider" />
                                {workspaceDevelopmentEntries.map(renderWorkspaceEntry)}
                                {(!!props.changeCount || props.workspacePage === "changes") && (
                                  <Button
                                    variant="bare"
                                    size="content"
                                    data-sidebar-navigate
                                    className={cn(
                                      "app-sidebar-item workspace-sidebar-child",
                                      props.workspacePage === "changes" &&
                                        "app-sidebar-item-active",
                                    )}
                                    aria-current={
                                      props.workspacePage === "changes" ? "page" : undefined
                                    }
                                    onClick={() => props.onWorkspaceNavigate?.("changes")}
                                  >
                                    <GitCompareArrows size={15} />
                                    <span>{tr("nav.changes")}</span>
                                    <em className="app-sidebar-item-badge">
                                      {props.changeCount ?? 0}
                                    </em>
                                  </Button>
                                )}
                              </>
                            ) : (
                              [...workspaceTaskEntries, ...workspaceDevelopmentEntries].map(
                                ({ page, label, icon: Icon }) => (
                                  <Button
                                    key={page}
                                    variant="bare"
                                    size="content"
                                    data-sidebar-navigate
                                    className="app-sidebar-item workspace-sidebar-child"
                                    onClick={() => props.onOpenWorkspace?.(workspace, page)}
                                  >
                                    <Icon size={15} />
                                    {tr(label)}
                                  </Button>
                                ),
                              )
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {!props.workspaces?.length && (
                    <p className="px-3 py-6 text-sm text-muted-foreground">
                      {tr("common.notFound")}
                    </p>
                  )}
                </nav>
              )}
              {context?.kind === "agents" && (
                <div className="app-sidebar-group agent-sidebar-filters">
                  {agentFilters.map(([id, label]) => (
                    <Button
                      key={id}
                      variant="bare"
                      size="content"
                      className={cn(
                        "app-sidebar-item",
                        context.filter === id && "app-sidebar-item-active",
                      )}
                      aria-pressed={context.filter === id}
                      onClick={() => context.onFilterChange(id)}
                    >
                      <span className="app-sidebar-item-icon">
                        {id === "all" ? <Bot size={16} /> : <SlidersHorizontal size={16} />}
                      </span>
                      {tr(label)}
                    </Button>
                  ))}
                </div>
              )}
              {active === "sessions" && (
                <div className="app-sidebar-session-directory">
                  <SessionDirectory />
                </div>
              )}
              {(active === "agents" || active === "catalog") && <SidebarPanelTarget />}
              {props.secondary}
            </div>
          </div>
        </div>
      </aside>
      {remoteOpen && (
        <RemoteConnectionPanel
          open={remoteOpen}
          onOpenChange={setRemoteOpen}
          onSettings={() => {
            setRemoteOpen(false);
            (props.onRemoteSettings ?? props.onSettings)();
          }}
        />
      )}
    </>
  );
}
