// @vitest-environment node
import { it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptanceSession } from "./acceptance";

it("requires an explicit session and separate temporary runtime/user data", () => {
  expect(acceptanceSession({})).toBeUndefined();
  expect(() => acceptanceSession({ AGENTKIB_WEB_ACCEPTANCE_SESSION: "bad" })).toThrow();
  const root = mkdtempSync(join(tmpdir(), "agentkib-web-acceptance-"));
  try {
    const user = join(root, "electron"),
      runtime = join(root, "runtime");
    mkdirSync(user);
    mkdirSync(runtime);
    const env = {
      AGENTKIB_WEB_ACCEPTANCE_SESSION: "a".repeat(64),
      AGENTKIB_BENCHMARK_USER_DATA: user,
      AGENTKIB_BENCHMARK_DATA_DIR: runtime,
    };
    expect(acceptanceSession(env)).toBe(env.AGENTKIB_WEB_ACCEPTANCE_SESSION);
    expect(() => acceptanceSession({ ...env, AGENTKIB_BENCHMARK_DATA_DIR: user })).toThrow();
    expect(() =>
      acceptanceSession({ AGENTKIB_WEB_ACCEPTANCE_SESSION: env.AGENTKIB_WEB_ACCEPTANCE_SESSION }),
    ).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
