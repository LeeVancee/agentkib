import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ChangeSet,
  Manifest,
  SessionHandoffLaunchRequest,
  WorkspaceSummary,
} from "@/core/types";
import { type ChangeSetOrigin, useWorkspaceStore } from "./workspace-store";
import { draftSectionCount } from "./manifest-draft";

const workspace: WorkspaceSummary = {
  id: "workspace-1",
  path: "/workspace-1",
  name: "First workspace",
  status: "healthy",
  asset_count: 0,
  warning_count: 0,
  sources: [],
};
const plan: ChangeSet = {
  id: "plan-1",
  project_root: workspace.path,
  created_at: "2026-10-16T00:00:00Z",
  changes: [],
  requires_home_approval: false,
};
const launchRequest: SessionHandoffLaunchRequest = {
  mode: "native-import",
  operation_id: "operation-1",
  workspace_id: workspace.id,
  target_agent: "codex",
  plan_hash: "plan-hash",
};
const manifest = (shared: string): Manifest => ({
  schema_version: 1,
  workspace: { id: workspace.id, name: workspace.name },
  instructions: { shared, scoped: [], platform_overrides: {} },
  skills: [],
  mcp: { config: "" },
  connections: [],
  memories: { require_approval: true },
  adapters: {},
});

function resetStore() {
  useWorkspaceStore.getState().resetWorkspace();
  useWorkspaceStore.getState().setWorkspaceDrafts({});
}

describe("transient workspace notices", () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  it("dismisses only the presentation and preserves the active workspace operation", () => {
    const draft = manifest("keep this draft");
    useWorkspaceStore.setState({ manifest: draft, applyingChanges: true });
    useWorkspaceStore.getState().setMessage("write failed");
    const { messageRevision } = useWorkspaceStore.getState();
    useWorkspaceStore.getState().dismissMessage(messageRevision);
    expect(useWorkspaceStore.getState()).toMatchObject({
      message: "write failed",
      messageDismissed: true,
      manifest: draft,
      applyingChanges: true,
    });
  });

  it.each(["same failure", "new failure"])("preserves a newer notice with text %s", (next) => {
    useWorkspaceStore.getState().setMessage("same failure");
    const old = useWorkspaceStore.getState().messageRevision;
    useWorkspaceStore.getState().dismissMessage(old);
    useWorkspaceStore.getState().setMessage(next);
    useWorkspaceStore.getState().dismissMessage(old);
    expect(useWorkspaceStore.getState()).toMatchObject({ message: next, messageDismissed: false });
    expect(useWorkspaceStore.getState().messageRevision).toBeGreaterThan(old);
  });

  it("does not reopen a dismissed error when another source conditionally leaves it unchanged", () => {
    useWorkspaceStore.getState().setMessage("workspace error");
    const before = useWorkspaceStore.getState().messageRevision;
    useWorkspaceStore.getState().dismissMessage(before);
    useWorkspaceStore
      .getState()
      .setMessage((current) => (current === "runtime error" ? "" : current));
    expect(useWorkspaceStore.getState()).toMatchObject({
      message: "workspace error",
      messageRevision: before,
      messageDismissed: true,
    });
  });

  it("invalidates old dismiss callbacks when the workspace is reset", () => {
    useWorkspaceStore.getState().setMessage("old");
    const old = useWorkspaceStore.getState().messageRevision;
    useWorkspaceStore.getState().resetWorkspace();
    useWorkspaceStore.getState().setMessage("new");
    useWorkspaceStore.getState().dismissMessage(old);
    expect(useWorkspaceStore.getState()).toMatchObject({ message: "new", messageDismissed: false });
  });
});

describe("workspace change plans and drafts", () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  it.each([
    ["doctor", true],
    ["doctor", false],
    ["handoff", true],
    ["handoff", false],
    ["handoff-setup", true],
    ["handoff-setup", false],
  ] satisfies Array<[ChangeSetOrigin, boolean]>)(
    "preserves the dirty draft after a %s plan with a recorded input of %s",
    (origin, recordInput) => {
      const baseline = manifest("saved instructions");
      const draft = manifest("unsaved editor instructions");
      const applied = manifest("instructions reloaded after applying the plan");
      const otherDraft = manifest("another workspace's unsaved instructions");
      useWorkspaceStore.setState({
        selectedWorkspace: workspace,
        manifest: draft,
        baselineManifest: JSON.stringify(baseline),
        workspaceDrafts: { [workspace.id]: manifest("older draft"), other: otherDraft },
        changeSetOrigin: origin,
      });
      useWorkspaceStore.getState().setChangeSet(plan, recordInput ? baseline : undefined);

      useWorkspaceStore
        .getState()
        .acceptAppliedManifest(
          applied,
          useWorkspaceStore.getState().changeSetManifest,
          JSON.stringify(draft),
        );

      const state = useWorkspaceStore.getState();
      expect(state.manifest).toBe(draft);
      expect(state.baselineManifest).toBe(JSON.stringify(applied));
      expect(state.workspaceDrafts).toEqual({ [workspace.id]: draft, other: otherDraft });
      expect(state.workspaceDrafts.other).toBe(otherDraft);
    },
  );

  it("consumes an applied standard draft and removes only its workspace's cached draft", () => {
    const baseline = manifest("saved instructions");
    const draft = manifest("planned editor instructions");
    const applied = manifest("planned editor instructions");
    const otherDraft = manifest("another workspace's unsaved instructions");
    useWorkspaceStore.setState({
      selectedWorkspace: workspace,
      manifest: draft,
      baselineManifest: JSON.stringify(baseline),
      workspaceDrafts: { [workspace.id]: manifest("older cached draft"), other: otherDraft },
    });
    useWorkspaceStore.getState().setChangeSet(plan, draft);

    useWorkspaceStore
      .getState()
      .acceptAppliedManifest(
        applied,
        useWorkspaceStore.getState().changeSetManifest,
        JSON.stringify(draft),
      );

    const state = useWorkspaceStore.getState();
    expect(state.manifest).toBe(applied);
    expect(state.baselineManifest).toBe(JSON.stringify(applied));
    expect(state.workspaceDrafts).toEqual({ other: otherDraft });
    expect(state.workspaceDrafts.other).toBe(otherDraft);
  });

  it("keeps edits made while an applied plan is reloading its manifest", () => {
    const baseline = manifest("saved instructions");
    const planned = manifest("planned editor instructions");
    const editedDuringReload = manifest("newer instructions typed during reload");
    useWorkspaceStore.setState({
      selectedWorkspace: workspace,
      manifest: planned,
      baselineManifest: JSON.stringify(baseline),
    });
    useWorkspaceStore.getState().setChangeSet(plan, planned);
    const appliedInput = useWorkspaceStore.getState().changeSetManifest;

    useWorkspaceStore.getState().setManifest(editedDuringReload);
    useWorkspaceStore
      .getState()
      .acceptAppliedManifest(
        manifest("planned editor instructions"),
        appliedInput,
        JSON.stringify(planned),
      );

    const state = useWorkspaceStore.getState();
    expect(state.manifest).toBe(editedDuringReload);
    expect(state.baselineManifest).toBe(JSON.stringify(planned));
    expect(state.workspaceDrafts[workspace.id]).toBe(editedDuringReload);
    expect(state.changeSet).toBeUndefined();
  });

  it.each(["standard", "doctor"] as const)(
    "preserves a revert to the old baseline while a %s plan is applying",
    (origin) => {
      const baseline = manifest("saved instructions");
      const draft = manifest("unsaved editor instructions");
      const plannedInput = origin === "standard" ? draft : baseline;
      const applied = origin === "standard" ? draft : manifest("repaired instructions");
      useWorkspaceStore.setState({
        selectedWorkspace: workspace,
        manifest: draft,
        baselineManifest: JSON.stringify(baseline),
        changeSetOrigin: origin,
      });
      useWorkspaceStore.getState().setChangeSet(plan, plannedInput);
      const appliedInput = useWorkspaceStore.getState().changeSetManifest;
      const draftAtApply = JSON.stringify(draft);

      useWorkspaceStore.getState().setManifest(baseline);
      useWorkspaceStore.getState().acceptAppliedManifest(applied, appliedInput, draftAtApply);

      const state = useWorkspaceStore.getState();
      expect(state.manifest).toBe(baseline);
      expect(state.baselineManifest).toBe(JSON.stringify(applied));
      expect(state.workspaceDrafts[workspace.id]).toBe(baseline);
    },
  );

  it("accepts a changed disk manifest when the editor has no unsaved changes", () => {
    const baseline = manifest("saved instructions");
    const applied = manifest("repaired instructions");
    useWorkspaceStore.setState({
      selectedWorkspace: workspace,
      manifest: baseline,
      baselineManifest: JSON.stringify(baseline),
      workspaceDrafts: { [workspace.id]: manifest("stale draft") },
    });

    useWorkspaceStore.getState().acceptAppliedManifest(applied);

    const state = useWorkspaceStore.getState();
    expect(state.manifest).toBe(applied);
    expect(state.baselineManifest).toBe(JSON.stringify(applied));
    expect(state.workspaceDrafts).toEqual({});
  });

  it.each(["value", "updater"] as const)(
    "invalidates a plan and its launch request when the draft changes through a %s",
    (updateKind) => {
      const draft = manifest("planned instructions");
      const nextDraft = manifest("newer instructions");
      useWorkspaceStore.getState().setManifest(draft);
      useWorkspaceStore.getState().setChangeSet(plan, draft);
      useWorkspaceStore.getState().setHandoffLaunchRequest(launchRequest);

      useWorkspaceStore
        .getState()
        .setManifest(updateKind === "value" ? nextDraft : () => nextDraft);

      const state = useWorkspaceStore.getState();
      expect(state.manifest).toBe(nextDraft);
      expect(state.changeSet).toBeUndefined();
      expect(state.changeSetManifest).toBeUndefined();
      expect(state.handoffLaunchRequest).toBeUndefined();
    },
  );

  it("retains the plan and launch request when a new manifest object has identical contents", () => {
    const draft = manifest("planned instructions");
    useWorkspaceStore.getState().setManifest(draft);
    useWorkspaceStore.getState().setChangeSet(plan, draft);
    useWorkspaceStore.getState().setHandoffLaunchRequest(launchRequest);
    const equivalent = { ...draft, instructions: { ...draft.instructions } };

    useWorkspaceStore.getState().setManifest(() => equivalent);

    const state = useWorkspaceStore.getState();
    expect(state.manifest).toBe(equivalent);
    expect(state.changeSet).toBe(plan);
    expect(state.changeSetManifest).toBe(JSON.stringify(draft));
    expect(state.handoffLaunchRequest).toBe(launchRequest);
  });

  it("retains an unresolved native import recovery request without a pending plan", () => {
    useWorkspaceStore.getState().setManifest(manifest("saved instructions"));
    useWorkspaceStore.getState().setHandoffLaunchRequest(launchRequest);

    useWorkspaceStore.getState().setManifest(manifest("new editor instructions"));

    const state = useWorkspaceStore.getState();
    expect(state.changeSet).toBeUndefined();
    expect(state.handoffLaunchRequest).toBe(launchRequest);
  });

  it("snapshots the actual planning input even when it differs from the editor draft", () => {
    const draft = manifest("unsaved editor instructions");
    const actualInput = manifest("saved instructions used by Doctor");
    const actualSnapshot = JSON.stringify(actualInput);
    useWorkspaceStore.getState().setManifest(draft);

    useWorkspaceStore.getState().setChangeSet(plan, actualInput);
    actualInput.instructions.shared = "later mutation of the planning input";

    const state = useWorkspaceStore.getState();
    expect(state.manifest).toBe(draft);
    expect(state.changeSet).toBe(plan);
    expect(state.changeSetManifest).toBe(actualSnapshot);
    expect(state.changeSetManifest).not.toBe(JSON.stringify(draft));
  });

  it("does not assign the editor draft as an input for a plan without a recorded manifest", () => {
    const draft = manifest("unsaved editor instructions");
    useWorkspaceStore.getState().setManifest(draft);
    useWorkspaceStore.getState().setChangeSet(plan, draft);

    useWorkspaceStore.getState().setChangeSet({ ...plan, id: "plan-without-input" });

    expect(useWorkspaceStore.getState().changeSetManifest).toBeUndefined();
  });

  it("discards the reviewed draft, stale plan and only its workspace's cache atomically", () => {
    const baseline = manifest("saved instructions");
    const draft = manifest("unsaved edit");
    const otherDraft = manifest("other workspace");
    useWorkspaceStore.setState({
      selectedWorkspace: workspace,
      manifest: draft,
      baselineManifest: JSON.stringify(baseline),
      workspaceDrafts: { [workspace.id]: draft, other: otherDraft },
    });
    useWorkspaceStore.getState().setChangeSet(plan, draft);
    useWorkspaceStore.getState().setHandoffLaunchRequest(launchRequest);

    expect(useWorkspaceStore.getState().discardWorkspaceDraft(JSON.stringify(draft))).toBe(true);

    const state = useWorkspaceStore.getState();
    expect(state.manifest).toEqual(baseline);
    expect(state.workspaceDrafts).toEqual({ other: otherDraft });
    expect(state.changeSet).toBeUndefined();
    expect(state.changeSetManifest).toBeUndefined();
    expect(state.handoffLaunchRequest).toBeUndefined();
  });

  it("does not discard newer edits or mutate drafts while applying", () => {
    const baseline = manifest("saved");
    const draft = manifest("confirmed draft");
    const newer = manifest("newer draft");
    useWorkspaceStore.setState({
      selectedWorkspace: workspace,
      manifest: newer,
      baselineManifest: JSON.stringify(baseline),
    });
    expect(useWorkspaceStore.getState().discardWorkspaceDraft(JSON.stringify(draft))).toBe(false);
    expect(useWorkspaceStore.getState().manifest).toBe(newer);
    useWorkspaceStore.getState().setApplyingChanges(true);
    expect(useWorkspaceStore.getState().discardWorkspaceDraft(JSON.stringify(newer))).toBe(false);
    expect(useWorkspaceStore.getState().manifest).toBe(newer);
  });

  it("retains an unknown import recovery request when discarding an unrelated draft", () => {
    const baseline = manifest("saved");
    const draft = manifest("editor draft");
    useWorkspaceStore.setState({
      selectedWorkspace: workspace,
      manifest: draft,
      baselineManifest: JSON.stringify(baseline),
      handoffLaunchRequest: launchRequest,
    });
    expect(useWorkspaceStore.getState().discardWorkspaceDraft(JSON.stringify(draft))).toBe(true);
    expect(useWorkspaceStore.getState().handoffLaunchRequest).toBe(launchRequest);
  });

  it.each(["invalid JSON", "null", "{}"])(
    "does not replace a draft with an invalid baseline: %s",
    (baseline) => {
      const draft = manifest("unsaved");
      useWorkspaceStore.setState({
        selectedWorkspace: workspace,
        manifest: draft,
        baselineManifest: baseline,
      });
      expect(useWorkspaceStore.getState().discardWorkspaceDraft(JSON.stringify(draft))).toBe(false);
      expect(useWorkspaceStore.getState().manifest).toBe(draft);
    },
  );

  it("counts changed draft sections rather than implying a count of files", () => {
    const baseline = manifest("saved");
    const draft = {
      ...manifest("edit"),
      skills: [{ name: "new skill", path: "skills/new", targets: [] }],
    };
    expect(draftSectionCount(draft, JSON.stringify(baseline))).toBe(2);
    expect(draftSectionCount(baseline, JSON.stringify(baseline))).toBe(0);
  });
});
