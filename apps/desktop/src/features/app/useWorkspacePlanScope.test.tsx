// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n, tr } from "@/core/i18n";
import type {
  ChangeSet,
  Manifest,
  WorkspaceSummary,
  SessionHandoffLaunchRequest,
} from "@/core/types";
import { useWorkspaceStore, type ChangeSetOrigin } from "@/features/workspace/workspace-store";
import { useWorkspaceTransitions } from "./useWorkspaceTransitions";

const dialogs = vi.hoisted(() => ({ notify: vi.fn(), confirm: vi.fn() }));
vi.mock("@/components/AppDialogProvider", () => ({ useAppDialogs: () => dialogs }));
const workspace: WorkspaceSummary = {
  id: "one",
  name: "First",
  path: "/first",
  status: "healthy",
  asset_count: 0,
  warning_count: 0,
  sources: [],
};
const other = { ...workspace, id: "two", name: "Second", path: "/second" };
const manifest = (shared: string): Manifest => ({
  schema_version: 2,
  workspace: { id: workspace.id, name: workspace.name },
  instructions: { shared, scoped: [], platform_overrides: {} },
  skills: [],
  connections: [],
  adapters: {},
  mcp: { config: "mcp.json" },
  memories: { require_approval: true },
});
const draft = manifest("Unapplied draft");
const baseline = JSON.stringify(manifest("Saved on disk"));
const plan: ChangeSet = {
  id: "reviewed-first-workspace",
  project_root: workspace.path,
  created_at: "2026-10-16T00:00:00Z",
  requires_home_approval: false,
  changes: [
    {
      target: "/first/AGENTS.md",
      scope: "project",
      before: "saved",
      after: "planned",
      risk: "low",
      validator: "markdown",
    },
  ],
};
const launch: SessionHandoffLaunchRequest = {
  mode: "native-import",
  operation_id: "operation",
  workspace_id: workspace.id,
  target_agent: "codex",
  plan_hash: "reviewed-hash",
};
const origins: ChangeSetOrigin[] = ["standard", "doctor", "handoff", "handoff-setup"];
function setup(origin: ChangeSetOrigin) {
  useWorkspaceStore.setState({
    selectedWorkspace: workspace,
    project: workspace.path,
    manifest: draft,
    baselineManifest: baseline,
    changeSet: plan,
    changeSetManifest: JSON.stringify(draft),
    changeSetOrigin: origin,
    handoffLaunchRequest: origin.startsWith("handoff") ? launch : undefined,
    workspaceDrafts: { [other.id]: manifest("Other draft") },
    message: "Previous notice",
  });
  const navigate = vi.fn();
  const invalidate = vi.fn();
  const hook = renderHook(() =>
    useWorkspaceTransitions({
      route: { kind: "workspace", workspaceId: workspace.id, page: "changes" },
      navigateWorkspacePageFor: navigate,
      clearGitSubview: vi.fn(),
      invalidatePendingLoad: invalidate,
    }),
  );
  return { ...hook, navigate, invalidate };
}
beforeEach(async () => {
  await initializeI18n("en-US");
  useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true);
  dialogs.notify.mockReset().mockResolvedValue(undefined);
  dialogs.confirm.mockReset().mockResolvedValue(false);
});
afterEach(cleanup);

describe("workspace-scoped review plans", () => {
  it.each(origins)(
    "invalidates a %s plan on workspace change while caching the editor draft",
    async (origin) => {
      const { result, navigate, invalidate } = setup(origin);
      const otherDraft = useWorkspaceStore.getState().workspaceDrafts[other.id];
      await act(async () => {
        expect(await result.current.openWorkspace(other)).toBe(true);
      });
      const state = useWorkspaceStore.getState();
      expect(state.selectedWorkspace).toBe(other);
      expect(state.project).toBe(other.path);
      expect(state.changeSet).toBeUndefined();
      expect(state.changeSetManifest).toBeUndefined();
      expect(state.changeSetOrigin).toBe("standard");
      expect(state.handoffLaunchRequest).toBeUndefined();
      expect(state.manifest).toBeUndefined();
      expect(state.baselineManifest).toBe("");
      expect(state.workspaceDrafts[workspace.id]).toBe(draft);
      expect(state.workspaceDrafts[other.id]).toBe(otherDraft);
      expect(invalidate).toHaveBeenCalledOnce();
      expect(navigate).toHaveBeenCalledExactlyOnceWith(other.id, "overview", undefined);
      expect(dialogs.confirm).not.toHaveBeenCalled();
    },
  );

  it.each(origins)(
    "keeps a %s review when navigating within the same workspace",
    async (origin) => {
      const { result, navigate, invalidate } = setup(origin);
      const before = useWorkspaceStore.getState();
      await act(async () => {
        expect(await result.current.openWorkspace(workspace, "assets")).toBe(true);
      });
      const state = useWorkspaceStore.getState();
      expect(state.changeSet).toBe(plan);
      expect(state.changeSetManifest).toBe(before.changeSetManifest);
      expect(state.changeSetOrigin).toBe(origin);
      expect(state.handoffLaunchRequest).toBe(before.handoffLaunchRequest);
      expect(state.manifest).toBe(draft);
      expect(state.workspaceDrafts).toBe(before.workspaceDrafts);
      expect(invalidate).not.toHaveBeenCalled();
      expect(navigate).toHaveBeenCalledExactlyOnceWith(workspace.id, "assets", undefined);
    },
  );

  it.each(origins)(
    "blocks a workspace switch if a %s apply starts while the guard yields",
    async (origin) => {
      const { result, navigate, invalidate } = setup(origin);
      const before = useWorkspaceStore.getState();
      await act(async () => {
        const switching = result.current.openWorkspace(other);
        useWorkspaceStore.getState().setApplyingChanges(true);
        expect(await switching).toBe(false);
      });
      const state = useWorkspaceStore.getState();
      expect(state.selectedWorkspace).toBe(workspace);
      expect(state.project).toBe(workspace.path);
      expect(state.changeSet).toBe(plan);
      expect(state.changeSetManifest).toBe(before.changeSetManifest);
      expect(state.changeSetOrigin).toBe(origin);
      expect(state.handoffLaunchRequest).toBe(before.handoffLaunchRequest);
      expect(state.manifest).toBe(draft);
      expect(state.workspaceDrafts).toBe(before.workspaceDrafts);
      expect(state.applyingChanges).toBe(true);
      expect(invalidate).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
      expect(dialogs.notify).toHaveBeenCalledExactlyOnceWith(tr("workspace.changesApplying"));
    },
  );
});
