import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const THEMES = ["system", "light", "dark"];
const ACCENTS = ["minimal-neutral", "vtron", "claude", "sakura", "ocean-breeze"];
const ICONS = ["white", "black"];
const CLOSE_BEHAVIORS = ["minimize-to-tray", "quit"];

export function readPreferences(dataDir: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(path.join(dataDir, "preferences.json"), "utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT")
      return {};
    throw error;
  }
}

/** Caller serializes this with every remaining Rust writer of preferences.json. */
export function writePreference(dataDir: string, key: string, value: unknown): void {
  const preferences = { ...readPreferences(dataDir), [key]: value };
  mkdirSync(dataDir, { recursive: true });
  const destination = path.join(dataDir, "preferences.json");
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(preferences, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function preferenceSnapshot(dataDir: string, environment: NodeJS.ProcessEnv) {
  const preferences = readPreferences(dataDir);
  const locale =
    typeof preferences.locale_preference === "string" ? preferences.locale_preference : "system";
  const theme = member(preferences.theme_preference, THEMES) ?? "system";
  const width = preferences.sidebar_width_preference;
  return {
    close_behavior: member(preferences.close_behavior, CLOSE_BEHAVIORS),
    locale_preference: locale,
    effective_locale: locale === "system" ? (environment.AGENTKIB_LOCALE ?? "en-US") : locale,
    theme_preference: theme,
    effective_theme: theme === "system" ? (environment.AGENTKIB_SYSTEM_THEME ?? "light") : theme,
    accent_theme_preference: member(preferences.accent_theme_preference, ACCENTS),
    sidebar_width_preference:
      typeof width === "number" && Number.isInteger(width) && width >= 250 && width <= 400
        ? width
        : null,
    app_icon_preference: member(preferences.app_icon_preference, ICONS) ?? "white",
  };
}

function member(value: unknown, values: string[]): string | null {
  return typeof value === "string" && values.includes(value) ? value : null;
}
