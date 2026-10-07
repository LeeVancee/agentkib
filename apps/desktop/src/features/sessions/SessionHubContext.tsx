import { useI18n } from "@/core/useI18n";
import { SESSION_COLLECTIONS, sessionCollection } from "@agentkib/runtime-protocol";
import type { WorkspaceSummary } from "@/core/types";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useHomeWorkspaces } from "@/features/home/home-query";
import { useAppStore } from "@/stores/app-store";
import { useSessionCatalog } from "./useSessionCatalog";
import { filterSessions, isSessionVisible } from "./session-catalog";
import { useSessionViewStore } from "./session-view-store";
import { SESSION_REFRESH_EVENT } from "./session-refresh";
import { refreshConversationCatalog, useConversationCatalog } from "./conversation-catalog";
import { hasDesktopConversation } from "@/core/conversation-bridge";
import {
  useRemoteCatalogEntries,
  refreshRemoteCatalog,
} from "@/features/remote/remote-catalog-store";

// The catalog store retains the error for the page's retry notice.
const refreshControlledCatalog = () => refreshConversationCatalog().catch(() => undefined);

function useHub(active: boolean) {
  const { localizeMessage, tr } = useI18n();
  const workspaceQuery = useHomeWorkspaces();
  const runtime = useAppStore((state) => state.runtime);
  const localEnabled = runtime?.session_index_enabled === true;
  const localWorkspaces = useMemo(
    (): WorkspaceSummary[] => [
      ...(workspaceQuery.data ?? []),
      ...(active && localEnabled
        ? Object.entries(SESSION_COLLECTIONS).map(([kind, id]) => ({
            id,
            name: tr(kind === "projectless" ? "sessions.projectless" : "sessions.unclassified"),
            path: "",
            status: "healthy" as const,
            asset_count: 0,
            warning_count: 0,
            sources: [],
          }))
        : []),
    ],
    [workspaceQuery.data, active, localEnabled, tr],
  );
  const remote = useRemoteCatalogEntries();
  const enabled = active && (localEnabled || remote.hosts.length > 0);
  const controlled = hasDesktopConversation();
  const catalog = useSessionCatalog(
    localWorkspaces,
    active && localEnabled,
    controlled ? refreshControlledCatalog : undefined,
  );
  const controlledCatalog = useConversationCatalog(active && localEnabled);
  const catalogError =
    controlled && active && localEnabled && controlledCatalog.error !== undefined
      ? localizeMessage(controlledCatalog.error)
      : "";
  const localSessions = useMemo(() => {
    if (!controlled) return catalog.sessions;
    const seen = new Set(controlledCatalog.sessions.map((session) => session.id));
    // Managed aliases belong to the controlled catalog. Conversation-only
    // Codex collections have no filesystem workspace and remain in the index.
    return [
      ...controlledCatalog.sessions,
      ...catalog.sessions.filter((session) => {
        if (
          session.agent !== "codex" ||
          !sessionCollection(session.workspace_id) ||
          seen.has(session.id)
        )
          return false;
        seen.add(session.id);
        return true;
      }),
    ];
  }, [controlled, controlledCatalog.sessions, catalog.sessions]);
  const workspaces = useMemo(
    () => [...localWorkspaces, ...remote.workspaces],
    [localWorkspaces, remote.workspaces],
  );
  const allSessions = useMemo(
    () => [...localSessions, ...remote.sessions],
    [localSessions, remote.sessions],
  );
  const sessions = useMemo(() => allSessions.filter(isSessionVisible), [allSessions]);
  const [hiddenSessionNotice, setHiddenSessionNotice] = useState(false);
  const refreshCatalog = catalog.refresh;
  const [historyRevision, setHistoryRevision] = useState(0);
  const [conversationRefreshRevision, setConversationRefreshRevision] = useState(0);
  const refresh = useCallback(async () => {
    await Promise.all([
      localEnabled ? refreshCatalog() : Promise.resolve(),
      ...remote.hosts.map((host) => refreshRemoteCatalog(host.id, true)),
    ]);
    setHistoryRevision((revision) => revision + 1);
    setConversationRefreshRevision((revision) => revision + 1);
  }, [localEnabled, refreshCatalog, remote.hosts]);
  const wasRefreshing = useRef(false);
  useEffect(() => {
    if (wasRefreshing.current && !catalog.refreshing && catalog.ready && enabled) {
      setHistoryRevision((revision) => revision + 1);
    }
    wasRefreshing.current = catalog.refreshing;
  }, [catalog.refreshing, catalog.ready, enabled]);
  useEffect(() => {
    if (!active) return;
    const handleRefresh = () => void refresh();
    window.addEventListener(SESSION_REFRESH_EVENT, handleRefresh);
    return () => window.removeEventListener(SESSION_REFRESH_EVENT, handleRefresh);
  }, [active, refresh]);
  const agent = useSessionViewStore((state) => state.agent);
  const filter = useSessionViewStore((state) => state.filter);
  const host = useSessionViewStore((state) => state.host);
  const filtered = useMemo(
    () =>
      filterSessions(sessions, workspaces, { query: "", agent, filter }).filter(
        (session) => host === "all" || host === (session.remote?.host_id ?? "local"),
      ),
    [sessions, workspaces, agent, filter, host],
  );
  const navigate = useNavigate();
  const { sessionId } = useSearch({ strict: false }) as { sessionId?: string };
  const canonicalId =
    allSessions.find(
      (session) => !session.remote && session.indexedSessionIds?.includes(sessionId ?? ""),
    )?.id ?? sessionId;
  const selected = enabled ? filtered.find((session) => session.id === canonicalId) : undefined;
  const selectedWorkspace = selected
    ? workspaces.find((workspace) => workspace.id === selected.workspace_id)
    : undefined;
  const select = useCallback(
    (id?: string, replace = false) => {
      setHiddenSessionNotice(false);
      if (id) useSessionViewStore.getState().setCreatingConversation(false);
      void navigate({
        to: "/sessions",
        replace,
        search: (current) => ({ ...current, sessionId: id }),
      });
    },
    [navigate],
  );
  useEffect(() => {
    if (enabled && selected && canonicalId !== sessionId) select(canonicalId, true);
  }, [enabled, selected, canonicalId, sessionId, select]);
  useEffect(() => {
    if (!sessionId || !enabled) return;
    const target = allSessions.find((session) => session.id === canonicalId);
    if (!target) return;
    if (isSessionVisible(target)) {
      setHiddenSessionNotice(false);
      return;
    }
    setHiddenSessionNotice(true);
    useSessionViewStore.getState().setCreatingConversation(false);
    void navigate({
      to: "/sessions",
      replace: true,
      search: (current) => ({ ...current, sessionId: undefined }),
    });
  }, [sessionId, canonicalId, allSessions, enabled, navigate]);
  useEffect(() => {
    const target = allSessions.find((session) => session.id === canonicalId);
    if (target && !isSessionVisible(target)) return;
    // Wait until every workspace cache has been read before validating a deep link.
    if (
      sessionId &&
      (!sessionId.startsWith("remote:") || sessions.some((session) => session.id === sessionId)) &&
      catalog.ready &&
      controlledCatalog.ready &&
      !catalogError &&
      enabled &&
      !workspaceQuery.isPending &&
      !workspaceQuery.error &&
      !selected &&
      (sessions.some((session) => session.id === sessionId) ||
        (!catalog.refreshing && Object.keys(catalog.errors).length === 0))
    ) {
      void navigate({
        to: "/sessions",
        replace: true,
        search: (current) => ({ ...current, sessionId: undefined }),
      });
    }
  }, [
    sessionId,
    canonicalId,
    allSessions,
    catalog.ready,
    controlledCatalog.ready,
    catalogError,
    catalog.refreshing,
    catalog.sessions,
    sessions,
    catalog.errors,
    enabled,
    selected,
    workspaceQuery.isPending,
    workspaceQuery.error,
    navigate,
  ]);
  return {
    statuses: catalog.statuses,
    errors: catalog.errors,
    refreshing: catalog.refreshing,
    ready: catalog.ready && controlledCatalog.ready,
    loading: catalog.loading || (controlled && !controlledCatalog.ready),
    catalogError,
    hiddenSessionNotice,
    sessions,
    remoteHosts: remote.hosts,
    remoteErrors: remote.errors,
    localEnabled,
    historyRevision,
    conversationRefreshRevision,
    refresh,
    workspaces,
    filtered,
    selected,
    selectedWorkspace,
    select,
    enabled,
    runtimeReady: runtime !== undefined,
    workspacesLoading: workspaceQuery.isPending && remote.sessions.length === 0,
    workspacesError: workspaceQuery.error ? localizeMessage(workspaceQuery.error) : "",
    retryWorkspaces: () => void workspaceQuery.refetch(),
  };
}

const SessionHubContext = createContext<ReturnType<typeof useHub> | null>(null);

export function SessionHubProvider({
  children,
  active = true,
}: {
  children: ReactNode;
  active?: boolean;
}) {
  return <SessionHubContext.Provider value={useHub(active)}>{children}</SessionHubContext.Provider>;
}

export function useSessionHub() {
  const context = useContext(SessionHubContext);
  if (!context) throw new Error("SessionHubProvider is required");
  return context;
}
