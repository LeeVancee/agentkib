import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROTOCOL_VERSION,
  RUNTIME_METHODS,
  type McpManagementState,
  type McpImportPreview,
  type McpImportReport,
  type McpBatchConnectionCheck,
  type McpBatchConnectionPlan,
  type McpBatchConnectionReport,
  type McpToolPolicySnapshot,
} from "@agentkib/runtime-protocol";
import { TypeScriptBackend } from "../../../packages/backend/src/index";
import { BACKEND_INITIALIZE } from "../../../packages/backend/src/migration";
import { BackendStore } from "../../../packages/backend/src/store";
import { Commands } from "../../../packages/backend/src/commands";
import { McpManager } from "../../../packages/backend/src/mcp";

const { createIsolatedWorkerEnvironment } = createRequire(import.meta.url)(
  "../scripts/backend-worker-smoke-environment.cjs",
) as {
  createIsolatedWorkerEnvironment(root: string, source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
};
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
async function unusedPort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  if (!address || typeof address === "string") throw new Error("No fixture port");
  return address.port;
}
function write(file: string, value: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, value);
}
async function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "agentkib-mcp-rpc-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"),
    project = path.join(root, "project"),
    data = path.join(root, "data"),
    bin = path.join(root, "bin");
  for (const directory of [home, project, data, bin, path.join(home, "tmp")])
    mkdirSync(directory, { recursive: true });
  const isolated = {
    ...createIsolatedWorkerEnvironment(home),
    PATH: bin,
  };
  const valuesByName = new Map(
    Object.entries(isolated).map(([key, value]) => [key.toUpperCase(), value]),
  );
  // Backend overlays these values on process.env. Override every existing casing
  // as well, so Windows Path/Systemroot aliases cannot hide or restore host values.
  const environment: NodeJS.ProcessEnv = {
    ...Object.fromEntries(
      Object.keys(process.env).map((key) => [key, valuesByName.get(key.toUpperCase())]),
    ),
    ...isolated,
  };
  const executable = path.join(bin, process.platform === "win32" ? "codex.cmd" : "codex");
  writeFileSync(
    executable,
    process.platform === "win32" ? "@echo off\r\nexit /b 91\r\n" : "#!/bin/sh\nexit 91\n",
  );
  if (process.platform !== "win32") chmodSync(executable, 0o755);
  const store = new BackendStore(path.join(data, "agentkib.db"));
  store.sql.run(
    "INSERT INTO workspaces(id,canonical_path,name,manifest_workspace_id,status,last_discovered_at) VALUES(?,?,?,?,?,?)",
    "registered",
    project,
    "Fixture",
    "legacy-manifest",
    "healthy",
    new Date().toISOString(),
  );
  store.close();
  write(
    path.join(data, "preferences.json"),
    JSON.stringify({
      session_index_enabled: false,
      session_content_search_enabled: false,
      mcp_network: { port: await unusedPort(), lan_enabled: false, lan_risk_accepted: false },
    }),
  );
  const native = path.join(project, ".mcp.json"),
    nativeBefore =
      '{"mcpServers":{"untouched":{"command":"native-must-not-start","env":{"PRIVATE":"native-private-value"}}}}\n';
  write(native, nativeBefore);
  const foreignFile = path.join(root, "unrelated-home/.agentkib/mcp.json");
  write(foreignFile, "UNRELATED-HOME-SENTINEL");
  const backend = new TypeScriptBackend(environment);
  cleanup.push(() => backend.closeAsync());
  let id = 0;
  const raw = (method: string, params: Record<string, unknown> = {}) =>
    backend.handleAsync({ jsonrpc: "2.0", id: ++id, method, params });
  const request = async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    const response = await raw(method, params);
    if (response.error) throw new Error(JSON.stringify(response.error));
    return response.result as T;
  };
  expect(
    await request<{ protocolVersion: number }>(RUNTIME_METHODS.handshake, {
      protocolVersion: PROTOCOL_VERSION,
      client: { name: "isolated-mcp-rpc-test", version: "1" },
    }),
  ).toMatchObject({ protocolVersion: PROTOCOL_VERSION });
  await request(BACKEND_INITIALIZE, { dataDir: data });
  const state = () => request<McpManagementState>(RUNTIME_METHODS.mcpManagementState, { project });
  return {
    root,
    home,
    project,
    data,
    native,
    nativeBefore,
    foreignFile,
    backend,
    raw,
    request,
    state,
  };
}

describe("MCP management through TypeScriptBackend JSON-RPC dispatch", () => {
  it.each(["paste", "native"])(
    "rejects OpenCode OAuth disablement through %s without collection or network activity",
    async (source) => {
      const f = await fixture(),
        command = vi.spyOn(Commands.prototype, "run"),
        probe = vi.spyOn(McpManager.prototype, "probe"),
        network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network expected")),
        native = path.join(f.project, "opencode.json"),
        text = JSON.stringify({
          mcp: { demo: { type: "remote", url: "https://mcp.example.test/mcp", oauth: false } },
        });
      write(native, text);
      const before = await f.state();
      let input: { text: string } | { candidateIds: string[] } = { text };
      if (source === "native") {
        const candidates = await f.request<Array<{ id: string; name: string }>>(
          RUNTIME_METHODS.scanNativeMcp,
          { project: f.project },
        );
        input = { candidateIds: [candidates.find((item) => item.name === "demo")!.id] };
      }
      const preview = await f.request<McpImportPreview>(RUNTIME_METHODS.previewMcpImport, {
        project: f.project,
        ...input,
      });
      expect(preview.items[0]?.status).toBe("blocked");
      await expect(
        f.request(RUNTIME_METHODS.applyMcpImport, {
          project: f.project,
          revision: preview.revision,
          token: preview.token,
          selections: [{ key: preview.items[0]!.key, action: "add" }],
        }),
      ).rejects.toThrow("Blocked import item");
      expect(await f.state()).toEqual(before);
      expect(readFileSync(native, "utf8")).toBe(text);
      expect(existsSync(path.join(f.project, ".agentkib/mcp.json"))).toBe(false);
      expect(existsSync(path.join(f.project, ".agentkib/mcp.local.json"))).toBe(false);
      expect(command).not.toHaveBeenCalled();
      expect(probe).not.toHaveBeenCalled();
      expect(network).not.toHaveBeenCalled();
    },
  );

  it("saves, collects and sets policy without executing or touching native/personal configuration", async () => {
    const f = await fixture();
    const command = vi.spyOn(Commands.prototype, "run"),
      probe = vi.spyOn(McpManager.prototype, "probe");
    const initial = await f.state();
    expect(initial.servers).toEqual([]);
    const saved = await f.request<McpManagementState>(RUNTIME_METHODS.saveMcpConfiguration, {
      project: f.project,
      revision: initial.revision,
      server: {
        id: "manual",
        name: "Manual",
        transport: "stdio",
        command: "never-run-rpc-fixture",
        enabled: true,
        targets: ["codex"],
      },
      secretOperations: { env: { PRIVATE: { action: "replace", value: "entered-private-value" } } },
    });
    expect(saved.servers[0]).toMatchObject({
      config: { enabled: false, env: {} },
      configured_env: ["PRIVATE"],
    });
    expect(JSON.stringify(saved)).not.toContain("entered-private-value");
    const preview = await f.request<McpImportPreview>(RUNTIME_METHODS.previewMcpImport, {
      project: f.project,
      text: '{"mcpServers":{"collected":{"command":"never-run-collected-fixture","env":{"SECRET":"pasted-private-value"}}}}',
    });
    expect(JSON.stringify(preview)).not.toContain("pasted-private-value");
    const result = await f.request<McpImportReport>(RUNTIME_METHODS.applyMcpImport, {
      project: f.project,
      revision: preview.revision,
      token: preview.token,
      selections: [{ key: preview.items[0]!.key, action: "add" }],
    });
    expect(result.results[0]).toMatchObject({ id: "collected", status: "saved" });
    expect((await f.state()).servers.every((item) => !item.config.enabled)).toBe(true);
    const policy = await f.request<McpToolPolicySnapshot>(RUNTIME_METHODS.getMcpPolicy, {
      project: f.project,
    });
    const rules = [
      { agent: "codex", server_id: "collected", mode: "selected", tools: [] },
      { agent: "codex", server_id: null, mode: "selected", tools: ["workspace_get_context"] },
    ];
    const updated = await f.request<McpToolPolicySnapshot>(RUNTIME_METHODS.saveMcpPolicy, {
      project: f.project,
      revision: policy.revision,
      rules,
    });
    expect(updated.effective_rules).toEqual(rules);
    expect(
      (await f.request<McpToolPolicySnapshot>(RUNTIME_METHODS.getMcpPolicy, { project: f.project }))
        .revision,
    ).toBe(updated.revision);
    expect(readFileSync(f.native, "utf8")).toBe(f.nativeBefore);
    expect(readFileSync(f.foreignFile, "utf8")).toBe("UNRELATED-HOME-SENTINEL");
    expect(existsSync(path.join(f.home, ".agentkib/mcp.json"))).toBe(false);
    expect(readFileSync(path.join(f.project, ".agentkib/mcp.json"), "utf8")).not.toMatch(
      /entered-private-value|pasted-private-value/,
    );
    expect(command).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    expect(await f.request(RUNTIME_METHODS.listMcpServers, { project: f.project })).toHaveLength(2);
  });

  it("plans and applies one batch through the same runtime, then verifies its real Hub endpoint", async () => {
    const f = await fixture(),
      run = vi.spyOn(Commands.prototype, "run");
    const selection = { workspaceId: "registered", targetAgents: ["codex"] };
    const check = await f.request<McpBatchConnectionCheck>(
      RUNTIME_METHODS.checkMcpConnections,
      selection,
    );
    expect(check.targets[0]).toMatchObject({
      agent: "codex",
      installed: true,
      status: "missing",
      selected: true,
    });
    const plan = await f.request<McpBatchConnectionPlan>(
      RUNTIME_METHODS.planMcpConnections,
      selection,
    );
    expect(plan.changes.length).toBeGreaterThan(0);
    expect(plan.changes.every((change) => change.target.startsWith(f.project + path.sep))).toBe(
      true,
    );
    expect(existsSync(path.join(f.project, ".codex/config.toml"))).toBe(false);
    const result = await f.request<McpBatchConnectionReport>(RUNTIME_METHODS.applyMcpConnections, {
      token: plan.token,
      approveHome: false,
    });
    expect(result.success).toBe(true);
    expect(result.targets[0]?.status).toBe("applied");
    expect(
      await f.request(RUNTIME_METHODS.applyMcpConnections, {
        token: plan.token,
        approveHome: false,
      }),
    ).toEqual(result);
    expect(
      (await f.request<McpBatchConnectionPlan>(RUNTIME_METHODS.planMcpConnections, selection))
        .changes,
    ).toEqual([]);
    const verification = await f.request<{ builtin_tools: number; builtin_tool_names: string[] }>(
      RUNTIME_METHODS.verifyMcpConnection,
      { workspaceId: "registered", targetAgent: "codex" },
    );
    expect(verification.builtin_tool_names).toContain("workspace_get_context");
    expect(verification.builtin_tools).toBe(verification.builtin_tool_names.length);
    expect(readFileSync(f.native, "utf8")).toBe(f.nativeBefore);
    expect(readFileSync(f.foreignFile, "utf8")).toBe("UNRELATED-HOME-SENTINEL");
    expect(existsSync(path.join(f.home, ".codex/config.toml"))).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("returns existing RPC errors for invalid scope, old revisions and attempted Web management", async () => {
    const f = await fixture();
    expect(
      (await f.raw(RUNTIME_METHODS.mcpManagementState, { project: f.home })).error,
    ).toBeDefined();
    const old = await f.state();
    await f.request(RUNTIME_METHODS.saveMcpConfiguration, {
      project: f.project,
      revision: old.revision,
      server: { id: "one", name: "One", transport: "stdio", command: "not-run" },
    });
    const stale = await f.raw(RUNTIME_METHODS.saveMcpConfiguration, {
      project: f.project,
      revision: old.revision,
      server: { id: "two", name: "Two", transport: "stdio", command: "not-run" },
    });
    expect(JSON.stringify(stale.error)).toContain("configuration changed");
    const web = await f.raw(RUNTIME_METHODS.webRequest, {
      operation: "mcp.managementState",
      project: f.project,
    });
    expect(web.error).toBeDefined();
    expect((await f.state()).servers.map((entry) => entry.config.id)).toEqual(["one"]);
  });
});
