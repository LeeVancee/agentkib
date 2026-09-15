// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  accentThemePreference,
  applyAccentTheme,
  applyTheme,
  cacheAccentTheme,
  cacheEffectiveTheme,
  cachedEffectiveTheme,
  systemTheme,
} from "./theme";

describe("theme runtime", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-accent-theme");
    document.documentElement.style.colorScheme = "";
    window.localStorage.clear();
  });

  it("uses the browser system appearance when no saved preference exists", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: true }),
    });

    expect(systemTheme()).toBe("light");
  });

  it("applies the effective theme to native form controls before rendering", () => {
    applyTheme("dark");

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("restores a valid saved accent and falls back without overwriting an unknown value", () => {
    window.localStorage.setItem("agentkib.accent-theme", "sakura");
    expect(accentThemePreference()).toBe("sakura");

    window.localStorage.setItem("agentkib.accent-theme", "unknown");
    expect(accentThemePreference()).toBe("vtron");
    expect(window.localStorage.getItem("agentkib.accent-theme")).toBe("unknown");
  });

  it.each([
    ["black", "minimal-neutral"],
    ["sky", "vtron"],
    ["claude", "claude"],
    ["violet", "sakura"],
    ["emerald", "ocean-breeze"],
  ] as const)("migrates the legacy accent %s to %s", (legacy, current) => {
    window.localStorage.setItem("agentkib.accent-theme", legacy);

    const migrated = accentThemePreference();
    cacheAccentTheme(migrated);

    expect(migrated).toBe(current);
    expect(window.localStorage.getItem("agentkib.accent-theme")).toBe(current);
  });

  it("applies and caches the selected accent independently", () => {
    applyAccentTheme("ocean-breeze");

    expect(document.documentElement.dataset.accentTheme).toBe("ocean-breeze");
    expect(window.localStorage.getItem("agentkib.accent-theme")).toBeNull();

    cacheAccentTheme("ocean-breeze");
    expect(window.localStorage.getItem("agentkib.accent-theme")).toBe("ocean-breeze");
  });

  it("caches the last explicit theme for non-blocking startup", () => {
    cacheEffectiveTheme("dark", "dark");

    expect(cachedEffectiveTheme()).toBe("dark");
  });

  it("uses the current system theme when the cached preference follows the system", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: true }),
    });
    cacheEffectiveTheme("dark", "system");

    expect(cachedEffectiveTheme()).toBe("light");
  });
});
