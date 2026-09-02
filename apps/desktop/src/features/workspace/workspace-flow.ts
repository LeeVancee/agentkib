/** @jsxImportSource octane */

import type { ChangeSetOrigin } from "./workspace-store";

export type WorkspaceFlowPage = "overview" | "sessions" | "doctor";

export function changesReturnPage(origin: ChangeSetOrigin): WorkspaceFlowPage {
  if (origin === "doctor") return "doctor";
  if (origin === "handoff") return "sessions";
  return "overview";
}

export function hasActiveChangesFlow(changeSet: unknown, handoffLaunchRequest: unknown) {
  return Boolean(changeSet || handoffLaunchRequest);
}
