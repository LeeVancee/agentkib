import { resolveCommand } from "./command-resolution";
import type { Commands } from "./commands";
import { versionAtLeast } from "./native-version";

/** True for `X.Y.Z (Claude Code)` at or above `minimum`; anything else, including a malformed value, is false. */
export function supportsClaudeVersion(value: string, minimum = "2.1.263"): boolean {
  const match = /^(\d+\.\d+\.\d+) \(Claude Code\)$/.exec(value);
  return match !== null && versionAtLeast(match[1]!, minimum);
}

/**
 * The highest Claude Code version managed sessions were checked against (QA recording). It is
 * only used to explain a failure and to log once; it never gates anything. The gates above stay
 * lower bounds. 2.1.299: checked with the real CLI on 2026-10-14 (qa/claude-live-acceptance-2026-10-14.md).
 */
export const CLAUDE_MANAGED_VERIFIED_THROUGH = "2.1.299";

/** True for a Claude Code version line that is newer than the version managed sessions were verified through. */
export function isNewerThanVerified(value: string | null | undefined): boolean {
  const match = /^(\d+\.\d+\.\d+) \(Claude Code\)$/.exec(value ?? "");
  return (
    match !== null &&
    match[1] !== CLAUDE_MANAGED_VERIFIED_THROUGH &&
    versionAtLeast(match[1]!, CLAUDE_MANAGED_VERIFIED_THROUGH)
  );
}

/**
 * Run `claude --version` and return its output (`X.Y.Z (Claude Code)`), or null when the CLI is
 * missing, fails, times out, prints too much, or prints something that is not a Claude Code
 * version. No minimum version is applied here: callers decide what a version allows.
 */
export async function readClaudeVersion(
  commands: Commands,
  environment: NodeJS.ProcessEnv,
): Promise<string | null> {
  const executable = resolveCommand("claude", environment);
  if (!executable) return null;
  try {
    const output = await commands.run(executable, ["--version"], {
      env: environment,
      timeout: 5000,
      limit: 4096,
      strictOutput: true,
      allowFailure: true,
    });
    const version = output.bytes.toString("utf8").trim();
    return output.success && supportsClaudeVersion(version, "0.0.0") ? version : null;
  } catch {
    return null;
  }
}
