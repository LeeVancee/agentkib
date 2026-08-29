import { Channel, invoke as tauriInvoke } from "@tauri-apps/api/core";
import { open as tauriOpen } from "@tauri-apps/plugin-dialog";
import { openUrl as tauriOpenUrl } from "@tauri-apps/plugin-opener";
import type { AppUpdateProgress } from "@/core/types";
import type { PlatformApi } from "./types";

export const platformApi: PlatformApi = {
  invoke: <T>(command: string, args?: Record<string, unknown>) =>
    args === undefined ? tauriInvoke<T>(command) : tauriInvoke<T>(command, args),
  openDirectory: async (title) => {
    const selected = await tauriOpen({ directory: true, multiple: false, title });
    return typeof selected === "string" ? selected : undefined;
  },
  openExternal: (url) => tauriOpenUrl(url),
  installAppUpdate: (version, onEvent) => {
    const channel = new Channel<AppUpdateProgress>();
    channel.onmessage = onEvent;
    return tauriInvoke<void>("install_app_update", { version, onEvent: channel });
  },
};
