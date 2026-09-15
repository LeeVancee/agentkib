import { describe, expect, it } from "vitest";
import type { ConversationEvent } from "@/core/types";
import { groupConversationEvents } from "./conversation-groups";

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

describe("groupConversationEvents", () => {
  it("does not mistake a later user message for the missing start of a turn", () => {
    const groups = groupConversationEvents([
      event("earlier-commentary", "agent-message", {
        turn_id: "partial",
        message_phase: "commentary",
      }),
      event("later-user", "user-message", { turn_id: "partial" }),
      event("final", "agent-message", { turn_id: "partial", message_phase: "final_answer" }),
    ]);
    expect(groups[0].complete).toBe(false);
    expect(groups[0].segments[0].collapsible).toBe(false);
  });
  it("keeps legacy records as ordered fallback groups without inventing turns", () => {
    const groups = groupConversationEvents([
      event("old-user", "user-message"),
      event("old-agent", "agent-message"),
      event("old-tool", "tool-summary"),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].events.map(({ id }) => id)).toEqual(["old-user", "old-agent", "old-tool"]);
    expect(groups.every((group) => group.turnId === undefined)).toBe(true);
    expect(groups[0].segments.map((segment) => segment.collapsible)).toEqual([false, false, true]);
  });

  it("does not cross missing metadata or merge a repeated non-contiguous id", () => {
    const groups = groupConversationEvents([
      event("a-user", "user-message", { turn_id: "turn-a" }),
      event("legacy-gap", "agent-message"),
      event("a-final", "agent-message", { turn_id: "turn-a", message_phase: "final_answer" }),
      event("a-again", "tool-summary", { turn_id: "turn-a" }),
    ]);

    expect(groups.map((group) => group.turnId)).toEqual(["turn-a", undefined, "turn-a"]);
    expect(groups.map((group) => group.events[0].id)).toEqual(["a-user", "legacy-gap", "a-final"]);
    expect(groups[2].events.map(({ id }) => id)).toEqual(["a-final", "a-again"]);
  });

  it("folds contiguous commentary and tools only in a complete turn", () => {
    const groups = groupConversationEvents([
      event("user", "user-message", { turn_id: "turn-1" }),
      event("thought", "agent-message", { turn_id: "turn-1", message_phase: "commentary" }),
      event("tool", "tool-summary", { turn_id: "turn-1" }, { tool_status: "completed" }),
      event("more-thought", "agent-message", {
        turn_id: "turn-1",
        message_phase: "commentary",
      }),
      event("final", "agent-message", { turn_id: "turn-1", message_phase: "final_answer" }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].complete).toBe(true);
    expect(groups[0].segments.map((segment) => [segment.kind, segment.collapsible])).toEqual([
      ["event", false],
      ["process", true],
      ["event", false],
    ]);
    expect(groups[0].segments[1].events.map(({ id }) => id)).toEqual([
      "thought",
      "tool",
      "more-thought",
    ]);
    expect(groups[0].segments[1].toolCount).toBe(1);
    expect(groups[0].segments[2].events[0].message_phase).toBe("final_answer");
  });

  it("keeps incomplete commentary open and only folds a contiguous tool run", () => {
    const groups = groupConversationEvents([
      event("user", "user-message", { turn_id: "partial" }),
      event("commentary", "agent-message", { turn_id: "partial", message_phase: "commentary" }),
      event("tool-1", "tool-summary", { turn_id: "partial" }),
      event("tool-2", "tool-summary", { turn_id: "partial" }),
      event("commentary-2", "agent-message", {
        turn_id: "partial",
        message_phase: "commentary",
      }),
    ]);

    expect(groups[0].complete).toBe(false);
    expect(groups[0].segments.map((segment) => segment.kind)).toEqual([
      "event",
      "event",
      "process",
      "event",
    ]);
    expect(groups[0].segments[1].collapsible).toBe(false);
    expect(groups[0].segments[2].events.map(({ id }) => id)).toEqual(["tool-1", "tool-2"]);
  });

  it("opens a process containing failed tools and reports only tool counts", () => {
    const groups = groupConversationEvents([
      event("user", "user-message", { turn_id: "failed" }),
      event("failed-tool", "tool-summary", { turn_id: "failed" }, { tool_status: "failed" }),
      event("final", "agent-message", { turn_id: "failed", message_phase: "final_answer" }),
    ]);

    const process = groups[0].segments[1];
    expect(groups[0].complete).toBe(true);
    expect(process.toolCount).toBe(1);
    expect(process.failedToolCount).toBe(1);
    expect(process.defaultOpen).toBe(true);
  });

  it("leaves unclassified body events expanded and keeps the final in order", () => {
    const groups = groupConversationEvents([
      event("user", "user-message", { turn_id: "mixed" }),
      event("body", "agent-message", { turn_id: "mixed" }),
      event("commentary", "agent-message", { turn_id: "mixed", message_phase: "commentary" }),
      event("final", "agent-message", { turn_id: "mixed", message_phase: "final_answer" }),
    ]);

    expect(groups[0].segments.flatMap((segment) => segment.events.map(({ id }) => id))).toEqual([
      "user",
      "body",
      "commentary",
      "final",
    ]);
    expect(groups[0].segments[1].collapsible).toBe(false);
    expect(groups[0].segments[2].collapsible).toBe(true);
    expect(groups[0].segments[3].events[0].id).toBe("final");
  });

  it("keeps a group key stable when older events are prepended", () => {
    const current = groupConversationEvents([
      event("user", "user-message", { turn_id: "turn-1" }),
      event("final", "agent-message", { turn_id: "turn-1", message_phase: "final_answer" }),
    ])[0];
    const afterEarlier = groupConversationEvents([
      event("older-commentary", "agent-message", {
        turn_id: "turn-1",
        message_phase: "commentary",
      }),
      event("user", "user-message", { turn_id: "turn-1" }),
      event("final", "agent-message", { turn_id: "turn-1", message_phase: "final_answer" }),
    ])[0];

    expect(afterEarlier.key).toBe(current.key);
  });

  it("folds contiguous legacy tools without crossing an annotated turn", () => {
    const groups = groupConversationEvents([
      event("legacy-tool-1", "tool-summary"),
      event("legacy-tool-2", "tool-summary"),
      event("annotated-user", "user-message", { turn_id: "turn-2" }),
      event("legacy-tool-3", "tool-summary"),
    ]);

    expect(groups.map((group) => group.events.map(({ id }) => id))).toEqual([
      ["legacy-tool-1", "legacy-tool-2"],
      ["annotated-user"],
      ["legacy-tool-3"],
    ]);
    expect(groups[0].segments[0].collapsible).toBe(true);
    expect(groups[2].segments[0].collapsible).toBe(true);
  });

  it("can conservatively keep a turn incomplete when the page has warnings", () => {
    const events = [
      event("user", "user-message", { turn_id: "turn-3" }),
      event("commentary", "agent-message", { turn_id: "turn-3", message_phase: "commentary" }),
      event("final", "agent-message", { turn_id: "turn-3", message_phase: "final_answer" }),
    ];

    expect(groupConversationEvents(events)[0].complete).toBe(true);
    expect(groupConversationEvents(events, { incomplete: true })[0].complete).toBe(false);
    expect(groupConversationEvents(events, { incomplete: true })[0].segments[1].collapsible).toBe(
      false,
    );
  });
});
