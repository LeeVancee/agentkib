import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HistorySearchWorker } from "../../../packages/backend/src/history-search-worker";
import {
  CONTENT_SEARCH_BUDGET,
  HistorySearchStore,
  type SearchSession,
} from "../../../packages/backend/src/history-search-store";
import { DatabaseSync } from "node:sqlite";
import { HermesSessions } from "../../../packages/backend/src/hermes-sessions";
import { OpenClawSessions } from "../../../packages/backend/src/openclaw-sessions";
import {
  OpenClawSourceOwnershipError,
  readOpenClawSearchSnapshot,
} from "../../../packages/backend/src/openclaw-sqlite-sessions";
import { sessionIdentity } from "../../../packages/backend/src/session-store";
import type {
  HistoryLocatedRecord,
  HistoryReference,
  HistorySearchResult,
  HistorySearchStatus,
} from "@agentkib/runtime-protocol";

const { createIsolatedWorkerEnvironment } = createRequire(import.meta.url)(
  "../scripts/backend-worker-smoke-environment.cjs",
) as { createIsolatedWorkerEnvironment(root: string): NodeJS.ProcessEnv };
const roots: string[] = [],
  workers: HistorySearchWorker[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((w) => w.close()));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function fixture(timeoutMs = 180_000) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "history-worker-"));
  roots.push(root);
  const entry = path.join(root, "protocol.cjs");
  await fs.writeFile(
    entry,
    `
const {parentPort,workerData}=require('node:worker_threads');
const fs=require('node:fs');
parentPort.on('message',m=>{
  if(m.type==='close')return parentPort.close();
  if(m.type==='cancel')return parentPort.postMessage({type:'error',id:m.id,message:'cancelled'});
  if(m.type==='verified')return parentPort.postMessage({type:'result',id:m.id,value:m.valid});
  if(m.type!=='run')return;
  fs.appendFileSync(workerData.filename+'.requests',m.operation+'\\n');
  if(m.operation==='crash')return process.exit(2);
  if(m.operation==='hold')return parentPort.postMessage({type:'verify',id:m.id});
  parentPort.postMessage({type:'result',id:m.id,value:m.operation});
});`,
  );
  const worker = new HistorySearchWorker(path.join(root, "cache"), false, CONTENT_SEARCH_BUDGET, {
    workerFilename: entry,
    timeoutMs,
  });
  workers.push(worker);
  return { root, worker };
}
async function openCodeSnapshotFixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "history-snapshot-")));
  roots.push(root);
  const project = path.join(root, "project"),
    bin = path.join(root, "bin"),
    mode = path.join(root, "mode"),
    filename = path.join(root, "search.sqlite");
  await Promise.all([project, bin].map((directory) => fs.mkdir(directory)));
  await fs.writeFile(mode, "valid");
  const script = path.join(bin, "snapshot.cjs");
  await fs.writeFile(
    script,
    `const fs = require('node:fs');
const mode = fs.readFileSync(${JSON.stringify(mode)}, 'utf8');
if (process.argv[2] === 'session') {
  process.stdout.write(JSON.stringify([{id:'native',title:'Synthetic',directory:${JSON.stringify(project)}}]));
} else if (mode === 'damaged') {
  process.stdout.write('{"info":');
} else if (mode === 'bounded') {
  // Exercise the real CLI supervisor's strict output bound without a 256 MiB fixture.
  process.stderr.write('x'.repeat(65537));
} else {
  process.stdout.write(JSON.stringify({info:{id:'native',directory:${JSON.stringify(project)}},messages:[{
    info:{id:'body',role:'assistant'},parts:[{type:'text',text:'last-good-marker '+mode}]
  }]}));
}
`,
  );
  await fs.writeFile(
    path.join(bin, process.platform === "win32" ? "opencode.CMD" : "opencode"),
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
      : `#!${process.execPath}\nrequire(${JSON.stringify(script)});\n`,
    { mode: 0o700 },
  );
  const identitySalt = "synthetic-opencode-snapshot-salt",
    sessionId = sessionIdentity(identitySalt, "opencode", "native");
  const session: SearchSession = {
    sessionId,
    workspaceId: "registered",
    agent: "opencode",
    title: "Synthetic",
    updatedAt: null,
    archived: false,
    ownerKey: "synthetic-owner",
  };
  const source = {
    sessionId,
    summary: {
      id: sessionId,
      workspace_id: "registered",
      agent: "opencode",
      native_ref: "native",
      title: "Synthetic",
      origin: "unknown",
      spawned_by_session_id: null,
      forked_from_session_id: null,
      created_at: null,
      updated_at: null,
      message_count: null,
      git_branch: null,
      archived: false,
      sidechain: false,
      availability: "readable",
    },
    workspacePath: project,
    environment: { ...createIsolatedWorkerEnvironment(root), PATH: bin },
    profiles: [],
    identitySalt,
  };
  const open = () => {
    const worker = new HistorySearchWorker(filename, true, CONTENT_SEARCH_BUDGET, {
      workerFilename: path.resolve("dist-electron/backend-history-search.cjs"),
    });
    workers.push(worker);
    return worker;
  };
  const committed = () => {
    const db = new DatabaseSync(filename, { readOnly: true });
    try {
      return db
        .prepare("SELECT generation,source_revision,indexed_at FROM sessions WHERE session_id=?")
        .get(sessionId);
    } finally {
      db.close();
    }
  };
  return { sessionId, entry: { session, source }, mode, open, committed };
}
async function openClawFixture(race = false, nested = false, raceAtOpen = 4) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "history-worker-openclaw-")),
  );
  roots.push(root);
  const home = path.join(root, "openclaw"),
    directory = path.join(home, "agents", "main", "agent"),
    project = path.join(root, "project"),
    foreign = path.join(root, "foreign"),
    cwd = nested ? path.join(project, "nested") : project;
  await Promise.all(
    [directory, project, foreign, cwd].map((dir) => fs.mkdir(dir, { recursive: true })),
  );
  if (nested) await fs.mkdir(path.join(project, ".git"));
  const filename = path.join(directory, "openclaw-agent.sqlite"),
    timestamp = "2026-10-08T00:00:00.000Z";
  const native = new DatabaseSync(filename);
  try {
    native.exec(`PRAGMA user_version=23; PRAGMA journal_mode=WAL;
      CREATE TABLE schema_meta(meta_key TEXT,role TEXT,schema_version INTEGER,agent_id TEXT,app_version TEXT);
      INSERT INTO schema_meta VALUES('primary','agent',23,'main','2026.9.6');
      CREATE TABLE transcript_events(session_id TEXT,seq INTEGER,event_json TEXT,event_utf8_bytes INTEGER);
      CREATE TABLE session_windows(session_id TEXT,session_key TEXT,created_at TEXT,transcript_updated_at TEXT,updated_at TEXT,display_name TEXT,acp_owned INTEGER,plugin_owner_id TEXT,agent_harness_id TEXT,session_scope TEXT);
      CREATE TABLE session_nodes(session_key TEXT,entry_json TEXT,entry_valid INTEGER,archived_at TEXT,current_session_id TEXT);
      CREATE TABLE session_transcript_cold_archives(session_id TEXT);
      CREATE TABLE session_transcript_index_state(session_id TEXT,indexed_seq INTEGER,needs_rebuild INTEGER,active_event_count INTEGER,active_message_count INTEGER);
      CREATE TABLE transcript_rewrite_watermarks(session_id TEXT,generation INTEGER);
      CREATE TABLE session_transcript_active_events(session_id TEXT,event_seq INTEGER,active_position INTEGER,message_position INTEGER,context_eligible INTEGER);`);
    for (const id of ["revoked", "retained"]) {
      native.prepare("INSERT INTO session_nodes VALUES(?,?,1,NULL,?)").run(id, "{}", id);
      native
        .prepare("INSERT INTO session_windows VALUES(?,?,?,?,?,?,0,NULL,'pi','conversation')")
        .run(id, id, timestamp, timestamp, timestamp, `Synthetic ${id}`);
      native.prepare("INSERT INTO session_transcript_index_state VALUES(?,1,0,1,1)").run(id);
      native.prepare("INSERT INTO transcript_rewrite_watermarks VALUES(?,1)").run(id);
      native.prepare("INSERT INTO session_transcript_active_events VALUES(?,1,0,0,1)").run(id);
      const events = [
        { type: "session", version: 4, id, cwd, timestamp },
        {
          type: "message",
          id: `message-${id}`,
          timestamp,
          message: { role: "assistant", content: `openclaw-owner-marker ${id} synthetic body` },
        },
      ];
      for (const [seq, event] of events.entries()) {
        const json = JSON.stringify(event);
        native
          .prepare("INSERT INTO transcript_events VALUES(?,?,?,?)")
          .run(id, seq, json, Buffer.byteLength(json));
      }
    }
  } finally {
    native.close();
  }
  const environment = { HOME: root, USERPROFILE: root, OPENCLAW_STATE_DIR: home, PATH: root },
    identitySalt = "synthetic-openclaw-worker-salt";
  const listing = new OpenClawSessions(environment).list(project).sessions;
  const entries = listing.map(({ session }) => {
    const sessionId = sessionIdentity(identitySalt, "open-claw", session.native_ref);
    return {
      session: {
        sessionId,
        workspaceId: "registered",
        agent: "open-claw",
        title: session.title,
        updatedAt: session.updated_at,
        archived: false,
        ownerKey: "synthetic-openclaw-owner",
      },
      source: {
        sessionId,
        summary: {
          ...session,
          id: sessionId,
          workspace_id: "registered",
          spawned_by_session_id: null,
          forked_from_session_id: null,
        },
        workspacePath: project,
        environment,
        profiles: [],
        identitySalt,
      },
    };
  });
  const revoked = entries.find((entry) => entry.session.title === "Synthetic revoked")!,
    retained = entries.find((entry) => entry.session.title === "Synthetic retained")!,
    owners = entries.map((entry) => entry.session),
    allowedSessionIds = entries.map((entry) => entry.session.sessionId),
    packagedWorker = path.resolve("dist-electron/backend-history-search.cjs"),
    armFile = path.join(root, "change-workspace");
  let workerFilename = packagedWorker;
  if (race) {
    workerFilename = path.join(root, "snapshot-race.cjs");
    // A binding probe and two discovery reads precede snapshot()'s own transaction.
    // Commit a real WAL change at the selected read boundary, without replacing readers.
    await fs.writeFile(
      workerFilename,
      `
const fs = require('node:fs');
const sqlite = require('node:sqlite');
const OriginalDatabase = sqlite.DatabaseSync;
let opens = 0;
sqlite.DatabaseSync = class extends OriginalDatabase {
  constructor(file, options) {
    if (file === ${JSON.stringify(filename)} && fs.existsSync(${JSON.stringify(armFile)}) && ++opens === ${raceAtOpen}) {
      const editor = new OriginalDatabase(file);
      const event = JSON.parse(editor.prepare("SELECT event_json FROM transcript_events WHERE session_id='revoked' AND seq=0").get().event_json);
      event.cwd = ${JSON.stringify(foreign)};
      const json = JSON.stringify(event);
      editor.prepare("UPDATE transcript_events SET event_json=?,event_utf8_bytes=? WHERE session_id='revoked' AND seq=0").run(json, Buffer.byteLength(json));
      editor.close();
      fs.unlinkSync(${JSON.stringify(armFile)});
    }
    super(file, options);
  }
};
require(${JSON.stringify(packagedWorker)});
`,
    );
  }
  let worker = new HistorySearchWorker(
    path.join(root, "search.sqlite"),
    true,
    CONTENT_SEARCH_BUDGET,
    { workerFilename },
  );
  workers.push(worker);
  for (const entry of entries) await worker.request("index", entry);
  const query = () =>
    worker.request<HistorySearchResult>("query", {
      query: { query: "openclaw-owner-marker" },
      allowedSessionIds,
    });
  const result = await query();
  expect(result.hits).toHaveLength(2);
  const hit = result.hits.find((hit) => hit.location.sessionId === revoked.session.sessionId)!;
  const located = await worker.request<HistoryLocatedRecord>("locate", {
    location: hit.location,
    source: revoked.source,
    allowedSessionIds,
    owners,
  });
  const reference = {
    ...hit.location,
    contentHash: located.contentHash,
    start: 0,
    end: located.content.length,
  };
  const references = {
    references: [reference],
    sources: { [revoked.session.sessionId]: revoked.source },
    allowedSessionIds,
    owners,
  };
  await expect(worker.request("references", references)).resolves.toMatchObject({
    references: [{ content: located.content }],
  });
  return {
    get worker() {
      return worker;
    },
    filename,
    revoked,
    retained,
    allowedSessionIds,
    hit,
    references,
    query,
    nativeSource: listing.find(({ session }) => session.title === "Synthetic revoked")!.sqlite!,
    arm: () => fs.writeFile(armFile, "armed"),
    changed: () => fs.stat(armFile),
    mutate: (sql: string) => {
      const db = new DatabaseSync(filename);
      try {
        db.exec(sql);
      } finally {
        db.close();
      }
    },
    addUnrelatedAgent: async () => {
      const otherDirectory = path.join(home, "agents", "unrelated", "agent");
      await fs.mkdir(otherDirectory, { recursive: true });
      // Same local session IDs and headers cannot establish ownership across agent directories.
      await fs.copyFile(filename, path.join(otherDirectory, "openclaw-agent.sqlite"));
    },
    changeWorkspace: () => {
      const db = new DatabaseSync(filename);
      try {
        const row = db
          .prepare("SELECT event_json FROM transcript_events WHERE session_id='revoked' AND seq=0")
          .get()!;
        const event = JSON.parse(String(row.event_json));
        event.cwd = foreign;
        const json = JSON.stringify(event);
        db.prepare(
          "UPDATE transcript_events SET event_json=?,event_utf8_bytes=? WHERE session_id='revoked' AND seq=0",
        ).run(json, Buffer.byteLength(json));
      } finally {
        db.close();
      }
    },
    restart: async () => {
      await worker.close();
      worker = new HistorySearchWorker(
        path.join(root, "search.sqlite"),
        true,
        CONTENT_SEARCH_BUDGET,
        { workerFilename },
      );
      workers.push(worker);
    },
  };
}
async function expectOpenClawWithdrawal(f: Awaited<ReturnType<typeof openClawFixture>>) {
  await expect(f.worker.request("index", f.revoked)).rejects.toThrow(
    "history-source-owner-changed",
  );
  expect(
    await f.worker.request("status", { allowedSessionIds: f.allowedSessionIds }),
  ).toMatchObject({
    coverage: { ready: 1, unavailable: 1, stale: 0, limitations: ["source-owner-changed"] },
  });
  const result = await f.query();
  expect(result.hits.map((hit) => hit.location.sessionId)).toEqual([f.retained.session.sessionId]);
  await expect(
    f.worker.request("locate", {
      location: f.hit.location,
      source: f.revoked.source,
      allowedSessionIds: f.allowedSessionIds,
    }),
  ).rejects.toThrow("history-source-stale");
  await expect(f.worker.request("references", f.references)).rejects.toThrow(
    "history-source-stale",
  );
}

describe("history worker lifecycle and bounded admission", () => {
  it.each(
    (["damaged", "bounded"] as const).flatMap((failure) =>
      (["cold", "cached", "forced"] as const).map((state) => ({ failure, state })),
    ),
  )(
    "preserves last-good content after a $failure whole snapshot failure ($state)",
    async ({ failure, state }) => {
      const f = await openCodeSnapshotFixture();
      let worker = f.open();
      const allowedSessionIds = [f.sessionId];
      const query = () =>
        worker.request<HistorySearchResult>("query", {
          query: { query: "last-good-marker" },
          allowedSessionIds,
        });
      let previous: HistorySearchResult["hits"][number]["location"] | undefined;
      let reference: HistoryReference | undefined;
      if (state !== "cold") {
        await worker.request("index", f.entry);
        previous = (await query()).hits[0]!.location;
        const located = await worker.request<HistoryLocatedRecord>("locate", {
          location: previous,
          source: f.entry.source,
          allowedSessionIds,
        });
        reference = { ...previous, contentHash: located.contentHash, start: 0, end: 1 };
      }
      const committed = state === "cold" ? undefined : f.committed();
      await fs.writeFile(f.mode, failure);
      await expect(
        worker.request("index", { ...f.entry, force: state === "forced" }),
      ).rejects.toThrow("history-source-unavailable");
      const assertRetained = async () => {
        const result = await query();
        expect(result.hits).toHaveLength(state === "cold" ? 0 : 1);
        expect(result.status.coverage).toMatchObject({
          ready: 0,
          partial: 0,
          stale: state === "cold" ? 0 : 1,
          unavailable: state === "cold" ? 1 : 0,
          limitations: [failure === "damaged" ? "damaged-record" : "source-byte-limit"],
        });
        if (committed) {
          expect(f.committed()).toEqual(committed);
          await expect(
            worker.request("locate", {
              location: previous,
              source: f.entry.source,
              allowedSessionIds,
            }),
          ).rejects.toThrow("history-source-unavailable");
          await expect(
            worker.request("references", {
              references: [reference],
              sources: { [f.sessionId]: f.entry.source },
              allowedSessionIds,
            }),
          ).rejects.toThrow("history-source-unavailable");
        }
      };
      await assertRetained();
      await worker.close();
      worker = f.open();
      await assertRetained();
      await fs.writeFile(f.mode, "recovered");
      await worker.request("index", f.entry);
      const recovered = await query();
      expect(recovered.hits).toHaveLength(1);
      expect(recovered.hits[0]!.snippet).toContain("recovered");
      expect(recovered.status.coverage).toMatchObject({
        ready: 1,
        stale: 0,
        unavailable: 0,
        limitations: [],
      });
    },
  );
  it("retains unchanged content generations and marks a failed snapshot check stale", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "history-worker-revision-")),
    );
    roots.push(root);
    const home = path.join(root, "hermes"),
      project = path.join(root, "project");
    await Promise.all([home, project].map((directory) => fs.mkdir(directory)));
    const filename = path.join(home, "state.db");
    const native = new DatabaseSync(filename);
    try {
      native.exec(`CREATE TABLE sessions(id TEXT,title TEXT,cwd TEXT,started_at TEXT,updated_at TEXT);
        CREATE TABLE messages(session_id TEXT,role TEXT,content TEXT,timestamp TEXT);`);
      native
        .prepare("INSERT INTO sessions VALUES(?,?,?,?,?)")
        .run("native", "Synthetic", project, "2026-10-08T00:00:00Z", "2026-10-08T00:00:00Z");
      native
        .prepare("INSERT INTO messages VALUES(?,?,?,?)")
        .run("native", "assistant", "revision-marker original", "2026-10-08T00:00:00Z");
    } finally {
      native.close();
    }
    const environment = { HOME: root, USERPROFILE: root, HERMES_HOME: home, PATH: root };
    const summary = new HermesSessions(environment).list(project).sessions[0]!.session;
    const identitySalt = "synthetic-worker-salt",
      sessionId = sessionIdentity(identitySalt, "hermes", summary.native_ref);
    const entry = {
      session: {
        sessionId,
        workspaceId: "registered",
        agent: "hermes",
        title: summary.title,
        updatedAt: summary.updated_at,
        archived: false,
        ownerKey: "synthetic-owner",
      },
      source: {
        sessionId,
        summary: {
          ...summary,
          id: sessionId,
          workspace_id: "registered",
          spawned_by_session_id: null,
          forked_from_session_id: null,
        },
        workspacePath: project,
        environment,
        profiles: [],
        identitySalt,
      },
    };
    const writer = new HistorySearchWorker(
      path.join(root, "search.sqlite"),
      true,
      CONTENT_SEARCH_BUDGET,
      { workerFilename: path.resolve("dist-electron/backend-history-search.cjs") },
    );
    workers.push(writer);
    await writer.request("index", entry);
    const before = await writer.request<HistorySearchStatus>("status", {
      allowedSessionIds: [sessionId],
    });
    const old = await writer.request<HistorySearchResult>("query", {
      query: { query: "revision-marker" },
      allowedSessionIds: [sessionId],
    });
    await writer.request("index", entry);
    expect(
      (await writer.request<HistorySearchStatus>("status", { allowedSessionIds: [sessionId] }))
        .generation,
    ).toBe(before.generation);
    expect(
      await writer.request("query", {
        query: { query: "revision-marker" },
        allowedSessionIds: [sessionId],
      }),
    ).toEqual(old);
    const other = path.join(root, "other");
    await fs.mkdir(other);
    const changed = new DatabaseSync(filename);
    try {
      changed.prepare("UPDATE sessions SET cwd=?").run(other);
    } finally {
      changed.close();
    }
    await expect(writer.request("index", entry)).rejects.toThrow("history-source-owner-changed");
    expect(await writer.request("status", { allowedSessionIds: [sessionId] })).toMatchObject({
      coverage: { unavailable: 1, stale: 0, limitations: ["source-owner-changed"] },
    });
    expect(
      (
        await writer.request<HistorySearchResult>("query", {
          query: { query: "revision-marker" },
          allowedSessionIds: [sessionId],
        })
      ).hits,
    ).toEqual([]);
    const restored = new DatabaseSync(filename);
    try {
      restored.prepare("UPDATE sessions SET cwd=?").run(project);
    } finally {
      restored.close();
    }
    await writer.request("index", entry);
    const linkedDirectory = path.join(home, "sessions"),
      linkedFile = path.join(linkedDirectory, "native.jsonl");
    await fs.mkdir(linkedDirectory);
    await fs.writeFile(
      linkedFile,
      JSON.stringify({ type: "session", id: "native", cwd: project, title: "Synthetic" }) + "\n",
    );
    const unlinked = new DatabaseSync(filename);
    try {
      unlinked.prepare("UPDATE sessions SET cwd=NULL").run();
    } finally {
      unlinked.close();
    }
    await writer.request("index", entry);
    expect(await writer.request("status", { allowedSessionIds: [sessionId] })).toMatchObject({
      coverage: { partial: 1, limitations: ["hermes-workspace-from-linked-history"] },
    });
    await fs.rm(linkedFile);
    await expect(writer.request("index", entry)).rejects.toThrow("history-source-unavailable");
    expect(await writer.request("status", { allowedSessionIds: [sessionId] })).toMatchObject({
      coverage: { stale: 1, unavailable: 0 },
    });
    expect(
      (
        await writer.request<HistorySearchResult>("query", {
          query: { query: "revision-marker" },
          allowedSessionIds: [sessionId],
        })
      ).hits,
    ).toHaveLength(1);
    await fs.rm(filename);
    await expect(writer.request("index", entry)).rejects.toThrow("history-source-unavailable");
    expect(await writer.request("status", { allowedSessionIds: [sessionId] })).toMatchObject({
      coverage: { stale: 1, ready: 0 },
    });
    expect(
      (
        await writer.request<HistorySearchResult>("query", {
          query: { query: "revision-marker" },
          allowedSessionIds: [sessionId],
        })
      ).hits,
    ).toHaveLength(1);
  });
  it.each([
    ["ACP ownership", "UPDATE session_windows SET acp_owned=1 WHERE session_id='revoked'"],
    [
      "shared scope",
      "UPDATE session_windows SET session_scope='shared' WHERE session_id='revoked'",
    ],
    [
      "plugin ownership",
      "UPDATE session_windows SET plugin_owner_id='synthetic-plugin' WHERE session_id='revoked'",
    ],
    [
      "external harness",
      "UPDATE session_windows SET agent_harness_id='external' WHERE session_id='revoked'",
    ],
    [
      "external CLI ownership",
      `UPDATE session_nodes SET entry_json='{"codexCliSessionId":"synthetic-cli"}' WHERE session_key='revoked'`,
    ],
  ])("withdraws cached OpenClaw text after %s changes", async (_name, sql) => {
    const f = await openClawFixture();
    f.mutate(sql);
    await expectOpenClawWithdrawal(f);
  });
  it.each(["locate", "references"])(
    "uses the committed OpenClaw binding rather than supplied evidence for %s",
    async (operation) => {
      const f = await openClawFixture();
      const source = {
        ...f.revoked.source,
        openClawBinding: {
          home: path.dirname(f.filename),
          agentId: "untrusted-agent",
          sessionId: "untrusted-session",
          cwd: path.dirname(f.filename),
        },
      };
      const input =
        operation === "locate"
          ? {
              location: f.hit.location,
              source,
              allowedSessionIds: f.allowedSessionIds,
              owners: f.references.owners,
            }
          : { ...f.references, sources: { [source.sessionId]: source } };
      await expect(f.worker.request(operation, input)).resolves.toBeDefined();
      f.changeWorkspace();
      await expect(f.worker.request(operation, input)).rejects.toMatchObject({
        message: "history-source-owner-changed",
        sessionId: f.revoked.session.sessionId,
      });
    },
  );
  it.each(["locate", "references"])(
    "requires the authorized OpenClaw owner before reading cached evidence for %s",
    async (operation) => {
      const f = await openClawFixture();
      const input =
        operation === "locate"
          ? {
              location: f.hit.location,
              source: f.revoked.source,
              allowedSessionIds: f.allowedSessionIds,
            }
          : f.references;
      for (const owners of [
        undefined,
        [{ ...f.revoked.session, ownerKey: "different-owner" }],
        [{ ...f.revoked.session, workspaceId: "different-workspace" }],
      ])
        await expect(f.worker.request(operation, { ...input, owners })).rejects.toThrow(
          "history-source-unavailable",
        );
      // Invalid caller scope is not evidence to revoke the owner's committed cache.
      expect((await f.query()).hits).toHaveLength(2);
    },
  );
  it("withdraws cached OpenClaw text when cwd changes between discovery and snapshot", async () => {
    const f = await openClawFixture(true);
    await f.arm();
    await expectOpenClawWithdrawal(f);
    await expect(f.changed()).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rechecks bound OpenClaw ownership when discovery fails after the first probe", async () => {
    const f = await openClawFixture(true, false, 2);
    await f.arm();
    await expectOpenClawWithdrawal(f);
    await expect(f.changed()).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("keeps cached OpenClaw text stale when the database is missing or temporarily unreadable", async () => {
    const f = await openClawFixture();
    f.mutate(
      "UPDATE session_transcript_index_state SET needs_rebuild=1 WHERE session_id='revoked'",
    );
    await expect(f.worker.request("index", f.revoked)).rejects.toThrow(
      "history-source-unavailable",
    );
    expect(
      await f.worker.request("status", { allowedSessionIds: f.allowedSessionIds }),
    ).toMatchObject({
      coverage: { ready: 1, stale: 1, unavailable: 0 },
    });
    expect((await f.query()).hits).toHaveLength(2);
    await fs.rm(f.filename);
    await expect(f.worker.request("index", f.revoked)).rejects.toThrow(
      "history-source-unavailable",
    );
    expect(
      await f.worker.request("status", { allowedSessionIds: f.allowedSessionIds }),
    ).toMatchObject({
      coverage: { ready: 1, stale: 1, unavailable: 0 },
    });
    expect((await f.query()).hits).toHaveLength(2);
  });
  it.each([
    ["agent identity", "UPDATE schema_meta SET agent_id='other'", true],
    ["database role", "UPDATE schema_meta SET role='state'", true],
    ["application version", "UPDATE schema_meta SET app_version='unsupported'", false],
    ["schema version", "PRAGMA user_version=24", false],
  ])("distinguishes changed OpenClaw %s from unavailable data", async (_name, sql, ownership) => {
    const f = await openClawFixture();
    f.mutate(sql);
    let failure: unknown;
    try {
      readOpenClawSearchSnapshot(f.nativeSource);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof OpenClawSourceOwnershipError).toBe(ownership);
  });
  it.each([
    ["agent identity", "UPDATE schema_meta SET agent_id='other'"],
    ["database role", "UPDATE schema_meta SET role='state'"],
  ])(
    "withdraws cached OpenClaw text after database %s changes before discovery",
    async (_name, sql) => {
      const f = await openClawFixture();
      f.mutate(sql);
      await expectOpenClawWithdrawal(f);
    },
  );
  it.each([
    [false, false],
    [true, false],
    [true, true],
  ])(
    "withdraws cached OpenClaw text after cwd changes before discovery (restart=%s, nested=%s)",
    async (restart, nested) => {
      const f = await openClawFixture(false, nested);
      if (restart) await f.restart();
      f.changeWorkspace();
      await expectOpenClawWithdrawal(f);
    },
  );
  it.each([
    ["workspace", null],
    ["agent identity", "UPDATE schema_meta SET agent_id='other'"],
    ["database role", "UPDATE schema_meta SET role='state'"],
  ])(
    "withdraws cached OpenClaw text when a missing source returns with changed %s",
    async (_name, sql) => {
      const f = await openClawFixture();
      await fs.rename(f.filename, `${f.filename}.offline`);
      await expect(f.worker.request("index", f.revoked)).rejects.toThrow(
        "history-source-unavailable",
      );
      expect(
        await f.worker.request("status", { allowedSessionIds: f.allowedSessionIds }),
      ).toMatchObject({ coverage: { stale: 1, ready: 1 } });
      await f.restart();
      await fs.rename(`${f.filename}.offline`, f.filename);
      if (sql) f.mutate(sql);
      else f.changeWorkspace();
      await expectOpenClawWithdrawal(f);
    },
  );
  it.each([
    ["application version", "UPDATE schema_meta SET app_version='unsupported'"],
    ["metadata schema version", "UPDATE schema_meta SET schema_version=24"],
    ["SQLite schema version", "PRAGMA user_version=24"],
  ])("keeps cached OpenClaw text stale after unsupported database %s", async (_name, sql) => {
    const f = await openClawFixture();
    f.mutate(sql);
    await expect(f.worker.request("index", f.revoked)).rejects.toThrow(
      "history-source-unavailable",
    );
    expect(
      await f.worker.request("status", { allowedSessionIds: f.allowedSessionIds }),
    ).toMatchObject({ coverage: { ready: 1, stale: 1, unavailable: 0 } });
    expect((await f.query()).hits).toHaveLength(2);
  });
  it("ignores an unrelated OpenClaw agent ownership mismatch without revoking a missing source", async () => {
    const f = await openClawFixture();
    await f.addUnrelatedAgent();
    await expect(f.worker.request("index", f.revoked)).resolves.toMatchObject({
      sessionId: f.revoked.session.sessionId,
      status: "ready",
    });
    expect(
      await f.worker.request("status", { allowedSessionIds: f.allowedSessionIds }),
    ).toMatchObject({ coverage: { ready: 2, stale: 0, unavailable: 0 } });
    await fs.rm(f.filename);
    await expect(f.worker.request("index", f.revoked)).rejects.toThrow(
      "history-source-unavailable",
    );
    expect(
      await f.worker.request("status", { allowedSessionIds: f.allowedSessionIds }),
    ).toMatchObject({ coverage: { ready: 1, stale: 1, unavailable: 0 } });
    expect((await f.query()).hits).toHaveLength(2);
  });
  it("withdraws cached OpenClaw text after the configured state directory changes", async () => {
    const f = await openClawFixture();
    f.revoked.source.environment.OPENCLAW_STATE_DIR = path.join(
      path.dirname(f.filename),
      "other-state",
    );
    await expectOpenClawWithdrawal(f);
  });
  it("has one active plus eight waiting slots, executes FIFO, and rejects overflow immediately", async () => {
    const { worker } = await fixture();
    let release!: (value: boolean) => void;
    let entered = false;
    const active = worker.request(
      "hold",
      {},
      {
        verify: () => {
          entered = true;
          return new Promise<boolean>((resolve) => {
            release = resolve;
          });
        },
      },
    );
    await vi.waitFor(() => expect(entered).toBe(true));
    const waiting = Array.from({ length: 8 }, (_, i) => worker.request(String(i), {}));
    await expect(worker.request("overflow", {})).rejects.toMatchObject({ reason: "queue-full" });
    release(true);
    expect(await active).toBe(true);
    expect(await Promise.all(waiting)).toEqual(["0", "1", "2", "3", "4", "5", "6", "7"]);
  });
  it("cancels queued reads without dispatch and keeps the active result isolated", async () => {
    const { root, worker } = await fixture();
    let release!: (value: boolean) => void,
      entered = false;
    const active = worker.request(
      "hold",
      {},
      {
        verify: () => {
          entered = true;
          return new Promise<boolean>((resolve) => {
            release = resolve;
          });
        },
      },
    );
    await vi.waitFor(() => expect(entered).toBe(true));
    const cancel = new AbortController();
    const queued = worker.request("never-dispatch", {}, { signal: cancel.signal });
    const rejected = expect(queued).rejects.toThrow();
    cancel.abort();
    await rejected;
    release(true);
    await active;
    expect(await fs.readFile(path.join(root, "cache.requests"), "utf8")).toBe("hold\n");
  });
  it("counts queue time toward the deadline and closes with unresolved verification", async () => {
    const { root, worker } = await fixture(250);
    const active = worker.request("hold", {}, { verify: () => new Promise<boolean>(() => {}) });
    const stopped = expect(active).rejects.toThrow();
    const queued = worker.request("queued", {});
    // Active cancellation receives a terminal response; the queued request is already expired.
    const queuedResult = queued.then(
      () => "dispatched",
      () => "expired",
    );
    await stopped;
    await worker.close();
    expect(await queuedResult).toBe("expired");
    expect(await fs.readFile(path.join(root, "cache.requests"), "utf8")).toBe("hold\n");
  });
  it("reports a crashed worker once and never replays accepted requests", async () => {
    const { root, worker } = await fixture();
    await expect(worker.request("crash", {})).rejects.toMatchObject({ reason: "worker-failed" });
    await expect(worker.request("retry", {})).rejects.toMatchObject({ reason: "worker-failed" });
    await worker.close();
    expect(await fs.readFile(path.join(root, "cache.requests"), "utf8")).toBe("crash\n");
  });
  it("boots the packaged SQLite worker and observes committed state across independent workers", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "history-native-worker-"));
    roots.push(root);
    const options = { workerFilename: path.resolve("dist-electron/backend-history-search.cjs") };
    const writer = new HistorySearchWorker(
      path.join(root, "session-search.sqlite"),
      true,
      CONTENT_SEARCH_BUDGET,
      options,
    );
    workers.push(writer);
    await writer.request("init", {});
    const reader = new HistorySearchWorker(
      path.join(root, "session-search.sqlite"),
      false,
      CONTENT_SEARCH_BUDGET,
      options,
    );
    workers.push(reader);
    await expect(reader.request("status", { allowedSessionIds: [] })).resolves.toMatchObject({
      enabled: true,
      coverage: { total: 0 },
    });
    await expect(
      reader.request("query", { query: { query: "中文/代码" }, allowedSessionIds: [] }),
    ).resolves.toMatchObject({ hits: [] });
  });
  it.each(["status", "query"] as const)(
    "reports authorized pending sources through the packaged worker %s without double counting",
    async (operation) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "history-worker-coverage-"));
      roots.push(root);
      const filename = path.join(root, "search.sqlite");
      const session = (sessionId: string, agent: string): SearchSession => ({
        sessionId,
        workspaceId: "registered",
        agent,
        title: `Synthetic ${sessionId}`,
        updatedAt: "2026-10-08T00:00:00Z",
        archived: false,
        ownerKey: `owner-${sessionId}`,
      });
      const ready = session("ready", "claude-code"),
        pending = session("pending", "claude-code"),
        pendingCodex = session("pending-codex", "codex"),
        pendingCursor = session("pending-cursor", "cursor"),
        outside = { ...session("outside-scope", "hermes"), workspaceId: "foreign" },
        rebound = session("owner-mismatch", "open-claw"),
        owners = [ready, pending, pendingCodex, pendingCursor, { ...rebound, ownerKey: "changed" }];
      const writer = new HistorySearchStore(filename, true);
      const publish = (entry: SearchSession) => {
        const generation = writer.begin(entry);
        writer.append(
          entry.sessionId,
          generation,
          {
            recordId: `record-${entry.sessionId}`,
            ordinal: 0,
            kind: "assistant",
            timestamp: null,
            toolName: null,
            content: `pending-coverage-marker ${entry.sessionId}`,
          },
          () => {},
        );
        writer.finish(entry.sessionId, generation, `revision-${entry.sessionId}`, "ready", []);
      };
      try {
        for (const entry of [ready, outside, rebound]) publish(entry);
        const reader = new HistorySearchWorker(filename, false, CONTENT_SEARCH_BUDGET, {
          workerFilename: path.resolve("dist-electron/backend-history-search.cjs"),
        });
        workers.push(reader);
        const readStatus = async (expectedHits: string[]) => {
          const input = {
            owners,
            // The scoped owners must replace stale IDs and reject changed ownership.
            allowedSessionIds: [...owners, outside].map((entry) => entry.sessionId),
          };
          if (operation === "status") return reader.request<HistorySearchStatus>(operation, input);
          const result = await reader.request<HistorySearchResult>(operation, {
            ...input,
            query: { query: "pending-coverage-marker" },
          });
          expect(result.hits.map((hit) => hit.location.sessionId).sort()).toEqual(
            expectedHits.sort(),
          );
          return result.status;
        };
        const expectCoverage = (status: HistorySearchStatus, completed: boolean) => {
          expect(status.coverage).toEqual({
            total: 4,
            ready: completed ? 3 : 1,
            building: completed ? 1 : 3,
            partial: 0,
            stale: 0,
            unavailable: 0,
            limitations: [],
          });
          expect(status.sources?.map((source) => source.agent).sort()).toEqual([
            "claude-code",
            "codex",
            "cursor",
          ]);
          for (const [agent, total, readyCount, body, tools] of [
            [
              "claude-code",
              2,
              completed ? 2 : 1,
              completed ? "supported" : "partial",
              completed ? "supported" : "partial",
            ],
            [
              "codex",
              1,
              completed ? 1 : 0,
              completed ? "supported" : "unavailable",
              completed ? "supported" : "unavailable",
            ],
            ["cursor", 1, 0, "unavailable", "unsupported"],
          ] as const)
            expect(status.sources?.find((source) => source.agent === agent)).toMatchObject({
              body,
              tools,
              coverage: { total, ready: readyCount, building: total - readyCount },
            });
        };
        expectCoverage(await readStatus([ready.sessionId]), false);
        for (const entry of [pending, pendingCodex]) publish(entry);
        expectCoverage(
          await readStatus([ready.sessionId, pending.sessionId, pendingCodex.sessionId]),
          true,
        );
      } finally {
        writer.close();
      }
    },
  );
});
