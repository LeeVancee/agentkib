// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { appSearchSchema } from "./app-search-schema";

describe("appSearchSchema", () => {
  it.each(["library", "workspace", "discover"])(
    "accepts the Skills section %s without losing other search fields",
    (skillSection) => {
      const search = {
        assetSection: "skills",
        catalogTarget: "mcp-network",
        skillSection,
        workspaceAssetSection: "native",
        workspaceView: "storage",
        sessionId: "saved-session",
      };
      expect(appSearchSchema.parse(search)).toMatchObject(search);
    },
  );
  it("safely drops missing or invalid Skills sections", () => {
    expect(appSearchSchema.parse({}).skillSection).toBeUndefined();
    for (const skillSection of ["unknown", "Library", true, null, 1, ["library"], {}])
      expect(appSearchSchema.parse({ assetSection: "skills", skillSection })).toMatchObject({
        assetSection: "skills",
        skillSection: undefined,
      });
  });
  it("only accepts the supported MCP network destination", () => {
    expect(
      appSearchSchema.parse({ assetSection: "mcp", catalogTarget: "mcp-network" }),
    ).toMatchObject({
      assetSection: "mcp",
      catalogTarget: "mcp-network",
    });
    for (const catalogTarget of ["mcp", "unknown", true, null, 1]) {
      expect(appSearchSchema.parse({ catalogTarget }).catalogTarget).toBeUndefined();
    }
  });
  it("accepts the pre-compaction history choice only as true", () => {
    expect(appSearchSchema.parse({ handoffPreCompaction: true }).handoffPreCompaction).toBe(true);
    for (const value of [false, "true", 1, null])
      expect(appSearchSchema.parse({ handoffPreCompaction: value }).handoffPreCompaction).toBe(
        undefined,
      );
    expect(appSearchSchema.parse({}).handoffPreCompaction).toBeUndefined();
  });
});
