import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { runDesktopStartupSmoke } from "./run-desktop-startup-smoke.mjs";

const script = fileURLToPath(new URL("./run-desktop-startup-smoke.mjs", import.meta.url));
const marks = ["runtime-handshake", "window-shown", "home-data-ready"];

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "agentkib-startup-probe-test-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const executable = path.join(directory, "application.mjs");
  const observed = path.join(directory, "observed.json");
  const descendant = path.join(directory, "descendant.json");
  const reportPath = path.join(directory, "report.json");
  await writeFile(
    executable,
    `
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
const [mode, observed, descendant, ...args] = process.argv.slice(2);
const preferences = JSON.parse(readFileSync(process.env.AGENTKIB_BENCHMARK_DATA_DIR + "/preferences.json", "utf8"));
const webAccess = JSON.parse(readFileSync(process.env.AGENTKIB_BENCHMARK_USER_DATA + "/web/web-access.json", "utf8"));
const ports = [createServer(), createServer()];
for (const [index, port] of ports.entries()) {
  await new Promise((resolve, reject) => {
    port.once("error", reject);
    port.listen(index === 0 ? preferences.mcp_network.port : webAccess.config.port, "127.0.0.1", resolve);
  });
}
await Promise.all(ports.map((port) => new Promise((resolve) => port.close(resolve))));
writeFileSync(observed, JSON.stringify({ env: process.env, cwd: process.cwd(), preferences, webAccess, args }));
if (mode === "hang") {
  process.stderr.write("TypeError: WebSocket is not a constructor; startup error window remains open\\n");
  process.on("SIGTERM", () => {});
  spawn(process.execPath, ["--input-type=module", "-e", \`
    import { createServer } from "node:net";
    import { writeFileSync } from "node:fs";
    process.on("SIGTERM", () => {});
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      writeFileSync(process.argv[1], JSON.stringify({ pid: process.pid, port: server.address().port }));
    });
  \`, descendant], { stdio: "inherit" });
  setInterval(() => {}, 1000);
} else {
  if (mode !== "absent") {
    const names = ${JSON.stringify(marks)}.filter((name) => mode !== "missing-" + name);
    const startup = { schemaVersion: mode === "schema" ? 2 : 1,
      marks: names.map((name, index) => ({ name, elapsedMs: mode === "invalid-mark" ? -1 : index })) };
    writeFileSync(process.env.AGENTKIB_STARTUP_BENCHMARK_FILE,
      mode === "malformed" ? "not json" : JSON.stringify(startup));
  }
  process.stdout.write("fixture startup complete\\n");
  if (mode === "nonzero") {
    process.stderr.write("fixture startup failed\\n");
    process.exitCode = 7;
  }
}
`,
  );
  return {
    directory,
    observed,
    descendant,
    reportPath,
    executable,
    run: (mode = "success", options = {}) =>
      runDesktopStartupSmoke({
        executable: process.execPath,
        args: [executable, mode, observed, descendant, "--no-sandbox", "argument with spaces"],
        timeoutMs: 5_000,
        reportPath,
        ...options,
      }),
  };
}

async function assertProfileRemoved(observed) {
  const state = JSON.parse(await readFile(observed, "utf8"));
  await assert.rejects(access(path.dirname(state.env.HOME)), { code: "ENOENT" });
  return state;
}

test("requires successful exit and all readiness marks, saves a report, and forwards arguments", async (t) => {
  const app = await fixture(t);
  const result = await app.run();
  assert.equal(result.success, true);
  assert.deepEqual(result.processExit, { code: 0, signal: null });
  assert.deepEqual(
    result.startup.marks.map((mark) => mark.name),
    marks,
  );
  assert.match(result.stdout, /fixture startup complete/);
  assert.deepEqual(JSON.parse(await readFile(app.reportPath, "utf8")), result);
  const state = await assertProfileRemoved(app.observed);
  assert.deepEqual(state.args, ["--no-sandbox", "argument with spaces"]);
});

test("rejects absent, malformed, unsupported and incomplete readiness reports", async (t) => {
  const app = await fixture(t);
  for (const [mode, expected] of [
    ["absent", /did not write a readable startup report/],
    ["malformed", /did not write a readable startup report/],
    ["schema", /schemaVersion 1/],
    ["invalid-mark", /missing a valid runtime-handshake/],
    ...marks.map((name) => [`missing-${name}`, new RegExp(`missing a valid ${name}`)]),
  ]) {
    await assert.rejects(app.run(mode), expected);
    assert.equal(JSON.parse(await readFile(app.reportPath, "utf8")).success, false);
    await assertProfileRemoved(app.observed);
  }
});

test("rejects nonzero exit even when the readiness report has every mark", async (t) => {
  const app = await fixture(t);
  await assert.rejects(
    app.run("nonzero"),
    /Desktop exited with code 7[\s\S]*fixture startup failed/,
  );
  const report = JSON.parse(await readFile(app.reportPath, "utf8"));
  assert.equal(report.processExit.code, 7);
  await assertProfileRemoved(app.observed);
});

test("isolates homes, runtime data, credentials and overrides while retaining the display session", async (t) => {
  const app = await fixture(t);
  const external = path.join(app.directory, "external-user-data");
  await writeFile(external, "user data must remain unchanged");
  const source = {
    ...process.env,
    HOME: external,
    USERPROFILE: external,
    APPDATA: external,
    LOCALAPPDATA: external,
    XDG_CONFIG_HOME: external,
    XDG_DATA_HOME: external,
    CODEX_HOME: external,
    CLAUDE_CONFIG_DIR: external,
    CURSOR_CONFIG_DIR: external,
    OPENCLAW_STATE_DIR: external,
    AGENTKIB_BENCHMARK_DATA_DIR: external,
    AGENTKIB_BENCHMARK_USER_DATA: external,
    AGENTKIB_STARTUP_BENCHMARK_FILE: external,
    AGENTKIB_DEV: "1",
    VITE_DEV_SERVER_URL: "https://invalid.example",
    ELECTRON_RUN_AS_NODE: "1",
    NODE_OPTIONS: "--require=external-hook.cjs",
    NODE_PATH: external,
    AGENTKIB_QUOTA_SIDECAR: external,
    OPENAI_API_KEY: "synthetic-secret",
    OPENCODE_CONFIG_CONTENT: "external-config",
    UNKNOWN_AGENT_HOME: external,
    DISPLAY: ":99",
    XAUTHORITY: "/synthetic-xauthority",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/synthetic-dbus",
    XDG_RUNTIME_DIR: "/synthetic-runtime",
    GDK_BACKEND: "x11",
  };
  await app.run("success", { environment: source });
  const first = await assertProfileRemoved(app.observed);
  const env = first.env;
  assert.equal(first.cwd, env.HOME);
  assert.equal(env.AGENTKIB_BENCHMARK_EXIT_AFTER_READY, "1");
  assert.equal(env.AGENTKIB_DATA_DIR, env.AGENTKIB_BENCHMARK_DATA_DIR);
  assert.notEqual(env.AGENTKIB_BENCHMARK_USER_DATA, env.AGENTKIB_BENCHMARK_DATA_DIR);
  const root = path.dirname(env.HOME);
  for (const key of [
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "CURSOR_CONFIG_DIR",
    "OPENCLAW_STATE_DIR",
    "AGENTKIB_BENCHMARK_DATA_DIR",
    "AGENTKIB_BENCHMARK_USER_DATA",
    "AGENTKIB_STARTUP_BENCHMARK_FILE",
  ]) {
    const relative = path.relative(root, env[key]);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), key);
  }
  for (const key of [
    "AGENTKIB_DEV",
    "VITE_DEV_SERVER_URL",
    "ELECTRON_RUN_AS_NODE",
    "NODE_OPTIONS",
    "NODE_PATH",
    "AGENTKIB_QUOTA_SIDECAR",
    "OPENAI_API_KEY",
    "OPENCODE_CONFIG_CONTENT",
    "UNKNOWN_AGENT_HOME",
  ]) {
    assert.equal(env[key], undefined, key);
  }
  for (const key of [
    "DISPLAY",
    "XAUTHORITY",
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_RUNTIME_DIR",
    "GDK_BACKEND",
  ]) {
    assert.equal(env[key], source[key]);
  }
  assert.equal(first.preferences.mcp_network.lan_enabled, false);
  assert.equal(first.preferences.mcp_network.lan_risk_accepted, false);
  assert.equal(first.preferences.quota_auto_refresh_enabled, false);
  assert.equal(first.preferences.local_auto_refresh_enabled, false);
  assert.deepEqual(first.webAccess, {
    config: {
      enabled: true,
      port: first.webAccess.config.port,
      externalOrigin: "",
      experimentalEnabled: false,
    },
    credentials: [],
    remotePairingInitialized: false,
  });
  assert.ok(first.webAccess.config.port >= 1024 && first.webAccess.config.port <= 65535);
  assert.notEqual(first.webAccess.config.port, first.preferences.mcp_network.port);
  assert.equal(source.HOME, external);
  assert.equal(await readFile(external, "utf8"), "user data must remain unchanged");
  await app.run("success", { environment: source });
  const second = await assertProfileRemoved(app.observed);
  assert.notEqual(second.env.HOME, env.HOME);
});

test(
  "times out an error window and kills its descendants without killing unrelated processes",
  { timeout: 15_000 },
  async (t) => {
    const app = await fixture(t);
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    t.after(() => unrelated.kill());
    await assert.rejects(
      app.run("hang", { timeoutMs: 2_000 }),
      /timed out[\s\S]*WebSocket is not a constructor/,
    );
    const descendant = JSON.parse(await readFile(app.descendant, "utf8"));
    // A listener remains observable even if an orphan has become a short-lived
    // zombie on Linux. Rebinding proves the descendant released its resources.
    const server = createServer();
    for (let attempt = 0; ; attempt += 1) {
      try {
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(descendant.port, "127.0.0.1", resolve);
        });
        break;
      } catch (error) {
        if (error.code !== "EADDRINUSE" || attempt === 20) throw error;
        await delay(50);
      }
    }
    await new Promise((resolve) => server.close(resolve));
    assert.equal(unrelated.exitCode, null);
    assert.equal(unrelated.signalCode, null);
    await assertProfileRemoved(app.observed);
  },
);

test("CLI reports success or failure through its exit code and supports report output", async (t) => {
  const app = await fixture(t);
  for (const [mode, expectedCode] of [
    ["success", 0],
    ["nonzero", 1],
  ]) {
    const child = spawn(
      process.execPath,
      [script, process.execPath, app.executable, mode, app.observed, app.descendant],
      {
        env: {
          ...process.env,
          AGENTKIB_STARTUP_SMOKE_REPORT: app.reportPath,
          AGENTKIB_STARTUP_SMOKE_TIMEOUT_MS: "5000",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(code, expectedCode, output);
    assert.equal(JSON.parse(await readFile(app.reportPath, "utf8")).success, expectedCode === 0);
  }
});

test("reports executable launch errors without waiting for the startup timeout", async (t) => {
  const app = await fixture(t);
  await assert.rejects(
    app.run("success", { executable: path.join(app.directory, "missing-application") }),
    /ENOENT/,
  );
  assert.equal(JSON.parse(await readFile(app.reportPath, "utf8")).success, false);
});
