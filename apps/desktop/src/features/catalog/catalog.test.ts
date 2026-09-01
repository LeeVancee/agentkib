import { describe, expect, it } from "vitest";
import { groupCatalogAssets, groupWorkspaceAssets, workspaceAssetCounts } from "./catalog";

describe("catalog presentation", () => {
  it("groups the same workspace asset while retaining every visible Agent", () => {
    const groups = groupCatalogAssets([
      {
        id: "1",
        scope: "workspace",
        workspace_id: "w",
        agent: "codex",
        kind: "instruction",
        name: "AGENTS.md",
        path: "/repo/AGENTS.md",
        summary: "",
        size: 10,
      },
      {
        id: "2",
        scope: "workspace",
        workspace_id: "w",
        agent: "claude-code",
        kind: "instruction",
        name: "AGENTS.md",
        path: "/repo/AGENTS.md",
        summary: "",
        size: 10,
      },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].agents).toEqual(["codex", "claude-code"]);
    expect(workspaceAssetCounts(groups).get("w")).toBe(1);
  });

  it("groups native scan records by physical path and kind", () => {
    const groups = groupWorkspaceAssets([
      {
        agent: "claude-code",
        kind: "instruction",
        path: "/repo/CLAUDE.md",
        exists: true,
        size: 1024,
        summary: "",
      },
      {
        agent: "hermes",
        kind: "instruction",
        path: "/repo/CLAUDE.md",
        exists: true,
        size: 1024,
        summary: "",
      },
      {
        agent: "codex",
        kind: "instruction",
        path: "/other/CLAUDE.md",
        exists: true,
        size: 2048,
        summary: "",
      },
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0].agents).toEqual(["claude-code", "hermes"]);
    expect(groups[0].records).toHaveLength(2);
    expect(groups[1].path).toBe("/other/CLAUDE.md");
  });

  it("retains shared ownership when a manifest and Agent expose the same Skill root", () => {
    const groups = groupCatalogAssets([
      {
        id: "shared",
        scope: "workspace",
        workspace_id: "w",
        kind: "skill",
        name: "reviewer",
        path: "/repo/.agents/skills/reviewer",
        summary: "",
        size: 10,
      },
      {
        id: "native",
        scope: "workspace",
        workspace_id: "w",
        agent: "codex",
        kind: "skill",
        name: "reviewer",
        path: "/repo/.agents/skills/reviewer",
        summary: "",
        size: 10,
      },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].shared).toBe(true);
    expect(groups[0].agents).toEqual(["codex"]);
    expect(groups[0].records).toHaveLength(2);
  });
});
