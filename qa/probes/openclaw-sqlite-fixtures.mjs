// Synthetic fixtures produced by the pinned product's own transactional writer.
// Usage: node qa/probes/openclaw-sqlite-fixtures.mjs <openclaw-package> <new-state-dir>
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [packageRoot, stateArgument] = process.argv.slice(2);
if (!packageRoot || !stateArgument)
  throw new Error("Expected package root and NEW state directory");
const state = path.resolve(stateArgument);
if (fs.existsSync(state)) throw new Error("Fixture state must not already exist");
if (
  JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version !== "2026.9.6"
) {
  throw new Error("Only OpenClaw 2026.9.6 is admitted");
}
const workspace = path.join(state, "workspace");
fs.mkdirSync(workspace, { recursive: true });
Object.assign(process.env, {
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
  HOME: path.join(state, "home"),
});
fs.writeFileSync(
  process.env.OPENCLAW_CONFIG_PATH,
  JSON.stringify(
    {
      gateway: { mode: "local", bind: "loopback", auth: { mode: "none" } },
      agents: { defaults: { workspace }, entries: { main: { workspace } } },
      plugins: { enabled: false },
    },
    null,
    2,
  ),
);
const load = (name) => import(pathToFileURL(path.join(packageRoot, "dist", name)));
const { f: transaction, r: close } = await load("openclaw-agent-db-CaQAStOA.mjs");
const { f: writeEntry } = await load("session-accessor.sqlite-entry-store-DTntRuil.mjs");
const { u: replace, m: header } = await load(
  "session-accessor.sqlite-transcript-store-CFksbmAY.mjs",
);
const { l: readEvents } = await load("session-accessor.sqlite-read-DG0i0-yW.mjs");
const { l: readVisibleEvents } = await load("session-accessor.sqlite-active-events-Cnt-hBim.mjs");
const { t: acquireLock } = await load("embedded-state-lock-Cw9nQxv5.mjs");
const options = { agentId: "main", env: { ...process.env } };
const timestamp = "2026-09-27T00:00:00.000Z";
const message = (id, parentId, role, text, extra = {}) => ({
  type: "message",
  id,
  parentId,
  timestamp,
  ...extra,
  message: { role, content: [{ type: "text", text }], timestamp: 1790467200000 },
});
const cases = {
  ordinary: [
    message("u", null, "user", "Synthetic marker AKIB-OPENCLAW-794fb2; decision: SQLite WAL."),
    message("a", "u", "assistant", "Acknowledged AKIB-OPENCLAW-794fb2 and SQLite WAL."),
  ],
  branch: [
    message("u", null, "user", "root"),
    message("a", "u", "assistant", "selected answer"),
    message("s", "u", "assistant", "inactive answer", { appendMode: "side" }),
    { type: "leaf", id: "l", parentId: "s", targetId: "a", timestamp },
  ],
  compaction: [
    message("u", null, "user", "before compaction"),
    {
      type: "compaction",
      id: "c",
      parentId: "u",
      timestamp,
      firstKeptEntryId: "u",
      tokensBefore: 12,
      summary: "synthetic summary",
    },
    message("a", "c", "assistant", "after compaction"),
  ],
  reset: [
    message("u", null, "user", "before reset"),
    { type: "reset", id: "r", parentId: "u", timestamp, reason: "new" },
    message("a", "r", "user", "after reset"),
  ],
  compressed: [
    message("u", null, "user", "long synthetic history ".repeat(5000)),
    message("a", "u", "assistant", "retained"),
  ],
};
const result = { version: "2026.9.6", workspace, cases: [] };
const lock = await acquireLock({
  options: { env: options.env, allowInTests: true, timeoutMs: 1000 },
  formatActiveGatewayRefusal: () => "Gateway must be stopped for synthetic fixture creation",
});
try {
  let index = 0;
  for (const [name, body] of Object.entries(cases)) {
    const sessionId = `a11a0000-0000-4000-8000-${String(++index).padStart(12, "0")}`;
    const sessionKey = `agent:main:agentkib:${sessionId}`;
    transaction((db) => {
      if (db.db.prepare("SELECT 1 FROM session_nodes WHERE session_key=?").get(sessionKey))
        throw new Error("Target collision");
      const events = [header({ sessionId, cwd: workspace, timestamp }), ...body];
      writeEntry(db, sessionKey, {
        sessionId,
        updatedAt: Date.now(),
        createdAt: Date.now(),
        label: `AgentKib ${name}`,
        spawnedCwd: workspace,
        spawnedWorkspaceDir: workspace,
        createdVia: "cli",
      });
      replace(db, { ...options, sessionKey, sessionId }, events);
      const readback = readEvents(db, sessionId);
      if (JSON.stringify(readback) !== JSON.stringify(events))
        throw new Error("Official writer readback mismatch");
      result.database = db.path;
      result.cases.push({ name, sessionKey, sessionId, events: readback });
    }, options);
    result.cases.at(-1).visibleEvents = readVisibleEvents({ ...options, sessionKey, sessionId });
  }
  fs.writeFileSync(path.join(state, "expected.json"), JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify(
      {
        database: result.database,
        workspace,
        cases: result.cases.map(({ name, sessionKey, sessionId }) => ({
          name,
          sessionKey,
          sessionId,
        })),
      },
      null,
      2,
    ),
  );
} finally {
  await close();
  await lock?.release();
}
