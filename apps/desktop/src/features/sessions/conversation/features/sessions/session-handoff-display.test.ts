import { sessionContinuationCopy } from "@agentkib/session-ui";
import { describe, expect, it } from "vitest";
import { codexReason } from "@/features/sessions/conversation/features/sessions/codex-copy";
import {
  sessionDisplayState,
  sessionNextAction,
} from "@/features/sessions/conversation/features/sessions/session-display-state";
import { webLayoutCopy } from "@/features/sessions/conversation/features/sessions/web-layout-copy";
import { canConfirmClaudeHandoff } from "@/features/sessions/conversation/features/sessions/claude-handoff";
import type { SessionController } from "@/features/sessions/conversation/features/sessions/use-session-controller";

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
  function codexFixture() {
    const state = fixture();
    state.current!.agent = "codex";
    Object.assign(state.live!, {
      executionMode: "codex-managed",
      reason: undefined,
      ownershipReason: null,
      executionLocation: null,
      sendEnabled: true,
    });
    state.capabilities!.executionMode = "codex-managed";
    state.capabilities!.features.send = { available: true };
    state.canSend = true;
    return state;
  }
  it("keeps an idle Codex session ready without a badge or manual resume", () => {
    const state = codexFixture();
    state.capabilities!.features.resume = { available: true };
    expect(sessionNextAction(state)).toBeUndefined();
    expect(sessionDisplayState(state)).toMatchObject({
      label: "",
      reason: "",
      continuation: "idle",
    });
  });
  it("does not require management permission to send to an automatically continued Codex session", () => {
    const state = codexFixture();
    state.access!.device!.manage = false;
    expect(sessionNextAction(state)).toBeUndefined();
    expect(sessionDisplayState(state).continuation).toBe("idle");
  });
  it("identifies the external Codex owner without a handoff action or warning color", () => {
    const state = codexFixture();
    state.canSend = false;
    Object.assign(state.live!, {
      sendEnabled: false,
      executionLocation: "external",
      ownershipReason: "codex-owner-busy",
      reason: "codex-owner-busy",
    });
    expect(sessionNextAction(state)).toBeUndefined();
    expect(sessionDisplayState(state)).toMatchObject({
      label: "In use in Codex",
      continuation: "busy",
      tone: "muted",
    });
  });
  it("returns a retired Codex session to idle without asking for resume confirmation", () => {
    const state = codexFixture();
    state.live!.status = "released";
    expect(sessionNextAction(state)).toBeUndefined();
    expect(sessionDisplayState(state)).toMatchObject({ label: "", continuation: "idle" });
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
  it("preserves Claude advice and localizes the Codex ownership state in all four locales", () => {
    for (const locale of ["en-US", "zh-CN", "zh-TW", "ja-JP"] as const) {
      const state = fixture();
      state.locale = locale;
      expect(sessionDisplayState(state)).toMatchObject({
        label: webLayoutCopy[locale].handoffPending,
        reason: codexReason(locale, "handoff-required").text,
      });
      state.current!.agent = "codex";
      state.live!.ownershipReason = "codex-owner-busy";
      expect(sessionDisplayState(state)).toMatchObject({
        label: sessionContinuationCopy(locale).busy("Codex"),
        reason: "",
        tone: "muted",
      });
    }
  });
});
