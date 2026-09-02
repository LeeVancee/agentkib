/** @jsxImportSource octane */

import type { ConversationSessionSummary, WorkspaceSummary } from "@/core/types";
import type { RecentContinuation } from "./GlobalHome";

export function selectRecentContinuations(
  workspaces: WorkspaceSummary[],
  sessionsByWorkspace: Array<ConversationSessionSummary[] | undefined>,
  limit = 3,
): RecentContinuation[] {
  return workspaces
    .flatMap((workspace, index) => {
      const sessions = (sessionsByWorkspace[index] ?? []).filter(
        (session) => session.availability === "readable",
      );
      if (!sessions.length) return [];
      return [
        {
          workspace,
          sessionCount: sessions.length,
          agents: [...new Set(sessions.map((session) => session.agent))],
        },
      ];
    })
    .slice(0, limit);
}
