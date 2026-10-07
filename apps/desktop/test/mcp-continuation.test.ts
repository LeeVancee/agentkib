import { createRequire } from "node:module";
import { createServer } from "node:net";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { applyRequest } from "../../../packages/backend/src/changes";
import { Commands } from "../../../packages/backend/src/commands";
import * as commandResolution from "../../../packages/backend/src/command-resolution";
import { Context } from "../../../packages/backend/src/context";
import { McpManager } from "../../../packages/backend/src/mcp";
import { McpBuiltins } from "../../../packages/backend/src/mcp-builtin";
import { planMcpConnection } from "../../../packages/backend/src/mcp-connection";
import { McpHub } from "../../../packages/backend/src/mcp-hub";
import { McpOAuth } from "../../../packages/backend/src/mcp-oauth";
import {
  prepareSessionHandoff,
  continuationMcpAvailable,
} from "../../../packages/backend/src/session-continuation";
import { planSessionHandoff } from "../../../packages/backend/src/session-handoff-plan";
import { applySessionHandoff } from "../../../packages/backend/src/session-handoff-apply";
import { prepareHandoffLaunch } from "../../../packages/backend/src/session-handoff-launch";
import { listNativeImports } from "../../../packages/backend/src/session-native-imports";
import type { SessionDocument } from "../../../packages/backend/src/session-model";
import { BackendStore } from "../../../packages/backend/src/store";
import { requireUniqueContinuationWorkspace } from "../../../packages/backend/src/workspace-identity";

const requireBackend = createRequire(
  new URL("../../../packages/backend/package.json", import.meta.url),
);
const { Client } = requireBackend("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = requireBackend(
  "@modelcontextprotocol/sdk/client/streamableHttp.js",
);
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function fixture(target: "codex" | "claude-code" = "codex", legacy = "manifest-workspace") {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "agentkib-mcp-continuation-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project"),
    home = path.join(root, "home"),
    data = path.join(root, "data");
  mkdirSync(project);
  mkdirSync(home);
  const environment = { HOME: home, USERPROFILE: home, PATH: path.join(root, "no-agent-bin") };
  const store = new BackendStore(path.join(data, "store.db"));
  cleanups.push(() => store.close());
  const registered = "registered-workspace";
  function register(id: string, manifest = legacy, directory = path.join(root, id)) {
    mkdirSync(directory, { recursive: true });
    store.sql.run(
      "INSERT INTO workspaces(id, canonical_path, name, manifest_workspace_id, status, last_discovered_at) VALUES(?,?,?,?,?,?)",
      id,
      directory,
      id,
      manifest,
      "healthy",
      "2026-10-07T00:00:00Z",
    );
  }
  register(registered, legacy, project);
  const nativeRef = path.join(home, "synthetic-history.jsonl");
  store.sessions.sync(registered, "claude-code", [
    {
      native_ref: nativeRef,
      agent: "claude-code",
      title: "Synthetic archive",
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
  const sessionId = store.sessions.id("claude-code", nativeRef);
  const document: SessionDocument = {
    schema_version: 1,
    source: { agent: "claude-code", workspace_id: registered },
    turns: [
      {
        id: "old",
        role: "user",
        blocks: [
          { type: "text", text: "archive-only-marker " + "Long source text. ".repeat(10000) },
        ],
      },
      {
        id: "latest",
        role: "assistant",
        blocks: [{ type: "text", text: "Current project decision" }],
      },
    ],
    losses: [],
    redaction_count: 0,
  };
  const sessions = { document: async () => structuredClone(document) };
  const commands = new Commands();
  vi.spyOn(commandResolution, "resolveCommand").mockReturnValue(null);
  cleanups.push(() => commands.close());
  const run = vi
    .spyOn(commands, "run")
    .mockRejectedValue(new Error("Real Agent execution forbidden"));
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const port = address.port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const manager = new McpManager(store.sql, environment, data, commands);
  cleanups.push(() => manager.closeAsync());
  const builtins = new McpBuiltins(store, new Context(store.catalog, commands, environment), data);
  const hub = new McpHub(manager, store, builtins, new McpOAuth(manager, () => port), {
    port,
    lan_enabled: false,
    lan_risk_accepted: false,
  });
  await hub.start();
  cleanups.push(() => hub.close());
  const connection = planMcpConnection(
    { workspaceId: registered, targetAgent: target },
    store,
    hub.status(),
    environment,
  );
  applyRequest({ changeSet: connection, approveHome: false }, store, data, environment);
  async function prepare() {
    const result = await prepareSessionHandoff(
      {
        request: {
          session_id: sessionId,
          target_agent: target,
          format: "markdown",
          history_budget_tokens: 64000,
        },
        mcpHubStatus: hub.status(),
      },
      sessions,
      store.sessions,
      store,
      commands,
      environment,
    );
    return z
      .object({
        draft: z.object({
          filename: z.string(),
          source_fingerprint: z.string(),
          archive_id: z.string(),
          mcp_available: z.boolean(),
          window_strategy: z.string(),
        }),
      })
      .parse(result).draft;
  }
  async function plan(draft: Awaited<ReturnType<typeof prepare>>) {
    return planSessionHandoff(
      {
        workspaceId: registered,
        sessionId,
        targetAgent: target,
        format: "markdown",
        mode: "handoff-file",
        filename: draft.filename,
        sourceFingerprint: draft.source_fingerprint,
        acceptLosses: true,
        historyBudgetTokens: 64000,
        archiveId: draft.archive_id,
        mcpHubStatus: hub.status(),
      },
      sessions,
      store.sessions,
      store,
      data,
      environment,
      commands,
    );
  }
  const apply = (planned: Awaited<ReturnType<typeof plan>>) =>
    applySessionHandoff(
      { changeSet: planned.change_set, launchRequest: planned.launch_request, approveHome: false },
      store,
      data,
      environment,
    );
  async function connected(
    id: string,
    use: (client: InstanceType<typeof Client>) => Promise<void>,
  ) {
    const client = new Client({ name: "continuation-fixture", version: "1" });
    const transport = new StreamableHTTPClientTransport(
      new URL(
        `http://127.0.0.1:${port}/mcp/v1/workspaces/${encodeURIComponent(id)}/agents/${target}`,
      ),
    );
    try {
      await client.connect(transport);
      await use(client);
    } finally {
      await transport.terminateSession().catch(() => undefined);
      await client.close();
    }
  }
  return {
    root,
    project,
    data,
    environment,
    store,
    registered,
    legacy,
    document,
    commands,
    run,
    port,
    hub,
    builtins,
    connection,
    register,
    prepare,
    plan,
    apply,
    connected,
  };
}

describe("MCP continuation workspace ownership", () => {
  it.each(["codex", "claude-code"] as const)(
    "%s: connection plan/apply → prepare → handoff plan/apply → real Hub read",
    async (target) => {
      const f = await fixture(target);
      const draft = await f.prepare();
      expect(draft).toMatchObject({ mcp_available: true, window_strategy: "windowed" });
      const planned = await f.plan(draft);
      f.apply(planned);
      for (const route of [f.registered, f.legacy]) {
        await f.connected(route, async (client) => {
          const search = await client.callTool({
            name: "session_search",
            arguments: { archive_id: draft.archive_id, query: "archive-only-marker" },
          });
          expect(search.isError).not.toBe(true);
          expect(search.structuredContent.hits[0].content).toContain("archive-only-marker");
          const chunk = await client.callTool({
            name: "session_read_chunk",
            arguments: { archive_id: draft.archive_id, chunk_id: "chunk-000001" },
          });
          expect(chunk.isError).not.toBe(true);
          expect(chunk.structuredContent.content).toContain("archive-only-marker");
        });
      }
      expect(f.run).not.toHaveBeenCalled();
      const manifest = planned.change_set.changes.find(
        (change) => path.basename(change.target) === "manifest.json",
      )!;
      expect(JSON.parse(readFileSync(manifest.target, "utf8"))).toMatchObject({
        workspace_id: f.legacy,
        source_fingerprint: draft.source_fingerprint,
      });
    },
  );

  it("accepts only an unambiguous legacy endpoint for the selected physical workspace", async () => {
    const f = await fixture("claude-code", "manifest'()!");
    const config = f.connection.changes[0]!.target;
    writeFileSync(
      config,
      JSON.stringify({
        mcpServers: {
          agentkib: {
            type: "http",
            url: `http://localhost:${f.port}/mcp/v1/workspaces/${encodeURIComponent(f.legacy)}/agents/claude-code`,
          },
        },
      }),
    );
    expect((await f.prepare()).mcp_available).toBe(true);
    f.register("other-workspace", "other-manifest");
    writeFileSync(
      config,
      JSON.stringify({
        mcpServers: {
          agentkib: {
            type: "http",
            url: `http://localhost:${f.port}/mcp/v1/workspaces/other-workspace/agents/claude-code`,
          },
        },
      }),
    );
    expect((await f.prepare()).mcp_available).toBe(false);
  });

  it("rejects shared ownership before planning and before any apply writes", async () => {
    const f = await fixture();
    const draft = await f.prepare();
    const planned = await f.plan(draft);
    f.register("clone");
    expect((await f.prepare()).mcp_available).toBe(false);
    await expect(f.plan(draft)).rejects.toThrow(/ownership is ambiguous/);
    expect(() => f.apply(planned)).toThrow(/ambiguous/i);
    expect(() =>
      applyRequest(
        { changeSet: planned.change_set, approveHome: false },
        f.store,
        f.data,
        f.environment,
      ),
    ).toThrow(/ownership is ambiguous/);
    for (const change of planned.change_set.changes) expect(existsSync(change.target)).toBe(false);
    expect(() => listNativeImports(f.data, f.store, f.registered)).toThrow(
      /ownership is ambiguous/,
    );
    await expect(
      prepareHandoffLaunch(planned.launch_request, f.store, f.commands, f.environment, f.data),
    ).rejects.toThrow(/ambiguous/i);
    expect(f.run).not.toHaveBeenCalled();
  });

  it("rechecks both archive tools after a clone appears on an initialized registered connection", async () => {
    const f = await fixture();
    const draft = await f.prepare();
    f.apply(await f.plan(draft));
    await f.connected(f.registered, async (client) => {
      f.register("clone");
      expect(
        (await client.listTools()).tools.some(
          (tool: { name: string }) => tool.name === "asset_list",
        ),
      ).toBe(true);
      for (const name of ["session_search", "session_read_chunk"]) {
        const result = await client.callTool({
          name,
          arguments: { archive_id: draft.archive_id, chunk_id: "chunk-000001" },
        });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).toContain("ownership is ambiguous");
        expect(JSON.stringify(result)).not.toContain("archive-only-marker");
      }
      const ordinary = await client.callTool({ name: "asset_list", arguments: {} });
      expect(ordinary.isError).not.toBe(true);
    });
  });

  it("preserves source fingerprint validation and rejects registered/legacy collisions", async () => {
    const f = await fixture();
    const draft = await f.prepare();
    f.document.turns[0]!.blocks = [{ type: "text", text: "Changed after preview" }];
    await expect(f.plan(draft)).rejects.toThrow(/changed after/);
    f.register(f.legacy, "different-manifest");
    expect(() => requireUniqueContinuationWorkspace(f.store, f.registered)).toThrow(/ambiguous/);
    expect(continuationMcpAvailable(f.project, "codex", f.registered, f.port, f.store)).toBe(false);
    await expect(
      prepareHandoffLaunch(
        {
          mode: "handoff-file",
          workspace_id: f.legacy,
          target_agent: "codex",
          filename: "previous.md",
        },
        f.store,
        f.commands,
        f.environment,
        f.data,
      ),
    ).rejects.toThrow(/operation workspace identity changed/);
    expect(f.run).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")(
    "does not reinterpret an initialized workspace snapshot after its directory becomes a link",
    async () => {
      const f = await fixture();
      const draft = await f.prepare();
      f.apply(await f.plan(draft));
      const other = path.join(f.root, "other");
      mkdirSync(other);
      await f.connected(f.registered, async (client) => {
        renameSync(f.project, path.join(f.root, "original-project"));
        symlinkSync(other, f.project);
        expect(() => requireUniqueContinuationWorkspace(f.store, f.registered, f.project)).toThrow(
          /workspace path changed/,
        );
        await expect(
          client.callTool({
            name: "session_read_chunk",
            arguments: { archive_id: draft.archive_id, chunk_id: "chunk-000001" },
          }),
        ).rejects.toMatchObject({ code: 400 });
        // Even a refreshed registration must not rebind an already initialized connection.
        f.store.sql.run("UPDATE workspaces SET canonical_path=? WHERE id=?", other, f.registered);
        expect(() => requireUniqueContinuationWorkspace(f.store, f.registered, f.project)).toThrow(
          /workspace path changed/,
        );
        await expect(client.listTools()).rejects.toMatchObject({ code: 404 });
      });
    },
  );
});
