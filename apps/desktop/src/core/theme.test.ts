// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accentThemePreference, applyAccentTheme, applyTheme, systemTheme } from "./theme";

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

  it("restores a valid saved accent and falls back for an unknown value", () => {
    window.localStorage.setItem("agentkib.accent-theme", "violet");
    expect(accentThemePreference()).toBe("violet");

    window.localStorage.setItem("agentkib.accent-theme", "unknown");
    expect(accentThemePreference()).toBe("sky");
  });

  it("applies and persists the selected accent", () => {
    applyAccentTheme("emerald");

    expect(document.documentElement.dataset.accentTheme).toBe("emerald");
    expect(window.localStorage.getItem("agentkib.accent-theme")).toBe("emerald");
  });
});
