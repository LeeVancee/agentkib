import { create } from "zustand";
import type {
  ChangeSet,
  Manifest,
  SessionHandoffLaunchRequest,
  WorkspaceScan,
  WorkspaceSummary,
} from "@/core/types";

export type ChangeSetOrigin = "standard" | "doctor" | "handoff" | "handoff-setup";
export interface AppliedWorkspaceChanges {
  workspaceId: string;
  project: string;
  changeSet: ChangeSet;
  applied: string[];
  backupDir: string;
  origin?: ChangeSetOrigin;
}
type Updater<T> = T | ((current: T) => T);

interface WorkspaceState {
  project: string;
  selectedWorkspace?: WorkspaceSummary;
  scan?: WorkspaceScan;
  manifest?: Manifest;
  changeSet?: ChangeSet;
  changeSetManifest?: string;
  changeSetIncludesHome: boolean;
  changeSetOrigin: ChangeSetOrigin;
  handoffLaunchRequest?: SessionHandoffLaunchRequest;
  baselineManifest: string;
  workspaceDrafts: Record<string, Manifest>;
  busy: boolean;
  message: string;
  messageRevision: number;
  messageDismissed: boolean;
  applyingChanges: boolean;
  appliedChanges?: AppliedWorkspaceChanges;
}

interface WorkspaceActions {
  setProject: (value: Updater<string>) => void;
  setSelectedWorkspace: (value: Updater<WorkspaceSummary | undefined>) => void;
  setScan: (value: Updater<WorkspaceScan | undefined>) => void;
  setManifest: (value: Updater<Manifest | undefined>) => void;
  setChangeSet: (
    value: Updater<ChangeSet | undefined>,
    plannedManifest?: Manifest,
    includesHome?: boolean,
  ) => void;
  acceptAppliedManifest: (
    manifest: Manifest,
    plannedManifest?: string,
    draftAtApply?: string,
  ) => void;
  setChangeSetOrigin: (value: Updater<ChangeSetOrigin>) => void;
  setHandoffLaunchRequest: (value: Updater<SessionHandoffLaunchRequest | undefined>) => void;
  setBaselineManifest: (value: Updater<string>) => void;
  setWorkspaceDrafts: (value: Updater<Record<string, Manifest>>) => void;
  setBusy: (value: Updater<boolean>) => void;
  setMessage: (value: Updater<string>) => void;
  dismissMessage: (revision: number) => void;
  setApplyingChanges: (value: Updater<boolean>) => void;
  setAppliedChanges: (value: AppliedWorkspaceChanges | undefined) => void;
  discardWorkspaceDraft: (expectedManifest: string) => boolean;
  resetWorkspace: () => void;
}

const resolve = <T>(value: Updater<T>, current: T): T =>
  typeof value === "function" ? (value as (current: T) => T)(current) : value;

export const useWorkspaceStore = create<WorkspaceState & WorkspaceActions>((set) => ({
  project: "",
  changeSetOrigin: "standard",
  changeSetIncludesHome: false,
  baselineManifest: "",
  workspaceDrafts: {},
  busy: false,
  message: "",
  messageRevision: 0,
  messageDismissed: false,
  applyingChanges: false,
  setProject: (value) => set((state) => ({ project: resolve(value, state.project) })),
  setSelectedWorkspace: (value) =>
    set((state) => ({ selectedWorkspace: resolve(value, state.selectedWorkspace) })),
  setScan: (value) => set((state) => ({ scan: resolve(value, state.scan) })),
  setManifest: (value) =>
    set((state) => {
      const manifest = resolve(value, state.manifest);
      if (
        state.changeSet &&
        state.changeSetOrigin === "standard" &&
        JSON.stringify(manifest) !== JSON.stringify(state.manifest)
      ) {
        return {
          manifest,
          changeSet: undefined,
          changeSetManifest: undefined,
          changeSetIncludesHome: false,
          handoffLaunchRequest: undefined,
        };
      }
      return { manifest };
    }),
  setChangeSet: (value, plannedManifest, includesHome = false) =>
    set((state) => {
      const changeSet = resolve(value, state.changeSet);
      return {
        changeSet,
        changeSetManifest: plannedManifest ? JSON.stringify(plannedManifest) : undefined,
        changeSetIncludesHome: includesHome,
        ...(changeSet && changeSet !== state.changeSet ? { appliedChanges: undefined } : {}),
      };
    }),
  acceptAppliedManifest: (diskManifest, plannedManifest, draftAtApply) =>
    set((state) => {
      const baselineManifest = JSON.stringify(diskManifest);
      const currentManifest = JSON.stringify(state.manifest);
      // Doctor and handoff plans may not include the editor's draft. Edits made
      // during apply also count, including a revert to the previous disk baseline.
      const preserveDraft =
        state.manifest &&
        ((draftAtApply !== undefined && currentManifest !== draftAtApply) ||
          (currentManifest !== state.baselineManifest && currentManifest !== plannedManifest));
      const manifest = preserveDraft && state.manifest ? state.manifest : diskManifest;
      const workspaceDrafts = { ...state.workspaceDrafts };
      if (state.selectedWorkspace) {
        if (JSON.stringify(manifest) !== baselineManifest)
          workspaceDrafts[state.selectedWorkspace.id] = manifest;
        else delete workspaceDrafts[state.selectedWorkspace.id];
      }
      return { manifest, baselineManifest, workspaceDrafts };
    }),
  setChangeSetOrigin: (value) =>
    set((state) => ({ changeSetOrigin: resolve(value, state.changeSetOrigin) })),
  setHandoffLaunchRequest: (value) =>
    set((state) => ({ handoffLaunchRequest: resolve(value, state.handoffLaunchRequest) })),
  setBaselineManifest: (value) =>
    set((state) => ({ baselineManifest: resolve(value, state.baselineManifest) })),
  setWorkspaceDrafts: (value) =>
    set((state) => ({ workspaceDrafts: resolve(value, state.workspaceDrafts) })),
  setBusy: (value) => set((state) => ({ busy: resolve(value, state.busy) })),
  setMessage: (value) =>
    set((state) => {
      const message = resolve(value, state.message);
      // Conditional recovery that leaves another error intact is not a new notice.
      if (typeof value === "function" && message === state.message) return state;
      return { message, messageRevision: state.messageRevision + 1, messageDismissed: false };
    }),
  dismissMessage: (revision) =>
    set((state) => (state.messageRevision === revision ? { messageDismissed: true } : state)),
  setApplyingChanges: (value) =>
    set((state) => ({ applyingChanges: resolve(value, state.applyingChanges) })),
  setAppliedChanges: (appliedChanges) => set({ appliedChanges }),
  discardWorkspaceDraft: (expectedManifest) => {
    let discarded = false;
    set((state) => {
      if (
        state.busy ||
        state.applyingChanges ||
        !state.selectedWorkspace ||
        !state.manifest ||
        !state.baselineManifest ||
        JSON.stringify(state.manifest) !== expectedManifest
      )
        return state;
      let manifest: Manifest;
      try {
        // The baseline is the JSON snapshot of the manifest loaded by the workspace loaders.
        manifest = JSON.parse(state.baselineManifest) as Manifest;
      } catch {
        return state;
      }
      if (
        !manifest ||
        typeof manifest !== "object" ||
        !manifest.instructions ||
        !manifest.workspace ||
        !Array.isArray(manifest.skills) ||
        !Array.isArray(manifest.connections)
      )
        return state;
      const workspaceDrafts = { ...state.workspaceDrafts };
      delete workspaceDrafts[state.selectedWorkspace.id];
      discarded = true;
      return {
        manifest,
        workspaceDrafts,
        ...(state.changeSetOrigin === "standard"
          ? {
              changeSet: undefined,
              changeSetManifest: undefined,
              changeSetIncludesHome: false,
              // A completed/unknown import still needs its recovery request.
              handoffLaunchRequest: state.changeSet ? undefined : state.handoffLaunchRequest,
            }
          : {}),
      };
    });
    return discarded;
  },
  resetWorkspace: () =>
    set((state) => ({
      project: "",
      selectedWorkspace: undefined,
      scan: undefined,
      manifest: undefined,
      changeSet: undefined,
      changeSetManifest: undefined,
      changeSetIncludesHome: false,
      changeSetOrigin: "standard",
      handoffLaunchRequest: undefined,
      baselineManifest: "",
      busy: false,
      message: "",
      messageRevision: state.messageRevision + 1,
      messageDismissed: false,
      applyingChanges: false,
      appliedChanges: undefined,
    })),
}));
