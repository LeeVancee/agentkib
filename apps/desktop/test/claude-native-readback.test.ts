import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeProjectKey } from "../../../packages/backend/src/claude-project-path";
import {
  launchPreparedHandoff,
  verifyNativeSession,
  type PreparedHandoffLaunch,
} from "../../../packages/backend/src/session-handoff-launch";
import {
  CLAUDE_RECORD_SCHEMA_VERSION,
  renderNative,
} from "../../../packages/backend/src/session-handoff-plan";
import type { SessionDocument } from "../../../packages/backend/src/session-model";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const document = {
  turns: [
    { role: "user", timestamp: "2026-10-13T00:00:00.000Z", blocks: [{ type: "text", text: "hi" }] },
    {
      role: "assistant",
      timestamp: "2026-10-13T00:00:01.000Z",
      blocks: [{ type: "text", text: "hello" }],
    },
    { role: "user", timestamp: "2026-10-13T00:00:02.000Z", blocks: [{ type: "text", text: "go" }] },
  ],
} as unknown as SessionDocument;

type Record_ = Record<string, unknown>;

/** A session written by the real renderer into a synthetic projects directory. */
function written() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "agentkib-readback-")));
  roots.push(root);
  const workspace = path.join(root, "work space");
  const projects = path.join(root, "claude", "projects");
  const key = claudeProjectKey(workspace);
  if (!key.ok) throw new Error("key");
  const directory = path.join(projects, key.key);
  const sessionId = randomUUID();
  const file = path.join(directory, `${sessionId}.jsonl`);
  const records = renderNative(
    document,
    "claude-code",
    sessionId,
    workspace,
    "2026-10-13T00:00:00.000Z",
    "notice",
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record_);
  const put = (rows: Record_[], target = file) => {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
    return target;
  };
  const expected = { sessionId, workspace, directory };
  return { root, workspace, projects, directory, sessionId, file, records, put, expected };
}

describe("Claude native import read-back", () => {
  it("accepts what the renderer wrote and stamps the documented schema version", () => {
    const w = written();
    w.put(w.records);
    expect(() => verifyNativeSession(w.file, "claude-code", w.expected)).not.toThrow();
    const messages = w.records.filter((record) => record.type !== "last-prompt");
    expect(messages).toHaveLength(4);
    expect(messages.every((record) => record.version === CLAUDE_RECORD_SCHEMA_VERSION)).toBe(true);
  });

  it("refuses to judge a Claude session without the launch's expectation", () => {
    const w = written();
    w.put(w.records);
    expect(() => verifyNativeSession(w.file, "claude-code")).toThrow(/expectation is missing/);
  });

  const message = (records: Record_[], index = 1) => records[index]!;
  const corruptions: Array<[string, RegExp, (w: ReturnType<typeof written>) => string]> = [
    [
      "a repeated uuid",
      /repeats a uuid/,
      (w) => {
        message(w.records, 2).uuid = message(w.records, 1).uuid;
        return w.put(w.records);
      },
    ],
    [
      "a dangling parentUuid",
      /dangling or out-of-order parentUuid/,
      (w) => {
        message(w.records, 2).parentUuid = randomUUID();
        return w.put(w.records);
      },
    ],
    [
      "a parentUuid on the first message",
      /dangling or out-of-order parentUuid/,
      (w) => {
        message(w.records, 0).parentUuid = randomUUID();
        return w.put(w.records);
      },
    ],
    [
      "a different sessionId",
      /different sessionId/,
      (w) => {
        message(w.records, 2).sessionId = randomUUID();
        return w.put(w.records);
      },
    ],
    [
      "a different cwd",
      /different cwd/,
      (w) => {
        message(w.records, 2).cwd = path.join(w.root, "elsewhere");
        return w.put(w.records);
      },
    ],
    [
      "a file outside the derived project directory",
      /project directory/,
      (w) => w.put(w.records, path.join(w.projects, "-other", `${w.sessionId}.jsonl`)),
    ],
    [
      "a file name that differs from the session id",
      /file name/,
      (w) => w.put(w.records, path.join(w.directory, `${randomUUID()}.jsonl`)),
    ],
    [
      "a malformed JSON line",
      /not valid JSON/,
      (w) => {
        w.put(w.records);
        const text = JSON.stringify(w.records[0]) + "\n{not json\n";
        writeFileSync(w.file, text);
        return w.file;
      },
    ],
    [
      "an unexpected record type",
      /unexpected record type/,
      (w) => {
        w.records.splice(2, 0, { type: "mystery", sessionId: w.sessionId });
        return w.put(w.records);
      },
    ],
    [
      "a probe-rejected first record",
      /format probe rejected/,
      (w) => {
        // The chain and identity stay valid; only the record shape the CLI expects is gone.
        delete message(w.records, 0).message;
        return w.put(w.records);
      },
    ],
    [
      "a last-prompt that points elsewhere",
      /last-prompt/,
      (w) => {
        w.records.at(-1)!.leafUuid = randomUUID();
        return w.put(w.records);
      },
    ],
    [
      "an empty file",
      /empty/,
      (w) => {
        mkdirSync(w.directory, { recursive: true });
        writeFileSync(w.file, "");
        return w.file;
      },
    ],
  ];

  it.each(corruptions)("fails on %s", (_name, reason, corrupt) => {
    const w = written();
    const file = corrupt(w);
    expect(() => verifyNativeSession(file, "claude-code", w.expected)).toThrow(reason);
  });

  describe("at launch", () => {
    function launch(w: ReturnType<typeof written>) {
      const home = path.join(w.root, "home");
      const environment = {
        HOME: home,
        USERPROFILE: home,
        CLAUDE_CONFIG_DIR: path.join(w.root, "claude"),
      } as NodeJS.ProcessEnv;
      const prepared = {
        request: {
          mode: "native-session",
          workspace_id: "workspace",
          target_agent: "claude-code",
          target_session_id: w.sessionId,
          target_path: w.file,
        },
        terminal: { kind: "macos", executable: "/nonexistent-terminal" },
        command: { executable: "/nonexistent-claude", arguments: [], cwd: w.workspace },
        workspace: w.workspace,
        validateOwnership: () => {},
      } as PreparedHandoffLaunch;
      return launchPreparedHandoff(prepared, path.join(w.root, "data"), environment);
    }

    it("reaches the terminal step for a sound session", async () => {
      const w = written();
      w.put(w.records);
      // Only the nonexistent stub terminal stops it, after the read-back passed.
      await expect(launch(w)).rejects.toThrow(/ENOENT|spawn/);
    });

    it("stops before any terminal is opened when the read-back fails", async () => {
      const w = written();
      w.records[2]!.parentUuid = randomUUID();
      w.put(w.records);
      await expect(launch(w)).rejects.toThrow(/Claude session read-back failed/);
    });

    it("stops when the workspace's project directory cannot be derived", async () => {
      const w = written();
      w.put(w.records);
      const long = { ...w, workspace: path.join(w.root, "x".repeat(300)) };
      await expect(launch(long)).rejects.toThrow(/project directory cannot be determined/);
    });
  });
});
