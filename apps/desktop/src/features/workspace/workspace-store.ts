import { create } from "zustand";
import type {
  ChangeSet,
  Manifest,
  SessionHandoffLaunchRequest,
  WorkspaceScan,
  WorkspaceSummary,
} from "@/core/types";

export type ChangeSetOrigin = "standard" | "doctor" | "handoff" | "handoff-setup";
type Updater<T> = T | ((current: T) => T);

interface WorkspaceState {
  project: string;
  selectedWorkspace?: WorkspaceSummary;
  scan?: WorkspaceScan;
  manifest?: Manifest;
  changeSet?: ChangeSet;
  changeSetOrigin: ChangeSetOrigin;
  handoffLaunchRequest?: SessionHandoffLaunchRequest;
  baselineManifest: string;
  workspaceDrafts: Record<string, Manifest>;
  busy: boolean;
  message: string;
  applyingChanges: boolean;
}

interface WorkspaceActions {
  setProject: (value: Updater<string>) => void;
  setSelectedWorkspace: (value: Updater<WorkspaceSummary | undefined>) => void;
  setScan: (value: Updater<WorkspaceScan | undefined>) => void;
  setManifest: (value: Updater<Manifest | undefined>) => void;
  setChangeSet: (value: Updater<ChangeSet | undefined>) => void;
  setChangeSetOrigin: (value: Updater<ChangeSetOrigin>) => void;
  setHandoffLaunchRequest: (value: Updater<SessionHandoffLaunchRequest | undefined>) => void;
  setBaselineManifest: (value: Updater<string>) => void;
  setWorkspaceDrafts: (value: Updater<Record<string, Manifest>>) => void;
  setBusy: (value: Updater<boolean>) => void;
  setMessage: (value: Updater<string>) => void;
  setApplyingChanges: (value: Updater<boolean>) => void;
  resetWorkspace: () => void;
}

const resolve = <T>(value: Updater<T>, current: T): T =>
  typeof value === "function" ? (value as (current: T) => T)(current) : value;

export const useWorkspaceStore = create<WorkspaceState & WorkspaceActions>((set) => ({
  project: "",
  changeSetOrigin: "standard",
  baselineManifest: "",
  workspaceDrafts: {},
  busy: false,
  message: "",
  applyingChanges: false,
  setProject: (value) => set((state) => ({ project: resolve(value, state.project) })),
  setSelectedWorkspace: (value) =>
    set((state) => ({ selectedWorkspace: resolve(value, state.selectedWorkspace) })),
  setScan: (value) => set((state) => ({ scan: resolve(value, state.scan) })),
  setManifest: (value) => set((state) => ({ manifest: resolve(value, state.manifest) })),
  setChangeSet: (value) => set((state) => ({ changeSet: resolve(value, state.changeSet) })),
  setChangeSetOrigin: (value) =>
    set((state) => ({ changeSetOrigin: resolve(value, state.changeSetOrigin) })),
  setHandoffLaunchRequest: (value) =>
    set((state) => ({ handoffLaunchRequest: resolve(value, state.handoffLaunchRequest) })),
  setBaselineManifest: (value) =>
    set((state) => ({ baselineManifest: resolve(value, state.baselineManifest) })),
  setWorkspaceDrafts: (value) =>
    set((state) => ({ workspaceDrafts: resolve(value, state.workspaceDrafts) })),
  setBusy: (value) => set((state) => ({ busy: resolve(value, state.busy) })),
  setMessage: (value) => set((state) => ({ message: resolve(value, state.message) })),
  setApplyingChanges: (value) =>
    set((state) => ({ applyingChanges: resolve(value, state.applyingChanges) })),
  resetWorkspace: () =>
    set({
      project: "",
      selectedWorkspace: undefined,
      scan: undefined,
      manifest: undefined,
      changeSet: undefined,
      changeSetOrigin: "standard",
      handoffLaunchRequest: undefined,
      baselineManifest: "",
      busy: false,
      message: "",
      applyingChanges: false,
    }),
}));
