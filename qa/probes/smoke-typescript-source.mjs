import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

// No model requests. --app selects an explicit macOS candidate; omission tests only local sources.
assert.equal(process.platform, "darwin", "This local acceptance helper currently requires macOS");
const desktop = fileURLToPath(new URL("../../apps/desktop", import.meta.url));
const desktopRequire = createRequire(path.join(desktop, "package.json"));
const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  assert.ok(
    ["--output", "--app", "--node", "--mode"].includes(key) && process.argv[index + 1],
    "Expected --output FILE, --app CANDIDATE.app, --node NODE_BINARY or --mode backend",
  );
  options[key.slice(2)] =
    key === "--mode" ? process.argv[index + 1] : path.resolve(process.argv[index + 1]);
}
assert.ok(
  options.mode === undefined || options.mode === "backend",
  "Only --mode backend is supported",
);
const backendOnly = options.mode === "backend";
const output = options.output;
const bundle = options.app;
const node = options.node ?? process.execPath;
const scratch = await mkdtemp(path.join(tmpdir(), "agentkib-source-smoke-"));
const dataDir = path.join(scratch, "runtime");
const profile = path.join(scratch, "electron");
const workspace = path.join(scratch, "synthetic-workspace");
const dist = bundle ? path.join(scratch, "candidate-backend") : path.join(desktop, "dist-electron");
const application = bundle
  ? path.join(bundle, "Contents/MacOS/AgentKib")
  : desktopRequire("electron");
const children = new Set();
let phase = "prepare-isolated-fixture";
const scope = `${bundle ? "explicit-candidate" : "source-build"}-${backendOnly ? "backend" : "electron"}-smoke`;
const environment = {
  PATH: `${path.dirname(node)}${path.delimiter}/usr/bin${path.delimiter}/bin`,
  HOME: scratch,
  USERPROFILE: scratch,
  TMPDIR: tmpdir(),
  LANG: "en_US.UTF-8",
  ELECTRON_ENABLE_LOGGING: "1",
  AGENTKIB_HOME: path.join(scratch, "library"),
  CODEX_HOME: path.join(scratch, ".codex"),
  CLAUDE_CONFIG_DIR: path.join(scratch, ".claude"),
  XDG_CONFIG_HOME: path.join(scratch, ".config"),
  XDG_DATA_HOME: path.join(scratch, ".local/share"),
  AGENTKIB_BENCHMARK_DATA_DIR: dataDir,
  AGENTKIB_BENCHMARK_USER_DATA: profile,
};

async function stopOwned(child) {
  if (!children.has(child)) return;
  if (!child.pid) {
    children.delete(child);
    return;
  }
  // A CLI may detach into a second group. Capture the owned subtree before stopping its parent.
  const processes = () =>
    execFileSync("/bin/ps", ["-axo", "pid=,ppid=,lstart="], { encoding: "utf8" })
      .split("\n")
      .flatMap((line) => {
        const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
        return match
          ? [{ pid: Number(match[1]), parent: Number(match[2]), started: match[3].trim() }]
          : [];
      });
  const descendants = new Map();
  const capture = () => {
    const rows = processes();
    const known = new Set([child.pid, ...descendants.keys()]);
    for (let changed = true; changed;) {
      changed = false;
      for (const row of rows)
        if (known.has(row.parent) && !known.has(row.pid)) {
          known.add(row.pid);
          descendants.set(row.pid, row.started);
          changed = true;
        }
    }
    return rows.filter((row) => descendants.get(row.pid) === row.started);
  };
  capture();
  const groupAlive = () => {
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      throw error;
    }
  };
  const alive = () => groupAlive() || capture().length > 0;
  const signal = (value) => {
    const rows = capture();
    try {
      process.kill(-child.pid, value);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    for (const row of rows) {
      try {
        process.kill(row.pid, value);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  };
  const wait = async () => {
    const until = Date.now() + 2000;
    while (alive() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25));
    return !alive();
  };
  if (alive()) {
    signal("SIGTERM");
    if (!(await wait())) {
      signal("SIGKILL");
      if (!(await wait()))
        throw new Error(
          `Owned process group ${child.pid} has not exited; scratch retained at ${scratch}`,
        );
    }
  }
  children.delete(child);
}

async function cleanupOwned() {
  const cleanup = await Promise.allSettled([...children].map(stopOwned));
  const failure = cleanup.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
  await rm(scratch, { recursive: true, force: true });
}

function exited(child, label, milliseconds = 45_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out`));
    }, milliseconds);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${label} exited ${code}`));
    });
  });
}

async function inspectBackend() {
  const child = spawn(node, [path.join(dist, "backend.cjs")], {
    cwd: workspace,
    env: environment,
    detached: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  children.add(child);
  const completion = exited(child, "Read-only backend inspection");
  void completion.catch(() => undefined);
  const pending = new Map();
  let sequence = 0;
  let transportFailure;
  const failed = (error) => {
    transportFailure = error;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  };
  child.once("error", failed);
  child.once("exit", () => failed(new Error("Backend exited before a pending response")));
  child.stdin.on("error", failed);
  createInterface({ input: child.stdout }).on("line", (line) => {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      failed(new Error("Backend emitted malformed JSON"));
      return;
    }
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
      failed(new Error("Backend emitted an invalid RPC frame"));
      return;
    }
    const waiter = pending.get(frame.id);
    if (!waiter) return;
    pending.delete(frame.id);
    clearTimeout(waiter.timer);
    if (frame.error) waiter.reject(new Error(JSON.stringify(frame.error)));
    else waiter.resolve(frame.result);
  });
  const rpc = (method, params = {}) =>
    new Promise((resolve, reject) => {
      if (transportFailure) {
        reject(transportFailure);
        return;
      }
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 15_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  try {
    await rpc("backend.initialize", { dataDir });
    const workspaces = await rpc("workspaces.list");
    await rpc("agentkib.shutdown");
    await completion;
    return workspaces;
  } finally {
    for (const waiter of pending.values()) clearTimeout(waiter.timer);
    await stopOwned(child);
  }
}

try {
  if (bundle) {
    assert.equal(process.platform, "darwin", "--app currently accepts macOS candidates only");
    const builderRequire = createRequire(desktopRequire.resolve("electron-builder"));
    const asar = builderRequire("@electron/asar");
    const archive = path.join(bundle, "Contents/Resources/app.asar");
    await mkdir(dist);
    for (const name of asar.listPackage(archive)) {
      if (/^\/dist-electron\/backend[^/]*\.cjs$/.test(name))
        await writeFile(
          path.join(dist, path.basename(name)),
          asar.extractFile(archive, name.slice(1)),
        );
    }
    await writeFile(
      path.join(dist, "main.cjs"),
      asar.extractFile(archive, "dist-electron/main.cjs"),
    );
    const native = path.join(bundle, "Contents/Resources/app.asar.unpacked/dist-electron/native");
    try {
      await cp(native, path.join(dist, "native"), { recursive: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  await Promise.all(
    [dataDir, profile, workspace].map((value) => mkdir(value, { recursive: true })),
  );
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  await writeFile(
    path.join(dataDir, "preferences.json"),
    JSON.stringify({
      session_index_enabled: false,
      local_auto_refresh_enabled: false,
      quota_auto_refresh_enabled: false,
      mcp_network: { port, lan_enabled: false, lan_risk_accepted: false },
    }),
  );
  await inspectBackend();
  const databasePath = path.join(dataDir, "agentkib.db");
  const seed = new DatabaseSync(databasePath);
  try {
    // Reproduce the prior shared schema-15 shape, without importing any personal database.
    seed.exec(
      "DROP TABLE conversation_collection_sessions; DROP TABLE conversation_collection_status;",
    );
    seed.prepare("DELETE FROM schema_meta WHERE key='codex_session_classification_revision'").run();
    seed
      .prepare(
        "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES (?,?,?,'healthy',?)",
      )
      .run("legacy-synthetic", workspace, "Synthetic legacy workspace", "2026-10-01T00:00:00Z");
    seed
      .prepare(
        "INSERT INTO memories(id,project_id,memory_type,content,status,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run(
        "retained-memory",
        "legacy-synthetic",
        "decision",
        "Keep the audit ledger append-only.",
        "approved",
        "2026-10-01T00:00:00Z",
      );
    seed.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    seed.close();
  }
  const original = path.join(scratch, "synthetic-schema15-original.db");
  await copyFile(databasePath, original);
  const originalSha256 = createHash("sha256")
    .update(await readFile(original))
    .digest("hex");
  const startups = [];
  for (const attempt of [1, 2]) {
    phase = `${backendOnly ? "backend-reopen" : "electron-startup"}-${attempt}`;
    const timeline = path.join(scratch, `startup-${attempt}.json`);
    if (!backendOnly) {
      const child = spawn(application, bundle ? [] : [desktop], {
        cwd: workspace,
        env: {
          ...environment,
          AGENTKIB_STARTUP_BENCHMARK_FILE: timeline,
          AGENTKIB_BENCHMARK_EXIT_AFTER_READY: "1",
        },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.add(child);
      let errors = "";
      child.stderr.on("data", (chunk) => {
        errors = (errors + String(chunk)).slice(-3000);
      });
      child.stdout.on("data", (chunk) => {
        errors = (errors + String(chunk)).slice(-3000);
      });
      try {
        await exited(child, `Electron startup ${attempt}`);
      } catch (error) {
        throw new Error(`${error.message}: ${errors}`);
      } finally {
        await stopOwned(child);
      }
      const startup = JSON.parse(await readFile(timeline, "utf8"));
      for (const name of ["runtime-handshake", "window-shown", "home-data-ready"])
        assert.ok(
          startup.marks.some((mark) => mark.name === name),
          `Missing ${name}`,
        );
      startups.push(startup);
    }
    const workspaces = await inspectBackend();
    assert.ok(
      workspaces.some((value) => value.id === "legacy-synthetic" && value.path === workspace),
    );
    const verified = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(
        verified.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get().value,
        "15",
      );
      assert.equal(
        verified.prepare("SELECT content FROM memories WHERE id='retained-memory'").get().content,
        "Keep the audit ledger append-only.",
      );
    } finally {
      verified.close();
    }
  }
  assert.equal(
    createHash("sha256")
      .update(await readFile(original))
      .digest("hex"),
    originalSha256,
  );
  const artifacts = {};
  for (const name of ["main.cjs", "backend.cjs", "backend-skills.cjs", "backend-handoff-read.cjs"])
    artifacts[name] = createHash("sha256")
      .update(await readFile(path.join(dist, name)))
      .digest("hex");
  const report = {
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    scope,
    status: "passed",
    candidate: bundle ?? null,
    applicationSha256: createHash("sha256")
      .update(await readFile(application))
      .digest("hex"),
    nodeSha256: createHash("sha256")
      .update(await readFile(node))
      .digest("hex"),
    artifacts,
    syntheticSharedSchema15: true,
    originalSha256,
    sourceUnchanged: true,
    workspaceAndMemoryPreserved: true,
    isolatedHomeAndData: true,
    modelRequests: 0,
    nativeAgentAcceptance: false,
    packagedStartupAcceptance: Boolean(bundle) && !backendOnly,
    completePackagedAppAcceptance: false,
    startups,
  };
  if (output) await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(
    backendOnly
      ? `PASS ${bundle ? "candidate" : "source"} backend: two isolated reopens preserve synthetic shared schema-15 workspace/memory; no GUI or native model acceptance claimed`
      : `PASS ${bundle ? "candidate" : "source"} Electron app: two isolated starts, backend handshake, visible home ready, shared schema-15 workspace/memory preserved; no native model acceptance claimed`,
  );
} catch (error) {
  if (output)
    await writeFile(
      output,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          measuredAt: new Date().toISOString(),
          scope,
          status: "failed",
          phase,
          candidate: bundle ?? null,
          detail: String(error),
          modelRequests: 0,
          nativeAgentAcceptance: false,
          completePackagedAppAcceptance: false,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  throw error;
} finally {
  await cleanupOwned();
}
