/** @jsxImportSource octane */

import { useId, useState } from "octane";
import { Markdown } from "@tanstack/markdown/octane";
import type { ConversationEvent } from "@agentkib/web-client";
export interface ReaderLabels {
  process: string;
  tools: string;
  failed: string;
  incomplete: string;
  details: string;
  attachments: string;
  truncated: string;
  unknownTool: string;
}
export function toolStatusLabel(status: string | undefined, locale: string): string {
  const names =
    locale === "zh-TW"
      ? ["已完成", "失敗", "執行中", "等待中", "已取消"]
      : locale.startsWith("zh")
        ? ["已完成", "失败", "执行中", "等待中", "已取消"]
        : locale.startsWith("ja")
          ? ["完了", "失敗", "実行中", "待機中", "キャンセル済み"]
          : ["Completed", "Failed", "Running", "Pending", "Cancelled"];
  const value = status?.toLowerCase();
  if (["completed", "complete", "success", "succeeded"].includes(value ?? "")) return names[0];
  if (["failed", "failure", "error", "errored"].includes(value ?? "")) return names[1];
  if (["running", "in-progress", "inprogress"].includes(value ?? "")) return names[2];
  if (["pending", "queued"].includes(value ?? "")) return names[3];
  if (["cancelled", "canceled"].includes(value ?? "")) return names[4];
  return status ?? "";
}
export function groupEvents(events: ConversationEvent[], incomplete = false) {
  const runs: ConversationEvent[][] = [];
  for (const event of events) {
    const last = runs.at(-1);
    if (last && (last[0].turn_id?.trim() || undefined) === (event.turn_id?.trim() || undefined))
      last.push(event);
    else runs.push([event]);
  }
  return runs.map((run) => {
    const complete =
      !incomplete &&
      !!run[0].turn_id?.trim() &&
      run[0].kind === "user-message" &&
      run.some((e) => e.message_phase === "final_answer" && e.kind === "agent-message") &&
      !run.some((e) => e.truncated);
    const segments: { key: string; process: boolean; events: ConversationEvent[] }[] = [];
    for (const e of run) {
      const process =
        e.kind === "tool-summary" ||
        (complete && e.kind === "agent-message" && e.message_phase === "commentary");
      const last = segments.at(-1);
      if (process && last?.process) {
        last.events.push(e);
      } else segments.push({ key: e.id, process, events: [e] });
    }
    return {
      key: run[0].id,
      complete,
      turnId: run[0].turn_id,
      time: run.find((e) => e.timestamp)?.timestamp,
      segments,
    };
  });
}

type TranscriptGroup = ReturnType<typeof groupEvents>[number];
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
  const groups = groupEvents(events, incomplete);
  const previousByItem = new Map<string, TranscriptGroup>();
  for (const group of previous?.groups ?? [])
    for (const segment of group.segments)
      for (const event of segment.events) previousByItem.set(event.id, group);
  const usedGroups = new Set<string>();
  let nextKey = previous?.nextKey ?? 0;
  for (const group of groups) {
    // Both ends of a loaded window can grow. Reuse a shared item's group and
    // process identities so neither pagination nor live appends remount them.
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

export function SafeMarkdown({ text }: { text: string }) {
  return (
    <Markdown components={{
        img: () => null,
        a: ({ href, children }) =>
          href && /^https?:\/\//i.test(href) ? (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ) : (
            <span>{children}</span>
          ),
      }}>
      {text}
    </Markdown>
  );
}
export function Transcript({
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
  // Adjust before committing children; an effect would first render new keys
  // and lose the very DOM nodes and expansion state we need to preserve.
  if (current !== projection) setProjection(current);
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const row = (e: ConversationEvent) => (
    <div key={`item-${e.id}`} data-event-id={e.id} className={`message ${e.kind}`}>
      {e.kind === "tool-summary" ? (
        <button className="tool" onClick={() => onTool(e)}>
          ⌘ {e.tool_name || labels.unknownTool}{" "}
          <span>{toolStatusLabel(e.tool_status, locale)}</span>
        </button>
      ) : (
        <SafeMarkdown text={e.content ?? ""} />
      )}
      {e.attachment_count > 0 && (
        <small>
          {labels.attachments}: {e.attachment_count}
        </small>
      )}
      {e.truncated && <small role="note">{labels.truncated}</small>}
    </div>
  );
  return (
    <div className="transcript">
      {current.groups.map((g) => (
        <section key={g.key} className="turn">
          {g.time && (
            <time
              tabIndex={0}
              dateTime={g.time}
              aria-label={new Date(g.time).toLocaleString(locale)}
            >
              {new Date(g.time).toLocaleString(locale)}
            </time>
          )}
          {g.segments.map((s) => {
            if (!s.process) return s.events.map(row);
            const failed = s.events.filter((e) =>
              /^(failed|failure|error|errored)$/i.test(e.tool_status ?? ""),
            ).length;
            const open = opened[s.key] ?? failed > 0;
            return (
              <div key={`process-${s.key}`} className="process">
                <button
                  aria-expanded={open}
                  aria-controls={`process-${transcriptId}-${s.key}`}
                  onClick={() => setOpened((v) => ({ ...v, [s.key]: !open }))}
                >
                  {open ? "⌄" : "›"} {labels.process}{" "}
                  <span>
                    {s.events.filter((e) => e.kind === "tool-summary").length} {labels.tools}
                    {failed > 0 && ` · ${failed} ${labels.failed}`}
                  </span>
                </button>
                {open && (
                  <div id={`process-${transcriptId}-${s.key}`} className="process-body">
                    {s.events.map(row)}
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
