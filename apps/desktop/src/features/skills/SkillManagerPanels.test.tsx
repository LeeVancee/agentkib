// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { changeLocale, initializeI18n } from "@/core/i18n";
import type {
  AgentKind,
  SkillDeployment,
  SkillDeploymentPreview,
  SkillObservation,
  SkillTargetCapability,
} from "@/core/types";
import {
  SkillDeploymentDialog,
  SkillDetailDialog,
  SkillUsageList,
  groupSkillObservations,
} from "./SkillManagerPanels";

const mocks = vi.hoisted(() => ({
  skillTargets: vi.fn(),
  prepareSkillDeployment: vi.fn(),
  applySkillDeployment: vi.fn(),
  skillDeployments: vi.fn(),
  readSkillPreviewFile: vi.fn(),
  skillDetail: vi.fn(),
  readSkillDetailFile: vi.fn(),
}));
vi.mock("@/core/api", () => ({ api: mocks }));
beforeAll(() => initializeI18n("en-US"));
beforeEach(() => {
  vi.resetAllMocks();
  mocks.skillDeployments.mockResolvedValue([]);
  mocks.readSkillPreviewFile.mockResolvedValue({
    path: "SKILL.md",
    before: "Old instructions",
    after: "New instructions",
    binary: false,
    truncated: false,
  });
});
afterEach(async () => {
  cleanup();
  await changeLocale("en-US");
});

const agents: AgentKind[] = [
  "codex",
  "claude-code",
  "antigravity",
  "cursor",
  "opencode",
  "open-claw",
  "hermes",
  "grok-build",
];
function target(agent: AgentKind): SkillTargetCapability {
  const shared = agent === "codex" || agent === "opencode";
  return {
    id: agent,
    agent,
    scope: "personal",
    workspace_id: null,
    profile: null,
    root: shared ? "/native/shared/skills" : `/native/${agent}/skills`,
    scope_root: "/native",
    visible_to: shared ? ["codex", "opencode"] : [agent],
    writable: true,
    reason: null,
    conditions: [],
  };
}
const deployment: SkillDeployment = {
  id: "owned-1",
  library_id: "reviewer",
  library_root: "/library",
  source_is_current_library: true,
  package_name: "reviewer",
  package_hash: "hash",
  scope: "personal",
  workspace_id: null,
  scope_root: "/native",
  target: "/native/shared/skills/reviewer",
  agents: ["codex"],
  visible_to: ["codex", "opencode"],
  status: "active",
  diagnostics: [],
  previous_hash: "older-hash",
  operation_id: "operation",
  updated_at: "2026-10-03T00:00:00Z",
};
const preview: SkillDeploymentPreview = {
  token: "immutable-preview",
  operation: "deploy",
  library_id: "reviewer",
  expires_at: "2030-01-01T00:00:00Z",
  requires_home_approval: true,
  targets: [
    {
      target_id: "physical-shared",
      deployment_id: null,
      path: deployment.target,
      scope: "personal",
      workspace_id: null,
      agents: ["codex", "opencode"],
      visible_to: ["codex", "opencode"],
      added: ["SKILL.md"],
      modified: [],
      removed: [],
      conflicts: [],
      conditions: [],
    },
  ],
};
const observation: SkillObservation = {
  id: "cc-observation",
  name: "reviewer",
  path: "/native/claude/skills/reviewer",
  resolved_path: "/cc-switch/skills/reviewer",
  scope: "personal",
  workspace_id: null,
  agents: ["claude-code"],
  kind: "symlink",
  status: "visible",
  owner: "cc-switch",
  library_id: null,
  diagnostics: ["Shared package managed outside AgentKib"],
};

describe("Skill deployment workflow", () => {
  it("restores an interrupted operation from saved usage after restart without preparing a new plan", async () => {
    const interrupted = {
      ...deployment,
      status: "recovery-required",
      operation_id: "saved-operation",
    };
    const onAction = vi.fn();
    const usage = render(
      <SkillUsageList
        inventory={{ observations: [], warnings: [] }}
        deployments={[interrupted]}
        installed={[]}
        workspaces={[]}
        loading={false}
        busy={false}
        onDetail={vi.fn()}
        onImport={vi.fn()}
        onAction={onAction}
        onOpen={vi.fn()}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Recover operation" }));
    expect(onAction).toHaveBeenCalledWith({
      operation: "recover",
      deployment: interrupted,
      recoveryDeployments: [interrupted],
    });
    usage.unmount();
    mocks.applySkillDeployment.mockResolvedValue({
      operation_id: "saved-operation",
      results: [
        {
          target_id: "physical-shared",
          path: deployment.target,
          deployment_id: deployment.id,
          success: true,
          status: "active",
          error: null,
        },
      ],
      warnings: [],
    });
    render(
      <SkillDeploymentDialog
        action={onAction.mock.calls[0][0]}
        workspaces={[]}
        onClose={vi.fn()}
        onChanged={vi.fn().mockResolvedValue([])}
      />,
    );
    const recover = screen.getByRole("button", { name: "Recover operation" });
    expect(recover.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(deployment.target)).toBeTruthy();
    expect(screen.getByText(/Shared location:.*Codex.*OpenCode/)).toBeTruthy();
    expect(screen.getByText(/previously interrupted operation/)).toBeTruthy();
    await user.click(screen.getByRole("checkbox", { name: /I approve these changes/ }));
    await user.click(recover);
    expect(await screen.findByText("1 of 1 locations completed.")).toBeTruthy();
    expect(mocks.applySkillDeployment).toHaveBeenCalledWith("saved-operation", true);
    expect(mocks.prepareSkillDeployment).not.toHaveBeenCalled();
  });

  it("retries a recovery-required result with the saved operation and fresh personal confirmation", async () => {
    mocks.prepareSkillDeployment.mockResolvedValue(preview);
    const result = {
      target_id: "physical-shared",
      path: deployment.target,
      deployment_id: deployment.id,
      success: false,
      status: "recovery-required",
      error: "Interrupted rename",
    };
    mocks.applySkillDeployment
      .mockResolvedValueOnce({ operation_id: "saved-operation", results: [result], warnings: [] })
      .mockResolvedValueOnce({
        operation_id: "saved-operation",
        results: [{ ...result, success: true, status: "active", error: null }],
        warnings: [],
      });
    mocks.skillDeployments.mockResolvedValueOnce([
      { ...deployment, operation_id: "saved-operation", status: "recovery-required" },
    ]);
    render(
      <SkillDeploymentDialog
        action={{ operation: "update", deployment }}
        workspaces={[]}
        onClose={vi.fn()}
        onChanged={vi.fn().mockResolvedValue([])}
      />,
    );
    const user = userEvent.setup();
    await screen.findByRole("button", { name: "Apply eligible locations" });
    await user.click(screen.getByRole("checkbox", { name: /I approve these changes/ }));
    await user.click(screen.getByRole("button", { name: "Apply eligible locations" }));
    await user.click(await screen.findByRole("button", { name: "Recover operation" }));
    expect(screen.getByRole("button", { name: "Recover operation" }).hasAttribute("disabled")).toBe(
      true,
    );
    await user.click(screen.getByRole("checkbox", { name: /I approve these changes/ }));
    await user.click(screen.getByRole("button", { name: "Recover operation" }));
    expect(await screen.findByText("1 of 1 locations completed.")).toBeTruthy();
    expect(mocks.applySkillDeployment).toHaveBeenNthCalledWith(2, "saved-operation", true);
    expect(mocks.prepareSkillDeployment).toHaveBeenCalledTimes(1);
  });

  it.each(["current", "inactive"])(
    "excludes a %s personal deployment from the project recovery opened through usage",
    async (status) => {
      const completed = { ...deployment, status };
      const interrupted = {
        ...deployment,
        id: "project-deployment",
        target: "/project/.agents/skills/reviewer",
        scope: "workspace" as const,
        scope_root: "/project",
        workspace_id: "project",
        status: "recovery-required",
      };
      const onAction = vi.fn();
      const usage = render(
        <SkillUsageList
          inventory={{ observations: [], warnings: [] }}
          deployments={[completed, interrupted]}
          installed={[]}
          workspaces={[]}
          loading={false}
          busy={false}
          onDetail={vi.fn()}
          onImport={vi.fn()}
          onAction={onAction}
          onOpen={vi.fn()}
        />,
      );
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Recover operation" }));
      expect(onAction.mock.calls[0][0].recoveryDeployments).toEqual([interrupted]);
      usage.unmount();
      mocks.applySkillDeployment.mockResolvedValue({
        operation_id: deployment.operation_id,
        results: [],
        warnings: [],
      });
      render(
        <SkillDeploymentDialog
          action={onAction.mock.calls[0][0]}
          workspaces={[]}
          onClose={vi.fn()}
          onChanged={vi.fn().mockResolvedValue([])}
        />,
      );
      expect(screen.queryByText(completed.target)).toBeNull();
      expect(screen.queryByRole("checkbox")).toBeNull();
      await user.click(screen.getByRole("button", { name: "Recover operation" }));
      expect(mocks.applySkillDeployment).toHaveBeenCalledWith(deployment.operation_id, false);
    },
  );

  it("drops the completed personal target before retrying a partially recovered mixed operation", async () => {
    const personal = { ...deployment, status: "recovery-required" };
    const project = {
      ...personal,
      id: "project-deployment",
      target: "/project/.agents/skills/reviewer",
      scope: "workspace" as const,
      scope_root: "/project",
      workspace_id: "project",
    };
    const personalResult = {
      target_id: "personal",
      deployment_id: personal.id,
      path: personal.target,
      success: true,
      status: "current",
      error: null,
    };
    const projectResult = {
      target_id: "project",
      deployment_id: project.id,
      path: project.target,
      success: false,
      status: "recovery-required",
      error: "Project is temporarily unavailable",
    };
    mocks.applySkillDeployment
      .mockResolvedValueOnce({
        operation_id: deployment.operation_id,
        results: [personalResult, projectResult],
        warnings: [],
      })
      .mockResolvedValueOnce({
        operation_id: deployment.operation_id,
        results: [
          personalResult,
          { ...projectResult, success: true, status: "current", error: null },
        ],
        warnings: [],
      });
    mocks.skillDeployments
      .mockResolvedValueOnce([{ ...personal, status: "current" }, project])
      .mockResolvedValueOnce([
        { ...personal, status: "current" },
        { ...project, status: "current" },
      ]);
    render(
      <SkillDeploymentDialog
        action={{
          operation: "recover",
          deployment: project,
          recoveryDeployments: [personal, project],
        }}
        workspaces={[]}
        onClose={vi.fn()}
        onChanged={vi.fn().mockResolvedValue([])}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", { name: /I approve these changes/ }));
    await user.click(screen.getByRole("button", { name: "Recover operation" }));
    await screen.findByText("1 of 2 locations completed.");
    await user.click(await screen.findByRole("button", { name: "Recover operation" }));
    expect(screen.queryByText(personal.target)).toBeNull();
    expect(screen.getByText(project.target)).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Recover operation" }));
    expect(await screen.findByText("2 of 2 locations completed.")).toBeTruthy();
    expect(mocks.applySkillDeployment).toHaveBeenNthCalledWith(1, deployment.operation_id, true);
    expect(mocks.applySkillDeployment).toHaveBeenNthCalledWith(2, deployment.operation_id, false);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Recover operation" })).toBeNull(),
    );
  });

  it("excludes a conflicting location when reviewing recovery from a real multi-target deploy flow", async () => {
    const selectedTargets = [target("claude-code"), target("cursor")];
    const targetPreviews = selectedTargets.map((item, index) => ({
      ...preview.targets[0],
      target_id: item.id,
      path: `${item.root}/reviewer`,
      agents: [item.agent],
      visible_to: [item.agent],
      added: [],
      conflicts: index === 0 ? ["External package already exists"] : [],
    }));
    mocks.skillTargets.mockResolvedValue(selectedTargets);
    mocks.prepareSkillDeployment.mockResolvedValue({ ...preview, targets: targetPreviews });
    mocks.applySkillDeployment.mockResolvedValue({
      operation_id: preview.token,
      results: targetPreviews.map((item, index) => ({
        target_id: item.target_id,
        path: item.path,
        deployment_id: index === 0 ? null : deployment.id,
        success: false,
        status: index === 0 ? "conflict" : "recovery-required",
        error: index === 0 ? "External package already exists" : "Interrupted rename",
      })),
      warnings: [],
    });
    mocks.skillDeployments.mockResolvedValue([
      {
        ...deployment,
        target: targetPreviews[1].path,
        operation_id: preview.token,
        status: "recovery-required",
      },
    ]);
    render(
      <SkillDeploymentDialog
        action={{ operation: "deploy", libraryId: "reviewer" }}
        workspaces={[]}
        onClose={vi.fn()}
        onChanged={vi.fn().mockResolvedValue([])}
      />,
    );
    const user = userEvent.setup();
    for (const item of selectedTargets) {
      await user.click(await screen.findByRole("checkbox", { name: new RegExp(item.root) }));
    }
    await user.click(screen.getByRole("button", { name: "Review deployment" }));
    await screen.findByText("External package already exists");
    expect(mocks.prepareSkillDeployment).toHaveBeenCalledWith({
      operation: "deploy",
      library_id: "reviewer",
      target_ids: selectedTargets.map((item) => item.id),
    });
    await user.click(screen.getByRole("checkbox", { name: /I approve these changes/ }));
    await user.click(screen.getByRole("button", { name: "Apply eligible locations" }));
    await user.click(await screen.findByRole("button", { name: "Recover operation" }));
    expect(screen.queryByText(targetPreviews[0].path)).toBeNull();
    expect(screen.getByText(targetPreviews[1].path)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Recover operation" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(screen.getByRole("checkbox", { name: /I approve these changes/ })).toBeTruthy();
  });

  it.each([false, true])(
    "keeps successful writes with pending reservation cleanup recoverable (lookup retry: %s)",
    async (retryLookup) => {
      mocks.prepareSkillDeployment.mockResolvedValue({ ...preview, operation: "update" });
      mocks.applySkillDeployment.mockResolvedValue({
        operation_id: preview.token,
        results: [
          {
            target_id: preview.targets[0].target_id,
            path: deployment.target,
            deployment_id: deployment.id,
            success: true,
            status: "current",
            error: "Native operation completed, but reservation cleanup is pending",
          },
        ],
        warnings: ["Reservation cleanup is pending"],
      });
      if (retryLookup)
        mocks.skillDeployments.mockRejectedValueOnce(new Error("Recovery list unavailable"));
      mocks.skillDeployments.mockResolvedValue([
        { ...deployment, operation_id: preview.token, status: "recovery-required" },
      ]);
      render(
        <SkillDeploymentDialog
          action={{ operation: "update", deployment }}
          workspaces={[]}
          onClose={vi.fn()}
          onChanged={vi.fn().mockResolvedValue([])}
        />,
      );
      const user = userEvent.setup();
      await user.click(await screen.findByRole("checkbox", { name: /I approve these changes/ }));
      await user.click(screen.getByRole("button", { name: "Apply eligible locations" }));
      expect(await screen.findByText("1 of 1 locations completed.")).toBeTruthy();
      if (retryLookup) {
        expect(
          await screen.findByText(/operation result was saved.*Recovery list unavailable/),
        ).toBeTruthy();
        await user.click(screen.getByRole("button", { name: "Review again" }));
      }
      await user.click(await screen.findByRole("button", { name: "Recover operation" }));
      expect(screen.getByText(deployment.target)).toBeTruthy();
      expect(
        screen.getByRole("button", { name: "Recover operation" }).hasAttribute("disabled"),
      ).toBe(true);
      expect(screen.getByRole("checkbox", { name: /I approve these changes/ })).toBeTruthy();
      expect(mocks.applySkillDeployment).toHaveBeenCalledTimes(1);
    },
  );

  it("offers all capability-reported agents, groups shared physical roots, and preserves read-only targets", async () => {
    mocks.skillTargets.mockResolvedValue([
      ...agents.map(target),
      { ...target("deepseek-harness"), writable: false, reason: "Read-only adapter" },
    ]);
    mocks.prepareSkillDeployment.mockResolvedValue(preview);
    render(
      <SkillDeploymentDialog
        action={{ operation: "deploy", libraryId: "reviewer" }}
        workspaces={[]}
        onClose={vi.fn()}
        onChanged={vi.fn().mockResolvedValue([])}
      />,
    );
    const shared = await screen.findByRole("checkbox", { name: /\/native\/shared\/skills/ });
    expect(screen.getAllByRole("checkbox")).toHaveLength(8);
    expect(
      screen
        .getByRole("checkbox", { name: /\/native\/deepseek-harness\/skills/ })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    expect(screen.getByText("Read-only adapter")).toBeTruthy();
    expect(screen.getByText(/Shared location:.*Codex.*OpenCode/)).toBeTruthy();
    const user = userEvent.setup();
    await user.click(shared);
    await user.click(screen.getByRole("button", { name: "Review deployment" }));
    await waitFor(() =>
      expect(mocks.prepareSkillDeployment).toHaveBeenCalledWith({
        operation: "deploy",
        library_id: "reviewer",
        target_ids: ["codex", "opencode"],
      }),
    );
    expect(await screen.findByText("New instructions")).toBeTruthy();
    expect(mocks.readSkillPreviewFile).toHaveBeenCalledWith(
      "immutable-preview",
      "SKILL.md",
      "physical-shared",
    );
    expect(
      screen.getByRole("button", { name: "Apply eligible locations" }).hasAttribute("disabled"),
    ).toBe(true);
  });
  it("previews and applies directory-only changes without requesting file contents", async () => {
    mocks.prepareSkillDeployment.mockResolvedValue({
      ...preview,
      operation: "update",
      requires_home_approval: false,
      targets: [
        {
          ...preview.targets[0],
          scope: "workspace",
          workspace_id: "project",
          added: ["output/", "output/nested/"],
          modified: [],
          removed: ["old/"],
        },
      ],
    });
    mocks.applySkillDeployment.mockResolvedValue({
      operation_id: "directory-update",
      results: [
        {
          target_id: "physical-shared",
          path: deployment.target,
          deployment_id: deployment.id,
          success: true,
          status: "active",
          error: null,
        },
      ],
      warnings: [],
    });
    render(
      <SkillDeploymentDialog
        action={{ operation: "update", deployment }}
        workspaces={[]}
        onClose={vi.fn()}
        onChanged={vi.fn().mockResolvedValue([])}
      />,
    );
    expect(await screen.findByText(/\+2 \/ ~0 \/ −1/)).toBeTruthy();
    expect(screen.getByTitle("output/nested/")).toBeTruthy();
    expect(screen.getByTitle("old/")).toBeTruthy();
    expect(screen.getByText(/Only directories are listed here/)).toBeTruthy();
    expect(mocks.readSkillPreviewFile).not.toHaveBeenCalled();
    const apply = screen.getByRole("button", { name: "Apply eligible locations" });
    expect(apply.hasAttribute("disabled")).toBe(false);
    await userEvent.setup().click(apply);
    await waitFor(() =>
      expect(mocks.applySkillDeployment).toHaveBeenCalledWith("immutable-preview", false),
    );
    expect(await screen.findByText("1 of 1 locations completed.")).toBeTruthy();
  });
  it("requires personal confirmation and preserves per-target success, failures and refresh warnings", async () => {
    mocks.prepareSkillDeployment.mockResolvedValue({
      ...preview,
      operation: "update",
      targets: [
        ...preview.targets,
        {
          ...preview.targets[0],
          target_id: "conflicting-location",
          path: "/native/conflict/reviewer",
          conflicts: ["External package already exists"],
        },
      ],
    });
    mocks.applySkillDeployment.mockResolvedValue({
      operation_id: "applied-operation",
      results: [
        {
          target_id: "physical-shared",
          path: deployment.target,
          deployment_id: "owned-1",
          success: true,
          status: "active",
          error: null,
        },
        {
          target_id: "conflicting-location",
          path: "/native/conflict/reviewer",
          deployment_id: null,
          success: false,
          status: "conflict",
          error: "External package already exists",
        },
      ],
      warnings: ["Discovery refresh failed"],
    });
    const onChanged = vi.fn().mockRejectedValue(new Error("View refresh failed"));
    render(
      <SkillDeploymentDialog
        action={{ operation: "update", deployment }}
        workspaces={[]}
        onClose={vi.fn()}
        onChanged={onChanged}
      />,
    );
    const apply = await screen.findByRole("button", { name: "Apply eligible locations" });
    expect(apply.hasAttribute("disabled")).toBe(true);
    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", { name: /I approve these changes/ }));
    await user.click(apply);
    expect(await screen.findByText("1 of 2 locations completed.")).toBeTruthy();
    expect(mocks.applySkillDeployment).toHaveBeenCalledWith("immutable-preview", true);
    expect(screen.getByText("External package already exists")).toBeTruthy();
    expect(screen.getByText("Discovery refresh failed")).toBeTruthy();
    expect(screen.getByText(/operation result was saved.*View refresh failed/)).toBeTruthy();
    expect(mocks.applySkillDeployment).toHaveBeenCalledTimes(1);
  });
  it("withdraws by deployment identity and explains remaining visibility without native deny controls", async () => {
    mocks.prepareSkillDeployment.mockResolvedValue({
      ...preview,
      operation: "undeploy",
      requires_home_approval: false,
      targets: [
        {
          ...preview.targets[0],
          scope: "workspace",
          conditions: ["Another native copy remains visible"],
        },
      ],
    });
    render(
      <SkillDeploymentDialog
        action={{ operation: "undeploy", deployment }}
        workspaces={[]}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    await screen.findByText("Another native copy remains visible");
    expect(mocks.prepareSkillDeployment).toHaveBeenCalledWith({
      operation: "undeploy",
      deployment_id: "owned-1",
    });
    expect(screen.getByText(/Other copies and shared locations/)).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(mocks.skillTargets).not.toHaveBeenCalled();
  });
  it("reports an expired content token without falling back to reading an installed package", async () => {
    mocks.prepareSkillDeployment.mockResolvedValue(preview);
    mocks.readSkillPreviewFile.mockRejectedValue(new Error("Preview token expired"));
    render(
      <SkillDeploymentDialog
        action={{ operation: "update", deployment }}
        workspaces={[]}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    expect(await screen.findByText(/Preview token expired/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review again" })).toBeTruthy();
    expect(mocks.readSkillDetailFile).not.toHaveBeenCalled();
  });
});

describe("Skill usage and details", () => {
  it.each([
    ["en-US", "Broken link"],
    ["zh-CN", "链接断开"],
    ["zh-TW", "連結失效"],
    ["ja-JP", "リンク切れ"],
  ] as const)("localizes the native broken-link status in %s", async (locale, label) => {
    await changeLocale(locale);
    render(
      <SkillUsageList
        inventory={{
          observations: [{ ...observation, status: "broken-link", resolved_path: null }],
          warnings: [],
        }}
        deployments={[]}
        installed={[]}
        workspaces={[]}
        loading={false}
        busy={false}
        onDetail={vi.fn()}
        onImport={vi.fn()}
        onAction={vi.fn()}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByText(new RegExp(label))).toBeTruthy();
    expect(screen.queryByText(/broken-link/)).toBeNull();
  });
  it("groups external entry paths by physical package while retaining each native scope", async () => {
    const root = {
      ...observation,
      id: "cc-root",
      path: "/cc-switch/skills/reviewer",
      resolved_path: null,
      kind: "directory",
      agents: [],
    };
    const alias = {
      ...observation,
      id: "codex-alias",
      path: "/project/.agents/skills/reviewer",
      scope: "workspace" as const,
      workspace_id: "project",
      agents: ["codex" as const],
    };
    const observations = [observation, root, alias];
    const groups = groupSkillObservations(observations);
    expect(groups).toHaveLength(1);
    expect(groups[0].observations.map((item) => item.id)).toEqual([
      "cc-observation",
      "cc-root",
      "codex-alias",
    ]);
    const onImport = vi.fn();
    render(
      <SkillUsageList
        inventory={{ observations, warnings: [] }}
        deployments={[]}
        installed={[]}
        workspaces={[]}
        loading={false}
        busy={false}
        onDetail={vi.fn()}
        onImport={onImport}
        onAction={vi.fn()}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getAllByRole("button", { name: "Copy to My Skills" })).toHaveLength(1);
    expect(screen.getByText(alias.path)).toBeTruthy();
    expect(screen.getByText(observation.path)).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "Copy to My Skills" }));
    expect(onImport).toHaveBeenCalledWith("cc-root");
  });
  it("keeps external aliases of a managed package visible, filterable and copyable", async () => {
    const managedObservation: SkillObservation = {
      ...observation,
      id: "managed-entry",
      path: deployment.target,
      resolved_path: deployment.target,
      agents: deployment.visible_to,
      kind: "directory",
      owner: "agentkib",
      library_id: deployment.library_id,
      diagnostics: [],
    };
    const alias = { ...observation, resolved_path: deployment.target };
    const onImport = vi.fn();
    const onDetail = vi.fn();
    render(
      <SkillUsageList
        inventory={{ observations: [managedObservation, alias], warnings: [] }}
        deployments={[deployment]}
        installed={[]}
        workspaces={[]}
        loading={false}
        busy={false}
        onDetail={onDetail}
        onImport={onImport}
        onAction={vi.fn()}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByText(alias.path)).toBeTruthy();
    expect(screen.getByText("Managed deployment")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Copy to My Skills" })).toHaveLength(1);
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "All Agents" }));
    await user.click(await screen.findByRole("option", { name: "Claude Code" }));
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(screen.getByText(alias.path)).toBeTruthy();
    expect(screen.queryByText("Managed deployment")).toBeNull();
    expect(screen.queryByText("No matching Skill locations.")).toBeNull();
    await user.click(screen.getByRole("button", { name: "View contents" }));
    expect(onDetail).toHaveBeenCalledWith({ observation_id: alias.id });
    await user.click(screen.getByRole("button", { name: "Copy to My Skills" }));
    expect(onImport).toHaveBeenCalledWith(alias.id);
  });
  it.each(["library", "external alias"])(
    "retains every native entry and its agents in %s details",
    async (entry) => {
      const managedObservation: SkillObservation = {
        ...observation,
        id: "managed-entry",
        path: deployment.target,
        resolved_path: deployment.target,
        agents: deployment.visible_to,
        kind: "directory",
        owner: "agentkib",
        library_id: deployment.library_id,
        diagnostics: [],
      };
      const alias = { ...observation, resolved_path: deployment.target };
      const library = entry === "library";
      mocks.skillDetail.mockResolvedValue({
        library_id: library ? deployment.library_id : null,
        observation_id: library ? null : alias.id,
        name: "reviewer",
        description: "Review",
        source: null,
        files: [],
        total_size: 0,
        diagnostics: [],
      });
      const onImport = vi.fn();
      render(
        <SkillDetailDialog
          request={library ? { library_id: deployment.library_id } : { observation_id: alias.id }}
          inventory={{ observations: [managedObservation, alias], warnings: [] }}
          deployments={[deployment]}
          onClose={vi.fn()}
          onDeploy={vi.fn()}
          onImport={onImport}
        />,
      );
      expect(await screen.findByText(alias.path)).toBeTruthy();
      expect(screen.getByText(/Personal · Claude Code · Native visibility:/)).toBeTruthy();
      expect(screen.getByText(/Personal · Codex · OpenCode · Native visibility:/)).toBeTruthy();
      if (!library) {
        await userEvent.setup().click(screen.getByRole("button", { name: "Copy to My Skills" }));
        expect(onImport).toHaveBeenCalledWith(alias.id);
      }
    },
  );
  it("separates deployed state from native restrictions and opens actual deployed content", async () => {
    const observed = {
      ...observation,
      id: "deployed-observation",
      path: deployment.target,
      resolved_path: deployment.target,
      owner: "agentkib",
      library_id: deployment.library_id,
      status: "native-restricted",
      diagnostics: ["Disabled by native policy"],
    };
    const onDetail = vi.fn();
    render(
      <SkillUsageList
        inventory={{ observations: [observed], warnings: [] }}
        deployments={[deployment]}
        installed={[
          {
            name: deployment.library_id,
            display_name: deployment.package_name,
            path: "/library/reviewer",
            description: "Updated library package",
            size: 10,
            status: "current",
            can_rollback: false,
            content_sha256: "new-library-hash",
          },
        ]}
        workspaces={[]}
        loading={false}
        busy={false}
        onDetail={onDetail}
        onImport={vi.fn()}
        onAction={vi.fn()}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByText("Deployed")).toBeTruthy();
    expect(screen.getByText("Different from library version")).toBeTruthy();
    expect(screen.getByText("Restricted by native settings")).toBeTruthy();
    expect(screen.getByText("Disabled by native policy")).toBeTruthy();
    expect(screen.getByText(/does not confirm a running Agent/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy to My Skills" })).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "View contents" }));
    expect(onDetail).toHaveBeenCalledWith({ observation_id: "deployed-observation" });
  });
  it.each([false, undefined])(
    "does not associate a same-named library package with an unverified source (%s)",
    async (sourceIsCurrentLibrary) => {
      const onAction = vi.fn();
      render(
        <SkillUsageList
          inventory={{ observations: [], warnings: [] }}
          deployments={[
            {
              ...deployment,
              source_is_current_library: sourceIsCurrentLibrary,
              library_root: "/other-library",
              status: "current",
            },
          ]}
          installed={[
            {
              name: "reviewer",
              display_name: "reviewer",
              path: "/library/skills/reviewer",
              description: "Unrelated package",
              size: 10,
              status: "current",
              can_rollback: false,
              content_sha256: "different",
            },
          ]}
          workspaces={[]}
          loading={false}
          busy={false}
          onDetail={vi.fn()}
          onImport={vi.fn()}
          onAction={onAction}
          onOpen={vi.fn()}
        />,
      );
      expect(screen.queryByText("Different from library version")).toBeNull();
      expect(
        screen.getByRole("button", { name: "Sync library version" }).hasAttribute("disabled"),
      ).toBe(true);
      expect(screen.getByRole("button", { name: "View contents" }).hasAttribute("disabled")).toBe(
        true,
      );
      expect(screen.getByText(/Update this deployment from its original library/)).toBeTruthy();
      await userEvent.setup().click(screen.getByRole("button", { name: "Withdraw deployment" }));
      expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ operation: "undeploy" }));
    },
  );

  it("keeps withdrawn history out of active usage and offers redeployment", async () => {
    render(
      <SkillUsageList
        inventory={{ observations: [], warnings: [] }}
        deployments={[{ ...deployment, status: "inactive" }]}
        installed={[]}
        workspaces={[]}
        loading={false}
        busy={false}
        onDetail={vi.fn()}
        onImport={vi.fn()}
        onAction={vi.fn()}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.queryByText("reviewer")).toBeNull();
    await userEvent
      .setup()
      .click(screen.getByRole("checkbox", { name: "Show withdrawn deployments" }));
    expect(screen.getByText("Withdrawn")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deploy to…" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Withdraw deployment" })).toBeNull();
  });
  it.each(["before", "after"] as const)(
    "retains the readable %s snapshot when the detail RPC returns a null binary side",
    async (textSide) => {
      mocks.skillDetail.mockResolvedValue({
        library_id: "reviewer",
        observation_id: null,
        name: "reviewer",
        description: "Review",
        source: null,
        files: [{ path: "guide.md", size: 20, executable: false, binary: true, sha256: "next" }],
        total_size: 20,
        diagnostics: [],
      });
      mocks.readSkillDetailFile.mockResolvedValue({
        path: "guide.md",
        before: textSide === "before" ? "# Previous readable instructions" : null,
        after: textSide === "after" ? "# Next readable instructions" : null,
        before_size: 20,
        after_size: 20,
        before_sha256: "previous",
        after_sha256: "next",
        binary: true,
        truncated: false,
      });
      render(
        <SkillDetailDialog
          request={{ library_id: "reviewer" }}
          onClose={vi.fn()}
          onDeploy={vi.fn()}
          onImport={vi.fn()}
        />,
      );
      const readableSide = textSide === "before" ? "Previous" : "Next";
      expect(
        await screen.findByRole("heading", { name: `${readableSide} readable instructions` }),
      ).toBeTruthy();
      await userEvent.setup().click(screen.getByRole("tab", { name: "Changes" }));
      const binarySide = screen.getByRole("region", {
        name: textSide === "before" ? "Next" : "Previous",
      });
      expect(within(binarySide).getByText("Binary version")).toBeTruthy();
      expect(binarySide.querySelector("pre")).toBeNull();
      expect(screen.getByText(`# ${readableSide} readable instructions`)).toBeTruthy();
      expect(screen.queryByText(/^[+−] # /)).toBeNull();
    },
  );
  it("shows current and previous empty directories while reading only file entries", async () => {
    mocks.skillDetail.mockResolvedValue({
      library_id: "reviewer",
      observation_id: null,
      name: "reviewer",
      description: "Review",
      source: null,
      files: ["output/", "output/nested/", "SKILL.md"].map((path) => ({
        path,
        size: path.endsWith("/") ? 0 : 20,
        executable: false,
        binary: false,
        sha256: path.endsWith("/") ? "" : "current",
      })),
      previous_files: [{ path: "old/", size: 0, executable: false, binary: false, sha256: "" }],
      total_size: 20,
      diagnostics: [],
    });
    mocks.readSkillDetailFile.mockResolvedValue({
      path: "SKILL.md",
      before: null,
      after: "Current instructions",
      binary: false,
      truncated: false,
    });
    render(
      <SkillDetailDialog
        request={{ library_id: "reviewer" }}
        onClose={vi.fn()}
        onDeploy={vi.fn()}
        onImport={vi.fn()}
      />,
    );
    expect(await screen.findByText("Current instructions")).toBeTruthy();
    expect(screen.getByText("1 Files")).toBeTruthy();
    expect(screen.getByText("2 Directories")).toBeTruthy();
    expect(screen.getByTitle("output/nested/")).toBeTruthy();
    expect(screen.getByTitle("old/")).toBeTruthy();
    expect(mocks.readSkillDetailFile.mock.calls).toEqual([
      [{ library_id: "reviewer", path: "SKILL.md" }],
    ]);
  });
  it("keeps deleted files available when comparing the prior library version", async () => {
    mocks.skillDetail.mockResolvedValue({
      library_id: "reviewer",
      observation_id: null,
      name: "reviewer",
      description: "Review",
      source: null,
      files: [],
      previous_files: [
        {
          path: "references/removed.md",
          size: 7,
          executable: false,
          binary: false,
          sha256: "previous",
        },
      ],
      total_size: 0,
      diagnostics: [],
    });
    mocks.readSkillDetailFile.mockResolvedValue({
      path: "references/removed.md",
      before: "Legacy instructions",
      after: null,
      binary: false,
      truncated: false,
    });
    render(
      <SkillDetailDialog
        request={{ library_id: "reviewer" }}
        onClose={vi.fn()}
        onDeploy={vi.fn()}
        onImport={vi.fn()}
      />,
    );
    await screen.findByRole("button", { name: "removed.md" });
    await userEvent.setup().click(await screen.findByRole("tab", { name: "Changes" }));
    expect(screen.getByText(/Legacy instructions/)).toBeTruthy();
    expect(mocks.readSkillDetailFile).toHaveBeenCalledWith({
      library_id: "reviewer",
      path: "references/removed.md",
    });
  });
  it("keeps CC Switch installations read-only and passes only their observation identity to copy", async () => {
    const onImport = vi.fn();
    render(
      <SkillUsageList
        inventory={{ observations: [observation], warnings: [] }}
        deployments={[]}
        installed={[]}
        workspaces={[]}
        loading={false}
        busy={false}
        onDetail={vi.fn()}
        onImport={onImport}
        onAction={vi.fn()}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByText("cc-switch")).toBeTruthy();
    expect(screen.getByText(/does not take ownership/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Withdraw deployment" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sync library version" })).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "Copy to My Skills" }));
    expect(onImport).toHaveBeenCalledWith("cc-observation");
  });
  it("preserves local source attribution and loads safe content by detail identity", async () => {
    mocks.skillDetail.mockResolvedValue({
      library_id: "reviewer",
      observation_id: null,
      name: "reviewer",
      description: "Review changes",
      source: null,
      local_source: observation.path,
      local_resolved_path: observation.resolved_path,
      files: [{ path: "SKILL.md", size: 20, executable: false, binary: false, sha256: "hash" }],
      total_size: 20,
      diagnostics: [],
    });
    mocks.readSkillDetailFile.mockResolvedValue({
      path: "SKILL.md",
      before: null,
      after: "# Review changes safely",
      binary: false,
      truncated: false,
    });
    render(
      <SkillDetailDialog
        request={{ library_id: "reviewer" }}
        onClose={vi.fn()}
        onDeploy={vi.fn()}
        onImport={vi.fn()}
      />,
    );
    expect(await screen.findByRole("heading", { name: "Review changes safely" })).toBeTruthy();
    expect(screen.getByText(observation.path)).toBeTruthy();
    expect(screen.getByText(`→ ${observation.resolved_path}`)).toBeTruthy();
    expect(mocks.readSkillDetailFile).toHaveBeenCalledWith({
      library_id: "reviewer",
      path: "SKILL.md",
    });
  });
});
