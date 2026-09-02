/** @jsxImportSource octane */

import type { DesktopApi } from "../electron/api";

declare global {
  interface Window {
    agentkibDesktop?: DesktopApi;
  }
}

export {};
