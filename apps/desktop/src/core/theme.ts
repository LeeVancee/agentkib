import type { EffectiveTheme } from "./types";

export type AccentTheme = "black" | "sky" | "claude" | "violet" | "emerald";

const ACCENT_THEME_STORAGE_KEY = "agentkib.accent-theme";

export function systemTheme(): EffectiveTheme {
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function applyTheme(theme: EffectiveTheme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
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
