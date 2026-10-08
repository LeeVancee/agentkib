import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Search } from "lucide-react";
import {
  ApiError,
  literalHistoryMatchRanges,
  type Access,
  type WebClient,
  type HistorySearchHit,
  type HistorySearchResult,
  type HistorySearchStatus,
  type HistoryLocatedRecord,
  type HistoryLocation,
  type ResolvedHistoryReference,
} from "@agentkib/web-client";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { NativeSelect } from "../../components/ui/native-select";
import { Dialog } from "../../components/dialog";
import type { Locale } from "../../i18n";
import { historyCopy } from "./history-copy";

export function historyAccessScope(access: Access | undefined): string {
  return access?.status === "approved" && access.historySearch
    ? JSON.stringify([access.bootId, access.device?.id, access.historySearchScope])
    : "";
}
export function HighlightedHistoryText({
  text,
  ranges,
}: {
  text: string;
  ranges: Array<[number, number]>;
}) {
  const nodes: ReactNode[] = [];
  let start = 0;
  for (const [from, to] of ranges) {
    if (
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(to) ||
      from < start ||
      to <= from ||
      to > text.length
    )
      continue;
    nodes.push(
      text.slice(start, from),
      <mark
        key={`${from}:${to}`}
        className="rounded bg-amber-200 text-black dark:bg-amber-500/40 dark:text-foreground"
      >
        {text.slice(from, to)}
      </mark>,
    );
    start = to;
  }
  nodes.push(text.slice(start));
  return <>{nodes}</>;
}
export function HistoryCoverageStatus({
  status,
  locale,
}: {
  status: HistorySearchStatus;
  locale: Locale;
}) {
  const c = historyCopy[locale],
    v = status.coverage;
  return (
    <div className="space-y-1 text-xs text-muted-foreground" role="status">
      <p>
        {c.coverage}: {c.ready} {v.ready}/{v.total} · {c.building} {v.building} · {c.partial}{" "}
        {v.partial} · {c.staleCount} {v.stale} · {c.unavailable} {v.unavailable}
      </p>
      {!!status.sources?.length && (
        <ul aria-label={c.sources} className="space-y-1">
          {status.sources.map((source) => (
            <li key={source.agent}>
              {source.agent}: {c.messages} {c[source.body]} · {c.tools} {c[source.tools]}
            </li>
          ))}
        </ul>
      )}
      {!!v.limitations.length && <p>{v.limitations.join(" · ")}</p>}
      {status.budgetExceeded && <p>{c.budget}</p>}
    </div>
  );
}
export interface HistorySearchPanelProps {
  client: WebClient;
  locale: Locale;
  scope: string;
  initialQuery?: string;
  onReference?: (reference: ResolvedHistoryReference) => void;
  onScopeEnded?: () => void;
}
function sourceSelectionRange(content: string, start: number, end: number): [number, number] {
  let sourceStart = start;
  let sourceEnd = end;
  // Textareas expose LF-normalized UTF-16 offsets, but references address the
  // unchanged source. Each preceding CRLF contributes one additional source unit.
  for (
    let source = 0, displayed = 0;
    source < content.length && displayed < end;
    source++, displayed++
  ) {
    if (content[source] !== "\r" || content[source + 1] !== "\n") continue;
    if (displayed < start) sourceStart++;
    sourceEnd++;
    source++;
  }
  return [sourceStart, sourceEnd];
}
/** A source window is independent of the active conversation and its draft. */
export function HistorySearchPanel({
  client,
  locale,
  scope,
  initialQuery = "",
  onReference,
  onScopeEnded,
}: HistorySearchPanelProps) {
  const c = historyCopy[locale];
  const [query, setQuery] = useState(initialQuery);
  const queryValid = Array.from(query).length <= 256;
  const [workspace, setWorkspace] = useState("");
  const [agent, setAgent] = useState("");
  const [kind, setKind] = useState("");
  const [archived, setArchived] = useState(false);
  const [catalog, setCatalog] = useState<Awaited<ReturnType<WebClient["catalog"]>>>();
  const workspaceName = (id: string) =>
    catalog?.workspaces?.find((item) => item.id === id)?.name.trim() || id;
  const [status, setStatus] = useState<HistorySearchStatus>();
  const [result, setResult] = useState<HistorySearchResult>();
  const [located, setLocated] = useState<HistoryLocatedRecord>();
  const [selection, setSelection] = useState<[number, number]>([0, 0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [added, setAdded] = useState(false);
  const request = useRef(0);
  const indexEnabled = useRef<boolean | undefined>(undefined);
  const indexGeneration = useRef<string | undefined>(undefined);
  const active = useRef(true);
  const scopeInvalid = useRef(false);
  const inFlight = useRef<AbortController | undefined>(undefined);
  const ended = useRef(onScopeEnded);
  useEffect(() => {
    ended.current = onScopeEnded;
  }, [onScopeEnded]);
  const clearPrivate = useCallback(() => {
    setResult(undefined);
    setLocated(undefined);
    setCatalog(undefined);
    setSelection([0, 0]);
    setQuery("");
    setStatus(undefined);
    setWorkspace("");
    setAgent("");
  }, []);
  useEffect(() => {
    active.current = true;
    scopeInvalid.current = false;
    let checking = false;
    const abort = new AbortController();
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const access = await client.access(abort.signal);
        if (abort.signal.aborted) return;
        if (!scope || historyAccessScope(access) !== scope) {
          scopeInvalid.current = true;
          request.current++;
          inFlight.current?.abort();
          clearPrivate();
          ended.current?.();
          return;
        }
        const next = await client.historyStatus(abort.signal);
        if (abort.signal.aborted) return;
        setStatus(next);
        if (!next.enabled) {
          request.current++;
          inFlight.current?.abort();
          setResult(undefined);
          setLocated(undefined);
          if (indexEnabled.current === true) ended.current?.();
        }
        indexEnabled.current = next.enabled;
      } catch (e) {
        if (!abort.signal.aborted) {
          clearPrivate();
          setError(c.error);
          if (e instanceof ApiError && [401, 403].includes(e.status)) {
            scopeInvalid.current = true;
            request.current++;
            inFlight.current?.abort();
            ended.current?.();
          }
        }
      } finally {
        checking = false;
      }
    };
    void check();
    void client
      .catalog(abort.signal)
      .then((value) => {
        if (!abort.signal.aborted && !scopeInvalid.current) setCatalog(value);
      })
      .catch(() => {});
    const timer = setInterval(() => void check(), 5000);
    return () => {
      active.current = false;
      request.current++;
      abort.abort();
      inFlight.current?.abort();
      clearInterval(timer);
    };
  }, [client, scope, clearPrivate, c.error]);
  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setError(
        e instanceof ApiError && /stale|changed/.test(e.code)
          ? c.stale
          : e instanceof Error && /reference.*(limit|large)|too_many.*reference/.test(e.message)
            ? c.limit
            : c.error,
      );
      if (e instanceof ApiError && [401, 403].includes(e.status)) {
        scopeInvalid.current = true;
        request.current++;
        inFlight.current?.abort();
        clearPrivate();
        ended.current?.();
      }
    },
    [c.error, c.stale, c.limit, clearPrivate],
  );
  const current = useCallback(
    async (generation: number, signal: AbortSignal) => {
      if (!active.current || signal.aborted || generation !== request.current) return false;
      const access = await client.access(signal);
      if (!active.current || signal.aborted || generation !== request.current) return false;
      if (historyAccessScope(access) !== scope) {
        scopeInvalid.current = true;
        request.current++;
        inFlight.current?.abort();
        clearPrivate();
        ended.current?.();
        return false;
      }
      return true;
    },
    [client, scope, clearPrivate],
  );
  const begin = useCallback(() => {
    inFlight.current?.abort();
    const abort = new AbortController();
    inFlight.current = abort;
    const generation = ++request.current;
    setBusy(true);
    setError("");
    setAdded(false);
    return { abort, generation };
  }, []);
  const search = useCallback(
    async (cursor?: string) => {
      if (!query.trim() || !queryValid || !status?.enabled || scopeInvalid.current) return;
      const { abort, generation } = begin();
      try {
        const next = await client.historySearch(
          {
            query,
            ...(workspace ? { workspaceIds: [workspace] } : {}),
            ...(agent ? { agents: [agent] } : {}),
            ...(kind
              ? {
                  kinds:
                    kind === "messages" ? ["user", "assistant"] : ["tool-input", "tool-output"],
                }
              : {}),
            ...(archived ? {} : { archived: false }),
            ...(cursor ? { cursor } : {}),
          },
          abort.signal,
        );
        if (!(await current(generation, abort.signal))) return;
        setStatus(next.status);
        setResult((previous) =>
          cursor && previous ? { ...next, hits: [...previous.hits, ...next.hits] } : next,
        );
        setLocated(undefined);
      } catch (e) {
        if (generation === request.current && !abort.signal.aborted) fail(e);
      } finally {
        if (generation === request.current) setBusy(false);
      }
    },
    [
      query,
      queryValid,
      workspace,
      agent,
      kind,
      archived,
      status?.enabled,
      begin,
      client,
      current,
      fail,
    ],
  );
  useEffect(() => {
    request.current++;
    inFlight.current?.abort();
    setResult(undefined);
    setLocated(undefined);
    setError("");
    setBusy(false);
    const timer = setTimeout(() => void search(), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const locate = useCallback(
    async (location: HistoryLocation) => {
      const { abort, generation } = begin();
      try {
        const value = await client.historyLocate(location, abort.signal);
        if (!(await current(generation, abort.signal))) return;
        setLocated(value);
        setSelection([0, value.content.length]);
      } catch (e) {
        if (generation === request.current && !abort.signal.aborted) {
          setLocated(undefined);
          fail(e);
        }
      } finally {
        if (generation === request.current) setBusy(false);
      }
    },
    [begin, client, current, fail],
  );
  useEffect(() => {
    const previous = indexGeneration.current;
    indexGeneration.current = status?.generation;
    if (
      !previous ||
      !status?.generation ||
      previous === status.generation ||
      result?.status.generation === status.generation
    )
      return;
    setResult(undefined);
    // A different session may have changed. Revalidate an open source without
    // taking the reader back to results unless that source itself disappeared.
    if (located) void locate(located.location);
    else void search();
  }, [status?.generation, result?.status.generation, located, locate, search]);
  async function quote() {
    if (!located || !onReference || selection[0] === selection[1]) return;
    const { abort, generation } = begin();
    try {
      const value = await client.historyReferences(
        [
          {
            ...located.location,
            start: selection[0],
            end: selection[1],
            contentHash: located.contentHash,
          },
        ],
        abort.signal,
      );
      if (!(await current(generation, abort.signal))) return;
      if (!value.references[0]) throw new Error("history_reference_unavailable");
      onReference(value.references[0]);
      setAdded(true);
    } catch (e) {
      if (generation === request.current && !abort.signal.aborted) fail(e);
    } finally {
      if (generation === request.current) setBusy(false);
    }
  }
  return (
    <div className="flex min-h-0 flex-col gap-3" data-history-search>
      <p className="text-xs text-muted-foreground">{c.local}</p>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <Input
          aria-label={c.query}
          placeholder={c.query}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button type="submit" disabled={!query.trim() || !queryValid || busy || !status?.enabled}>
          {c.search}
        </Button>
      </form>
      <div className="flex flex-wrap gap-2">
        <NativeSelect
          aria-label={c.allWorkspaces}
          value={workspace}
          onChange={(e) => setWorkspace(e.target.value)}
        >
          <option value="">{c.allWorkspaces}</option>
          {catalog?.workspaces?.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name.trim() || w.id}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label={c.allAgents}
          value={agent}
          onChange={(e) => setAgent(e.target.value)}
        >
          <option value="">{c.allAgents}</option>
          {[...new Set(catalog?.sessions.map((s) => s.agent) ?? [])].map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label={c.allKinds}
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          <option value="">{c.allKinds}</option>
          <option value="messages">{c.messages}</option>
          <option value="tools">{c.tools}</option>
        </NativeSelect>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => setArchived(e.target.checked)}
          />
          {c.archived}
        </label>
      </div>
      {status && <HistoryCoverageStatus status={status} locale={locale} />}
      {status?.enabled === false && <p role="status">{c.disabled}</p>}
      {!queryValid && (
        <p role="alert" className="text-sm text-destructive">
          {c.queryLimit}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {busy && (
        <p role="status" className="text-xs">
          {c.loading}
        </p>
      )}
      {located ? (
        <section className="space-y-3 rounded-lg border p-3" aria-label={c.source}>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                request.current++;
                inFlight.current?.abort();
                setLocated(undefined);
                setBusy(false);
              }}
            >
              {c.back}
            </Button>
            <strong className="min-w-0 break-words text-sm">
              {located.title || located.agent}
            </strong>
            <span className="text-xs text-muted-foreground">
              {c[located.kind]} {located.toolName}
            </span>
          </div>
          <p className="break-words text-xs text-muted-foreground">
            {c.workspace}: {workspaceName(located.workspaceId)}
          </p>
          <pre
            tabIndex={0}
            className="max-h-[35dvh] overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-3 text-xs"
          >
            <HighlightedHistoryText
              text={located.content}
              ranges={literalHistoryMatchRanges(located.content, query)}
            />
          </pre>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={!located.before || busy}
              onClick={() => located.before && void locate(located.before)}
            >
              {c.previous}
            </Button>
            <Button
              variant="outline"
              disabled={!located.after || busy}
              onClick={() => located.after && void locate(located.after)}
            >
              {c.next}
            </Button>
          </div>
          {onReference && (
            <>
              <label className="block text-xs">
                {c.selection}
                <textarea
                  aria-label={c.excerpt}
                  readOnly
                  value={located.content}
                  onSelect={(e) =>
                    setSelection(
                      sourceSelectionRange(
                        located.content,
                        e.currentTarget.selectionStart,
                        e.currentTarget.selectionEnd,
                      ),
                    )
                  }
                  className="mt-2 max-h-32 min-h-20 w-full rounded border bg-background p-2"
                />
              </label>
              <p className="text-xs text-muted-foreground">{c.quoteOnly}</p>
              <Button disabled={busy || selection[0] === selection[1]} onClick={() => void quote()}>
                {c.quote}
              </Button>
              {added && (
                <p role="status" className="text-xs">
                  {c.added}
                </p>
              )}
            </>
          )}
        </section>
      ) : (
        <div className="max-h-[45dvh] space-y-2 overflow-auto">
          {result?.hits.map((hit: HistorySearchHit, index) => (
            <button
              type="button"
              key={`${JSON.stringify(hit.location)}:${index}`}
              disabled={busy}
              onClick={() => void locate(hit.location)}
              className="block w-full space-y-1 rounded-lg border p-3 text-left hover:bg-accent"
            >
              <strong className="block text-sm">{hit.title || hit.agent}</strong>
              <span className="block break-words text-xs text-muted-foreground">
                {c.workspace}: {workspaceName(hit.workspaceId)}
              </span>
              <span className="block text-xs text-muted-foreground">
                {hit.agent} · {c[hit.kind]} {hit.toolName} · {hit.timestamp}
              </span>
              <p className="whitespace-pre-wrap break-words text-xs">
                <HighlightedHistoryText text={hit.snippet} ranges={hit.matchRanges} />
              </p>
              {hit.indexedAt && (
                <small className="block text-muted-foreground">
                  {c.cachedAt}: {hit.indexedAt}
                </small>
              )}
              {hit.stale && <small>{c.stale}</small>}
            </button>
          ))}
          {result && !result.hits.length && <p role="status">{c.empty}</p>}
          {result?.limited && <p className="text-xs">{c.limited}</p>}
          {result?.nextCursor && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void search(result.nextCursor!)}
            >
              {c.more}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
export function HistorySearchDialog(props: HistorySearchPanelProps & { onClose: () => void }) {
  const c = historyCopy[props.locale];
  return (
    <Dialog panel title={c.title} closeLabel={c.close} onClose={props.onClose}>
      <HistorySearchPanel
        {...props}
        onScopeEnded={() => {
          props.onScopeEnded?.();
          props.onClose();
        }}
      />
    </Dialog>
  );
}
/** Desktop surfaces outside SessionProvider share the same source reader. */
export function HistorySearchLauncher({
  client,
  locale,
  initialQuery = "",
  onOpen,
}: {
  client: WebClient;
  locale: Locale;
  initialQuery?: string;
  onOpen?: () => void;
}) {
  const [access, setAccess] = useState<{ client: WebClient; value: Access }>();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const inFlight = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const abort = new AbortController();
    inFlight.current = abort;
    setAccess(undefined);
    setOpen(false);
    setPending(false);
    setError(false);
    void client
      .access(abort.signal)
      .then((value) => {
        if (!abort.signal.aborted) setAccess({ client, value });
      })
      .catch(() => {})
      .finally(() => {
        if (inFlight.current === abort) inFlight.current = undefined;
      });
    return () => {
      abort.abort();
      inFlight.current?.abort();
    };
  }, [client]);
  async function openSearch() {
    // The initial grant only controls visibility; workspace registration can change its scope.
    if (inFlight.current) return;
    const abort = new AbortController();
    inFlight.current = abort;
    setPending(true);
    setError(false);
    try {
      const value = await client.access(abort.signal);
      if (abort.signal.aborted) return;
      setAccess({ client, value });
      if (!historyAccessScope(value)) {
        setOpen(false);
        return;
      }
      if (onOpen) onOpen();
      else setOpen(true);
    } catch (e) {
      if (abort.signal.aborted) return;
      setOpen(false);
      if (e instanceof ApiError && [401, 403].includes(e.status)) setAccess(undefined);
      else setError(true);
    } finally {
      if (inFlight.current === abort) {
        inFlight.current = undefined;
        if (!abort.signal.aborted) setPending(false);
      }
    }
  }
  const scope = access?.client === client ? historyAccessScope(access.value) : "";
  if (!scope) return null;
  return (
    <>
      <Button type="button" variant="ghost" disabled={pending} onClick={() => void openSearch()}>
        <Search size={16} />
        {historyCopy[locale].title}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {historyCopy[locale].error}
        </p>
      )}
      {open && (
        <HistorySearchDialog
          client={client}
          locale={locale}
          scope={scope}
          initialQuery={initialQuery}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
