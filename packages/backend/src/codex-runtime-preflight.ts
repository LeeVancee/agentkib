import { statSync } from "node:fs";
import { Commands } from "./commands";
import { resolveCommand } from "./command-resolution";

export const MINIMUM_CODEX_WRITER_VERSION = "0.147.0";

function parseVersion(output: string): RegExpExecArray | null {
  const match =
    /^codex(?:-cli)?\s+(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\s*$/.exec(
      output.trim(),
    );
  if (!match) return null;
  const parts = match.slice(1, 4).map(Number);
  return parts.every((part) => Number.isSafeInteger(part)) ? match : null;
}

export function codexVersionSupportsWriterLock(output: string): boolean {
  const match = parseVersion(output);
  if (!match) return false;
  const parts = match.slice(1, 4).map(Number);
  const minimum = MINIMUM_CODEX_WRITER_VERSION.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    if (parts[index] !== minimum[index]) return parts[index]! > minimum[index]!;
  }
  // A prerelease of the first supported release is still older than that release.
  return !match[4];
}

export class CodexRuntimePreflight {
  #commands = new Commands();
  #cached?: {
    identity: string;
    checkedAt: number;
    result: Promise<{ executable?: string; reason: string | null }>;
  };

  constructor(readonly environment: NodeJS.ProcessEnv) {}

  close(): void {
    this.#commands.close();
  }

  check(): Promise<{ executable?: string; reason: string | null }> {
    const executable = resolveCommand("codex", this.environment);
    if (!executable) return Promise.resolve({ reason: "codex-cli-unavailable" });
    let info;
    try {
      info = statSync(executable);
    } catch {
      return Promise.resolve({ reason: "codex-cli-unavailable" });
    }
    const identity = `${executable}:${info.mtimeMs}:${info.size}`;
    if (this.#cached?.identity === identity && Date.now() - this.#cached.checkedAt < 30_000)
      return this.#cached.result;
    const result = this.#commands
      .run(executable, ["--version"], {
        env: this.environment,
        limit: 512,
        timeout: 5000,
        strictOutput: true,
      })
      .then(
        (output) => ({
          executable,
          reason: !parseVersion(output.bytes.toString("utf8"))
            ? "codex-cli-version-unavailable"
            : codexVersionSupportsWriterLock(output.bytes.toString("utf8"))
              ? null
              : "codex-cli-version-too-old",
        }),
        () => ({ executable, reason: "codex-cli-version-unavailable" }),
      );
    this.#cached = { identity, checkedAt: Date.now(), result };
    return result;
  }
}
