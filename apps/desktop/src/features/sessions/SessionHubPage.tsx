import { useI18n } from "@/core/useI18n";
import { useLayoutEffect, useRef, useState } from "react";
import {
  ChevronRight,
  CircleAlert,
  Clock,
  Database,
  FileText,
  GitBranch,
  Info,
  RefreshCw,
} from "lucide-react";
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
import { cn, withAsyncCleanup } from "@/lib/utils";
import { hasDesktopConversation } from "@/core/conversation-bridge";
import { DesktopConversationPane } from "./DesktopConversationPane";

function Notice({ children, error = false }: { children: React.ReactNode; error?: boolean }) {
  return (
    <div
      className={cn(
        "session-notice mb-4 flex items-start gap-[9px] rounded-[10px] border bg-muted px-3.5 py-3 leading-[1.6] text-muted-foreground [overflow-wrap:anywhere] [&>svg]:mt-[3px] [&>svg]:shrink-0",
        error &&
          "session-notice-error bg-[color-mix(in_srgb,var(--destructive)_5%,var(--background))] text-destructive",
      )}
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
  const creating = useSessionViewStore((state) => state.creatingConversation);
  const interactive =
    hasDesktopConversation() &&
    !hub.selected?.remote &&
    (creating ||
      (hub.selected?.availability === "readable" &&
        ["codex", "claude-code", "antigravity"].includes(hub.selected.agent)));
  const history = useSessionHistory(hub.selected, hub.enabled && !interactive, hub.historyRevision);
  const resetFilters = useSessionViewStore((state) => state.resetFilters);
  const [enabling, setEnabling] = useState(false);
  const [enableError, setEnableError] = useState("");
  const enableLock = useRef(false);
  const historyRef = useRef<HTMLDivElement>(null);
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
    await withAsyncCleanup(
      async () => {
        try {
          useAppStore.getState().setRuntime(await api.setSessionIndexEnabled(true));
        } catch (error) {
          setEnableError(localizeMessage(error));
        }
      },
      () => {
        enableLock.current = false;
        setEnabling(false);
      },
    );
  };

  if (!hub.runtimeReady || hub.workspacesLoading)
    return (
      <div
        className="session-state flex min-w-0 flex-1 flex-col items-center justify-center gap-4 p-8 text-center"
        role="status"
      >
        <RefreshCw className="animate-spin" size={24} />
        <p className="max-w-[520px] leading-[1.7] text-muted-foreground">
          {tr("sessions.loading")}
        </p>
      </div>
    );
  if (!hub.enabled)
    return (
      <div className="session-state flex min-w-0 flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
        <Database size={32} />
        <h1 className="text-xl font-semibold">{tr("conversations.indexDisabled")}</h1>
        <p className="max-w-[520px] leading-[1.7] text-muted-foreground">
          {tr("sessions.enableDescription")}
        </p>
        {enableError && <Notice error>{enableError}</Notice>}
        <Button disabled={enabling} onClick={() => void enable()}>
          {tr(enabling ? "sessions.enabling" : "conversations.enable")}
        </Button>
      </div>
    );
  if (hub.workspacesError && !hub.workspaces.length)
    return (
      <div className="session-state flex min-w-0 flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
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

  const catalogNotice = hub.catalogError && (
    <Notice error>
      {hub.catalogError}
      <Button variant="ghost" disabled={hub.refreshing} onClick={() => void hub.refresh()}>
        {tr("sessions.retry")}
      </Button>
    </Notice>
  );

  if (interactive)
    return (
      <div className="session-hub-page flex min-w-0 min-h-0 flex-1 flex-col text-sm">
        {catalogNotice}
        <DesktopConversationPane
          sessionId={creating ? undefined : selected?.id}
          create={creating}
        />
      </div>
    );

  return (
    <div className="session-hub-page flex min-w-0 min-h-0 flex-1 flex-col text-sm">
      <div
        className="session-hub-body min-h-0 flex-1 overflow-auto overscroll-contain p-6 px-7 pb-8 [overflow-anchor:none] max-[600px]:p-4"
        ref={historyRef}
      >
        {catalogNotice}
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
            <div className="session-reading-context mx-auto flex max-w-[900px] flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground [overflow-wrap:anywhere]">
              <span>
                {selected.remote?.host_name ?? tr("sessions.local")} · {workspace?.name} ·{" "}
                {sessionAgentNames[selected.agent]}
              </span>
              <span>{tr("sessions.historyReadonly")}</span>
            </div>
            <Collapsible
              className="session-history-details mx-auto mt-2 max-w-[900px] text-xs text-muted-foreground"
              key={sessionKey}
            >
              <CollapsibleTrigger className="session-details-trigger flex w-fit cursor-pointer items-center gap-1 rounded focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-4 [&[data-panel-open]>svg]:rotate-90">
                <ChevronRight size={13} />
                {tr("sessions.historyDetails")}
              </CollapsibleTrigger>
              <CollapsibleContent
                className="session-history-details-content py-3 leading-[1.7]"
                keepMounted
              >
                {workspace?.path && (
                  <p className="session-detail-path mb-2 select-text [overflow-wrap:anywhere]">
                    {workspace.path}
                  </p>
                )}
                <div className="session-history-meta mb-4 flex flex-wrap gap-x-5 gap-y-3 text-muted-foreground [&>span]:flex [&>span]:items-center [&>span]:gap-1.5 [&>span]:[overflow-wrap:anywhere]">
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
                <div className="session-reading-description leading-[1.7]">
                  {tr(selected.remote ? "remote.sessionsReadonly" : "sessions.historyOnly")}
                  {selected.availability === "readable" && (
                    <p>{tr("history.latestWindow", { count: DEFAULT_SESSION_PAGE_SIZE })}</p>
                  )}
                </div>
              </CollapsibleContent>
            </Collapsible>
            {selected.remote && (
              <p className="session-remote-status mx-auto max-w-[900px] text-xs text-muted-foreground">
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
              <div className="session-state session-state-inline flex min-w-0 flex-1 flex-col items-center justify-center gap-4 p-7 px-5 text-center">
                <FileText size={28} />
                <h2 className="text-xl font-semibold">{tr("conversations.filter.metadata")}</h2>
                <p className="max-w-[520px] leading-[1.7] text-muted-foreground">
                  {tr("sessions.metadataDescription")}
                </p>
              </div>
            ) : history.loading ? (
              <div
                className="session-state session-state-inline flex min-w-0 flex-1 flex-col items-center justify-center gap-4 p-7 px-5 text-center"
                role="status"
              >
                <RefreshCw className="animate-spin" size={24} />
                <p className="max-w-[520px] leading-[1.7] text-muted-foreground">
                  {tr("sessions.loadingHistory")}
                </p>
              </div>
            ) : (
              <div className="session-transcript mx-auto mt-6 flex w-full max-w-3xl flex-col gap-5">
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
                  <p className="session-state-inline p-7 px-5 text-center text-muted-foreground">
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
            <p className="session-overview-description mb-5 leading-[1.7] text-muted-foreground">
              {tr(
                hub.remoteHosts?.length
                  ? "remote.aggregateDescription"
                  : "sessions.overviewDescription",
              )}
            </p>
            <div className="session-stats mb-6 grid grid-cols-4 gap-3 max-[600px]:grid-cols-2">
              {stats.map(([key, count]) => (
                <div
                  className="grid gap-2 rounded-xl bg-muted p-[18px] max-[600px]:p-3.5"
                  key={key}
                >
                  <strong className="text-[28px] leading-[1.2] font-[550] tabular-nums">
                    {count}
                  </strong>
                  <span className="text-muted-foreground">{tr(`sessions.stat.${key}`)}</span>
                </div>
              ))}
            </div>
            {hub.loading && <Notice>{tr("conversations.scanning")}</Notice>}
            <div className="session-overview-panels grid grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] items-stretch gap-[18px] max-[1199px]:grid-cols-1">
              <section className="session-overview-panel flex min-h-0 min-w-0 max-h-[min(58vh,680px)] flex-col overflow-hidden rounded-[14px] border border-border">
                <header className="flex shrink-0 items-center gap-[9px] p-5">
                  <Clock size={18} />
                  <h2 className="flex-1 text-base font-semibold">{tr("sessions.recent")}</h2>
                  <span className="text-muted-foreground">{hub.filtered.length}</span>
                </header>
                <div className="session-overview-panel-content min-h-0 flex-1 overflow-auto overscroll-contain [scrollbar-width:thin]">
                  {hub.filtered.slice(0, 12).map((session) => {
                    const source = hub.workspaces.find((item) => item.id === session.workspace_id);
                    return (
                      <Button
                        variant="bare"
                        size="content"
                        className="session-recent-item mx-4 flex w-[calc(100%-2rem)] flex-wrap items-start gap-2 border-t border-border px-1 py-3.5 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
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
                        <span className="grid min-w-0 flex-1 gap-[5px]">
                          <strong className="inline-flex items-center gap-1 font-[550] [overflow-wrap:anywhere]">
                            {displaySessionTitle(session.title, tr)}
                            {isInteractiveFork(session) && (
                              <GitBranch
                                size={12}
                                aria-label={`${tr("conversations.forked")}: ${sessionSourceLabel(session, hub.sessions, tr, formatDateTime)}`}
                              />
                            )}
                          </strong>
                          <small className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
                            {session.remote && `${session.remote.host_name} · `}
                            {source?.name} · {sessionAgentNames[session.agent]} ·{" "}
                            {sessionRecordLabel(session, tr)}
                          </small>
                        </span>
                        <time className="w-full pl-7 text-sm text-muted-foreground [overflow-wrap:anywhere]">
                          {session.updated_at
                            ? formatDateTime(session.updated_at)
                            : tr("conversations.unknownTime")}
                        </time>
                      </Button>
                    );
                  })}
                  {!hub.filtered.length && !hub.loading && !hub.catalogError && (
                    <div className="session-state-inline p-7 px-5 text-center">
                      <p className="text-muted-foreground">
                        {tr(hub.sessions.length ? "sessions.noMatches" : "sessions.noSessions")}
                      </p>
                      {hub.sessions.length > 0 && (
                        <Button variant="ghost" onClick={resetFilters}>
                          {tr("sessions.clearFilters")}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </section>
              <section className="session-overview-panel flex min-h-0 min-w-0 max-h-[min(58vh,680px)] flex-col overflow-hidden rounded-[14px] border border-border">
                <header className="flex shrink-0 items-center gap-[9px] p-5">
                  <Database size={18} />
                  <h2 className="flex-1 text-base font-semibold">{tr("sessions.indexStatus")}</h2>
                </header>
                <div className="session-overview-panel-content min-h-0 flex-1 overflow-auto overscroll-contain [scrollbar-width:thin]">
                  {statusWorkspaces.map((item) => (
                    <div
                      className="session-index-item mx-5 border-t border-border py-3.5 [overflow-wrap:anywhere] [&>p]:mt-2 [&>p]:text-muted-foreground"
                      key={item.id}
                    >
                      <strong className="font-semibold" title={item.path}>
                        {item.name}
                      </strong>
                      {hub.errors[item.id] && (
                        <p className="text-destructive">{hub.errors[item.id]}</p>
                      )}
                      {hub.statuses
                        .filter((status) => status.workspace_id === item.id)
                        .map((status) => (
                          <div
                            className="session-index-status flex flex-wrap gap-x-3 gap-y-1 pt-2 [&>span:nth-child(2)]:ml-auto [&_small]:w-full [&_small]:text-sm [&_small]:text-muted-foreground [&_p]:w-full [&_p]:text-sm"
                            key={`${item.id}:${status.agent}`}
                          >
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
                    <p className="session-state-inline p-7 px-5 text-center text-muted-foreground">
                      {tr(hub.workspaces.length ? "sessions.noMatches" : "sessions.noWorkspaces")}
                    </p>
                  )}
                </div>
              </section>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
