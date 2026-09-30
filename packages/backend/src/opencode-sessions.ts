import { z } from "zod";
import { Commands } from "./commands";
import { resolveCommand } from "./command-resolution";
import type { NativeSession } from "./session-store";
import { hasText, type ConversationEvent, type ConversationEventPage } from "./session-events";

const i64 = z.bigint().min(-9223372036854775808n).max(9223372036854775807n);
const optionalInteger = i64.nullable().optional();
const listed = z.array(
  z.object({
    id: z.string(),
    title: z.string().nullable().optional(),
    created: optionalInteger,
    updated: optionalInteger,
    directory: z.string().nullable().optional(),
  }),
);
const exported = z.object({
  info: z.unknown(),
  messages: z.array(
    z.object({
      info: z.object({
        id: z.string(),
        role: z.string(),
        time: z.object({ created: optionalInteger }).nullable().optional(),
      }),
      parts: z.array(z.unknown()),
    }),
  ),
});
type Export = z.infer<typeof exported>;

export class OpenCodeSessions {
  constructor(
    readonly commands: Commands,
    readonly env: NodeJS.ProcessEnv = process.env,
  ) {}
  async list(workspace: string): Promise<NativeSession[]> {
    const executable = resolveCommand("opencode", this.env);
    if (executable === null) return [];
    return parseOpenCodeSessions(
      await this.#run(
        executable,
        ["session", "list", "--format", "json"],
        workspace,
        16 * 1024 * 1024,
      ),
    );
  }
  async readEvents(
    workspace: string,
    nativeRef: string,
    cursor: string | null,
    limit: number,
  ): Promise<ConversationEventPage> {
    return parseOpenCodeEvents(await this.#export(workspace, nativeRef), cursor, limit);
  }
  async readHandoff(workspace: string, nativeRef: string) {
    return parseOpenCodeHandoff(await this.#export(workspace, nativeRef));
  }
  async #export(workspace: string, nativeRef: string): Promise<Buffer> {
    const executable = resolveCommand("opencode", this.env);
    if (executable === null)
      throw new Error("OpenCode CLI is not installed or is not available on PATH");
    return this.#run(executable, ["export", nativeRef], workspace, 256 * 1024 * 1024);
  }
  async #run(
    executable: string,
    args: string[],
    workspace: string,
    limit: number,
  ): Promise<Buffer> {
    const result = await this.commands.run(executable, args, {
      cwd: workspace,
      env: this.env,
      limit,
      timeout: 30_000,
      strictOutput: true,
      terminateDescendantsOnExit: true,
    });
    return result.bytes;
  }
}

/** Retain signed 64-bit JSON timestamps before JavaScript rounds them. */
function json(bytes: Uint8Array): unknown {
  const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  return JSON.parse(source, ((_: string, value: unknown, context?: { source?: string }) => {
    if (typeof value !== "number") return value;
    if (!Number.isFinite(value)) throw new Error("Invalid OpenCode JSON number");
    return context?.source && /^-?\d+$/.test(context.source) ? BigInt(context.source) : value;
  }) as Parameters<typeof JSON.parse>[1]);
}
function millis(value: bigint | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = new Date(Number(value));
  if (!Number.isFinite(date.valueOf())) return null;
  const year = date.getUTCFullYear();
  if (year < -262143 || year > 262142) return null;
  return date
    .toISOString()
    .replace(/^([+-])0*(\d{4,})-/, "$1$2-")
    .replace(".000Z", "Z");
}
/** The CLI already scopes its listing to cwd; a missing directory only changes availability. */
export function parseOpenCodeSessions(bytes: Uint8Array): NativeSession[] {
  if (bytes.byteLength > 16 * 1024 * 1024)
    throw new Error("OpenCode session list exceeds the read limit");
  return listed.parse(json(bytes)).map((session) => {
    const title =
      session.title
        ?.split(/\p{White_Space}+/u)
        .filter(Boolean)
        .join(" ") ?? "";
    return {
      native_ref: session.id,
      agent: "opencode",
      title: title ? [...title].slice(0, 200).join("") : null,
      origin: "unknown",
      spawned_by_session_id: null,
      forked_from_session_id: null,
      created_at: millis(session.created),
      updated_at: millis(session.updated),
      message_count: null,
      git_branch: null,
      archived: false,
      sidechain: false,
      availability:
        session.directory !== null && session.directory !== undefined
          ? "readable"
          : "metadata-only",
    };
  });
}
function exportSession(bytes: Uint8Array): Export {
  if (bytes.byteLength > 256 * 1024 * 1024)
    throw new Error("OpenCode export exceeds the read limit");
  return exported.parse(json(bytes));
}
function events(
  session: Export,
  handoff: boolean,
): { events: ConversationEvent[]; omitted: number } {
  const events: ConversationEvent[] = [];
  let omitted = 0;
  for (const message of session.messages) {
    const kind =
      message.info.role === "user"
        ? "user-message"
        : message.info.role === "assistant"
          ? "agent-message"
          : null;
    if (kind === null) continue;
    const fragments: string[] = [];
    let tools = 0,
      attachments = 0;
    for (const value of message.parts) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
      const part = value as Record<string, unknown>;
      if (part.type === "text" && typeof part.text === "string") fragments.push(part.text);
      else if (part.type === "tool") tools++;
      else if (part.type === "file") attachments++;
    }
    const content = fragments.join("\n"),
      visible = hasText(content);
    omitted += tools;
    if (!visible && !attachments && (handoff || !tools)) continue;
    events.push({
      id: message.info.id,
      kind,
      timestamp: millis(message.info.time?.created),
      content: visible ? content : null,
      tool_name: null,
      tool_status: null,
      duration_ms: null,
      attachment_count: attachments,
      truncated: false,
    });
  }
  return { events, omitted };
}
export function parseOpenCodeEvents(
  bytes: Uint8Array,
  cursor: string | null,
  limit: number,
): ConversationEventPage {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Invalid event limit");
  const values = events(exportSession(bytes), false).events;
  let end = values.length;
  // This provider's existing offset cursor falls back to the latest page when invalid.
  if (cursor !== null && /^[+]?\d+$/.test(cursor)) {
    const number = BigInt(cursor);
    const maxUsize = process.arch === "ia32" ? 4294967295n : 18446744073709551615n;
    if (number <= maxUsize) end = Number(number > BigInt(end) ? BigInt(end) : number);
  }
  const start = Math.max(0, end - Math.min(100, Math.max(1, limit)));
  return {
    events: values.slice(start, end),
    next_cursor: start > 0 ? String(start) : null,
    warnings: [],
  };
}
export function parseOpenCodeHandoff(bytes: Uint8Array) {
  const result = events(exportSession(bytes), true);
  return {
    compact_summary: null,
    messages: result.events,
    omitted_tool_count: result.omitted,
    warnings: [],
  };
}
