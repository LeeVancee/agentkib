// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AppDialogProvider } from "@/components/AppDialogProvider";
import { initializeI18n } from "@/core/i18n";
import type { SkillCandidate, SkillOperationPreview } from "@/core/types";
import { SkillHubPage } from "./SkillHubPage";

const mocks = vi.hoisted(() => ({
  installedSkills: vi.fn(),
  removedSkills: vi.fn(),
  skillCatalog: vi.fn(),
  discoverSkills: vi.fn(),
  prepareSkillInstall: vi.fn(),
  prepareSkillUpdate: vi.fn(),
  applySkillOperation: vi.fn(),
  checkSkillUpdates: vi.fn(),
  rollbackSkill: vi.fn(),
  uninstallSkill: vi.fn(),
  restoreSkill: vi.fn(),
}));

vi.mock("@/core/api", () => ({ api: mocks }));

const candidate: SkillCandidate = {
  name: "skill-installer",
  description: "Install Skills from curated sources or GitHub.",
  license: "Apache-2.0",
  source: {
    kind: "openai-curated",
    repository: "openai/skills",
    ref: "main",
    path: "skills/.curated/skill-installer",
    resolved_commit: "0123456789abcdef",
    tree_sha: "tree-sha",
  },
};

const preview: SkillOperationPreview = {
  token: "preview-token",
  operation: "install",
  skill: candidate,
  files: [{ path: "SKILL.md", size: 128, executable: false }],
  added: ["SKILL.md"],
  modified: [],
  removed: [],
  total_size: 128,
  local_modified: false,
  expires_at: "2030-01-01T00:00:00Z",
};

describe("SkillHubPage", () => {
  beforeAll(() => initializeI18n("en-US"));
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("separates the AgentKib library from workspace usage", async () => {
    mocks.installedSkills.mockResolvedValue([
      {
        name: "local-reviewer",
        description: "Review local changes",
        path: "/tmp/.agentkib/skills/local-reviewer",
        size: 256,
        status: "unmanaged",
        can_rollback: false,
      },
    ]);
    mocks.removedSkills.mockResolvedValue([]);

    render(
      <AppDialogProvider>
        <SkillHubPage workspaceAssets={[]} workspaces={[]} onOpen={vi.fn()} onReload={vi.fn()} />
      </AppDialogProvider>,
    );

    expect(await screen.findByText("local-reviewer")).toBeTruthy();
    expect(screen.getByText("Local unmanaged")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Workspace usage/ })).toBeTruthy();
    expect(screen.getByText(/not enabled for any Agent automatically/)).toBeTruthy();
  });

  it("reviews an immutable curated package before adding it", async () => {
    mocks.installedSkills.mockResolvedValue([]);
    mocks.removedSkills.mockResolvedValue([]);
    mocks.skillCatalog.mockResolvedValue({
      entries: [{ ...candidate, installed: false }],
      cached_at: "2026-09-02T00:00:00Z",
      stale: false,
    });
    mocks.prepareSkillInstall.mockResolvedValue(preview);
    mocks.applySkillOperation.mockResolvedValue({
      name: candidate.name,
      description: candidate.description,
      path: "/tmp/.agentkib/skills/skill-installer",
      size: 128,
      status: "current",
      source: candidate.source,
      can_rollback: false,
    });
    const user = userEvent.setup();

    render(
      <AppDialogProvider>
        <SkillHubPage workspaceAssets={[]} workspaces={[]} onOpen={vi.fn()} onReload={vi.fn()} />
      </AppDialogProvider>,
    );

    await user.click(screen.getByRole("tab", { name: "Discover" }));
    expect(await screen.findByText("skill-installer")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Add to library" }));

    expect(await screen.findByText("Review Skill package")).toBeTruthy();
    expect(screen.getByText("0123456789ab")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Add to library" }));

    await waitFor(() =>
      expect(mocks.applySkillOperation).toHaveBeenCalledWith("preview-token", false),
    );
  });
});
