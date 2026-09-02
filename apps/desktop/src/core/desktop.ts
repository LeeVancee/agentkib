/** @jsxImportSource octane */

import type { DesktopApi } from "../../electron/api";

export function desktopApi(): DesktopApi {
  const desktop = globalThis.window?.agentkibDesktop;
  if (!desktop) {
    throw new Error("Electron preload bridge is unavailable");
  }
  return desktop;
}
