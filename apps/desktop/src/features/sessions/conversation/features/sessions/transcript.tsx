import { useId, useState } from "react";
import { groupConversationEvents } from "@agentkib/conversation-state";
import { SafeMarkdown } from "@agentkib/session-ui";
import type { ConversationEvent } from "@agentkib/web-client";
import { Button } from "@/components/ui/button";
import { toolStatusLabel } from "./tool-status";

interface ReaderLabels {
  process: string;
  tools: string;
  failed: string;
  incomplete: string;
  details: string;
  attachments: string;
  truncated: string;
  unknownTool: string;
}

type TranscriptGroup = ReturnType<typeof groupConversationEvents>[number];

interface TranscriptProjection {
  events: ConversationEvent[];
  incomplete: boolean;
  groups: TranscriptGroup[];
  nextKey: number;
}

function projectTranscript(
  events: ConversationEvent[],
  incomplete: boolean,
  previous?: TranscriptProjection,
): TranscriptProjection {
  const groups = groupConversationEvents(events, incomplete);
  const previousByItem = new Map<string, TranscriptGroup>();
  for (const group of previous?.groups ?? [])
    for (const segment of group.segments)
      for (const event of segment.events) previousByItem.set(event.id, group);
  const usedGroups = new Set<string>();
  let nextKey = previous?.nextKey ?? 0;
  for (const group of groups) {
    const prior = group.segments
      .flatMap((segment) => segment.events)
      .map((event) => previousByItem.get(event.id))
      .find(
        (candidate) =>
          candidate &&
          !usedGroups.has(candidate.key) &&
          (candidate.turnId?.trim() || undefined) === (group.turnId?.trim() || undefined),
      );
    if (prior) usedGroups.add(prior.key);
    group.key = prior?.key ?? String(nextKey++);
    const previousProcesses = new Map<string, TranscriptGroup["segments"][number]>();
    for (const segment of prior?.segments ?? [])
      if (segment.process)
        for (const event of segment.events) previousProcesses.set(event.id, segment);
    const usedProcesses = new Set<string>();
    for (const segment of group.segments) {
      if (!segment.process) continue;
      const priorProcess = segment.events
        .map((event) => previousProcesses.get(event.id))
        .find((candidate) => candidate && !usedProcesses.has(candidate.key));
      if (priorProcess) usedProcesses.add(priorProcess.key);
      segment.key = priorProcess?.key ?? String(nextKey++);
    }
  }
  return { events, incomplete, groups, nextKey };
}

export function DesktopTranscript({
  events,
  incomplete = false,
  labels,
  onTool,
  locale,
}: {
  events: ConversationEvent[];
  incomplete?: boolean;
  labels: ReaderLabels;
  onTool: (event: ConversationEvent) => void;
  locale: string;
}) {
  const transcriptId = useId();
  const [projection, setProjection] = useState(() => projectTranscript(events, incomplete));
  const current =
    projection.events === events && projection.incomplete === incomplete
      ? projection
      : projectTranscript(events, incomplete, projection);
  if (current !== projection) setProjection(current);
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const row = (event: ConversationEvent) => (
    <div key={`item-${event.id}`} data-event-id={event.id} className={`message ${event.kind}`}>
      {event.kind === "tool-summary" ? (
        <Button variant="bare" size="content" className="tool" onClick={() => onTool(event)}>
          ⌘ {event.tool_name || labels.unknownTool}{" "}
          <span>{toolStatusLabel(event.tool_status, locale)}</span>
        </Button>
      ) : (
        <SafeMarkdown text={event.content ?? ""} />
      )}
      {event.attachment_count > 0 && (
        <small>
          {labels.attachments}: {event.attachment_count}
        </small>
      )}
      {event.truncated && <small role="note">{labels.truncated}</small>}
    </div>
  );
  return (
    <div className="transcript">
      {current.groups.map((group) => (
        <section key={group.key} className="turn">
          {group.time && (
            <time
              tabIndex={0}
              dateTime={group.time}
              aria-label={new Date(group.time).toLocaleString(locale)}
            >
              {new Date(group.time).toLocaleString(locale)}
            </time>
          )}
          {group.segments.map((segment) => {
            if (!segment.process) return segment.events.map(row);
            const failed = segment.events.filter((event) =>
              /^(failed|failure|error|errored)$/i.test(event.tool_status ?? ""),
            ).length;
            const open = opened[segment.key] ?? failed > 0;
            return (
              <div key={`process-${segment.key}`} className="process">
                <Button
                  variant="bare"
                  size="content"
                  aria-expanded={open}
                  aria-controls={`process-${transcriptId}-${segment.key}`}
                  onClick={() => setOpened((value) => ({ ...value, [segment.key]: !open }))}
                >
                  {open ? "⌄" : "›"} {labels.process}{" "}
                  <span>
                    {segment.events.filter((event) => event.kind === "tool-summary").length}{" "}
                    {labels.tools}
                    {failed > 0 && ` · ${failed} ${labels.failed}`}
                  </span>
                </Button>
                {open && (
                  <div id={`process-${transcriptId}-${segment.key}`} className="process-body">
                    {segment.events.map(row)}
                  </div>
                )}
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}
