import { Input } from "@/components/ui/input";
import { SelectControl } from "@/components/ui/select-control";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  Archive,
  ArrowLeft,
  Bot,
  ChevronRight,
  CircleAlert,
  FileOutput,
  GitBranch,
  MessageSquareText,
  RefreshCw,
  Search,
  UserRound,
  Wrench,
} from "lucide-react";
import { api } from "@/core/api";
import { isTauriRuntime } from "@/core/platform";
import { AgentIcon } from "@/features/agents/AgentIcon";
import { formatDateTime, formatRelativeTime, localizeMessage, tr } from "@/core/i18n";
import type {
  AgentKind,
  ConversationEvent,
  ConversationIndexStatus,
  ConversationSessionSummary,
  PlannedSessionHandoff,
  WorkspaceSummary,
} from "@/core/types";
import { SessionHandoffDialog } from "./SessionHandoffDialog";
import { WorkspaceSessionsSkeleton } from "./WorkspaceSkeleton";

type SessionFilter = "current" | "archived" | "metadata" | "all";
type AgentFilter = "all" | ConversationSessionSummary["agent"];

function matchesSessionFilter(session: ConversationSessionSummary, filter: SessionFilter) {
  if (filter === "current") return !session.archived && session.availability === "readable";
  if (filter === "archived") return session.archived;
  if (filter === "metadata") return session.availability === "metadata-only";
  return true;
}

export function WorkspaceSessionsPage({
  workspace,
  enabled,
  onRuntimeChanged,
  onHandoffPlanned,
  targetAgents,
}: {
  workspace: WorkspaceSummary;
  enabled: boolean;
  onRuntimeChanged: (enabled: boolean) => Promise<void>;
  onHandoffPlanned: (handoff: PlannedSessionHandoff) => void;
  targetAgents: AgentKind[];
}) {
  const [sessions, setSessions] = useState<ConversationSessionSummary[]>([]);
  const [statuses, setStatuses] = useState<ConversationIndexStatus[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [events, setEvents] = useState<ConversationEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [warnings, setWarnings] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [agent, setAgent] = useState<AgentFilter>("all");
  const [filter, setFilter] = useState<SessionFilter>("current");
  const [refreshing, setRefreshing] = useState(false);
  const [reading, setReading] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [error, setError] = useState("");
  const [showDetail, setShowDetail] = useState(false);
  const [showHandoff, setShowHandoff] = useState(false);
  const readSequence = useRef(0);
  const cacheSequence = useRef(0);

  const reloadCache = async () => {
    const sequence = ++cacheSequence.current;
    const [nextSessions, nextStatuses] = await Promise.all([
      api.workspaceSessions(workspace.id),
      api.workspaceSessionStatus(workspace.id),
    ]);
    if (sequence !== cacheSequence.current) return;
    setSessions(nextSessions);
    setStatuses(nextStatuses);
  };

  const refresh = async (force: boolean) => {
    const sequence = ++cacheSequence.current;
    setRefreshing(true);
    setError("");
    try {
      const nextSessions = await api.refreshWorkspaceSessions(workspace.id, force);
      if (sequence !== cacheSequence.current) return;
      setSessions(nextSessions);
      const nextStatuses = await api.workspaceSessionStatus(workspace.id);
      if (sequence !== cacheSequence.current) return;
      setStatuses(nextStatuses);
    } catch (reason) {
      if (sequence === cacheSequence.current) setError(localizeMessage(reason));
    } finally {
      if (sequence === cacheSequence.current) setRefreshing(false);
    }
  };

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    if (!enabled) {
      setSessions([]);
      setStatuses([]);
      return;
    }
    setSessions([]);
    setStatuses([]);
    setSelectedId(undefined);
    setRefreshing(true);
    setError("");
    const sequence = ++cacheSequence.current;
    void (async () => {
      if (isTauriRuntime()) {
        unlisten = await listen<string>("agentkib:conversations-updated", (event) => {
          if (event.payload === workspace.id) void reloadCache();
        });
      }
      if (disposed) {
        unlisten?.();
        return;
      }
      try {
        const nextSessions = await api.refreshWorkspaceSessions(workspace.id, true);
        if (disposed || sequence !== cacheSequence.current) return;
        const nextStatuses = await api.workspaceSessionStatus(workspace.id);
        if (disposed || sequence !== cacheSequence.current) return;
        setSessions(nextSessions);
        setStatuses(nextStatuses);
      } catch (reason) {
        if (!disposed && sequence === cacheSequence.current) setError(localizeMessage(reason));
      } finally {
        if (!disposed && sequence === cacheSequence.current) setRefreshing(false);
      }
    })();
    return () => {
      disposed = true;
      cacheSequence.current += 1;
      readSequence.current += 1;
      unlisten?.();
    };
  }, [workspace.id, enabled]);

  const scopedSessions = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return sessions.filter((session) => {
      if (agent !== "all" && session.agent !== agent) return false;
      if (needle && !(session.title ?? "").toLocaleLowerCase().includes(needle)) return false;
      return true;
    });
  }, [agent, query, sessions]);
  const filterCounts = useMemo(
    () =>
      Object.fromEntries(
        (["current", "archived", "metadata", "all"] as SessionFilter[]).map((value) => [
          value,
          scopedSessions.filter((session) => matchesSessionFilter(session, value)).length,
        ]),
      ) as Record<SessionFilter, number>,
    [scopedSessions],
  );
  const filtered = useMemo(
    () => scopedSessions.filter((session) => matchesSessionFilter(session, filter)),
    [filter, scopedSessions],
  );

  const selected = sessions.find((session) => session.id === selectedId);
  useEffect(() => {
    if (selectedId && filtered.some((session) => session.id === selectedId)) return;
    setSelectedId(filtered[0]?.id);
    setShowDetail(false);
  }, [filtered, selectedId]);

  useEffect(() => {
    const sequence = ++readSequence.current;
    setEvents([]);
    setLoadingEarlier(false);
    setNextCursor(undefined);
    setWarnings([]);
    setError("");
    if (!selected || selected.availability !== "readable") {
      setReading(false);
      return;
    }
    setReading(true);
    void api
      .sessionEvents(selected.id)
      .then((page) => {
        if (sequence !== readSequence.current) return;
        setEvents(page.events);
        setNextCursor(page.next_cursor);
        setWarnings(page.warnings);
      })
      .catch((reason) => {
        if (sequence === readSequence.current) setError(localizeMessage(reason));
      })
      .finally(() => {
        if (sequence === readSequence.current) setReading(false);
      });
  }, [selected?.id, selected?.availability]);

  const loadEarlier = async () => {
    if (!selected || !nextCursor) return;
    const sequence = readSequence.current;
    const selectedSessionId = selected.id;
    const cursor = nextCursor;
    setLoadingEarlier(true);
    try {
      const page = await api.sessionEvents(selectedSessionId, cursor);
      if (sequence !== readSequence.current) return;
      setEvents((current) => [...page.events, ...current]);
      setNextCursor(page.next_cursor);
      setWarnings((current) => [...new Set([...page.warnings, ...current])]);
    } catch (reason) {
      if (sequence === readSequence.current) setError(localizeMessage(reason));
    } finally {
      if (sequence === readSequence.current) setLoadingEarlier(false);
    }
  };

  if (!enabled) {
    return (
      <div className="grid min-h-[calc(100vh-220px)] place-content-center justify-items-center p-6 text-center">
        <div className="grid max-w-sm justify-items-center gap-4 rounded-2xl border border-border/70 bg-card p-8 shadow-sm">
          <div className="grid size-12 place-items-center rounded-2xl bg-muted text-muted-foreground">
            <MessageSquareText size={22} />
          </div>
          <div className="grid gap-1.5">
            <strong className="text-base text-foreground">
              {tr("conversations.indexDisabled")}
            </strong>
            <span className="text-sm text-muted-foreground">
              {tr("conversations.settingsTitle")}
            </span>
          </div>
          <Button onClick={() => void onRuntimeChanged(true)}>{tr("conversations.enable")}</Button>
        </div>
      </div>
    );
  }

  if (refreshing && !sessions.length && !error) return <WorkspaceSessionsSkeleton />;

  return (
    <>
      <div className="grid min-h-[calc(100vh-150px)] grid-cols-[minmax(340px,380px)_minmax(0,1fr)] items-stretch gap-4 max-[760px]:relative max-[760px]:block">
        <Card
          className={`flex min-h-0 min-w-0 flex-col self-start overflow-hidden rounded-2xl border-border/70 bg-card shadow-sm max-h-[calc(100vh-150px)] max-[760px]:absolute max-[760px]:inset-0 max-[760px]:h-full max-[760px]:max-h-none ${showDetail ? "max-[760px]:hidden" : ""}`}
        >
          <div className="border-b border-border/70">
            <div className="flex items-center justify-between gap-3 px-4 pb-3 pt-4">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                  <MessageSquareText size={16} />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-foreground">
                    {tr("conversations.settingsTitle")}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {tr("conversations.sessionCount", { count: filtered.length })}
                  </p>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => void refresh(true)}
                disabled={refreshing}
                aria-label={tr("conversations.refresh")}
                title={tr("conversations.refresh")}
              >
                <RefreshCw size={15} className={refreshing ? "animate-spin" : ""} />
              </Button>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_126px] gap-2 px-4 pb-4 max-[640px]:grid-cols-1">
              <label className="flex h-10 min-w-0 items-center gap-2 rounded-lg border border-input bg-background px-3 text-muted-foreground transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/20">
                <Search size={15} />
                <Input
                  className="h-auto border-0 bg-transparent px-0 py-0 text-sm text-foreground shadow-none placeholder:text-muted-foreground focus-visible:ring-0"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={tr("conversations.searchPlaceholder")}
                />
              </label>
              <SelectControl
                className="h-10 min-w-0 border-input bg-background text-foreground"
                value={agent}
                onChange={(event) => setAgent(event.target.value as AgentFilter)}
                aria-label={tr("conversations.agentFilter")}
              >
                <option value="all">{tr("conversations.allAgents")}</option>
                <option value="codex">Codex</option>
                <option value="claude-code">Claude Code</option>
              </SelectControl>
            </div>
          </div>
          <Tabs value={filter} onValueChange={(value) => setFilter(value as SessionFilter)}>
            <TabsList
              className="segmented-control flex w-full justify-start"
              variant="default"
              aria-label={tr("conversations.filterLabel")}
            >
              {(["current", "archived", "metadata", "all"] as SessionFilter[]).map((value) => (
                <TabsTrigger
                  key={value}
                  value={value}
                  className="segmented-control-item h-9 min-h-9 flex-none gap-1.5 px-2.5 text-xs"
                >
                  <span>{tr(`conversations.filter.${value}`)}</span>
                  <Badge
                    variant={filter === value ? "default" : "secondary"}
                    className="!rounded-full !px-1.5 !py-0 !text-[10px]"
                  >
                    {filterCounts[value]}
                  </Badge>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          {statuses.length > 0 && (
            <div className="grid gap-1.5 border-b border-border/70 bg-muted/20 px-4 py-3">
              {statuses.map((status) => {
                const sourceSessions = sessions.filter((session) => session.agent === status.agent);
                const readable = sourceSessions.filter(
                  (session) => session.availability === "readable",
                ).length;
                return (
                  <span
                    className="grid min-h-8 grid-cols-[36px_auto_minmax(0,1fr)] items-center gap-2.5 text-xs"
                    key={status.agent}
                  >
                    <AgentIcon agent={status.agent} />
                    <strong className="font-medium text-foreground">
                      {status.agent === "codex" ? "Codex" : "Claude Code"}
                    </strong>
                    <em className="overflow-hidden text-right text-muted-foreground [text-overflow:ellipsis] whitespace-nowrap not-italic">
                      {tr("conversations.sourceCoverage", {
                        total: status.session_count,
                        readable,
                      })}
                    </em>
                  </span>
                );
              })}
            </div>
          )}
          {statuses.some((status) => status.freshness !== "fresh") && (
            <div className="flex min-h-[38px] items-center gap-2 border-b border-amber-200/70 bg-amber-50/70 px-4 py-2.5 text-xs text-amber-800">
              <CircleAlert size={14} />
              <span>{tr("conversations.partialIndex")}</span>
            </div>
          )}
          <div role="list" className="min-h-0 flex-1 overflow-auto p-2">
            {filtered.map((session) => (
              <Button
                variant="bare"
                size="content"
                key={session.id}
                role="listitem"
                className={`group mb-1 grid min-h-[82px] w-full grid-cols-[36px_minmax(0,1fr)_16px] items-start gap-3 rounded-xl border px-3 py-3 text-left transition-colors duration-200 ${selected?.id === session.id ? "border-primary/20 bg-accent-soft ring-1 ring-primary/5" : "border-transparent hover:border-border/70 hover:bg-muted/60"}`}
                onClick={() => {
                  setSelectedId(session.id);
                  setShowDetail(true);
                }}
              >
                <AgentIcon agent={session.agent} />
                <span className="min-w-0">
                  <span className="flex min-w-0 items-center gap-2">
                    <strong className="truncate text-sm">
                      {session.title || tr("conversations.untitled")}
                    </strong>
                    {session.availability === "metadata-only" && (
                      <Badge
                        variant="secondary"
                        className="shrink-0 !rounded-full !px-1.5 !py-0 !text-[10px]"
                      >
                        {tr("conversations.metadataOnly")}
                      </Badge>
                    )}
                  </span>
                  <small className="mt-1 block truncate text-xs text-muted-foreground">
                    {session.updated_at
                      ? formatRelativeTime(session.updated_at)
                      : tr("conversations.unknownTime")}
                    {session.message_count !== undefined
                      ? ` · ${tr("conversations.messageCount", { count: session.message_count })}`
                      : ""}
                  </small>
                  <em className="mt-1.5 flex min-h-4 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground not-italic">
                    {session.git_branch && (
                      <span className="inline-flex min-w-0 max-w-full items-center gap-1 truncate">
                        <GitBranch size={11} className="shrink-0" />
                        {session.git_branch}
                      </span>
                    )}
                    {session.archived && (
                      <span className="inline-flex items-center gap-1">
                        <Archive size={11} />
                        {tr("conversations.archived")}
                      </span>
                    )}
                    {session.sidechain && <span>{tr("conversations.sidechain")}</span>}
                  </em>
                </span>
                <ChevronRight
                  size={15}
                  className={`mt-1 transition-transform duration-200 ${selected?.id === session.id ? "text-foreground" : "text-muted-foreground/60 group-hover:translate-x-0.5 group-hover:text-foreground"}`}
                />
              </Button>
            ))}
            {!filtered.length && (
              <div className="grid min-h-[220px] place-content-center justify-items-center gap-3 p-6 text-center text-muted-foreground">
                <span className="grid size-10 place-items-center rounded-xl bg-muted">
                  <MessageSquareText size={19} />
                </span>
                <strong className="max-w-[250px] text-sm text-foreground">
                  {tr(
                    filter === "current" && filterCounts.metadata > 0
                      ? "conversations.metadataAvailable"
                      : "conversations.empty",
                    { count: filterCounts.metadata },
                  )}
                </strong>
                {filter === "current" && filterCounts.metadata > 0 && (
                  <Button variant="outline" size="sm" onClick={() => setFilter("metadata")}>
                    {tr("conversations.viewMetadata")}
                  </Button>
                )}
              </div>
            )}
          </div>
        </Card>
        <Card
          className={`grid min-w-0 min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-2xl border-border/70 bg-card shadow-sm max-[760px]:absolute max-[760px]:inset-0 ${showDetail ? "max-[760px]:grid" : "max-[760px]:hidden"}`}
        >
          <header className="flex min-h-[88px] items-center gap-3 border-b border-border/70 px-5 py-4">
            <Button
              variant="ghost"
              size="icon-sm"
              className="-ml-1 hidden shrink-0 text-muted-foreground hover:bg-muted hover:text-foreground max-[760px]:inline-flex"
              onClick={() => setShowDetail(false)}
              aria-label={tr("conversations.back")}
            >
              <ArrowLeft size={16} />
            </Button>
            {selected ? (
              <>
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <AgentIcon agent={selected.agent} />
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <h2 className="truncate text-base font-semibold tracking-tight text-foreground">
                        {selected.title || tr("conversations.untitled")}
                      </h2>
                      {selected.availability === "metadata-only" && (
                        <Badge
                          variant="secondary"
                          className="shrink-0 !rounded-full !px-1.5 !py-0 !text-[10px]"
                        >
                          {tr("conversations.metadataOnly")}
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {selected.updated_at
                        ? formatDateTime(selected.updated_at)
                        : tr("conversations.unknownTime")}
                      {selected.git_branch ? ` · ${selected.git_branch}` : ""}
                    </p>
                  </div>
                </div>
                {selected.availability === "readable" && events.length > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={() => setShowHandoff(true)}
                  >
                    <FileOutput size={14} />
                    {tr("handoff.create")}
                  </Button>
                )}
              </>
            ) : (
              <div className="flex items-center gap-3 text-muted-foreground">
                <span className="grid size-9 place-items-center rounded-xl bg-muted">
                  <MessageSquareText size={17} />
                </span>
                <strong className="text-sm text-foreground">
                  {tr("conversations.selectSession")}
                </strong>
              </div>
            )}
          </header>
          <div className="min-h-0 overflow-auto bg-muted/15">
            {error && (
              <div
                role="alert"
                aria-live="assertive"
                className="mx-5 mt-5 flex items-start gap-2 rounded-xl border border-destructive/25 bg-destructive/10 px-4 py-3 text-sm text-destructive"
              >
                <CircleAlert size={16} className="mt-0.5 shrink-0" />
                {error}
              </div>
            )}
            {warnings.map((warning) => (
              <div
                className="mx-5 mt-4 flex items-start gap-2 rounded-xl border border-amber-200/70 bg-amber-50/70 px-4 py-3 text-xs text-amber-800"
                key={warning}
              >
                <CircleAlert size={15} className="mt-0.5 shrink-0" />
                <span>{tr("conversations.damagedLines")}</span>
              </div>
            ))}
            {!selected && (
              <div className="grid min-h-[420px] place-content-center justify-items-center gap-3 p-8 text-center text-muted-foreground">
                <span className="grid size-12 place-items-center rounded-2xl bg-background shadow-sm ring-1 ring-border/70">
                  <MessageSquareText size={22} />
                </span>
                <strong className="text-sm text-foreground">
                  {tr("conversations.selectSession")}
                </strong>
              </div>
            )}
            {selected?.availability === "metadata-only" && (
              <div className="grid min-h-[420px] place-content-center justify-items-center gap-3 p-8 text-center text-muted-foreground">
                <span className="grid size-12 place-items-center rounded-2xl bg-background shadow-sm ring-1 ring-border/70">
                  <Archive size={21} />
                </span>
                <strong className="text-sm text-foreground">
                  {tr("conversations.metadataOnly")}
                </strong>
                <span className="max-w-xs text-xs leading-relaxed">
                  {tr("conversations.metadataOnlyDetail")}
                </span>
              </div>
            )}
            {selected?.availability === "readable" && (
              <div className="flex min-h-full flex-col gap-3 p-5">
                {nextCursor && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="self-center"
                    disabled={loadingEarlier}
                    onClick={() => void loadEarlier()}
                  >
                    {tr(loadingEarlier ? "common.loading" : "conversations.loadEarlier")}
                  </Button>
                )}
                {reading && (
                  <div className="grid min-h-[180px] place-content-center justify-items-center gap-2 text-sm text-muted-foreground">
                    <RefreshCw className="animate-spin" size={18} />
                    <span>{tr("conversations.reading")}</span>
                  </div>
                )}
                {!reading && !events.length && !error && (
                  <div className="grid min-h-[220px] place-content-center justify-items-center gap-3 text-center text-muted-foreground">
                    <span className="grid size-10 place-items-center rounded-xl bg-background ring-1 ring-border/70">
                      <MessageSquareText size={19} />
                    </span>
                    <strong className="text-sm text-foreground">
                      {tr("conversations.noReadableEvents")}
                    </strong>
                  </div>
                )}
                {events.map((event) => (
                  <ConversationEventRow key={event.id} event={event} />
                ))}
              </div>
            )}
          </div>
        </Card>
      </div>
      {showHandoff && selected && (
        <SessionHandoffDialog
          workspace={workspace}
          session={selected}
          targetAgents={targetAgents}
          onClose={() => setShowHandoff(false)}
          onPlanned={(changeSet) => {
            setShowHandoff(false);
            onHandoffPlanned(changeSet);
          }}
        />
      )}
    </>
  );
}

function ConversationEventRow({ event }: { event: ConversationEvent }) {
  if (event.kind === "tool-summary") {
    return (
      <div className="flex min-h-[38px] items-center gap-2 rounded-lg border border-border/70 bg-background px-3 py-2 text-xs text-muted-foreground shadow-xs">
        <span className="grid size-5 place-items-center rounded-md bg-muted">
          <Wrench size={12} />
        </span>
        <strong className="text-foreground">{event.tool_name || tr("conversations.tool")}</strong>
        <span>{tr(`conversations.toolStatus.${event.tool_status ?? "unknown"}`)}</span>
        {(event.timestamp || event.duration_ms !== undefined) && (
          <time className="ml-auto text-[11px]">
            {event.timestamp ? formatDateTime(event.timestamp) : ""}
            {event.timestamp && event.duration_ms !== undefined ? " · " : ""}
            {event.duration_ms !== undefined ? formatDuration(event.duration_ms) : ""}
          </time>
        )}
      </div>
    );
  }
  const isUser = event.kind === "user-message";
  return (
    <article
      className={`max-w-[min(820px,92%)] self-start rounded-2xl border px-4 py-3.5 shadow-xs ${isUser ? "ml-auto border-primary bg-primary text-primary-foreground" : "border-border/70 bg-card text-foreground"}`}
    >
      <header
        className={`mb-2.5 flex items-center gap-1.5 text-xs ${isUser ? "text-primary-foreground/70" : "text-muted-foreground"}`}
      >
        {isUser ? <UserRound size={14} /> : <Bot size={14} />}
        <strong className={isUser ? "text-primary-foreground" : "text-foreground"}>
          {tr(isUser ? "conversations.you" : "conversations.agent")}
        </strong>
        {event.timestamp && <time className="ml-auto">{formatDateTime(event.timestamp)}</time>}
      </header>
      <div className="select-text text-sm leading-7 whitespace-pre-wrap [overflow-wrap:anywhere]">
        {event.content}
      </div>
      {(event.attachment_count > 0 || event.truncated) && (
        <footer
          className={`mt-3 flex gap-2 text-xs ${isUser ? "text-primary-foreground/70" : "text-muted-foreground"}`}
        >
          {event.attachment_count > 0 && (
            <span>{tr("conversations.attachments", { count: event.attachment_count })}</span>
          )}
          {event.truncated && <span>{tr("conversations.contentTruncated")}</span>}
        </footer>
      )}
    </article>
  );
}

function formatDuration(milliseconds: number) {
  return milliseconds < 1000 ? `${milliseconds} ms` : `${(milliseconds / 1000).toFixed(1)} s`;
}
