import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { readText } from "./files";
import { userHome } from "./mcp-config-read";
import { isReparseOrSymlink } from "./native-files";

function configuredPath(value: string | undefined, fallback: string, env: NodeJS.ProcessEnv) {
  let expanded = (value ?? fallback).trim();
  expanded = expanded.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
    const replacement = env[name];
    if (replacement === undefined) throw new Error(`Unresolved Agent Home variable: ${name}`);
    return replacement;
  });
  if (expanded === "~") expanded = userHome(env);
  else if (expanded.startsWith("~/") || expanded.startsWith("~\\"))
    expanded = path.join(userHome(env), expanded.slice(2));
  if (!path.isAbsolute(expanded)) throw new Error("Agent Home must be an absolute path");
  return path.normalize(expanded);
}

/** Validate even missing targets: an existing ancestor must never redirect this write. */
export function safeAgentHomePath(target: string): string {
  for (let current = target; ; current = path.dirname(current)) {
    try {
      const metadata = lstatSync(current);
      if (isReparseOrSymlink(current, metadata) || (current !== target && !metadata.isDirectory()))
        throw new Error("Agent Home contains an unsafe path");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (path.dirname(current) === current) break;
  }
  return target;
}

export function openClawHome(env: NodeJS.ProcessEnv): { home: string; config: string } {
  const root = configuredPath(env.OPENCLAW_HOME, userHome(env), env);
  const profile = env.OPENCLAW_PROFILE?.trim() || "default";
  if (!/^[A-Za-z0-9_-]+$/.test(profile)) throw new Error("Invalid OpenClaw profile name");
  const state = configuredPath(
    env.OPENCLAW_STATE_DIR,
    path.join(root, profile.toLowerCase() === "default" ? ".openclaw" : `.openclaw-${profile}`),
    env,
  );
  const config = configuredPath(env.OPENCLAW_CONFIG_PATH, path.join(state, "openclaw.json"), env);
  return { home: safeAgentHomePath(state), config: safeAgentHomePath(config) };
}

export function hermesTargetHome(env: NodeJS.ProcessEnv): { home: string; profile: string } {
  const base = safeAgentHomePath(
    configuredPath(env.HERMES_HOME, path.join(userHome(env), ".hermes"), env),
  );
  let profile: string;
  let selected: string;
  if (path.basename(path.dirname(base)) === "profiles") {
    profile = path.basename(base);
    selected = base;
  } else {
    let active = "default";
    const activeFile = safeAgentHomePath(path.join(base, "active_profile"));
    try {
      active = readText(activeFile, 256).trim() || "default";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    profile = active;
    selected = active === "default" ? base : path.join(base, "profiles", active);
  }
  if (!profile || profile.length > 64 || !/^[A-Za-z0-9_-]+$/.test(profile))
    throw new Error("Invalid Hermes profile name");
  safeAgentHomePath(selected);
  try {
    selected = realpathSync(selected);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { home: selected, profile };
}

export function agentMcpHome(agent: "open-claw" | "hermes", env: NodeJS.ProcessEnv) {
  if (agent === "open-claw") return openClawHome(env);
  const { home } = hermesTargetHome(env);
  return { home, config: safeAgentHomePath(path.join(home, "config.yaml")) };
}
