import { SessionOperations } from "./session-operations";
import { useSessionPanels } from "./session-panels";
import { CodexComposer } from "./codex-composer";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { ArrowUp, ChevronRight, ShieldCheck, Square } from "@octanejs/lucide";
import { SafeMarkdown, Transcript } from "@agentkib/session-ui";
import { interactionCopy } from "@/features/interactions/question-form";
import { MAX_MESSAGE_LENGTH, isValidMessage } from "./session-model";
import { useSession } from "./session-context";
import { ArtifactBrowser } from "./artifact-browser";
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
  } = useSession();
  const panels = useSessionPanels();
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
                onClick={() => void earlier()}
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
            {live?.streamText && live.status !== "idle" && (
              <article aria-label={t.streamingReply}>
                <small>{t.streamingReply}</small>
                <SafeMarkdown text={live.streamText} />
                {live.streamTextTruncated && <p role="note">{t.streamingReplyTruncated}</p>}
              </article>
            )}
          </section>
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
          access.device?.send ? (
            current?.agent === "codex" || current?.agent === "claude-code" ? (
              <CodexComposer key={selected} />
            ) : (
              <form
                className="mx-4 mb-4 mt-3 w-[calc(100%-2rem)] max-w-3xl shrink-0 self-center rounded-2xl border bg-card p-3 shadow-sm focus-within:ring-2 focus-within:ring-ring/20 md:mb-6 [&>textarea]:min-h-16 [&>textarea]:max-h-40 [&>textarea]:resize-y [&>textarea]:border-0 [&>textarea]:shadow-none [&>textarea]:focus-visible:ring-0 [&>div]:flex [&>div]:items-end [&>div]:justify-between [&>div]:gap-4 [&_small]:max-w-lg [&_small]:text-xs [&_small]:leading-5 [&_small]:text-muted-foreground"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (canSend && isValidMessage(message)) void control("send");
                }}
              >
                <label className="sr-only" htmlFor="message">
                  {t.message}
                </label>
                <Textarea
                  id="message"
                  value={message}
                  maxLength={MAX_MESSAGE_LENGTH}
                  onChange={(e) => setMessage(e.currentTarget.value)}
                  placeholder={t.message}
                  disabled={!online || busy}
                />
                <div>
                  <small>
                    {t.experimental} · {t.controlInfo}
                  </small>
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
                      disabled={!canSend || !isValidMessage(message)}
                    >
                      <ArrowUp size={20} />
                    </Button>
                  )}
                </div>
              </form>
            )
          ) : (
            <footer className="shrink-0 border-t px-5 py-4 text-center text-xs text-muted-foreground">
              {(current?.agent === "codex" ||
                current?.agent === "claude-code" ||
                current?.agent === "antigravity") &&
              access.experimentalEnabled &&
              access.device?.approve
                ? t.noSendPermission
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
