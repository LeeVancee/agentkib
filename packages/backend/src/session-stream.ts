import { randomUUID } from "node:crypto";
import type { SessionStreamEvent, SessionSubscription } from "@agentkib/runtime-protocol";

const MAX_SUBSCRIPTIONS = 128;
const MAX_REPLAY_EVENTS = 256;
const MAX_REPLAY_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_INTERVAL_MS = 250;

interface Snapshot {
  live: Record<string, unknown>;
  items: Record<string, unknown>[];
}

interface Source {
  epoch: string;
  seq: number;
  snapshot: Snapshot;
  replay: SessionStreamEvent[];
  replayBytes: number;
  nextPollAt: number;
}

interface Subscription {
  id: string;
  sessionId: string;
  delivered: number;
}

/** Bounded runtime event stream for native sessions; native history remains authoritative. */
export class SessionStreamHub {
  #sources = new Map<string, Source>();
  #subscriptions = new Map<string, Subscription>();
  #timer: ReturnType<typeof setInterval>;
  #polling = false;
  #closed = false;

  constructor(
    private readonly bootId: string,
    private readonly readSnapshot: (sessionId: string) => Promise<Snapshot>,
    private readonly notify: (event: SessionStreamEvent) => void,
  ) {
    this.#timer = setInterval(() => void this.#poll(), SNAPSHOT_INTERVAL_MS);
    this.#timer.unref();
  }

  async subscribe(sessionId: string, afterCursor?: string): Promise<SessionSubscription> {
    if (this.#closed) throw new Error("session-stream-unavailable");
    if (sessionId.length > 256) throw new Error("invalid-session-id");
    if (this.#subscriptions.size >= MAX_SUBSCRIPTIONS)
      throw new Error("session-subscription-limit");

    const snapshot = await this.readSnapshot(sessionId);
    let source = this.#sources.get(sessionId);
    if (!source) {
      source = {
        epoch: randomUUID(),
        seq: 0,
        snapshot,
        replay: [],
        replayBytes: 0,
        nextPollAt: Date.now() + (sessionId ? SNAPSHOT_INTERVAL_MS : 2_000),
      };
      this.#sources.set(sessionId, source);
    } else if (JSON.stringify(source.snapshot) !== JSON.stringify(snapshot)) {
      source.snapshot = snapshot;
      this.#append(sessionId, source, "snapshot", {
        live: snapshot.live,
        items: snapshot.items,
        replaceItems: true,
      });
    }

    const subscriptionId = randomUUID();
    const cursorSequence = this.#sequence(afterCursor, source.epoch);
    const earliest = source.replay[0]?.seq ?? source.seq;
    const replayIsAvailable =
      cursorSequence !== undefined &&
      cursorSequence <= source.seq &&
      cursorSequence + 1 >= earliest;
    const events = replayIsAvailable
      ? source.replay
          .filter((event) => event.seq > cursorSequence)
          .map((event) => ({ ...event, subscriptionId }))
      : [
          this.#event(sessionId, subscriptionId, source, "snapshot", {
            live: source.snapshot.live,
            items: source.snapshot.items,
            replaceItems: true,
          }),
        ];
    this.#subscriptions.set(subscriptionId, {
      id: subscriptionId,
      sessionId,
      delivered: source.seq,
    });
    const last = events.at(-1);
    return {
      subscriptionId,
      events,
      cursor: last?.cursor ?? this.#cursor(source.epoch, source.seq),
    };
  }

  unsubscribe(subscriptionId: string): { removed: boolean } {
    const subscription = this.#subscriptions.get(subscriptionId);
    const removed = this.#subscriptions.delete(subscriptionId);
    if (
      subscription &&
      ![...this.#subscriptions.values()].some((item) => item.sessionId === subscription.sessionId)
    )
      this.#sources.delete(subscription.sessionId);
    return { removed };
  }

  publish(
    sessionId: string,
    type: SessionStreamEvent["type"],
    payload: Record<string, unknown>,
    live?: Record<string, unknown>,
  ): void {
    const source = this.#sources.get(sessionId);
    if (!source || ![...this.#subscriptions.values()].some((item) => item.sessionId === sessionId))
      return;
    if (live) source.snapshot = { ...source.snapshot, live };
    if (type === "item-upsert" && typeof payload.id === "string") {
      const items = source.snapshot.items.filter((item) => item.id !== payload.id);
      items.push(payload);
      source.snapshot = { ...source.snapshot, items };
    }
    this.#append(sessionId, source, type, payload);
    const event = source.replay.at(-1);
    if (!event) return;
    for (const subscription of this.#subscriptions.values()) {
      if (subscription.sessionId !== sessionId) continue;
      this.notify({ ...event, subscriptionId: subscription.id });
      subscription.delivered = event.seq;
    }
  }

  close(): void {
    this.#closed = true;
    clearInterval(this.#timer);
    this.#subscriptions.clear();
    this.#sources.clear();
  }

  async #poll(): Promise<void> {
    if (this.#closed || this.#polling) return;
    this.#polling = true;
    try {
      const sessionIds = new Set([...this.#subscriptions.values()].map((item) => item.sessionId));
      for (const sessionId of sessionIds) {
        if (this.#closed) return;
        const source = this.#sources.get(sessionId);
        if (!source || source.nextPollAt > Date.now()) continue;
        source.nextPollAt = Date.now() + (sessionId ? SNAPSHOT_INTERVAL_MS : 2_000);
        try {
          const snapshot = await this.readSnapshot(sessionId);
          if (JSON.stringify(source.snapshot) === JSON.stringify(snapshot)) continue;
          source.snapshot = snapshot;
          this.#append(
            sessionId,
            source,
            sessionId === "" ? "invalidate" : "snapshot",
            sessionId === ""
              ? { domains: ["catalog"] }
              : { live: snapshot.live, items: snapshot.items, replaceItems: true },
          );
          for (const subscription of this.#subscriptions.values()) {
            if (subscription.sessionId !== sessionId) continue;
            const event = source.replay.at(-1);
            if (!event || event.seq <= subscription.delivered) continue;
            this.notify({ ...event, subscriptionId: subscription.id });
            subscription.delivered = event.seq;
          }
        } catch {
          // A transient provider read must not tear down other live sessions.
        }
      }
    } finally {
      this.#polling = false;
    }
  }

  #append(
    sessionId: string,
    source: Source,
    type: SessionStreamEvent["type"],
    payload: Record<string, unknown>,
  ): void {
    source.seq += 1;
    const event = this.#event(sessionId, "", source, type, payload);
    const bytes = Buffer.byteLength(JSON.stringify(event));
    source.replay.push(event);
    source.replayBytes += bytes;
    while (source.replay.length > MAX_REPLAY_EVENTS || source.replayBytes > MAX_REPLAY_BYTES) {
      const removed = source.replay.shift();
      if (removed) source.replayBytes -= Buffer.byteLength(JSON.stringify(removed));
    }
  }

  #event(
    sessionId: string,
    subscriptionId: string,
    source: Source,
    type: SessionStreamEvent["type"],
    payload: Record<string, unknown>,
  ): SessionStreamEvent {
    return {
      protocolVersion: 2,
      subscriptionId,
      sessionId,
      runtimeBootId: this.bootId,
      epoch: source.epoch,
      seq: source.seq,
      cursor: this.#cursor(source.epoch, source.seq),
      type,
      payload,
    };
  }

  #cursor(epoch: string, seq: number): string {
    return `${this.bootId}:${epoch}:${seq}`;
  }

  #sequence(cursor: string | undefined, epoch: string): number | undefined {
    if (!cursor || cursor.length > 1024) return undefined;
    const prefix = `${this.bootId}:${epoch}:`;
    if (!cursor.startsWith(prefix)) return undefined;
    const sequence = Number(cursor.slice(prefix.length));
    return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : undefined;
  }
}
