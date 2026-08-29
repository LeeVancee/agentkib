import type { PlatformWindow } from "./types";

export const platformWindow: PlatformWindow = {
  hide: () => window.agentkibDesktop?.shell.hideWindow() ?? Promise.resolve(),
  isFullscreen: async () => false,
  onResized: async () => () => undefined,
};
