import { describe, expect, it } from "vitest";
import type { ConversationSessionSummary, WorkspaceSummary } from "@/core/types";
import {
  continuationIndexingEnabled,
  recentContinuationWorkspaces,
  selectRecentContinuations,
} from "./home-continuations";

const workspaces = ["first", "second", "third", "fourth"].map(
  (id) => ({ id, name: id }) as WorkspaceSummary,
);

const readableSession = {
  id: "session-1",
  availability: "readable",
  agent: "codex",
  updated_at: "2026-09-01T12:00:00.000Z",
} as ConversationSessionSummary;

describe("selectRecentContinuations", () => {
  it("waits for the runtime preference before enabling session indexing", () => {
    expect(continuationIndexingEnabled()).toBe(false);
    expect(continuationIndexingEnabled({ session_index_enabled: false })).toBe(false);
    expect(continuationIndexingEnabled({ session_index_enabled: true })).toBe(true);
  });

  it("limits background discovery to the five most recent workspaces", () => {
    const values = Array.from({ length: 7 }, (_, index) => ({
      id: `workspace-${index}`,
      last_active_at: `2026-09-0${index + 1}T00:00:00.000Z`,
    })) as WorkspaceSummary[];

    expect(recentContinuationWorkspaces(values).map(({ id }) => id)).toEqual([
      "workspace-6",
      "workspace-5",
      "workspace-4",
      "workspace-3",
      "workspace-2",
    ]);
  });

  it("takes the limit after filtering workspaces without readable sessions", () => {
    const result = selectRecentContinuations(workspaces, [[], [], [], [readableSession]], 3);

    expect(result.map((item) => item.workspace.id)).toEqual(["fourth"]);
  });

  it("sorts individual readable sessions globally and excludes metadata-only sessions", () => {
    const result = selectRecentContinuations(
      workspaces,
      [
        [
          readableSession,
          {
            ...readableSession,
            id: "session-2",
            agent: "claude-code",
            updated_at: "2026-09-03T12:00:00.000Z",
          },
        ],
        [
          {
            ...readableSession,
            id: "metadata-session",
            availability: "metadata-only",
            updated_at: "2026-09-04T12:00:00.000Z",
          },
          { ...readableSession, id: "session-3", updated_at: "2026-09-02T12:00:00.000Z" },
        ],
      ],
      2,
    );

    expect(result.map((item) => item.session.id)).toEqual(["session-2", "session-3"]);
  });
});
