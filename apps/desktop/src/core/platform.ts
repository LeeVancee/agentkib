export type AppPlatform = "macos" | "windows" | "linux" | "web";

type TauriWindow = Window & {
  __TAURI_INTERNALS__?: unknown;
};

export function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean((window as TauriWindow).__TAURI_INTERNALS__)
  );
}

export function isElectronRuntime(): boolean {
  return typeof window !== "undefined" && Boolean(window.agentkibDesktop);
}

export function normalizePlatform(platform?: string): AppPlatform {
  if (platform === "darwin" || platform === "macos") return "macos";
  if (platform === "windows" || platform === "linux") return platform;
  return "web";
}

export function applyPlatformAttribute(platform?: string): void {
  document.documentElement.dataset.platform = normalizePlatform(platform);
}

export function primaryShortcutModifier(platform?: string): "Command" | "Ctrl" {
  return normalizePlatform(platform) === "macos" ? "Command" : "Ctrl";
}

export function usesSystemTrayWording(platform?: string): boolean {
  return normalizePlatform(platform) === "linux";
}
