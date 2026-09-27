import { beforeEach, describe, expect, it } from "vitest";
import { forgetPending, pendingScope, readPending, rememberPending } from "./pending-controls";

beforeEach(() => sessionStorage.clear());
describe("pending Codex identities", () => {
  it("isolates host and device and stores only identity fields", () => {
    const scope = pendingScope("http://192.168.1.2:1422", "device-a");
    const identity = {
      requestId: crypto.randomUUID(),
      sessionId: "session",
      kind: "send" as const,
      text: "never store this",
    };
    rememberPending(scope, identity);
    expect(sessionStorage.getItem(scope)).not.toContain("never store");
    expect(readPending(pendingScope("http://192.168.1.3:1422", "device-a"))).toEqual([]);
    expect(readPending(pendingScope("http://192.168.1.2:1422", "device-b"))).toEqual([]);
    expect(() => rememberPending(scope, { ...identity, requestId: crypto.randomUUID() })).toThrow();
    forgetPending(scope, identity.requestId);
    expect(readPending(scope)).toEqual([]);
  });
  it("permits native reconciliation while preserving an unknown send identity", () => {
    const scope = pendingScope("", "device");
    rememberPending(scope, { requestId: crypto.randomUUID(), sessionId: "session", kind: "send" });
    rememberPending(scope, {
      requestId: crypto.randomUUID(),
      sessionId: "session",
      kind: "reconcile",
    });
    expect(readPending(scope)).toHaveLength(2);
  });
  it("fails closed on malformed storage instead of silently erasing pending state", () => {
    const scope = pendingScope("", "device");
    sessionStorage.setItem(scope, "broken json");
    expect(() => readPending(scope)).toThrow();
    expect(() =>
      rememberPending(scope, {
        requestId: crypto.randomUUID(),
        sessionId: "session",
        kind: "send",
      }),
    ).toThrow();
    expect(sessionStorage.getItem(scope)).toBe("broken json");
  });
});
