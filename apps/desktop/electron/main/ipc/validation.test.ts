import { describe, expect, it } from "vitest";

import {
  optionalBoolean,
  requireAccentThemePreference,
  requireAgentKind,
  requireSidebarWidthPreference,
} from "./validation";

describe("agent IPC validation", () => {
  it.each([
    "codex",
    "claude-code",
    "antigravity",
    "cursor",
    "opencode",
    "open-claw",
    "hermes",
    "grok-build",
    "deepseek-harness",
  ])("accepts the supported agent %s", (agent) => {
    expect(requireAgentKind(agent)).toBe(agent);
  });

  it.each(["unknown", "toString", "__proto__", "Codex"])(
    "rejects the unsupported agent %s",
    (agent) => {
      expect(() => requireAgentKind(agent)).toThrow(`Unsupported agent: ${agent}`);
    },
  );

  it.each([undefined, null, "", 1])("rejects the non-string agent %s", (agent) => {
    expect(() => requireAgentKind(agent)).toThrow("agent must be a non-empty string");
  });
});

describe("optional boolean IPC validation", () => {
  it.each([true, false])("accepts %s", (value) => {
    expect(optionalBoolean(value, "flag")).toBe(value);
  });
  it.each([undefined, null])("treats %s as absent", (value) => {
    expect(optionalBoolean(value, "flag")).toBeUndefined();
  });
  it.each(["true", 1, 0, {}, []])("rejects the non-boolean %s", (value) => {
    expect(() => optionalBoolean(value, "flag")).toThrow("flag must be a boolean");
  });
});
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
