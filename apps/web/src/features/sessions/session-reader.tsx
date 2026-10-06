import { SessionOperations } from "./session-operations";
import { useSessionPanels } from "./session-panels";
import { ContextUsageGauge } from "./context-usage";
import { contextUsageCopy } from "./context-usage-copy";
import { CodexComposer } from "./codex-composer";
import { Textarea } from "../../components/ui/textarea";
import { Button } from "../../components/ui/button";
import { ArrowDown, ArrowUp, ChevronRight, ShieldCheck, Square } from "lucide-react";
import { SafeMarkdown, Transcript } from "@agentkib/session-ui";
import { interactionCopy } from "../interactions/question-form";
import { MAX_MESSAGE_LENGTH, isValidMessage } from "./session-model";
import { useSession } from "./session-context";
import { ArtifactBrowser } from "./artifact-browser";
import { useLayoutEffect, useRef, useState } from "react";
import { webLayoutCopy } from "./web-layout-copy";
export function SessionReader() {
  const {
    t,
    access,
    selected,
    current,
    setModal,
    online,
    scroll,
    page,
    busy,
    earlier,
    locale,
    live,
    notice,
    canSend,
    canStop,
    message,
    setMessage,
    control,
    liveContentVersion,
  } = useSession();
  const panels = useSessionPanels();
  const hasNativeReply =
    !!live?.turnId &&
    page?.events.some((event) => event.kind === "agent-message" && event.turn_id === live.turnId);
  const following = useRef(true);
  const previousSession = useRef(selected);
  const previousContent = useRef({ events: page?.events, streamText: live?.streamText });
  const previousLiveContentVersion = useRef(liveContentVersion);
  const [hasNewMessages, setHasNewMessages] = useState(false);
  useLayoutEffect(() => {
    if (previousSession.current !== selected) {
      previousSession.current = selected;
      following.current = true;
      setHasNewMessages(false);
    } else if (!following.current && previousLiveContentVersion.current !== liveContentVersion) {
      const previous = previousContent.current;
      const last = previous.events?.at(-1);
      const latest = page?.events.at(-1);
      // Prepending a history page leaves existing content unchanged. Also
      // observe deltas to a message followed by another active tool item.
      const previousItems = new Map(previous.events?.map((event) => [event.id, event]));
      const changedText = page?.events.some((event) => {
        const old = previousItems.get(event.id);
        return old && old.content !== event.content;
      });
      const appended =
        last && latest?.id !== last.id && page?.events.some((event) => event.id === last.id);
      const streamed = !!live?.streamText && live.streamText !== previous.streamText;
      if (changedText || appended || streamed) setHasNewMessages(true);
    }
    previousContent.current = { events: page?.events, streamText: live?.streamText };
    previousLiveContentVersion.current = liveContentVersion;
    const viewport = scroll.current;
    if (following.current && viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [selected, page?.events, live?.streamText, liveContentVersion, scroll]);
  if (!access || !selected) return null;
  return (
    <>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <SessionOperations
            key={selected}
            open={panels?.actionsOpen ?? false}
            onOpenChange={(open) => panels?.setActionsOpen(open)}
          />
          <section
            className="reader-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-8 pt-3 [scrollbar-gutter:stable] md:px-10"
            ref={scroll}
            onScroll={() => {
              const viewport = scroll.current;
              if (viewport)
                following.current =
                  viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 96;
              if (following.current) setHasNewMessages(false);
            }}
          >
            {current?.agent === "claude-code" && (
              <aside className="info mx-auto mb-5 max-w-3xl">{t.managedResumeInfo}</aside>
            )}
            {page?.warnings.length ? (
              <aside className="mx-auto mb-5 max-w-3xl rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs leading-6 text-amber-600">
                {t.warnings}: {page.warnings.join(" · ")}
              </aside>
            ) : null}
            {page?.next_cursor && (
              <Button
                variant="ghost"
                className="mx-auto mb-5 flex text-xs text-muted-foreground"
                disabled={busy}
                onClick={() => {
                  following.current = false;
                  void earlier();
                }}
              >
                {t.earlier}
              </Button>
            )}
            {!page ? (
              <p role="status">{t.loading}</p>
            ) : (
              <Transcript
                key={selected}
                events={page.events}
                incomplete={page.warnings.length > 0}
                labels={t}
                onTool={setModal}
                locale={locale}
              />
            )}
            {live?.streamText && live.status !== "idle" && !hasNativeReply && (
              <article aria-label={t.streamingReply}>
                <small>{t.streamingReply}</small>
                <SafeMarkdown text={live.streamText} />
                {live.streamTextTruncated && <p role="note">{t.streamingReplyTruncated}</p>}
              </article>
            )}
          </section>
          {hasNewMessages && (
            <div className="shrink-0 self-center py-1" role="status">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  following.current = true;
                  const viewport = scroll.current;
                  if (viewport) viewport.scrollTop = viewport.scrollHeight;
                  setHasNewMessages(false);
                }}
              >
                <ArrowDown size={16} />
                {webLayoutCopy[locale].newMessages}
              </Button>
            </div>
          )}
          <div className="max-h-[25dvh] shrink-0 overflow-y-auto">
            {live?.approvals.map((a) => (
              <Button
                variant="ghost"
                key={a.requestId}
                className="mx-5 my-2 shrink-0 justify-start whitespace-normal border border-amber-500/25 bg-amber-500/5 text-left text-xs text-amber-700 dark:text-amber-300 [&>svg:last-child]:ml-auto"
                onClick={() => setModal(a)}
              >
                <ShieldCheck size={19} />
                {t.approval}
                <ChevronRight size={18} />
              </Button>
            ))}
            {live?.questions?.map((q) => (
              <Button
                variant="ghost"
                key={q.requestId}
                className="mx-5 my-2 shrink-0 justify-start whitespace-normal border border-amber-500/25 bg-amber-500/5 text-left text-xs text-amber-700 dark:text-amber-300 [&>svg:last-child]:ml-auto"
                onClick={() => setModal(q)}
              >
                {interactionCopy[locale].title}
                <ChevronRight size={18} />
              </Button>
            ))}
          </div>
          {notice && (
            <p
              role="status"
              className="mx-auto w-full max-w-3xl px-5 py-2 text-xs leading-6 text-muted-foreground"
            >
              {t[notice]}
            </p>
          )}
          {(current?.agent === "codex" ||
            current?.agent === "claude-code" ||
            current?.agent === "antigravity") &&
          access.experimentalEnabled &&
          access.protocolVersion === 2 &&
          access.device?.send ? (
            current?.agent === "codex" || current?.agent === "claude-code" ? (
              <CodexComposer key={selected} />
            ) : (
              <form
                className="mx-4 mb-4 mt-3 w-[calc(100%-2rem)] max-w-3xl shrink-0 self-center rounded-2xl border bg-card p-3 shadow-sm focus-within:ring-2 focus-within:ring-ring/20 md:mb-6 [&>textarea]:min-h-16 [&>textarea]:max-h-40 [&>textarea]:resize-y [&>textarea]:border-0 [&>textarea]:shadow-none [&>textarea]:focus-visible:ring-0 [&>div]:flex [&>div]:items-end [&>div]:justify-between [&>div]:gap-4 [&_small]:max-w-lg [&_small]:text-xs [&_small]:leading-5 [&_small]:text-muted-foreground"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (canSend && live?.activity !== "compacting" && isValidMessage(message))
                    void control("send");
                }}
              >
                <label className="sr-only" htmlFor="message">
                  {t.message}
                </label>
                <Textarea
                  id="message"
                  value={message}
                  maxLength={MAX_MESSAGE_LENGTH}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder={t.message}
                  disabled={!online || busy}
                />
                <div>
                  <small>
                    {t.experimental} · {t.controlInfo}
                  </small>
                  <div className="flex min-w-0 items-center gap-1">
                    <ContextUsageGauge />
                    {canStop ? (
                      <Button
                        type="button"
                        variant="destructive"
                        className="size-11 shrink-0 rounded-xl"
                        aria-label={t.stop}
                        onClick={() => void control("stop")}
                      >
                        <Square size={17} />
                      </Button>
                    ) : (
                      <Button
                        variant="default"
                        className="size-11 shrink-0 rounded-xl"
                        aria-label={t.send}
                        disabled={
                          !canSend || live?.activity === "compacting" || !isValidMessage(message)
                        }
                      >
                        <ArrowUp size={20} />
                      </Button>
                    )}
                  </div>
                </div>
                {live?.activity === "compacting" && (
                  <p role="status" className="mt-2 text-xs text-muted-foreground">
                    {contextUsageCopy[locale].compactingDetail}
                  </p>
                )}
              </form>
            )
          ) : (
            <footer className="shrink-0 border-t px-5 py-4 text-center text-xs text-muted-foreground">
              {access.protocolVersion === 2 &&
                access.device?.accessMode === "full" &&
                access.device.advancedControl &&
                ["codex", "claude-code", "antigravity"].includes(current?.agent ?? "") && (
                  <div className="flex justify-center">
                    <ContextUsageGauge />
                  </div>
                )}
              {(current?.agent === "codex" ||
                current?.agent === "claude-code" ||
                current?.agent === "antigravity") &&
              access.experimentalEnabled &&
              access.device?.approve
                ? t.noSendPermission
                : access.protocolVersion !== 2
                  ? t.lanIncompatible
                  : t.readOnly}
            </footer>
          )}
        </div>
        <ArtifactBrowser
          key={selected}
          open={panels?.filesOpen ?? false}
          onOpenChange={(open) => panels?.setFilesOpen(open)}
          showTrigger={false}
        />
      </div>
    </>
  );
}
