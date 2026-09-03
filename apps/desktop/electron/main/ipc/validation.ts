import type { BrowserWindow, IpcMainInvokeEvent } from "electron";

export function assertTrustedRenderer(
  event: IpcMainInvokeEvent,
  mainWindow: BrowserWindow | undefined,
): void {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error("Rejected IPC from an unknown renderer");
  }
}

export function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

export function requireText(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

export function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean`);
  return value;
}

export function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function optionalString(value: unknown, name: string): string | undefined {
  return value === undefined || value === null ? undefined : requireString(value, name);
}

export function optionalCloseBehavior(value: unknown): "minimize-to-tray" | "quit" | undefined {
  if (value === undefined || value === null) return undefined;
  if (value !== "minimize-to-tray" && value !== "quit") {
    throw new TypeError("close behavior must be minimize-to-tray or quit");
  }
  return value;
}

export function requireThemePreference(value: unknown): "system" | "light" | "dark" {
  if (value !== "system" && value !== "light" && value !== "dark") {
    throw new TypeError("theme preference must be system, light, or dark");
  }
  return value;
}

export function requireAccentThemePreference(
  value: unknown,
): "minimal-neutral" | "vtron" | "claude" | "sakura" | "ocean-breeze" {
  if (
    value !== "minimal-neutral" &&
    value !== "vtron" &&
    value !== "claude" &&
    value !== "sakura" &&
    value !== "ocean-breeze"
  ) {
    throw new TypeError("accent theme preference is not supported");
  }
  return value;
}

export function requireAppIconPreference(value: unknown): "white" | "black" {
  if (value !== "white" && value !== "black") {
    throw new TypeError("app icon preference must be white or black");
  }
  return value;
}

export function optionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

export function requirePositiveInteger(value: unknown, name: string): number {
  const parsed = optionalPositiveInteger(value, name);
  if (parsed === undefined) throw new TypeError(`${name} must be a positive integer`);
  return parsed;
}
