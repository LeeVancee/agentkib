import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Commands } from "../../../packages/backend/src/commands";
import { Context } from "../../../packages/backend/src/context";
import { McpManager, mcpToolCacheKey } from "../../../packages/backend/src/mcp";
import { McpBuiltins } from "../../../packages/backend/src/mcp-builtin";
import { McpHub } from "../../../packages/backend/src/mcp-hub";
import { McpOAuth } from "../../../packages/backend/src/mcp-oauth";
import type { McpServer } from "../../../packages/backend/src/mcp-config-read";
import {
  mcpToolAllowed,
  requireContinuationToolPolicy,
  type McpToolPolicyRule,
} from "../../../packages/backend/src/mcp-policy";
import { BackendStore } from "../../../packages/backend/src/store";

const requireBackend = createRequire(
  new URL("../../../packages/backend/package.json", import.meta.url),
);
const { Client } = requireBackend("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = requireBackend(
  "@modelcontextprotocol/sdk/client/streamableHttp.js",
);
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "agentkib-tool-policy-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"),
    project = path.join(root, "project"),
    project2 = path.join(root, "project2"),
    data = path.join(root, "data");
  for (const directory of [home, project, project2]) mkdirSync(directory);
  const environment = { HOME: home, USERPROFILE: home };
  const store = new BackendStore(path.join(data, "agentkib.db"));
  cleanups.push(() => store.close());
  for (const [id, directory] of [
    ["one", project],
    ["two", project2],
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
  const manager = new McpManager(store.sql, environment, data, commands);
  cleanups.push(() => manager.closeAsync());
  const script = path.join(root, "server.cjs"),
    events = path.join(root, "events");
  writeFileSync(
    script,
    `
const fs=require('node:fs'), readline=require('node:readline');
const events=process.argv[2], gate=process.argv[3];
const emit=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
const wait=(name,callback)=>{if(!fs.existsSync(gate+'.'+name)){callback();return;}const timer=setInterval(()=>{if(!fs.existsSync(gate+'.'+name)){clearInterval(timer);callback();}},5);};
readline.createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line); if(request.id===undefined)return;
if(request.method==='initialize') emit(request.id,{protocolVersion:request.params.protocolVersion,serverInfo:{name:'fixture',version:'1'},capabilities:{tools:{}}});
else if(request.method==='tools/list'){fs.appendFileSync(events,'list\\n');wait('list',()=>emit(request.id,{tools:(process.argv[4]?JSON.parse(process.argv[4]):['read','write']).map(name=>({name,inputSchema:{type:'object'},annotations:{readOnlyHint:name==='read'}}))}));}
else if(request.method==='tools/call'){fs.appendFileSync(events,'call:'+request.params.name+'\\n');wait('call',()=>emit(request.id,{content:[{type:'text',text:String(process.pid)}]}));}
else emit(request.id,{});});`,
  );
  const server: McpServer = {
    id: "fixture",
    name: "Fixture",
    enabled: true,
    transport: "stdio",
    command: process.execPath,
    args: [script, events, path.join(root, "gate")],
    env: {},
    headers: {},
    targets: [],
    allow_tools: [],
    lan_allow_tools: ["read"],
    supports_parallel_tool_calls: false,
  };
  manager.save(server);
  const eventList = () =>
    existsSync(events) ? readFileSync(events, "utf8").trim().split("\n") : [];
  const waitForEvent = async (event: string, count = 1) => {
    const start = Date.now();
    while (eventList().filter((item) => item === event).length < count) {
      if (Date.now() - start > 3000) throw new Error(`Fixture event missing: ${event}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  return {
    root,
    home,
    project,
    project2,
    data,
    environment,
    store,
    commands,
    manager,
    server,
    eventList,
    waitForEvent,
    policy(rules: McpToolPolicyRule[], scope: string | undefined = project) {
      return manager.savePolicy({ revision: manager.getPolicy(scope).revision, rules }, scope);
    },
    gate(name: string) {
      writeFileSync(path.join(root, `gate.${name}`), "hold");
    },
    release(name: string) {
      rmSync(path.join(root, `gate.${name}`));
    },
  };
}
function selected(
  agent: McpToolPolicyRule["agent"],
  server_id: string | null,
  tools: string[],
): McpToolPolicyRule {
  return { agent, server_id, mode: "selected", tools };
}
async function hubClient(f: ReturnType<typeof fixture>, agent = "codex") {
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address();
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("Fixture port unavailable");
  const hub = new McpHub(
    f.manager,
    f.store,
    new McpBuiltins(f.store, new Context(f.store.catalog, f.commands, f.environment), f.data),
    new McpOAuth(f.manager, () => address.port),
    { port: address.port, lan_enabled: false, lan_risk_accepted: false },
  );
  await hub.start();
  cleanups.push(() => hub.close());
  const client = new Client({ name: "policy-fixture", version: "1" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}/mcp/v1/workspaces/one/agents/${agent}`),
  );
  await client.connect(transport);
  cleanups.push(async () => {
    await transport.terminateSession().catch(() => undefined);
    await client.close();
  });
  return client;
}

describe("MCP Agent tool policies", () => {
  it("supports global inheritance, explicit empty selection and revision-checked safe saves", () => {
    const f = fixture();
    f.manager.savePolicy({
      revision: f.manager.getPolicy().revision,
      rules: [selected("codex", "fixture", ["read"])],
    });
    const state = f.manager.getPolicy(f.project);
    expect(mcpToolAllowed(state, "codex", "fixture", "write")).toBe(false);
    f.policy([selected("codex", "fixture", [])]);
    expect(mcpToolAllowed(f.manager.getPolicy(f.project), "codex", "fixture", "read")).toBe(false);
    f.policy([{ agent: "codex", server_id: "fixture", mode: "inherit", tools: [] }]);
    expect(mcpToolAllowed(f.manager.getPolicy(f.project), "codex", "fixture", "read")).toBe(true);
    const stale = f.manager.getPolicy(f.project);
    appendFileSync(path.join(f.home, ".agentkib/mcp.json"), " ");
    expect(() => f.manager.savePolicy({ revision: stale.revision, rules: [] }, f.project)).toThrow(
      "changed",
    );
    expect(f.eventList()).toEqual([]);
    f.store.sql.run(
      "INSERT INTO workspaces(id,canonical_path,name,manifest_workspace_id,status,last_discovered_at) VALUES(?,?,?,?,?,?)",
      "home-scope",
      f.home,
      "Home",
      "home-scope",
      "healthy",
      new Date().toISOString(),
    );
    expect(() => f.manager.getPolicy(f.home)).toThrow("overlaps");
  });

  it("rejects unsafe or malformed policy files and keeps explicit archive restrictions", () => {
    const f = fixture();
    f.policy([selected("codex", null, ["asset_list"])]);
    expect(() => requireContinuationToolPolicy(f.project, "codex", f.environment)).toThrow(
      "session_search",
    );
    const file = path.join(f.project, ".agentkib/mcp-policy.json");
    const original = readFileSync(file, "utf8");
    expect(() =>
      f.manager.savePolicy(
        {
          revision: f.manager.getPolicy(f.project).revision,
          rules: [{ ...selected("codex", null, []), unknown: true }],
        },
        f.project,
      ),
    ).toThrow();
    expect(readFileSync(file, "utf8")).toBe(original);
    if (process.platform === "win32") {
      // Directory junctions exercise the reparse-point boundary without requiring
      // Windows developer mode or elevated privileges to create a file symlink.
      rmSync(path.dirname(file), { recursive: true });
      symlinkSync(path.join(f.home, ".agentkib"), path.dirname(file), "junction");
    } else {
      rmSync(file);
      symlinkSync(path.join(f.home, ".agentkib/mcp.json"), file);
    }
    expect(() => f.manager.getPolicy(f.project)).toThrow("unsafe");
  });

  it("keeps raw scoped catalogs, ignores legacy cache, and updates exposure without another probe", async () => {
    const f = fixture();
    f.store.sql.run(
      "INSERT INTO mcp_tool_cache VALUES(?,?,?,?)",
      "fixture",
      "legacy",
      JSON.stringify({ server_id: "fixture", name: "legacy" }),
      new Date().toISOString(),
    );
    expect(
      f.manager.getPolicy(f.project).catalog.find((item) => item.server_id === "fixture")?.probed,
    ).toBe(false);
    f.manager.save({ ...f.server, allow_tools: ["read"] });
    await f.manager.probe("fixture", f.project);
    expect(f.manager.cachedTools("fixture", f.project).map((item) => item.name)).toEqual([
      "read",
      "write",
    ]);
    expect(f.manager.hubTools(f.project, "codex", false).map((item) => item.name)).toEqual([
      "fixture__read",
    ]);
    expect(f.manager.cachedTools("fixture", f.project2)).toEqual([]);
    f.manager.save(f.server);
    f.policy([selected("codex", "fixture", ["write"])]);
    expect(f.manager.hubTools(f.project, "codex", false).map((item) => item.name)).toEqual([
      "fixture__write",
    ]);
    expect(f.manager.hubTools(f.project, "claude-code", false)).toHaveLength(2);
    expect(f.manager.hubTools(f.project, "codex", true)).toEqual([]);
    expect(f.eventList()).toEqual(["list"]);
    expect(mcpToolCacheKey(f.server, f.project, f.environment)).not.toBe(
      mcpToolCacheKey(f.server, f.project2, f.environment),
    );
    const first = await f.manager.callHubTool(f.project, "claude-code", "fixture__read", {}, false);
    const second = await f.manager.callHubTool(
      f.project2,
      "claude-code",
      "fixture__read",
      {},
      false,
    );
    expect(first).not.toEqual(second); // distinct native process IDs, even for identical config
    f.manager.save({ ...f.server, args: [...f.server.args, "changed"] });
    expect(
      f.manager.getPolicy(f.project).catalog.find((item) => item.server_id === "fixture")?.probed,
    ).toBe(false);
  });

  it("enforces builtin and upstream policies on an already initialized real Hub transport", async () => {
    const f = fixture();
    await f.manager.probe("fixture", f.project);
    const client = await hubClient(f);
    expect((await client.listTools()).tools.map((item: { name: string }) => item.name)).toContain(
      "fixture__write",
    );
    f.policy([selected("codex", null, ["asset_list"]), selected("codex", "fixture", ["read"])]);
    expect((await client.listTools()).tools.map((item: { name: string }) => item.name)).toEqual([
      "asset_list",
      "fixture__read",
    ]);
    expect((await client.callTool({ name: "session_search", arguments: {} })).isError).toBe(true);
    expect((await client.callTool({ name: "fixture__write", arguments: {} })).isError).toBe(true);
    expect(f.eventList()).toEqual(["list"]);
  });

  it("rechecks revocation after startup and before queued calls are actually dispatched", async () => {
    const f = fixture();
    f.gate("list");
    const starting = f.manager.callHubTool(f.project, "codex", "fixture__write", {}, false);
    const startupRejected = expect(starting).rejects.toThrow("policy");
    await f.waitForEvent("list");
    f.policy([selected("codex", "fixture", ["read"])]);
    f.release("list");
    await startupRejected;
    expect(f.eventList()).toEqual(["list"]);
    f.policy([]);
    f.gate("call");
    const first = f.manager.callHubTool(f.project, "codex", "fixture__read", {}, false);
    await f.waitForEvent("call:read");
    const second = f.manager.callHubTool(f.project, "codex", "fixture__write", {}, false);
    const rejected = expect(second).rejects.toThrow("policy");
    f.policy([selected("codex", "fixture", ["read"])]);
    f.release("call");
    await Promise.all([first, rejected]);
    expect(f.eventList()).toEqual(["list", "call:read"]);
  });

  it("rejects a queued Hub call if its registered workspace is removed during the preceding action", async () => {
    const f = fixture();
    await f.manager.probe("fixture", f.project);
    f.gate("call");
    const client = await hubClient(f);
    const first = client.callTool({ name: "fixture__read", arguments: {} });
    await f.waitForEvent("call:read");
    // Call directly with the same authoritative recheck used by Hub after queue waits.
    const second = f.manager.callHubTool(f.project, "codex", "fixture__write", {}, false, () => {
      if (!f.store.getWorkspace("one")) throw new Error("Workspace removed");
    });
    const rejected = expect(second).rejects.toThrow("Workspace does not exist");
    f.store.sql.run("DELETE FROM workspaces WHERE id='one'");
    f.release("call");
    await Promise.all([first, rejected]);
    expect(f.eventList()).toEqual(["list", "call:read"]);
  });

  it("restarts one workspace without interrupting another workspace's same-named service", async () => {
    const f = fixture();
    const firstPid = await f.manager.callHubTool(f.project, "codex", "fixture__read", {}, false);
    const secondPid = await f.manager.callHubTool(f.project2, "codex", "fixture__read", {}, false);
    f.gate("call");
    const inFlight = f.manager.callHubTool(f.project2, "codex", "fixture__read", {}, false);
    await f.waitForEvent("call:read", 3);
    await f.manager.restart("fixture", f.project);
    f.release("call");
    expect(await inFlight).toEqual(secondPid);
    expect(await f.manager.callHubTool(f.project2, "codex", "fixture__read", {}, false)).toEqual(
      secondPid,
    );
    expect(await f.manager.callHubTool(f.project, "codex", "fixture__read", {}, false)).not.toEqual(
      firstPid,
    );
    f.manager.stop("fixture");
    expect(f.manager.runtimes().filter((runtime) => runtime.state === "running")).toEqual([]);
  });

  it("resolves existing service IDs containing the separator by the exact discovered tool", async () => {
    const f = fixture();
    f.manager.save({ ...f.server, id: "fixture__nested", name: "Nested" });
    await f.manager.probe("fixture", f.project);
    await f.manager.probe("fixture__nested", f.project);
    expect(f.manager.hubTools(f.project, "codex", false).map((tool) => tool.name)).toContain(
      "fixture__nested__read",
    );
    const parentPid = await f.manager.callHubTool(f.project, "codex", "fixture__read", {}, false);
    const nestedPid = await f.manager.callHubTool(
      f.project,
      "codex",
      "fixture__nested__read",
      {},
      false,
    );
    expect(nestedPid).not.toEqual(parentPid);
    f.policy([selected("codex", "fixture__nested", [])]);
    await expect(
      f.manager.callHubTool(f.project, "codex", "fixture__nested__read", {}, false),
    ).rejects.toThrow("policy");
  });

  it("hides colliding public tool names and rejects direct calls without routing to either service", async () => {
    const f = fixture();
    f.manager.save({ ...f.server, args: [...f.server.args, JSON.stringify(["nested__read"])] });
    f.manager.save({
      ...f.server,
      id: "fixture__nested",
      name: "Nested",
      args: [...f.server.args, JSON.stringify(["read"])],
    });
    await f.manager.probe("fixture", f.project);
    await f.manager.probe("fixture__nested", f.project);
    expect(f.manager.hubTools(f.project, "codex", false)).toEqual([]);
    await expect(
      f.manager.callHubTool(f.project, "codex", "fixture__nested__read", {}, false),
    ).rejects.toThrow("Ambiguous");
    // Disabling one namespace must not turn an old, ambiguous name into a call to the other.
    f.manager.save({ ...f.manager.getPrivate("fixture__nested")!, enabled: false });
    await expect(
      f.manager.callHubTool(f.project, "codex", "fixture__nested__read", {}, false),
    ).rejects.toThrow("Ambiguous");
    expect(f.eventList()).toEqual(["list", "list"]);
  });

  it("rechecks newly overlapping namespaces before a queued call is dispatched", async () => {
    const f = fixture();
    f.manager.save({
      ...f.server,
      args: [...f.server.args, JSON.stringify(["read", "nested__read"])],
    });
    await f.manager.probe("fixture", f.project);
    f.gate("call");
    const first = f.manager.callHubTool(f.project, "codex", "fixture__read", {}, false);
    await f.waitForEvent("call:read");
    const second = f.manager.callHubTool(f.project, "codex", "fixture__nested__read", {}, false);
    const rejected = expect(second).rejects.toThrow("Ambiguous");
    f.manager.save({ ...f.server, id: "fixture__nested", name: "Unprobed overlapping namespace" });
    f.release("call");
    await Promise.all([first, rejected]);
    expect(f.eventList()).toEqual(["list", "call:read"]);
  });
});
