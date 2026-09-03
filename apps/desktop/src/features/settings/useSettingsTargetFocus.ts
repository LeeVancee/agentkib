import { useEffect } from "react";

import type { SettingsSection, SettingsTarget } from "./SettingsSidebar";
import { focusSettingsTarget } from "./components/SettingsLayout";

export function useSettingsTargetFocus(
  target: SettingsTarget | undefined,
  section: SettingsSection,
  contentPending: boolean,
) {
  useEffect(() => {
    if (!target || contentPending) return;
    const frame = window.requestAnimationFrame(() => {
      focusSettingsTarget(target);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [contentPending, section, target]);
}
