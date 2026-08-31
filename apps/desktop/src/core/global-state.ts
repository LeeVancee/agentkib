import { api } from "./api";
import type { RuntimeInfo } from "./types";
import { useAppStore } from "../stores/app-store";

let refreshSequence = 0;

type RefreshGlobalStateOptions = {
  deferNonCritical?: boolean;
};

function afterFirstPaint(task: () => void) {
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
    setTimeout(task, 0);
    return;
  }
  window.requestAnimationFrame(() => window.setTimeout(task, 0));
}

async function loadDerivedState(
  workspaces: Awaited<ReturnType<typeof api.workspaces>>,
  sequence: number,
) {
  if (sequence !== refreshSequence) return;

  const [doctorResult, insightsResult] = await Promise.allSettled([
    api.workspaceDoctorSummaries(workspaces.map((workspace) => workspace.id)),
    Promise.all([api.insightsSummary(), api.insightsStatus()]),
  ]);
  if (sequence !== refreshSequence) return;

  const nextState: {
    doctorSummaries?: Record<
      string,
      Awaited<ReturnType<typeof api.workspaceDoctorSummaries>>[number]
    >;
    insightsSummary?: Awaited<ReturnType<typeof api.insightsSummary>>;
    insightsStatus?: Awaited<ReturnType<typeof api.insightsStatus>>;
  } = {};

  if (doctorResult.status === "fulfilled") {
    nextState.doctorSummaries = Object.fromEntries(
      doctorResult.value.map((summary) => [summary.workspace_id, summary]),
    );
  }
  if (insightsResult.status === "fulfilled") {
    [nextState.insightsSummary, nextState.insightsStatus] = insightsResult.value;
  }
  useAppStore.setState(nextState);
}

export async function refreshGlobalState(
  currentRuntime?: RuntimeInfo,
  options: RefreshGlobalStateOptions = {},
) {
  const sequence = ++refreshSequence;
  const nextRuntimePromise = currentRuntime ? Promise.resolve(currentRuntime) : api.runtime();
  const previous = useAppStore.getState();
  const workspacesPromise = api.workspaces();
  const workspaces = await workspacesPromise;
  const initialState = { ...previous, workspaces, workspacesLoaded: true };
  if (sequence === refreshSequence) {
    useAppStore.setState({ workspaces, workspacesLoaded: true });
  }

  const secondaryResultsPromise = Promise.allSettled([
    api.agentInstallations(),
    api.catalogAssets(),
    api.globalMemories(),
    api.activity(),
    api.scanRoots(),
    api.excludedWorkspaces(),
    nextRuntimePromise,
    api.remoteGateways(),
  ]);
  const applySecondaryState = async () => {
    const [
      installationsResult,
      catalogResult,
      globalMemoriesResult,
      activityResult,
      scanRootsResult,
      excludedResult,
      runtimeResult,
      remoteGatewaysResult,
    ] = await secondaryResultsPromise;
    const valueOr = <T>(result: PromiseSettledResult<T>, fallback: T): T =>
      result.status === "fulfilled" ? result.value : fallback;
    const state = {
      ...initialState,
      installations: valueOr(installationsResult, previous.installations),
      catalog: valueOr(catalogResult, previous.catalog),
      globalMemories: valueOr(globalMemoriesResult, previous.globalMemories),
      activity: valueOr(activityResult, previous.activity),
      scanRoots: valueOr(scanRootsResult, previous.scanRoots),
      excluded: valueOr(excludedResult, previous.excluded),
      runtime: valueOr(runtimeResult, currentRuntime ?? previous.runtime),
      remoteGateways: valueOr(remoteGatewaysResult, previous.remoteGateways),
    };
    if (sequence === refreshSequence) useAppStore.setState(state);
    return state;
  };

  if (options.deferNonCritical) {
    void (async () => {
      await applySecondaryState();
      afterFirstPaint(() => void loadDerivedState(workspaces, sequence));
    })();
    return initialState;
  }

  await applySecondaryState();
  await loadDerivedState(workspaces, sequence);
  return useAppStore.getState();
}
