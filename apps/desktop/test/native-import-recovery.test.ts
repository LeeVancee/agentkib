import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Commands } from "../../../packages/backend/src/commands";
import * as resolution from "../../../packages/backend/src/command-resolution";
import { BackendStore } from "../../../packages/backend/src/store";
import { fingerprintSessionDocument } from "../../../packages/backend/src/session-handoff";
import type { SessionDocument } from "../../../packages/backend/src/session-model";
import {
  inspectNativeImportTarget,
  planNativeImport,
  continueNativeImport,
  reconcileNativeImport,
  nativeImportLaunchInfo,
  NativeImportOutcomeUnknownError,
} from "../../../packages/backend/src/session-native-import-owner";

const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const action of cleanup.splice(0).reverse()) action();
});
async function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "native-recovery-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project"),
    data = path.join(root, "data"),
    home = path.join(root, "home");
  mkdirSync(project);
  mkdirSync(home);
  const env = { HOME: home, USERPROFILE: home, PATH: path.join(root, "bin") };
  const store = new BackendStore(path.join(data, "agentkib.db"));
  cleanup.push(() => store.close());
  store.sql.run(
    "INSERT INTO workspaces(id,canonical_path,name,manifest_workspace_id,status,last_discovered_at) VALUES(?,?,?,?,?,?)",
    "registered",
    project,
    "Fixture",
    "legacy",
    "healthy",
    "2026-10-07T00:00:00Z",
  );
  store.sessions.sync("registered", "claude-code", [
    {
      native_ref: "source",
      agent: "claude-code",
      title: null,
      created_at: null,
      updated_at: null,
      message_count: 2,
      git_branch: null,
      archived: false,
      sidechain: false,
      availability: "readable",
      origin: "interactive",
    },
  ]);
  const document: SessionDocument = {
    schema_version: 1,
    source: { agent: "claude-code", workspace_id: "legacy" },
    turns: [
      { id: "u", role: "user", blocks: [{ type: "text", text: "Unique source marker 83eac8" }] },
      {
        id: "a",
        role: "assistant",
        blocks: [{ type: "text", text: "Decision: preserve append-only history." }],
      },
    ],
    losses: [],
    redaction_count: 0,
  };
  const sessions = { document: async () => structuredClone(document) };
  const executable = path.join(root, "opencode");
  writeFileSync(executable, "fixture", { mode: 0o755 });
  vi.spyOn(resolution, "resolveCommand").mockReturnValue(executable);
  const commands = new Commands();
  cleanup.push(() => commands.close());
  let attempts = 0,
    lost = false;
  const exported = path.join(root, "export.json");
  vi.spyOn(commands, "run").mockImplementation(async (_program, args) => {
    let text = "";
    if (args[0] === "--version") text = "1.18.32";
    else if (args[0] === "debug") text = JSON.stringify({ model: "fixture/model" });
    else if (args[0] === "import") {
      attempts++;
      writeFileSync(exported, readFileSync(args[1]!));
      if (lost) throw new Error("reply lost after native commit");
    } else if (args[0] === "export") text = readFileSync(exported, "utf8");
    else throw new Error("Unexpected command: " + args.join(" "));
    return { bytes: Buffer.from(text), success: true, truncated: false, error: "", exitCode: 0 };
  });
  const snapshot = await inspectNativeImportTarget("opencode", document, project, commands, env);
  const plan = await planNativeImport(
    data,
    project,
    "legacy",
    store.sessions.id("claude-code", "source"),
    fingerprintSessionDocument(document),
    "opencode",
    document,
    snapshot,
  );
  const envelope = {
    changeSet: plan.change_set,
    launchRequest: plan.launch_request,
    approveHome: true,
  };
  const receipt = path.join(path.dirname(plan.change_set.changes[0]!.target), "receipt.json");
  const proceed = () =>
    continueNativeImport(envelope, sessions, store.sessions, store, data, env, commands);
  const recover = () => reconcileNativeImport(data, plan.launch_request, commands, env, store);
  return {
    store,
    document,
    exported,
    plan,
    receipt,
    proceed,
    recover,
    attempts: () => attempts,
    loseReply: () => {
      lost = true;
    },
    launch: () => nativeImportLaunchInfo(data, plan.launch_request, commands, env, () => {}),
  };
}

describe("native import durable reconciliation", () => {
  it("reconciles a lost reply and lost receipt without repeating the import", async () => {
    const f = await fixture();
    f.loseReply();
    await expect(f.proceed()).rejects.toBeInstanceOf(NativeImportOutcomeUnknownError);
    expect(f.attempts()).toBe(1);
    await f.recover();
    const first = JSON.parse(readFileSync(f.receipt, "utf8"));
    expect(first.verified).toBe(true);
    unlinkSync(f.receipt);
    await f.recover();
    await f.recover();
    expect(JSON.parse(readFileSync(f.receipt, "utf8")).target_session_id).toBe(
      first.target_session_id,
    );
    expect(f.attempts()).toBe(1);
    expect(await f.launch()).toMatchObject({ targetSessionId: first.target_session_id });
  });
  it("refuses changed imported text and preserves the unresolved attempt", async () => {
    const f = await fixture();
    f.loseReply();
    await expect(f.proceed()).rejects.toBeInstanceOf(NativeImportOutcomeUnknownError);
    const record = JSON.parse(readFileSync(f.exported, "utf8"));
    record.messages[1].parts[0].text = "externally modified";
    writeFileSync(f.exported, JSON.stringify(record));
    await expect(f.recover()).rejects.toThrow("text differs");
    expect(f.attempts()).toBe(1);
    expect(readFileSync(f.exported, "utf8")).toContain("externally modified");
    expect(() => readFileSync(f.receipt)).toThrow();
  });
  it("rejects ownership collisions before looking up a pending target", async () => {
    const f = await fixture();
    f.loseReply();
    await expect(f.proceed()).rejects.toBeInstanceOf(NativeImportOutcomeUnknownError);
    const clone = path.join(path.dirname(f.exported), "clone");
    mkdirSync(clone);
    f.store.sql.run(
      "INSERT INTO workspaces(id,canonical_path,name,manifest_workspace_id,status,last_discovered_at) VALUES(?,?,?,?,?,?)",
      "clone",
      clone,
      "Clone",
      "legacy",
      "healthy",
      "2026-10-07T00:00:00Z",
    );
    await expect(f.recover()).rejects.toThrow();
    expect(f.attempts()).toBe(1);
    expect(() => readFileSync(f.receipt)).toThrow();
  });
});
