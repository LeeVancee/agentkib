import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BackendTaskError,
  BoundedTaskQueue,
  TaskContext,
} from "../../../packages/backend/src/task-executor";

function gate<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
afterEach(() => vi.useRealTimers());

describe("bounded backend task admission", () => {
  it("runs one task, queues eight in order and rejects the tenth without invoking it", async () => {
    const queue = new BoundedTaskQueue({ name: "test" });
    const held = gate();
    const order: number[] = [];
    const first = queue.run(async () => {
      order.push(0);
      await held.promise;
    });
    const rest = Array.from({ length: 8 }, (_, index) =>
      queue.run(() => {
        order.push(index + 1);
      }),
    );
    const rejected = vi.fn();
    await expect(queue.run(rejected)).rejects.toMatchObject({ reason: "queue-full" });
    expect(rejected).not.toHaveBeenCalled();
    expect(order).toEqual([0]);
    held.resolve();
    await Promise.all([first, ...rest]);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    await queue.close();
  });

  it("starts the deadline at admission, removes expired waiters and never starts them", async () => {
    vi.useFakeTimers();
    const queue = new BoundedTaskQueue({ name: "test", timeoutMs: 180_000 });
    const held = gate();
    const first = queue.run(async (task) => {
      await held.promise;
      task.checkpoint();
    });
    const firstFailure = expect(first).rejects.toMatchObject({ reason: "deadline-exceeded" });
    await vi.advanceTimersByTimeAsync(10_000);
    const waiting = vi.fn();
    const later = queue.run(waiting);
    const laterFailure = expect(later).rejects.toMatchObject({ reason: "deadline-exceeded" });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(waiting).not.toHaveBeenCalled();
    held.resolve();
    await Promise.all([firstFailure, laterFailure]);
    await expect(queue.run(() => "next")).resolves.toBe("next");
    await queue.close();
  });

  it("waits for protected local work and its compensation on shutdown", async () => {
    const queue = new BoundedTaskQueue({ name: "test" });
    const writing = gate();
    const begun = gate();
    let compensated = false;
    const active = queue.run((task) =>
      task.commit(async () => {
        begun.resolve();
        await writing.promise;
        task.checkpoint(); // Cancellation cannot cut off this compensation.
        compensated = true;
        throw new Error("write failed after compensation");
      }),
    );
    const activeFailure = expect(active).rejects.toThrow("after compensation");
    await begun.promise;
    const pending = queue.run(() => "must not start");
    const pendingFailure = expect(pending).rejects.toMatchObject({ reason: "backend-closing" });
    let drained = false;
    const close = queue.close().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    await expect(queue.run(() => null)).rejects.toMatchObject({ reason: "backend-closing" });
    writing.resolve();
    await Promise.all([activeFailure, pendingFailure, close]);
    expect(compensated).toBe(true);
  });

  it("rejects a write before entering it when expired, but returns a completed commit truthfully", async () => {
    vi.useFakeTimers();
    const task = new TaskContext({ id: "commit", deadlineAt: Date.now() + 100 });
    const held = gate();
    const started = task.commit(async () => {
      await held.promise;
      return "saved";
    });
    await vi.advanceTimersByTimeAsync(101);
    held.resolve();
    await expect(started).resolves.toBe("saved");
    expect(task.committed).toBe(true);
    await expect(task.commit(() => "late")).rejects.toBeInstanceOf(BackendTaskError);
    task.dispose();
  });
});
