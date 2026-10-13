import type { SessionController } from "./use-session-controller";

/** The shortcut and the existing confirmation share the same current-session gate. */
export function canConfirmClaudeHandoff(
  session: Pick<
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
  >,
) {
  const { selected, current, live, capabilities, access } = session;
  return !!(
    selected &&
    current?.id === selected &&
    current.agent === "claude-code" &&
    live?.sessionId === selected &&
    capabilities?.sessionId === selected &&
    capabilities.features.adopt?.available &&
    (!capabilities.reason || capabilities.reason === "handoff-required") &&
    live.reason === "handoff-required" &&
    (live.status === "idle" || live.status === "released") &&
    live.activity !== "compacting" &&
    !live.approvals?.length &&
    !live.questions?.length &&
    access?.status === "approved" &&
    access.protocolVersion === 2 &&
    access.experimentalEnabled &&
    access.device?.manage &&
    access.device.send &&
    session.online &&
    session.controlReady &&
    !session.busy &&
    session.notice !== "uncertain"
  );
}
