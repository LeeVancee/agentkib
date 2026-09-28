import { useI18n } from "@/core/useI18n";
import {
  currentAppPlatform,
  formatShortcut,
  shortcutsForGroup,
  type ShortcutGroup,
} from "@/core/keyboard-shortcuts";
import { SettingsPage, SettingsPageHeader, SettingsSection } from "./components/SettingsLayout";

export function KeyboardShortcutsSettings() {
  const { tr } = useI18n();
  const platform = currentAppPlatform();
  return (
    <SettingsPage>
      <SettingsPageHeader title={tr("settings.section.shortcuts")} />
      <SettingsSection title={tr("shortcuts.group.navigation")} target="shortcuts-list">
        <ShortcutRows group="navigation" platform={platform} />
      </SettingsSection>
      <SettingsSection title={tr("shortcuts.group.actions")}>
        <ShortcutRows group="actions" platform={platform} />
      </SettingsSection>
    </SettingsPage>
  );
}

function ShortcutRows({
  group,
  platform,
}: {
  group: ShortcutGroup;
  platform: ReturnType<typeof currentAppPlatform>;
}) {
  const { tr } = useI18n();
  return (
    <div className="divide-y divide-border/60">
      {shortcutsForGroup(group).map((definition) => (
        <div
          key={definition.id}
          className="flex min-h-12 items-center justify-between gap-4 px-5 py-2.5"
        >
          <span className="min-w-0 truncate">{tr(definition.labelKey)}</span>
          <kbd className="shrink-0 rounded border border-border bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground">
            {formatShortcut(definition, platform)}
          </kbd>
        </div>
      ))}
    </div>
  );
}
