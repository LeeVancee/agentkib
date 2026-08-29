import type { AppUpdateProgress } from "@/core/types";

export interface PlatformApi {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  openDirectory(title?: string): Promise<string | undefined>;
  openExternal(url: string): Promise<void>;
  installAppUpdate(version: string, onEvent: (event: AppUpdateProgress) => void): Promise<void>;
}
