/** @jsxImportSource octane */

export type AppPlatform = "macos" | "windows" | "linux";

export function normalizePlatform(platform?: string): AppPlatform {
  if (platform === "darwin" || platform === "macos") return "macos";
  if (platform === "windows" || platform === "win32") return "windows";
  if (platform === "linux") return platform;
  throw new Error(`Unsupported Electron platform: ${platform ?? "unknown"}`);
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
