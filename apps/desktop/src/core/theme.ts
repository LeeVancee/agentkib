import type { AccentThemeId, EffectiveTheme, ThemePreference } from "./types";

// These values are persisted user preference IDs. Keep them stable and migrate retired IDs.
export const ACCENT_THEME_IDS = [
  "minimal-neutral",
  "vtron",
  "claude",
  "sakura",
  "ocean-breeze",
] as const satisfies readonly AccentThemeId[];

const LEGACY_ACCENT_THEMES: Record<string, AccentThemeId> = {
  black: "minimal-neutral",
  sky: "vtron",
  claude: "claude",
  violet: "sakura",
  emerald: "ocean-breeze",
};

const ACCENT_THEME_STORAGE_KEY = "agentkib.accent-theme";
const EFFECTIVE_THEME_STORAGE_KEY = "agentkib.effective-theme";
const THEME_PREFERENCE_STORAGE_KEY = "agentkib.cached-theme-preference";

export function systemTheme(): EffectiveTheme {
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function applyTheme(theme: EffectiveTheme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

export function cachedEffectiveTheme(): EffectiveTheme {
  try {
    if (window.localStorage.getItem(THEME_PREFERENCE_STORAGE_KEY) === "system") {
      return systemTheme();
    }
    const value = window.localStorage.getItem(EFFECTIVE_THEME_STORAGE_KEY);
    if (value === "light" || value === "dark") return value;
  } catch {
    // The system theme remains a safe fallback in restricted webviews.
  }
  return systemTheme();
}

export function cacheEffectiveTheme(theme: EffectiveTheme, preference?: ThemePreference) {
  try {
    window.localStorage.setItem(EFFECTIVE_THEME_STORAGE_KEY, theme);
    if (preference) window.localStorage.setItem(THEME_PREFERENCE_STORAGE_KEY, preference);
  } catch {
    // Startup appearance caching is best-effort.
  }
}

export function isAccentThemeId(value: unknown): value is AccentThemeId {
  return typeof value === "string" && ACCENT_THEME_IDS.some((theme) => theme === value);
}

export function accentThemePreference(): AccentThemeId {
  try {
    const value = window.localStorage.getItem(ACCENT_THEME_STORAGE_KEY);
    if (isAccentThemeId(value)) return value;
    return value ? (LEGACY_ACCENT_THEMES[value] ?? "vtron") : "vtron";
  } catch {
    return "vtron";
  }
}

export function cacheAccentTheme(theme: AccentThemeId) {
  try {
    window.localStorage.setItem(ACCENT_THEME_STORAGE_KEY, theme);
  } catch {
    // Startup appearance caching is best-effort.
  }
}

export function applyAccentTheme(theme: AccentThemeId) {
  document.documentElement.dataset.accentTheme = theme;
}
