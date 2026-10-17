import { claudeConnectionCopy, claudeConnectionReason } from "./claude-connection-copy";
import type { SessionController } from "./use-session-controller";

/** Keep execution ownership distinct from the terminal's observation connection. */
export function claudeSessionBanner({
  locale,
  live,
  online,
  t,
}: Pick<SessionController, "locale" | "live" | "online" | "t">) {
  const copy = claudeConnectionCopy[locale];
  if (live?.executionMode === "claude-managed")
    return live.status === "released"
      ? { title: copy.released, body: copy.releasedInfo }
      : { title: copy.managed, body: t.managedResumeInfo };
  if (live?.executionMode === "claude-follower") {
    if (online && live.reason === "claude-bridge-event-gap")
      return { title: copy.connected, body: copy.gap };
    if (!online || live.reason === "claude-bridge-disconnected" || live.status === "unsupported")
      return { title: copy.lostTitle, body: copy.lost };
    if (live.status === "outcome-unknown")
      return {
        title: t.controlUnconfirmed,
        body: claudeConnectionReason(locale, live.reason) ?? t.controlUnconfirmed,
      };
    return {
      title: copy.connected,
      body: claudeConnectionReason(locale, live.reason) ?? copy.info,
    };
  }
  if (
    live?.executionMode === "managed-resume" &&
    ["handoff-required", "session-released"].includes(live.reason ?? "")
  )
    return { title: copy.handoff, body: copy.handoffInfo };
  return {
    title: copy.history,
    body: claudeConnectionReason(locale, live?.reason) ?? copy.disconnected,
  };
}
