import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HistorySearchResult } from "@agentkib/runtime-protocol";
import { historySourceIdentity } from "../../../packages/backend/src/history-search-source-identity";
import {
  readHistorySearchSource,
  type HistorySourceInput,
  type HistorySourceRecord,
} from "../../../packages/backend/src/history-search-source";
import {
  CONTENT_SEARCH_BUDGET,
  HistorySearchStore,
  contentHash,
  type SearchSession,
} from "../../../packages/backend/src/history-search-store";
import { HistorySearchWorker } from "../../../packages/backend/src/history-search-worker";
import { SESSION_AGENTS, SessionReaders } from "../../../packages/backend/src/session-readers";
import { sessionIdentity, type NativeSession } from "../../../packages/backend/src/session-store";
import * as handoff from "../../../packages/backend/src/session-handoff";

const roots: string[] = [];
const stores = new Set<HistorySearchStore>();
const workers: HistorySearchWorker[] = [];
const canary = "SYNTHETIC_PKCS8_CACHE_UPGRADE_MARKER";
const body = `before\n-----BEGIN PRIVATE KEY-----\n${canary}\n-----END PRIVATE KEY-----\nafter`;
const timestamp = "2026-10-08T00:00:00.000Z";
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(workers.splice(0).map((worker) => worker.close()));
  for (const store of stores) store.close();
  stores.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function open(filename: string, writable: boolean) {
  const store = new HistorySearchStore(filename, writable);
  stores.add(store);
  return store;
}
function close(store: HistorySearchStore) {
  store.close();
  stores.delete(store);
}
function fixture(agent: NativeSession["agent"]) {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-sanitizer-upgrade-"));
  roots.push(root);
  const project = path.join(root, "project");
  mkdirSync(project);
  const native: NativeSession = {
    agent,
    native_ref: "synthetic-native",
    title: "Synthetic",
    created_at: timestamp,
    updated_at: timestamp,
    message_count: 1,
    git_branch: null,
    archived: false,
    sidechain: false,
    availability: "readable",
    origin: "interactive",
    spawned_by_session_id: null,
    forked_from_session_id: null,
  };
  const identitySalt = "synthetic-sanitizer-upgrade-salt";
  const sessionId = sessionIdentity(identitySalt, agent, native.native_ref);
  const input: HistorySourceInput = {
    sessionId,
    summary: { ...native, id: sessionId, workspace_id: "registered" },
    workspacePath: project,
    environment: { HOME: root, USERPROFILE: root, PATH: root },
    identitySalt,
    profiles: [],
  };
  const session: SearchSession = {
    sessionId,
    workspaceId: "registered",
    agent,
    title: "Synthetic",
    updatedAt: timestamp,
    archived: false,
    ownerKey: "synthetic-owner",
  };
  const record: HistorySourceRecord = {
    recordId: "synthetic-record",
    ordinal: 0,
    kind: "user",
    toolName: null,
    timestamp,
    content: body,
  };
  const filename = path.join(root, "search.sqlite");
  const allowed = [sessionId];
  const identity = historySourceIdentity(input, "synthetic-native-evidence", {
    native,
    workspace: project,
  });
  const oldIdentity = JSON.parse(identity);
  delete oldIdentity.sanitizerVersion;
  const oldRevision = contentHash(JSON.stringify(oldIdentity));
  const currentRevision = contentHash(identity);
  const save = (
    store: HistorySearchStore,
    records: HistorySourceRecord[],
    sourceRevision: string,
  ) => {
    const generation = store.begin(session);
    for (const record of records) store.append(sessionId, generation, record, () => {});
    store.finish(sessionId, generation, sourceRevision, "ready", []);
  };
  const seed = () => {
    const store = open(filename, true);
    save(store, [record], oldRevision);
    const oldLocation = store.query({ query: canary }, allowed, () => {}).hits[0]!.location;
    // Reproduce an already committed cache made before generic PKCS#8 redaction existed.
    store.db.prepare("UPDATE metadata SET value='1' WHERE key='sanitizer_version'").run();
    close(store);
    return oldLocation;
  };
  return {
    root,
    project,
    native,
    input,
    session,
    filename,
    allowed,
    record,
    currentRevision,
    save,
    seed,
  };
}

describe("history search sanitizer upgrades", () => {
  it.each(
    SESSION_AGENTS.flatMap((agent) =>
      (["reader-first", "writer-first"] as const).map((order) => ({ agent, order })),
    ),
  )("withdraws v1 $agent text before serving queries ($order)", ({ agent, order }) => {
    const f = fixture(agent);
    const oldLocation = f.seed();
    if (order === "reader-first")
      expect(() => open(f.filename, false)).toThrow("Obsolete content search sanitizer");
    const writer = open(f.filename, true);
    const reader = open(f.filename, false);
    for (const store of [writer, reader]) {
      expect(store.query({ query: canary }, f.allowed, () => {}).hits).toEqual([]);
      expect(store.cachedSourceRevision(f.session)).toBeUndefined();
      expect(() => store.locate(oldLocation, f.allowed)).toThrow("history-source-stale");
      expect(store.status(f.allowed).coverage).toMatchObject({ ready: 0, building: 1 });
    }
    const sanitized = handoff.sanitizeSessionText(body, { value: 0 });
    expect(sanitized).not.toContain(canary);
    f.save(writer, [{ ...f.record, content: sanitized }], f.currentRevision);
    expect(reader.query({ query: canary }, f.allowed, () => {}).hits).toEqual([]);
    const location = reader.query({ query: "before" }, f.allowed, () => {}).hits[0]!.location;
    expect(reader.locate(location, f.allowed).content).toBe(sanitized);
    expect(() => reader.locate(oldLocation, f.allowed)).toThrow("history-source-stale");
  });

  it("changes the Codex revision and rebuilds unmodified native history with current redaction", async () => {
    const f = fixture("codex");
    const transcript = path.join(f.root, "history.jsonl");
    const bytes =
      JSON.stringify({
        type: "event_msg",
        timestamp,
        payload: { type: "user_message", message: body },
      }) + "\n";
    writeFileSync(transcript, bytes);
    vi.spyOn(SessionReaders.prototype, "resolve").mockResolvedValue({
      summary: f.input.summary,
      native: f.native,
      workspace: f.project,
      transcript,
    });
    const identityModule =
      await import("../../../packages/backend/src/history-search-source-identity");
    const currentIdentity = identityModule.historySourceIdentity;
    const oldIdentity = vi
      .spyOn(identityModule, "historySourceIdentity")
      .mockImplementation((...args) => {
        const parsed = JSON.parse(currentIdentity(...args));
        delete parsed.sanitizerVersion;
        return JSON.stringify(parsed);
      });
    const sanitize = handoff.sanitizeSessionText;
    const oldSanitizer = vi
      .spyOn(handoff, "sanitizeSessionText")
      .mockImplementation((text, count) =>
        text.includes("-----BEGIN PRIVATE KEY-----") ? text : sanitize(text, count),
      );
    const read = async () => {
      const records: HistorySourceRecord[] = [];
      const result = await readHistorySearchSource(f.input, (record) => {
        records.push(record);
      });
      return { ...result, records };
    };
    const previous = await read();
    oldSanitizer.mockRestore();
    oldIdentity.mockRestore();
    const current = await read();
    expect(previous.records[0]!.content.includes(canary)).toBe(true);
    expect(current.records[0]!.content.includes(canary)).toBe(false);
    expect(current.sourceRevision).not.toBe(previous.sourceRevision);
    const old = open(f.filename, true);
    f.save(old, previous.records, previous.sourceRevision);
    const oldLocation = old.query({ query: canary }, f.allowed, () => {}).hits[0]!.location;
    old.db.prepare("UPDATE metadata SET value='1' WHERE key='sanitizer_version'").run();
    close(old);
    const writer = open(f.filename, true);
    const reader = open(f.filename, false);
    expect(reader.query({ query: canary }, f.allowed, () => {}).hits).toEqual([]);
    f.save(writer, current.records, current.sourceRevision);
    expect(reader.query({ query: canary }, f.allowed, () => {}).hits).toEqual([]);
    const location = reader.query({ query: "before" }, f.allowed, () => {}).hits[0]!.location;
    expect(reader.locate(location, f.allowed).content).toBe(current.records[0]!.content);
    expect(() => reader.locate(oldLocation, f.allowed)).toThrow("history-source-stale");
    expect((await import("node:fs")).readFileSync(transcript, "utf8")).toBe(bytes);
  });

  it("rejects a query worker opened before the upgrading writer and recovers without exposing v1 text", async () => {
    const f = fixture("codex");
    const oldLocation = f.seed();
    const workerFilename = path.resolve("dist-electron/backend-history-search.cjs");
    const reader = new HistorySearchWorker(f.filename, false, CONTENT_SEARCH_BUDGET, {
      workerFilename,
    });
    workers.push(reader);
    const query = () =>
      reader.request<HistorySearchResult>("query", {
        query: { query: canary },
        allowedSessionIds: f.allowed,
      });
    await expect(reader.request("init", {})).rejects.toThrow("history-search-cache-unavailable");
    await expect(query()).rejects.toThrow("history-source-unavailable");
    const writer = new HistorySearchWorker(f.filename, true, CONTENT_SEARCH_BUDGET, {
      workerFilename,
    });
    workers.push(writer);
    await writer.request("init", {});
    expect((await query()).hits).toEqual([]);
    await expect(
      reader.request("locate", {
        location: oldLocation,
        allowedSessionIds: f.allowed,
      }),
    ).rejects.toThrow("history-source-stale");
    const status = await reader.request("status", { allowedSessionIds: f.allowed });
    expect(status).toMatchObject({ coverage: { ready: 0, building: 1 } });
  });
});
