import { claudeConnectionCopy, claudeConnectionReason } from "./claude-connection-copy";
import type { SessionController } from "./use-session-controller";
import { codexReason } from "./codex-copy";
import { contextUsageCopy } from "./context-usage-copy";
import { webLayoutCopy } from "./web-layout-copy";
import { canConfirmClaudeHandoff } from "./claude-handoff";
import { managedControlCopy } from "./managed-control-copy";
import { sessionContinuationCopy } from "@agentkib/session-ui";

type State = Pick<
  SessionController,
  | "locale"
  | "live"
  | "online"
  | "controlReady"
  | "busy"
  | "canSend"
  | "access"
  | "capabilities"
  | "selected"
  | "current"
  | "notice"
> & { pendingSend?: SessionController["pendingSend"] };

export type SessionNextAction = "managed-handoff";
type DisplayState = {
  label: string;
  reason: string;
  tone: "warning" | "active" | "muted";
  loading?: boolean;
  nextAction?: SessionNextAction;
  continuation?: "idle" | "starting" | "running" | "busy" | "view-only";
};

/** An entry into an existing review flow, never permission to send or dispatch it. */
export function sessionNextAction(state: State): SessionNextAction | undefined {
  const { selected, current, live, capabilities, access } = state;
  if (
    state.canSend ||
    !selected ||
    current?.id !== selected ||
    current.availability !== "readable" ||
    current.origin === "auxiliary" ||
    current.origin === "execution" ||
    ("remote" in current && current.remote) ||
    live?.sessionId !== selected ||
    capabilities?.sessionId !== selected ||
    access?.status !== "approved" ||
    access.protocolVersion !== 2 ||
    !access.experimentalEnabled ||
    !access.device?.send ||
    !state.online ||
    !state.controlReady ||
    state.busy ||
    state.notice === "uncertain" ||
    live.activity === "compacting" ||
    live.approvals?.length ||
    live.questions?.length ||
    (live.status !== "idle" && live.status !== "released") ||
    (capabilities.reason && !["handoff-required", "session-released"].includes(capabilities.reason))
  )
    return undefined;
  return current.agent === "claude-code" && canConfirmClaudeHandoff(state)
    ? "managed-handoff"
    : undefined;
}
/** Presentation only: never grants capabilities or changes dispatch eligibility. */
export function sessionDisplayState(state: State): DisplayState {
  const { live, online, controlReady, busy, canSend, access, capabilities, locale } = state;
  const c = webLayoutCopy[locale];
  const reason =
    live?.reason === "handoff-required" &&
    capabilities?.reason &&
    capabilities.reason !== "handoff-required"
      ? capabilities.reason
      : live?.reason || capabilities?.features.send?.reason || capabilities?.reason;
  if (
    state.notice === "uncertain" ||
    reason === "control-outcome-unconfirmed" ||
    live?.reason === "control-outcome-unconfirmed" ||
    capabilities?.reason === "control-outcome-unconfirmed"
  )
    return {
      label: c.uncertain,
      reason: codexReason(locale, "control-outcome-unconfirmed").text,
      tone: "warning",
    };
  if (
    state.current?.availability === "metadata-only" ||
    (state.current &&
      (("remote" in state.current && state.current.remote) ||
        !["codex", "claude-code", "antigravity"].includes(state.current.agent) ||
        state.current.origin === "auxiliary" ||
        state.current.origin === "execution"))
  )
    return { label: c.readonly, reason: c.readonly, tone: "muted" };
  if (!online)
    return {
      label: live ? c.offline : c.connecting,
      reason: live ? c.offline : c.connecting,
      tone: "warning",
      loading: !live,
    };
  if (state.current?.agent === "codex") {
    const copy = sessionContinuationCopy(locale);
    if (access?.status !== "approved")
      return { label: c.accessRequired, reason: managedControlCopy[locale].access, tone: "muted" };
    if (access.protocolVersion !== 2)
      return {
        label: c.controlUnavailable,
        reason: managedControlCopy[locale].protocol,
        tone: "muted",
      };
    if (!access.experimentalEnabled)
      return {
        label: c.controlDisabled,
        reason: codexReason(locale, "control-disabled").text,
        tone: "muted",
      };
    if (!access.device?.send)
      return {
        label: c.permissionRequired,
        reason: managedControlCopy[locale].send,
        tone: "muted",
      };
    // Only the selected session's authoritative projection can describe its owner.
    if (
      state.current.id !== state.selected ||
      live?.sessionId !== state.selected ||
      capabilities?.sessionId !== state.selected
    )
      return { label: c.verifying, reason: c.verifying, tone: "muted", loading: true };
    if (live.ownershipReason === "codex-owner-busy" || reason === "codex-owner-busy")
      return { label: copy.busy("Codex"), reason: "", tone: "muted", continuation: "busy" };
    if (state.pendingSend?.sessionId === state.selected || live.status === "starting")
      return {
        label: copy.starting,
        reason: "",
        tone: "muted",
        loading: true,
        continuation: "starting",
      };
    if (live.executionLocation === "agentkib")
      return { label: copy.running, reason: "", tone: "active", continuation: "running" };
    if (!controlReady)
      return { label: c.verifying, reason: c.verifying, tone: "muted", loading: true };
    if (canSend || (live.sendEnabled && !reason))
      return { label: "", reason: "", tone: "muted", continuation: "idle" };
    return {
      label: copy.viewOnly,
      reason: codexReason(locale, reason).text,
      tone: "muted",
      continuation: "view-only",
    };
  }
  if (
    live?.executionMode === "claude-follower" &&
    ["claude-terminal-approval", "claude-terminal-question"].includes(live.reason ?? "")
  )
    return {
      label: live.reason === "claude-terminal-question" ? c.question : c.approval,
      reason: codexReason(locale, live.reason).text,
      tone: "warning",
    };
  if (live?.questions?.length) return { label: c.question, reason: c.question, tone: "warning" };
  if (
    live?.approvals?.length ||
    live?.status === "awaiting-approval" ||
    live?.status === "waiting-approval"
  )
    return { label: c.approval, reason: c.approval, tone: "warning" };
  if (live?.activity === "compacting")
    return {
      label: contextUsageCopy[locale].compacting,
      reason: contextUsageCopy[locale].compactingDetail,
      tone: "active",
    };
  if (
    live?.executionMode === "claude-follower" &&
    ["claude-follower-turn-unconfirmed", "claude-terminal-permission-unconfirmed"].includes(
      live.reason ?? "",
    )
  )
    return { label: c.running, reason: codexReason(locale, live.reason).text, tone: "warning" };
  if (live?.executionMode === "claude-follower" && live.reason === "claude-bridge-event-gap")
    return { label: c.verifying, reason: claudeConnectionCopy[locale].gap, tone: "warning" };
  if (
    live?.executionMode === "claude-follower" &&
    (live.status === "unsupported" || live.reason === "claude-bridge-disconnected")
  )
    return {
      label: claudeConnectionCopy[locale].lostTitle,
      reason: claudeConnectionCopy[locale].lost,
      tone: "warning",
    };
  if (live?.status === "running") return { label: c.running, reason: c.running, tone: "active" };
  if (busy) return { label: c.busy, reason: c.busy, tone: "active", loading: true };
  if (access?.status !== "approved")
    return { label: c.accessRequired, reason: managedControlCopy[locale].access, tone: "muted" };
  if (access.protocolVersion !== 2)
    return {
      label: c.controlUnavailable,
      reason: managedControlCopy[locale].protocol,
      tone: "muted",
    };
  if (!access.experimentalEnabled)
    return {
      label: c.controlDisabled,
      reason: codexReason(locale, "control-disabled").text,
      tone: "muted",
    };
  if (!access.device?.send)
    return { label: c.permissionRequired, reason: managedControlCopy[locale].send, tone: "muted" };
  if (live?.executionMode === "claude-follower" && live.status === "idle")
    return {
      label: claudeConnectionCopy[locale].connected,
      reason: claudeConnectionReason(locale, reason) ?? claudeConnectionCopy[locale].info,
      tone: "active",
    };
  if (live?.executionMode === "claude-managed" && live.status === "released")
    return {
      label: claudeConnectionCopy[locale].released,
      reason: claudeConnectionCopy[locale].releasedInfo,
      tone: "muted",
      nextAction: sessionNextAction(state),
    };
  if (
    !canSend &&
    (((!controlReady || !live) && (!reason || reason === "handoff-required")) ||
      (state.selected &&
        (state.current?.id !== state.selected ||
          live?.sessionId !== state.selected ||
          (capabilities && capabilities.sessionId !== state.selected))))
  )
    return { label: c.verifying, reason: c.verifying, tone: "muted", loading: true };
  const nextAction = !canSend ? sessionNextAction(state) : undefined;
  if (nextAction)
    return {
      label: c.handoffPending,
      reason: codexReason(locale, "handoff-required").text,
      tone: "warning",
      nextAction,
    };
  if (controlReady && live?.status === "idle" && live.lastOutcome === "cancelled")
    return { label: c.cancelled, reason: "", tone: "muted" };
  if (canSend) return { label: c.ready, reason: "", tone: "active" };
  if (
    reason === "handoff-required" &&
    !access.device.manage &&
    capabilities?.features.adopt?.available
  )
    return {
      label: c.permissionRequired,
      reason: managedControlCopy[locale].management,
      tone: "muted",
    };
  if (reason)
    return {
      label: reason === "unverified-installation" ? c.unverified : c.readonly,
      reason: codexReason(locale, reason).text,
      tone: "muted",
    };
  if (!controlReady || !live)
    return { label: c.verifying, reason: c.verifying, tone: "muted", loading: true };
  return { label: c.readonly, reason: c.readonly, tone: "muted" };
}
