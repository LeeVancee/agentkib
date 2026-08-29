import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import { useAppDialogs } from "@/components/AppDialogProvider";
import { api } from "@/core/api";
import { refreshGlobalState } from "@/core/global-state";
import { localizeMessage, tr } from "@/core/i18n";
import { useAppStore } from "@/stores/app-store";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import type { Manifest, RefreshKind, WorkspaceSummary } from "@/core/types";
import type { SettingsSection } from "@/features/settings/SettingsSidebar";
import { createGlobalNavigation } from "./GlobalShell";
import { parseRoute, type AppSearch, type GlobalPage, type Page } from "./app-route";

export type { AppSearch, GlobalPage, Page, ParsedRoute } from "./app-route";

export function useAppNavigation() {
  useTranslation();
  const dialogs = useAppDialogs();
  const navigate = useNavigate();
  const location = useLocation();
  const search = useSearch({ strict: false }) as AppSearch;
  const route = parseRoute(location.pathname);
  const workspaceRouteId = route.kind === "workspace" ? route.workspaceId : undefined;
  const workspaceRoutePage = route.kind === "workspace" ? route.page : undefined;
  const routeGlobalPage = route.kind === "global" ? route.page : "home";
  const globalPage = routeGlobalPage;
  const appMode = route.kind === "settings" ? "settings" : "main";
  const settingsSection = search.settingsSection ?? "general";
  const quotaProvider = search.quotaProvider;
  const quotaWindow = search.quotaWindow;
  const appStore = useAppStore();
  const workspaceStore = useWorkspaceStore();
  const {
    workspaces,
    globalMemories,
    navigationRequest,
    setNavigationRequest,
    menuCommand,
    setMenuCommand,
    refreshJobs,
    setQuotaConfigureRequest,
  } = appStore;
  const {
    project,
    setProject,
    selectedWorkspace,
    setSelectedWorkspace,
    setScan,
    manifest,
    setManifest,
    setChangeSet,
    setChangeSetOrigin,
    setHandoffLaunchRequest,
    baselineManifest,
    setBaselineManifest,
    workspaceDrafts,
    setWorkspaceDrafts,
    message,
    setMessage,
    setBusy,
  } = workspaceStore;
  const workspaceOpenRequest = useRef(0);

  const updateSearch = useCallback(
    (patch: Partial<AppSearch>) => {
      void navigate({
        to: location.pathname as never,
        search: (current) => ({ ...current, ...patch }) as never,
      });
    },
    [location.pathname, navigate],
  );
  const navigateWorkspacePageFor = useCallback(
    (workspaceId: string, nextPage: Page) => {
      const path =
        nextPage === "overview" ? "/workspace/$workspaceId" : `/workspace/$workspaceId/${nextPage}`;
      void navigate({ to: path as never, params: { workspaceId } as never });
    },
    [navigate],
  );
  const setGitSubview = useCallback(
    (nextSubview: import("@/features/workspace/WorkspaceGitPage").GitSubview | undefined) =>
      updateSearch({ gitSubview: nextSubview }),
    [updateSearch],
  );

  const load = async (path = project, draft?: Manifest) => {
    if (!path) return;
    const requestId = ++workspaceOpenRequest.current;
    const targetWorkspaceId = selectedWorkspace?.id;
    const isCurrentRequest = () =>
      requestId === workspaceOpenRequest.current &&
      useWorkspaceStore.getState().project === path &&
      useWorkspaceStore.getState().selectedWorkspace?.id === targetWorkspaceId;
    setBusy(true);
    setMessage("");
    try {
      const [nextScan, nextManifest, nextRuntime] = await Promise.all([
        api.scan(path),
        api.manifest(path),
        api.runtime(),
      ]);
      if (!isCurrentRequest()) return;
      setProject(path);
      setScan(nextScan);
      setManifest(draft ?? nextManifest);
      setBaselineManifest(JSON.stringify(nextManifest));
      useAppStore.getState().setRuntime(nextRuntime);
    } catch (error) {
      if (isCurrentRequest()) setMessage(localizeMessage(error));
    } finally {
      if (isCurrentRequest()) setBusy(false);
    }
  };

  const loadGlobal = async () => {
    await refreshGlobalState(useAppStore.getState().runtime);
  };

  const refreshDiscovery = async () => {
    setMessage("");
    try {
      await api.requestRefresh("discovery", true);
    } catch (error) {
      setMessage(localizeMessage(error));
    }
  };

  const requestRefreshKinds = async (kinds: RefreshKind[]) => {
    setMessage("");
    try {
      await Promise.all(kinds.map((kind) => api.requestRefresh(kind, true)));
    } catch (error) {
      setMessage(localizeMessage(error));
    }
  };

  const hasUnsavedDraft = Boolean(
    manifest && baselineManifest && JSON.stringify(manifest) !== baselineManifest,
  );
  const persistWorkspaceDraft = useCallback(() => {
    if (selectedWorkspace && manifest && hasUnsavedDraft)
      setWorkspaceDrafts((drafts) => ({ ...drafts, [selectedWorkspace.id]: manifest }));
  }, [hasUnsavedDraft, manifest, selectedWorkspace, setWorkspaceDrafts]);

  const leaveWorkspace = async (next: () => void) => {
    if (useWorkspaceStore.getState().applyingChanges) {
      await dialogs.notify(tr("dialog.quit.changesApplying"));
      return;
    }
    if (
      hasUnsavedDraft &&
      !(await dialogs.confirm({
        description: tr("workspace.leaveDraftConfirm"),
        tone: "destructive",
      }))
    )
      return;
    if (useWorkspaceStore.getState().applyingChanges) {
      await dialogs.notify(tr("dialog.quit.changesApplying"));
      return;
    }
    workspaceOpenRequest.current += 1;
    if (selectedWorkspace)
      setWorkspaceDrafts((drafts) => {
        const nextDrafts = { ...drafts };
        delete nextDrafts[selectedWorkspace.id];
        return nextDrafts;
      });
    setGitSubview(undefined);
    setSelectedWorkspace(undefined);
    setProject("");
    setScan(undefined);
    setManifest(undefined);
    setChangeSet(undefined);
    setChangeSetOrigin("standard");
    setHandoffLaunchRequest(undefined);
    setBaselineManifest("");
    next();
  };

  const openWorkspace = useCallback(
    async (workspace: WorkspaceSummary, initialPage: Page = "overview") => {
      const requestId = ++workspaceOpenRequest.current;
      persistWorkspaceDraft();
      setBusy(true);
      setMessage("");
      try {
        const runtimePromise = useAppStore.getState().runtime
          ? Promise.resolve(useAppStore.getState().runtime)
          : api.runtime();
        const [nextScan, nextRuntime] = await Promise.all([
          api.scan(workspace.path),
          runtimePromise,
        ]);
        if (requestId !== workspaceOpenRequest.current) return;
        let nextManifest: Manifest | undefined;
        try {
          nextManifest = await api.manifest(workspace.path);
        } catch (error) {
          if (requestId === workspaceOpenRequest.current) setMessage(localizeMessage(error));
        }
        if (requestId !== workspaceOpenRequest.current) return;
        setGitSubview(undefined);
        setChangeSet(undefined);
        setChangeSetOrigin("standard");
        setHandoffLaunchRequest(undefined);
        setProject(workspace.path);
        setScan(nextScan);
        setManifest(nextManifest ? (workspaceDrafts[workspace.id] ?? nextManifest) : undefined);
        setBaselineManifest(nextManifest ? JSON.stringify(nextManifest) : "");
        useAppStore.getState().setRuntime(nextRuntime);
        setSelectedWorkspace(workspace);
        navigateWorkspacePageFor(workspace.id, nextManifest ? initialPage : "doctor");
      } catch (error) {
        if (requestId === workspaceOpenRequest.current) {
          setSelectedWorkspace(workspace);
          setProject("");
          setScan(undefined);
          setManifest(undefined);
          setChangeSet(undefined);
          setChangeSetOrigin("standard");
          setHandoffLaunchRequest(undefined);
          setBaselineManifest("");
          setMessage(localizeMessage(error));
        }
      } finally {
        if (requestId === workspaceOpenRequest.current) setBusy(false);
      }
    },
    [
      navigateWorkspacePageFor,
      persistWorkspaceDraft,
      setBaselineManifest,
      setBusy,
      setChangeSet,
      setChangeSetOrigin,
      setGitSubview,
      setHandoffLaunchRequest,
      setManifest,
      setMessage,
      setProject,
      setScan,
      setSelectedWorkspace,
      workspaceDrafts,
    ],
  );

  useEffect(() => {
    if (route.kind !== "workspace") workspaceOpenRequest.current += 1;
  }, [route.kind]);
  useEffect(() => {
    if (
      route.kind !== "workspace" ||
      selectedWorkspace?.id === workspaceRouteId ||
      !useAppStore.getState().workspacesLoaded ||
      !workspaceRouteId
    )
      return;
    const workspace = workspaces.find((item) => item.id === workspaceRouteId);
    if (workspace) void openWorkspace(workspace, workspaceRoutePage ?? "overview");
    else setMessage(tr("common.notFound"));
  }, [
    route.kind,
    workspaceRouteId,
    workspaceRoutePage,
    selectedWorkspace?.id,
    workspaces,
    openWorkspace,
    setMessage,
  ]);

  const navigateGlobalWithSearch = (nextPage: GlobalPage, patch: Partial<AppSearch> = {}) => {
    const path = nextPage === "home" ? "/" : `/${nextPage}`;
    void navigate({ to: path as never, search: (current) => ({ ...current, ...patch }) as never });
  };
  const navigateGlobal = (
    nextPage: GlobalPage,
    preserveQuotaSelection = false,
    searchPatch: Partial<AppSearch> = {},
  ) => {
    const next = () =>
      navigateGlobalWithSearch(
        nextPage,
        preserveQuotaSelection
          ? { quotaProvider, quotaWindow, ...searchPatch }
          : { quotaProvider: undefined, quotaWindow: undefined, ...searchPatch },
      );
    if (selectedWorkspace) void leaveWorkspace(next);
    else {
      workspaceOpenRequest.current += 1;
      next();
    }
  };
  const openSettings = useCallback(
    (section: SettingsSection = "general") => {
      if (useWorkspaceStore.getState().applyingChanges) {
        void dialogs.notify(tr("dialog.quit.changesApplying"));
        return;
      }
      void navigate({
        to: "/settings",
        search: (current) => ({ ...current, settingsSection: section }) as never,
      });
    },
    [dialogs, navigate],
  );

  useEffect(() => {
    if (!navigationRequest) return;
    if (navigationRequest.page === "settings") {
      openSettings(navigationRequest.settings_section ?? "general");
      setNavigationRequest(undefined);
      return;
    }
    if (navigationRequest.page === "quota") {
      navigateGlobal("quota", false, {
        quotaProvider: navigationRequest.provider,
        quotaWindow: navigationRequest.window,
      });
      if (navigationRequest.configure_popover) setQuotaConfigureRequest((value) => value + 1);
    } else {
      navigateGlobal(navigationRequest.page);
    }
    setNavigationRequest(undefined);
  }, [
    navigationRequest,
    dialogs,
    navigateGlobal,
    navigateGlobalWithSearch,
    navigate,
    openSettings,
    setNavigationRequest,
    setQuotaConfigureRequest,
  ]);

  const ensureWorkspaceChangeAllowed = async () => {
    if (!useWorkspaceStore.getState().applyingChanges) return true;
    await dialogs.notify(tr("dialog.quit.changesApplying"));
    return false;
  };

  const selectProject = async () => {
    if (!(await ensureWorkspaceChangeAllowed())) return;
    const selected = await api.pickDirectory(tr("dialog.addWorkspace"));
    if (typeof selected === "string") {
      if (!(await ensureWorkspaceChangeAllowed())) return;
      const workspace = await api.addWorkspace(selected);
      await loadGlobal();
      if (!(await ensureWorkspaceChangeAllowed())) return;
      await openWorkspace(workspace);
    }
  };

  const refreshCurrentView = async () => {
    if (selectedWorkspace && project && manifest) {
      await load(project, manifest);
      return;
    }
    if (appMode === "settings") {
      if (settingsSection === "discovery") await requestRefreshKinds(["discovery"]);
      else if (settingsSection === "integrations") await requestRefreshKinds(["gateways"]);
      else if (settingsSection === "diagnostics")
        await requestRefreshKinds(["discovery", "insights", "gateways", "quota"]);
      else await loadGlobal();
      return;
    }
    if (globalPage === "quota") await requestRefreshKinds(["quota"]);
    else if (globalPage === "insights") await requestRefreshKinds(["insights"]);
    else await requestRefreshKinds(["discovery"]);
  };

  async function addScanRootFromDialog() {
    const selected = await api.pickDirectory(tr("dialog.addScanRoot"));
    if (typeof selected === "string") {
      await api.addScanRoot(selected, 5);
      await loadGlobal();
      await refreshDiscovery();
    }
  }

  useEffect(() => {
    if (!menuCommand) return;
    setMenuCommand(undefined);
    if (menuCommand.command === "add-workspace") void selectProject();
    else if (menuCommand.command === "add-scan-root") void addScanRootFromDialog();
    else if (menuCommand.command === "refresh-current") void refreshCurrentView();
    else if (menuCommand.command === "refresh-all")
      void dialogs.confirm(tr("menu.refreshAllConfirm")).then((confirmed) => {
        if (confirmed) void requestRefreshKinds(["discovery", "insights", "gateways", "quota"]);
      });
  }, [
    dialogs,
    menuCommand,
    addScanRootFromDialog,
    refreshCurrentView,
    requestRefreshKinds,
    selectProject,
    setMenuCommand,
  ]);

  return {
    route,
    appMode,
    globalPage,
    message,
    refreshJobs,
    navigation: createGlobalNavigation(
      globalMemories.filter((item) => item.status === "pending").length,
    ),
    navigateGlobal,
    openSettings,
    refreshCurrentView,
    addWorkspace: selectProject,
    addScanRoot: addScanRootFromDialog,
  };
}
