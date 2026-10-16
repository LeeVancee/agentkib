import type { SessionController } from "./use-session-controller";

type ClaudeHandoffSession = Pick<
  SessionController,
  | "selected"
  | "current"
  | "live"
  | "capabilities"
  | "access"
  | "online"
  | "controlReady"
  | "busy"
  | "notice"
>;

export type ClaudeHandoffBlockReason =
  | "session"
  | "capability"
  | "ownership"
  | "turn"
  | "compacting"
  | "approvals"
  | "questions"
  | "access"
  | "protocol"
  | "experimental"
  | "management"
  | "send"
  | "offline"
  | "synchronizing"
  | "sessionBusy"
  | "uncertain";

/** Keep explanation and eligibility on the same current-session gate. */
export function claudeHandoffBlockReason(
  session: ClaudeHandoffSession,
): ClaudeHandoffBlockReason | undefined {
  const { selected, current, live, capabilities, access } = session;
  if (
    !selected ||
    current?.id !== selected ||
    current.agent !== "claude-code" ||
    live?.sessionId !== selected ||
    capabilities?.sessionId !== selected
  )
    return "session";
  if (
    !capabilities.features.adopt?.available ||
    (capabilities.reason && capabilities.reason !== "handoff-required")
  )
    return "capability";
  if (live.reason !== "handoff-required") return "ownership";
  if (live.status !== "idle" && live.status !== "released") return "turn";
  if (live.activity === "compacting") return "compacting";
  if (live.approvals?.length) return "approvals";
  if (live.questions?.length) return "questions";
  if (access?.status !== "approved") return "access";
  if (access.protocolVersion !== 2) return "protocol";
  if (!access.experimentalEnabled) return "experimental";
  if (!access.device?.manage) return "management";
  if (!access.device.send) return "send";
  if (!session.online) return "offline";
  if (!session.controlReady) return "synchronizing";
  if (session.busy) return "sessionBusy";
  if (session.notice === "uncertain") return "uncertain";
  return undefined;
}

/** The shortcut and the existing confirmation share the same current-session gate. */
export function canConfirmClaudeHandoff(session: ClaudeHandoffSession) {
  return claudeHandoffBlockReason(session) === undefined;
}
