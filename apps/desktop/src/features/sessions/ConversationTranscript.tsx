/** @jsxImportSource octane */

import { useI18n } from "@/core/useI18n";
import type { ConversationEvent } from "@/core/types";
import { ChevronRight } from "@octanejs/lucide";
import { useLinkedState } from "octane";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ConversationEventRow } from "./ConversationEventRow";
import { groupConversationEvents, type ConversationTurnGroup } from "./conversation-groups";

export interface ConversationTranscriptProps {
  events: ConversationEvent[];
  sessionKey: string;
  incomplete?: boolean;
}

function firstTimestamp(group: ConversationTurnGroup) {
  return group.timestamp;
}

export function ConversationTranscript({
  events,
  sessionKey,
  incomplete = false,
}: ConversationTranscriptProps) {
  const { tr, formatDateTime } = useI18n();
  const [explicit, setExplicit] = useLinkedState<string, Map<string, boolean>>(
    sessionKey,
    () => new Map(),
  );

  const groups = groupConversationEvents(events, { incomplete });
  const setExpanded = (key: string, open: boolean) => {
    setExplicit(new Map(explicit).set(key, open));
  };

  return (
    <>
      {groups.map((group) => {
        const timestamp = firstTimestamp(group);
        return (
          <section
            className="session-hub-turn flex flex-col gap-2"
            data-turn-id={group.turnId}
            data-turn-key={group.key}
            key={group.key}
          >
            {(timestamp || (group.turnId && !group.complete)) && (
              <div className="session-hub-turn-meta flex items-center justify-end gap-2 px-1 text-[11px] text-muted-foreground/70">
                {group.turnId && !group.complete && (
                  <span className="session-hub-partial-turn">{tr("sessions.partialTurn")}</span>
                )}
                {timestamp && (
                  <time
                    aria-label={`${tr("sessions.recordTime")}: ${formatDateTime(timestamp)}`}
                    dateTime={timestamp}
                    tabIndex={0}
                  >
                    <span className="sr-only">{tr("sessions.recordTime")}: </span>
                    {formatDateTime(timestamp)}
                  </time>
                )}
              </div>
            )}
            <div className="session-hub-turn-events flex flex-col gap-2">
              {group.segments.map((segment) =>
                segment.collapsible ? (
                  <Collapsible
                    className="session-hub-process group overflow-hidden rounded-xl border border-border/60 bg-muted/25"
                    data-segment-key={segment.key}
                    key={`${sessionKey}:${segment.key}`}
                    open={explicit.get(segment.key) ?? segment.defaultOpen}
                    onOpenChange={(open: boolean) => setExpanded(segment.key, open)}
                  >
                    <CollapsibleTrigger className="session-hub-process-summary flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      <ChevronRight
                        aria-hidden="true"
                        className="size-4 shrink-0 transition-transform group-data-open:rotate-90"
                      />
                      <span className="font-medium text-foreground">{tr("sessions.process")}</span>
                      {segment.toolCount > 0 && (
                        <span>{tr("sessions.toolCalls", { count: segment.toolCount })}</span>
                      )}
                      {segment.failedToolCount > 0 && (
                        <span className="text-destructive">
                          {tr("sessions.processFailed", { count: segment.failedToolCount })}
                        </span>
                      )}
                    </CollapsibleTrigger>
                    <CollapsibleContent className="session-hub-process-events flex flex-col gap-2 px-2 pb-2">
                      {segment.events.map((event) => (
                        <ConversationEventRow key={event.id} event={event} variant="hub" />
                      ))}
                    </CollapsibleContent>
                  </Collapsible>
                ) : (
                  <div className="session-hub-transcript-event" key={segment.key}>
                    {segment.events.map((event) => (
                      <ConversationEventRow key={event.id} event={event} variant="hub" />
                    ))}
                  </div>
                ),
              )}
            </div>
          </section>
        );
      })}
    </>
  );
}
