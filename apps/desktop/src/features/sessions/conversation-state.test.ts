import { describe, expect, it, vi } from "vitest";
import {
  createConversationState,
  createConversationStore,
  mergeConversationItems,
  reduceSessionStreamEvent,
  type ConversationItem,
  type SessionStreamEvent,
} from "@agentkib/conversation-state";

type Live = {
  sessionId: string;
  revision: number;
  status: string;
  streamText?: string;
  reason?: string;
};
const base = {
  protocolVersion: 2 as const,
  subscriptionId: "subscription",
  sessionId: "session",
  runtimeBootId: "boot",
  epoch: "epoch",
};
const snapshot = (seq = 7): Extract<SessionStreamEvent<Live>, { type: "snapshot" }> => ({
  ...base,
  seq,
  cursor: `cursor-${seq}`,
  type: "snapshot",
  payload: { live: { sessionId: "session", revision: 2, status: "running" }, items: [] },
});
const delta = (seq: number, text: string, offset: number): SessionStreamEvent<Live> => ({
  ...base,
  seq,
  cursor: `cursor-${seq}`,
  type: "text-delta",
  payload: { itemId: "reply", turnId: "turn", text, offset },
});
const initial = () =>
  reduceSessionStreamEvent(createConversationState<Live>("session"), snapshot());

describe("conversation event state", () => {
  it("applies Unicode deltas to a stable item without changing the control revision", () => {
    const first = reduceSessionStreamEvent(initial(), delta(8, "🙂", 0));
    const second = reduceSessionStreamEvent(first, delta(9, "好", 2));
    expect(second.items).toMatchObject([{ id: "reply", content: "🙂好", turn_id: "turn" }]);
    expect(second.live?.revision).toBe(2);
    const complete: ConversationItem = {
      ...second.items[0],
      message_phase: "final_answer",
    };
    const final = reduceSessionStreamEvent(second, {
      ...base,
      seq: 10,
      cursor: "cursor-10",
      type: "item-upsert",
      payload: complete,
    });
    expect(final.items).toEqual([complete]);
  });

  it("does not advance the acknowledged cursor across missing or conflicting text", () => {
    const first = reduceSessionStreamEvent(initial(), delta(8, "a", 0));
    const gap = reduceSessionStreamEvent(first, delta(10, "c", 2));
    expect(gap).toMatchObject({ seq: 8, cursor: "cursor-8", resyncRequired: "sequence-gap" });
    expect(reduceSessionStreamEvent(gap, delta(9, "b", 1))).toBe(gap);
    const conflict = reduceSessionStreamEvent(first, delta(9, "x", 0));
    expect(conflict).toMatchObject({ seq: 8, resyncRequired: "text-offset-conflict" });
    expect(reduceSessionStreamEvent(first, delta(9, "b", 3)).resyncRequired).toBe(
      "text-offset-gap",
    );
  });

  it("ignores duplicates, previous sessions and a retired runtime epoch", () => {
    const first = reduceSessionStreamEvent(initial(), delta(8, "hello", 0));
    expect(reduceSessionStreamEvent(first, delta(8, "hello", 0))).toBe(first);
    expect(reduceSessionStreamEvent(first, { ...delta(9, "!", 5), sessionId: "other" })).toBe(
      first,
    );
    const reset = reduceSessionStreamEvent(first, {
      ...snapshot(0),
      epoch: "next",
      runtimeBootId: "new",
    });
    expect(reset.items).toEqual([]);
    expect(reduceSessionStreamEvent(reset, snapshot(100))).toBe(reset);
  });

  it("accepts an authoritative resync and de-duplicates overlapping replay by identity", () => {
    const first = reduceSessionStreamEvent(initial(), delta(8, "hello", 0));
    const overlapping = reduceSessionStreamEvent(first, delta(9, "lo!", 3));
    expect(overlapping.items[0].content).toBe("hello!");
    const gap = reduceSessionStreamEvent(overlapping, delta(12, "x", 6));
    const restored = reduceSessionStreamEvent(gap, {
      ...snapshot(12),
      payload: {
        live: { sessionId: "session", status: "idle", revision: 4 },
        items: overlapping.items,
      },
    });
    expect(restored.resyncRequired).toBeUndefined();
    const duplicateText = { ...restored.items[0], id: "another-reply" };
    expect(mergeConversationItems(restored.items, [duplicateText])).toHaveLength(2);
  });

  it("publishes only applied state and clears subscription state on reset", () => {
    const store = createConversationStore<Live>("session");
    const notify = vi.fn();
    const unsubscribe = store.subscribe(notify);
    store.dispatch(snapshot());
    store.dispatch(delta(8, "hello", 0));
    store.dispatch(delta(8, "hello", 0));
    expect(notify).toHaveBeenCalledTimes(2);
    store.reset("next-session");
    expect(store.getSnapshot()).toMatchObject({ sessionId: "next-session", seq: -1, items: [] });
    unsubscribe();
    store.reset();
    expect(notify).toHaveBeenCalledTimes(3);
  });

  it("replaces a control fence without advancing delivery or discarding streamed content", () => {
    const store = createConversationStore<Live>("session");
    store.dispatch({
      ...snapshot(),
      payload: {
        live: {
          sessionId: "session",
          status: "outcome-unknown",
          reason: "control-outcome-unconfirmed",
          revision: 2,
        },
      },
    });
    store.dispatch(delta(8, "answer", 0));
    store.dispatch({
      ...base,
      seq: 9,
      cursor: "cursor-9",
      type: "text-delta",
      payload: { text: "streaming", offset: 0 },
    });
    const before = store.getSnapshot();
    const live = { sessionId: "session", status: "idle", revision: 6 };
    const replaced = store.replaceLive(live);
    expect(replaced).toEqual({ ...before, live });
    expect(replaced.live).not.toHaveProperty("reason");
    expect(replaced.items).toBe(before.items);
    expect(replaced.streamText).toBe("streaming");
    const next = store.dispatch(delta(10, "!", 6));
    expect(next.live?.status).toBe("idle");
    expect(next.items[0].content).toBe("answer!");
  });

  it("retains explicit ephemeral identity until an authoritative replacement", () => {
    const first = reduceSessionStreamEvent(initial(), {
      ...base,
      seq: 8,
      cursor: "cursor-8",
      type: "text-delta",
      payload: { itemId: "temporary", turnId: "turn", text: "same", offset: 0, ephemeral: true },
    });
    expect(first.items[0].ephemeral).toBe(true);
    const replacement = { ...first.items[0], id: "native", ephemeral: false };
    const restored = reduceSessionStreamEvent(first, {
      ...snapshot(9),
      payload: { live: first.live!, items: [replacement], replaceItems: true },
    });
    expect(restored.items).toEqual([replacement]);
  });
});
