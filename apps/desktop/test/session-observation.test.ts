import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionStreamHub } from "../../../packages/backend/src/session-stream";

const hubs: SessionStreamHub[] = [];
afterEach(() => {
  for (const hub of hubs.splice(0)) hub.close();
  vi.useRealTimers();
});

describe("session ownership observation", () => {
  it("records short subscriptions synchronously while retaining other subscribers", async () => {
    vi.useFakeTimers();
    const observed: string[] = [];
    const hub = new SessionStreamHub(
      "boot",
      async (sessionId) => ({ live: { sessionId }, items: [], completeItems: true }),
      vi.fn(),
      (sessionId) => {
        expect(hub.hasSubscribers(sessionId)).toBe(true);
        observed.push(sessionId);
      },
    );
    hubs.push(hub);
    const first = await hub.subscribe("session");
    const second = await hub.subscribe("session");
    // Both clients can leave before the first poll or retirement timer tick.
    hub.unsubscribe(first.subscriptionId);
    expect(hub.hasSubscribers("session")).toBe(true);
    hub.unsubscribe(second.subscriptionId);
    expect(hub.hasSubscribers("session")).toBe(false);
    expect(observed).toEqual(["session", "session"]);
  });

  it("does not treat catalog streams or failed subscriptions as session observation", async () => {
    const observed = vi.fn();
    const hub = new SessionStreamHub(
      "boot",
      async (sessionId) => {
        if (sessionId === "unavailable") throw new Error("session-unavailable");
        return { live: {}, items: [], completeItems: true };
      },
      vi.fn(),
      observed,
    );
    hubs.push(hub);
    const catalog = await hub.subscribe("");
    expect(hub.hasSubscribers("")).toBe(true);
    await expect(hub.subscribe("unavailable")).rejects.toThrow("session-unavailable");
    expect(hub.hasSubscribers("unavailable")).toBe(false);
    expect(observed).not.toHaveBeenCalled();
    hub.unsubscribe(catalog.subscriptionId);
  });
});
