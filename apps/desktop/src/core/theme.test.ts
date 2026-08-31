// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyTheme, systemTheme } from "./theme";

describe("theme runtime", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.colorScheme = "";
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
});
