// @vitest-environment node
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerSession } from "../../../packages/backend/src/codex-app-server";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("cross-spawn", () => ({ default: spawn }));

const cleanups: Array<() => void | Promise<void>> = [];

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  spawn.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stdin: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null,
  });
  spawn.mockReturnValue(child);
  const frames: Array<Record<string, unknown>> = [];
  let respond = true;
  child.stdin.on("data", (chunk: Buffer) => {
    const frame = JSON.parse(chunk.toString("utf8")) as Record<string, unknown>;
    frames.push(frame);
    if (typeof frame.id === "number" && respond)
      child.stdout.write(JSON.stringify({ id: frame.id, result: { accepted: true } }) + "\n");
  });
  const session = await CodexAppServerSession.start(
    "/synthetic/codex",
    "/synthetic/workspace",
    "/synthetic/home",
    {},
  );
  frames.splice(0);
  cleanups.push(async () => {
    child.exitCode = 0;
    child.emit("close", 0);
    await session.close();
    child.stdout.destroy();
    child.stdin.destroy();
  });
  return { session, child, frames, setRespond: (value: boolean) => (respond = value) };
}

describe("Codex app-server dispatch cleanup", () => {
  it("rejects before writing and releases the response timer without an unhandled rejection", async () => {
    const f = await fixture();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    cleanups.push(() => {
      process.off("unhandledRejection", unhandled);
    });
    await expect(
      f.session.request("turn/start", {}, () => {
        throw new Error("session-compacting");
      }),
    ).rejects.toThrow("session-compacting");
    expect(f.frames).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(unhandled).not.toHaveBeenCalled();
    await expect(f.session.request("thread/read", {})).resolves.toEqual({ accepted: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not exhaust pending request capacity after repeated dispatch rejections", async () => {
    const f = await fixture();
    for (let index = 0; index < 129; index++)
      await expect(
        f.session.request("turn/start", {}, () => {
          throw new Error("session-compacting");
        }),
      ).rejects.toThrow("session-compacting");
    expect(f.frames).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    await expect(f.session.request("thread/read", {})).resolves.toEqual({ accepted: true });
  });

  it("runs the admission callback immediately before a successful native write", async () => {
    const f = await fixture();
    const dispatch = vi.fn(() => expect(f.frames).toEqual([]));
    await expect(f.session.request("turn/start", {}, dispatch)).resolves.toEqual({
      accepted: true,
    });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(f.frames).toMatchObject([{ method: "turn/start" }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still rejects a dispatched request at the native response timeout", async () => {
    const f = await fixture();
    f.setRespond(false);
    const rejection = expect(f.session.request("turn/start", {})).rejects.toThrow(
      "Codex app-server request timed out",
    );
    expect(f.frames).toMatchObject([{ method: "turn/start" }]);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(12_000);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
    f.setRespond(true);
    await expect(f.session.request("thread/read", {})).resolves.toEqual({ accepted: true });
  });

  it("cleans up an unwritten request when stdin.write throws", async () => {
    const f = await fixture();
    vi.spyOn(f.child.stdin, "write").mockImplementationOnce(() => {
      throw new Error("fixture-write-failure");
    });
    await expect(f.session.request("turn/start", {})).rejects.toThrow("fixture-write-failure");
    expect(f.frames).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(12_000);
    await expect(f.session.request("thread/read", {})).resolves.toEqual({ accepted: true });
  });
});
