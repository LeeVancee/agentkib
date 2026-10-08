// Invoked by run-backend-worker-smoke.mjs; never reads the user's Agent or app data.
const { app, utilityProcess } = require("electron");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { createServer } = require("node:net");
const { createIsolatedWorkerEnvironment } = require("./backend-worker-smoke-environment.cjs");
const root = require("node:fs").mkdtempSync(path.join(os.tmpdir(), "agentkib-worker-smoke-"));
const dist = path.resolve(__dirname, "../dist-electron");
app.setPath("userData", path.join(root, "electron"));
const children = new Set();
const timers = new Set();
function fork(filename, environment) {
  const child = utilityProcess.fork(filename, [], { env: environment, stdio: "pipe" });
  children.add(child);
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  child.once("exit", () => children.delete(child));
  return child;
}
function deadline(operation, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout: ${label}`)), 15000);
    timers.add(timer);
  });
  return Promise.race([operation, timeout]).finally(() => {
    clearTimeout(timer);
    timers.delete(timer);
  });
}
app
  .whenReady()
  .then(async () => {
    app.dock?.hide();
    const dataDir = path.join(root, "data");
    const skill = path.join(root, ".claude/skills/smoke");
    const handoff = path.join(root, ".agentkib/handoffs/smoke.md");
    await fs.mkdir(dataDir);
    await fs.mkdir(skill, { recursive: true });
    await fs.mkdir(path.dirname(handoff), { recursive: true });
    await fs.writeFile(
      path.join(skill, "SKILL.md"),
      "---\nname: smoke\ndescription: Isolated Worker smoke\n---\nFixture text.\n",
    );
    await fs.writeFile(handoff, "Isolated handoff fixture\n");
    const listener = createServer();
    await new Promise((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolve);
    });
    const port = listener.address().port;
    await new Promise((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
    await fs.writeFile(
      path.join(dataDir, "preferences.json"),
      JSON.stringify({
        session_index_enabled: false,
        mcp_network: { port, lan_enabled: false, lan_risk_accepted: false },
      }),
    );
    const environment = createIsolatedWorkerEnvironment(root);
    await fs.mkdir(environment.TMPDIR, { recursive: true });
    const backend = fork(path.join(dist, "backend.cjs"), environment);
    const pending = new Map();
    let sequence = 0;
    backend.on("message", (message) => {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    });
    backend.once("exit", (code) => {
      for (const waiter of pending.values()) waiter.reject(new Error(`Backend exited: ${code}`));
      pending.clear();
    });
    const rpc = (method, params = {}) =>
      deadline(
        new Promise((resolve, reject) => {
          const id = ++sequence;
          pending.set(id, { resolve, reject });
          backend.postMessage({ jsonrpc: "2.0", id, method, params });
        }),
        method,
      );
    await rpc("backend.initialize", { dataDir });
    const inventory = await rpc("skills.inventory");
    assert.ok(
      inventory.observations.every((item) => {
        const relative = path.relative(root, item.path);
        return (
          !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)
        );
      }),
      "Skills worker read a package outside the isolated directory",
    );
    const observation = inventory.observations.find((item) => item.name === "smoke");
    assert.ok(observation, "Skills worker did not read the isolated package");
    const preview = await rpc("skills.prepareImport", { observation_id: observation.id });
    await rpc("skills.applyOperation", { token: preview.token, confirmed: true });
    assert.equal(
      await fs.readFile(path.join(root, "library/skills", preview.library_id, "SKILL.md"), "utf8"),
      await fs.readFile(path.join(skill, "SKILL.md"), "utf8"),
    );
    await rpc("sessions.setIndexEnabled", { enabled: true });
    const searchStatus = await rpc("sessions.setContentSearchEnabled", { enabled: true });
    assert.equal(searchStatus.enabled, true);
    assert.deepEqual((await rpc("sessions.searchContent", { query: "中文正文 /src/main.ts" })).hits, []);
    await rpc("sessions.setContentSearchEnabled", { enabled: false });
    for (const suffix of ["", "-wal", "-shm"])
      assert.equal(require("node:fs").existsSync(path.join(dataDir, "session-search.sqlite" + suffix)), false);
    console.log("PASS Electron utilityProcess -> content index/query Workers: SQLite FTS5, scope, disable and cache removal");
    const exited = new Promise((resolve) => backend.once("exit", resolve));
    await rpc("agentkib.shutdown");
    assert.equal(await deadline(exited, "Backend shutdown"), 0);
    console.log(
      "PASS Electron utilityProcess -> Backend -> persistent Skills Worker: inventory, preview, native file validation, import and shutdown",
    );

    // This utility host exercises the production read-worker entry without opening an Agent CLI.
    const fixture = path.join(root, "read-host.cjs");
    await fs.writeFile(
      fixture,
      `
const { Worker } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const database = new DatabaseSync(':memory:');database.exec('SELECT 1');database.close();
const worker = new Worker(${JSON.stringify(path.join(dist, "backend-handoff-read.cjs"))});
worker.once('error', error => {process.parentPort.postMessage({error:error.message});process.exitCode=1;});
worker.once('message', async message => {process.parentPort.postMessage(message);await worker.terminate();process.exit(0);});
worker.postMessage({kind:'read', id:'smoke', task:{id:'smoke',deadlineAt:Date.now()+10000},operation:'validate-handoff-file',input:[${JSON.stringify(root)},'smoke.md']});
`,
    );
    const host = fork(fixture, environment);
    const hostExited = new Promise((resolve) => host.once("exit", resolve));
    const read = await deadline(
      new Promise((resolve, reject) => {
        host.once("message", resolve);
        host.once("exit", (code) => {
          if (code !== 0) reject(new Error(`Read worker host exited: ${code}`));
        });
      }),
      "Handoff read worker",
    );
    assert.equal(read.error, undefined);
    assert.equal(read.value, await fs.realpath(handoff));
    assert.equal(await deadline(hostExited, "Handoff worker shutdown"), 0);
    console.log(
      `PASS Electron ${process.versions.electron} / Node ${process.versions.node} utilityProcess -> Handoff read Worker: node:sqlite and real handoff path validation (${process.platform}; Windows exercises staged Koffi)`,
    );
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const timer of timers) clearTimeout(timer);
    for (const child of children) child.kill();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    app.exit(process.exitCode || 0);
  });
