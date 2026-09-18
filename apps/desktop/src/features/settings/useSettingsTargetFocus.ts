/** @jsxImportSource octane */

import { useEffect, useRef } from "octane";

import type { SettingsSection, SettingsTarget } from "./SettingsSidebar.tsrx";
import { focusSettingsTarget } from "./components/SettingsLayout.tsrx";

export function useSettingsTargetFocus(
  target: SettingsTarget | undefined,
  section: SettingsSection,
  contentPending: boolean,
) {
  const scheduledKey = useRef("");
  useEffect(() => {
    if (!target || contentPending) return;
    const key = `${section}:${target}`;
    if (scheduledKey.current === key) return;
    scheduledKey.current = key;
    const frame = window.requestAnimationFrame(() => {
      focusSettingsTarget(target);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [contentPending, section, target]);
}
/** @jsxImportSource octane */
