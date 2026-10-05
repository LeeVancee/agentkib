import { describe, expect, it } from "vitest";
import { dictionaries } from "@/i18n";
import { sessionDisplayState } from "./session-display-state";
import type { SessionController } from "./use-session-controller";
const state = {
  locale: "zh-CN",
  online: true,
  controlReady: true,
  canSend: true,
  busy: false,
  access: { experimentalEnabled: true, device: { send: true } },
  live: { status: "idle", sendEnabled: true, approvals: [] },
} as unknown as SessionController;
describe("session display state", () => {
  it("only displays ready after the existing dispatch gate accepts", () => {
    expect(sessionDisplayState(state).label).toBe("可发送");
    expect(
      sessionDisplayState({
        ...state,
        canSend: false,
        live: { ...state.live!, sendEnabled: false },
      }).label,
    ).toBe("仅可查看");
  });
  it("never describes SSE alone as controllable", () => {
    expect(
      sessionDisplayState({ ...state, canSend: false, controlReady: false, live: undefined }).label,
    ).toBe("正在核对状态");
    expect(
      sessionDisplayState({
        ...state,
        canSend: false,
        access: { ...state.access!, device: { ...state.access!.device!, send: false } },
      }).label,
    ).toBe("仅可查看");
  });
  it("prioritizes unconfirmed results even when the connection drops", () => {
    expect(
      sessionDisplayState({
        ...state,
        online: false,
        live: { ...state.live!, reason: "control-outcome-unconfirmed" },
      }).label,
    ).toBe("结果待核对");
  });
  it("does not present stale approval as currently actionable offline", () => {
    expect(
      sessionDisplayState({
        ...state,
        online: false,
        live: { ...state.live!, status: "waiting-approval" },
      }).label,
    ).toBe("已断线");
  });
  it("explains blocked sending without echoing private errors", () => {
    const result = sessionDisplayState({
      ...state,
      canSend: false,
      live: { ...state.live!, reason: "secret runtime detail" },
    });
    expect(result.reason).not.toContain("secret");
    expect(sessionDisplayState(state).reason).toBe("");
  });
  it.each([
    ["unverified-installation", dictionaries["zh-CN"].unverifiedInstallation],
    ["open-in-original-client", dictionaries["zh-CN"].openOriginalClient],
  ])("explains %s from live state or send capability", (reason, expected) => {
    const unavailable = {
      ...state,
      canSend: false,
      live: { ...state.live!, status: "unsupported" as const, sendEnabled: false },
    };
    expect(
      sessionDisplayState({ ...unavailable, live: { ...unavailable.live, reason } }),
    ).toMatchObject({ label: "仅可查看", reason: expected });
    expect(
      sessionDisplayState({
        ...unavailable,
        capabilities: {
          sessionId: "s",
          executionMode: "codex-follower",
          status: "unsupported",
          features: { send: { available: false, reason } },
        },
      }),
    ).toMatchObject({ label: "仅可查看", reason: expected });
  });
  it("provides localized status for every locale", () => {
    for (const locale of ["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)
      expect(sessionDisplayState({ ...state, locale }).label).toBeTruthy();
  });
});

it("shows a cancelled Claude turn while leaving the idle send eligibility unchanged", () => {
  const value = { ...state, live: { ...state.live!, lastOutcome: "cancelled" as const } };
  expect(sessionDisplayState(value).label).toBe("已取消");
  expect(value.canSend).toBe(true);
  expect(sessionDisplayState({ ...value, online: false }).label).toBe("已断线");
});
