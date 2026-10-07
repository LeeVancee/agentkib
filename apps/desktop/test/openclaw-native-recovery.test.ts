import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as resolution from "../../../packages/backend/src/command-resolution";
import { Commands } from "../../../packages/backend/src/commands";
import { BackendStore } from "../../../packages/backend/src/store";
import { canonicalize } from "../../../packages/backend/src/paths";
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
import {
  assertContinuationWorkspaceIdentity,
  requireUniqueContinuationWorkspace,
} from "../../../packages/backend/src/workspace-identity";
import { HandoffWork } from "../../../packages/backend/src/handoff-work";
import {
  executeHandoffRead,
  type HandoffReadKind,
  type HandoffReadInput,
  type HandoffReadOutput,
} from "../../../packages/backend/src/handoff-read-tasks";
import { TaskContext, type TaskWorkspace } from "../../../packages/backend/src/task-executor";

const cleanup: Array<() => void> = [];
const timestamp = "2026-10-08T00:00:00Z";
const generation = "synthetic-generation";
const modules = [
  "agents.config-G5R7b0ly.mjs",
  "io.runtime-hPN4FOBi.mjs",
  "openclaw-agent-db.paths-C2YxM4Tj.mjs",
  "openclaw-state-db.paths-DYMh54HD.mjs",
  "embedded-state-lock-Cw9nQxv5.mjs",
  "openclaw-agent-db-CaQAStOA.mjs",
  "session-accessor.sqlite-entry-store-DTntRuil.mjs",
  "session-accessor.sqlite-transcript-store-CFksbmAY.mjs",
  "session-accessor.sqlite-read-DG0i0-yW.mjs",
  "openclaw-agent-db-readonly-IBx2zWDG.mjs",
];

afterEach(() => {
  vi.restoreAllMocks();
  for (const action of cleanup.splice(0).reverse()) action();
});

async function fixture() {
  const root = canonicalize(mkdtempSync(path.join(os.tmpdir(), "openclaw-recovery-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project"),
    data = path.join(root, "data"),
    home = path.join(root, "home"),
    packageRoot = path.join(root, "package"),
    agentDir = path.join(home, "agents/main/agent"),
    state = path.join(home, "state/openclaw.sqlite"),
    agentDatabase = path.join(agentDir, "openclaw-agent.sqlite"),
    config = path.join(home, "config.json");
  for (const directory of [project, path.join(packageRoot, "dist"), agentDir, path.dirname(state)])
    mkdirSync(directory, { recursive: true });
  const executable = path.join(packageRoot, "openclaw.mjs"),
    node = path.join(root, "node");
  writeFileSync(executable, "synthetic", { mode: 0o755 });
  writeFileSync(node, "synthetic", { mode: 0o755 });
  writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "openclaw", version: "2026.9.6" }),
  );
  writeFileSync(config, "{}");
  for (const name of modules)
    writeFileSync(path.join(packageRoot, "dist", name), "// synthetic module");
  for (const [file, role, version] of [
    [state, "global", 18],
    [agentDatabase, "agent", 23],
  ] as const) {
    const db = new DatabaseSync(file);
    try {
      db.exec(`PRAGMA user_version=${version};
        CREATE TABLE schema_meta(meta_key TEXT,role TEXT,schema_version INTEGER,agent_id TEXT,app_version TEXT);`);
      db.prepare("INSERT INTO schema_meta VALUES(?,?,?,?,?)").run(
        "primary",
        role,
        version,
        role === "agent" ? "main" : null,
        "2026.9.6",
      );
      if (role === "agent")
        db.exec("CREATE TABLE synthetic_imports(id TEXT PRIMARY KEY,events TEXT,generation TEXT)");
    } finally {
      db.close();
    }
  }
  const env = { HOME: home, USERPROFILE: home, PATH: root, OPENCLAW_HOME: home };
  const store = new BackendStore(path.join(data, "agentkib.db"));
  cleanup.push(() => store.close());
  store.sql.run(
    "INSERT INTO workspaces(id,canonical_path,name,manifest_workspace_id,status,last_discovered_at) VALUES(?,?,?,?,?,?)",
    "registered",
    project,
    "Synthetic",
    "legacy",
    "healthy",
    timestamp,
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
      { id: "u", role: "user", blocks: [{ type: "text", text: "Synthetic question 8ad932" }] },
      { id: "a", role: "assistant", blocks: [{ type: "text", text: "Keep the source history." }] },
    ],
    losses: [],
    redaction_count: 0,
  };
  const sessions = { document: async () => structuredClone(document) };
  const commands = new Commands();
  cleanup.push(() => commands.close());
  vi.spyOn(resolution, "resolveCommand").mockImplementation((program) =>
    program === "openclaw" ? executable : node,
  );
  let imports = 0,
    lostReply = false,
    beforeReadback: (() => void) | undefined;
  // Only the external CLI is synthetic; continuation, ownership, plan and receipt writes are real.
  vi.spyOn(commands, "run").mockImplementation(async (_program, args) => {
    let text: string;
    if (args[0] === executable) text = "OpenClaw 2026.9.6";
    else if (args[0] === "--version") text = "v22.23.3";
    else if (args[2]?.includes("const {s:path}")) text = JSON.stringify(state);
    else if (args[2]?.includes("const snapshot=await read"))
      text = JSON.stringify({
        entries: [{ id: "main", workspace: project, agentDir }],
        path: config,
        fingerprint: "a".repeat(64),
      });
    else if (args[2]?.includes("const p=JSON.parse(process.argv[1])")) {
      const request = JSON.parse(args[3]!) as {
        id: string;
        payload: string;
        probe: boolean;
        write: boolean;
      };
      if (request.probe) text = JSON.stringify({ ready: true });
      else {
        const db = new DatabaseSync(agentDatabase);
        try {
          if (request.write) {
            imports++;
            db.prepare("INSERT INTO synthetic_imports VALUES(?,?,?)").run(
              request.id,
              readFileSync(request.payload, "utf8"),
              generation,
            );
            if (lostReply) throw new Error("Reply lost after native commit");
          } else beforeReadback?.();
          const target = db
            .prepare("SELECT events,generation FROM synthetic_imports WHERE id=?")
            .get(request.id) as { events: string; generation: string } | undefined;
          if (!target) throw new Error("Synthetic OpenClaw target missing");
          text = JSON.stringify({
            events: JSON.parse(target.events),
            generation: target.generation,
          });
        } finally {
          db.close();
        }
      }
    } else throw new Error("Unexpected synthetic OpenClaw command");
    return { bytes: Buffer.from(text), success: true, truncated: false, error: "", exitCode: 0 };
  });
  const snapshot = await inspectNativeImportTarget("open-claw", document, project, commands, env);
  const plan = await planNativeImport(
    data,
    project,
    "legacy",
    store.sessions.id("claude-code", "source"),
    fingerprintSessionDocument(document),
    "open-claw",
    document,
    snapshot,
  );
  const directory = path.dirname(plan.change_set.changes[0]!.target),
    receipt = path.join(directory, "receipt.json"),
    marker = path.join(directory, "openclaw-generation"),
    attempted = path.join(directory, "attempted.json");
  const envelope = {
    changeSet: plan.change_set,
    launchRequest: plan.launch_request,
    approveHome: true,
  };
  const proceed = () =>
    continueNativeImport(envelope, sessions, store.sessions, store, data, env, commands);
  const recover = () => reconcileNativeImport(data, plan.launch_request, commands, env, store);
  const launch = () => {
    const identity = requireUniqueContinuationWorkspace(store, "legacy", project);
    return nativeImportLaunchInfo(data, plan.launch_request, commands, env, () =>
      assertContinuationWorkspaceIdentity(store, "legacy", identity),
    );
  };
  return {
    plan,
    receipt,
    marker,
    attempted,
    proceed,
    recover,
    launch,
    imports: () => imports,
    targets: () => {
      const db = new DatabaseSync(agentDatabase, { readOnly: true });
      try {
        return db.prepare("SELECT id,events,generation FROM synthetic_imports").all() as Array<{
          id: string;
          events: string;
          generation: string;
        }>;
      } finally {
        db.close();
      }
    },
    mutateTarget: (events: unknown[], targetGeneration = generation) => {
      const db = new DatabaseSync(agentDatabase);
      try {
        db.prepare("UPDATE synthetic_imports SET events=?,generation=? WHERE id=?").run(
          JSON.stringify(events),
          targetGeneration,
          plan.change_set.id,
        );
      } finally {
        db.close();
      }
    },
    onReadback: (action: () => void) => {
      beforeReadback = action;
    },
    loseReply: () => {
      lostReply = true;
    },
    replaceOwner: () => {
      const other = path.join(root, "other-project");
      mkdirSync(other);
      store.sql.run(
        "UPDATE workspaces SET canonical_path=?,manifest_workspace_id=? WHERE id=?",
        other,
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
        timestamp,
      );
    },
  };
}

function localReadWork() {
  return new (class extends HandoffWork {
    override async read<K extends HandoffReadKind>(
      kind: K,
      input: HandoffReadInput<K>,
      task: TaskContext,
    ): Promise<HandoffReadOutput<K>> {
      task.checkpoint();
      return executeHandoffRead(kind, input, this.commands);
    }
  })();
}

describe("OpenClaw native import durable reconciliation", () => {
  it("imports one target and keeps its identity through two recoveries", async () => {
    const f = await fixture();
    const imported = await f.proceed();
    expect(imported).toEqual({
      status: "verified",
      targetSessionId: f.plan.launch_request.operation_id,
    });
    const receipt = readFileSync(f.receipt),
      marker = readFileSync(f.marker);
    for (let attempt = 0; attempt < 2; attempt++)
      expect(await f.recover()).toEqual({
        targetSessionId: imported.targetSessionId,
        verified: true,
      });
    expect(f.imports()).toBe(1);
    expect(f.targets().map((target) => target.id)).toEqual([imported.targetSessionId]);
    expect(marker.toString("utf8")).toBe(generation);
    expect(readFileSync(f.marker)).toEqual(marker);
    expect(readFileSync(f.receipt)).toEqual(receipt);
  });

  it("does not persist generation or a receipt after its registered owner changes during first readback", async () => {
    const f = await fixture();
    f.onReadback(f.replaceOwner);
    await expect(f.proceed()).rejects.toBeInstanceOf(NativeImportOutcomeUnknownError);
    expect(f.imports()).toBe(1);
    expect(f.targets().map((target) => target.id)).toEqual([f.plan.launch_request.operation_id]);
    expect(readFileSync(f.attempted, "utf8")).toBe(f.plan.launch_request.plan_hash);
    expect(existsSync(f.receipt)).toBe(false);
    expect(existsSync(f.marker)).toBe(false);
  });

  it.each(["lost import reply", "lost receipt"] as const)(
    "recovers a %s twice without importing another target",
    async (stage) => {
      const f = await fixture();
      if (stage === "lost import reply") {
        f.loseReply();
        await expect(f.proceed()).rejects.toBeInstanceOf(NativeImportOutcomeUnknownError);
        expect(existsSync(f.marker)).toBe(false);
      } else {
        await f.proceed();
        unlinkSync(f.receipt);
      }
      expect(existsSync(f.receipt)).toBe(false);
      for (let attempt = 0; attempt < 2; attempt++)
        expect(await f.recover()).toEqual({
          targetSessionId: f.plan.launch_request.operation_id,
          verified: true,
        });
      expect(f.imports()).toBe(1);
      expect(f.targets().map((target) => target.id)).toEqual([f.plan.launch_request.operation_id]);
      expect(readFileSync(f.marker, "utf8")).toBe(generation);
      expect(JSON.parse(readFileSync(f.receipt, "utf8"))).toMatchObject({
        target_session_id: f.plan.launch_request.operation_id,
        verified: true,
        launched: false,
      });
    },
  );

  it.each(["lost import reply", "lost receipt"] as const)(
    "does not change generation or create a receipt after owner replacement during pending recovery of a %s",
    async (stage) => {
      const f = await fixture();
      if (stage === "lost import reply") {
        f.loseReply();
        await expect(f.proceed()).rejects.toBeInstanceOf(NativeImportOutcomeUnknownError);
      } else {
        await f.proceed();
        unlinkSync(f.receipt);
      }
      const previousMarker = existsSync(f.marker) ? readFileSync(f.marker) : null;
      const previousAttempt = readFileSync(f.attempted);
      f.onReadback(f.replaceOwner);
      await expect(f.recover()).rejects.toThrow(/workspace identity changed/);
      expect(f.imports()).toBe(1);
      expect(f.targets().map((target) => target.id)).toEqual([f.plan.launch_request.operation_id]);
      expect(readFileSync(f.attempted)).toEqual(previousAttempt);
      expect(existsSync(f.receipt)).toBe(false);
      if (previousMarker) expect(readFileSync(f.marker)).toEqual(previousMarker);
      else expect(existsSync(f.marker)).toBe(false);
    },
  );

  it("preserves an existing generation marker and verified receipt byte for byte after owner replacement during readback", async () => {
    const f = await fixture();
    await f.proceed();
    const receipt = readFileSync(f.receipt),
      marker = readFileSync(f.marker);
    f.onReadback(f.replaceOwner);
    await expect(f.recover()).rejects.toThrow(/workspace identity changed/);
    expect(f.imports()).toBe(1);
    expect(f.targets()).toHaveLength(1);
    expect(readFileSync(f.marker)).toEqual(marker);
    expect(readFileSync(f.receipt)).toEqual(receipt);
  });

  it("returns the verified launch target and rebuilds a lost generation marker without importing again", async () => {
    const f = await fixture();
    const imported = await f.proceed();
    const receipt = readFileSync(f.receipt);
    unlinkSync(f.marker);
    expect(await f.launch()).toMatchObject({
      targetSessionId: imported.targetSessionId,
      alreadyLaunched: false,
    });
    expect(readFileSync(f.marker, "utf8")).toBe(generation);
    expect(readFileSync(f.receipt)).toEqual(receipt);
    expect(f.imports()).toBe(1);
    expect(f.targets().map((target) => target.id)).toEqual([imported.targetSessionId]);
  });

  it("does not rebuild a lost generation marker after owner replacement during launch verification, preserving the receipt", async () => {
    const f = await fixture();
    await f.proceed();
    const receipt = readFileSync(f.receipt);
    unlinkSync(f.marker);
    f.onReadback(f.replaceOwner);
    await expect(f.launch()).rejects.toThrow(/workspace identity changed/);
    expect(existsSync(f.marker)).toBe(false);
    expect(readFileSync(f.receipt)).toEqual(receipt);
    expect(f.imports()).toBe(1);
    expect(f.targets()).toHaveLength(1);
  });

  it("rechecks the registered owner inside the local generation commit before writing", async () => {
    const f = await fixture();
    let readbackFinished = false;
    f.onReadback(() => {
      readbackFinished = true;
    });
    const work = localReadWork();
    const task = new (class extends TaskContext {
      replaced = false;
      override async commit<T>(operation: () => Promise<T> | T, scope?: TaskWorkspace) {
        if (readbackFinished && !this.replaced) {
          this.replaced = true;
          f.replaceOwner();
        }
        return super.commit(operation, scope);
      }
    })({ id: "openclaw-generation-commit", deadlineAt: Date.now() + 10_000 });
    try {
      await expect(work.run(task, f.proceed)).rejects.toBeInstanceOf(
        NativeImportOutcomeUnknownError,
      );
      expect(task.replaced).toBe(true);
      expect(f.imports()).toBe(1);
      expect(f.targets()).toHaveLength(1);
      expect(readFileSync(f.attempted, "utf8")).toBe(f.plan.launch_request.plan_hash);
      expect(existsSync(f.marker)).toBe(false);
      expect(existsSync(f.receipt)).toBe(false);
    } finally {
      task.dispose();
      await work.close();
    }
  });

  it("preserves a legally committed generation when the owner changes before the commit settles, without writing a receipt", async () => {
    const f = await fixture();
    const work = localReadWork();
    let committedMarker: Buffer | undefined;
    const task = new (class extends TaskContext {
      override async commit<T>(operation: () => Promise<T> | T, scope?: TaskWorkspace) {
        const result = await super.commit(operation, scope);
        if (!committedMarker && existsSync(f.marker)) {
          committedMarker = readFileSync(f.marker);
          f.replaceOwner();
        }
        return result;
      }
    })({ id: "openclaw-generation-settled", deadlineAt: Date.now() + 10_000 });
    try {
      await expect(work.run(task, f.proceed)).rejects.toBeInstanceOf(
        NativeImportOutcomeUnknownError,
      );
      expect(committedMarker?.toString("utf8")).toBe(generation);
      expect(readFileSync(f.marker)).toEqual(committedMarker);
      expect(existsSync(f.receipt)).toBe(false);
      expect(f.imports()).toBe(1);
      expect(f.targets()).toHaveLength(1);
    } finally {
      task.dispose();
      await work.close();
    }
  });

  it("accepts an appended target history while preserving the reviewed prefix and generation", async () => {
    const f = await fixture();
    await f.proceed();
    const events = JSON.parse(f.targets()[0]!.events) as Array<{
      id: string;
      [key: string]: unknown;
    }>;
    events.push({
      type: "message",
      id: "synthetic-follow-up",
      parentId: events.at(-1)!.id,
      timestamp,
      message: { role: "user", content: [{ type: "text", text: "Synthetic continuation" }] },
    });
    f.mutateTarget(events);
    const receipt = readFileSync(f.receipt),
      marker = readFileSync(f.marker);
    expect(await f.recover()).toEqual({
      targetSessionId: f.plan.launch_request.operation_id,
      verified: true,
    });
    expect(f.imports()).toBe(1);
    expect(f.targets()).toHaveLength(1);
    expect(readFileSync(f.marker)).toEqual(marker);
    expect(readFileSync(f.receipt)).toEqual(receipt);
  });

  it("rejects changed imported content during pending recovery without persisting verification files", async () => {
    const f = await fixture();
    f.loseReply();
    await expect(f.proceed()).rejects.toBeInstanceOf(NativeImportOutcomeUnknownError);
    const events = JSON.parse(f.targets()[0]!.events) as Array<{
      message?: { content: Array<{ type: string; text: string }> };
    }>;
    events[1]!.message!.content[0]!.text = "Externally changed synthetic question";
    f.mutateTarget(events);
    await expect(f.recover()).rejects.toThrow("history differs from reviewed events");
    expect(f.imports()).toBe(1);
    expect(existsSync(f.marker)).toBe(false);
    expect(existsSync(f.receipt)).toBe(false);
    expect(readFileSync(f.attempted, "utf8")).toBe(f.plan.launch_request.plan_hash);
  });

  it("rejects a changed target generation while preserving existing verification bytes", async () => {
    const f = await fixture();
    await f.proceed();
    const receipt = readFileSync(f.receipt),
      marker = readFileSync(f.marker);
    f.mutateTarget(JSON.parse(f.targets()[0]!.events) as unknown[], "rewritten-generation");
    await expect(f.recover()).rejects.toThrow("target transcript generation changed");
    expect(f.imports()).toBe(1);
    expect(f.targets()).toHaveLength(1);
    expect(readFileSync(f.marker)).toEqual(marker);
    expect(readFileSync(f.receipt)).toEqual(receipt);
  });
});
