import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as commandResolution from "../../../packages/backend/src/command-resolution";
import { Commands } from "../../../packages/backend/src/commands";
import { canonicalize } from "../../../packages/backend/src/paths";
import { prepareSessionHandoff } from "../../../packages/backend/src/session-continuation";
import { readClaudeDocument } from "../../../packages/backend/src/session-document-providers";
import { planSessionHandoff } from "../../../packages/backend/src/session-handoff-plan";
import type { DocumentOptions } from "../../../packages/backend/src/session-model";
import { BackendStore } from "../../../packages/backend/src/store";
import type { CursorBridge } from "../../../packages/backend/src/cursor-bridge";
import { jsonlLines, specificationSession } from "./fixtures/claude-compaction-session";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
});

type Loss = { code: string; count: number };
const cursorBinding = "00000000-0000-4000-8000-0000000000bb";
type Draft = {
  mode: string;
  target_fingerprint?: string;
  filename: string;
  format: "markdown";
  content: string;
  source_fingerprint: string;
  include_pre_compaction_history: boolean;
  losses: Loss[];
};

/**
 * A registered workspace plus a hand-built compacted Claude transcript. `sessions.document` reads
 * that transcript with the real provider and records the options it was asked to apply.
 */
function fixture(target: "codex" | "claude-code" | "cursor" = "codex") {
  const root = canonicalize(mkdtempSync(path.join(os.tmpdir(), "claude-compaction-handoff-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project"),
    home = path.join(root, "home"),
    data = path.join(root, "data"),
    claudeHome = path.join(root, "claude-config");
  mkdirSync(project);
  mkdirSync(home);
  mkdirSync(path.join(claudeHome, "projects"), { recursive: true });
  const environment: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: claudeHome,
    CODEX_HOME: path.join(root, "codex-home"),
    PATH: path.join(root, "no-agent-bin"),
  };
  const store = new BackendStore(path.join(data, "store.db"));
  cleanups.push(() => store.close());
  store.sql.run(
    "INSERT INTO workspaces(id, canonical_path, name, manifest_workspace_id, status, last_discovered_at) VALUES(?,?,?,?,?,?)",
    "workspace",
    project,
    "workspace",
    "workspace",
    "healthy",
    "2026-10-13T00:00:00Z",
  );
  const nativeRef = path.join(root, "synthetic-source.jsonl");
  store.sessions.sync("workspace", "claude-code", [
    {
      native_ref: nativeRef,
      agent: "claude-code",
      title: "Synthetic source",
      created_at: null,
      updated_at: null,
      message_count: 7,
      git_branch: null,
      archived: false,
      sidechain: false,
      availability: "readable",
      origin: "interactive",
    },
  ]);
  const sessionId = store.sessions.id("claude-code", nativeRef);
  const transcript = path.join(root, "transcript.jsonl");
  writeFileSync(transcript, jsonlLines(specificationSession()));
  const requested: Array<DocumentOptions | undefined> = [];
  const sessions = {
    async document(_id: string, options?: DocumentOptions) {
      requested.push(options);
      return readClaudeDocument(
        {
          workspace_id: "workspace",
          agent: "claude-code",
          title: "Synthetic source",
          created_at: null,
          updated_at: null,
          git_branch: null,
        },
        transcript,
        false,
        options,
      );
    },
  };
  const commands = new Commands();
  cleanups.push(() => commands.close());
  // Without a resolvable CLI the continuation falls back to a context file; with one, the CLI is a stub.
  const resolve = vi.spyOn(commandResolution, "resolveCommand").mockReturnValue(null);
  if (target === "claude-code") {
    resolve.mockImplementation((name) => path.join(root, "bin", name));
    vi.spyOn(commands, "run").mockImplementation(async (_program, args) => {
      if (args.length !== 1 || args[0] !== "--version")
        throw new Error("Real Agent execution forbidden");
      return {
        bytes: Buffer.from("2.1.296 (Claude Code)\n"),
        error: "",
        success: true,
        truncated: false,
        exitCode: 0,
      };
    });
  }
  const hub = { running: false, port: 4010 };
  // A Cursor IDE target needs a connected window; only its context and (no) profiles are read here.
  const bridge = {
    context: () => ({ binding_id: cursorBinding, profile: "synthetic" }),
    profiles: () => [],
  } as unknown as CursorBridge;
  const prepare = async (extra: Record<string, unknown> = {}) =>
    (
      (await prepareSessionHandoff(
        {
          request: {
            session_id: sessionId,
            target_agent: target,
            format: "markdown",
            history_budget_tokens: 64000,
            ...extra,
          },
          mcpHubStatus: hub,
        },
        sessions,
        store.sessions,
        store,
        commands,
        environment,
        target === "cursor" ? bridge : undefined,
      )) as { draft: Draft }
    ).draft;
  const plan = (draft: Draft, extra: Record<string, unknown> = {}) =>
    planSessionHandoff(
      {
        workspaceId: "workspace",
        sessionId,
        targetAgent: target,
        format: "markdown",
        mode: draft.mode,
        filename: draft.filename,
        editedContent: draft.content,
        sourceFingerprint: draft.source_fingerprint,
        acceptLosses: true,
        historyBudgetTokens: 64000,
        archiveId: null,
        mcpHubStatus: hub,
        ...extra,
      },
      sessions,
      store.sessions,
      store,
      data,
      environment,
      commands,
      target === "cursor" ? bridge : undefined,
    );
  return { project, claudeHome, requested, prepare, plan };
}

describe("compacted Claude session handoff", () => {
  it("prepares the context summary plus later messages and requires acknowledging what is left out", async () => {
    const f = fixture();
    const draft = await f.prepare();
    expect(draft.include_pre_compaction_history).toBe(false);
    expect(draft.losses).toEqual([{ code: "compacted-history", count: 3 }]);
    expect(draft.content).toContain("### Context summary");
    expect(draft.content).toContain("not a message written by the user");
    expect(draft.content).toContain("delta-answer");
    expect(draft.content).not.toContain("alpha-question");
    expect(draft.content).not.toContain("### Compaction boundary");
    expect(f.requested).toEqual([undefined]);

    await expect(f.plan(draft, { acceptLosses: false })).rejects.toThrow(
      "Continuation losses must be acknowledged",
    );
    const planned = await f.plan(draft);
    const written = planned.change_set.changes.find((change) => change.target.endsWith(".md"))!;
    expect(written.after).toContain("### Context summary");
    expect(written.after).not.toContain("alpha-question");
    expect(f.requested).toEqual([undefined, undefined, undefined]);
  });

  it("includes the earlier history with boundary markers only when asked", async () => {
    const f = fixture();
    const draft = await f.prepare({ include_pre_compaction_history: true });
    expect(draft.include_pre_compaction_history).toBe(true);
    expect(draft.losses).toEqual([]);
    for (const text of [
      "alpha-question",
      "charlie-question",
      "### Compaction boundary",
      "### Context summary",
      "echo-question",
    ])
      expect(draft.content).toContain(text);
    expect(draft.content.indexOf("charlie-question")).toBeLessThan(
      draft.content.indexOf("### Compaction boundary"),
    );

    const planned = await f.plan(draft, { includePreCompactionHistory: true });
    expect(
      planned.change_set.changes.find((change) => change.target.endsWith(".md"))!.after,
    ).toContain("alpha-question");
    expect(f.requested).toEqual([
      { includePreCompactionHistory: true },
      { includePreCompactionHistory: true },
    ]);
  });

  it("rejects a plan whose history choice differs from the reviewed preview", async () => {
    const f = fixture();
    const defaults = await f.prepare();
    await expect(f.plan(defaults, { includePreCompactionHistory: true })).rejects.toThrow(
      "Conversation changed after the continuation preview was prepared",
    );
    const included = await f.prepare({ include_pre_compaction_history: true });
    await expect(f.plan(included)).rejects.toThrow(
      "Conversation changed after the continuation preview was prepared",
    );
    await expect(f.plan(included, { includePreCompactionHistory: false })).rejects.toThrow(
      "Conversation changed after the continuation preview was prepared",
    );
  });

  it("rejects a non-boolean history option before reading anything", async () => {
    const f = fixture();
    await expect(f.prepare({ include_pre_compaction_history: "yes" })).rejects.toThrow();
    const draft = await f.prepare();
    const reads = f.requested.length;
    await expect(f.plan(draft, { includePreCompactionHistory: "yes" })).rejects.toThrow();
    expect(f.requested).toHaveLength(reads);
  });

  it.each([false, true])(
    "records the history choice in a Cursor IDE plan only when it was made (%s)",
    async (include) => {
      const f = fixture("cursor");
      const surface = { target_surface: "cursor-ide", binding_id: cursorBinding };
      const draft = await f.prepare({
        ...surface,
        ...(include ? { include_pre_compaction_history: true } : {}),
      });
      expect(draft.mode).toBe("native-session");
      const planned = await f.plan(draft, {
        targetSurface: "cursor-ide",
        bindingId: cursorBinding,
        targetFingerprint: draft.target_fingerprint,
        ...(include ? { includePreCompactionHistory: true } : {}),
      });
      const stored = JSON.parse(planned.change_set.changes[0]!.after);
      expect(Object.hasOwn(stored, "include_pre_compaction_history")).toBe(include);
      expect(JSON.stringify(stored.document).includes("alpha-question")).toBe(include);
      expect(f.requested.at(-1)).toEqual(
        include ? { includePreCompactionHistory: true } : undefined,
      );
    },
  );

  it("writes the annotated summary into a native Claude session as a user record", async () => {
    const f = fixture("claude-code");
    const draft = await f.prepare();
    expect(draft.mode).toBe("native-session");
    const planned = await f.plan(draft);
    const written = planned.change_set.changes[0]!;
    const records = written.after
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, any>);
    const summary = records.find((record) =>
      JSON.stringify(record.message?.content).includes("SUMMARY-BODY"),
    )!;
    expect(summary.type).toBe("user");
    expect(summary.message.content[0].text).toMatch(
      /^\[AgentKib: context summary generated by Claude Code/,
    );
    expect(JSON.stringify(records)).not.toContain("alpha-question");
  });
});
