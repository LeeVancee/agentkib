import { useI18n } from "@/core/useI18n";
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
import { filterSessions } from "./session-catalog";
import { useSessionViewStore } from "./session-view-store";
import { SESSION_REFRESH_EVENT } from "./session-refresh";
import { refreshConversationCatalog, useConversationCatalog } from "./conversation-catalog";
import { hasDesktopConversation } from "@/core/conversation-bridge";
import {
  useRemoteCatalogEntries,
  refreshRemoteCatalog,
} from "@/features/remote/remote-catalog-store";
import "./sessions.css";

// The catalog store retains the error for the page's retry notice.
const refreshControlledCatalog = () => refreshConversationCatalog().catch(() => undefined);

function useHub(active: boolean) {
  const { localizeMessage } = useI18n();
  const workspaceQuery = useHomeWorkspaces();
  const localWorkspaces = useMemo(() => workspaceQuery.data ?? [], [workspaceQuery.data]);
  const runtime = useAppStore((state) => state.runtime);
  const localEnabled = runtime?.session_index_enabled === true;
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
  // The controlled catalog already removes indexed aliases of managed tasks.
  // Merging the raw index back in would expose a second, unreadable route.
  const localSessions = controlled ? controlledCatalog.sessions : catalog.sessions;
  const workspaces = useMemo(
    () => [...localWorkspaces, ...remote.workspaces],
    [localWorkspaces, remote.workspaces],
  );
  const sessions = useMemo(
    () => [...localSessions, ...remote.sessions],
    [localSessions, remote.sessions],
  );
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
  const showAuxiliary = useSessionViewStore((state) => state.showAuxiliary);
  const revealSession = useSessionViewStore((state) => state.revealSession);
  const filtered = useMemo(
    () =>
      filterSessions(sessions, workspaces, { query: "", agent, filter, showAuxiliary }).filter(
        (session) => host === "all" || host === (session.remote?.host_id ?? "local"),
      ),
    [sessions, workspaces, agent, filter, host, showAuxiliary],
  );
  const navigate = useNavigate();
  const { sessionId } = useSearch({ strict: false }) as { sessionId?: string };
  const canonicalId =
    sessions.find(
      (session) => !session.remote && session.indexedSessionIds?.includes(sessionId ?? ""),
    )?.id ?? sessionId;
  const selected = enabled ? filtered.find((session) => session.id === canonicalId) : undefined;
  const selectedWorkspace = selected
    ? workspaces.find((workspace) => workspace.id === selected.workspace_id)
    : undefined;
  const select = useCallback(
    (id?: string, replace = false) => {
      if (id) useSessionViewStore.getState().setCreatingConversation(false);
      void navigate({
        to: "/sessions",
        replace,
        search: (current) => ({ ...current, sessionId: id }),
      });
    },
    [navigate],
  );
  const routeReveal = useRef<{ sessionId?: string; revealed: boolean; skipClear: boolean }>({
    revealed: false,
    skipClear: false,
  });
  useEffect(() => {
    if (enabled && selected && canonicalId !== sessionId) select(canonicalId, true);
  }, [enabled, selected, canonicalId, sessionId, select]);
  useEffect(() => {
    if (routeReveal.current.sessionId !== sessionId) {
      routeReveal.current = { sessionId, revealed: false, skipClear: false };
    }
    if (!sessionId || routeReveal.current.revealed) return;
    const target = sessions.find((session) => session.id === sessionId);
    if (!target || target.origin !== "auxiliary") return;
    routeReveal.current.revealed = true;
    routeReveal.current.skipClear = true;
    // Route targets are explicit intent. Reveal once, including auxiliary
    // records, without re-revealing after the user changes view filters.
    revealSession(target);
  }, [sessionId, sessions, revealSession]);
  useEffect(() => {
    if (routeReveal.current.skipClear && routeReveal.current.sessionId === sessionId) {
      routeReveal.current.skipClear = false;
      return;
    }
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
    ...catalog,
    ready: catalog.ready && controlledCatalog.ready,
    loading: catalog.loading || (controlled && !controlledCatalog.ready),
    catalogError,
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
