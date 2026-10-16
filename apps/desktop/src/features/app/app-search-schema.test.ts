// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { appSearchSchema } from "./app-search-schema";

describe("appSearchSchema", () => {
  it("accepts the pre-compaction history choice only as true", () => {
    expect(appSearchSchema.parse({ handoffPreCompaction: true }).handoffPreCompaction).toBe(true);
    for (const value of [false, "true", 1, null])
      expect(appSearchSchema.parse({ handoffPreCompaction: value }).handoffPreCompaction).toBe(
        undefined,
      );
    expect(appSearchSchema.parse({}).handoffPreCompaction).toBeUndefined();
  });
});
