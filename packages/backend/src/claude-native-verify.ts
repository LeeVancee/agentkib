import path from "node:path";
import { probeClaudeSessionFile } from "./claude-session-probe";
import { pathIdentity } from "./paths";

/**
 * Structural read-back of a Claude Code transcript that AgentKib has just written.
 *
 * It proves the file is what the writer (`renderNative`) intended and what AgentKib's own readers
 * and the format probe accept. It cannot prove that `claude --resume` will find the session: no
 * Claude process is started, so a CLI-side lookup rule AgentKib does not know about stays unchecked.
 */

/** Record types `renderNative` writes for Claude Code. Anything else is unexpected output. */
const WRITTEN_TYPES = new Set(["user", "assistant", "last-prompt"]);
const MESSAGE_TYPES = new Set(["user", "assistant"]);

export interface ClaudeNativeExpectation {
  /** Session id the launch request names; must equal the file name and every record's sessionId. */
  sessionId: string;
  /** Workspace the session was written for; must equal every message record's cwd. */
  workspace: string;
  /** `<projects>/<claudeProjectKey(workspace)>`: the only directory the file may live in. */
  directory: string;
}

function fail(reason: string): never {
  throw new Error(`Claude session read-back failed: ${reason}`);
}

export function verifyClaudeTranscript(
  file: string,
  text: string,
  expected: ClaudeNativeExpectation,
): void {
  if (path.basename(file, ".jsonl") !== expected.sessionId)
    fail("session id does not match the file name");
  if (pathIdentity(path.dirname(file)) !== pathIdentity(expected.directory))
    fail("file is not in the project directory Claude Code derives from the workspace");
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (!lines.length) fail("file is empty");
  const records: Record<string, unknown>[] = [];
  lines.forEach((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      fail(`line ${index + 1} is not valid JSON`);
    }
    if (value === null || typeof value !== "object" || Array.isArray(value))
      fail(`line ${index + 1} is not a JSON object`);
    records.push(value as Record<string, unknown>);
  });
  const seen = new Set<string>();
  let previous: string | null = null;
  let messages = 0;
  let last: Record<string, unknown> | null = null;
  records.forEach((record, index) => {
    const where = `line ${index + 1}`;
    if (typeof record.type !== "string" || !WRITTEN_TYPES.has(record.type))
      fail(`${where} has an unexpected record type`);
    if (record.sessionId !== expected.sessionId) fail(`${where} has a different sessionId`);
    if (last) fail(`${where} follows the closing last-prompt record`);
    if (record.type === "last-prompt") {
      last = record;
      return;
    }
    if (!MESSAGE_TYPES.has(record.type)) return;
    if (
      typeof record.cwd !== "string" ||
      pathIdentity(record.cwd) !== pathIdentity(expected.workspace)
    )
      fail(`${where} has a different cwd`);
    if (typeof record.uuid !== "string" || !record.uuid) fail(`${where} has no uuid`);
    if (seen.has(record.uuid)) fail(`${where} repeats a uuid`);
    if (messages === 0 ? record.parentUuid !== null : record.parentUuid !== previous)
      fail(`${where} has a dangling or out-of-order parentUuid`);
    seen.add(record.uuid);
    previous = record.uuid;
    messages++;
  });
  if (!messages) fail("file holds no user or assistant record");
  const closing = last as Record<string, unknown> | null;
  if (!closing) fail("closing last-prompt record is missing");
  if (closing!.leafUuid !== previous) fail("last-prompt does not point at the final message");
  const probe = probeClaudeSessionFile(file);
  if (probe !== null) fail(`format probe rejected the file (${probe})`);
}
