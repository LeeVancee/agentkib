import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Commands } from "../../../packages/backend/src/commands";
import { McpManager, mcpToolCacheKey } from "../../../packages/backend/src/mcp";
import type { McpServer } from "../../../packages/backend/src/mcp-config-read";
import { BackendStore } from "../../../packages/backend/src/store";
import { StreamableHTTPClientTransport } from "../../../packages/backend/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture(parallel = false) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "agentkib-policy-oauth-"))),
    home = path.join(root, "home"),
    project = path.join(root, "project"),
    project2 = path.join(root, "project2"),
    data = path.join(root, "data"),
    environment = { HOME: home, USERPROFILE: home };
  for (const directory of [home, project, project2]) mkdirSync(directory);
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new BackendStore(path.join(data, "agentkib.db"));
  cleanups.push(() => store.close());
  const commands = new Commands();
  cleanups.push(() => commands.close());
  const manager = new McpManager(store.sql, environment, data, commands);
  cleanups.push(() => manager.closeAsync());
  const url = "https://mcp.example.test/mcp",
    issuer = "https://auth.example.test",
    server: McpServer = {
      id: "oauth",
      name: "OAuth fixture",
      transport: "streamable-http",
      url,
      enabled: true,
      env: {},
      headers: {},
      targets: [],
      allow_tools: [],
      lan_allow_tools: ["read", "write"],
      supports_parallel_tool_calls: parallel,
    },
    credentials = {
      client_information: { client_id: "fixture-client", issuer },
      token_response: {
        access_token: "expired-placeholder",
        refresh_token: "refresh-placeholder",
        token_type: "Bearer",
        issuer,
      },
      discovery_state: {
        authorizationServerUrl: issuer,
        resourceMetadata: { resource: url, authorization_servers: [issuer] },
        authorizationServerMetadata: {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        },
      },
    };
  for (const [id, directory] of [
    ["one", project],
    ["two", project2],
  ] as const) {
    store.sql.run(
      "INSERT INTO workspaces(id,canonical_path,name,manifest_workspace_id,status,last_discovered_at) VALUES(?,?,?,?,?,?)",
      id,
      directory,
      id,
      id,
      "healthy",
      new Date().toISOString(),
    );
    manager.save(server, directory);
    manager.ensureOAuthStore(server, directory);
    manager.saveOAuthCredentials(server.id, credentials, directory);
  }
  const events: string[] = [],
    gates = new Map<string, Promise<void>>();
  let token = "not-yet-issued",
    refreshes = 0;
  let refreshError: string | undefined, grantedScope: string | undefined;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url === `${issuer}/token`) {
      events.push("refresh");
      await gates.get("refresh");
      if (refreshError) return Response.json({ error: refreshError }, { status: 400 });
      token = `fresh-placeholder-${++refreshes}`;
      return Response.json({
        access_token: token,
        refresh_token: `refresh-${refreshes}`,
        token_type: "Bearer",
        ...(grantedScope === undefined ? {} : { scope: grantedScope }),
      });
    }
    expect(request.url).toBe(url);
    if (request.method === "GET") return new Response(null, { status: 405 });
    const message = await request.json();
    if (!("id" in message)) return new Response(null, { status: 202 });
    if (request.headers.get("authorization") !== `Bearer ${token}`)
      return new Response(null, { status: 401 });
    const event = message.method === "tools/call" ? `call:${message.params.name}` : message.method;
    events.push(event);
    await gates.get(event);
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: message.params.protocolVersion,
            serverInfo: { name: "fixture", version: "1" },
            capabilities: { tools: {} },
          }
        : message.method === "tools/list"
          ? { tools: ["read", "write"].map((name) => ({ name, inputSchema: { type: "object" } })) }
          : message.method === "tools/call"
            ? { content: [{ type: "text", text: message.params.name }] }
            : undefined;
    if (!result) throw new Error("Unexpected fixture RPC method");
    return Response.json({ jsonrpc: "2.0", id: message.id, result });
  });
  const localFile = (scope = project) => path.join(scope, ".agentkib/mcp.local.json");
  return {
    manager,
    store,
    project,
    project2,
    environment,
    events,
    localFile,
    currentKey(scope = project) {
      return mcpToolCacheKey(manager.getPrivate("oauth", scope)!, scope, environment);
    },
    currentCatalog(scope = project) {
      return manager.getPolicy(scope).catalog.find((item) => item.server_id === "oauth");
    },
    call(
      tool = "read",
      scope = project,
      agent = "codex",
      remote = false,
      assertIdentity?: () => void,
    ) {
      return manager.callHubTool(scope, agent, `oauth__${tool}`, {}, remote, assertIdentity);
    },
    configure(patch: Partial<typeof server>) {
      manager.save({ ...server, ...patch }, project);
    },
    denyCodex() {
      manager.savePolicy(
        {
          revision: manager.getPolicy(project).revision,
          rules: [{ agent: "codex", server_id: "oauth", mode: "selected", tools: [] }],
        },
        project,
      );
    },
    expire() {
      token = "expired-by-fixture";
    },
    rejectRefresh(error: string) {
      refreshError = error;
    },
    grantScope(scope: string) {
      grantedScope = scope;
    },
    hold(event: string) {
      let release!: () => void;
      gates.set(
        event,
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      return () => {
        gates.delete(event);
        release();
      };
    },
    waitFor(event: string, count = 1) {
      return vi.waitFor(() => expect(events.filter((item) => item === event)).toHaveLength(count), {
        timeout: 3000,
        interval: 5,
      });
    },
    change(kind: "endpoint" | "headers" | "account" | "token" | "clear") {
      if (kind === "endpoint") manager.save({ ...server, url: `${url}/changed` }, project);
      if (kind === "headers")
        manager.saveLocal("oauth", {}, { Authorization: "changed-placeholder" }, project);
      if (kind === "clear") manager.clearOAuthCredentials("oauth", project);
      if (kind === "account" || kind === "token") {
        const updated = structuredClone(credentials);
        if (kind === "account") updated.client_information.client_id = "different-account";
        else updated.token_response.access_token = "externally-replaced-placeholder";
        manager.saveOAuthCredentials("oauth", updated, project);
      }
    },
  };
}

describe("MCP policy connection ownership during OAuth refresh", () => {
  it("rejects an SDK tools/call without the manager's dispatch context", async () => {
    const f = fixture(),
      send = StreamableHTTPClientTransport.prototype.send;
    vi.spyOn(StreamableHTTPClientTransport.prototype, "send").mockImplementation(
      function (message, options) {
        if (!Array.isArray(message) && "method" in message && message.method === "tools/list")
          return send.call(
            this,
            { ...message, method: "tools/call", params: { name: "write" } },
            options,
          );
        return send.call(this, message, options);
      },
    );
    await expect(f.manager.probe("oauth", f.project)).rejects.toThrow("dispatch context");
    expect(f.events).not.toContain("call:write");
  });

  it("rejects an SDK batch containing a tool request outside the current request identity", async () => {
    const f = fixture();
    await f.manager.probe("oauth", f.project);
    const send = StreamableHTTPClientTransport.prototype.send;
    const spy = vi
      .spyOn(StreamableHTTPClientTransport.prototype, "send")
      .mockImplementation(function (message, options) {
        if (!Array.isArray(message) && "method" in message && message.method === "tools/call")
          return send.call(this, [message, { ...message, id: "unrelated-request" }], options);
        return send.call(this, message, options);
      });
    await expect(f.call("write")).rejects.toThrow("dispatch context");
    expect(f.events).not.toContain("call:write");
    spy.mockRestore();
    await expect(f.call("read")).resolves.toMatchObject({ content: [{ text: "read" }] });
  });

  it.each(["policy", "targets", "allow_tools", "lan", "disabled", "workspace", "identity"])(
    "rechecks %s immediately before the SDK sends an OAuth retry",
    async (changed) => {
      const f = fixture();
      await f.manager.probe("oauth", f.project);
      f.expire();
      let identityValid = true;
      const release = f.hold("refresh"),
        call = f.call("write", f.project, "codex", changed === "lan", () => {
          if (!identityValid) throw new Error("Workspace identity changed");
        }),
        rejected = expect(call).rejects.toThrow();
      await f.waitFor("refresh", 2);
      if (changed === "policy") f.denyCodex();
      if (changed === "targets") f.configure({ targets: ["claude-code"] });
      if (changed === "allow_tools") f.configure({ allow_tools: ["read"] });
      if (changed === "lan") f.configure({ lan_allow_tools: ["read"] });
      if (changed === "disabled") f.configure({ enabled: false });
      if (changed === "workspace") f.store.sql.run("DELETE FROM workspaces WHERE id='one'");
      if (changed === "identity") identityValid = false;
      release();
      await rejected;
      expect(f.events).not.toContain("call:write");
      if (changed === "policy") {
        expect(f.currentCatalog()?.probed).toBe(true);
        expect(f.manager.runtimes().filter((runtime) => runtime.state === "running")).toHaveLength(
          1,
        );
      }
    },
  );

  it("isolates parallel Agents calling the same tool and keeps allowed calls alive after retry denial", async () => {
    const f = fixture(true);
    await f.manager.probe("oauth", f.project);
    const releaseAllowed = f.hold("call:write"),
      allowed = f.call("write", f.project, "claude-code");
    const allowedResult = expect(allowed).resolves.toMatchObject({ content: [{ text: "write" }] });
    await f.waitFor("call:write");
    f.expire();
    const releaseRefresh = f.hold("refresh"),
      denied = f.call("write"),
      rejected = expect(denied).rejects.toThrow("policy");
    await f.waitFor("refresh", 2);
    f.denyCodex();
    releaseRefresh();
    await rejected;
    expect(f.events.filter((event) => event === "call:write")).toHaveLength(1);
    expect(f.manager.runtimes().filter((runtime) => runtime.state === "running")).toHaveLength(1);
    releaseAllowed();
    await allowedResult;
    await expect(f.call("read", f.project, "claude-code")).resolves.toMatchObject({
      content: [{ text: "read" }],
    });
    expect(f.events.filter((event) => event === "initialize")).toHaveLength(1);
  });

  it("dispatches the first call after SDK refresh and retains the refreshed directory", async () => {
    const f = fixture(),
      original = f.currentKey();
    await expect(f.call()).resolves.toMatchObject({ content: [{ text: "read" }] });
    expect(f.events).toEqual(["refresh", "initialize", "tools/list", "call:read"]);
    expect(f.currentKey()).not.toBe(original);
    expect(f.currentCatalog()).toMatchObject({ probed: true });
    expect(f.manager.cachedTools("oauth", f.project).map((tool) => tool.name)).toEqual([
      "read",
      "write",
    ]);
    expect(f.currentCatalog(f.project2)?.probed).toBe(false);
    await f.call("write");
    expect(f.events.at(-1)).toBe("call:write");
    expect(f.events.filter((event) => event === "initialize")).toHaveLength(1);
  });

  it("keeps an explicit successful probe current after refresh", async () => {
    const f = fixture();
    await expect(f.manager.probe("oauth", f.project)).resolves.toHaveLength(2);
    expect(f.currentCatalog()?.probed).toBe(true);
    f.manager.stop("oauth");
    expect(f.currentCatalog()?.probed).toBe(true); // persisted under the new full fingerprint
  });

  it("shares a starting connection before and after its credential fingerprint changes", async () => {
    const f = fixture(),
      releaseRefresh = f.hold("refresh"),
      releaseList = f.hold("tools/list");
    const first = f.call();
    await f.waitFor("refresh");
    const second = f.call("write");
    releaseRefresh();
    await f.waitFor("tools/list");
    const third = f.call();
    releaseList();
    await Promise.all([first, second, third]);
    expect(f.events.filter((event) => event === "refresh")).toHaveLength(1);
    expect(f.events.filter((event) => event === "initialize")).toHaveLength(1);
    expect(f.events.filter((event) => event === "tools/list")).toHaveLength(1);
  });

  it("keeps queued calls serialized across an active refresh without borrowing another scope", async () => {
    const f = fixture();
    await f.manager.probe("oauth", f.project);
    await f.manager.probe("oauth", f.project2);
    const otherCredentials = readFileSync(f.localFile(f.project2), "utf8");
    f.expire();
    const release = f.hold("refresh"),
      first = f.call();
    await f.waitFor("refresh", 3);
    const second = f.call("write");
    release();
    await Promise.all([first, second]);
    await f.call();
    expect(f.events.filter((event) => event.startsWith("call:"))).toEqual([
      "call:read",
      "call:write",
      "call:read",
    ]);
    expect(f.events.filter((event) => event === "initialize")).toHaveLength(2);
    expect(f.currentCatalog()?.probed).toBe(true);
    expect(f.currentCatalog(f.project2)?.probed).toBe(true);
    expect(readFileSync(f.localFile(f.project2), "utf8")).toBe(otherCredentials);
    expect(f.manager.runtimes().filter((runtime) => runtime.state === "running")).toHaveLength(2);
  });

  it("allows a call waiting for restart to use that restart's refreshed credentials", async () => {
    const f = fixture();
    await f.manager.probe("oauth", f.project);
    f.expire();
    const release = f.hold("refresh"),
      restart = f.manager.restart("oauth", f.project);
    await f.waitFor("refresh", 2);
    const call = f.call();
    release();
    await restart;
    await expect(call).resolves.toMatchObject({ content: [{ text: "read" }] });
    expect(f.events.filter((event) => event === "initialize")).toHaveLength(2);
  });

  it.each(["endpoint", "headers", "account", "token", "clear"] as const)(
    "rejects queued dispatch and invalidates the catalog after an external %s change",
    async (kind) => {
      const f = fixture();
      await f.manager.probe("oauth", f.project);
      const release = f.hold("call:read"),
        first = f.call();
      await f.waitFor("call:read");
      const second = f.call("write"),
        rejected = expect(second).rejects.toThrow("configuration changed");
      f.change(kind);
      release();
      await Promise.all([first, rejected]);
      expect(f.events).not.toContain("call:write");
      expect(f.currentCatalog()?.probed).toBe(false);
    },
  );

  it.each(["endpoint", "headers", "account", "token", "clear"] as const)(
    "rejects a late refresh instead of overwriting an external %s change",
    async (kind) => {
      const f = fixture(),
        release = f.hold("refresh"),
        call = f.call(),
        rejected = expect(call).rejects.toThrow(/configuration changed|Unauthorized/);
      await f.waitFor("refresh");
      f.change(kind);
      const credentials = readFileSync(f.localFile(), "utf8");
      release();
      await rejected;
      expect(readFileSync(f.localFile(), "utf8")).toBe(credentials);
      expect(f.events).toEqual(["refresh"]);
      expect(f.currentCatalog()?.probed).toBe(false);
      if (kind === "clear")
        expect(f.manager.getPrivate("oauth", f.project)?.oauth_credentials).toBeUndefined();
    },
  );

  it("does not retain a directory if credentials change while tools/list is pending", async () => {
    const f = fixture(),
      release = f.hold("tools/list"),
      probe = f.manager.probe("oauth", f.project),
      rejected = expect(probe).rejects.toThrow("configuration changed");
    await f.waitFor("tools/list");
    f.change("account");
    release();
    await rejected;
    expect(f.currentCatalog()?.probed).toBe(false);
    expect(f.manager.runtimes().filter((runtime) => runtime.state === "running")).toEqual([]);
  });

  it("does not save credentials when an active connection is stopped during refresh", async () => {
    const f = fixture();
    await f.manager.probe("oauth", f.project);
    const credentials = readFileSync(f.localFile(), "utf8");
    f.expire();
    const release = f.hold("refresh"),
      call = f.call(),
      rejected = expect(call).rejects.toThrow();
    await f.waitFor("refresh", 2);
    f.manager.stop("oauth");
    release();
    await rejected;
    expect(readFileSync(f.localFile(), "utf8")).toBe(credentials);
    expect(f.events).not.toContain("call:read");
  });

  it.each(["invalid_grant", "invalid_client"])(
    "invalidates the old directory and connection when the SDK rejects refresh with %s",
    async (error) => {
      const f = fixture();
      await f.manager.probe("oauth", f.project);
      expect(f.currentCatalog()?.probed).toBe(true);
      f.expire();
      f.rejectRefresh(error);
      await expect(f.call()).rejects.toThrow();
      expect(f.currentCatalog()?.probed).toBe(false);
      expect(f.manager.cachedTools("oauth", f.project)).toEqual([]);
      expect(f.manager.runtimes().filter((runtime) => runtime.state === "running")).toEqual([]);
      expect(f.events).not.toContain("call:read");
      const credentials = f.manager.getPrivate("oauth", f.project)?.oauth_credentials as
        | Record<string, unknown>
        | undefined;
      expect(credentials?.token_response).toBeUndefined();
    },
  );

  it("requires a fresh directory when refreshed token grants change", async () => {
    const f = fixture();
    await f.manager.probe("oauth", f.project);
    f.expire();
    f.grantScope("different-grant");
    await expect(f.call()).rejects.toThrow();
    expect(f.currentCatalog()?.probed).toBe(false);
    expect(f.events).not.toContain("call:read");
    await f.manager.probe("oauth", f.project);
    expect(f.currentCatalog()?.probed).toBe(true);
    await expect(f.call()).resolves.toMatchObject({ content: [{ text: "read" }] });
  });

  it("keeps nonpersistent probes independent of registered connection ownership", async () => {
    const f = fixture();
    await f.manager.probe("oauth", f.project);
    const temporary = { ...f.manager.getPrivate("oauth", f.project)!, id: "temporary-unsaved" };
    await expect(f.manager.probeConfig(temporary)).resolves.toHaveLength(2);
    expect(f.manager.getPrivate(temporary.id)).toBeNull();
    expect(f.manager.hasCurrentProbe(temporary.id)).toBe(false);
  });
});
