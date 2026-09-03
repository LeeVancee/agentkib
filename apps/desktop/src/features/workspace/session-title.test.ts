// @vitest-environment jsdom

import { beforeAll, describe, expect, it } from "vitest";
import { initializeI18n } from "@/core/i18n";
import { displaySessionTitle } from "./session-title";

describe("displaySessionTitle", () => {
  beforeAll(() => initializeI18n("en-US"));

  it("hides cached internal AGENTS instructions", () => {
    expect(displaySessionTitle("# AGENTS.md instructions\nprivate")).toBe("Untitled session");
  });

  it("keeps a real title that only mentions the internal prefix", () => {
    expect(displaySessionTitle("Fix # AGENTS.md instructions rendering")).toBe(
      "Fix # AGENTS.md instructions rendering",
    );
  });
});
