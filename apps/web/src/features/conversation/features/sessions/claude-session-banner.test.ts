import { sessionContinuationCopy } from "@agentkib/session-ui";
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
    t: { controlUnconfirmed: "unconfirmed" },
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
      const continuation = sessionContinuationCopy(locale);
      const idle = fixture(locale, "claude-managed", "idle");
      idle.canSend = true;
      expect(claudeSessionBanner(idle)).toBeNull();
      expect(sessionDisplayState(idle)).toMatchObject({ label: "", continuation: "idle" });
      const managed = fixture(locale, "claude-managed", "idle");
      managed.live!.executionLocation = "agentkib";
      expect(claudeSessionBanner(managed)).toBeNull();
      expect(sessionDisplayState(managed)).toMatchObject({
        label: continuation.running,
        continuation: "running",
      });
      for (const unconfirmed of [
        fixture(locale, "claude-managed", "outcome-unknown", "control-outcome-unconfirmed"),
        { ...managed, notice: "uncertain" as const },
      ]) {
        expect(claudeSessionBanner(unconfirmed)).toEqual({
          title: "",
          body: copy.managedUnconfirmed,
        });
        expect(copy.managedUnconfirmed).not.toBe(copy.connectionUnconfirmed);
      }
      const ended = {
        ...idle,
        live: { ...idle.live!, continuationNotice: "background-ended" as const },
      };
      expect(claudeSessionBanner(ended)).toEqual({
        title: "",
        body: continuation.backgroundEnded,
        notice: "background-ended",
      });
      const conflict = {
        ...idle,
        live: {
          ...idle.live!,
          continuationNotice: "owner-opened-elsewhere" as const,
          ownershipReason: "owner-opened-elsewhere",
        },
      };
      expect(claudeSessionBanner(conflict)).toEqual({
        title: "",
        body: continuation.ownerOpenedElsewhere,
        notice: "owner-opened-elsewhere",
      });
      expect(sessionDisplayState(conflict)).toMatchObject({
        label: continuation.busy("Claude Code"),
        continuation: "busy",
        tone: "muted",
      });
      const connected = fixture(locale, "claude-follower", "idle");
      connected.live!.executionLocation = "terminal";
      expect(claudeSessionBanner(connected)).toBeNull();
      // The released plugin cannot take messages from here, so the terminal is only followed.
      expect(sessionDisplayState(connected)).toMatchObject({
        label: continuation.terminalConnected,
        continuation: "terminal-watch",
        tone: "muted",
      });
      expect(
        sessionDisplayState({ ...connected, live: { ...connected.live!, terminalSend: true } }),
      ).toMatchObject({
        label: continuation.terminalConnected,
        continuation: "terminal",
        tone: "muted",
      });
      // A terminal that cannot take messages is explained once, in place of the composer.
      for (const reason of [
        "claude-follower-send-unverified",
        "claude-terminal-approval",
        "claude-terminal-question",
      ])
        expect(
          claudeSessionBanner({ ...connected, live: { ...connected.live!, reason } }),
        ).toBeNull();
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
        expect(sessionDisplayState(lost).label).toBe(continuation.viewOnly);
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
