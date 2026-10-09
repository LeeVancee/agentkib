import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Commands } from "../../../packages/backend/src/commands";
import { McpManager } from "../../../packages/backend/src/mcp";
import type { McpServer } from "../../../packages/backend/src/mcp-config-read";
import { BackendStore } from "../../../packages/backend/src/store";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "agentkib-mcp-runtime-scope-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"),
    project = path.join(root, "project"),
    otherProject = path.join(root, "other-project"),
    data = path.join(root, "data");
  for (const directory of [home, project, otherProject]) mkdirSync(directory);
  const store = new BackendStore(path.join(data, "agentkib.db"));
  cleanups.push(() => store.close());
  for (const [id, directory] of [
    ["one", project],
    ["two", otherProject],
  ])
    store.sql.run(
      "INSERT INTO workspaces(id,canonical_path,name,manifest_workspace_id,status,last_discovered_at) VALUES(?,?,?,?,?,?)",
      id!,
      directory!,
      id!,
      id!,
      "healthy",
      new Date().toISOString(),
    );
  const commands = new Commands();
  cleanups.push(() => commands.close());
  const manager = new McpManager(store.sql, { HOME: home, USERPROFILE: home }, data, commands);
  cleanups.push(() => manager.closeAsync());
  const script = path.join(root, "server.cjs");
  writeFileSync(
    script,
    `
const readline = require("node:readline");
const emit = (id, result) => process.stdout.write(JSON.stringify({jsonrpc: "2.0", id, result}) + "\\n");
readline.createInterface({input: process.stdin}).on("line", line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === "initialize") emit(request.id, {
    protocolVersion: request.params.protocolVersion,
    serverInfo: {name: "scope-fixture", version: "1"}, capabilities: {tools: {}}
  });
  else if (request.method === "tools/list") {
    if (process.argv[2] === "fail") process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: request.id, error: {code: -32603, message: "Fixture listing failed"}
    }) + "\\n");
    else emit(request.id, {tools: [{name: "read", inputSchema: {type: "object"}}]});
  }
  else if (request.method === "tools/call") emit(request.id, {
    content: [{type: "text", text: String(process.pid)}]
  });
  else emit(request.id, {});
});`,
  );
  const server: McpServer = {
    id: "fixture",
    name: "Fixture",
    enabled: true,
    transport: "stdio",
    command: process.execPath,
    args: [script],
    env: {},
    headers: {},
    targets: [],
    allow_tools: [],
    lan_allow_tools: [],
    supports_parallel_tool_calls: false,
  };
  manager.save(server);
  return {
    manager,
    server,
    project,
    otherProject,
    call: (scope?: string) => manager.callTool(server, "read", {}, scope),
  };
}

describe("MCP runtime scope ownership", () => {
  it("reports canonical ownership and restarts only the selected instance while preserving legacy stop", async () => {
    const f = fixture();
    const globalBefore = await f.call();
    const projectBefore = await f.call(`${f.project}${path.sep}.`);
    const otherBefore = await f.call(f.otherProject);
    const runtimes = f.manager.runtimes();
    expect(runtimes).toHaveLength(3);
    expect(runtimes.map((item) => item.project)).toEqual([null, f.project, f.otherProject]);
    expect(runtimes.every((item) => item.state === "running")).toBe(true);
    expect(new Set(runtimes.map((item) => item.config_hash)).size).toBe(3);

    const projectInstance = runtimes.find((item) => item.project === f.project)!;
    await f.manager.restart(projectInstance.server_id, projectInstance.project ?? undefined);
    const projectAfter = await f.call(f.project);
    expect(projectAfter).not.toEqual(projectBefore);
    expect(await f.call()).toEqual(globalBefore);
    expect(await f.call(f.otherProject)).toEqual(otherBefore);

    const globalInstance = runtimes.find((item) => item.project === null)!;
    await f.manager.restart(globalInstance.server_id, globalInstance.project ?? undefined);
    expect(await f.call()).not.toEqual(globalBefore);
    expect(await f.call(f.project)).toEqual(projectAfter);
    expect(await f.call(f.otherProject)).toEqual(otherBefore);
    expect(f.manager.runtimes().filter((item) => item.state === "running")).toHaveLength(3);

    f.manager.stop(f.server.id);
    expect(f.manager.runtimes().map((item) => [item.project, item.state])).toEqual([
      [null, "stopped"],
      [f.project, "stopped"],
      [f.otherProject, "stopped"],
    ]);
  });

  it("keeps the owning workspace on failed runtime records", async () => {
    const f = fixture();
    f.manager.save({ ...f.server, args: [...f.server.args, "fail"] }, f.project);
    await expect(f.manager.probe(f.server.id, `${f.project}${path.sep}.`)).rejects.toThrow(
      "Fixture listing failed",
    );
    expect(f.manager.runtimes()).toEqual([
      expect.objectContaining({ server_id: f.server.id, project: f.project, state: "error" }),
    ]);
  });
});
