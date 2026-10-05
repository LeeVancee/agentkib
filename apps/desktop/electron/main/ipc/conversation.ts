import { ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import type { WebAccessService } from "../web/service";
import type { ConversationHub } from "../conversation-hub";
import type { SessionStreamEvent } from "../../generated/runtime-protocol";
import { requireObject, requireString, optionalString } from "./validation";

const MAX_UNACKNOWLEDGED_EVENTS = 256;
const MAX_UNACKNOWLEDGED_BYTES = 4 * 1024 * 1024;

interface RendererState {
  generation: number;
  pending: number;
  control?: { sessionId: string; notificationId: string };
  dirtyControl?: string;
}

interface Subscription {
  sender: WebContents;
  stopped: boolean;
  outstanding: { cursor: string; bytes: number }[];
  bytes: number;
}

function overflowEvent(event: SessionStreamEvent): SessionStreamEvent {
  return { ...event, type: "resync-required", payload: { reason: "desktop-subscriber-overflow" } };
}

export function registerConversationIpc(options: {
  service: WebAccessService;
  hub: ConversationHub;
  assertTrustedRenderer(event: IpcMainInvokeEvent): void;
}) {
  const owners = new Map<string, Subscription>();
  const watched = new Map<number, RendererState>();
  const stop = (subscription: Subscription) => {
    subscription.stopped = true;
    subscription.outstanding = [];
    subscription.bytes = 0;
    if (
      ![...owners.values()].some((owner) => owner.sender === subscription.sender && !owner.stopped)
    ) {
      const state = watched.get(subscription.sender.id);
      if (state) {
        state.control = undefined;
        state.dirtyControl = undefined;
      }
    }
  };
  const unsubscribe = (id: string) => void options.hub.unsubscribe(id).catch(() => undefined);
  const sendControl = (sender: WebContents, state: RendererState, sessionId: string) => {
    if (state.control) {
      // A single wildcard replaces changes to multiple sessions; never queue a
      // growing set of session IDs behind a stalled renderer.
      state.dirtyControl =
        state.dirtyControl === undefined || state.dirtyControl === sessionId ? sessionId : "";
      return;
    }
    state.control = { sessionId, notificationId: randomUUID() };
    sender.send("agentkib:conversation:control-changed", state.control);
  };
  const watch = (sender: WebContents) => {
    const existing = watched.get(sender.id);
    if (existing) return existing;
    const state: RendererState = { generation: 0, pending: 0 };
    watched.set(sender.id, state);
    const cleanup = () => {
      state.generation++;
      state.control = undefined;
      state.dirtyControl = undefined;
      for (const [id, owner] of owners)
        if (owner.sender === sender) {
          stop(owner);
          owners.delete(id);
          unsubscribe(id);
        }
    };
    sender.on("render-process-gone", cleanup);
    sender.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) cleanup();
    });
    sender.once("destroyed", () => {
      cleanup();
      watched.delete(sender.id);
    });
    return state;
  };
  options.hub.on("unavailable", () => {
    for (const state of watched.values()) {
      state.generation++;
      state.control = undefined;
      state.dirtyControl = undefined;
    }
    for (const owner of owners.values()) stop(owner);
    for (const sender of new Set([...owners.values()].map((owner) => owner.sender)))
      if (!sender.isDestroyed()) sender.send("agentkib:conversation:unavailable");
    owners.clear();
  });
  options.service.onControlChanged((sessionId) => {
    for (const sender of new Set(
      [...owners.values()].filter((owner) => !owner.stopped).map((owner) => owner.sender),
    )) {
      const state = watched.get(sender.id);
      if (state && !sender.isDestroyed()) sendControl(sender, state, sessionId);
    }
  });
  ipcMain.handle("agentkib:conversation:acknowledge-control", (event, id: unknown) => {
    options.assertTrustedRenderer(event);
    const notificationId = requireString(id, "notificationId");
    const state = watched.get(event.sender.id);
    if (!state || state.control?.notificationId !== notificationId) return;
    state.control = undefined;
    const dirty = state.dirtyControl;
    state.dirtyControl = undefined;
    if (
      dirty !== undefined &&
      !event.sender.isDestroyed() &&
      [...owners.values()].some((owner) => owner.sender === event.sender && !owner.stopped)
    )
      sendControl(event.sender, state, dirty);
  });
  ipcMain.handle("agentkib:conversation:acknowledge", (event, id: unknown, value: unknown) => {
    options.assertTrustedRenderer(event);
    const subscription = owners.get(requireString(id, "subscriptionId"));
    const cursor = requireString(value, "cursor");
    if (!subscription || subscription.sender !== event.sender || subscription.stopped) return;
    // Cumulative credit is limited to a cursor actually sent to this observer.
    // Foreign, stale and future acknowledgements cannot expand its window.
    const index = subscription.outstanding.findIndex((entry) => entry.cursor === cursor);
    if (index < 0) return;
    for (const entry of subscription.outstanding.splice(0, index + 1))
      subscription.bytes -= entry.bytes;
  });
  ipcMain.handle("agentkib:conversation:request", (event, path: unknown, body: unknown) => {
    options.assertTrustedRenderer(event);
    return options.service.localRequest(requireString(path, "path"), body);
  });
  ipcMain.handle("agentkib:conversation:upload", (event, input: unknown) => {
    options.assertTrustedRenderer(event);
    const data = requireObject(input, "upload");
    if (!(data.data instanceof ArrayBuffer) && !ArrayBuffer.isView(data.data))
      throw new Error("invalid_upload");
    const bytes =
      data.data instanceof ArrayBuffer
        ? new Uint8Array(data.data)
        : new Uint8Array(data.data.buffer, data.data.byteOffset, data.data.byteLength);
    if (bytes.byteLength > 25 * 1024 * 1024)
      return { status: 413, body: { error: "attachment_too_large" } };
    const query = new URLSearchParams({
      sessionId: requireString(data.sessionId, "sessionId"),
      name: requireString(data.name, "name"),
      mime: requireString(data.mime, "mime"),
    });
    return options.service.localRequest(`/attachments?${query}`, undefined, bytes);
  });
  ipcMain.handle(
    "agentkib:conversation:subscribe",
    async (event, sessionId: unknown, cursor: unknown) => {
      options.assertTrustedRenderer(event);
      const sender = event.sender;
      const state = watch(sender);
      if (
        state.pending + [...owners.values()].filter((owner) => owner.sender === sender).length >=
        4
      )
        throw new Error("stream_limit");
      if (typeof sessionId !== "string" || sessionId.length > 256)
        throw new Error("invalid_sessionId");
      const generation = state.generation;
      const subscription: Subscription = { sender, stopped: false, outstanding: [], bytes: 0 };
      let initializing = true;
      let early: SessionStreamEvent[] = [];
      let earlyBytes = 0;
      let overflow: SessionStreamEvent | undefined;
      const reserve = (value: SessionStreamEvent) => {
        const bytes = Buffer.byteLength(JSON.stringify(value));
        if (
          subscription.outstanding.length >= MAX_UNACKNOWLEDGED_EVENTS ||
          subscription.bytes + bytes > MAX_UNACKNOWLEDGED_BYTES
        )
          return false;
        subscription.outstanding.push({ cursor: value.cursor, bytes });
        subscription.bytes += bytes;
        return true;
      };
      state.pending++;
      try {
        const result = await options.service.localSubscribe(
          sessionId,
          optionalString(cursor, "cursor"),
          (value) => {
            if (sender.isDestroyed() || state.generation !== generation || subscription.stopped)
              return;
            if (initializing) {
              earlyBytes += Buffer.byteLength(JSON.stringify(value));
              if (
                early.length >= MAX_UNACKNOWLEDGED_EVENTS ||
                earlyBytes > MAX_UNACKNOWLEDGED_BYTES
              ) {
                overflow = overflowEvent(value);
                early = [];
                stop(subscription);
                unsubscribe(value.subscriptionId);
              } else early.push(value);
              return;
            }
            if (!reserve(value)) {
              stop(subscription);
              unsubscribe(value.subscriptionId);
              // Keep the owner slot until teardown, but detach the observer now.
              // Only this small marker may exceed the unconsumed event budget.
              sender.send("agentkib:conversation:event", overflowEvent(value));
              return;
            }
            sender.send("agentkib:conversation:event", value);
          },
        );
        if (sender.isDestroyed() || state.generation !== generation) {
          await options.hub.unsubscribe(result.subscriptionId);
          throw new Error("renderer_closed");
        }
        owners.set(result.subscriptionId, subscription);
        const last = result.events.at(-1);
        const events = [
          ...result.events,
          ...early.filter((value) => !last || value.epoch !== last.epoch || value.seq > last.seq),
        ];
        early = [];
        initializing = false;
        if (!overflow) {
          for (const value of events) {
            if (!reserve(value)) {
              overflow = overflowEvent(events.at(-1)!);
              stop(subscription);
              unsubscribe(result.subscriptionId);
              break;
            }
          }
        }
        // Bootstrap shares the same budget as steady-state pushes. Returning a
        // large replay through invoke must not bypass the acknowledgement window.
        return {
          ...result,
          events: overflow ? [overflow] : events,
          cursor: overflow?.cursor ?? events.at(-1)?.cursor ?? result.cursor,
        };
      } finally {
        state.pending--;
      }
    },
  );
  ipcMain.handle("agentkib:conversation:unsubscribe", async (event, id: unknown) => {
    options.assertTrustedRenderer(event);
    const subscriptionId = requireString(id, "subscriptionId");
    const subscription = owners.get(subscriptionId);
    if (subscription?.sender !== event.sender) return;
    stop(subscription);
    owners.delete(subscriptionId);
    await options.hub.unsubscribe(subscriptionId);
  });
}
