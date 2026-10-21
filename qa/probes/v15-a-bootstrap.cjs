// Test-only boundary around the complete production app. Production files stay
// unchanged. Network/account status payloads are synthetic; their security and
// pairing flows are intentionally outside this visual check.
const { app, ipcMain, session, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const config = JSON.parse(fs.readFileSync(process.env.AGENTKIB_V15_A_FIXTURE, "utf8"));
if (config.owner !== "agentkib-v15-a-sandbox") throw new Error("Missing owned QA sandbox");
const lifecycleFile = path.join(config.root, "lifecycle.jsonl");
const lifecycle = (event, details = {}) =>
  fs.appendFileSync(
    lifecycleFile,
    `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...details })}\n`,
    { mode: 0o600 },
  );
lifecycle("bootstrap");
process.on("exit", (code) => lifecycle("process-exit", { code }));
process.on("uncaughtExceptionMonitor", (error) =>
  lifecycle("uncaught-exception", { name: error?.name, message: error?.message }),
);
app.on("before-quit", () => lifecycle("before-quit"));
app.on("will-quit", () => lifecycle("will-quit"));
app.on("quit", (_event, exitCode) => lifecycle("quit", { exitCode }));
app.on("child-process-gone", (_event, details) =>
  lifecycle("child-process-gone", {
    type: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
  }),
);
app.on("browser-window-created", (_event, window) => {
  window.on("closed", () => lifecycle("window-closed"));
  window.webContents.on("render-process-gone", (_rendererEvent, details) =>
    lifecycle("renderer-gone", { reason: details.reason, exitCode: details.exitCode }),
  );
});
for (const name of [
  "HOME",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "AGENTKIB_BENCHMARK_DATA_DIR",
  "AGENTKIB_BENCHMARK_USER_DATA",
]) {
  if (
    !process.env[name] ||
    !path.resolve(process.env[name]).startsWith(`${config.root}${path.sep}`)
  )
    throw new Error(`Unsafe QA root: ${name}`);
}
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) =>
  originalHandle(channel, async (event, ...args) => {
    if (channel === "agentkib:account:request") {
      if (args[0]?.operation !== "status")
        throw new Error("QA sandbox does not perform account actions");
      return { phase: "signed-out", secureStorage: true };
    }
    if (
      [
        "agentkib:shell:open-external",
        "agentkib:shell:open-directory",
        "agentkib:shell:open-files-and-folders-settings",
      ].includes(channel)
    )
      throw new Error("QA sandbox blocks external UI actions");
    if (channel === "agentkib:remote:request") {
      if (!["status", "discover"].includes(args[0]?.operation))
        throw new Error("QA sandbox does not pair or share computers");
      return {
        local: { id: "example-computer", name: "Example Computer", enabled: false, address: null },
        interfaces: [{ name: "Example Wi-Fi", address: "192.0.2.10" }],
        discovered: [],
        pending: [],
        authorized: [],
        connections: [],
        pairing_code: null,
        pairing_expires_at: null,
      };
    }
    if (
      channel === "agentkib:web:request" &&
      !["status", "generate-code"].includes(args[0]?.operation)
    )
      throw new Error("QA sandbox blocks remote configuration mutations");
    const result = await handler(event, ...args);
    if (channel === "agentkib:web:request" && result && typeof result === "object") {
      return {
        ...result,
        addresses: [{ name: "Example Wi-Fi", address: "192.0.2.10" }],
        localUrl: `http://127.0.0.1:${config.webPort}`,
        connectionUrl: undefined,
      };
    }
    return result;
  });
shell.openExternal = async () => {
  throw new Error("QA sandbox blocks external navigation");
};
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    let allowed = false;
    try {
      const url = new URL(details.url);
      allowed =
        ["app:", "file:", "data:", "devtools:"].includes(url.protocol) ||
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    } catch {}
    callback({ cancel: !allowed });
  });
});
require(path.join(config.repository, "apps/desktop/dist-electron/main.cjs"));
