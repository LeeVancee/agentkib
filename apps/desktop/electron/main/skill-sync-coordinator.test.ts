import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeHost } from "./runtime-host";
import { SkillSyncCoordinator } from "./skill-sync-coordinator";

afterEach(() => vi.useRealTimers());
function fixture() {
  const request = vi.fn().mockResolvedValue(null);
  const onState = vi.fn();
  const coordinator = new SkillSyncCoordinator({
    runtime: () => ({ request }) as unknown as RuntimeHost,
    onState,
  });
  coordinator.setRuntimeAvailable(true);
  return { request, onState, coordinator };
}
describe("SkillSyncCoordinator", () => {
  it("checks after startup, continues without a visible window, and stops on quit", async () => {
    vi.useFakeTimers();
    const { coordinator, request, onState } = fixture();
    coordinator.start();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(request).toHaveBeenCalledExactlyOnceWith("skills.runDueSync", {});
    expect(onState).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledTimes(2);
    coordinator.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("pauses for sleep or lock and checks once after resume and runtime recovery", async () => {
    vi.useFakeTimers();
    const { coordinator, request } = fixture();
    coordinator.start();
    coordinator.setSuspended(true);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(request).not.toHaveBeenCalled();
    coordinator.setSuspended(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(request).toHaveBeenCalledTimes(1);
    coordinator.setRuntimeAvailable(false);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(request).toHaveBeenCalledTimes(1);
    coordinator.setRuntimeAvailable(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(request).toHaveBeenCalledTimes(2);
    coordinator.stop();
  });
  it("deduplicates active checks and backs off failures without reporting success", async () => {
    vi.useFakeTimers();
    const { coordinator, request, onState } = fixture();
    let reject!: (error: Error) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((_resolve, no) => {
          reject = no;
        }),
    );
    coordinator.start();
    const first = coordinator.tick();
    expect(coordinator.tick()).toBe(first);
    reject(new Error("offline"));
    await first;
    expect(onState).toHaveBeenCalledExactlyOnceWith({ state: "failed", error: "offline" });
    await vi.advanceTimersByTimeAsync(119_999);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(2);
    coordinator.stop();
  });
});
