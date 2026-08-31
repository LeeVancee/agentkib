import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const STABLE_APP_DATA_DIRECTORY = "ai.agentkib";
export const DEVELOPMENT_APP_DATA_DIRECTORY = "ai.agentkib.dev";
export const LEGACY_APP_DATA_DIRECTORY = "com.agentkib.desktop";

export interface DataPathOptions {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  appFlavor?: "stable" | "development";
  migrateLegacy?: boolean;
}

/** Resolve AgentKib's platform data directory without creating it. */
export function defaultDataDir(options: DataPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const home = options.homeDirectory ?? homedir();
  const base = localDataDirectory(platform, environment, home);
  const flavor =
    options.appFlavor ??
    (environment.AGENTKIB_APP_FLAVOR === "ai.agentkib.dev" ? "development" : "stable");
  const currentName =
    flavor === "development" ? DEVELOPMENT_APP_DATA_DIRECTORY : STABLE_APP_DATA_DIRECTORY;
  const current = path.join(base, currentName);
  if (flavor === "stable" && (options.migrateLegacy ?? true))
    migrateLegacyDirectory(current, path.join(base, LEGACY_APP_DATA_DIRECTORY));
  return current;
}

export function defaultDatabasePath(options: DataPathOptions = {}): string {
  return path.join(defaultDataDir(options), "agentkib.db");
}

export function defaultBackupDir(options: DataPathOptions = {}): string {
  return path.join(defaultDataDir(options), "backups");
}

function localDataDirectory(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  home: string,
): string {
  if (platform === "darwin")
    return environment.HOME
      ? path.join(home, "Library", "Application Support")
      : path.join(home, "Library", "Application Support");
  if (platform === "win32") return environment.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const configured = environment.XDG_DATA_HOME;
  return configured && path.isAbsolute(configured)
    ? configured
    : path.join(home, ".local", "share");
}

function migrateLegacyDirectory(current: string, legacy: string): void {
  if (existsSync(current) || !existsSync(legacy)) return;
  try {
    renameSync(legacy, current);
  } catch (error) {
    // Concurrent startup may have completed the one-time rename already.
    if (existsSync(current) && !existsSync(legacy)) return;
    throw error;
  }
}
