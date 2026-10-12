import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createIsolatedWorkerEnvironment } from "../../apps/desktop/scripts/backend-worker-smoke-environment.cjs";

const requiredMarks = ["runtime-handshake", "window-shown", "home-data-ready"];
const defaultTimeoutMs = 75_000;
const logLimit = 16_000;

// Keep the graphical session supplied by xvfb/dbus while the existing worker
// isolation helper removes credentials, agent configuration and injection flags.
const displayVariables = [
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_RUNTIME_DIR",
  "GDK_BACKEND",
];

async function freeLocalPorts() {
  const servers = [createServer(), createServer()];
  try {
    // Reserve both together so MCP and local Web cannot receive the same port.
    for (const server of servers) {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
    }
    const ports = servers.map((server) => server.address().port);
    if (ports.some((port) => port < 1024))
      throw new Error("Local smoke ports must be at least 1024");
    return ports;
  } finally {
    await Promise.all(
      servers
        .filter((server) => server.listening)
        .map(
          (server) =>
            new Promise((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            ),
        ),
    );
  }
}

function validateStartup(startup) {
  if (startup?.schemaVersion !== 1 || !Array.isArray(startup.marks)) {
    throw new Error("Startup report must have schemaVersion 1 and a marks array");
  }
  for (const name of requiredMarks) {
    if (
      !startup.marks.some(
        (mark) => mark?.name === name && Number.isFinite(mark.elapsedMs) && mark.elapsedMs >= 0,
      )
    ) {
      throw new Error(`Startup report is missing a valid ${name} mark`);
    }
  }
}

function waitForExit(child, timeoutMs) {
  let timer;
  let interrupt;
  let terminate;
  return new Promise((resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Desktop startup timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
    interrupt = () => reject(new Error("Desktop startup interrupted by SIGINT"));
    terminate = () => reject(new Error("Desktop startup interrupted by SIGTERM"));
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  }).finally(() => {
    clearTimeout(timer);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  });
}

async function stopProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null) return;
    // /PID targets only this launch; /T also covers Electron utility/renderers.
    await new Promise((resolve, reject) => {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        killer.kill();
        reject(new Error("Timed out cleaning up the desktop process tree"));
      }, 10_000);
      killer.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      killer.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0 || child.exitCode !== null || child.signalCode !== null) resolve();
        else reject(new Error(`taskkill failed with exit code ${code}`));
      });
    });
    return;
  }
  const signalGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      throw error;
    }
  };
  // detached creates an owned process group. Signal it even after the main
  // process exits, since a hung descendant can keep the group alive.
  if (!signalGroup("SIGTERM")) return;
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  signalGroup("SIGKILL");
}

export async function runDesktopStartupSmoke({
  executable,
  args = [],
  timeoutMs = defaultTimeoutMs,
  reportPath,
  environment = process.env,
}) {
  if (!executable)
    throw new Error("Usage: node run-desktop-startup-smoke.mjs <executable> [args...]");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) {
    throw new Error("Startup timeout must be a positive integer no greater than 300000 ms");
  }

  const target = path.resolve(executable);
  const scratch = await realpath(await mkdtemp(path.join(tmpdir(), "agentkib-desktop-startup-")));
  const report = {
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    executable: target,
    isolatedProfile: true,
    localWebEnabled: true,
    timeoutMs,
    success: false,
  };
  let child;
  let failure;
  let stdout = "";
  let stderr = "";
  try {
    const isolatedHome = path.join(scratch, "home");
    const data = path.join(scratch, "data");
    const profile = path.join(scratch, "electron");
    const localWeb = path.join(profile, "web");
    const timeline = path.join(scratch, "startup.json");
    const env = createIsolatedWorkerEnvironment(isolatedHome, environment);
    for (const name of displayVariables) {
      if (environment[name] !== undefined) env[name] = environment[name];
    }
    Object.assign(env, {
      AGENTKIB_DATA_DIR: data,
      AGENTKIB_BENCHMARK_DATA_DIR: data,
      AGENTKIB_BENCHMARK_USER_DATA: profile,
      AGENTKIB_STARTUP_BENCHMARK_FILE: timeline,
      AGENTKIB_BENCHMARK_EXIT_AFTER_READY: "1",
    });
    await Promise.all(
      [
        isolatedHome,
        data,
        profile,
        localWeb,
        env.TMPDIR,
        env.APPDATA,
        env.LOCALAPPDATA,
        env.XDG_CONFIG_HOME,
        env.XDG_DATA_HOME,
        env.XDG_STATE_HOME,
        env.XDG_CACHE_HOME,
      ].map((directory) => mkdir(directory, { recursive: true })),
    );
    const [mcpPort, webPort] = await freeLocalPorts();
    await writeFile(
      path.join(data, "preferences.json"),
      JSON.stringify({
        mcp_network: { port: mcpPort, lan_enabled: false, lan_risk_accepted: false },
        quota_auto_refresh_enabled: false,
        local_auto_refresh_enabled: false,
      }),
    );

    // The WebSocket regression only runs when saved local Web access is enabled.
    // This synthetic profile grants no devices and leaves LAN/relay disabled.
    await writeFile(
      path.join(localWeb, "web-access.json"),
      JSON.stringify({
        config: { enabled: true, port: webPort, externalOrigin: "", experimentalEnabled: false },
        credentials: [],
        remotePairingInitialized: false,
      }),
    );

    child = spawn(target, args, {
      cwd: isolatedHome,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk).slice(-logLimit);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-logLimit);
    });
    report.processExit = await waitForExit(child, timeoutMs);
    if (report.processExit.code !== 0) {
      throw new Error(
        `Desktop exited with ${report.processExit.signal ?? `code ${report.processExit.code}`}`,
      );
    }
    try {
      report.startup = JSON.parse(await readFile(timeline, "utf8"));
    } catch (error) {
      throw new Error(`Desktop did not write a readable startup report: ${error.message}`);
    }
    validateStartup(report.startup);
    report.success = true;
  } catch (error) {
    failure = error;
  } finally {
    try {
      await stopProcessTree(child);
    } catch (error) {
      failure = new Error(
        `${failure ? `${failure.message}; ` : ""}Process cleanup failed: ${error.message}`,
      );
    }
    child?.stdout?.destroy();
    child?.stderr?.destroy();
    try {
      await rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch (error) {
      failure = new Error(
        `${failure ? `${failure.message}; ` : ""}Temporary profile cleanup failed: ${error.message}`,
      );
    }
  }
  report.success = !failure;
  if (failure) report.error = failure.message;
  report.stdout = stdout;
  report.stderr = stderr;
  if (reportPath) {
    await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (failure) {
    throw new Error([failure.message, stdout.trim(), stderr.trim()].filter(Boolean).join("\n"));
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Optional report contains diagnostics on failure as well as the validated
  // startup timeline on success. Arguments after the executable pass unchanged.
  runDesktopStartupSmoke({
    executable: process.argv[2],
    args: process.argv.slice(3),
    timeoutMs: Number(process.env.AGENTKIB_STARTUP_SMOKE_TIMEOUT_MS ?? defaultTimeoutMs),
    reportPath: process.env.AGENTKIB_STARTUP_SMOKE_REPORT,
  })
    .then(() => {
      process.stdout.write(`Desktop startup passed: ${requiredMarks.join(", ")}; exited 0.\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
