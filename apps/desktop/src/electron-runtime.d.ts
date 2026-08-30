import type { DesktopApi } from "../electron/desktop-api";

declare global {
  interface Window {
    agentkibDesktop?: DesktopApi;
  }
}

export {};
