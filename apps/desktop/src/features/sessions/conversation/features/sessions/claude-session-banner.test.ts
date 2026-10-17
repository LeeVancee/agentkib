import { describe, expect, it } from "vitest";
import { claudeSessionBanner } from "./claude-session-banner";
import { claudeConnectionCopy, claudeConnectionReason } from "./claude-connection-copy";
import { sessionDisplayState } from "./session-display-state";
import type { SessionController } from "./use-session-controller";

function fixture(
  locale: SessionController["locale"],
  executionMode: string,
  status: string,
  reason?: string,
) {
  return {
    locale,
    online: true,
    controlReady: true,
    canSend: false,
    busy: false,
    t: { managedResumeInfo: "managed explanation", controlUnconfirmed: "unconfirmed" },
    current: { id: "s", agent: "claude-code", availability: "readable", origin: "interactive" },
    selected: "s",
    access: {
      status: "approved",
      protocolVersion: 2,
      experimentalEnabled: true,
      device: { send: true, manage: true },
    },
    live: { sessionId: "s", executionMode, status, reason, approvals: [], questions: [] },
    capabilities: { sessionId: "s", features: { adopt: { available: true } } },
  } as unknown as SessionController;
}
describe("Claude execution and terminal connection presentation", () => {
  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "keeps ownership, connection and failure states distinct in %s",
    (locale) => {
      const copy = claudeConnectionCopy[locale];
      const pending = fixture(locale, "managed-resume", "idle", "handoff-required");
      expect(claudeSessionBanner(pending)).toEqual({ title: copy.handoff, body: copy.handoffInfo });
      expect(sessionDisplayState(pending).label).toBe(copy.handoff);
      const released = fixture(locale, "claude-managed", "released", "session-released");
      expect(claudeSessionBanner(released)).toEqual({
        title: copy.released,
        body: copy.releasedInfo,
      });
      expect(sessionDisplayState(released).label).toBe(copy.released);
      const managed = fixture(locale, "claude-managed", "idle");
      expect(claudeSessionBanner(managed)).toEqual({
        title: copy.managed,
        body: "managed explanation",
      });
      const connected = fixture(
        locale,
        "claude-follower",
        "idle",
        "claude-follower-send-unverified",
      );
      expect(claudeSessionBanner(connected).title).toBe(copy.connected);
      expect(sessionDisplayState(connected).label).toBe(copy.connected);
      const hostOffline = { ...connected, online: false };
      expect(claudeSessionBanner(hostOffline)).toEqual({
        title: copy.hostDisconnected,
        body: copy.hostDisconnectedInfo,
      });
      for (const unconfirmed of [
        {
          ...fixture(locale, "claude-follower", "outcome-unknown", "control-outcome-unconfirmed"),
          online: false,
        },
        { ...hostOffline, notice: "uncertain" as const },
      ]) {
        expect(claudeSessionBanner(unconfirmed)).toEqual({
          title: unconfirmed.t.controlUnconfirmed,
          body: copy.connectionUnconfirmed,
        });
        expect(sessionDisplayState(unconfirmed).tone).toBe("warning");
      }
      const gap = fixture(locale, "claude-follower", "unsupported", "claude-bridge-event-gap");
      expect(claudeSessionBanner(gap)).toEqual({ title: copy.connected, body: copy.gap });
      for (const status of ["idle", "unsupported"]) {
        const lost = fixture(locale, "claude-follower", status, "claude-bridge-disconnected");
        expect(claudeSessionBanner(lost)).toEqual({ title: copy.lostTitle, body: copy.lost });
        expect(sessionDisplayState(lost).label).toBe(copy.lostTitle);
      }
      expect(claudeConnectionReason(locale, "platform-unsupported")).toBe(copy.platformUnsupported);
      expect(claudeConnectionReason(locale, "claude-bridge-unavailable")).toBe(
        copy.bridgeUnavailable,
      );
    },
  );
  it("uses 對話 consistently in traditional Chinese connection copy", () => {
    expect(Object.values(claudeConnectionCopy["zh-TW"]).join(" ")).not.toContain("會話");
  });
});
