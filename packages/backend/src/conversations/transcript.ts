import { lstat, readFile } from "node:fs/promises";
import { backendError } from "../contracts.js";
import type { AgentKind, ConversationEvent, ConversationEventPage } from "./types.js";
const MAX = 256 * 1024 * 1024;
export async function parseTranscript(
  file: string,
  agent: AgentKind,
  cursor = 0,
  limit = 300,
): Promise<ConversationEventPage> {
  let metadata;
  try {
    metadata = await lstat(file);
  } catch (error) {
    throw backendError(
      (error as NodeJS.ErrnoException).code === "EACCES" ? "PERMISSION" : "NOT_FOUND",
      "Conversation transcript is not available",
    );
  }
  if (!metadata.isFile())
    throw backendError("VALIDATION", "Conversation transcript must be a regular file");
  if (metadata.size > MAX)
    throw backendError("VALIDATION", "Conversation transcript exceeds the 256 MiB read limit");
  const lines = (await readFile(file, "utf8")).split(/\r?\n/).filter(Boolean),
    events: ConversationEvent[] = [],
    warnings: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (Buffer.byteLength(line) > 4 * 1024 * 1024) {
      warnings.push(`oversized transcript line ${index + 1}`);
      continue;
    }
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      const role = String(value.role ?? value.type ?? "");
      const content =
        typeof value.content === "string"
          ? value.content
          : typeof value.message === "string"
            ? value.message
            : undefined;
      if (!content && !role) continue;
      events.push({
        id: String(value.id ?? index),
        kind: role.includes("user")
          ? "user-message"
          : role.includes("tool")
            ? "tool-summary"
            : "agent-message",
        timestamp: typeof value.timestamp === "string" ? value.timestamp : undefined,
        content,
        tool_name: typeof value.name === "string" ? value.name : undefined,
        attachment_count: 0,
        truncated: false,
      });
    } catch {
      warnings.push(`damaged transcript line ${index + 1}`);
    }
  }
  return {
    events: events.slice(cursor, cursor + limit),
    next_cursor: cursor + limit < events.length ? String(cursor + limit) : undefined,
    warnings,
  };
}
