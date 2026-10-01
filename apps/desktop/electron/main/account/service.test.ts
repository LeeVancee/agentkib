// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DesktopAccountService } from "./service";

const profile = {
  id: "account-a",
  username: "alice",
  status: "active",
  deviceLimit: 3,
  deviceCount: 1,
  totpEnabled: false,
};
const tokens = {
  accessToken: "a".repeat(43),
  refreshToken: "r".repeat(43),
  expiresIn: 600,
  account: profile,
};
let directory: string;
let service: DesktopAccountService;
let opened: string;
let network: ReturnType<typeof vi.fn>;
let pause: ReturnType<typeof vi.fn<() => Promise<unknown>>>;
let identity:
  | {
      deviceId: string;
      credential: string;
      accountId?: string;
      accountClaimPending?: boolean;
      accountClaimAccountId?: string;
    }
  | undefined;
let available: boolean;
async function setup() {
  service = new DesktopAccountService({
    directory,
    storage: {
      available: () => available,
      encrypt: (value) => Buffer.from(Buffer.from(value).map((byte) => byte ^ 0x55)),
      decrypt: (value) => Buffer.from(value.map((byte) => byte ^ 0x55)).toString(),
    },
    openExternal: async (url) => {
      opened = url;
    },
    pauseRemote: pause,
    identity: async () => identity,
    prepareIdentityClaim: async (id) => {
      identity!.accountClaimPending = true;
      identity!.accountClaimAccountId = id;
    },
    bindIdentity: async (id) => {
      identity!.accountId = id;
      delete identity!.accountClaimPending;
      delete identity!.accountClaimAccountId;
    },
    fetch: network as typeof fetch,
  });
  await service.initialize();
}
async function callback(state?: string) {
  const params = new URLSearchParams(new URL(opened).hash.split("?")[1]);
  const url = new URL(params.get("redirectUri")!);
  url.searchParams.set("state", state ?? params.get("state")!);
  url.searchParams.set("code", "c".repeat(43));
  const result = await fetch(url);
  await vi.waitFor(async () => expect((await service.status()).phase).not.toBe("signing-in"));
  return result;
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "agentkib-account-"));
  opened = "";
  available = true;
  identity = undefined;
  network = vi.fn<typeof fetch>(async () => Response.json(tokens));
  pause = vi.fn(async () => undefined);
  await setup();
});
afterEach(async () => {
  service.shutdown();
  await rm(directory, { recursive: true, force: true });
});

describe("desktop account boundary", () => {
  it("uses a real loopback PKCE callback and only publishes safe profile data", async () => {
    expect((await service.request({ operation: "login" })).phase).toBe("signing-in");
    const params = new URLSearchParams(new URL(opened).hash.split("?")[1]);
    expect(new URL(opened).origin).toBe("https://account.agentkib.com");
    expect((await callback()).status).toBe(200);
    const [endpoint, request] = network.mock.calls[0] as unknown as [URL, RequestInit];
    const body = JSON.parse(request.body as string);
    expect(endpoint.pathname).toBe("/v1/auth/token");
    expect(createHash("sha256").update(body.codeVerifier).digest("base64url")).toBe(
      params.get("codeChallenge"),
    );
    expect(body.grantType).toBe("authorization_code");
    const state = await service.status();
    expect(state.account).toEqual(profile);
    expect(JSON.stringify(state)).not.toContain(tokens.accessToken);
    expect(JSON.stringify(state)).not.toContain(tokens.refreshToken);
    expect((await readFile(join(directory, "refresh.enc"))).toString()).not.toContain(
      tokens.refreshToken,
    );
  });
  it("rejects wrong state and allows cancel without redeeming a code", async () => {
    await service.request({ operation: "login" });
    const params = new URLSearchParams(new URL(opened).hash.split("?")[1]);
    const url = new URL(params.get("redirectUri")!);
    url.searchParams.set("state", "wrong");
    url.searchParams.set("code", "c".repeat(43));
    expect((await fetch(url)).status).toBe(400);
    await service.request({ operation: "cancel-login" });
    expect(network).not.toHaveBeenCalled();
    expect((await service.status()).phase).toBe("signed-out");
  });
  it("does not open browser or persist plaintext without secure storage", async () => {
    available = false;
    expect((await service.request({ operation: "login" })).error).toBe(
      "account_secure_storage_unavailable",
    );
    expect(opened).toBe("");
    await expect(readFile(join(directory, "refresh.enc"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("serializes refresh and never retries an uncertain rotated token after restart", async () => {
    await service.request({ operation: "login" });
    await callback();
    service.shutdown();
    network.mockClear();
    network.mockRejectedValue(new Error("connection reset"));
    await setup();
    expect(network).toHaveBeenCalledTimes(1);
    expect((await service.status()).phase).toBe("signed-out");
    await setup();
    expect(network).toHaveBeenCalledTimes(1);
  });
  it("detects a crash marker before using old refresh credentials", async () => {
    await service.request({ operation: "login" });
    await callback();
    service.shutdown();
    await writeFile(join(directory, "rotation-pending"), "pending");
    network.mockClear();
    await setup();
    expect(network).not.toHaveBeenCalled();
    expect((await service.status()).error).toBe("account_login_required");
  });
  it("persists remote pause before logout network and preserves the device identity", async () => {
    identity = { deviceId: "device", credential: "private", accountId: profile.id };
    await service.request({ operation: "login" });
    await callback();
    network.mockImplementation(async () => {
      expect(pause).toHaveBeenCalledOnce();
      throw new Error("offline");
    });
    const state = await service.request({ operation: "logout" });
    expect(state.error).toBe("account_remote_logout_unconfirmed");
    expect(state.phase).toBe("signed-out");
    expect(identity.credential).toBe("private");
    await expect(service.ensureDeviceOwner(profile.id)).rejects.toBeDefined();
  });
  it("blocks a concurrent relay enable while logout revocation is in flight", async () => {
    await service.request({ operation: "login" });
    await callback();
    let release!: () => void;
    network.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return Response.json({ ok: true });
    });
    const logout = service.request({ operation: "logout" });
    await vi.waitFor(() => expect(release).toBeDefined());
    await expect(service.ensureDeviceOwner(profile.id)).rejects.toThrow("account_login_required");
    await expect(service.ensureDeviceOwner()).rejects.toThrow("account_login_required");
    expect(service.signedIn).toBe(false);
    release();
    await logout;
  });
  it("does not clear credentials if durable pause fails", async () => {
    await service.request({ operation: "login" });
    await callback();
    pause.mockRejectedValue(new Error("disk failure"));
    const state = await service.request({ operation: "logout" });
    expect(state.phase).toBe("signed-in");
    expect(await readFile(join(directory, "refresh.enc"))).toBeDefined();
  });
  it("claims only through the desktop credential and rejects another owner", async () => {
    identity = { deviceId: "device", credential: "private" };
    await service.request({ operation: "login" });
    await callback();
    network.mockImplementation(async (url: URL) =>
      Response.json(
        url.pathname === "/v1/account" ? profile : { deviceId: "device", accountId: profile.id },
      ),
    );
    expect((await service.request({ operation: "claim" })).device?.ownership).toBe("owned");
    const request = network.mock.calls.find(
      (call) => (call[0] as URL).pathname === "/v1/account/devices/claim",
    )![1] as RequestInit;
    expect(JSON.parse(request.body as string)).toEqual({
      deviceId: "device",
      credential: "private",
    });
    identity.accountId = "another-account";
    expect((await service.request({ operation: "claim" })).error).toBe("account_device_conflict");
  });
  it("a definite profile rejection clears cached login and encrypted refresh state", async () => {
    await service.request({ operation: "login" });
    await callback();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
    network.mockImplementation(async () =>
      Response.json({ error: "authentication_required" }, { status: 401 }),
    );
    try {
      const state = await service.request({ operation: "status" });
      expect(state.phase).toBe("signed-out");
      expect(state.account).toBeUndefined();
      expect(state.error).toBe("account_login_required");
      await expect(readFile(join(directory, "refresh.enc"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      clock.mockRestore();
    }
  });
  it("claim 401 clears authentication but permission and quota rejections preserve login", async () => {
    identity = { deviceId: "device", credential: "private" };
    await service.request({ operation: "login" });
    await callback();
    network.mockImplementation(async () =>
      Response.json({ error: "device_limit_reached" }, { status: 409 }),
    );
    expect((await service.request({ operation: "claim" })).error).toBe("account_device_limit");
    expect((await service.status()).phase).toBe("signed-in");
    network.mockImplementation(async () =>
      Response.json({ error: "device_unavailable" }, { status: 403 }),
    );
    expect((await service.request({ operation: "claim" })).error).toBe("account_forbidden");
    expect((await service.status()).phase).toBe("signed-in");
    network.mockImplementation(async () =>
      Response.json({ error: "authentication_required" }, { status: 401 }),
    );
    expect((await service.request({ operation: "claim" })).phase).toBe("signed-out");
  });
  it("account registration 401 publishes signed-out state and arbitrary errors stay private", async () => {
    await service.request({ operation: "login" });
    await callback();
    network.mockImplementation(async () =>
      Response.json({ error: "sensitive-debug-data" }, { status: 409 }),
    );
    await expect(
      service.registerDevice({ registrationId: "test", credential: "private" }),
    ).rejects.toThrow("account_device_conflict");
    expect(JSON.stringify(await service.status())).not.toContain("sensitive-debug-data");
    network.mockImplementation(async () =>
      Response.json({ error: "authentication_required" }, { status: 401 }),
    );
    await expect(
      service.registerDevice({ registrationId: "test", credential: "private" }),
    ).rejects.toThrow("account_login_required");
    expect((await service.status()).phase).toBe("signed-out");
  });
  it("does not auto-claim for a different account after an uncertain claim", async () => {
    identity = { deviceId: "device", credential: "private" };
    await service.request({ operation: "login" });
    await callback();
    network.mockRejectedValue(new Error("request never reached server"));
    await service.request({ operation: "claim" });
    expect(identity.accountClaimAccountId).toBe(profile.id);
    expect(identity.accountId).toBeUndefined();
    await service.request({ operation: "logout" });
    const other = { ...profile, id: "account-b", username: "bob" };
    network.mockClear();
    network.mockImplementation(async (url: URL) =>
      Response.json(
        url.pathname === "/v1/auth/token" ? { ...tokens, account: other } : { ok: true },
      ),
    );
    await service.request({ operation: "login" });
    await callback();
    const state = await service.request({ operation: "status" });
    expect(state.phase).toBe("signed-in");
    expect(state.account?.id).toBe(other.id);
    expect(state.error).toBe("account_claim_pending");
    expect((await service.request({ operation: "claim" })).error).toBe("account_claim_pending");
    expect(
      network.mock.calls.some((call) => (call[0] as URL).pathname === "/v1/account/devices/claim"),
    ).toBe(false);
    expect(identity.accountId).toBeUndefined();
  });
  it("reconciles a pending claim only after the intended account signs in again", async () => {
    identity = {
      deviceId: "device",
      credential: "private",
      accountClaimPending: true,
      accountClaimAccountId: profile.id,
    };
    network.mockImplementation(async (url: URL) =>
      Response.json(
        url.pathname === "/v1/auth/token"
          ? tokens
          : url.pathname === "/v1/account"
            ? profile
            : { deviceId: "device", accountId: profile.id },
      ),
    );
    await service.request({ operation: "login" });
    await callback();
    const state = await service.request({ operation: "status" });
    expect(state.device?.ownership).toBe("owned");
    expect(identity.accountClaimPending).toBeUndefined();
    expect(identity.accountClaimAccountId).toBeUndefined();
    expect(
      network.mock.calls.filter(
        (call) => (call[0] as URL).pathname === "/v1/account/devices/claim",
      ),
    ).toHaveLength(1);
  });
  it("rejects injected paths or native RPC parameters", async () => {
    await expect(
      service.request({ operation: "login", url: "https://attacker.invalid" } as never),
    ).rejects.toThrow("invalid_account_request");
  });
});
