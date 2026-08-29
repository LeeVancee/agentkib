import { getCurrentWindow } from "@tauri-apps/api/window";
import type { PlatformWindow } from "./types";

export const platformWindow: PlatformWindow = {
  hide: () => getCurrentWindow().hide(),
  isFullscreen: () => getCurrentWindow().isFullscreen(),
  onResized: (handler) => getCurrentWindow().onResized(handler),
};
