import { describe, expect, it } from "vitest";

import { requireAccentThemePreference, requireSidebarWidthPreference } from "./validation";

describe("sidebar width IPC validation", () => {
  it.each([250, 325, 400])("accepts integer %s", (width) => {
    expect(requireSidebarWidthPreference(width)).toBe(width);
  });

  it.each([null, undefined, "300", 249, 401, 300.5, NaN, Infinity])(
    "rejects invalid width %s",
    (width) => {
      expect(() => requireSidebarWidthPreference(width)).toThrow(
        "sidebar width preference must be an integer between 250 and 400",
      );
    },
  );
});

describe("accent theme IPC validation", () => {
  it.each(["minimal-neutral", "vtron", "claude", "sakura", "ocean-breeze"])(
    "accepts the stable theme id %s",
    (theme) => {
      expect(requireAccentThemePreference(theme)).toBe(theme);
    },
  );

  it.each(["black", "sky", "violet", "emerald", "unknown", null])(
    "rejects the non-current theme id %s",
    (theme) => {
      expect(() => requireAccentThemePreference(theme)).toThrow(
        "accent theme preference is not supported",
      );
    },
  );
});
