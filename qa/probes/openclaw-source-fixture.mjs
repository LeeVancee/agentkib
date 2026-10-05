// Pinned official writer/read-only accessor; only isolated synthetic QA data.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [mode, specPath] = process.argv.slice(2);
if (!["seed", "read"].includes(mode)) throw Error("Expected seed or read");
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
if (JSON.parse(fs.readFileSync(path.join(spec.package, "package.json"))).version !== "2026.9.6")
  throw Error("Unsupported package version");
const state = process.env.OPENCLAW_STATE_DIR;
if (!state || !path.isAbsolute(state) || state !== spec.state) throw Error("Wrong isolated state");
const load = name => import(pathToFileURL(path.join(spec.package, "dist", name)));
const { n: readOnly } = await load("openclaw-agent-db-readonly-IBx2zWDG.mjs");
const { l: readEvents } = await load("session-accessor.sqlite-read-DG0i0-yW.mjs");
const options = { agentId: "main", env: { ...process.env } };
if (mode === "seed") {
  if (!fs.existsSync(process.env.OPENCLAW_CONFIG_PATH)) {
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify({
      gateway: { mode: "local", bind: "loopback", auth: { mode: "none" } },
      agents: { defaults: { workspace: spec.workspace }, entries: { main: { workspace: spec.workspace } } },
      plugins: { enabled: false },
    }));
  }
  const { f: transaction, r: close } = await load("openclaw-agent-db-CaQAStOA.mjs");
  const { f: writeEntry } = await load("session-accessor.sqlite-entry-store-DTntRuil.mjs");
  const { u: replace, m: header } = await load("session-accessor.sqlite-transcript-store-CFksbmAY.mjs");
  const { t: acquireLock } = await load("embedded-state-lock-Cw9nQxv5.mjs");
  const lock = await acquireLock({ options: { env: options.env, allowInTests: true, timeoutMs: 1000 },
    formatActiveGatewayRefusal: () => "Active gateway refuses synthetic seed" });
  try {
    transaction(db => {
      if (db.db.prepare("SELECT 1 FROM session_nodes WHERE session_key=?").get(spec.sessionKey))
        throw Error("Existing source must not be overwritten");
      const timestamp = "2026-09-30T12:00:00.000Z";
      const events = [header({ sessionId: spec.sessionId, cwd: spec.workspace, timestamp }),
        ...spec.messages.map(([role, text], index) => ({ type: "message", id: `m${index}`,
          parentId: index ? `m${index - 1}` : null, timestamp,
          message: { role, content: [{ type: "text", text }], timestamp: 1790769600000 + index } }))];
      writeEntry(db, spec.sessionKey, { sessionId: spec.sessionId, createdAt: 1790769600000,
        updatedAt: 1790769600001, label: spec.title, displayName: spec.title,
        spawnedCwd: spec.workspace, spawnedWorkspaceDir: spec.workspace, createdVia: "cli" });
      replace(db, { ...options, sessionKey: spec.sessionKey, sessionId: spec.sessionId }, events);
      if (JSON.stringify(readEvents(db, spec.sessionId)) !== JSON.stringify(events))
        throw Error("Official writer readback differs");
    }, options);
  } finally {
    await close();
    await lock?.release();
  }
}
const result = readOnly(db => ({ events: readEvents(db, spec.sessionId),
  entry: db.db.prepare("SELECT entry_json FROM session_nodes WHERE session_key=?").get(spec.sessionKey),
}), { ...options, path: path.join(state, "agents/main/agent/openclaw-agent.sqlite") });
if (!result.found || !result.value.entry) throw Error("Source missing");
console.log(JSON.stringify(result.value));
