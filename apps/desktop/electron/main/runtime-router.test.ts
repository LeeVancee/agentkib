import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { BACKEND_INITIALIZE, BACKEND_PREFERENCES } from "@agentkib/backend/migration";
import {
  PROTOCOL_VERSION,
  RUNTIME_METHODS,
  type RuntimeHandshakeResult,
} from "../generated/runtime-protocol";
import { type RuntimeHost, type RuntimeHostStatus, RuntimeUnavailableError } from "./runtime-host";
import { RuntimeRouter } from "./runtime-router";

const handshake: RuntimeHandshakeResult = {
  protocolVersion: PROTOCOL_VERSION,
  runtime: { name: "fixture", version: "0.13.0" },
  pid: 1,
  capabilities: ["fixture"],
};

class Host extends EventEmitter implements RuntimeHost {
  status: RuntimeHostStatus = { state: "stopping", restartCount: 0 };
  handler: (method: string, params: unknown) => unknown = (method) => {
    if (method === RUNTIME_METHODS.runtimeInfo)
      return { data_dir: "/fixture", session_index_enabled: true };
    if (method === BACKEND_PREFERENCES || method === RUNTIME_METHODS.setLocale)
      return { locale_preference: "zh-TW" };
    return [];
  };
  calls: string[] = [];
  start = vi.fn(async () => {
    this.ready();
    return handshake;
  });
  retry = vi.fn(async () => {
    this.ready();
    return handshake;
  });
  stop = vi.fn(async () => {
    this.status.state = "stopping";
    this.emit("exit", { expected: true });
  });
  async request<T>(method: string, params: unknown): Promise<T> {
    this.calls.push(method);
    return (await this.handler(method, params)) as T;
  }
  ready() {
    this.status.state = "ready";
    this.emit("ready", handshake);
  }
  crash() {
    this.status = { state: "restarting", restartCount: this.status.restartCount + 1 };
    this.emit("exit", { expected: false });
    this.emit("state", this.status);
  }
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

describe("RuntimeRouter migration ownership and recovery", () => {
  it("waits for shared database initialization before serving migrated requests", async () => {
    const rust = new Host();
    const ts = new Host();
    const initialized = gate();
    ts.handler = (method) => (method === BACKEND_INITIALIZE ? initialized.promise : ["typescript"]);
    const router = new RuntimeRouter(rust, ts);
    const starting = router.start();
    const reading = router.request(RUNTIME_METHODS.listWorkspaces, {});
    await vi.waitFor(() => expect(ts.calls).toContain(BACKEND_INITIALIZE));
    expect(ts.calls).not.toContain(RUNTIME_METHODS.listWorkspaces);
    initialized.resolve();
    await starting;
    expect(await reading).toEqual(["typescript"]);
    expect(rust.calls.filter((method) => method === RUNTIME_METHODS.listWorkspaces)).toHaveLength(
      1,
    );
    expect(rust.calls).not.toContain(RUNTIME_METHODS.handshake);
    await router.stop();
  });

  it("serializes preference writers across both processes and continues after an error", async () => {
    const rust = new Host();
    const ts = new Host();
    const router = new RuntimeRouter(rust, ts);
    await router.start();
    const writing = gate();
    rust.handler = (method) => {
      if (method === RUNTIME_METHODS.updateMcpNetwork)
        return writing.promise.then(() => {
          throw new Error("fixture write failed");
        });
      return { data_dir: "/fixture", session_index_enabled: true };
    };
    const first = expect(
      router.request(RUNTIME_METHODS.updateMcpNetwork, { settings: {} }),
    ).rejects.toThrow("fixture write failed");
    const second = router.request(RUNTIME_METHODS.setLocale, { preference: "zh-TW" });
    const snapshot = router.request(RUNTIME_METHODS.runtimeInfo, {});
    await vi.waitFor(() => expect(rust.calls).toContain(RUNTIME_METHODS.updateMcpNetwork));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(ts.calls).not.toContain(RUNTIME_METHODS.setLocale);
    expect(ts.calls).not.toContain(BACKEND_PREFERENCES);
    writing.resolve();
    await first;
    expect(await second).toMatchObject({ locale_preference: "zh-TW", session_index_enabled: true });
    expect(await snapshot).toMatchObject({
      locale_preference: "zh-TW",
      session_index_enabled: true,
    });
    expect(rust.calls).not.toContain(RUNTIME_METHODS.setLocale);
    await router.stop();
  });

  it("does not replay failed TypeScript operations through Rust", async () => {
    const rust = new Host();
    const ts = new Host();
    const router = new RuntimeRouter(rust, ts);
    await router.start();
    ts.handler = () => {
      throw new Error("typescript failure");
    };
    await expect(router.request(RUNTIME_METHODS.setLocale, {})).rejects.toThrow(
      "typescript failure",
    );
    expect(rust.calls).not.toContain(RUNTIME_METHODS.setLocale);
    await router.stop();
  });

  it("reinitializes a recovered process without restarting its healthy peer", async () => {
    const rust = new Host();
    const ts = new Host();
    const router = new RuntimeRouter(rust, ts);
    await router.start();
    ts.crash();
    const waiting = router.request(RUNTIME_METHODS.runtimeInfo, {});
    expect(router.status.state).toBe("restarting");
    ts.ready();
    expect(await waiting).toMatchObject({
      locale_preference: "zh-TW",
      session_index_enabled: true,
    });
    expect(ts.calls.filter((method) => method === BACKEND_INITIALIZE)).toHaveLength(2);
    expect(rust.start).toHaveBeenCalledTimes(1);
    expect(rust.retry).not.toHaveBeenCalled();
    await router.stop();
  });

  it("keeps terminal failures until manual retry even if the peer restarts", async () => {
    const rust = new Host();
    const ts = new Host();
    const router = new RuntimeRouter(rust, ts);
    await router.start();
    ts.status = { state: "failed", restartCount: 3, error: "crash loop" };
    ts.emit("state", ts.status);
    rust.crash();
    rust.ready();
    await expect(router.request(RUNTIME_METHODS.runtimeInfo, {})).rejects.toBeInstanceOf(
      RuntimeUnavailableError,
    );
    expect(router.status.state).toBe("failed");
    await router.retry();
    expect(router.status.state).toBe("ready");
    await router.stop();
  });

  it("cancels queued requests and cannot become ready after shutdown", async () => {
    const rust = new Host();
    const ts = new Host();
    const initialized = gate();
    ts.handler = () => initialized.promise;
    const router = new RuntimeRouter(rust, ts);
    const starting = expect(router.start()).rejects.toBeInstanceOf(RuntimeUnavailableError);
    const waiting = expect(
      router.request(RUNTIME_METHODS.listWorkspaces, {}),
    ).rejects.toBeInstanceOf(RuntimeUnavailableError);
    await vi.waitFor(() => expect(ts.calls).toContain(BACKEND_INITIALIZE));
    await router.stop();
    initialized.resolve();
    await Promise.all([starting, waiting]);
    expect(router.status.state).toBe("stopping");
    expect(rust.stop).toHaveBeenCalledTimes(1);
    expect(ts.stop).toHaveBeenCalledTimes(1);
  });
});
