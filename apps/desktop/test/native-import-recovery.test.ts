import {
  existsSync,
  mkdtempSync,
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
import { canonicalize } from "../../../packages/backend/src/paths";
import { fingerprintSessionDocument } from "../../../packages/backend/src/session-handoff";
import type { SessionDocument } from "../../../packages/backend/src/session-model";
import type { NativeSession } from "../../../packages/backend/src/session-store";
import { HandoffWork } from "../../../packages/backend/src/handoff-work";
import {
  executeHandoffRead,
  type HandoffReadKind,
  type HandoffReadInput,
  type HandoffReadOutput,
} from "../../../packages/backend/src/handoff-read-tasks";
import { TaskContext, type TaskWorkspace } from "../../../packages/backend/src/task-executor";
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
  const root = canonicalize(mkdtempSync(path.join(os.tmpdir(), "native-recovery-")));
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
  const nativeSource: NativeSession = {
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
  };
  store.sessions.sync("registered", "claude-code", [nativeSource]);
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
  let beforeSourceRead: (() => void) | undefined;
  const sessions = {
    document: async () => {
      beforeSourceRead?.();
      return structuredClone(document);
    },
  };
  const executable = path.join(root, "opencode");
  writeFileSync(executable, "fixture", { mode: 0o755 });
  vi.spyOn(resolution, "resolveCommand").mockReturnValue(executable);
  const commands = new Commands();
  cleanup.push(() => commands.close());
  let attempts = 0,
    lost = false;
  let beforeCommand: ((args: string[]) => void) | undefined;
  const exported = path.join(root, "export.json");
  vi.spyOn(commands, "run").mockImplementation(async (_program, args) => {
    beforeCommand?.(args);
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
    reindexSource: () => store.sessions.sync("replacement", "claude-code", [nativeSource]),
    onSourceRead: (action: () => void) => {
      beforeSourceRead = action;
    },
    onCommand: (action: (args: string[]) => void) => {
      beforeCommand = action;
    },
    replaceOwner: () => {
      const otherProject = path.join(root, "other-project");
      mkdirSync(otherProject);
      store.sql.run(
        "UPDATE workspaces SET canonical_path=?, manifest_workspace_id=? WHERE id=?",
        otherProject,
        "other-legacy",
        "registered",
      );
      store.sql.run(
        "INSERT INTO workspaces(id,canonical_path,name,manifest_workspace_id,status,last_discovered_at) VALUES(?,?,?,?,?,?)",
        "replacement",
        project,
        "Replacement",
        "legacy",
        "healthy",
        "2026-10-07T00:00:00Z",
      );
    },
    attempts: () => attempts,
    loseReply: () => {
      lost = true;
    },
    launch: () => nativeImportLaunchInfo(data, plan.launch_request, commands, env, () => {}),
  };
}

function localReadWork(onRead?: (kind: HandoffReadKind) => void) {
  return new (class extends HandoffWork {
    override async read<K extends HandoffReadKind>(
      kind: K,
      input: HandoffReadInput<K>,
      _task: TaskContext,
    ): Promise<HandoffReadOutput<K>> {
      const result = await executeHandoffRead(kind, input, this.commands);
      onRead?.(kind);
      return result;
    }
  })();
}

describe("native import durable reconciliation", () => {
  it("binds the owner before the first read even when the source is reindexed to its replacement", async () => {
    const f = await fixture();
    const work = localReadWork((kind) => {
      if (kind === "native-change") {
        f.replaceOwner();
        f.reindexSource();
      }
    });
    const task = new TaskContext({ id: "first-read", deadlineAt: Date.now() + 10_000 });
    try {
      await expect(work.run(task, f.proceed)).rejects.toThrow(/workspace identity changed/);
      expect(f.attempts()).toBe(0);
      expect(() => readFileSync(f.plan.change_set.changes[0]!.target)).toThrow();
      expect(() => readFileSync(f.receipt)).toThrow();
    } finally {
      task.dispose();
      await work.close();
    }
  });
  it("does not dispatch after the attempt marker commits under a replaced owner", async () => {
    const f = await fixture();
    const attempted = path.join(path.dirname(f.receipt), "attempted.json");
    const work = localReadWork();
    const task = new (class extends TaskContext {
      replaced = false;
      override async commit<T>(operation: () => Promise<T> | T, scope?: TaskWorkspace) {
        const result = await super.commit(operation, scope);
        if (!this.replaced && existsSync(attempted)) {
          this.replaced = true;
          f.replaceOwner();
        }
        return result;
      }
    })({ id: "attempt-commit", deadlineAt: Date.now() + 10_000 });
    try {
      await expect(work.run(task, f.proceed)).rejects.toBeInstanceOf(
        NativeImportOutcomeUnknownError,
      );
      expect(f.attempts()).toBe(0);
      expect(readFileSync(attempted, "utf8")).toBe(f.plan.launch_request.plan_hash);
      expect(() => readFileSync(f.exported)).toThrow();
      expect(() => readFileSync(f.receipt)).toThrow();
    } finally {
      task.dispose();
      await work.close();
    }
  });
  it.each(["source read", "version probe", "configuration probe"])(
    "rejects a replaced registered owner during %s before importing",
    async (stage) => {
      const f = await fixture();
      if (stage === "source read") f.onSourceRead(f.replaceOwner);
      else
        f.onCommand((args) => {
          if (args[0] === (stage === "version probe" ? "--version" : "debug")) f.replaceOwner();
        });
      await expect(f.proceed()).rejects.toThrow(/workspace identity changed/);
      expect(f.attempts()).toBe(0);
      expect(() => readFileSync(f.receipt)).toThrow();
      expect(() =>
        readFileSync(f.plan.change_set.changes[0]!.target.replace("plan.json", "attempted.json")),
      ).toThrow();
      if (stage === "source read")
        expect(() => readFileSync(f.plan.change_set.changes[0]!.target)).toThrow();
    },
  );
  it("keeps an imported target unresolved when its registered owner changes during readback", async () => {
    const f = await fixture();
    f.onCommand((args) => {
      if (args[0] === "export") f.replaceOwner();
    });
    await expect(f.proceed()).rejects.toBeInstanceOf(NativeImportOutcomeUnknownError);
    expect(f.attempts()).toBe(1);
    expect(readFileSync(f.exported, "utf8")).toContain("Unique source marker 83eac8");
    expect(() => readFileSync(f.receipt)).toThrow();
  });
  it.each(["version probe", "verified readback", "pending readback"])(
    "rejects owner replacement during recovery %s without importing again",
    async (stage) => {
      const f = await fixture();
      await f.proceed();
      let previousReceipt: Buffer | undefined;
      if (stage === "pending readback") unlinkSync(f.receipt);
      else previousReceipt = readFileSync(f.receipt);
      f.onCommand((args) => {
        if (args[0] === (stage === "version probe" ? "--version" : "export")) f.replaceOwner();
      });
      await expect(f.recover()).rejects.toThrow(/workspace identity changed/);
      expect(f.attempts()).toBe(1);
      if (previousReceipt) expect(readFileSync(f.receipt)).toEqual(previousReceipt);
      else expect(() => readFileSync(f.receipt)).toThrow();
    },
  );
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
