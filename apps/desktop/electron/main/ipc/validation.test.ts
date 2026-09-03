import { describe, expect, it } from "vitest";

import { requireAccentThemePreference } from "./validation";

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
