import { Button } from "@/components/ui/button";
import { useEffect, useId, useState, type ComponentType } from "react";
import {
  ArrowLeft,
  Database,
  FolderSearch,
  Keyboard,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  PlugZap,
  Settings,
  Settings2,
  Stethoscope,
} from "lucide-react";
import { tr } from "@/core/i18n";
import { cn } from "@/lib/utils";
import { SidebarBrand } from "@/components/SidebarBrand";
import {
  ariaShortcut,
  currentAppPlatform,
  getShortcutDefinition,
} from "@/core/keyboard-shortcuts";
import { useShortcutHelp } from "@/features/app/ShortcutHelpContext";

export type SettingsSection = "general" | "discovery" | "integrations" | "privacy" | "diagnostics";

const sections: Array<{
  id: SettingsSection;
  label: string;
  icon: ComponentType<{ size?: number }>;
}> = [
  { id: "general", label: "settings.section.general", icon: Settings2 },
  { id: "discovery", label: "settings.section.discovery", icon: FolderSearch },
  { id: "integrations", label: "settings.section.integrations", icon: PlugZap },
  { id: "privacy", label: "settings.section.privacy", icon: Database },
  { id: "diagnostics", label: "settings.section.diagnostics", icon: Stethoscope },
];

export function SettingsSidebar({
  active,
  onSelect,
  onBack,
  onSettings,
  collapsed,
  onCollapsedChange,
}: {
  active: SettingsSection;
  onSelect: (section: SettingsSection) => void;
  onBack: () => void;
  onSettings: () => void;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const sidebarId = useId();
  const { openShortcutHelp } = useShortcutHelp();
  const platform = currentAppPlatform();

  useEffect(() => {
    if (!mobileOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mobileOpen]);

  const select = (section: SettingsSection) => {
    setMobileOpen(false);
    onSelect(section);
  };

  const toggleCollapsed = () => {
    const next = !collapsed;
    onCollapsedChange(next);
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
        aria-label={tr("settings.navigation")}
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
      <div className="app-shell-header">
        <Button
          variant="bare"
          size="content"
          className="app-sidebar-collapse-button"
          type="button"
          aria-label={tr(collapsed ? "common.expandSidebar" : "common.collapseSidebar")}
          aria-keyshortcuts={ariaShortcut(getShortcutDefinition("toggle-sidebar"), platform)}
          aria-expanded={!collapsed}
          data-collapsed={collapsed}
          title={tr(collapsed ? "common.expandSidebar" : "common.collapseSidebar")}
          onClick={toggleCollapsed}
        >
          <span className="app-sidebar-collapse-icon" aria-hidden="true">
            <PanelLeftClose
              className={cn("app-sidebar-collapse-icon-close", collapsed && "is-hidden")}
              size={17}
            />
            <PanelLeftOpen
              className={cn("app-sidebar-collapse-icon-open", !collapsed && "is-hidden")}
              size={17}
            />
          </span>
        </Button>
      </div>
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
                onBack();
              }}
            />
            <Button
              variant="bare"
              size="content"
              className="app-sidebar-item app-sidebar-back-item"
              type="button"
              title={tr("settings.backToApp")}
              onClick={() => {
                setMobileOpen(false);
                onBack();
              }}
            >
              <span className="app-sidebar-item-icon">
                <ArrowLeft size={18} />
              </span>
              <span className="app-sidebar-item-label min-w-0 flex-1 truncate text-left">
                {tr("settings.backToApp")}
              </span>
            </Button>
          </div>
          <nav className="app-sidebar-nav" aria-label={tr("settings.navigation")}>
            {sections.map(({ id, label, icon: Icon }) => (
              <Button
                key={id}
                variant="bare"
                size="content"
                className={cn("app-sidebar-item", active === id && "app-sidebar-item-active")}
                aria-current={active === id ? "page" : undefined}
                title={tr(label)}
                onClick={() => select(id)}
              >
                <span className="app-sidebar-item-icon">
                  <Icon size={18} />
                </span>
                <span className="app-sidebar-item-label min-w-0 flex-1 truncate text-left">
                  {tr(label)}
                </span>
              </Button>
            ))}
          </nav>
          <div className="app-sidebar-footer">
            <Button
              variant="bare"
              size="content"
              className="app-sidebar-item"
              type="button"
              title={tr("shortcuts.openHelp")}
              aria-label={tr("shortcuts.openHelp")}
              aria-keyshortcuts={ariaShortcut(getShortcutDefinition("open-help"), platform)}
              onClick={() => {
                setMobileOpen(false);
                openShortcutHelp();
              }}
            >
              <span className="app-sidebar-item-icon">
                <Keyboard size={18} />
              </span>
              <span className="app-sidebar-item-label min-w-0 flex-1 truncate text-left">
                {tr("shortcuts.openHelp")}
              </span>
            </Button>
            <Button
              variant="bare"
              size="content"
              className="app-sidebar-item"
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
              <span className="app-sidebar-item-label min-w-0 flex-1 truncate text-left">
                {tr("nav.settings")}
              </span>
            </Button>
          </div>
        </div>
      </aside>
    </>
  );
}

export function settingsSectionLabel(section: SettingsSection) {
  return tr(`settings.section.${section}`);
}
