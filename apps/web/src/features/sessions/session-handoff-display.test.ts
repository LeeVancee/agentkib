import { describe, expect, it } from "vitest";
import { codexReason } from "@/features/conversation/features/sessions/codex-copy";
import {
  sessionDisplayState,
  sessionNextAction,
} from "@/features/conversation/features/sessions/session-display-state";
import { webLayoutCopy } from "@/features/conversation/features/sessions/web-layout-copy";
import { canConfirmClaudeHandoff } from "@/features/conversation/features/sessions/claude-handoff";
import type { SessionController } from "@/features/conversation/features/sessions/use-session-controller";

function fixture(): SessionController {
  return {
    locale: "en-US",
    selected: "session",
    current: {
      id: "session",
      agent: "claude-code",
      availability: "readable",
      origin: "interactive",
    },
    online: true,
    controlReady: true,
    canSend: false,
    busy: false,
    access: {
      status: "approved",
      protocolVersion: 2,
      experimentalEnabled: true,
      device: { id: "device", send: true, manage: true },
    },
    live: {
      sessionId: "session",
      executionMode: "managed-resume",
      status: "idle",
      reason: "handoff-required",
      sendEnabled: false,
      approvals: [],
      questions: [],
    },
    capabilities: {
      sessionId: "session",
      status: "idle",
      executionMode: "managed-resume",
      features: {
        adopt: { available: true },
        resume: { available: false },
        send: { available: false, reason: "handoff-required" },
      },
    },
  } as unknown as SessionController;
}
describe("handoff-aware session presentation", () => {
  it.each(["idle", "released"] as const)(
    "describes a qualified %s Claude source as awaiting handoff without enabling sending",
    (status) => {
      const state = fixture();
      state.live!.status = status;
      expect(canConfirmClaudeHandoff(state)).toBe(true);
      expect(sessionDisplayState(state)).toMatchObject({
        label: "Handoff required",
        nextAction: "managed-handoff",
        tone: "warning",
      });
      expect(sessionDisplayState(state).reason).toBe(codexReason("en-US", "handoff-required").text);
      expect(state.canSend).toBe(false);
      expect(state.live!.sendEnabled).toBe(false);
    },
  );
  it("uses Codex's native resume when it is available, preserving its separate meaning", () => {
    const state = fixture();
    state.current!.agent = "codex";
    state.capabilities!.features.resume = { available: true };
    expect(sessionDisplayState(state)).toMatchObject({
      label: "Resume required",
      nextAction: "native-resume",
    });
    expect(state.canSend).toBe(false);
  });
  it("can enter the native Codex review without management permission when the native capability remains available", () => {
    const state = fixture();
    state.current!.agent = "codex";
    state.access!.device!.manage = false;
    state.capabilities!.features.resume = { available: true };
    expect(sessionNextAction(state)).toBe("native-resume");
  });
  it("uses the real managed Codex handoff entry when native resume is unavailable", () => {
    const state = fixture();
    state.current!.agent = "codex";
    expect(sessionDisplayState(state)).toMatchObject({
      label: "Handoff required",
      nextAction: "managed-handoff",
    });
  });
  it("recognizes a released native Codex source without rebranding resume as managed handoff", () => {
    const state = fixture();
    state.current!.agent = "codex";
    state.live!.status = "released";
    state.live!.reason = "session-released";
    state.capabilities!.reason = "session-released";
    state.capabilities!.features.resume = { available: true };
    expect(sessionNextAction(state)).toBe("native-resume");
  });
  const blocked: [string, (state: SessionController) => void][] = [
    [
      "metadata source",
      (s) => {
        s.current!.availability = "metadata-only";
      },
    ],
    [
      "remote source",
      (s) => {
        Object.assign(s.current!, { remote: { host_id: "remote" } });
      },
    ],
    [
      "auxiliary record",
      (s) => {
        s.current!.origin = "auxiliary";
      },
    ],
    [
      "execution record",
      (s) => {
        s.current!.origin = "execution";
      },
    ],
    [
      "unsupported Agent",
      (s) => {
        s.current!.agent = "cursor";
      },
    ],
    [
      "wrong current identity",
      (s) => {
        s.current!.id = "other";
      },
    ],
    [
      "stale live identity",
      (s) => {
        s.live!.sessionId = "other";
      },
    ],
    [
      "stale capabilities",
      (s) => {
        s.capabilities!.sessionId = "other";
      },
    ],
    [
      "unapproved access",
      (s) => {
        s.access!.status = "pending";
      },
    ],
    [
      "incompatible protocol",
      (s) => {
        s.access!.protocolVersion = 1;
      },
    ],
    [
      "disabled experimental controls",
      (s) => {
        s.access!.experimentalEnabled = false;
      },
    ],
    [
      "no send permission",
      (s) => {
        s.access!.device!.send = false;
      },
    ],
    [
      "no management permission",
      (s) => {
        s.access!.device!.manage = false;
      },
    ],
    [
      "unverified installation",
      (s) => {
        s.capabilities!.reason = "unverified-installation";
      },
    ],
    [
      "unavailable adoption capability",
      (s) => {
        s.capabilities!.features.adopt = { available: false };
      },
    ],
    [
      "offline",
      (s) => {
        s.online = false;
      },
    ],
    [
      "control synchronization",
      (s) => {
        s.controlReady = false;
      },
    ],
    [
      "in-flight operation",
      (s) => {
        s.busy = true;
      },
    ],
    [
      "unknown outcome",
      (s) => {
        s.notice = "uncertain";
      },
    ],
    [
      "active turn",
      (s) => {
        s.live!.status = "running";
      },
    ],
    [
      "unsupported status",
      (s) => {
        s.live!.status = "unsupported";
      },
    ],
    [
      "compaction",
      (s) => {
        s.live!.activity = "compacting";
      },
    ],
    [
      "approval",
      (s) => {
        s.live!.approvals = [{ requestId: "approval" }] as NonNullable<
          SessionController["live"]
        >["approvals"];
      },
    ],
    [
      "question",
      (s) => {
        s.live!.questions = [{ requestId: "question" }] as NonNullable<
          SessionController["live"]
        >["questions"];
      },
    ],
  ];
  it.each(blocked)("does not advertise an executable handoff for %s", (_name, mutate) => {
    const state = fixture();
    mutate(state);
    expect(sessionNextAction(state)).toBeUndefined();
    const result = sessionDisplayState(state);
    expect(result.nextAction).toBeUndefined();
    expect(result.label).not.toBe("Handoff required");
    expect(result.label).not.toBe("Resume required");
    expect(state.canSend).toBe(false);
  });
  it("identifies stale control evidence as verification, not a permanent view-only source", () => {
    const state = fixture();
    state.capabilities!.sessionId = "previous";
    expect(sessionDisplayState(state)).toMatchObject({ label: "Verifying state", loading: true });
  });
  it("keeps installation verification and unknown outcomes distinct from handoff", () => {
    const state = fixture();
    state.capabilities!.reason = "unverified-installation";
    expect(sessionDisplayState(state)).toMatchObject({ label: "Unverified" });
    state.controlReady = false;
    expect(sessionDisplayState(state)).toMatchObject({ label: "Unverified" });
    state.notice = "uncertain";
    expect(sessionDisplayState(state)).toMatchObject({
      label: "Result unconfirmed",
      tone: "warning",
    });
  });
  it.each([
    [
      "Access approval needed",
      (s: SessionController) => {
        s.access!.status = "pending";
      },
    ],
    [
      "Permission required",
      (s: SessionController) => {
        s.access!.device!.send = false;
      },
    ],
    [
      "Permission required",
      (s: SessionController) => {
        s.access!.device!.manage = false;
      },
    ],
    [
      "Control disabled",
      (s: SessionController) => {
        s.access!.experimentalEnabled = false;
      },
    ],
    [
      "Control unavailable",
      (s: SessionController) => {
        s.access!.protocolVersion = 1;
      },
    ],
  ] as const)("explains %s without advertising an operation", (label, mutate) => {
    const state = fixture();
    mutate(state);
    expect(sessionDisplayState(state)).toMatchObject({ label, tone: "muted" });
    expect(sessionDisplayState(state).nextAction).toBeUndefined();
    expect(sessionDisplayState(state).reason.length).toBeGreaterThan(0);
  });
  it("does not claim that a failed native resume capability can be entered without the separate managed capability", () => {
    const state = fixture();
    state.current!.agent = "codex";
    state.capabilities!.features.adopt = { available: false };
    expect(sessionNextAction(state)).toBeUndefined();
  });
  it("continues to report send readiness only from the existing dispatch decision", () => {
    const state = fixture();
    state.live!.reason = undefined;
    state.canSend = true;
    state.capabilities!.features.send = { available: true };
    expect(sessionDisplayState(state)).toMatchObject({ label: "Ready to send" });
    expect(sessionDisplayState(state).nextAction).toBeUndefined();
  });
  it("provides the distinct pending labels and advice in all four locales", () => {
    for (const locale of ["en-US", "zh-CN", "zh-TW", "ja-JP"] as const) {
      const state = fixture();
      state.locale = locale;
      expect(sessionDisplayState(state)).toMatchObject({
        label: webLayoutCopy[locale].handoffPending,
        reason: codexReason(locale, "handoff-required").text,
      });
      state.current!.agent = "codex";
      state.capabilities!.features.resume = { available: true };
      expect(sessionDisplayState(state)).toMatchObject({
        label: webLayoutCopy[locale].resumePending,
        reason: webLayoutCopy[locale].resumeInfo,
      });
    }
  });
});
