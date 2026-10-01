import { z } from "zod";
import { SessionStore } from "./session-store";
import { SESSION_AGENTS, type NativeListing, type SessionReaders } from "./session-readers";
import { parameters } from "./rpc";

/** Invalidate scans before clearing or changing preferences; no await occurs between validation and writes. */
export class SessionIndex {
  #epoch = 0n;
  #closed = false;
  constructor(
    readonly store: SessionStore,
    readonly readers: Pick<SessionReaders, "list">,
    readonly enabled: () => boolean,
  ) {}
  invalidate(): void {
    this.#epoch++;
  }
  generation(): bigint {
    return this.#epoch;
  }
  close(): void {
    this.#closed = true;
    this.invalidate();
  }
  clear(value: unknown): null {
    const { workspaceId } = parameters(
      z.object({ workspaceId: z.string().nullable().optional() }),
      value,
    );
    this.invalidate();
    this.store.clear(workspaceId ?? null);
    return null;
  }
  async refresh(value: unknown) {
    const { workspaceId, force } = parameters(
      z.object({
        workspaceId: z.string(),
        force: z.boolean().default(false),
      }),
      value,
    );
    if (this.#closed || !this.enabled()) return [];
    const epoch = this.#epoch;
    if (!force) {
      const statuses = this.store.status(workspaceId);
      if (
        statuses.length === SESSION_AGENTS.length &&
        statuses.every((status) => status.freshness === "fresh")
      )
        return this.store.list(workspaceId);
    }
    const workspace = this.store.workspacePath(workspaceId);
    const current = () => !this.#closed && epoch === this.#epoch && this.enabled();
    let normalizedOwner: ReturnType<SessionStore["owner"]> | undefined;
    for (const agent of SESSION_AGENTS) {
      let listing: NativeListing;
      try {
        listing = await this.readers.list(agent, workspace);
      } catch {
        if (!current()) return [];
        this.store.failure(workspaceId, agent, "Conversation source could not be read");
        continue;
      }
      if (!current()) return [];
      const owner = ["open-claw", "hermes", "grok-build"].includes(agent)
        ? (normalizedOwner ??= this.store.owner(workspaceId))
        : undefined;
      this.store.sync(workspaceId, agent, listing.sessions, !listing.incomplete, owner);
      if (listing.incomplete)
        this.store.failure(
          workspaceId,
          agent,
          "Some conversation sources could not be read; previous records were retained",
        );
    }
    return current() ? this.store.list(workspaceId) : [];
  }
}
