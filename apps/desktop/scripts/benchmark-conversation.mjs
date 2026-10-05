import { spawn } from "node:child_process";
import { builtinModules } from "node:module";
import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { build, createLogger } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// This fixture only launches the opt-in native mock in newly created directories.
// It intentionally leaves its report and diagnostic logs in the printed temp path.
if (process.platform !== "darwin") throw new Error("Codex managed benchmark requires macOS");
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repository = path.resolve(desktop, "../..");
const scratch = await mkdtemp(path.join(os.tmpdir(), "agentkib-conversation-benchmark-"));
console.info(`Conversation benchmark artifacts: ${scratch}`);
const buildMessages = [];
const logger = createLogger("warn");
logger.warn = (message) => {
  buildMessages.push(message);
};
logger.warnOnce = logger.warn;
for (const name of ["bin", "codex", "claude", "runtime", "electron", "workspace"])
  await mkdir(path.join(scratch, name));
const mock = path.join(scratch, "bin", "codex-mock.py");
await copyFile(path.join(repository, "crates/agentkib-runtime/tests/fixtures/codex_mock.py"), mock);
await writeFile(path.join(scratch, "codex", "allow-stream-benchmark"), "isolated fixture\n");
await writeFile(
  path.join(scratch, "bin", "codex"),
  '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "%s\\n" "codex-cli 0.155.1"; exit 0; fi\nexec /usr/bin/python3 "$(dirname "$0")/codex-mock.py" "$@"\n',
);
await chmod(path.join(scratch, "bin", "codex"), 0o700);

function run(executable, args, options, log) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const deadline = setTimeout(() => child.kill("SIGTERM"), 120_000);
    child.once("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once("exit", async (code, signal) => {
      clearTimeout(deadline);
      await writeFile(path.join(scratch, log), output);
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `${path.basename(executable)} failed (${code ?? signal}); ${path.join(scratch, log)}\n${output.slice(-5000)}`,
          ),
        );
    });
  });
}

await run(
  "cargo",
  ["build", "-p", "agentkib-runtime", "--features", "dev-app"],
  { cwd: repository },
  "build-runtime.log",
);
const external = ["electron", ...builtinModules, ...builtinModules.map((name) => `node:${name}`)];
for (const [entry, name] of [
  ["electron/fixtures/conversation-benchmark.ts", "main.cjs"],
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
await build({
  configFile: false,
  customLogger: logger,
  root: desktop,
  base: "./",
  logLevel: "warn",
  plugins: [react({ compiler: true }), tailwindcss()],
  resolve: { alias: { "@": path.join(desktop, "src") } },
  build: {
    target: "es2022",
    outDir: path.join(scratch, "renderer"),
    rollupOptions: {
      input: path.join(desktop, "scripts/fixtures/conversation-benchmark/index.html"),
    },
  },
});
await writeFile(path.join(scratch, "build-web.log"), buildMessages.join("\n\n"));
if (buildMessages.length) console.info(`Build diagnostics: ${path.join(scratch, "build-web.log")}`);
const environment = {
  ...process.env,
  PATH: `${path.join(scratch, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
  AGENTKIB_CONVERSATION_BENCHMARK: scratch,
  AGENTKIB_RUNTIME_PATH: path.join(repository, "target/debug/agentkib-runtime"),
  AGENTKIB_BENCHMARK_DATA_DIR: path.join(scratch, "runtime"),
  AGENTKIB_APP_FLAVOR: "ai.agentkib.dev",
  CODEX_HOME: path.join(scratch, "codex"),
  CLAUDE_CONFIG_DIR: path.join(scratch, "claude"),
};
delete environment.ELECTRON_RUN_AS_NODE;
await run(
  electron,
  [path.join(scratch, "bundle/main.cjs")],
  { cwd: desktop, env: environment },
  "electron.log",
);
const report = JSON.parse(await readFile(path.join(scratch, "report.json"), "utf8"));
const { samples: _samples, ...summary } = report;
console.info(JSON.stringify({ ...summary, report: path.join(scratch, "report.json") }, null, 2));
if (!report.passed)
  throw new Error(`Conversation benchmark failed: ${path.join(scratch, "report.json")}`);
