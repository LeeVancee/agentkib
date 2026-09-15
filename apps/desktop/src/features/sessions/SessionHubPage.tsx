/** @jsxImportSource octane */

import { useI18n } from "@/core/useI18n";
import { useLayoutEffect, useRef, useState } from "octane";
import {
  ChevronRight,
  CircleAlert,
  Clock,
  Database,
  FileText,
  GitBranch,
  Info,
  RefreshCw,
} from "@octanejs/lucide";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { AgentIcon } from "@/features/agents/AgentIcon";
import { RemoteErrorDetails } from "@/features/remote/RemoteErrorDetails";
import { displaySessionTitle } from "@/features/workspace/session-title";
import { api } from "@/core/api";
import { DEFAULT_SESSION_PAGE_SIZE } from "@/core/session-history";
import { useAppStore } from "@/stores/app-store";
import { useSessionHub } from "./SessionHubContext";
import { useSessionViewStore } from "./session-view-store";
import {
  isInteractiveFork,
  sessionAgentNames,
  sessionRecordLabel,
  sessionSourceLabel,
  sessionSourceDetails,
} from "./session-labels";
import { useSessionHistory } from "./useSessionHistory";
import { ConversationTranscript } from "./ConversationTranscript";
import { HistoryError, HistoryWarning } from "./HistoryFeedback";
import type { Renderable } from "@/lib/octane-types";

function Notice({ children, error = false }: { children: Renderable; error?: boolean }) {
  return (
    <div
      className={`session-notice ${error ? "session-notice-error" : ""}`}
      role={error ? "alert" : "status"}
    >
      {error ? <CircleAlert size={17} /> : <Info size={17} />}
      <div>{children}</div>
    </div>
  );
}

export function SessionHubPage() {
  const { localizeMessage, tr, formatDateTime } = useI18n();
  const hub = useSessionHub();
  const history = useSessionHistory(hub.selected, hub.enabled, hub.historyRevision);
  const resetFilters = useSessionViewStore((state) => state.resetFilters);
  const [enabling, setEnabling] = useState(false);
  const [enableError, setEnableError] = useState("");
  const enableLock = useRef(false);
  const historyRef = useRef<HTMLDivElement | null>(null);
  const sessionKey = JSON.stringify([
    hub.selected?.remote?.host_id,
    hub.selected?.workspace_id,
    hub.selected?.id,
  ]);
  const scrollAnchor = useRef<{
    key: string;
    candidates: { id: string; top: number }[];
    height: number;
    scroll: number;
  } | null>(null);
  useLayoutEffect(() => {
    scrollAnchor.current = null;
    if (historyRef.current) historyRef.current.scrollTop = 0;
  }, [sessionKey]);
  useLayoutEffect(() => {
    const anchor = scrollAnchor.current;
    const container = historyRef.current;
    if (!anchor || !container || history.loadingEarlier) return;
    scrollAnchor.current = null;
    if (anchor.key !== sessionKey) return;
    const elements = Array.from(container.querySelectorAll<HTMLElement>("[data-event-id]"));
    // Completing a previously partial turn can hide the first anchor inside a
    // process disclosure. Prefer the next surviving record (usually the final).
    for (const candidate of anchor.candidates) {
      const element = elements.find(
        (item) =>
          item.dataset.eventId === candidate.id &&
          item.getClientRects().length > 0 &&
          !item.closest("[hidden]"),
      );
      if (element) {
        container.scrollTop += element.getBoundingClientRect().top - candidate.top;
        return;
      }
    }
    container.scrollTop = anchor.scroll + container.scrollHeight - anchor.height;
  }, [history.events, history.loadingEarlier, sessionKey]);
  const loadEarlier = () => {
    const container = historyRef.current;
    if (container) {
      const top = container.getBoundingClientRect().top;
      const candidates = Array.from(container.querySelectorAll<HTMLElement>("[data-event-id]"))
        .filter(
          (item) =>
            item.getClientRects().length > 0 &&
            !item.closest("[hidden]") &&
            item.getBoundingClientRect().bottom > top,
        )
        .map((item) => ({ id: item.dataset.eventId!, top: item.getBoundingClientRect().top }));
      scrollAnchor.current = {
        key: sessionKey,
        candidates,
        height: container.scrollHeight,
        scroll: container.scrollTop,
      };
    }
    void history.loadEarlier();
  };

  const enable = async () => {
    if (enableLock.current) return;
    enableLock.current = true;
    setEnabling(true);
    setEnableError("");
    try {
      useAppStore.getState().setRuntime(await api.setSessionIndexEnabled(true));
    } catch (error) {
      setEnableError(localizeMessage(error));
    } finally {
      enableLock.current = false;
      setEnabling(false);
    }
  };

  if (!hub.runtimeReady || hub.workspacesLoading)
    return (
      <div className="session-state" role="status">
        <RefreshCw className="animate-spin" size={24} />
        <p>{tr("sessions.loading")}</p>
      </div>
    );
  if (!hub.enabled)
    return (
      <div className="session-state">
        <Database size={32} />
        <h1>{tr("conversations.indexDisabled")}</h1>
        <p>{tr("sessions.enableDescription")}</p>
        {enableError && <Notice error>{enableError}</Notice>}
        <Button disabled={enabling} onClick={() => void enable()}>
          {tr(enabling ? "sessions.enabling" : "conversations.enable")}
        </Button>
      </div>
    );
  if (hub.workspacesError && !hub.workspaces.length)
    return (
      <div className="session-state">
        <Notice error>{hub.workspacesError}</Notice>
        <Button onClick={hub.retryWorkspaces}>{tr("sessions.retry")}</Button>
      </div>
    );

  const selected = hub.selected;
  const workspace = hub.selectedWorkspace;
  const selectedSources = selected
    ? sessionSourceDetails(selected, hub.sessions, tr, formatDateTime)
    : [];
  const stats = [
    ["all", hub.filtered.length],
    ["readable", hub.filtered.filter((session) => session.availability === "readable").length],
    ["archived", hub.filtered.filter((session) => session.archived).length],
    ["metadata", hub.filtered.filter((session) => session.availability === "metadata-only").length],
  ] as const;
  const visibleWorkspaceIds = new Set(hub.filtered.map((session) => session.workspace_id));
  const statusWorkspaces = hub.workspaces
    .filter((item) => !item.remote)
    .filter(
      (item) =>
        visibleWorkspaceIds.has(item.id) ||
        Boolean(hub.errors[item.id]) ||
        !hub.sessions.some((session) => session.workspace_id === item.id),
    );

  return (
    <div className="session-hub-page">
      <div className="session-hub-body" ref={historyRef}>
        {hub.remoteHosts?.map(
          (host) =>
            (host.status !== "online" || hub.remoteErrors?.[host.id]) && (
              <Notice key={host.id} error={!!hub.remoteErrors?.[host.id]}>
                {host.name} · {tr(`remote.state.${host.status}`)}
                {hub.remoteErrors?.[host.id] && (
                  <RemoteErrorDetails error={hub.remoteErrors[host.id]} />
                )}
              </Notice>
            ),
        )}
        {hub.workspacesError && (
          <Notice error>
            {hub.workspacesError}
            <Button variant="ghost" onClick={hub.retryWorkspaces}>
              {tr("sessions.retry")}
            </Button>
          </Notice>
        )}
        {Object.keys(hub.errors).length > 0 && (
          <Notice error>
            {tr("sessions.partialFailure", { count: Object.keys(hub.errors).length })}
          </Notice>
        )}
        {selected ? (
          <>
            <div className="session-reading-context">
              <span>
                {selected.remote?.host_name ?? tr("sessions.local")} · {workspace?.name} ·{" "}
                {sessionAgentNames[selected.agent]}
              </span>
              <span>{tr("sessions.historyReadonly")}</span>
            </div>
            <Collapsible className="session-history-details" key={sessionKey}>
              <CollapsibleTrigger className="session-details-trigger">
                <ChevronRight size={13} />
                {tr("sessions.historyDetails")}
              </CollapsibleTrigger>
              <CollapsibleContent className="session-history-details-content" keepMounted>
                {workspace?.path && <p className="session-detail-path">{workspace.path}</p>}
                <div className="session-history-meta">
                  <span>
                    <FileText size={15} />
                    {sessionRecordLabel(selected, tr)}
                  </span>
                  {selected?.origin === "auxiliary" && !selectedSources.length && (
                    <span>{tr("conversations.auxiliary")}</span>
                  )}
                  {selectedSources.map((source) =>
                    source.session ? (
                      <Button
                        key={`${source.kind}:${source.id}`}
                        variant="link"
                        size="sm"
                        className="h-auto gap-1 p-0 text-xs"
                        title={source.label}
                        aria-label={source.label}
                        onClick={() => {
                          useSessionViewStore.getState().revealSession(source.session!);
                          hub.select(source.session!.id);
                        }}
                      >
                        {source.kind === "forked" && <GitBranch size={13} />}
                        {source.label}
                      </Button>
                    ) : (
                      <span key={`${source.kind}:${source.id}`} title={source.label}>
                        {source.label}
                      </span>
                    ),
                  )}
                  <span>
                    <Clock size={15} />
                    {selected.updated_at
                      ? formatDateTime(selected.updated_at)
                      : tr("conversations.unknownTime")}
                  </span>
                  {selected.git_branch && <span>{selected.git_branch}</span>}
                </div>
                <div className="session-reading-description">
                  {tr(selected.remote ? "remote.sessionsReadonly" : "sessions.historyOnly")}
                  {selected.availability === "readable" && (
                    <p>{tr("history.latestWindow", { count: DEFAULT_SESSION_PAGE_SIZE })}</p>
                  )}
                </div>
              </CollapsibleContent>
            </Collapsible>
            {selected.remote && (
              <p className="session-remote-status">
                {tr(selected.remote.online ? "remote.state.online" : "remote.state.offline")} ·{" "}
                {tr("remote.catalogSynced")} {formatDateTime(selected.remote.last_synced_at)}
              </p>
            )}
            {history.error && (
              <HistoryError error={history.rawError} onRetry={() => void history.retry()} />
            )}
            {history.warnings.map((warning) => (
              <HistoryWarning key={warning} warning={warning} />
            ))}
            {selected.availability === "metadata-only" ? (
              <div className="session-state session-state-inline">
                <FileText size={28} />
                <h2>{tr("conversations.filter.metadata")}</h2>
                <p>{tr("sessions.metadataDescription")}</p>
              </div>
            ) : history.loading ? (
              <div className="session-state session-state-inline" role="status">
                <RefreshCw className="animate-spin" size={24} />
                <p>{tr("sessions.loadingHistory")}</p>
              </div>
            ) : (
              <div className="session-transcript">
                {history.nextCursor && (
                  <Button
                    variant="outline"
                    className="self-center"
                    disabled={history.loadingEarlier}
                    onClick={loadEarlier}
                  >
                    {tr(
                      history.loadingEarlier ? "sessions.loadingHistory" : "sessions.loadEarlier",
                    )}
                  </Button>
                )}
                {!history.events.length && !history.error && (
                  <p className="session-state-inline text-muted-foreground">
                    {tr(
                      history.nextCursor ? "history.emptyWindow" : "conversations.noReadableEvents",
                    )}
                  </p>
                )}
                <ConversationTranscript
                  events={history.events}
                  sessionKey={sessionKey}
                  incomplete={history.warnings.length > 0}
                />
              </div>
            )}
          </>
        ) : (
          <>
            <p className="session-overview-description">
              {tr(
                hub.remoteHosts?.length
                  ? "remote.aggregateDescription"
                  : "sessions.overviewDescription",
              )}
            </p>
            <div className="session-stats">
              {stats.map(([key, count]) => (
                <div key={key}>
                  <strong>{count}</strong>
                  <span>{tr(`sessions.stat.${key}`)}</span>
                </div>
              ))}
            </div>
            {hub.loading && <Notice>{tr("conversations.scanning")}</Notice>}
            <div className="session-overview-panels">
              <section className="session-overview-panel">
                <header>
                  <Clock size={18} />
                  <h2>{tr("sessions.recent")}</h2>
                  <span>{hub.filtered.length}</span>
                </header>
                {hub.filtered.slice(0, 12).map((session) => {
                  const source = hub.workspaces.find((item) => item.id === session.workspace_id);
                  return (
                    <Button
                      variant="bare"
                      size="content"
                      className="session-recent-item"
                      key={session.id}
                      onClick={() => hub.select(session.id)}
                      title={[
                        source?.path,
                        sessionSourceLabel(session, hub.sessions, tr, formatDateTime),
                      ]
                        .filter(Boolean)
                        .join("\n")}
                    >
                      <AgentIcon agent={session.agent} compact />
                      <span>
                        <strong className="inline-flex items-center gap-1">
                          {displaySessionTitle(session.title, tr)}
                          {isInteractiveFork(session) && (
                            <GitBranch
                              size={12}
                              aria-label={`${tr("conversations.forked")}: ${sessionSourceLabel(session, hub.sessions, tr, formatDateTime)}`}
                            />
                          )}
                        </strong>
                        <small>
                          {session.remote && `${session.remote.host_name} · `}
                          {source?.name} · {sessionAgentNames[session.agent]} ·{" "}
                          {sessionRecordLabel(session, tr)}
                        </small>
                      </span>
                      <time>
                        {session.updated_at
                          ? formatDateTime(session.updated_at)
                          : tr("conversations.unknownTime")}
                      </time>
                    </Button>
                  );
                })}
                {!hub.filtered.length && !hub.loading && (
                  <div className="session-state-inline">
                    <p>{tr(hub.sessions.length ? "sessions.noMatches" : "sessions.noSessions")}</p>
                    {hub.sessions.length > 0 && (
                      <Button variant="ghost" onClick={resetFilters}>
                        {tr("sessions.clearFilters")}
                      </Button>
                    )}
                  </div>
                )}
              </section>
              <section className="session-overview-panel">
                <header>
                  <Database size={18} />
                  <h2>{tr("sessions.indexStatus")}</h2>
                </header>
                {statusWorkspaces.map((item) => (
                  <div className="session-index-item" key={item.id}>
                    <strong title={item.path}>{item.name}</strong>
                    {hub.errors[item.id] && (
                      <p className="text-destructive">{hub.errors[item.id]}</p>
                    )}
                    {hub.statuses
                      .filter((status) => status.workspace_id === item.id)
                      .map((status) => (
                        <div className="session-index-status" key={`${item.id}:${status.agent}`}>
                          <span>{sessionAgentNames[status.agent]}</span>
                          <span>{tr(`sessions.index.${status.freshness}`)}</span>
                          <small>
                            {status.last_success_at
                              ? formatDateTime(status.last_success_at)
                              : tr("sessions.neverIndexed")}
                          </small>
                          {(status.error_key || status.error_detail) && (
                            <p className="text-destructive">
                              {status.error_key
                                ? tr(status.error_key)
                                : localizeMessage(status.error_detail ?? "")}
                            </p>
                          )}
                        </div>
                      ))}
                    {!hub.statuses.some((status) => status.workspace_id === item.id) && (
                      <p>
                        {tr(hub.refreshing ? "conversations.scanning" : "sessions.neverIndexed")}
                      </p>
                    )}
                  </div>
                ))}
                {!statusWorkspaces.length && (
                  <p className="session-state-inline">
                    {tr(hub.workspaces.length ? "sessions.noMatches" : "sessions.noWorkspaces")}
                  </p>
                )}
              </section>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
