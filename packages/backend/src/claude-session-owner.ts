import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Commands } from "./commands";
import { resolveCommand } from "./command-resolution";
import { resolveClaudeConfig } from "./claude-config";

export type ClaudeSessionOwnership =
  | { kind: "idle" }
  | { kind: "interactive" | "background"; pid: number; source: "agents" | "registry" | "ps" };

type Process = { start: string; command: string };
const unavailable = () => new Error("claude-owner-check-unavailable");
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const pidOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
const normalizedStart = (value: string) => value.trim().replace(/\s+/g, " ");
const ownershipKind = (kind: unknown): "interactive" | "background" =>
  kind === "background" ? "background" : "interactive";

/** Read-only observations. No caching: every worker start must see current external ownership. */
export class ClaudeSessionOwnerProbe {
  constructor(
    readonly commands: Commands,
    readonly environment: NodeJS.ProcessEnv,
  ) {}

  async check(nativeId: string, ownedPid: number | null = null): Promise<ClaudeSessionOwnership> {
    if (process.platform !== "darwin" && process.platform !== "linux")
      throw new Error("platform-unsupported");
    // Liveness must be newer than the agents observation: an earlier process snapshot can
    // omit a newly opened session and incorrectly discard positive ownership as a dead PID.
    const agents = await this.#agents().catch(() => null);
    const processes = await this.#processes().catch(() => null);
    let uncertain = false;

    for (const agent of agents ?? []) {
      if (!object(agent) || agent.sessionId !== nativeId) continue;
      const pid = pidOf(agent.pid);
      if (pid === null) {
        uncertain = true;
        continue;
      }
      if (pid === ownedPid || (processes && !processes.has(pid))) continue;
      return { kind: ownershipKind(agent.kind), pid, source: "agents" };
    }

    if (processes) {
      const registry = this.#registry(nativeId, ownedPid, processes);
      if (registry.owner) return registry.owner;
      uncertain ||= registry.uncertain;
      for (const [pid, row] of processes) {
        if (pid === ownedPid) continue;
        const words = row.command.trim().split(/\s+/);
        if (!words.some((word) => path.posix.basename(word) === "claude")) continue;
        const mentioned = words.some(
          (word, index) =>
            word === `--resume=${nativeId}` ||
            word === `--session-id=${nativeId}` ||
            (["--resume", "-r", "--session-id"].includes(word) && words[index + 1] === nativeId),
        );
        if (mentioned)
          return {
            kind: words.some((word) => word === "--print" || word === "-p")
              ? "background"
              : "interactive",
            pid,
            source: "ps",
          };
      }
    }
    // A successful but empty agents response cannot replace the retained process scan. Older
    // CLIs and sessions that have not registered yet may only be visible through `ps`.
    if (!processes || uncertain) throw unavailable();
    return { kind: "idle" };
  }

  async #agents(): Promise<unknown[] | null> {
    const executable = resolveCommand("claude", this.environment);
    if (!executable) return null;
    const result = await this.commands.run(executable, ["agents", "--json"], {
      env: this.environment,
      timeout: 3000,
      limit: 2 * 1024 * 1024,
      strictOutput: true,
      allowFailure: true,
    });
    if (!result.success || result.truncated) return null;
    try {
      const value: unknown = JSON.parse(result.bytes.toString("utf8"));
      return Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  }

  async #processes(): Promise<Map<number, Process>> {
    const result = await this.commands.run("/bin/ps", ["-axo", "pid=,lstart=,command="], {
      env: { ...this.environment, TZ: "UTC", LC_ALL: "C", LANG: "C" },
      timeout: 3000,
      limit: 4 * 1024 * 1024,
      strictOutput: true,
    });
    if (!result.success || result.truncated) throw unavailable();
    const processes = new Map<number, Process>();
    for (const line of result.bytes.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      const match =
        /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(line);
      if (!match) throw unavailable();
      const pid = pidOf(Number(match[1]));
      if (pid === null) throw unavailable();
      processes.set(pid, { start: normalizedStart(match[2]!), command: match[3]! });
    }
    return processes;
  }

  #registry(
    nativeId: string,
    ownedPid: number | null,
    processes: Map<number, Process>,
  ): { owner: ClaudeSessionOwnership | null; uncertain: boolean } {
    const home = this.environment.HOME ?? homedir();
    const config = resolveClaudeConfig(this.environment, home);
    if (config.invalid) return { owner: null, uncertain: true };
    const directory = path.join(config.dir, "sessions");
    let entries: string[];
    try {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return { owner: null, uncertain: true };
      entries = readdirSync(directory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return { owner: null, uncertain: code !== "ENOENT" && code !== "ENOTDIR" };
    }
    if (entries.length > 4096) return { owner: null, uncertain: true };
    let uncertain = false;
    for (const name of entries) {
      if (!/^[1-9]\d*\.json$/.test(name)) continue;
      const filenamePid = Number(name.slice(0, -5));
      if (!processes.has(filenamePid) || filenamePid === ownedPid) continue;
      let value: unknown;
      let fd: number | undefined;
      try {
        const file = path.join(directory, name);
        const stat = lstatSync(file);
        if (stat.isSymbolicLink()) continue;
        if (!stat.isFile() || stat.size > 64 * 1024) {
          uncertain = true;
          continue;
        }
        fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        const opened = fstatSync(fd);
        if (
          !opened.isFile() ||
          opened.size > 64 * 1024 ||
          opened.ino !== stat.ino ||
          opened.dev !== stat.dev
        )
          throw unavailable();
        const bytes = Buffer.alloc(64 * 1024 + 1);
        let length = 0;
        while (length < bytes.length) {
          const size = readSync(fd, bytes, length, bytes.length - length, null);
          if (size === 0) break;
          length += size;
        }
        if (length > 64 * 1024) throw unavailable();
        value = JSON.parse(bytes.subarray(0, length).toString("utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") uncertain = true;
        continue;
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
      if (!object(value)) {
        uncertain = true;
        continue;
      }
      if (value.sessionId !== nativeId) continue;
      if (typeof value.pidDomain === "string" && value.pidDomain !== process.platform) continue;
      const pid = pidOf(value.pid);
      if (pid !== filenamePid || typeof value.procStart !== "string" || !value.procStart.trim()) {
        uncertain = true;
        continue;
      }
      // CLI registry records use UTC lstart. Matching the birth time prevents a dead PID's
      // stale record from claiming an unrelated process after the OS reuses that PID.
      if (normalizedStart(value.procStart) !== processes.get(pid)!.start) continue;
      return {
        owner: { kind: ownershipKind(value.kind), pid, source: "registry" },
        uncertain,
      };
    }
    return { owner: null, uncertain };
  }
}
