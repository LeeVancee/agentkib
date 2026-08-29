import type { PlatformEventHandler, PlatformEvents, Unlisten } from "./types";

const electronEventNames: Record<string, string> = {
  "agentkib:refresh-state": "agentkib:electron-refresh-state",
  "agentkib:navigate": "agentkib:electron-navigate",
  "theme-changed": "agentkib:theme-changed",
};

export const platformEvents: PlatformEvents = {
  listen: <T>(event: string, handler: PlatformEventHandler<T>): Promise<Unlisten> => {
    const target = globalThis.window;
    if (!target) return Promise.resolve(() => undefined);
    const eventName = electronEventNames[event] ?? event;
    const listener = (value: Event) => {
      handler({ payload: (value as CustomEvent<T>).detail });
    };
    target.addEventListener(eventName, listener);
    return Promise.resolve(() => target.removeEventListener(eventName, listener));
  },
};

export const listen = platformEvents.listen;
