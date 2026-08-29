import type { PlatformApi } from "./types";

function unavailable<T>(operation: string): Promise<T> {
  return Promise.reject(new Error(`${operation} is unavailable outside a desktop runtime`));
}

export const platformApi: PlatformApi = {
  invoke: <T>() => unavailable<T>("Platform IPC"),
  openDirectory: () => unavailable<string | undefined>("Directory picker"),
  openExternal: () => unavailable<void>("External links"),
  installAppUpdate: () => unavailable<void>("App updates"),
};
