import { useI18n } from "@/core/useI18n";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { ConversationEventRow } from "@/features/sessions/ConversationEventRow";
import { HistoryError, HistoryWarning } from "@/features/sessions/HistoryFeedback";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArrowLeft,
  Check,
  ChevronRight,
  CircleAlert,
  FileOutput,
  GitBranch,
  ListFilter,
  ListChecks,
  MessageSquareText,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { api } from "@/core/api";
import { DEFAULT_SESSION_PAGE_SIZE } from "@/core/session-history";
import { AgentIcon } from "@/features/agents/AgentIcon";
import { canContinueFromHistory } from "@/features/agents/agent-capabilities";
import { withAsyncCleanup } from "@/lib/utils";

import type {
  AgentKind,
  ChangeSet,
  ConversationEvent,
  ConversationIndexStatus,
  ConversationSessionSummary,
  PlannedSessionHandoff,
  WorkspaceSummary,
} from "@/core/types";
import { SessionHandoffDialog } from "./SessionHandoffDialog";
import { displaySessionTitle } from "./session-title";
import {
  isInteractiveFork,
  sessionSourceLabel,
  sessionSourceDetails,
  sessionAgentNames,
} from "@/features/sessions/session-labels";
import { isSessionVisible } from "@/features/sessions/session-catalog";
import { useSessionViewStore } from "@/features/sessions/session-view-store";

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
  onMcpConnectionPlanned,
  initialSessionId,
  onInitialSessionConsumed,
  resumeContinuation,
  onResumeConsumed,
  targetAgents,
}: {
  workspace: WorkspaceSummary;
  enabled: boolean;
  onRuntimeChanged: (enabled: boolean) => Promise<void>;
  onHandoffPlanned: (handoff: PlannedSessionHandoff) => void;
  onMcpConnectionPlanned: (changeSet: ChangeSet, request: SessionContinuationResume) => void;
  initialSessionId?: string;
  onInitialSessionConsumed?: () => void;
  resumeContinuation?: SessionContinuationResume & { autoPrepare: boolean };
  onResumeConsumed?: () => void;
  targetAgents: AgentKind[];
}) {
  const { formatDateTime, formatRelativeTime, localizeMessage, tr } = useI18n();
  const [sessions, setSessions] = useState<ConversationSessionSummary[]>([]);
  const [statuses, setStatuses] = useState<ConversationIndexStatus[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [events, setEvents] = useState<ConversationEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [warnings, setWarnings] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [agent, setAgent] = useState<AgentFilter>("all");
  const [filter, setFilter] = useState<SessionFilter>("current");
  const [refreshing, setRefreshing] = useState(false);
  const [slowLoading, setSlowLoading] = useState(false);
  const [reading, setReading] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [rawError, setError] = useState<unknown>("");
  const [historyError, setHistoryError] = useState(false);
  const [readRevision, setReadRevision] = useState(0);
  const error = rawError === "" ? "" : localizeMessage(rawError);
  const [showDetail, setShowDetail] = useState(false);
  const [showHandoff, setShowHandoff] = useState(false);
  const [resumedRequest, setResumedRequest] = useState<
    (SessionContinuationResume & { autoPrepare: boolean }) | undefined
  >();
  const readSequence = useRef(0);
  const earlierRequest = useRef<number | null>(null);
  const cacheSequence = useRef(0);
  const consumedInitialSession = useRef<string | undefined>(undefined);
  const showAuxiliary = useSessionViewStore((state) => state.showAuxiliary);
  const setShowAuxiliary = useSessionViewStore((state) => state.setShowAuxiliary);
  const revealSession = useSessionViewStore((state) => state.revealSession);

  const refresh = async (force: boolean) => {
    const sequence = ++cacheSequence.current;
    setRefreshing(true);
    setError("");
    await withAsyncCleanup(
      async () => {
        try {
          const nextSessions = await api.refreshWorkspaceSessions(workspace.id, force);
          if (sequence !== cacheSequence.current) return;
          setSessions(nextSessions);
          const nextStatuses = await api.workspaceSessionStatus(workspace.id);
          if (sequence !== cacheSequence.current) return;
          setStatuses(nextStatuses);
        } catch (reason) {
          if (sequence === cacheSequence.current) {
            setHistoryError(false);
            setError(reason);
          }
        }
      },
      () => {
        if (sequence === cacheSequence.current) setRefreshing(false);
      },
    );
  };

  useEffect(() => {
    let disposed = false;
    if (!enabled) {
      setSessions([]);
      setStatuses([]);
      return;
    }
    setSessions([]);
    setStatuses([]);
    setSelectedId(undefined);
    setRefreshing(true);
    setSlowLoading(false);
    setError("");
    const sequence = ++cacheSequence.current;
    void withAsyncCleanup(
      async () => {
        try {
          const [cachedSessions, cachedStatuses] = await Promise.all([
            api.workspaceSessions(workspace.id).catch(() => []),
            api.workspaceSessionStatus(workspace.id).catch(() => []),
          ]);
          if (disposed || sequence !== cacheSequence.current) return;
          setSessions(cachedSessions);
          setStatuses(cachedStatuses);
          const nextSessions = await api.refreshWorkspaceSessions(workspace.id, false);
          if (disposed || sequence !== cacheSequence.current) return;
          setSessions(nextSessions);
          const nextStatuses = await api.workspaceSessionStatus(workspace.id);
          if (disposed || sequence !== cacheSequence.current) return;
          setStatuses(nextStatuses);
        } catch (reason) {
          if (!disposed && sequence === cacheSequence.current) {
            setHistoryError(false);
            setError(reason);
          }
        }
      },
      () => {
        if (!disposed && sequence === cacheSequence.current) setRefreshing(false);
      },
    );
    return () => {
      disposed = true;
      cacheSequence.current += 1;
      readSequence.current += 1;
    };
  }, [workspace.id, enabled]);

  useEffect(() => {
    if (!refreshing || sessions.length > 0) {
      setSlowLoading(false);
      return;
    }
    const timer = window.setTimeout(() => setSlowLoading(true), 3000);
    return () => window.clearTimeout(timer);
  }, [refreshing, sessions.length]);

  const visibleSessions = useMemo(
    () => sessions.filter((session) => isSessionVisible(session, showAuxiliary)),
    [sessions, showAuxiliary],
  );
  const scopedSessions = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return visibleSessions.filter((session) => {
      if (agent !== "all" && session.agent !== agent) return false;
      if (needle && !(session.title ?? "").toLocaleLowerCase().includes(needle)) return false;
      return true;
    });
  }, [agent, query, visibleSessions]);
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
  const selectedSources = selected
    ? sessionSourceDetails(selected, sessions, tr, formatDateTime)
    : [];
  useEffect(() => {
    if (selectedId && filtered.some((session) => session.id === selectedId)) return;
    setSelectedId(filtered[0]?.id);
    setShowDetail(false);
  }, [filtered, selectedId]);

  useEffect(() => {
    if (!initialSessionId || consumedInitialSession.current === initialSessionId) return;
    if (!sessions.some(({ id }) => id === initialSessionId)) return;
    consumedInitialSession.current = initialSessionId;
    revealSession(sessions.find(({ id }) => id === initialSessionId)!);
    setFilter("all");
    setSelectedId(initialSessionId);
    setShowDetail(true);
    onInitialSessionConsumed?.();
  }, [initialSessionId, onInitialSessionConsumed, revealSession, sessions]);

  useEffect(() => {
    if (!resumeContinuation || !sessions.some(({ id }) => id === resumeContinuation.sessionId)) {
      return;
    }
    const target = sessions.find(({ id }) => id === resumeContinuation.sessionId);
    if (!target) return;
    if (!canContinueFromHistory(target.agent)) {
      onResumeConsumed?.();
      return;
    }
    revealSession(target);
    setFilter("all");
    setSelectedId(resumeContinuation.sessionId);
    setResumedRequest(resumeContinuation);
    setShowDetail(true);
    setShowHandoff(true);
    onResumeConsumed?.();
  }, [onResumeConsumed, resumeContinuation, revealSession, sessions]);

  useEffect(() => {
    const sequence = ++readSequence.current;
    earlierRequest.current = null;
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
        if (sequence === readSequence.current) {
          setHistoryError(true);
          setError(reason);
        }
      })
      .finally(() => {
        if (sequence === readSequence.current) setReading(false);
      });
  }, [selected?.id, selected?.availability, readRevision]);

  const loadEarlier = async () => {
    if (!selected || !nextCursor || reading || earlierRequest.current !== null) return;
    const sequence = readSequence.current;
    earlierRequest.current = sequence;
    const selectedSessionId = selected.id;
    const cursor = nextCursor;
    setLoadingEarlier(true);
    setError("");
    await withAsyncCleanup(
      async () => {
        try {
          const page = await api.sessionEvents(selectedSessionId, cursor);
          if (sequence !== readSequence.current) return;
          setEvents((current) => {
            const seen = new Set<string>();
            return [...page.events, ...current].filter((event) => {
              if (seen.has(event.id)) return false;
              seen.add(event.id);
              return true;
            });
          });
          setNextCursor(page.next_cursor);
          setWarnings((current) => [
            ...new Set([
              ...page.warnings,
              ...current.filter((warning) => warning !== "TRANSCRIPT_SCAN_BUDGET"),
            ]),
          ]);
        } catch (reason) {
          if (sequence === readSequence.current) {
            setHistoryError(true);
            setError(reason);
          }
        }
      },
      () => {
        if (sequence === readSequence.current) {
          earlierRequest.current = null;
          setLoadingEarlier(false);
        }
      },
    );
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

  if (refreshing && !sessions.length && !error) {
    return (
      <div className="grid min-h-[calc(100vh-220px)] place-content-center justify-items-center gap-3 p-6 text-center">
        <RefreshCw className="animate-spin text-muted-foreground" size={22} />
        <strong className="text-sm text-foreground">{tr("conversations.scanning")}</strong>
        {slowLoading && (
          <span className="max-w-sm text-xs leading-relaxed text-muted-foreground">
            {tr("conversations.scanningSlow")}
          </span>
        )}
      </div>
    );
  }

  return (
    <>
      <div className="grid h-[calc(100vh-150px)] max-h-[calc(100vh-150px)] min-h-0 grid-cols-[minmax(340px,380px)_minmax(0,1fr)] items-stretch gap-4 max-[760px]:relative max-[760px]:h-full max-[760px]:max-h-none max-[760px]:block">
        <Card
          className={`flex min-h-0 min-w-0 flex-col self-start overflow-hidden rounded-2xl border-border/70 bg-card shadow-sm max-h-[calc(100vh-150px)] max-[760px]:absolute max-[760px]:inset-0 max-[760px]:h-full max-[760px]:max-h-none ${showDetail ? "max-[760px]:hidden" : ""}`}
        >
          <div className="border-b border-border/70 px-3 py-3">
            <div className="flex min-h-8 items-center gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <p className="truncate text-sm font-semibold text-foreground">
                  {tr("conversations.listTitle")}
                </p>
                <Badge
                  variant="outline"
                  className="shrink-0 border-transparent bg-muted text-muted-foreground !rounded-full !px-2 !py-0.5 !text-xs tabular-nums"
                >
                  {filtered.length}
                </Badge>
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-0.5">
                <DropdownMenu>
                  <DropdownMenuTrigger
                    className={`inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground ${agent !== "all" ? "bg-accent text-accent-foreground" : ""}`}
                    aria-label={tr("conversations.agentFilter")}
                    title={tr("conversations.agentFilter")}
                  >
                    <ListFilter size={16} />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-40">
                    <DropdownMenuGroup>
                      <DropdownMenuLabel>{tr("conversations.agentFilter")}</DropdownMenuLabel>
                      {[
                        ["all", tr("conversations.allAgents")],
                        ...Object.entries(sessionAgentNames).filter(
                          ([value]) =>
                            sessions.some((session) => session.agent === value) || agent === value,
                        ),
                      ].map(([value, label]) => (
                        <DropdownMenuItem
                          key={value}
                          onClick={() => setAgent(value as AgentFilter)}
                          className="pr-2"
                        >
                          <span className="grid size-4 place-items-center">
                            {agent === value && <Check size={14} />}
                          </span>
                          {label}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    className={`inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground ${filter !== "current" || showAuxiliary ? "bg-accent text-accent-foreground" : ""}`}
                    aria-label={tr("conversations.filterLabel")}
                    title={tr(`conversations.filter.${filter}`)}
                  >
                    <ListChecks size={16} />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-44">
                    <DropdownMenuGroup>
                      <DropdownMenuLabel>{tr("conversations.filterLabel")}</DropdownMenuLabel>
                      {(["current", "archived", "metadata", "all"] as SessionFilter[]).map(
                        (value) => (
                          <DropdownMenuItem
                            key={value}
                            onClick={() => setFilter(value)}
                            className="pr-2"
                          >
                            <span className="grid size-4 place-items-center">
                              {filter === value && <Check size={14} />}
                            </span>
                            <span>{tr(`conversations.filter.${value}`)}</span>
                            <Badge
                              variant="outline"
                              className="ml-auto border-transparent bg-muted text-muted-foreground !rounded-full !px-1.5 !py-0 !text-[10px] tabular-nums"
                            >
                              {filterCounts[value]}
                            </Badge>
                          </DropdownMenuItem>
                        ),
                      )}
                      <DropdownMenuCheckboxItem
                        checked={showAuxiliary}
                        onCheckedChange={(checked) => setShowAuxiliary(checked === true)}
                      >
                        {tr("conversations.showAuxiliary")}
                      </DropdownMenuCheckboxItem>
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={`text-muted-foreground hover:bg-muted hover:text-foreground ${searchOpen ? "bg-muted text-foreground" : ""}`}
                  onClick={() => setSearchOpen((open) => !open)}
                  aria-label={tr("conversations.searchPlaceholder")}
                  aria-expanded={searchOpen}
                  title={tr("conversations.searchPlaceholder")}
                >
                  <Search size={16} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => void refresh(true)}
                  disabled={refreshing}
                  aria-label={tr("conversations.refresh")}
                  title={tr("conversations.refresh")}
                >
                  <RefreshCw size={16} className={refreshing ? "animate-spin" : ""} />
                </Button>
              </div>
            </div>
            {searchOpen && (
              <label className="mt-3 flex h-9 min-w-0 items-center gap-2 rounded-lg border border-input bg-background px-3 text-muted-foreground transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/20">
                <Search size={15} />
                <Input
                  autoFocus
                  className="h-auto min-w-0 border-0 bg-transparent px-0 py-0 text-sm text-foreground shadow-none placeholder:text-muted-foreground focus-visible:ring-0"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={tr("conversations.searchPlaceholder")}
                />
                {query && (
                  <Button
                    variant="bare"
                    size="icon-xs"
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                    onClick={() => setQuery("")}
                    aria-label={tr("common.clear")}
                    title={tr("common.clear")}
                  >
                    <X size={14} />
                  </Button>
                )}
              </label>
            )}
          </div>
          {statuses.some((status) => status.freshness !== "fresh") && (
            <div className="flex min-h-[38px] items-center gap-2 border-b border-amber-200/70 bg-amber-50/70 px-4 py-2.5 text-xs text-amber-800">
              <CircleAlert size={14} />
              <span>{tr("conversations.partialIndex")}</span>
            </div>
          )}
          <div role="list" className="min-h-0 flex-1 overflow-auto p-2">
            {filtered.map((session) => {
              const sourceLabel = sessionSourceLabel(session, sessions, tr, formatDateTime);
              return (
                <Button
                  variant="bare"
                  size="content"
                  key={session.id}
                  role="listitem"
                  title={sourceLabel || undefined}
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
                        {displaySessionTitle(session.title, tr)}
                      </strong>
                      {isInteractiveFork(session) && (
                        <GitBranch
                          size={12}
                          aria-label={`${tr("conversations.forked")}: ${sourceLabel}`}
                        />
                      )}
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
                      {session.message_count != null
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
              );
            })}
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
                  <Button variant="outline" onClick={() => setFilter("metadata")}>
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
                        {displaySessionTitle(selected.title, tr)}
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
                    {selected?.origin === "auxiliary" && !selectedSources.length && (
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {tr("conversations.auxiliary")}
                      </span>
                    )}
                    {selectedSources.map((source) =>
                      source.session ? (
                        <Button
                          key={`${source.kind}:${source.id}`}
                          variant="link"
                          size="sm"
                          className="mt-1 h-auto max-w-full justify-start truncate p-0 text-xs"
                          title={source.label}
                          aria-label={source.label}
                          onClick={() => {
                            revealSession(source.session!);
                            setQuery("");
                            setAgent("all");
                            setFilter("all");
                            setSelectedId(source.session!.id);
                            setShowDetail(true);
                          }}
                        >
                          {source.kind === "forked" && <GitBranch size={12} />}
                          {source.label}
                        </Button>
                      ) : (
                        <span
                          key={`${source.kind}:${source.id}`}
                          className="mt-1 block truncate text-xs text-muted-foreground"
                          title={source.label}
                        >
                          {source.label}
                        </span>
                      ),
                    )}
                  </div>
                </div>
                {selected.availability === "readable" &&
                  canContinueFromHistory(selected.agent) &&
                  events.length > 0 && (
                    <Button
                      variant="outline"
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
              <div className="mx-5 mt-5">
                {historyError ? (
                  <HistoryError
                    error={rawError}
                    onRetry={() => setReadRevision((value) => value + 1)}
                  />
                ) : (
                  <div
                    role="alert"
                    className="rounded-xl border border-destructive/25 bg-destructive/10 px-4 py-3 text-sm text-destructive"
                  >
                    {error}
                  </div>
                )}
              </div>
            )}
            {warnings.length > 0 && (
              <div className="mx-5 mt-4 grid gap-2">
                {warnings.map((warning) => (
                  <HistoryWarning key={warning} warning={warning} />
                ))}
              </div>
            )}
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
                <p className="text-sm text-muted-foreground">
                  {tr("history.latestWindow", { count: DEFAULT_SESSION_PAGE_SIZE })}
                </p>
                {nextCursor && (
                  <Button
                    variant="outline"
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
                      {tr(nextCursor ? "history.emptyWindow" : "conversations.noReadableEvents")}
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
          onClose={() => {
            setShowHandoff(false);
            setResumedRequest(undefined);
          }}
          onPlanned={(changeSet) => {
            setShowHandoff(false);
            setResumedRequest(undefined);
            onHandoffPlanned(changeSet);
          }}
          onMcpConnectionPlanned={onMcpConnectionPlanned}
          initialRequest={resumedRequest?.sessionId === selected.id ? resumedRequest : undefined}
        />
      )}
    </>
  );
}

export interface SessionContinuationResume {
  sessionId: string;
  targetAgent: AgentKind;
  historyBudgetTokens: number;
  format: import("@/core/types").HandoffFormat;
}
