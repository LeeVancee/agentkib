import { Button } from "@/components/ui/button";
import { useEffect, useId, useState, type ComponentType } from "react";
import {
  ArrowLeft,
  Database,
  FolderSearch,
  Menu,
  PlugZap,
  Settings2,
  Stethoscope,
} from "lucide-react";
import { tr } from "@/core/i18n";
import { cn } from "@/lib/utils";

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

export function SettingsSidebar(props: {
  active: SettingsSection;
  onSelect: (section: SettingsSection) => void;
  onBack: () => void;
  onSettings?: () => void;
  collapsed: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}) {
  const { active, onSelect, onBack, collapsed } = props;
  const [mobileOpen, setMobileOpen] = useState(false);
  const sidebarId = useId();

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
            <Button
              variant="bare"
              size="content"
              className="app-sidebar-item app-sidebar-back-item app-settings-back"
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
        </div>
      </aside>
    </>
  );
}

export function settingsSectionLabel(section: SettingsSection) {
  return tr(`settings.section.${section}`);
}
