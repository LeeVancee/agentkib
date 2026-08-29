import { listen as tauriListen } from "@tauri-apps/api/event";
import type { PlatformEventHandler, PlatformEvents, Unlisten } from "./types";

export const platformEvents: PlatformEvents = {
  listen: <T>(event: string, handler: PlatformEventHandler<T>): Promise<Unlisten> =>
    tauriListen<T>(event === "theme-changed" ? "tauri://theme-changed" : event, handler),
};

export const listen = platformEvents.listen;
