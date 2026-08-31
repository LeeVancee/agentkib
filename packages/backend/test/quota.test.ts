import { test, expect } from "vitest";
import { collectQuota, refreshFreshness, selectBackend, type CommandRunner } from "../src/index.js";
test("selects platform backend and refreshes freshness", () => {
  expect(selectBackend("win32")).toBe("win-codex-bar");
  expect(selectBackend("darwin")).toBe("codex-bar-cli");
  const value = {
    schema_version: 1,
    backend: "codex-bar-cli" as const,
    generated_at: new Date().toISOString(),
    fetched_at: new Date().toISOString(),
    stale_after_seconds: 60,
    freshness: "fresh" as const,
    providers: [],
  };
  expect(refreshFreshness(value).freshness).toBe("fresh");
});
test("validates mocked collector JSON and bounds diagnostics", async () => {
  const runner: CommandRunner = {
    run: async () => ({
      success: true,
      stderr: "",
      stdout: JSON.stringify({
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        staleAfterSeconds: 10,
        host: { codexBarVersion: "1" },
        providers: [],
      }),
    }),
  };
  const snapshot = await collectQuota(runner);
  expect(snapshot.schema_version).toBe(1);
  await expect(
    collectQuota({ run: async () => ({ success: true, stdout: "bad", stderr: "" }) }),
  ).rejects.toMatchObject({ code: "VALIDATION" });
});
