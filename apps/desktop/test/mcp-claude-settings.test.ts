import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  scanNativeMcp,
  type NativeMcpCandidate,
} from "../../../packages/backend/src/mcp-native-scan";
import { canonicalize } from "../../../packages/backend/src/paths";
import { BackendStore } from "../../../packages/backend/src/store";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const http = (name: string) => ({ type: "http", url: `https://example.test/${name}` });
const codes = (candidate: NativeMcpCandidate) =>
  (candidate.warning_messages ?? []).map((message) => message.key.replace(/^.*diagnostic\./, ""));

function fixture() {
  const root = canonicalize(mkdtempSync(path.join(os.tmpdir(), "claude-mcp-settings-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"),
    managed = path.join(root, "managed"),
    repository = path.join(root, "repo"),
    project = path.join(root, "app");
  mkdirSync(home);
  mkdirSync(project, { recursive: true });
  const store = new BackendStore(path.join(root, "data", "db.sqlite"));
  cleanups.push(() => store.close());
  store.sql.run(
    "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
    "registered",
    project,
    "fixture",
    "healthy",
    new Date().toISOString(),
  );
  const environment = (extra: NodeJS.ProcessEnv = {}) => ({
    HOME: home,
    USERPROFILE: home,
    ...extra,
  });
  const globalFile = path.join(home, ".claude.json");
  const scan = (
    request: { project?: string } | null = { project },
    extra: NodeJS.ProcessEnv = {},
    managedDir: string | null = managed,
  ) => scanNativeMcp(request, store, environment(extra), { managedDir });
  const claude = (items: NativeMcpCandidate[], scope?: string) =>
    items.filter((item) => item.agent === "claude-code" && (!scope || item.scope === scope));
  const writeGlobal = (value: unknown) => writeFileSync(globalFile, JSON.stringify(value));
  const writeManaged = (text: string) => {
    mkdirSync(managed, { recursive: true });
    writeFileSync(path.join(managed, "managed-mcp.json"), text);
  };
  return {
    root,
    home,
    managed,
    project,
    repository,
    store,
    environment,
    globalFile,
    scan,
    claude,
    writeGlobal,
    writeManaged,
  };
}

// How the settings files change what the MCP view says about Claude Code servers
// (https://code.claude.com/docs/en/mcp "Project server approvals", managed-mcp "allowlists and
// denylists"): approval of .mcp.json servers, the allow and deny lists, and the servers an
// organization provides in managed settings.
const SECRET = "SETTINGS-ENV-CANARY-5f2e";
function withSettings(f: ReturnType<typeof fixture>) {
  const write = (file: string, value: unknown) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value));
  };
  return {
    user: (value: unknown) => write(path.join(f.home, ".claude", "settings.json"), value),
    project: (value: unknown) => write(path.join(f.project, ".claude", "settings.json"), value),
    local: (value: unknown) => write(path.join(f.project, ".claude", "settings.local.json"), value),
    managed: (value: unknown) => write(path.join(f.managed, "managed-settings.json"), value),
    projectServers: (servers: Record<string, unknown>) =>
      writeFileSync(path.join(f.project, ".mcp.json"), JSON.stringify({ mcpServers: servers })),
  };
}
const by = (items: NativeMcpCandidate[], name: string, scope?: string) =>
  items
    .filter((item) => item.name === name && (!scope || item.scope === scope))
    .map((item) => [item.scope, codes(item)]);

describe("approval of .mcp.json servers", () => {
  it("is pending until a settings file approves the server", () => {
    const f = fixture();
    const s = withSettings(f);
    s.projectServers({ one: http("1") });
    expect(by(f.claude(f.scan()), "one")).toEqual([["project", ["native_project_pending"]]]);
  });

  it("is approved by user or managed settings, by name or for all servers", () => {
    const f = fixture();
    const s = withSettings(f);
    s.projectServers({ one: http("1"), two: http("2"), three: http("3") });
    s.user({ enabledMcpjsonServers: ["one"] });
    s.managed({ enableAllProjectMcpServers: true });
    const items = f.claude(f.scan());
    for (const name of ["one", "two", "three"])
      expect(by(items, name)).toEqual([["project", ["native_project_approved"]]]);
    rmSync(path.join(f.managed, "managed-settings.json"));
    const again = f.claude(f.scan());
    expect(by(again, "one")).toEqual([["project", ["native_project_approved"]]]);
    expect(by(again, "two")).toEqual([["project", ["native_project_pending"]]]);
  });

  it("depends on the trust decision when only the project or local file approves it", () => {
    const f = fixture();
    const s = withSettings(f);
    s.projectServers({ one: http("1"), two: http("2") });
    s.project({ enabledMcpjsonServers: ["one"] });
    s.local({ enabledMcpjsonServers: ["two"] });
    const items = f.claude(f.scan());
    expect(by(items, "one")).toEqual([["project", ["native_project_approved_if_trusted"]]]);
    expect(by(items, "two")).toEqual([["project", ["native_project_approved_if_trusted"]]]);
  });

  it("is approved once the matching project entry records that the folder is trusted", () => {
    const f = fixture();
    const s = withSettings(f);
    f.writeGlobal({
      mcpServers: { one: http("u") },
      projects: { [f.project]: { hasTrustDialogAccepted: true } },
    });
    s.projectServers({ one: http("1"), two: http("2") });
    s.local({ enabledMcpjsonServers: ["one"] });
    s.project({ enabledMcpjsonServers: ["two"] });
    const items = f.claude(f.scan());
    expect(by(items, "one", "project")).toEqual([["project", ["native_project_approved"]]]);
    expect(by(items, "two", "project")).toEqual([["project", ["native_project_approved"]]]);
    expect(by(items, "one", "home")).toEqual([["home", ["native_overridden_by_project"]]]);
  });
  it("ignores trust recorded only for another project", () => {
    const f = fixture();
    const s = withSettings(f);
    f.writeGlobal({
      mcpServers: { one: http("u") },
      projects: {
        "/tmp/other-project-alpha": { hasTrustDialogAccepted: true },
        [path.dirname(f.project)]: { hasTrustDialogAccepted: true },
        [f.project]: { mcpServers: {} },
      },
    });
    s.projectServers({ one: http("1") });
    s.local({ enabledMcpjsonServers: ["one"] });
    const items = f.claude(f.scan());
    expect(by(items, "one", "project")).toEqual([
      ["project", ["native_project_approved_if_trusted"]],
    ]);
    expect(by(items, "one", "home")).toEqual([["home", ["native_overridden_if_approved"]]]);
    expect(JSON.stringify(items)).not.toMatch(/other-project-alpha|hasTrustDialogAccepted/);
  });
  it("counts only a boolean true as trust", () => {
    for (const value of ["true", 1, "yes", null, [true], {}]) {
      const f = fixture();
      const s = withSettings(f);
      f.writeGlobal({ projects: { [f.project]: { hasTrustDialogAccepted: value } } });
      s.projectServers({ one: http("1") });
      s.local({ enabledMcpjsonServers: ["one"] });
      expect(by(f.claude(f.scan()), "one")).toEqual([
        ["project", ["native_project_approved_if_trusted"]],
      ]);
    }
  });
  it("still rejects a trusted folder's server listed in disabledMcpjsonServers", () => {
    const f = fixture();
    const s = withSettings(f);
    f.writeGlobal({ projects: { [f.project]: { hasTrustDialogAccepted: true } } });
    s.projectServers({ one: http("1") });
    s.local({ enabledMcpjsonServers: ["one"], disabledMcpjsonServers: ["one"] });
    expect(by(f.claude(f.scan()), "one")).toEqual([["project", ["native_project_rejected"]]]);
  });
  it("is rejected by disabledMcpjsonServers in any file, whatever else approves it", () => {
    const f = fixture();
    const s = withSettings(f);
    s.projectServers({ one: http("1") });
    s.user({ enabledMcpjsonServers: ["one"], enableAllProjectMcpServers: true });
    s.project({ disabledMcpjsonServers: ["one"] });
    expect(by(f.claude(f.scan()), "one")).toEqual([["project", ["native_project_rejected"]]]);
  });

  it("decides whether a user server is overridden by the same name in .mcp.json", () => {
    const f = fixture();
    const s = withSettings(f);
    f.writeGlobal({ mcpServers: { a: http("u"), b: http("u"), c: http("u"), d: http("u") } });
    s.projectServers({ a: http("p"), b: http("p"), c: http("p"), d: http("p") });
    s.user({ enabledMcpjsonServers: ["a"], disabledMcpjsonServers: ["c"] });
    s.project({ enabledMcpjsonServers: ["b"] });
    const items = f.claude(f.scan());
    expect(by(items, "a", "home")).toEqual([["home", ["native_overridden_by_project"]]]);
    expect(by(items, "b", "home")).toEqual([["home", ["native_overridden_if_approved"]]]);
    expect(by(items, "c", "home")).toEqual([["home", []]]);
    expect(by(items, "d", "home")).toEqual([["home", ["native_overridden_if_approved"]]]);
  });
});

describe("allow and deny lists", () => {
  it("block a server by name, URL pattern or exact command", () => {
    const f = fixture();
    const s = withSettings(f);
    f.writeGlobal({
      mcpServers: {
        byName: http("x"),
        byUrl: { type: "http", url: "https://blocked.example/sse" },
        byCommand: { command: "node", args: ["server.js"] },
        fine: http("fine"),
      },
    });
    s.user({
      deniedMcpServers: [{ serverName: "byName" }],
    });
    s.project({
      deniedMcpServers: [
        { serverUrl: "https://blocked.*/sse" },
        { serverCommand: ["node", "server.js"] },
      ],
    });
    const items = f.claude(f.scan());
    for (const name of ["byName", "byUrl", "byCommand"])
      expect(by(items, name).flat(2)).toContain("native_policy_denied");
    expect(by(items, "fine")).toEqual([["home", []]]);
  });

  it("restrict servers to the allow list, where an empty list allows none", () => {
    const f = fixture();
    const s = withSettings(f);
    f.writeGlobal({ mcpServers: { listed: http("a"), unlisted: http("b") } });
    s.managed({ allowedMcpServers: [{ serverName: "listed" }] });
    let items = f.claude(f.scan());
    expect(by(items, "listed", "home")).toEqual([["home", []]]);
    expect(by(items, "unlisted", "home")).toEqual([["home", ["native_policy_not_allowed"]]]);
    s.managed({ allowedMcpServers: [] });
    items = f.claude(f.scan());
    expect(by(items, "listed", "home")).toEqual([["home", ["native_policy_not_allowed"]]]);
  });

  it("merge across layers unless the managed list is the only one", () => {
    const f = fixture();
    const s = withSettings(f);
    f.writeGlobal({ mcpServers: { fromUser: http("a"), fromManaged: http("b") } });
    s.managed({ allowedMcpServers: [{ serverName: "fromManaged" }] });
    s.user({ allowedMcpServers: [{ serverName: "fromUser" }] });
    let items = f.claude(f.scan());
    expect(by(items, "fromUser", "home")).toEqual([["home", []]]);
    s.managed({
      allowedMcpServers: [{ serverName: "fromManaged" }],
      allowManagedMcpServersOnly: true,
    });
    items = f.claude(f.scan());
    expect(by(items, "fromUser", "home")).toEqual([["home", ["native_policy_not_allowed"]]]);
    expect(by(items, "fromManaged", "home")).toEqual([["home", []]]);
  });

  it("do not apply the allow list to managed-mcp.json, but the deny list still applies", () => {
    const f = fixture();
    const s = withSettings(f);
    f.writeManaged(JSON.stringify({ mcpServers: { org: http("org"), banned: http("b") } }));
    s.managed({ allowedMcpServers: [], deniedMcpServers: [{ serverName: "banned" }] });
    const items = f.claude(f.scan(), "managed");
    expect(by(items, "org")).toEqual([["managed", ["native_readonly_scope"]]]);
    expect(by(items, "banned").flat(2)).toContain("native_policy_denied");
  });
});

describe("servers an organization provides in managed settings", () => {
  it("are listed read-only without any credential, and win over the same name elsewhere", () => {
    const f = fixture();
    const s = withSettings(f);
    f.writeGlobal({ mcpServers: { provided: http("user"), other: http("other") } });
    s.managed({
      managedMcpServers: {
        provided: {
          type: "http",
          url: "https://org.example",
          headers: { Authorization: `Bearer ${SECRET}` },
        },
      },
    });
    const items = f.scan();
    const text = JSON.stringify(items);
    expect(text).not.toContain(SECRET);
    expect(by(f.claude(items), "provided")).toEqual([
      ["managed", ["native_readonly_scope"]],
      ["home", ["native_overridden_by_managed_setting"]],
    ]);
    expect(f.claude(items, "managed")[0]!.supported).toBe(false);
  });
});

describe("settings never leak through the MCP view", () => {
  it("shows no value of an env block or a command", () => {
    const f = fixture();
    const s = withSettings(f);
    s.user({
      env: { ANTHROPIC_AUTH_TOKEN: SECRET },
      apiKeyHelper: `echo ${SECRET}`,
      enabledMcpjsonServers: ["x"],
    });
    s.project({
      env: { TOKEN: SECRET },
      hooks: { Stop: [{ hooks: [{ type: "command", command: `run ${SECRET}` }] }] },
    });
    s.projectServers({ x: http("x") });
    expect(JSON.stringify(f.scan())).not.toContain(SECRET);
  });

  it("changes nothing for another agent's candidates", () => {
    const f = fixture();
    const s = withSettings(f);
    mkdirSync(path.join(f.home, ".codex"));
    writeFileSync(
      path.join(f.home, ".codex", "config.toml"),
      '[mcp_servers.fx]\ncommand = "node"\nargs = ["x.js"]\n',
    );
    const before = JSON.stringify(f.scan().filter((item) => item.agent !== "claude-code"));
    s.managed({ allowedMcpServers: [], deniedMcpServers: [{ serverName: "fx" }] });
    s.user({ enabledMcpjsonServers: ["fx"] });
    expect(JSON.stringify(f.scan().filter((item) => item.agent !== "claude-code"))).toBe(before);
  });
});
