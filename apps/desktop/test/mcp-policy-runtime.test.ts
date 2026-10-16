import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { RUNTIME_METHODS } from "@agentkib/runtime-protocol";
import { BackendStore } from "../../../packages/backend/src/store";
import type { NativeMcpCandidate } from "../../../packages/backend/src/mcp-native-scan";
import { DesktopRuntimeHost } from "../electron/main/runtime-host";
import { RuntimeRouter } from "../electron/main/runtime-router";
import { createStdioTransport, type RuntimeTransport } from "../electron/main/runtime-transport";

const { createIsolatedWorkerEnvironment } = createRequire(import.meta.url)(
  "../scripts/backend-worker-smoke-environment.cjs",
) as { createIsolatedWorkerEnvironment(root: string): NodeJS.ProcessEnv };
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("keeps the real Backend responsive while scanning adversarial MCP URL wildcards", async () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "mcp-policy-runtime-")));
  cleanups.push(() =>
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  );
  const project = path.join(root, "project"),
    dataDir = path.join(root, "data");
  for (const directory of [project, dataDir, path.join(root, "tmp"), path.join(project, ".claude")])
    mkdirSync(directory, { recursive: true });
  const store = new BackendStore(path.join(dataDir, "agentkib.db"));
  try {
    store.sql.run(
      "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
      "registered",
      project,
      "Fixture",
      "healthy",
      "2026-10-15T00:00:00Z",
    );
  } finally {
    store.close();
  }
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  writeFileSync(
    path.join(dataDir, "preferences.json"),
    JSON.stringify({
      session_index_enabled: false,
      session_content_search_enabled: false,
      mcp_network: { port, lan_enabled: false, lan_risk_accepted: false },
    }),
  );
  writeFileSync(
    path.join(project, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        subject: { type: "http", url: `https://example.invalid/${"a".repeat(40)}` },
        matched: { type: "http", url: `https://example.invalid/${"a".repeat(40)}Z` },
      },
    }),
  );
  writeFileSync(
    path.join(project, ".claude/settings.json"),
    JSON.stringify({
      // Denies always merge, including on machines with managed-only allowlists. The first
      // candidate exercises the pathological nonmatch; the second proves the rule was applied.
      deniedMcpServers: [{ serverUrl: `*${"a*".repeat(16)}Z` }],
    }),
  );
  const environment = createIsolatedWorkerEnvironment(root);
  let transport: RuntimeTransport | undefined;
  const host = new DesktopRuntimeHost({
    executablePath: process.execPath,
    args: [path.resolve("dist-electron/backend.cjs")],
    clientVersion: "test",
    maxRestarts: 0,
    createTransport: (options) => (transport = createStdioTransport({ ...options, environment })),
  });
  const router = new RuntimeRouter(host, dataDir);
  cleanups.push(async () => {
    await router.stop();
    expect(transport?.hasExited).toBe(true);
  });
  await router.start();
  // The watchdog runs in the test process, so a future synchronous regression cannot hang CI.
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const completed = Promise.all([
      router.request<NativeMcpCandidate[]>(RUNTIME_METHODS.scanNativeMcp, { project }),
      router.request(RUNTIME_METHODS.listWorkspaces, {}),
    ]);
    const [candidates] = await Promise.race([
      completed,
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => {
          transport?.forceKill();
          reject(new Error("MCP scan blocked ordinary Backend requests for over 1 second"));
        }, 1000);
      }),
    ]);
    expect(candidates.some((item) => item.agent === "claude-code" && item.name === "subject")).toBe(
      true,
    );
    const matched = candidates.find(
      (item) => item.agent === "claude-code" && item.name === "matched",
    );
    expect(matched?.warning_messages?.map((message) => message.key)).toContain(
      "mcp.manage.diagnostic.native_policy_denied",
    );
  } finally {
    clearTimeout(watchdog);
  }
}, 15_000);
