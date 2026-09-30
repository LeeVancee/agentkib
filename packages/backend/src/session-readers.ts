import { z } from "zod";
import { CodexSessions } from "./codex-sessions";
import { ClaudeSessions } from "./claude-sessions";
import { GrokSessions } from "./grok-sessions";
import { OpenClawSessions } from "./openclaw-sessions";
import { HermesSessions } from "./hermes-sessions";
import { OpenCodeSessions } from "./opencode-sessions";
import { AntigravitySessions } from "./antigravity-sessions";
import { SessionPaging } from "./session-paging";
import { readHermesEvents } from "./hermes-events";
import { SessionStore, type NativeSession } from "./session-store";
import { Commands } from "./commands";
import { parameters, optionalString, unsigned } from "./rpc";
import type { ConversationEventPage } from "./session-events";

export const SESSION_AGENTS = [
  "codex",
  "claude-code",
  "opencode",
  "open-claw",
  "hermes",
  "grok-build",
  "antigravity",
] as const;
export type SessionAgent = (typeof SESSION_AGENTS)[number];
export interface NativeListing {
  sessions: NativeSession[];
  incomplete: boolean;
}

/** Revalidate indexed workspace ownership before resolving an opaque reference in native history. */
export class SessionReaders {
  #codex: CodexSessions;
  #claude: ClaudeSessions;
  #grok: GrokSessions;
  #openclaw: OpenClawSessions;
  #hermes: HermesSessions;
  #opencode: OpenCodeSessions;
  #antigravity: AntigravitySessions;
  #paging = new SessionPaging();
  constructor(
    readonly store: SessionStore,
    commands: Commands,
    env: NodeJS.ProcessEnv,
  ) {
    this.#codex = new CodexSessions(env);
    this.#claude = new ClaudeSessions(env);
    this.#grok = new GrokSessions(env);
    this.#openclaw = new OpenClawSessions(env);
    this.#hermes = new HermesSessions(env);
    this.#opencode = new OpenCodeSessions(commands, env);
    this.#antigravity = new AntigravitySessions(env);
  }
  close(): void {
    this.#antigravity.close();
    this.#paging.clear();
  }
  async list(agent: SessionAgent, workspace: string): Promise<NativeListing> {
    switch (agent) {
      case "opencode":
        return { sessions: await this.#opencode.list(workspace), incomplete: false };
      case "antigravity":
        return this.#antigravity.list(workspace);
      default: {
        const provider =
          agent === "codex"
            ? this.#codex
            : agent === "claude-code"
              ? this.#claude
              : agent === "grok-build"
                ? this.#grok
                : agent === "open-claw"
                  ? this.#openclaw
                  : this.#hermes;
        const listing = provider.list(workspace);
        return {
          sessions: listing.sessions.map((source) => source.session),
          incomplete: listing.incomplete,
        };
      }
    }
  }
  async resolve(id: string) {
    const summary = this.store.get(id);
    if (!summary) throw new Error("Conversation metadata is no longer available");
    const agent = summary.agent;
    if (!(SESSION_AGENTS as readonly string[]).includes(agent))
      throw new Error("Conversation provider is unavailable");
    const workspace = this.store.workspacePath(summary.workspace_id);
    const listing = await this.list(agent as SessionAgent, workspace);
    const native = listing.sessions.find(
      (candidate) => this.store.id(agent, candidate.native_ref) === id,
    );
    if (!native) throw new Error("Conversation transcript is no longer available");
    return { summary, native, workspace };
  }
  async events(value: unknown): Promise<ConversationEventPage> {
    const { sessionId, cursor, limit } = parameters(
      z.object({
        sessionId: z.string(),
        cursor: optionalString,
        limit: unsigned.nullable().optional(),
      }),
      value,
    );
    const { native, workspace } = await this.resolve(sessionId);
    const ref = native.native_ref,
      count = limit ?? 50,
      offset = cursor ?? null;
    switch (native.agent) {
      case "codex":
      case "claude-code": {
        const provider = native.agent === "codex" ? this.#codex : this.#claude;
        const source = provider
          .list(null)
          .sessions.find((value) => value.session.native_ref === ref);
        if (!source)
          throw new Error(
            native.agent === "codex"
              ? "Codex session is no longer available"
              : "Claude session is no longer available",
          );
        return this.#paging.read(source.transcript, offset, count, native.agent);
      }
      case "grok-build":
        return this.#paging.read(this.#grok.resolve(ref).transcript, offset, count, native.agent);
      case "open-claw":
        return this.#paging.read(
          this.#openclaw.resolve(ref).transcript,
          offset,
          count,
          native.agent,
        );
      case "hermes": {
        const { source } = this.#hermes.resolve(ref);
        return source.type === "sqlite"
          ? readHermesEvents(source.path, source.sessionId, offset, count)
          : this.#paging.read(source.path, offset, count, "hermes");
      }
      case "opencode":
        return this.#opencode.readEvents(workspace, ref, offset, count);
      case "antigravity":
        return this.#antigravity.readEvents(ref, offset, count);
      default:
        throw new Error("Conversation provider is unavailable");
    }
  }
}
