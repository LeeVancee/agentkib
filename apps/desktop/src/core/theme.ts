import type { EffectiveTheme } from "./types";

export type AccentTheme = "black" | "sky" | "claude" | "violet" | "emerald";

const ACCENT_THEME_STORAGE_KEY = "agentkib.accent-theme";
const EFFECTIVE_THEME_STORAGE_KEY = "agentkib.effective-theme";

export function systemTheme(): EffectiveTheme {
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function applyTheme(theme: EffectiveTheme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

export function cachedEffectiveTheme(): EffectiveTheme {
  try {
    const value = window.localStorage.getItem(EFFECTIVE_THEME_STORAGE_KEY);
    if (value === "light" || value === "dark") return value;
  } catch {
    // The system theme remains a safe fallback in restricted webviews.
  }
  return systemTheme();
}

export function cacheEffectiveTheme(theme: EffectiveTheme) {
  try {
    window.localStorage.setItem(EFFECTIVE_THEME_STORAGE_KEY, theme);
  } catch {
    // Startup appearance caching is best-effort.
  }
}

export function accentThemePreference(): AccentTheme {
  const value = window.localStorage.getItem(ACCENT_THEME_STORAGE_KEY);
  return value === "black" ||
    value === "sky" ||
    value === "claude" ||
    value === "violet" ||
    value === "emerald"
    ? value
    : "sky";
}

export function applyAccentTheme(theme: AccentTheme) {
  document.documentElement.dataset.accentTheme = theme;
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(ACCENT_THEME_STORAGE_KEY, theme);
  }
}
