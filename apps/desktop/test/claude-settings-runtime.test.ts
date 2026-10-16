import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { RUNTIME_METHODS } from "@agentkib/runtime-protocol";
import { BackendStore } from "../../../packages/backend/src/store";
import { DesktopRuntimeHost } from "../electron/main/runtime-host";
import { RuntimeRouter } from "../electron/main/runtime-router";
import { createStdioTransport, type RuntimeTransport } from "../electron/main/runtime-transport";

const { createIsolatedWorkerEnvironment } = createRequire(import.meta.url)(
  "../scripts/backend-worker-smoke-environment.cjs",
) as { createIsolatedWorkerEnvironment(root: string): NodeJS.ProcessEnv };
const requireBackend = createRequire(
  new URL("../../../packages/backend/package.json", import.meta.url),
);
const { Client } = requireBackend("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = requireBackend(
  "@modelcontextprotocol/sdk/client/streamableHttp.js",
);
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function runtimeFixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "claude-settings-runtime-")));
  cleanups.push(() =>
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  );
  const project = path.join(root, "project"),
    dataDir = path.join(root, "data"),
    bin = path.join(root, "bin");
  for (const directory of [
    project,
    dataDir,
    bin,
    path.join(root, "tmp"),
    path.join(project, ".claude/commands"),
  ])
    mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(project, "CLAUDE.md"), "Synthetic project instructions.\n");
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
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
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
  const environment = { ...createIsolatedWorkerEnvironment(root), PATH: bin };
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
  const client = new Client({ name: "redaction-runtime-fixture", version: "1" });
  cleanups.push(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp/v1/workspaces/registered/agents/claude-code`),
    ),
  );
  return { root, project, router, client, transport };
}

it("keeps Context, MCP and ordinary Backend requests responsive on large plugin ledgers", async () => {
  const { root, project, router, client, transport } = await runtimeFixture();
  type ContextResult = {
    sections: Array<{ scope: string; source: string; content: string }>;
    warnings: string[];
  };
  const pluginRoot = path.join(root, ".claude/plugins");
  const live = path.join(pluginRoot, "cache/m/live/1");
  const blocked = path.join(pluginRoot, "cache/m/blocked/1");
  mkdirSync(path.join(live, "commands"), { recursive: true });
  mkdirSync(path.join(blocked, "commands"), { recursive: true });
  writeFileSync(path.join(live, "commands/public.md"), "Public plugin command.\n");
  writeFileSync(
    path.join(blocked, "commands/private.md"),
    "---\ndescription: PRIVATE-PLUGIN-DESCRIPTION\n---\nPRIVATE-PLUGIN-COMMAND-BODY\n",
  );
  writeFileSync(
    path.join(blocked, ".mcp.json"),
    JSON.stringify({ mcpServers: { private_server: { command: "PRIVATE-PLUGIN-SERVER-BODY" } } }),
  );
  const pluginId = (index: number) => `p${index.toString(36).padStart(4, "0")}@m`;
  const switches = {
    "blocked@m": true,
    "live@m": true,
    ...Object.fromEntries(Array.from({ length: 16_000 }, (_, index) => [pluginId(index), true])),
  };
  const records = {
    ...Object.fromEntries(
      Array.from({ length: 65_000 }, (_, index) => [pluginId(index + 16_000), []]),
    ),
    "blocked@m": [{ scope: "user", installPath: blocked, version: "1" }],
    "live@m": [{ scope: "user", installPath: live, version: "1" }],
  };
  const settings = JSON.stringify({ enabledPlugins: switches });
  const ledger = JSON.stringify({ version: 2, plugins: records });
  // Exercise the full Cartesian-size regression while remaining inside real read budgets.
  expect(Buffer.byteLength(settings)).toBeLessThan(256 * 1024);
  expect(Buffer.byteLength(ledger)).toBeLessThan(1024 * 1024);
  writeFileSync(path.join(root, ".claude/settings.json"), settings);
  writeFileSync(path.join(pluginRoot, "installed_plugins.json"), ledger);
  writeFileSync(
    path.join(project, ".claude/settings.json"),
    JSON.stringify({ enabledPlugins: { "blocked@m": false } }),
  );
  for (const surface of ["Context", "MCP"] as const) {
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const request: Promise<ContextResult> =
        surface === "Context"
          ? router.request<ContextResult>(RUNTIME_METHODS.resolveContext, {
              project,
              cwd: project,
              agent: "claude-code",
            })
          : client
              .callTool({ name: "workspace_get_context", arguments: { cwd: project } })
              .then((result: { structuredContent?: unknown }) => {
                expect(result.structuredContent).toBeDefined();
                return result.structuredContent as ContextResult;
              });
      // This timer runs outside the Backend, so synchronous membership scans cannot delay it.
      const [result, workspaces] = await Promise.race([
        Promise.all([request, router.request(RUNTIME_METHODS.listWorkspaces, {})]),
        new Promise<never>((_, reject) => {
          watchdog = setTimeout(() => {
            transport?.forceKill();
            reject(
              new Error(
                `${surface}: large plugin ledgers blocked Backend requests for over 1 second`,
              ),
            );
          }, 1_000);
        }),
      ]);
      expect(JSON.stringify(workspaces)).toContain("registered");
      const output = JSON.stringify(result);
      expect(output).not.toContain("PRIVATE-PLUGIN");
      expect(output).not.toContain("private_server");
      expect(output).not.toContain(pluginId(16_000));
      if (surface === "Context") {
        const plugins = result.sections.find(
          (section) => section.source === "Claude Code plugins",
        )?.content;
        expect(plugins).toContain("- live@m 1: enabled (user settings); 1 command");
        expect(plugins).toContain("commands: public");
        expect(plugins).toContain("- p0000@m: enabled (user settings), not installed");
        expect(plugins).toContain("Installed, not enabled: blocked@m");
        expect(plugins).not.toContain("- blocked@m");
      } else {
        expect(output).toContain(
          "Claude Code plugins: 64 plugins enabled, 2 installed, providing 1 command",
        );
        expect(output).not.toContain("commands: public");
      }
    } finally {
      clearTimeout(watchdog);
    }
  }
}, 15_000);

it("keeps Context, MCP and ordinary Backend requests responsive on long redaction near-matches", async () => {
  const { project, router, client, transport } = await runtimeFixture();
  type ContextResult = { sections: Array<{ scope: string; source: string; content: string }> };
  const cases = [
    ["hyphens", `echo ${"-".repeat(50_000)}`],
    ["assignment name", `echo ${"token".repeat(10_000)}!`],
    ["scheme near-match", `echo ${"a-".repeat(25_000)}`],
    ["query near-match", `echo https://example.test/?${"key".repeat(16_667)}!`],
    [
      "nested query near-match",
      `echo https://example.test?redirect=https://foo.test/?${"key".repeat(16_667)}!`,
    ],
    ["ordinary query prefixes", `echo https://example.test/?${"page=2?".repeat(8_334)}`],
    ["marker run", `echo ${"\ue000".repeat(50_000)}`],
    ["quoted argument", `curl -H '${"-H ordinary ".repeat(4_200)}' https://example.test`],
    [
      "full credential",
      `run --token 'long-canary-head${"a".repeat(50_000)}long-canary-tail' --format json`,
    ],
    [
      "nested full credential",
      `echo https://example.test?redirect=https://foo.test/?auth[secret]=long-canary-head${"a".repeat(50_000)}long-canary-tail&plain=visible`,
    ],
  ] as const;
  for (const [label, command] of cases) {
    writeFileSync(
      path.join(project, ".claude/commands/check.md"),
      `---\ndescription: ${JSON.stringify(command)}\n---\nPublic command body.\n`,
    );
    for (const surface of ["Context", "MCP"] as const) {
      writeFileSync(
        path.join(project, ".claude/settings.json"),
        JSON.stringify(
          surface === "Context"
            ? { statusLine: { type: "command", command } }
            : { hooks: { PreToolUse: [{ hooks: [{ type: "command", command }] }] } },
        ),
      );
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      try {
        // Parsing happens only in the child Backend. This independent watchdog kills it if a
        // synchronous regression blocks either the sensitive request or an ordinary request.
        const request =
          surface === "Context"
            ? router.request<ContextResult>(RUNTIME_METHODS.resolveContext, {
                project,
                cwd: project,
                agent: "claude-code",
              })
            : client.callTool({ name: "workspace_get_context", arguments: { cwd: project } });
        const [result] = await Promise.race([
          Promise.all([request, router.request(RUNTIME_METHODS.listWorkspaces, {})]),
          new Promise<never>((_, reject) => {
            watchdog = setTimeout(() => {
              transport?.forceKill();
              reject(new Error(`${surface}: ${label} blocked Backend requests for over 1 second`));
            }, 1_000);
          }),
        ]);
        const output = JSON.stringify(result);
        expect(output).toContain("Claude Code commands");
        expect(output).toContain(surface === "Context" ? "statusLine: command" : "hooks: 1 hook");
        if (label.endsWith("full credential")) {
          expect(output).not.toContain("long-canary");
          if (surface === "Context")
            expect(output).toContain(
              label === "full credential"
                ? "--token [REDACTED] --format json"
                : "auth[secret]=[REDACTED]&plain=visible",
            );
        }
      } finally {
        clearTimeout(watchdog);
      }
    }
  }
}, 15_000);

it("keeps Context, MCP and ordinary Backend requests responsive on expensive exclusion patterns", async () => {
  const { project, router, client, transport } = await runtimeFixture();
  type ContextResult = {
    sections: Array<{ scope: string; source: string; content: string }>;
    warnings: string[];
  };
  const warning = "claudeMdExcludes could not be fully evaluated within the matching budget";
  const originalAttack = `**/${"!(".repeat(10)}x${")".repeat(10)}`;
  const tooManyAlternatives = `**/{${Array.from({ length: 129 }, (_, i) => `x${i}`).join(",")}}`;
  mkdirSync(path.join(project, ".claude/rules"), { recursive: true });
  writeFileSync(path.join(project, ".claude/rules/keep.md"), "RETAINED-RUNTIME-RULE\n");
  writeFileSync(path.join(project, ".claude/rules/skip.md"), "EXCLUDED-RUNTIME-RULE\n");
  writeFileSync(path.join(project, "AGENTS.md"), "INCORRECT-RUNTIME-FALLBACK\n");
  for (const [label, patterns] of [
    ["original nested negation", [originalAttack]],
    ["exhausted budget", [tooManyAlternatives, "**/*.md"]],
    ["long matching exclusion", [`**/${"*".repeat(1_024)}skip.md`]],
    ["long work budget", [`**/${"q".repeat(180_000)}.md`, "**/*.md"]],
    ["next ordinary request", ["**/skip.md"]],
  ] as const) {
    writeFileSync(
      path.join(project, ".claude/settings.json"),
      JSON.stringify({ claudeMdExcludes: patterns }),
    );
    for (const surface of ["Context", "MCP"] as const) {
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      try {
        const request: Promise<ContextResult> =
          surface === "Context"
            ? router.request<ContextResult>(RUNTIME_METHODS.resolveContext, {
                project,
                cwd: project,
                agent: "claude-code",
              })
            : client
                .callTool({ name: "workspace_get_context", arguments: { cwd: project } })
                .then((result: { structuredContent?: unknown }) => {
                  expect(result.structuredContent).toBeDefined();
                  return result.structuredContent as ContextResult;
                });
        // A parent-process timer still runs when glob evaluation blocks the child event loop.
        const [result, workspaces] = await Promise.race([
          Promise.all([request, router.request(RUNTIME_METHODS.listWorkspaces, {})]),
          new Promise<never>((_, reject) => {
            watchdog = setTimeout(() => {
              transport?.forceKill();
              reject(new Error(`${surface}: ${label} blocked Backend requests for over 1 second`));
            }, 1_000);
          }),
        ]);
        expect(JSON.stringify(workspaces)).toContain("registered");
        const bodies = result.sections
          .filter((section) => section.scope !== "settings")
          .map((section) => section.content);
        expect(bodies).toContain("Synthetic project instructions.\n");
        expect(bodies).toContain("RETAINED-RUNTIME-RULE\n");
        expect(bodies).not.toContain("INCORRECT-RUNTIME-FALLBACK\n");
        const warnings = result.warnings.filter((message) => message.includes(warning));
        if (label === "exhausted budget" || label === "long work budget") {
          expect(warnings).toHaveLength(1);
          expect(bodies).toContain("EXCLUDED-RUNTIME-RULE\n");
        } else if (label === "next ordinary request" || label === "long matching exclusion") {
          expect(warnings).toEqual([]);
          expect(bodies).not.toContain("EXCLUDED-RUNTIME-RULE\n");
        } else {
          // Ten complements cannot match these names. Exact completion and an explicit
          // conservative budget fallback both retain them, without silently misclassifying.
          expect(warnings.length).toBeLessThanOrEqual(1);
          expect(bodies).toContain("EXCLUDED-RUNTIME-RULE\n");
        }
      } finally {
        clearTimeout(watchdog);
      }
    }
  }
}, 15_000);
