import { spawn, execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

// Local, ad-hoc macOS bundle smoke. No public broker or model is contacted.
const bundle = path.resolve(process.argv[2] ?? "apps/desktop/release-electron/mac-arm64/AgentKib.app");
const output = process.argv[3] && path.resolve(process.argv[3]);
const resources = path.join(bundle, "Contents/Resources");
const scratch = await mkdtemp(path.join(tmpdir(), "agentkib-package-smoke-"));
const children = new Set();
try {
  const profile = path.join(scratch, "electron");
  const data = path.join(scratch, "runtime");
  await mkdir(profile); await mkdir(data);
  const portServer = createServer();
  await new Promise((resolve) => portServer.listen(0, "127.0.0.1", resolve));
  const port = portServer.address().port;
  await new Promise((resolve) => portServer.close(resolve));
  await writeFile(path.join(data, "preferences.json"), JSON.stringify({ mcp_network: { port, lan_enabled: false, lan_risk_accepted: false } }));
  const environment = { ...process.env, AGENTKIB_BENCHMARK_DATA_DIR: data, AGENTKIB_BENCHMARK_USER_DATA: profile };
  delete environment.AGENTKIB_RUNTIME_PATH;
  delete environment.AGENTKIB_DEV;
  await access(path.join(resources, "web/index.html"));
  await access(path.join(resources, "bin/licenses/frp-LICENSE"));
  const manifest = JSON.parse(await readFile(path.join(resources, "bin/frpc-manifest.json"), "utf8"));
  assert.equal(manifest.version, "0.68.0");
  assert.equal(execFileSync(path.join(resources, "bin/frpc"), ["--version"], { encoding: "utf8" }).trim(), manifest.version);
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const runtime = spawn(path.join(resources, "bin/agentkib-runtime"), [], { env: environment, stdio: ["pipe", "pipe", "pipe"] });
  children.add(runtime);
  const csr = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("Bundled CSR RPC timed out")), 15_000);
    runtime.once("error", reject);
    runtime.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Bundled runtime exited before CSR (${code})`)); });
    runtime.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n"); buffer = lines.pop();
      for (const line of lines) {
        const response = JSON.parse(line);
        if (response.id !== 1) continue;
        clearTimeout(timer);
        if (response.error) reject(new Error("Bundled CSR RPC failed"));
        else resolve(response.result);
      }
    });
    runtime.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "relay.createCsr", params: {
      privateKeyDer: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
      hosts: ["smoke.control.remote.agentkib.com", "smoke.preview.remote.agentkib.com"],
    } }) + "\n");
  });
  assert.match(csr.csrPem, /^-----BEGIN CERTIFICATE REQUEST-----/);
  runtime.stdin.end();
  const timeline = path.join(scratch, "startup.json");
  const application = spawn(path.join(bundle, "Contents/MacOS/AgentKib"), [], {
    env: { ...environment, AGENTKIB_STARTUP_BENCHMARK_FILE: timeline, AGENTKIB_BENCHMARK_EXIT_AFTER_READY: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(application);
  const errors = [];
  application.stderr.on("data", (chunk) => { if (errors.length < 40) errors.push(String(chunk)); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Packaged app startup timed out")), 45_000);
    application.once("error", (error) => { clearTimeout(timer); reject(error); });
    application.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Packaged app exited ${code}: ${errors.join("").slice(-1500)}`));
      else resolve();
    });
  });
  const startup = JSON.parse(await readFile(timeline, "utf8"));
  assert.ok(startup.marks.some((mark) => mark.name === "runtime-handshake"));
  assert.ok(startup.marks.some((mark) => mark.name === "home-data-ready"));
  const report = { schemaVersion: 1, measuredAt: new Date().toISOString(), platform: process.platform,
    arch: process.arch, frpcVersion: manifest.version, bundledWeb: true, bundledLicense: true,
    bundledRustCsr: true, isolatedProfile: true, startup, notarized: false };
  if (output) await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write("Bundled frpc, Rust CSR and Web resources verified; packaged app reached home-data-ready and exited.\n");
} finally {
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
  await rm(scratch, { recursive: true, force: true });
}
