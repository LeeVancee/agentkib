/** @jsxImportSource octane */

import type { EffectiveTheme, ThemePreference } from "./types";

export type AccentTheme = "minimal-neutral" | "vtron" | "claude" | "sakura" | "ocean-breeze";

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

export function accentThemePreference(): AccentTheme {
  const value = window.localStorage.getItem(ACCENT_THEME_STORAGE_KEY);
  return value === "minimal-neutral" ||
    value === "vtron" ||
    value === "claude" ||
    value === "sakura" ||
    value === "ocean-breeze"
    ? value
    : "vtron";
}

export function applyAccentTheme(theme: AccentTheme) {
  document.documentElement.dataset.accentTheme = theme;
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(ACCENT_THEME_STORAGE_KEY, theme);
  }
}
