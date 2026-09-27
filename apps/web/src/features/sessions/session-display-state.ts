import type { SessionController } from "./use-session-controller";
import { codexReason } from "./codex-copy";
import { webLayoutCopy } from "./web-layout-copy";

type State = Pick<
  SessionController,
  "locale" | "live" | "online" | "controlReady" | "busy" | "canSend" | "access" | "capabilities"
>;
/** Presentation only: never grants capabilities or changes dispatch eligibility. */
export function sessionDisplayState(state: State) {
  const { live, online, controlReady, busy, canSend, access, capabilities, locale } = state;
  const c = webLayoutCopy[locale];
  if (
    live?.reason === "control-outcome-unconfirmed" ||
    capabilities?.reason === "control-outcome-unconfirmed"
  )
    return {
      label: c.uncertain,
      reason: codexReason(locale, "control-outcome-unconfirmed").text,
      tone: "warning",
    };
  if (!online)
    return {
      label: live ? c.offline : c.connecting,
      reason: live ? c.offline : c.connecting,
      tone: "warning",
    };
  if (live?.questions?.length) return { label: c.question, reason: c.question, tone: "warning" };
  if (
    live?.approvals?.length ||
    live?.status === "awaiting-approval" ||
    live?.status === "waiting-approval"
  )
    return { label: c.approval, reason: c.approval, tone: "warning" };
  if (live?.status === "running") return { label: c.running, reason: c.running, tone: "active" };
  if (busy) return { label: c.busy, reason: c.busy, tone: "active" };
  if (!access?.experimentalEnabled || !access.device?.send)
    return { label: c.readonly, reason: c.readonly, tone: "muted" };
  if (canSend) return { label: c.ready, reason: "", tone: "active" };
  const reason = live?.reason || capabilities?.features.send?.reason || capabilities?.reason;
  if (reason) return { label: c.readonly, reason: codexReason(locale, reason).text, tone: "muted" };
  if (!controlReady || !live) return { label: c.verifying, reason: c.verifying, tone: "muted" };
  return { label: c.readonly, reason: c.readonly, tone: "muted" };
}
