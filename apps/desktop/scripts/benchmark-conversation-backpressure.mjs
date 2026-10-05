import { spawn } from "node:child_process";
import { builtinModules } from "node:module";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { build, createLogger } from "vite";

// Unlike benchmark-conversation, this exercises synthetic IPC backpressure only.
// No Runtime, native agent, account, task, or network listener is started.
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(path.join(os.tmpdir(), "agentkib-conversation-backpressure-"));
console.info(`Conversation backpressure artifacts: ${scratch}`);
await mkdir(path.join(scratch, "electron"));
await writeFile(
  path.join(scratch, "renderer.html"),
  '<!doctype html><meta charset="utf-8"><title>Isolated conversation backpressure</title>',
);
const messages = [];
const logger = createLogger("warn");
logger.warn = (message) => messages.push(message);
logger.warnOnce = logger.warn;
const external = ["electron", ...builtinModules, ...builtinModules.map((name) => `node:${name}`)];
for (const [entry, name] of [
  ["electron/fixtures/conversation-backpressure.ts", "main.cjs"],
  ["electron/preload/index.ts", "preload.cjs"],
]) {
  await build({
    configFile: false,
    customLogger: logger,
    root: desktop,
    logLevel: "warn",
    build: {
      target: "node22",
      outDir: path.join(scratch, "bundle"),
      emptyOutDir: false,
      minify: false,
      lib: { entry: path.join(desktop, entry), formats: ["cjs"], fileName: () => name },
      rollupOptions: { external },
    },
  });
}
await writeFile(path.join(scratch, "build.log"), messages.join("\n\n"));
const environment = { ...process.env, AGENTKIB_CONVERSATION_BACKPRESSURE: scratch };
delete environment.ELECTRON_RUN_AS_NODE;
await new Promise((resolve, reject) => {
  const child = spawn(electron, [path.join(scratch, "bundle/main.cjs")], {
    cwd: desktop,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const timeout = setTimeout(() => child.kill("SIGTERM"), 60_000);
  child.once("error", (error) => {
    clearTimeout(timeout);
    reject(error);
  });
  child.once("exit", async (code, signal) => {
    clearTimeout(timeout);
    await writeFile(path.join(scratch, "electron.log"), output);
    if (code === 0) resolve();
    else
      reject(
        new Error(
          `Electron backpressure acceptance failed (${code ?? signal}); ${path.join(scratch, "electron.log")}\n${output.slice(-5000)}`,
        ),
      );
  });
});
const report = JSON.parse(await readFile(path.join(scratch, "report.json"), "utf8"));
console.info(JSON.stringify({ ...report, report: path.join(scratch, "report.json") }, null, 2));
if (!report.passed) throw new Error(`Backpressure acceptance failed: ${scratch}`);
