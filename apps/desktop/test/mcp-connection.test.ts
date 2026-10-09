import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isAlias,
  isScalar,
  parse as parseYaml,
  parseDocument,
  stringify as stringifyYaml,
  visit,
} from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mcpConnectionInfo,
  planMcpConnection,
  verifyMcpConnection,
  MCP_CONNECTION_AGENTS,
  type McpConnectionAgent,
} from "../../../packages/backend/src/mcp-connection";
import { applyRequest } from "../../../packages/backend/src/changes";
import { hash } from "../../../packages/backend/src/doctor-files";
import type { BackendStore } from "../../../packages/backend/src/store";
import { canonicalize } from "../../../packages/backend/src/paths";
import * as files from "../../../packages/backend/src/files";

// Resolve backend-owned dependencies without adding them to the desktop package.
const requireBackend = createRequire(
  new URL("../../../packages/backend/package.json", import.meta.url),
);
const { parse: parseToml } = requireBackend("smol-toml");
const { Server } = requireBackend("@modelcontextprotocol/sdk/server/index.js");
const { StreamableHTTPServerTransport } = requireBackend(
  "@modelcontextprotocol/sdk/server/streamableHttp.js",
);
const { CallToolRequestSchema, ListToolsRequestSchema } = requireBackend(
  "@modelcontextprotocol/sdk/types.js",
);

const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(manifestId: string | null = "manifest-id") {
  const root = canonicalize(mkdtempSync(path.join(os.tmpdir(), "agentkib-mcp-connection-")));
  roots.push(root);
  const project = path.join(root, "project"),
    home = path.join(root, "home");
  mkdirSync(project);
  mkdirSync(home);
  const store = {
    getWorkspace(id: string) {
      if (id !== "registry-id") throw new Error("Workspace does not exist");
      return { id, path: project, manifest_workspace_id: manifestId };
    },
    workspacePath(id: string) {
      if (id !== "registry-id") throw new Error("Workspace does not exist");
      return project;
    },
    sql: { audit: vi.fn() },
  };
  const environment = { HOME: home, USERPROFILE: home };
  const hub = { running: true, port: 47653 };
  const request = (targetAgent: McpConnectionAgent) => ({
    workspaceId: "registry-id",
    targetAgent,
  });
  const info = (targetAgent: McpConnectionAgent) =>
    mcpConnectionInfo(request(targetAgent), store, hub, environment);
  const plan = (targetAgent: McpConnectionAgent) =>
    planMcpConnection(request(targetAgent), store, hub, environment);
  const apply = (changeSet: ReturnType<typeof plan>, approveHome = false) =>
    applyRequest(
      { changeSet, approveHome },
      store as unknown as BackendStore,
      path.join(root, "data"),
      environment,
    );
  return { root, project, home, store, environment, hub, request, info, plan, apply };
}
function write(target: string, content: string) {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}
function parsed(target: string, content: string) {
  return target.endsWith(".toml")
    ? parseToml(content)
    : target.endsWith(".yaml")
      ? parseYaml(content)
      : JSON.parse(content);
}

describe("MCP connection planning", () => {
  it.each(MCP_CONNECTION_AGENTS)(
    "creates only %s's connection and remains idempotent without a manifest",
    (agent) => {
      const f = fixture(null),
        info = f.info(agent),
        plan = f.plan(agent);
      expect(info).toMatchObject({
        workspace_id: "registry-id",
        target_agent: agent,
        hub_running: true,
      });
      expect(info.url).toBe(`http://127.0.0.1:47653/mcp/v1/workspaces/registry-id/agents/${agent}`);
      expect(plan.changes).toHaveLength(1);
      expect(plan.changes[0]).toMatchObject({
        target: info.target,
        scope: info.scope,
        original_hash: null,
      });
      expect(parsed(info.target, plan.changes[0]!.after)).toEqual(parsed(info.target, info.config));
      expect(plan.requires_home_approval).toBe(info.scope === "agent-home");
      f.apply(plan, info.scope === "agent-home");
      expect(f.plan(agent).changes).toEqual([]);
      expect(existsSync(path.join(f.project, "AGENTS.md"))).toBe(false);
      expect(existsSync(path.join(f.project, ".agentkib/manifest.yaml"))).toBe(false);
    },
  );

  it("uses the registered ID and rejects unregistered/read-only clients", () => {
    const f = fixture("manifest /'!");
    expect(f.info("cursor").workspace_id).toBe("registry-id");
    expect(f.info("cursor").url).toContain("/registry-id/agents/cursor");
    expect(() =>
      mcpConnectionInfo(
        { workspaceId: "missing", targetAgent: "cursor" },
        f.store,
        f.hub,
        f.environment,
      ),
    ).toThrow(/Workspace/);
    expect(() =>
      planMcpConnection(
        { workspaceId: "registry-id", targetAgent: "deepseek-harness" },
        f.store,
        f.hub,
        f.environment,
      ),
    ).toThrow();
    expect(() =>
      mcpConnectionInfo(f.request("cursor"), f.store, { running: false, port: 0 }, f.environment),
    ).toThrow(/settings/);
    expect(
      mcpConnectionInfo(
        f.request("cursor"),
        f.store,
        { running: false, port: 12345 },
        f.environment,
      ).hub_running,
    ).toBe(false);
  });

  it.each(MCP_CONNECTION_AGENTS)("keeps default HTTP port 80 idempotent for %s", (agent) => {
    const f = fixture();
    f.hub.port = 80;
    f.apply(f.plan(agent), f.info(agent).scope === "agent-home");
    expect(f.plan(agent).changes).toEqual([]);
  });

  it("uses OpenCode's existing JSONC path while preserving instructions and other MCP servers", () => {
    const f = fixture(),
      target = path.join(f.project, "opencode.jsonc");
    write(
      target,
      `// existing config\n{ instructions: ['own.md'], mcp: { other: { type: 'local', command: ['node', 'own.js'] } }, model: 'fixture', }`,
    );
    expect(f.info("opencode").target).toBe(target);
    const plan = f.plan("opencode"),
      value = JSON.parse(plan.changes[0]!.after);
    expect(value.instructions).toEqual(["own.md"]);
    expect(value.mcp.other.command).toEqual(["node", "own.js"]);
    expect(value.mcp.agentkib).toEqual({
      type: "remote",
      url: f.info("opencode").url,
      enabled: true,
    });
    expect(plan.changes[0]!.validator).toBe("jsonc");
  });

  it("reads OpenClaw JSON5 and preserves unrelated values and gateway extension fields", () => {
    const f = fixture(),
      info = f.info("open-claw");
    write(
      info.target,
      `{ // OpenClaw supports JSON5\n model: 'fixture', mcp: { servers: { other: { command: 'own' }, agentkib: { url: 'http://127.0.0.1:10000/mcp/v1/workspaces/old/agents/open-claw', transport: 'streamable-http', timeout: 60, headers: { test: 'keep' }, tools: { include: ['own'] }, }, } }, }`,
    );
    const value = JSON.parse(f.plan("open-claw").changes[0]!.after);
    expect(value.model).toBe("fixture");
    expect(value.mcp.servers.other).toEqual({ command: "own" });
    expect(value.mcp.servers.agentkib).toMatchObject({
      url: info.url,
      timeout: 60,
      headers: { test: "keep" },
      tools: { include: ["own"] },
    });
  });

  it("accepts Claude Code's HTTP alias while preserving its existing settings", () => {
    const f = fixture(),
      info = f.info("claude-code");
    write(
      info.target,
      JSON.stringify({
        mcpServers: {
          agentkib: {
            type: "streamable-http",
            url: info.url,
            timeout: 42,
          },
        },
      }),
    );
    const value = JSON.parse(f.plan("claude-code").changes[0]!.after);
    expect(value.mcpServers.agentkib).toEqual({ type: "http", url: info.url, timeout: 42 });
  });

  it("updates Hermes MCP alone and preserves YAML comments and extension fields", () => {
    const f = fixture(),
      info = f.info("hermes");
    write(
      info.target,
      `# user settings\nmodel: fixture\nmcp_servers:\n  other:\n    command: own\n  agentkib:\n    url: http://localhost:10000/mcp/v1/workspaces/old/agents/hermes\n    timeout: 42\n    enabled_tools: [own]\n`,
    );
    const after = f.plan("hermes").changes[0]!.after,
      value = parseYaml(after);
    expect(after).toContain("# user settings");
    expect(value).toMatchObject({
      model: "fixture",
      mcp_servers: {
        other: { command: "own" },
        agentkib: { url: info.url, timeout: 42, enabled_tools: ["own"] },
      },
    });
    expect(value).not.toHaveProperty("external_skill_dirs");
  });

  it.each([
    {
      shape: "gateway anchor referenced by another server and an extension",
      before:
        "# user settings\nmodel: fixture\nmcp_servers:\n  agentkib: &gateway\n    # gateway settings\n    url: http://localhost:10000/mcp/v1/workspaces/old/agents/hermes\n    timeout: 42\n    enabled_tools: &tools [own]\n    disabled_tools: *tools\n  other: *gateway # retain old gateway\nextension: *gateway\ntool_defaults: *tools\n",
      comments: ["# gateway settings", "# retain old gateway"],
    },
    {
      shape: "gateway alias referencing shared defaults",
      before:
        "# user settings\ndefaults: &gateway\n  # shared gateway settings\n  url: http://localhost:10000/mcp/v1/workspaces/old/agents/hermes\n  timeout: 42\n  enabled_tools: &tools [own]\n  disabled_tools: *tools\nmcp_servers:\n  agentkib: *gateway # target alias\n  other: *gateway\ntool_defaults: *tools\n",
      comments: ["# shared gateway settings", "# target alias"],
    },
    {
      shape: "server collection alias referencing shared defaults",
      before:
        "# user settings\ndefaults: &servers\n  agentkib: &gateway\n    url: http://localhost:10000/mcp/v1/workspaces/old/agents/hermes\n    enabled_tools: &tools [own]\n    disabled_tools: *tools\n  other: *gateway\nmcp_servers: *servers # target collection\nextension: *servers\ntool_defaults: *tools\n",
      comments: ["# target collection"],
    },
    {
      shape: "server collection anchor referenced by an extension",
      before:
        "# user settings\nmcp_servers: &servers\n  agentkib:\n    url: http://localhost:10000/mcp/v1/workspaces/old/agents/hermes\n    enabled_tools: &tools [own]\n    disabled_tools: *tools\n  other:\n    command: own\nextension: *servers # retain old collection\ntool_defaults: *tools\n",
      comments: ["# retain old collection"],
    },
    {
      shape: "nested aliases to tool filters and replaced or removed fields",
      before:
        "# user settings\nmcp_servers:\n  agentkib:\n    # endpoint comment\n    url: &endpoint http://localhost:10000/mcp/v1/workspaces/old/agents/hermes\n    command: &command own\n    args: &arguments [fixture]\n    enabled_tools: &tools [own]\n    disabled_tools: *tools\n    extension:\n      endpoint: *endpoint\n      command: *command\n  other:\n    url: *endpoint\n    command: *command\n    args: *arguments\ntool_defaults: *tools\n",
      comments: ["# endpoint comment"],
    },
    {
      shape: "nested tool filter aliases anchored outside the gateway",
      before:
        "# user settings\ntool_defaults: &tools [own]\nheaders: &headers {test: keep}\nmcp_servers:\n  agentkib:\n    url: http://localhost:10000/mcp/v1/workspaces/old/agents/hermes\n    enabled_tools: *tools\n    disabled_tools: *tools\n    headers: *headers\n  other:\n    command: own\n    enabled_tools: *tools\n",
      comments: [],
    },
    {
      shape: "server collection alias without an existing gateway",
      before:
        "# user settings\ndefaults: &servers\n  other:\n    command: own\n    enabled_tools: &tools [own]\nmcp_servers: *servers # target collection\nextension: *servers\ntool_defaults: *tools\n",
      comments: ["# target collection"],
    },
    {
      shape: "removed field keys referenced by an extension",
      before:
        "# user settings\nmcp_servers:\n  agentkib:\n    url: http://localhost:10000/mcp/v1/workspaces/old/agents/hermes\n    &command_key command: own\n    &args_key args: [fixture]\n    enabled_tools: &tools [own]\n    disabled_tools: *tools\n  other:\n    command: own\nextension: [*command_key, *args_key]\ntool_defaults: *tools\n",
      comments: [],
    },
    {
      shape: "gateway alias with a shadowed nested tool anchor",
      before:
        "# user settings\ntool_defaults: &tools [own]\ndefaults: &gateway\n  url: http://localhost:10000/mcp/v1/workspaces/old/agents/hermes\n  enabled_tools: *tools\n  disabled_tools: *tools\nshadow: &tools [other]\nmcp_servers:\n  agentkib: *gateway\n  other: *gateway\n",
      comments: [],
    },
  ])("updates Hermes's $shape without changing shared values", ({ before, comments }) => {
    const f = fixture(),
      info = f.info("hermes"),
      original = parseYaml(before);
    write(info.target, before);
    const plan = f.plan("hermes");
    expect(plan.changes.map((change) => change.target)).toEqual([info.target]);
    expect(plan.requires_home_approval).toBe(true);
    const gateway = { ...original.mcp_servers.agentkib, url: info.url };
    for (const key of ["command", "args", "cwd"]) delete gateway[key];
    const expected = {
      ...original,
      mcp_servers: { ...original.mcp_servers, agentkib: gateway },
    };
    const after = plan.changes[0]!.after;
    expect(parseYaml(after)).toEqual(expected);
    for (const comment of ["# user settings", ...comments]) expect(after).toContain(comment);
    expect(after).toContain("*tools");
    expect(() => f.apply(plan)).toThrow(/authorization/);
    expect(readFileSync(info.target, "utf8")).toBe(before);
    f.apply(plan, true);
    expect(parseYaml(readFileSync(info.target, "utf8"))).toEqual(expected);
    expect(f.plan("hermes").changes).toEqual([]);
  });

  it.each([
    {
      shape: "server collection key supplied through a scalar alias",
      before:
        "# user settings\nserver_key: &server_key mcp_servers\n? *server_key\n: # aliased collection key\n  other: {command: own}\n  agentkib:\n    url: http://localhost:10000/mcp/v1/workspaces/old/agents/hermes\n    timeout: 42\n    enabled_tools: [own]\n",
      comments: ["# aliased collection key"],
    },
    {
      shape: "gateway key supplied through a scalar alias",
      before:
        "# user settings\ngateway_key: &gateway_key agentkib\nmcp_servers:\n  other: {command: own}\n  ? *gateway_key\n  : # aliased gateway key\n    url: http://localhost:10000/mcp/v1/workspaces/old/agents/hermes\n    timeout: 42\n    enabled_tools: [own]\n    extension: {retained: true}\n",
      comments: ["# aliased gateway key"],
    },
    {
      shape: "endpoint key and value supplied through scalar aliases",
      before:
        "# user settings\nendpoint_key: &endpoint_key url\nendpoint: &endpoint http://localhost:10000/mcp/v1/workspaces/old/agents/hermes\nmcp_servers:\n  agentkib:\n    ? *endpoint_key\n    : *endpoint # aliased endpoint\n    enabled_tools: [own]\n    timeout: 42\n  other: {url: *endpoint}\nextension: {key: *endpoint_key, endpoint: *endpoint}\n",
      comments: ["# aliased endpoint"],
    },
    {
      shape: "removed transport keys and values supplied through scalar aliases",
      before:
        "# user settings\nkeys: [&command_key command, &args_key args, &cwd_key cwd]\ntransport:\n  command: &command own\n  args: &args [fixture]\n  cwd: &cwd /fixture\nmcp_servers:\n  agentkib:\n    url: http://localhost:10000/mcp/v1/workspaces/old/agents/hermes\n    ? *command_key\n    : *command\n    ? *args_key\n    : *args\n    ? *cwd_key\n    : *cwd\n    enabled_tools: [own]\n    timeout: 42\n  other: {command: *command, args: *args, cwd: *cwd}\nextension: [*command_key, *args_key, *cwd_key, *command, *args, *cwd]\n",
      comments: [],
    },
    {
      shape: "endpoint key referencing a removed transport value anchor",
      before:
        "# user settings\nmcp_servers:\n  agentkib:\n    command: &endpoint_key url\n    ? *endpoint_key\n    : http://localhost:10000/mcp/v1/workspaces/old/agents/hermes # retained endpoint comment\n    enabled_tools: [own]\n    timeout: 42\n  other: {command: own}\nextension: *endpoint_key\n",
      comments: ["# retained endpoint comment"],
    },
    {
      shape: "gateway key aliases nested in a collection alias with shadowed anchors",
      before:
        "# user settings\ngateway_key: &gateway_key agentkib\nendpoint_key: &endpoint_key url\ntool_defaults: &tools [own]\ndefaults: &servers\n  ? *gateway_key\n  : &gateway\n    ? *endpoint_key\n    : http://localhost:10000/mcp/v1/workspaces/old/agents/hermes\n    enabled_tools: *tools\n    timeout: 42\n  other: *gateway\nshadowed_keys: [&gateway_key spare, &endpoint_key other_url, &tools [other]]\nmcp_servers: *servers # aliased collection\nextension: *servers\n",
      comments: ["# aliased collection"],
    },
    {
      shape: "collection key alias without an existing gateway",
      before:
        "# user settings\nserver_key: &server_key mcp_servers\n? *server_key\n: # new gateway collection\n  other:\n    command: own\n    enabled_tools: [own]\nmodel: fixture\n",
      comments: ["# new gateway collection"],
    },
  ])("updates Hermes scalar alias keys: $shape", ({ before, comments }) => {
    const f = fixture(),
      info = f.info("hermes"),
      original = JSON.parse(JSON.stringify(parseYaml(before)));
    expect(parseDocument(before, { uniqueKeys: true }).errors).toEqual([]);
    write(info.target, before);
    const plan = f.plan("hermes");
    expect(plan.changes.map((change) => change.target)).toEqual([info.target]);
    expect(plan.requires_home_approval).toBe(true);
    const gateway = { ...original.mcp_servers.agentkib, url: info.url };
    for (const key of ["command", "args", "cwd"]) delete gateway[key];
    const expected = {
      ...original,
      mcp_servers: { ...original.mcp_servers, agentkib: gateway },
    };
    const after = plan.changes[0]!.after,
      output = parseDocument(after, { uniqueKeys: true });
    expect(output.errors).toEqual([]);
    // Parser uniqueness checks do not compare scalar aliases with their resolved keys.
    visit(output, {
      Map: (_key, mapping) => {
        const keys = mapping.items.map((pair) => {
          const key = isAlias(pair.key) ? pair.key.resolve(output) : pair.key;
          expect(isScalar(key)).toBe(true);
          return isScalar(key) ? key.value : undefined;
        });
        expect(new Set(keys).size).toBe(keys.length);
      },
    });
    expect(output.toJS()).toEqual(expected);
    for (const comment of ["# user settings", ...comments]) expect(after).toContain(comment);
    expect(() => f.apply(plan)).toThrow(/authorization/);
    expect(readFileSync(info.target, "utf8")).toBe(before);
    f.apply(plan, true);
    expect(parseYaml(readFileSync(info.target, "utf8"))).toEqual(expected);
    expect(f.plan("hermes").changes).toEqual([]);
  });

  it.each([
    {
      shape: "server collection",
      before:
        "server_key: &server_key mcp_servers\n? *server_key\n: {other: {command: own}}\nmcp_servers:\n  agentkib: {url: http://localhost:10000/mcp/v1/workspaces/old/agents/hermes}\n",
    },
    {
      shape: "gateway",
      before:
        "gateway_key: &gateway_key agentkib\nmcp_servers:\n  ? *gateway_key\n  : {url: http://localhost:10000/mcp/v1/workspaces/old/agents/hermes, enabled_tools: [first]}\n  agentkib: {url: http://localhost:10000/mcp/v1/workspaces/old/agents/hermes, enabled_tools: [second]}\n",
    },
    {
      shape: "endpoint",
      before:
        "endpoint_key: &endpoint_key url\nmcp_servers:\n  agentkib:\n    ? *endpoint_key\n    : http://localhost:10000/mcp/v1/workspaces/old/agents/hermes\n    url: http://localhost:10000/mcp/v1/workspaces/old/agents/hermes\n    enabled_tools: [own]\n",
    },
  ])("rejects Hermes's ambiguous $shape alias keys without writing", ({ before }) => {
    const f = fixture(),
      info = f.info("hermes");
    expect(parseDocument(before, { uniqueKeys: true }).errors).toEqual([]);
    write(info.target, before);
    expect(() => f.plan("hermes")).toThrow(/ambiguous|duplicate/i);
    expect(readFileSync(info.target, "utf8")).toBe(before);
  });

  it("rejects ambiguous Hermes endpoint alias keys even when their values already match", () => {
    const f = fixture(),
      info = f.info("hermes"),
      before = `endpoint_key: &endpoint_key url\nmcp_servers:\n  agentkib:\n    ? *endpoint_key\n    : ${info.url}\n    url: ${info.url}\n    enabled_tools: [own]\n`;
    expect(parseDocument(before, { uniqueKeys: true }).errors).toEqual([]);
    write(info.target, before);
    expect(() => f.plan("hermes")).toThrow(/ambiguous|duplicate/i);
    expect(readFileSync(info.target, "utf8")).toBe(before);
  });

  it.each([
    "defaults: &gateway {url: https://unrelated.example/mcp}\nmcp_servers: {agentkib: *gateway}\n",
    "defaults: &servers {agentkib: {url: https://unrelated.example/mcp}}\nmcp_servers: *servers\n",
  ])("rejects unmanaged Hermes gateways reached through aliases without writing", (before) => {
    const f = fixture(),
      info = f.info("hermes");
    write(info.target, before);
    expect(() => f.plan("hermes")).toThrow(/unmanaged/);
    expect(readFileSync(info.target, "utf8")).toBe(before);
  });

  it.each([
    "mcp_servers: {agentkib: *missing}\n",
    "defaults: &servers [invalid]\nmcp_servers: *servers\n",
    "mcp_servers: {}\nmcp_servers: {}\n",
  ])("rejects invalid Hermes YAML without writing", (before) => {
    const f = fixture(),
      info = f.info("hermes");
    write(info.target, before);
    expect(() => f.plan("hermes")).toThrow();
    expect(readFileSync(info.target, "utf8")).toBe(before);
  });

  it("rejects cyclic Hermes aliases without writing", () => {
    const f = fixture(),
      info = f.info("hermes"),
      before =
        "mcp_servers:\n  agentkib: &gateway\n    url: http://localhost:10000/mcp/v1/workspaces/old/agents/hermes\n    extension: *gateway\n";
    write(info.target, before);
    expect(() => f.plan("hermes")).toThrow(/Invalid MCP YAML configuration: cyclic aliases/);
    expect(readFileSync(info.target, "utf8")).toBe(before);
  });

  it("keeps unchanged Hermes alias configuration byte for byte", () => {
    const f = fixture(),
      info = f.info("hermes"),
      before = `# keep original layout\ndefaults: &gateway {url: '${info.url}', enabled_tools: [own]}\nmcp_servers: {agentkib: *gateway, other: *gateway} # untouched\n`;
    write(info.target, before);
    expect(f.plan("hermes").changes).toEqual([]);
    expect(readFileSync(info.target, "utf8")).toBe(before);
  });

  it.each(["codex", "grok-build"] as const)(
    "preserves %s managed block extras and unmanaged configuration",
    (agent) => {
      const f = fixture(),
        info = f.info(agent);
      write(
        info.target,
        `# outside comment\nmodel = "fixture"\n# agentkib:managed:start\n[mcp_servers.agentkib]\nurl = "http://127.0.0.1:10000/mcp/v1/workspaces/old/agents/${agent}"\nenabled_tools = ["own"]\ndisabled_tools = ["other"]\nstartup_timeout_sec = 42\n[mcp_servers.extra]\nurl = "http://other/mcp"\n# agentkib:managed:end\n`,
      );
      const after = f.plan(agent).changes[0]!.after,
        value = parseToml(after);
      expect(after).toContain('# outside comment\nmodel = "fixture"');
      expect(value).toMatchObject({
        model: "fixture",
        mcp_servers: {
          agentkib: {
            url: info.url,
            enabled_tools: ["own"],
            disabled_tools: ["other"],
            startup_timeout_sec: 42,
          },
          extra: { url: "http://other/mcp" },
        },
      });
    },
  );

  it.each(
    (["codex", "grok-build"] as const).flatMap((agent) =>
      [
        {
          shape: "other server's enabled tools after the managed block",
          before:
            '# agentkib:managed:start\n[mcp_servers.other]\nurl = "http://other/mcp"\n# agentkib:managed:end\nenabled_tools = ["own"]\n',
        },
        {
          shape: "other server's filters and extensions after the managed block",
          before:
            '# user settings\nmodel = "fixture"\n# agentkib:managed:start\n[mcp_servers.other]\nurl = "http://other/mcp"\n# agentkib:managed:end\nenabled_tools = ["own"]\ndisabled_tools = ["blocked"]\nheaders = { test = "keep" }\nstartup_timeout_sec = 42\nextension = { retries = 3, observed_at = 2026-10-07T12:34:56+08:00, score = nan }\n[profile]\nname = "keep"\n',
        },
        {
          shape: "gateway filters and client settings after the managed block",
          before: `model = "fixture"\n# agentkib:managed:start\n[mcp_servers.agentkib]\nurl = "http://127.0.0.1:10000/mcp/v1/workspaces/old/agents/${agent}"\n# agentkib:managed:end\nenabled_tools = ["own"]\ndisabled_tools = ["blocked"]\nheaders = { test = "keep" }\nstartup_timeout_sec = 42\ntool_timeout_sec = 60\nextension = { retries = 3 }\n[mcp_servers.other]\nurl = "http://other/mcp"\n`,
        },
        {
          shape: "gateway filters following an earlier headers subtable",
          before: `model = "fixture"\n# agentkib:managed:start\n[mcp_servers.agentkib.headers]\ntest = "keep"\n[mcp_servers.agentkib]\nurl = "http://127.0.0.1:10000/mcp/v1/workspaces/old/agents/${agent}"\n# agentkib:managed:end\nenabled_tools = ["own"]\ndisabled_tools = ["blocked"]\nstartup_timeout_sec = 42\ntool_timeout_sec = 60\nextension = { retries = 3 }\n[mcp_servers.other]\nurl = "http://other/mcp"\n`,
        },
        {
          shape: "gateway URL and filters after the managed block",
          before: `model = "fixture"\n# agentkib:managed:start\n[mcp_servers.agentkib]\n# agentkib:managed:end\nurl = "http://127.0.0.1:10000/mcp/v1/workspaces/old/agents/${agent}"\nenabled_tools = ["own"]\ndisabled_tools = ["blocked"]\nheaders = { test = "keep" }\nstartup_timeout_sec = 42\n[mcp_servers.other]\nurl = "http://other/mcp"\n`,
        },
        {
          shape: "gateway table started before the managed block",
          before: `model = "fixture"\n[mcp_servers.agentkib]\nurl = "http://127.0.0.1:10000/mcp/v1/workspaces/old/agents/${agent}"\n# agentkib:managed:start\nenabled_tools = ["own"]\n# agentkib:managed:end\ndisabled_tools = ["blocked"]\nheaders = { test = "keep" }\nstartup_timeout_sec = 42\n[mcp_servers.other]\nurl = "http://other/mcp"\n`,
        },
        {
          shape: "other server's nested table continued after the managed block",
          before:
            '# user settings\nmodel = "fixture"\n# agentkib:managed:start\n[mcp_servers.other]\nurl = "http://other/mcp"\n[mcp_servers.other.extension]\nretries = 3\n# agentkib:managed:end\nobserved_at = 2026-10-07T12:34:56+08:00\nscore = nan\n[profile]\nname = "keep"\n',
        },
        {
          shape: "gateway date extensions after the managed block",
          before: `model = "fixture"\n# agentkib:managed:start\n[mcp_servers.agentkib]\nurl = "http://127.0.0.1:10000/mcp/v1/workspaces/old/agents/${agent}"\n# agentkib:managed:end\nextension = { date = 2026-10-07, date_time = 2026-10-07T12:34:56+08:00, local_date_time = 2026-10-07T12:34:56, local_time = 12:34:56 }\n[mcp_servers.other]\nurl = "http://other/mcp"\n`,
        },
      ].map((value) => ({ agent, ...value })),
    ),
  )("preserves $agent's TOML scope for $shape", ({ agent, before }) => {
    const f = fixture(),
      info = f.info(agent),
      original = parseToml(before);
    write(info.target, before);
    const plan = f.plan(agent);
    expect(plan.changes.map((change) => change.target)).toEqual([info.target]);
    expect(plan.requires_home_approval).toBe(false);
    const expected = {
      ...original,
      mcp_servers: {
        ...original.mcp_servers,
        agentkib: { ...original.mcp_servers.agentkib, url: info.url },
      },
    };
    expect(parseToml(plan.changes[0]!.after)).toEqual(expected);
    f.apply(plan);
    expect(parseToml(readFileSync(info.target, "utf8"))).toEqual(expected);
    expect(f.plan(agent).changes).toEqual([]);
  });

  it.each(["codex", "grok-build"] as const)(
    "rejects %s's unrelated gateway outside the managed block without writing",
    (agent) => {
      const f = fixture(),
        info = f.info(agent);
      for (const before of [
        '[mcp_servers.agentkib]\nurl = "https://unrelated.example/mcp"\n# agentkib:managed:start\n[mcp_servers.other]\nurl = "http://other/mcp"\n# agentkib:managed:end\n',
        '# agentkib:managed:start\n[mcp_servers.other]\nurl = "http://other/mcp"\n# agentkib:managed:end\n[mcp_servers.agentkib]\nurl = "https://unrelated.example/mcp"\n',
      ]) {
        write(info.target, before);
        expect(() => f.plan(agent)).toThrow(/unmanaged/);
        expect(readFileSync(info.target, "utf8")).toBe(before);
      }
    },
  );

  it.each(
    (["codex", "grok-build"] as const).flatMap((agent) =>
      [
        {
          shape: "populated inline table",
          before:
            '# user settings\nmodel = "fixture"\nmcp_servers = { other = { url = "http://other/mcp", enabled_tools = ["own"], headers = { test = "keep" }, extension = { retries = 3 } } }\n[profile]\nname = "keep"\n',
        },
        {
          shape: "empty inline table",
          before: '# user settings\nmodel = "fixture"\nmcp_servers = {}\n',
        },
        {
          shape: "inline table outside an empty managed block",
          before:
            '# user settings\nmodel = "fixture"\nmcp_servers = { other = { url = "http://other/mcp" } }\n# agentkib:managed:start\n# agentkib:managed:end\n',
        },
        {
          shape: "nested inline service table",
          before:
            '# user settings\nmodel = "fixture"\nmcp_servers.other = { url = "http://other/mcp", disabled_tools = ["own"], extension = { retries = 3 } }\n',
          preserveText: true,
        },
      ].map((value) => ({ agent, ...value })),
    ),
  )("merges $agent's $shape and applies it idempotently", ({ agent, before, preserveText }) => {
    const f = fixture(),
      info = f.info(agent),
      original = parseToml(before);
    write(info.target, before);
    const plan = f.plan(agent);
    expect(plan.changes.map((change) => change.target)).toEqual([info.target]);
    const after = plan.changes[0]!.after,
      expected = {
        ...original,
        mcp_servers: { ...original.mcp_servers, agentkib: { url: info.url } },
      };
    expect(parseToml(after)).toEqual(expected);
    if (preserveText) expect(after).toContain(before.trimEnd());
    f.apply(plan);
    expect(parseToml(readFileSync(info.target, "utf8"))).toEqual(expected);
    expect(f.plan(agent).changes).toEqual([]);
  });

  it.each(["codex", "grok-build"] as const)(
    "retains %s's existing inline gateway tool filters and extensions",
    (agent) => {
      const f = fixture(),
        info = f.info(agent),
        before = `model = "fixture"\nmcp_servers = { agentkib = { url = "http://127.0.0.1:10000/mcp/v1/workspaces/old/agents/${agent}", enabled_tools = ["own"], disabled_tools = ["other"], headers = { test = "keep" }, extension = { retries = 3 } }, other = { command = "own" } }\n`,
        original = parseToml(before);
      write(info.target, before);
      const plan = f.plan(agent);
      expect(plan.changes.map((change) => change.target)).toEqual([info.target]);
      const expected = {
        ...original,
        mcp_servers: {
          ...original.mcp_servers,
          agentkib: { ...original.mcp_servers.agentkib, url: info.url },
        },
      };
      expect(parseToml(plan.changes[0]!.after)).toEqual(expected);
      f.apply(plan);
      expect(parseToml(readFileSync(info.target, "utf8"))).toEqual(expected);
      expect(f.plan(agent).changes).toEqual([]);
    },
  );

  it.each(["codex", "grok-build"] as const)(
    "rejects %s's invalid inline TOML and unmanaged inline gateway without writing",
    (agent) => {
      const f = fixture(),
        info = f.info(agent);
      for (const [before, error] of [
        ["mcp_servers = {}\ninvalid =\n", /Invalid MCP TOML/],
        ['mcp_servers = { agentkib = { url = "https://unrelated.example/mcp" } }\n', /unmanaged/],
      ] as const) {
        write(info.target, before);
        expect(() => f.plan(agent)).toThrow(error);
        expect(readFileSync(info.target, "utf8")).toBe(before);
      }
    },
  );

  it.each(
    (["codex", "grok-build"] as const).flatMap((agent) =>
      [
        { type: "date", value: "2026-10-07" },
        { type: "date-time", value: "2026-10-07T12:00:00Z" },
        { type: "local date-time", value: "2026-10-07T12:00:00" },
        { type: "local time", value: "12:00:00" },
      ].flatMap(({ type, value }) =>
        [false, true].map((managed) => ({
          agent,
          type,
          scope: managed ? "inside the managed block" : "without managed markers",
          before: `# user settings\nmodel = "fixture"\n${managed ? "# agentkib:managed:start\n" : ""}mcp_servers = ${value}\n${managed ? "# agentkib:managed:end\n" : ""}`,
        })),
      ),
    ),
  )("rejects $agent's TOML $type as mcp_servers $scope without writing", ({ agent, before }) => {
    const f = fixture(),
      info = f.info(agent);
    write(info.target, before);
    expect(() => f.plan(agent)).toThrow(/mcp_servers.*(?:object|table)/i);
    expect(readFileSync(info.target, "utf8")).toBe(before);
  });

  it.each(MCP_CONNECTION_AGENTS)("preserves an unrelated same-name service for %s", (agent) => {
    const f = fixture(),
      info = f.info(agent);
    const before = info.config.replaceAll(info.url, "https://unrelated.example/mcp");
    write(info.target, before);
    expect(() => f.plan(agent)).toThrow(/unmanaged/);
    expect(readFileSync(info.target, "utf8")).toBe(before);
  });

  it("rejects unmanaged same-name TOML servers even inside managed markers, and malformed markers", () => {
    const f = fixture(),
      info = f.info("codex");
    write(
      info.target,
      `# agentkib:managed:start\n[mcp_servers.agentkib]\nurl = "https://unrelated.example/mcp"\n# agentkib:managed:end\n`,
    );
    expect(() => f.plan("codex")).toThrow(/unmanaged/);
    write(info.target, `# agentkib:managed:end\n# agentkib:managed:start\n`);
    expect(() => f.plan("codex")).toThrow(/incomplete/);
  });

  it("changes only an existing recorded target hash and keeps manifest content intact", () => {
    const f = fixture(),
      info = f.info("cursor"),
      target = path.join(f.project, ".agentkib/manifest.yaml");
    write(info.target, "{}\n");
    const manifest = {
      schema_version: 2,
      workspace: { id: "manifest-id", name: "fixture" },
      instructions: { shared: "keep", scoped: [], platform_overrides: {} },
      skills: [{ name: "missing-skill", path: "not-present", targets: [] }],
      connections: [
        {
          name: "legacy",
          transport: "http",
          url: "http://own/mcp",
          env: {},
          allow_tools: [],
          targets: [],
        },
      ],
      adapters: {
        cursor: {
          enabled: false,
          generated_hashes: { ".cursor/mcp.json": hash("{}\n"), "AGENTS.md": "keep" },
        },
        codex: { enabled: true, generated_hashes: { ".codex/config.toml": "keep" } },
      },
      custom_note: "keep",
    };
    write(target, `# manifest comment\n${stringifyYaml(manifest)}`);
    const plan = f.plan("cursor");
    expect(plan.changes).toHaveLength(2);
    const next = parseYaml(plan.changes[1]!.after);
    expect(next).toEqual({
      ...manifest,
      adapters: {
        ...manifest.adapters,
        cursor: {
          ...manifest.adapters.cursor,
          generated_hashes: {
            ...manifest.adapters.cursor.generated_hashes,
            ".cursor/mcp.json": hash(plan.changes[0]!.after),
          },
        },
      },
    });
    expect(plan.changes[1]!.after).toContain("# manifest comment");
    f.apply(plan);
    expect(f.plan("cursor").changes).toEqual([]);
  });

  it.each([
    {
      shape: "selected generated hashes anchor shared with another client",
      agent: "cursor" as const,
      body: `adapters:
  cursor:
    enabled: false
    generated_hashes: &hashes
      .cursor/mcp.json: old-cursor
      .codex/config.toml: old-codex
      AGENTS.md: keep
  codex:
    enabled: true
    generated_hashes: *hashes
hash_defaults: *hashes
`,
    },
    {
      shape: "selected generated hashes alias referencing another client",
      agent: "codex" as const,
      body: `adapters:
  cursor:
    enabled: false
    generated_hashes: &hashes
      .cursor/mcp.json: old-cursor
      .codex/config.toml: old-codex
      AGENTS.md: keep
  codex:
    enabled: true
    generated_hashes: *hashes # selected hash map
hash_defaults: *hashes
`,
      comment: "# selected hash map",
    },
    {
      shape: "selected adapter anchor shared with another client",
      agent: "cursor" as const,
      body: `adapters:
  cursor: &adapter
    enabled: false
    generated_hashes:
      .cursor/mcp.json: old-cursor
      .codex/config.toml: old-codex
      AGENTS.md: keep
  codex: *adapter
adapter_defaults: *adapter
`,
    },
    {
      shape: "selected adapter alias referencing another client",
      agent: "codex" as const,
      body: `adapters:
  cursor: &adapter
    enabled: false
    generated_hashes:
      .cursor/mcp.json: old-cursor
      .codex/config.toml: old-codex
      AGENTS.md: keep
  codex: *adapter # selected adapter
adapter_defaults: *adapter
`,
      comment: "# selected adapter",
    },
    {
      shape: "adapters anchor referenced by an extension",
      agent: "cursor" as const,
      body: `adapters: &adapters
  cursor:
    enabled: false
    generated_hashes:
      .cursor/mcp.json: old-cursor
      AGENTS.md: keep
  codex:
    generated_hashes:
      .codex/config.toml: old-codex
adapter_defaults: *adapters
`,
    },
    {
      shape: "adapters alias referencing an extension",
      agent: "cursor" as const,
      body: `adapter_defaults: &adapters
  cursor:
    enabled: false
    generated_hashes:
      .cursor/mcp.json: old-cursor
      AGENTS.md: keep
  codex:
    generated_hashes:
      .codex/config.toml: old-codex
adapters: *adapters # selected adapters
`,
      comment: "# selected adapters",
    },
    {
      shape: "target scalar hash anchor referenced by another client and fields",
      agent: "cursor" as const,
      body: `adapters:
  cursor:
    generated_hashes:
      .cursor/mcp.json: &old_hash old-cursor # selected hash
      AGENTS.md: *old_hash
  codex:
    generated_hashes:
      .codex/config.toml: *old_hash
hash_default: *old_hash
`,
      comment: "# selected hash",
    },
    {
      shape: "target scalar hash alias referencing an extension",
      agent: "cursor" as const,
      body: `hash_default: &old_hash old-cursor
adapters:
  cursor:
    generated_hashes:
      .cursor/mcp.json: *old_hash # selected hash
      AGENTS.md: *old_hash
  codex:
    generated_hashes:
      .codex/config.toml: *old_hash
`,
      comment: "# selected hash",
    },
    {
      shape: "manifest path keys and target hash key supplied through scalar aliases",
      agent: "cursor" as const,
      body: `key_defaults:
  adapters: &adapters_key adapters
  agent: &agent_key cursor
  hashes: &hashes_key generated_hashes
  target: &target_key .cursor/mcp.json
? *adapters_key
:
  ? *agent_key
  :
    enabled: false
    ? *hashes_key
    :
      ? *target_key
      : old-cursor # selected hash
      AGENTS.md: keep
  codex:
    generated_hashes:
      .codex/config.toml: old-codex
`,
      comment: "# selected hash",
    },
  ])("isolates manifest $shape while updating only the target hash", ({ body, agent, comment }) => {
    const f = fixture(),
      info = f.info(agent),
      otherInfo = f.info(agent === "cursor" ? "codex" : "cursor"),
      otherBefore = otherInfo.format === "toml" ? "# untouched client\n" : '{"untouched":true}\n',
      target = path.join(f.project, ".agentkib/manifest.yaml"),
      instructions = path.join(f.project, "AGENTS.md"),
      before = `# manifest comment
schema_version: 2
workspace: {id: manifest-id, name: fixture}
instructions: {shared: keep instructions}
skills: [{name: fixture-skill, path: not-present, targets: []}]
custom_note: keep
${body}`;
    write(info.target, agent === "cursor" ? "{}\n" : "");
    write(otherInfo.target, otherBefore);
    write(instructions, "keep instructions\n");
    write(target, before);
    // JSON cloning breaks resolved alias identity, so the expected update cannot affect peers.
    const expected = JSON.parse(JSON.stringify(parseYaml(before)));
    const plan = f.plan(agent);
    expect(plan.changes.map((change) => change.target)).toEqual([info.target, target]);
    const configuration = plan.changes[0]!,
      metadata = plan.changes[1]!,
      key = path.relative(f.project, info.target).split(path.sep).join("/");
    expected.adapters[agent].generated_hashes[key] = hash(configuration.after);
    expect(parseYaml(metadata.after)).toEqual(expected);
    expect(metadata.after).toContain("# manifest comment");
    if (comment) expect(metadata.after).toContain(comment);
    expect(readFileSync(target, "utf8")).toBe(before);
    f.apply(plan);
    expect(parseYaml(readFileSync(target, "utf8"))).toEqual(expected);
    expect(readFileSync(otherInfo.target, "utf8")).toBe(otherBefore);
    expect(readFileSync(instructions, "utf8")).toBe("keep instructions\n");
    expect(existsSync(path.join(f.project, "not-present"))).toBe(false);
    expect(f.plan(agent).changes).toEqual([]);
  });

  it("rejects cyclic manifest adapter aliases without writing either planned file", () => {
    const f = fixture(),
      info = f.info("cursor"),
      target = path.join(f.project, ".agentkib/manifest.yaml"),
      before = `schema_version: 2
workspace: {id: manifest-id, name: fixture}
adapter_defaults: &adapter
  generated_hashes: {.cursor/mcp.json: old-cursor}
  extension: &extension
    self: *extension
adapters:
  cursor: *adapter
`;
    write(info.target, "{}\n");
    write(target, before);
    expect(() => f.plan("cursor")).toThrow(/Invalid YAML configuration: cyclic aliases/);
    expect(readFileSync(info.target, "utf8")).toBe("{}\n");
    expect(readFileSync(target, "utf8")).toBe(before);
  });

  it("keeps manifest aliases byte for byte when the recorded target hash already matches", () => {
    const f = fixture(),
      info = f.info("cursor"),
      target = path.join(f.project, ".agentkib/manifest.yaml");
    write(info.target, "{}\n");
    const generatedHash = hash(f.plan("cursor").changes[0]!.after),
      before = `# keep shared metadata layout
schema_version: 2
workspace: {id: manifest-id, name: fixture}
adapters:
  cursor:
    generated_hashes: &hashes
      .cursor/mcp.json: ${generatedHash}
      .codex/config.toml: keep
  codex:
    generated_hashes: *hashes # untouched alias
hash_defaults: *hashes
`;
    write(target, before);
    const plan = f.plan("cursor");
    expect(plan.changes.map((change) => change.target)).toEqual([info.target]);
    expect(readFileSync(target, "utf8")).toBe(before);
    f.apply(plan);
    expect(readFileSync(target, "utf8")).toBe(before);
    expect(f.plan("cursor").changes).toEqual([]);
  });

  it.each([
    {
      key: "generated_hashes",
      body: `hashes_key: &hashes_key generated_hashes
adapter_defaults: &adapters
  cursor:
    generated_hashes: {.cursor/mcp.json: old-first}
    ? *hashes_key
    : {.cursor/mcp.json: old-second}
adapters: *adapters
`,
    },
    {
      key: ".cursor/mcp.json",
      body: `target_key: &target_key .cursor/mcp.json
adapters:
  cursor:
    generated_hashes:
      .cursor/mcp.json: old-first
      ? *target_key
      : old-second
`,
    },
  ])("rejects ambiguous manifest hash path key $key without writing", ({ key, body }) => {
    const f = fixture(),
      info = f.info("cursor"),
      target = path.join(f.project, ".agentkib/manifest.yaml"),
      before = `schema_version: 2
workspace: {id: manifest-id, name: fixture}
${body}`;
    // Scalar aliases and literal keys can resolve to the same key without parser errors.
    expect(parseDocument(before, { uniqueKeys: true }).errors).toEqual([]);
    write(info.target, "{}\n");
    write(target, before);
    expect(() => f.plan("cursor")).toThrow(`manifest.yaml has ambiguous hash path key: ${key}`);
    expect(readFileSync(info.target, "utf8")).toBe("{}\n");
    expect(readFileSync(target, "utf8")).toBe(before);
  });

  it("rejects manifest aliases that would materialize duplicate unrelated hash keys", () => {
    const f = fixture(),
      info = f.info("cursor"),
      target = path.join(f.project, ".agentkib/manifest.yaml"),
      before = `schema_version: 2
workspace: {id: manifest-id, name: fixture}
unrelated_key: &unrelated_key AGENTS.md
adapter_defaults: &adapter
  generated_hashes:
    .cursor/mcp.json: old-cursor
    ? *unrelated_key
    : alias-value
    AGENTS.md: literal-value
adapters:
  cursor: *adapter
`;
    expect(parseDocument(before, { uniqueKeys: true }).errors).toEqual([]);
    write(info.target, "{}\n");
    write(target, before);
    expect(() => f.plan("cursor")).toThrow(/Map keys must be unique/);
    expect(readFileSync(info.target, "utf8")).toBe("{}\n");
    expect(readFileSync(target, "utf8")).toBe(before);
  });

  it("rejects an invalid manifest without modifying configuration", () => {
    const f = fixture();
    write(path.join(f.project, ".agentkib/manifest.yaml"), "invalid: manifest\n");
    expect(() => f.plan("cursor")).toThrow(/manifest/);
    expect(existsSync(f.info("cursor").target)).toBe(false);
  });

  it("retains the hash guard when the configuration changes after review", () => {
    const f = fixture(),
      info = f.info("cursor");
    write(info.target, "{}\n");
    const plan = f.plan("cursor");
    write(info.target, '{"new":"user edit"}\n');
    expect(() => f.apply(plan)).toThrow(/modified externally/);
    expect(readFileSync(info.target, "utf8")).toBe('{"new":"user edit"}\n');
  });

  it("refuses a stale merge if configuration changes between reading and snapshotting", () => {
    const f = fixture(),
      info = f.info("cursor");
    write(info.target, "{}\n");
    const readText = files.readText;
    let reads = 0;
    const spy = vi.spyOn(files, "readText").mockImplementation((target, limit, regular) => {
      if (target === info.target && ++reads === 2)
        write(target, '{"new":"concurrent user edit"}\n');
      return readText(target, limit, regular);
    });
    try {
      expect(() => f.plan("cursor")).toThrow(/changed while planning/);
      expect(readFileSync(info.target, "utf8")).toBe('{"new":"concurrent user edit"}\n');
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects invalid UTF-8 and oversized configurations without normalizing them", () => {
    const f = fixture(),
      info = f.info("cursor");
    write(info.target, "{}");
    writeFileSync(info.target, Buffer.from([0xff]));
    expect(() => f.plan("cursor")).toThrow(/Could not read/);
    expect(readFileSync(info.target)).toEqual(Buffer.from([0xff]));
    writeFileSync(info.target, Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));
    expect(() => f.plan("cursor")).toThrow(/Could not read/);
  });

  it.each(["open-claw", "hermes"] as const)(
    "requires Home approval for %s and rejects a swapped symlink ancestor",
    (agent) => {
      const f = fixture(),
        plan = f.plan(agent),
        info = f.info(agent);
      expect(() => f.apply(plan)).toThrow(/authorization/);
      const directory = path.dirname(info.target),
        outside = path.join(f.root, "outside");
      mkdirSync(directory, { recursive: true });
      mkdirSync(outside);
      renameSync(directory, directory + "-original");
      symlinkSync(outside, directory, "dir");
      expect(() => f.apply(plan, true)).toThrow(/parent|symbolic|unsafe/);
      expect(existsSync(path.join(outside, path.basename(info.target)))).toBe(false);
    },
  );

  it("rejects unsafe project configuration ancestors", () => {
    const f = fixture(),
      outside = path.join(f.root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, path.join(f.project, ".cursor"), "dir");
    expect(() => f.plan("cursor")).toThrow(/Unsafe/);
  });
});

async function httpFixture(
  options: {
    repeatedCursor?: boolean;
    failList?: boolean;
    hangDelete?: boolean;
    onList?: () => void;
    onDelete?: () => void;
    hangList?: boolean;
    hangInitialize?: boolean;
    onInitialize?: () => void;
  } = {},
) {
  const sessions = new Map<
    string,
    {
      transport: InstanceType<typeof StreamableHTTPServerTransport>;
      server: InstanceType<typeof Server>;
    }
  >();
  let toolCalls = 0,
    deletes = 0,
    listCalls = 0;
  const http = createServer((request, response) => {
    void (async () => {
      if (request.method === "DELETE") {
        deletes++;
        options.onDelete?.();
        if (options.hangDelete) return;
      }
      const id = request.headers["mcp-session-id"];
      let session = typeof id === "string" ? sessions.get(id) : undefined;
      if (!session) {
        if (options.hangInitialize) {
          options.onInitialize?.();
          return;
        }
        const server = new Server(
          { name: "fixture", version: "1" },
          { capabilities: { tools: {} } },
        );
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: (nextId) => {
            sessions.set(nextId, { transport, server });
          },
          onsessionclosed: (closedId) => {
            sessions.delete(closedId);
          },
        });
        server.setRequestHandler(ListToolsRequestSchema, async (rpcRequest) => {
          listCalls++;
          options.onList?.();
          if (options.hangList) await new Promise(() => {});
          if (options.failList) throw new Error("fixture listing failed");
          const name = rpcRequest.params?.cursor
            ? "blender__get_scene_info"
            : "workspace_get_context";
          return {
            tools: [{ name, inputSchema: { type: "object" } }],
            ...(options.repeatedCursor || !rpcRequest.params?.cursor
              ? { nextCursor: "next-page" }
              : {}),
          };
        });
        server.setRequestHandler(CallToolRequestSchema, async () => {
          toolCalls++;
          return { content: [] };
        });
        await server.connect(transport);
        session = { transport, server };
      }
      await session.transport.handleRequest(request, response);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("fixture missing port");
  closers.push(async () => {
    for (const session of sessions.values()) {
      await session.server.close();
      await session.transport.close();
    }
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  return { port: address.port, sessions, calls: () => ({ toolCalls, deletes, listCalls }) };
}

describe("MCP HTTP connection verification", () => {
  it("initializes HTTP, lists all pages, separates builtins, and deletes the session without calling tools", async () => {
    const f = fixture(),
      server = await httpFixture();
    const result = await verifyMcpConnection(
      f.request("cursor"),
      f.store,
      { running: true, port: server.port },
      f.environment,
    );
    expect(result).toMatchObject({ builtin_tools: 1, external_tools: ["blender__get_scene_info"] });
    expect(result.checked_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(server.calls()).toEqual({ toolCalls: 0, deletes: 1, listCalls: 2 });
    expect(server.sessions.size).toBe(0);
  });
  it("cleans up sessions on a listing failure or repeated pagination cursor", async () => {
    const f = fixture();
    for (const options of [{ failList: true }, { repeatedCursor: true }]) {
      const server = await httpFixture(options);
      await expect(
        verifyMcpConnection(
          f.request("cursor"),
          f.store,
          { running: true, port: server.port },
          f.environment,
        ),
      ).rejects.toThrow(/failed|pagination/);
      expect(server.calls().toolCalls).toBe(0);
      expect(server.calls().deletes).toBe(1);
      expect(server.sessions.size).toBe(0);
    }
  });
  it("rejects a stopped Hub or an endpoint changed during listing", async () => {
    const f = fixture();
    await expect(
      verifyMcpConnection(
        f.request("cursor"),
        f.store,
        { running: false, port: 47653 },
        f.environment,
      ),
    ).rejects.toThrow(/not running/);
    let current = { running: true, port: 0 };
    const server = await httpFixture({
      onList: () => {
        current = { ...current, port: current.port + 1 };
      },
    });
    current.port = server.port;
    await expect(
      verifyMcpConnection(f.request("cursor"), f.store, () => ({ ...current }), f.environment),
    ).rejects.toThrow(/endpoint changed/);
    expect(server.sessions.size).toBe(0);
  });
  it("keeps concurrent checks independent and bounds an unresponsive session deletion", async () => {
    const f = fixture(),
      server = await httpFixture();
    await Promise.all(
      ["cursor", "codex"].map((targetAgent) =>
        verifyMcpConnection(
          { workspaceId: "registry-id", targetAgent },
          f.store,
          { running: true, port: server.port },
          f.environment,
        ),
      ),
    );
    expect(server.calls()).toEqual({ toolCalls: 0, deletes: 2, listCalls: 4 });
    expect(server.sessions.size).toBe(0);
    const stalled = await httpFixture({ hangDelete: true }),
      started = performance.now();
    await verifyMcpConnection(
      f.request("cursor"),
      f.store,
      { running: true, port: stalled.port },
      f.environment,
    );
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(stalled.calls().deletes).toBe(1);
  });
  it("does not return a successful old endpoint after the port changes during session cleanup", async () => {
    const f = fixture();
    let current = { running: true, port: 0 };
    const server = await httpFixture({
      onDelete: () => {
        current = { ...current, port: current.port + 1 };
      },
    });
    current.port = server.port;
    await expect(
      verifyMcpConnection(f.request("cursor"), f.store, () => ({ ...current }), f.environment),
    ).rejects.toThrow(/endpoint changed/);
    expect(server.sessions.size).toBe(0);
  });
  it("applies the overall deadline to stalled tool listing and still terminates its session", async () => {
    const controller = new AbortController();
    const f = fixture(),
      server = await httpFixture({ hangList: true, onList: () => controller.abort() });
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((duration) =>
        duration === 15_000 ? controller.signal : timeout(duration),
      );
    try {
      await expect(
        verifyMcpConnection(
          f.request("cursor"),
          f.store,
          { running: true, port: server.port },
          f.environment,
        ),
      ).rejects.toThrow(/timed out/);
      expect(spy).toHaveBeenCalledWith(15_000);
      expect(server.calls()).toMatchObject({ deletes: 1, toolCalls: 0 });
      expect(server.sessions.size).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
  it("applies the same overall deadline to an unresponsive initialization", async () => {
    const controller = new AbortController(),
      f = fixture();
    const server = await httpFixture({
      hangInitialize: true,
      onInitialize: () => controller.abort(),
    });
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((duration) =>
        duration === 15_000 ? controller.signal : timeout(duration),
      );
    try {
      await expect(
        verifyMcpConnection(
          f.request("cursor"),
          f.store,
          { running: true, port: server.port },
          f.environment,
        ),
      ).rejects.toThrow(/timed out/);
      expect(spy).toHaveBeenCalledWith(15_000);
      expect(server.calls()).toEqual({ deletes: 0, listCalls: 0, toolCalls: 0 });
    } finally {
      spy.mockRestore();
    }
  });
});
