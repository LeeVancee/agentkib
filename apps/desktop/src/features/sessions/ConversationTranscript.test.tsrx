/** @jsxImportSource octane */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@octanejs/testing-library";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { formatDateTime, initializeI18n, tr } from "@/core/i18n";
import type { ConversationEvent } from "@/core/types";
import { ConversationEventRow } from "./ConversationEventRow";
import { ConversationTranscript } from "./ConversationTranscript";

function event(
  id: string,
  kind: ConversationEvent["kind"],
  metadata: Partial<{ turn_id: string | null; message_phase: "commentary" | "final_answer" }> = {},
  extra: Partial<ConversationEvent> = {},
): ConversationEvent {
  return {
    id,
    kind,
    content: id,
    attachment_count: 0,
    truncated: false,
    ...metadata,
    ...extra,
  } as ConversationEvent;
}

describe("ConversationTranscript", () => {
  beforeAll(() => initializeI18n("en-US"));
  afterEach(cleanup);

  it("folds complete process segments, keeps final visible, and removes hub role duplication", () => {
    const timestamp = "2026-09-07T03:04:05Z";
    const events = [
      event("user", "user-message", { turn_id: "turn-1" }, { timestamp }),
      event("commentary", "agent-message", { turn_id: "turn-1", message_phase: "commentary" }),
      event("tool", "tool-summary", { turn_id: "turn-1" }, { tool_status: "completed" }),
      event("final", "agent-message", { turn_id: "turn-1", message_phase: "final_answer" }),
    ];

    const { container } = render(<ConversationTranscript events={events} sessionKey="session-1" />);
    const process = container.querySelector('[data-slot="collapsible"]');
    expect(process).not.toBeNull();
    const trigger = process!.querySelector('[data-slot="collapsible-trigger"]');
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("user")).toBeVisible();
    expect(screen.getByText("final")).toBeVisible();
    expect(screen.queryByText("commentary")).toBeNull();
    expect(screen.queryByText(tr("conversations.agent"))).toBeNull();
    expect(screen.queryByText(tr("conversations.you"))).toBeNull();

    const time = container.querySelector("time");
    expect(time).toHaveAttribute("tabindex", "0");
    expect(time).toHaveAccessibleName(`${tr("sessions.recordTime")}: ${formatDateTime(timestamp)}`);

    fireEvent.click(screen.getByText(tr("sessions.process")));
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("commentary")).toBeVisible();
    expect(container.querySelector('[data-event-id="tool"]')).toBeTruthy();
  });

  it("retains an opened process when earlier pagination extends its turn", () => {
    const initial = [
      event("user", "user-message", { turn_id: "turn-page" }),
      event("commentary", "agent-message", { turn_id: "turn-page", message_phase: "commentary" }),
      event("tool", "tool-summary", { turn_id: "turn-page" }),
      event("final", "agent-message", { turn_id: "turn-page", message_phase: "final_answer" }),
    ];
    const { container, rerender } = render(
      <ConversationTranscript events={initial} sessionKey="session-page" />,
    );
    const process = container.querySelector('[data-slot="collapsible"]')!;
    const trigger = process.querySelector('[data-slot="collapsible-trigger"]')!;
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    rerender(
      <ConversationTranscript
        events={[
          event("older", "agent-message", {
            turn_id: "turn-page",
            message_phase: "commentary",
          }),
          ...initial,
        ]}
        sessionKey="session-page"
      />,
    );
    expect(
      container
        .querySelector('[data-segment-key$=":segment:tool"]')
        ?.querySelector('[data-slot="collapsible-trigger"]'),
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("older")).toBeVisible();
  });

  it("resets disclosure state when the externally-owned session key changes", () => {
    const events = [
      event("user", "user-message", { turn_id: "turn-reset" }),
      event("commentary", "agent-message", { turn_id: "turn-reset", message_phase: "commentary" }),
      event("final", "agent-message", { turn_id: "turn-reset", message_phase: "final_answer" }),
    ];
    const { container, rerender } = render(
      <ConversationTranscript events={events} sessionKey="session-a" />,
    );
    const process = container.querySelector('[data-slot="collapsible"]')!;
    const trigger = process.querySelector('[data-slot="collapsible-trigger"]')!;
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    rerender(<ConversationTranscript events={events} sessionKey="session-b" />);
    expect(container.querySelector('[data-slot="collapsible-trigger"]')).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByText("commentary")).toBeNull();
  });

  it("opens failed tools by default and keeps incomplete commentary expanded", () => {
    const events = [
      event("user", "user-message", { turn_id: "turn-failed" }),
      event("commentary", "agent-message", {
        turn_id: "turn-failed",
        message_phase: "commentary",
      }),
      event("failed-tool", "tool-summary", { turn_id: "turn-failed" }, { tool_status: "failed" }),
    ];
    const { container } = render(
      <ConversationTranscript events={events} sessionKey="session-failed" incomplete />,
    );
    const process = container.querySelector('[data-slot="collapsible"]');
    expect(process?.querySelector('[data-slot="collapsible-trigger"]')).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText("commentary")).toBeVisible();
    expect(container.querySelector('[data-event-id="failed-tool"]')).toBeVisible();
    expect(screen.getByText(tr("sessions.processFailed", { count: 1 }))).toBeVisible();
  });

  it("updates the default disclosure when pagination reveals a failed tool", () => {
    const initial = [
      event("user", "user-message", { turn_id: "turn-late-failure" }),
      event("tool", "tool-summary", { turn_id: "turn-late-failure" }, { tool_status: "completed" }),
    ];
    const { container, rerender } = render(
      <ConversationTranscript events={initial} sessionKey="session-late-failure" />,
    );
    expect(container.querySelector('[data-slot="collapsible-trigger"]')).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    rerender(
      <ConversationTranscript
        events={[
          event("user", "user-message", { turn_id: "turn-late-failure" }),
          event(
            "tool",
            "tool-summary",
            { turn_id: "turn-late-failure" },
            { tool_status: "failed" },
          ),
        ]}
        sessionKey="session-late-failure"
      />,
    );
    expect(container.querySelector('[data-slot="collapsible-trigger"]')).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("keeps workspace row framing and metadata while hub rows stay compact", () => {
    const timestamp = "2026-09-07T03:04:05Z";
    const { container } = render(
      <>
        <ConversationEventRow
          event={event("hub-agent", "agent-message", {}, { timestamp })}
          variant="hub"
        />
        <ConversationEventRow
          event={event("hub-user", "user-message", {}, { timestamp })}
          variant="hub"
        />
        <ConversationEventRow
          event={event("workspace-agent", "agent-message", {}, { timestamp })}
        />
        <ConversationEventRow
          event={event("hub-tool", "tool-summary", {}, { timestamp, tool_status: "completed" })}
          variant="hub"
        />
      </>,
    );

    expect(container.querySelector('[data-event-id="hub-agent"] header')).toBeNull();
    expect(container.querySelector('[data-event-id="hub-user"] header')).toBeNull();
    expect(container.querySelector('[data-event-id="hub-tool"] time')).toBeNull();
    expect(container.querySelector('[data-event-id="workspace-agent"] header')).toHaveTextContent(
      tr("conversations.agent"),
    );
    expect(container.querySelector('[data-event-id="workspace-agent"] time')).toHaveTextContent(
      "Sep 7, 2026",
    );
  });
});
