import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { applyRequest } from "../../../packages/backend/src/changes";
import { Commands } from "../../../packages/backend/src/commands";
import { McpManager } from "../../../packages/backend/src/mcp";
import { McpManagement } from "../../../packages/backend/src/mcp-management";
import { planNativeMcpMigration } from "../../../packages/backend/src/mcp-migration-plan";
import { scanNativeMcp } from "../../../packages/backend/src/mcp-native-scan";
import { BackendStore } from "../../../packages/backend/src/store";
import { canonicalize } from "../../../packages/backend/src/paths";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const root = canonicalize(mkdtempSync(path.join(os.tmpdir(), "agentkib-mcp-migration-alias-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"),
    project = path.join(root, "project"),
    data = path.join(root, "data"),
    source = path.join(home, ".hermes/config.yaml");
  mkdirSync(path.dirname(source), { recursive: true });
  mkdirSync(path.join(project, ".agentkib"), { recursive: true });
  writeFileSync(
    path.join(project, ".agentkib/manifest.yaml"),
    "schema_version: 2\nworkspace:\n  id: registered\n  name: fixture\n",
  );
  const environment = { HOME: home, USERPROFILE: home };
  const methods: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    methods.push(message.method);
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: message.params.protocolVersion,
            serverInfo: { name: "migration-fixture", version: "1" },
            capabilities: { tools: {} },
          }
        : { tools: [{ name: "read", inputSchema: { type: "object" } }] };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture port unavailable");
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const store = new BackendStore(path.join(data, "db.sqlite"));
  cleanups.push(() => store.close());
  store.sql.run(
    "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
    "registered",
    project,
    "fixture",
    "healthy",
    new Date().toISOString(),
  );
  const commands = new Commands();
  cleanups.push(() => commands.close());
  const manager = new McpManager(store.sql, environment, data, commands);
  cleanups.push(() => manager.closeAsync());
  const management = new McpManagement(store, environment, data, manager);
  const hub = { running: true, port: 47653 };
  const candidates = () =>
    scanNativeMcp({ project }, store, environment).filter((item) => item.agent === "hermes");
  const prepare = async (mode: "legacy" | "collected") => {
    const candidate = candidates().find((item) => item.name === "tool")!;
    expect(candidate.supported).toBe(true);
    if (mode === "legacy") {
      const plan = await planNativeMcpMigration(
        { project, candidateIds: [candidate.id], mcpHubStatus: hub },
        store,
        manager,
        environment,
      );
      return () => applyRequest({ changeSet: plan, approveHome: true }, store, data, environment);
    }
    const preview = management.previewImport({ project, candidateIds: [candidate.id] });
    management.applyImport({
      project,
      token: preview.token,
      revision: preview.revision,
      selections: [{ key: candidate.id, action: "add" }],
    });
    const state = management.state({ project });
    management.save({
      project,
      revision: state.revision,
      originalId: "tool",
      server: { ...state.servers[0]!.config, enabled: true },
    });
    await manager.probe("tool", project);
    const migration = await management.previewMigration(
      { project, revision: management.state({ project }).revision, candidateIds: [candidate.id] },
      hub,
    );
    return () => management.applyMigration({ token: migration.token, approveHome: true }, hub);
  };
  return { source, url, candidates, methods, prepare };
}

describe.each(["legacy", "collected"] as const)("Hermes %s migration with YAML aliases", (mode) => {
  it.each(["MCP map is anchor", "MCP map is alias"])(
    "preserves other fields and unselected services when %s",
    async (direction) => {
      const f = await fixture();
      const servers = `  tool:\n    url: ${f.url}\n  untouched:\n    url: https://fixture.invalid/other\n`;
      const before =
        direction === "MCP map is anchor"
          ? `model: fixture\nmcp_servers: &servers\n${servers}extensions:\n  saved_servers: *servers\n`
          : `model: fixture\nextensions: &extensions\n  saved_servers: &servers\n${servers
              .split("\n")
              .filter(Boolean)
              .map((line) => `  ${line}\n`)
              .join("")}other_extensions: *extensions\nmcp_servers: *servers\n`;
      writeFileSync(f.source, before);
      const apply = await f.prepare(mode);
      expect(readFileSync(f.source, "utf8")).toBe(before);
      apply();
      const original = parseYaml(before),
        actual = parseYaml(readFileSync(f.source, "utf8"));
      expect(actual).toEqual({
        ...original,
        mcp_servers: {
          untouched: original.mcp_servers.untouched,
          agentkib: {
            url: "http://127.0.0.1:47653/mcp/v1/workspaces/registered/agents/hermes",
          },
        },
      });
      expect(f.candidates().map((candidate) => candidate.name)).toEqual(["untouched"]);
      expect(f.methods).toContain("initialize");
      expect(f.methods).toContain("tools/list");
      expect(f.methods).not.toContain("tools/call");
    },
  );

  it("rejects a changed aliased source between preview and apply", async () => {
    const f = await fixture(),
      before = `mcp_servers: &servers\n  tool:\n    url: ${f.url}\nextensions:\n  saved_servers: *servers\n`;
    writeFileSync(f.source, before);
    const apply = await f.prepare(mode),
      changed = `${before}externally_added: true\n`;
    writeFileSync(f.source, changed);
    expect(apply).toThrow(/changed|modified/);
    expect(readFileSync(f.source, "utf8")).toBe(changed);
  });
});

describe("Hermes invalid YAML remains ineligible for migration", () => {
  it.each([
    ["duplicate field", "mcp_servers: {}\nmcp_servers: {}\n"],
    [
      "recursive service",
      "mcp_servers:\n  tool: &tool\n    url: https://fixture.invalid/mcp\n    extra: *tool\n",
    ],
    [
      "alias expansion",
      "a: &a [x, x, x, x, x, x, x, x, x, x]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]\nc: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]\nmcp_servers: {tool: {url: https://fixture.invalid/mcp}}\nd: [*c, *c, *c]\n",
    ],
  ])("keeps %s blocked without probing or editing the source", async (_name, before) => {
    const f = await fixture();
    writeFileSync(f.source, before);
    expect(f.candidates().every((candidate) => !candidate.supported)).toBe(true);
    expect(f.methods).toEqual([]);
    expect(readFileSync(f.source, "utf8")).toBe(before);
  });
});
