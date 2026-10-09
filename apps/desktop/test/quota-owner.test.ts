import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackendStore } from "../../../packages/backend/src/store";
import { Commands } from "../../../packages/backend/src/commands";
import { QuotaOwner } from "../../../packages/backend/src/quota";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
});

const previousTime = "2026-09-09T14:15:32.000Z";
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentkib-quota-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new BackendStore(path.join(root, "agentkib.db"));
  cleanups.push(() => store.close());
  const commands = new Commands();
  const run = vi.spyOn(commands, "run");
  const sidecar = path.join(root, "collector");
  const config = path.join(root, "config.json");
  writeFileSync(sidecar, "synthetic executable, intercepted at process boundary");
  writeFileSync(config, '{"version":1,"providers":[]}');
  const owner = new QuotaOwner(store, commands, root, {
    AGENTKIB_QUOTA_SIDECAR: sidecar,
    CODEXBAR_CONFIG: config,
    // Keep Windows proxy discovery from invoking a separate command.
    HTTPS_PROXY: "http://127.0.0.1:1",
  });
  store.saveQuotaSnapshot({
    backend: "codex-bar-cli",
    generated_at: previousTime,
    fetched_at: previousTime,
    stale_after_seconds: 180,
    providers: [{ id: "codex", windows: [{ remaining_percent: 13 }] }],
  });
  const before = store.quotaCollectorStatus({
    backend: "codex-bar-cli",
    platform_supported: true,
    sidecar_available: true,
    config_source: "environment",
    running: false,
  });
  function respond(providers: unknown[]) {
    const snapshot = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      staleAfterSeconds: 180,
      host: { codexBarVersion: "fixture" },
      providers,
    };
    run.mockResolvedValue({
      bytes: Buffer.from(JSON.stringify(snapshot)),
      error: "",
      success: true,
      truncated: false,
      exitCode: 0,
    });
  }
  return { store, owner, run, before, respond };
}

function window(remaining = 57) {
  return {
    kind: "weekly",
    label: "Weekly",
    usedPercent: 100 - remaining,
    remainingPercent: remaining,
  };
}
function provider(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    enabled: true,
    windows: [],
    updatedAt: new Date().toISOString(),
    ...extra,
  };
}

describe("quota collection diagnostics and partial results", () => {
  it("saves current Codex and Claude quota when only their separate cost scans timed out", async () => {
    const f = fixture();
    f.respond([
      provider("codex", {
        windows: [window()],
        error: { code: 1, message: "codex cost refresh timed out" },
      }),
      provider("claude", {
        windows: [window(61)],
        error: { code: 1, message: "claude cost refresh timed out" },
      }),
      provider("gemini", { error: "Not logged in" }),
    ]);
    await expect(f.owner.refresh()).resolves.toMatchObject({ status: { state: "succeeded" } });
    expect(f.owner.snapshot()).toMatchObject({
      freshness: "fresh",
      providers: [
        {
          id: "codex",
          windows: [{ remaining_percent: 57 }],
          error: "codex cost refresh timed out",
        },
        {
          id: "claude",
          windows: [{ remaining_percent: 61 }],
          error: "claude cost refresh timed out",
        },
        { id: "gemini", error: "Not logged in" },
      ],
    });
    expect(await f.owner.status()).not.toHaveProperty("error_key");
    expect(f.run).toHaveBeenCalledOnce();
  });

  it.each(["Authentication failed (401)", "codex usage timed out", "unknown provider failure"])(
    "keeps the old cache and reports the actual failure for %s, even with returned windows",
    async (error) => {
      const f = fixture();
      f.respond([provider("codex", { windows: [window()], error })]);
      await expect(f.owner.refresh()).rejects.toThrow(`codex: ${error}`);
      expect(f.owner.snapshot()).toMatchObject({ fetched_at: previousTime, freshness: "stale" });
      expect(await f.owner.status()).toMatchObject({
        last_success_at: (f.before as { last_success_at: string }).last_success_at,
        error_key: "errors.quotaUnavailable",
        error_detail: expect.stringContaining(`codex: ${error}`),
      });
      expect(f.run).toHaveBeenCalledOnce();
    },
  );

  it.each([previousTime, undefined, "2099-01-01T00:00:00Z"])(
    "rejects cost-only results with stale or missing update time (%s)",
    async (updatedAt) => {
      const f = fixture();
      f.respond([
        provider("codex", {
          updatedAt,
          windows: [window()],
          error: "codex cost refresh timed out",
        }),
      ]);
      await expect(f.owner.refresh()).rejects.toThrow("no usable quota");
      expect(f.owner.snapshot()).toMatchObject({ fetched_at: previousTime, freshness: "stale" });
    },
  );

  it("does not turn a cost-only error with no quota into a success", async () => {
    const f = fixture();
    f.respond([provider("codex", { error: "codex cost refresh timed out" })]);
    await expect(f.owner.refresh()).rejects.toThrow("codex: codex cost refresh timed out");
    expect(f.owner.snapshot()).toMatchObject({ fetched_at: previousTime });
  });

  it.each([
    ["codex", "codex cost refresh timed out; usage failed"],
    ["other", "other cost refresh timed out"],
  ])("rejects unverified cost errors for %s", async (id, error) => {
    const f = fixture();
    f.respond([provider(id, { windows: [window()], error })]);
    await expect(f.owner.refresh()).rejects.toThrow("no usable quota");
    expect(f.owner.snapshot()).toMatchObject({ fetched_at: previousTime });
  });

  it("reports each enabled provider and account failure without overwriting last-good data", async () => {
    const f = fixture();
    f.respond([
      provider("codex", {
        error: { message: "Usage request failed (403)" },
        accountsError: "Account enumeration failed",
      }),
      provider("claude", {
        accounts: [
          {
            id: "private-id",
            label: "private-account",
            active: true,
            windows: [],
            error: "Usage timed out",
          },
        ],
      }),
      provider("gemini"),
      provider("disabled", {
        enabled: false,
        windows: [window()],
        error: "Do not include disabled diagnostics",
      }),
    ]);
    await expect(f.owner.refresh()).rejects.toThrow("no usable quota");
    const status = (await f.owner.status()) as { error_detail: string };
    expect(status.error_detail).toContain(
      "codex: Usage request failed (403); Account enumeration failed".replace("; ", " "),
    );
    expect(status.error_detail).toContain("claude: Usage timed out");
    expect(status.error_detail).toContain("gemini: No usable quota");
    expect(status.error_detail).not.toMatch(/private-id|private-account|disabled/);
    expect(f.owner.snapshot()).toMatchObject({ fetched_at: previousTime });
  });

  it("redacts credentials, URL parameters and private keys before returning or persisting diagnostics", async () => {
    const f = fixture();
    f.respond([
      provider("codex", {
        error: [
          "Request failed (403)",
          "Authorization: Bearer private-credential",
          "password = private-password",
          'Upstream response: {"password":"private-json-password"}',
          "https://user:private-password@example.test/usage?session=private-session",
          "upstream sk-abcdef1234567890abcdef",
          "upstream eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.syntheticSignature",
          "account private-account@example.test",
          "-----BEGIN RSA PRIVATE KEY-----",
          "private-key-body",
          "-----END RSA PRIVATE KEY-----",
          "-----BEGIN PRIVATE KEY-----",
          "private-key-pkcs8-body",
          "-----END PRIVATE KEY-----",
        ].join("\n"),
      }),
    ]);
    await expect(f.owner.refresh()).rejects.toThrow("Request failed (403)");
    const status = (await f.owner.status()) as { error_detail: string };
    expect(status.error_detail).not.toMatch(
      /private-credential|private-password|private-json-password|private-session|private-key-body|private-key-pkcs8-body|abcdef1234567890abcdef|eyJhbGci|private-account/,
    );
    expect(status.error_detail.length).toBeLessThanOrEqual(1000);
  });

  it("bounds large diagnostics while keeping a reason for every displayed provider", async () => {
    const f = fixture();
    f.respond(
      Array.from({ length: 10 }, (_, i) =>
        provider(`provider-${i}`, { error: "Unavailable ".repeat(500) }),
      ),
    );
    await expect(f.owner.refresh()).rejects.toThrow("no usable quota");
    const status = (await f.owner.status()) as { error_detail: string };
    for (let i = 0; i < 8; i++) expect(status.error_detail).toContain(`provider-${i}:`);
    expect(status.error_detail).toContain("2 more providers omitted");
    expect(status.error_detail.length).toBeLessThanOrEqual(1000);
  });

  it.each([
    'Upstream response: {"password":"SYNTHETIC-SECRET"}',
    "-----BEGIN PRIVATE KEY-----\nSYNTHETIC-SECRET\n-----END PRIVATE KEY-----",
    "-----BEGIN PRIVATE KEY-----\nSYNTHETIC-SECRET",
  ])(
    "redacts quoted passwords and standard or incomplete private-key blocks (%s)",
    async (error) => {
      const f = fixture();
      f.respond([provider("codex", { error })]);
      await expect(f.owner.refresh()).rejects.not.toThrow("SYNTHETIC-SECRET");
      expect(JSON.stringify(await f.owner.status())).not.toContain("SYNTHETIC-SECRET");
    },
  );

  it("preserves successful account quota and the parent warning", async () => {
    const f = fixture();
    f.respond([
      provider("codex", {
        error: "One account failed",
        accounts: [{ id: "a", label: "Fixture", active: true, windows: [window()] }],
      }),
    ]);
    await f.owner.refresh();
    expect(f.owner.snapshot()).toMatchObject({
      providers: [
        { error: "One account failed", accounts: [{ windows: [{ remaining_percent: 57 }] }] },
      ],
    });
  });

  it("preserves a healthy provider when another provider fails", async () => {
    const f = fixture();
    f.respond([
      provider("codex", { windows: [window()] }),
      provider("claude", { error: "claude usage timed out" }),
    ]);
    await f.owner.refresh();
    expect(f.owner.snapshot()).toMatchObject({
      providers: [
        { windows: [{ remaining_percent: 57 }] },
        { windows: [], error: "claude usage timed out" },
      ],
    });
  });

  it("does not conflate separate account failures with a verified cost timeout", async () => {
    const f = fixture();
    f.respond([
      provider("codex", {
        windows: [window()],
        error: "codex cost refresh timed out",
        accountsError: "Account lookup failed",
      }),
    ]);
    await expect(f.owner.refresh()).rejects.toThrow("Account lookup failed");
  });

  it("reports an empty enabled-provider configuration explicitly", async () => {
    const f = fixture();
    f.respond([]);
    await expect(f.owner.refresh()).rejects.toThrow("No providers are enabled");
  });
});
