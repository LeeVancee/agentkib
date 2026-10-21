import type { SessionSurface } from "./session-surface-copy";
import { claudeConnectionCopyForSurface, claudeConnectionReason } from "./claude-connection-copy";
import { sessionContinuationCopy } from "@agentkib/session-ui";
import type { SessionController } from "./use-session-controller";

/** Normal ownership is shown in the header; only transitions and safety notices need a banner. */
export function claudeSessionBanner(
  {
    locale,
    live,
    online,
    notice,
    t,
  }: Pick<SessionController, "locale" | "live" | "online" | "notice" | "t">,
  surface: SessionSurface = "desktop",
) {
  const copy = claudeConnectionCopyForSurface(locale, surface);
  const continuation = sessionContinuationCopy(locale);
  if (
    notice === "uncertain" ||
    live?.status === "outcome-unknown" ||
    live?.reason === "control-outcome-unconfirmed"
  )
    return live?.executionMode === "claude-managed"
      ? { title: "", body: copy.managedUnconfirmed }
      : { title: t.controlUnconfirmed, body: copy.connectionUnconfirmed };
  if (!online && live?.executionMode === "claude-follower")
    return { title: copy.hostDisconnected, body: copy.hostDisconnectedInfo };
  if (live?.continuationNotice === "owner-opened-elsewhere")
    return {
      title: "",
      body: continuation.ownerOpenedElsewhere,
      notice: "owner-opened-elsewhere" as const,
    };
  if (live?.continuationNotice === "background-ended")
    return { title: "", body: continuation.backgroundEnded, notice: "background-ended" as const };
  if (live?.executionMode === "claude-follower") {
    if (live.reason === "claude-bridge-event-gap") return { title: copy.connected, body: copy.gap };
    if (live.reason === "claude-bridge-disconnected" || live.status === "unsupported")
      return { title: copy.lostTitle, body: copy.lost };
    if (
      ["claude-follower-turn-unconfirmed", "claude-terminal-permission-unconfirmed"].includes(
        live.reason ?? "",
      )
    )
      return {
        title: copy.connected,
        body: claudeConnectionReason(locale, live.reason, surface) ?? copy.connectionUnconfirmed,
      };
    // Approvals, questions and a terminal that cannot take messages are explained in place.
    if (
      ![
        "claude-terminal-approval",
        "claude-terminal-question",
        "claude-follower-send-unverified",
      ].includes(live.reason ?? "")
    ) {
      const reason = claudeConnectionReason(locale, live.reason, surface);
      if (reason) return { title: copy.connected, body: reason };
    }
  }
  return null;
}
