import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  scanNativeMcp,
  type NativeMcpCandidate,
} from "../../../packages/backend/src/mcp-native-scan";
import { canonicalize } from "../../../packages/backend/src/paths";
import { BackendStore } from "../../../packages/backend/src/store";
import { defaultIo } from "../../../packages/backend/src/context-claude-sources";

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

describe("incomplete settings coverage", () => {
  const writeDropIn = (f: ReturnType<typeof fixture>, name: string, value: unknown) => {
    const directory = path.join(f.managed, "managed-settings.d");
    mkdirSync(directory, { recursive: true });
    const file = path.join(directory, name);
    writeFileSync(file, JSON.stringify(value));
    return file;
  };
  const assertUnknown = (items: NativeMcpCandidate[]) => {
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(codes(item)).toContain("native_config_unavailable");
      expect(codes(item)).not.toContain("native_project_approved");
      expect(codes(item)).not.toContain("native_policy_denied");
      expect(codes(item)).not.toContain("native_policy_not_allowed");
      expect(codes(item)).not.toContain("native_plugin_duplicate");
      expect(codes(item).some((code) => code.startsWith("native_overridden"))).toBe(false);
      expect(item.warnings.join("\n")).toContain("settings coverage is incomplete");
    }
  };

  it.each(["denied", "allowed"])(
    "does not claim approval or precedence when the 65th drop-in could change %s policy",
    (kind) => {
      const f = fixture();
      const settings = withSettings(f);
      settings.user({ enableAllProjectMcpServers: true });
      settings.projectServers({ subject: http("project") });
      f.writeGlobal({ mcpServers: { subject: http("user") } });
      for (let index = 1; index <= 63; index++)
        writeDropIn(f, `${String(index).padStart(3, "0")}.json`, {});
      writeDropIn(
        f,
        "065-policy.json",
        kind === "denied"
          ? { deniedMcpServers: [{ serverName: "subject" }] }
          : { allowedMcpServers: [{ serverName: "other" }], allowManagedMcpServersOnly: true },
      );
      const before = f.claude(f.scan());
      expect(by(before, "subject", "project").flat(2)).toContain(
        kind === "denied" ? "native_policy_denied" : "native_policy_not_allowed",
      );
      writeDropIn(f, "064.json", {});
      const after = f.claude(f.scan());
      assertUnknown(after);
      expect(after.map((item) => [item.scope, item.supported])).toEqual(
        before.map((item) => [item.scope, item.supported]),
      );
    },
  );

  it("does not infer managed overrides or plugin replacement from a partial policy", () => {
    const f = fixture();
    const settings = withSettings(f);
    const install = path.join(f.home, ".claude", "plugins", "cache", "market", "tool", "1");
    mkdirSync(install, { recursive: true });
    writeFileSync(path.join(install, ".mcp.json"), JSON.stringify({ plugin: http("same") }));
    writeFileSync(
      path.join(f.home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "tool@market": [{ scope: "user", installPath: install, version: "1" }] },
      }),
    );
    settings.user({ enabledPlugins: { "tool@market": true } });
    settings.managed({ managedMcpServers: { subject: http("same") } });
    f.writeGlobal({ mcpServers: { subject: http("other") } });
    const before = f.claude(f.scan());
    expect(by(before, "subject", "home").flat(2)).toContain("native_overridden_by_managed_setting");
    expect(by(before, "plugin").flat(2)).toContain("native_plugin_duplicate");
    for (let index = 0; index < 65; index++) writeDropIn(f, `${index}.json`, {});
    const after = f.claude(f.scan());
    expect(after.map((item) => [item.scope, item.name])).toEqual(
      before.map((item) => [item.scope, item.name]),
    );
    assertUnknown(after);
  });

  it.each(["directory", "drop-in", "base", "user"])(
    "does not infer loading when a known %s settings source cannot be read",
    (source) => {
      const f = fixture();
      const settings = withSettings(f);
      settings.user({ enableAllProjectMcpServers: true });
      settings.managed({ deniedMcpServers: [{ serverName: "subject" }] });
      settings.projectServers({ subject: http("project") });
      const dropIn = writeDropIn(f, "policy.json", { disabledMcpjsonServers: ["subject"] });
      const target =
        source === "directory"
          ? path.dirname(dropIn)
          : source === "drop-in"
            ? dropIn
            : source === "base"
              ? path.join(f.managed, "managed-settings.json")
              : path.join(f.home, ".claude", "settings.json");
      const fail = () => {
        throw Object.assign(new Error("fixture cannot read"), { code: "EACCES" });
      };
      const originalRead = defaultIo.readFile;
      const originalList = defaultIo.readdir;
      const mock =
        source === "directory"
          ? vi.spyOn(defaultIo, "readdir").mockImplementation((file) =>
              file === target ? fail() : originalList(file),
            )
          : vi.spyOn(defaultIo, "readFile").mockImplementation((file, limit) =>
              file === target ? fail() : originalRead(file, limit),
            );
      try {
        assertUnknown(f.claude(f.scan()));
      } finally {
        mock.mockRestore();
      }
    },
  );
});

describe("plugin server identity", () => {
  function installPlugin(
    f: ReturnType<typeof fixture>,
    servers: Record<string, unknown>,
    settings: Record<string, unknown> = {},
  ) {
    const install = path.join(f.home, ".claude", "plugins", "cache", "market", "tool", "1");
    mkdirSync(install, { recursive: true });
    writeFileSync(path.join(install, ".mcp.json"), JSON.stringify({ mcpServers: servers }));
    writeFileSync(
      path.join(f.home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "tool@market": [{ scope: "user", installPath: install, version: "1" }] },
      }),
    );
    withSettings(f).user({ enabledPlugins: { "tool@market": true }, ...settings });
  }

  it("compares complete stdio argument arrays instead of executable labels", () => {
    const f = fixture();
    installPlugin(f, {
      same: { command: "npx", args: ["-y", "same-server"] },
      other: { command: "npx", args: ["-y", "other-server"] },
      joined: { command: "node", args: ["a b"] },
      split: { command: "node", args: ["a", "b"] },
      noArgs: { command: "fixture-command" },
    });
    f.writeGlobal({
      projects: {
        [f.project]: {
          mcpServers: {
            direct: { command: "npx", args: ["-y", "same-server"] },
            array: { command: "node", args: ["a", "b"] },
            empty: { command: "fixture-command", args: [] },
          },
        },
      },
    });
    const items = f.claude(f.scan(), "plugin");
    for (const name of ["same", "split", "noArgs"])
      expect(by(items, name).flat(2)).toContain("native_plugin_duplicate");
    for (const name of ["other", "joined"])
      expect(by(items, name).flat(2)).not.toContain("native_plugin_duplicate");
  });

  it("does not let an unrelated local name override or disable a plugin server", () => {
    const f = fixture();
    installPlugin(
      f,
      { shared: http("plugin"), blocked: http("blocked"), stopped: http("stop") },
      {
        deniedMcpServers: [{ serverName: "shared" }, { serverName: "plugin:tool:blocked" }],
      },
    );
    f.writeGlobal({
      projects: {
        [f.project]: {
          mcpServers: { shared: http("local") },
          disabledMcpServers: ["shared", "plugin:tool:stopped"],
        },
      },
    });
    const items = f.claude(f.scan());
    expect(by(items, "shared", "local").flat(2)).toContain("native_policy_denied");
    const shared = by(items, "shared", "plugin").flat(2);
    expect(shared).not.toContain("native_overridden_by_local");
    expect(shared).not.toContain("native_disabled_for_project");
    expect(shared).not.toContain("native_policy_denied");
    expect(shared).not.toContain("native_plugin_duplicate");
    expect(by(items, "blocked", "plugin").flat(2)).toContain("native_policy_denied");
    expect(by(items, "stopped", "plugin").flat(2)).toContain("native_disabled_for_project");
  });

  it("uses the namespaced name for allowlists while retaining display labels", () => {
    const f = fixture();
    installPlugin(
      f,
      { allowed: http("one"), other: http("two") },
      {
        allowedMcpServers: [{ serverName: "plugin:tool:allowed" }],
      },
    );
    const items = f.claude(f.scan(), "plugin");
    expect(items.map((item) => item.name)).toEqual(["allowed", "other"]);
    expect(by(items, "allowed").flat(2)).not.toContain("native_policy_not_allowed");
    expect(by(items, "other").flat(2)).toContain("native_policy_not_allowed");
  });

  it("normalizes remote host and port without conflating queries or unsafe credentials", () => {
    const f = fixture();
    const url = "https://example.test/mcp?token=";
    installPlugin(f, {
      same: { type: "http", url: "HTTPS://EXAMPLE.TEST:443/mcp/" },
      otherPath: http("different"),
      otherQuery: { type: "http", url: "https://example.test/mcp?project=other" },
      sameToken: { type: "http", url: `${url}PRIVATE-ONE` },
      otherToken: { type: "http", url: `${url}PRIVATE-TWO` },
    });
    f.writeGlobal({
      mcpServers: {
        direct: { type: "http", url: "https://example.test/mcp" },
        credential: { type: "http", url: `${url}PRIVATE-ONE` },
      },
    });
    const items = f.claude(f.scan(), "plugin");
    expect(by(items, "same").flat(2)).toContain("native_plugin_duplicate");
    for (const name of ["otherPath", "otherQuery", "sameToken", "otherToken"])
      expect(by(items, name).flat(2)).not.toContain("native_plugin_duplicate");
    for (const name of ["sameToken", "otherToken"]) {
      expect(items.find((item) => item.name === name)?.endpoint).toBe("unavailable");
      expect(by(items, name).flat(2)).toContain("native_review_configuration");
    }
    expect(JSON.stringify(items)).not.toMatch(/PRIVATE-ONE|PRIVATE-TWO/);
  });

  it.each(["disabled", "denied", "overridden", "pending", "rejected"])(
    "does not mark a plugin duplicate of a %s direct definition",
    (state) => {
      const f = fixture();
      installPlugin(
        f,
        { plugin: http("same") },
        {
          ...(state === "denied" ? { deniedMcpServers: [{ serverName: "direct" }] } : {}),
          ...(state === "rejected" ? { disabledMcpjsonServers: ["direct"] } : {}),
        },
      );
      if (state === "pending" || state === "rejected")
        withSettings(f).projectServers({ direct: http("same") });
      else
        f.writeGlobal({
          mcpServers: { direct: http("same") },
          projects: {
            [f.project]: {
              ...(state === "disabled" ? { disabledMcpServers: ["direct"] } : {}),
              ...(state === "overridden" ? { mcpServers: { direct: http("other") } } : {}),
            },
          },
        });
      expect(by(f.claude(f.scan(), "plugin"), "plugin").flat(2)).not.toContain(
        "native_plugin_duplicate",
      );
    },
  );
});

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

  it.each([1023, 1024, 1025, 4097])(
    "retains /mcp disabled diagnostics across a %i-item list without changing approval or files",
    (count) => {
      const f = fixture();
      const s = withSettings(f);
      const disabled = Array.from({ length: count }, (_, index) => `disabled-${index}`);
      const names = [disabled[0]!, disabled[Math.floor(count / 2)]!, disabled.at(-1)!];
      s.projectServers(Object.fromEntries([...names, "enabled"].map((name) => [name, http(name)])));
      s.user({ enableAllProjectMcpServers: true });
      f.writeGlobal({
        projects: {
          [f.project]: { disabledMcpServers: disabled },
          [path.join(f.root, "unrelated")]: { disabledMcpServers: ["enabled"] },
        },
      });
      const files = [
        f.globalFile,
        path.join(f.project, ".mcp.json"),
        path.join(f.home, ".claude/settings.json"),
      ];
      const before = files.map((file) => readFileSync(file));
      const items = f.claude(f.scan());
      for (const name of names)
        expect(by(items, name)).toEqual([
          ["project", ["native_project_approved", "native_disabled_for_project"]],
        ]);
      expect(by(items, "enabled")).toEqual([["project", ["native_project_approved"]]]);
      expect(files.map((file) => readFileSync(file))).toEqual(before);
    },
  );

  it("matches a complete disabled name instead of applying a display length cap", () => {
    const f = fixture();
    const s = withSettings(f);
    const name = `disabled-${"x".repeat(256)}`;
    s.projectServers({ [name]: http("long-name"), enabled: http("enabled") });
    s.user({ enableAllProjectMcpServers: true });
    f.writeGlobal({ projects: { [f.project]: { disabledMcpServers: [name] } } });
    const items = f.claude(f.scan());
    expect(by(items, name)).toEqual([
      ["project", ["native_project_approved", "native_disabled_for_project"]],
    ]);
    expect(by(items, "enabled")).toEqual([["project", ["native_project_approved"]]]);
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
  it.each([
    ["https://example.test/mcp", "https://example.test/mcp", true],
    ["https://example.test/mcp", "https://example.test/mcp/extra", false],
    ["https://example.test/*", "https://example.test/", true],
    ["https://example.test/*", "https://other.test/mcp", false],
    ["*/mcp", "https://example.test/mcp", true],
    ["*/mcp", "https://example.test/mcp/extra", false],
    ["https://*/a**b*c", "https://example.test/ab-middle-c", true],
    ["https://*/a*b*c", "https://example.test/acb", false],
    ["https://example.test/a*a", "https://example.test/a", false],
    ["https://example.test/*ababac*", "https://example.test/ababababac/end", true],
    ["https://example.test/*?x=[a]+(b).$", "https://example.test/mcp?x=[a]+(b).$", true],
    ["https://example.test/*?x=[a]+(b).$", "https://example.test/mcp?x=abZ", false],
    ["https://example.test/*你好*😀", "https://example.test/路径你好/😀", true],
    ["***", "https://example.test/mcp", true],
  ])("matches only literal URL runs and stars: %s against %s", (pattern, url, matches) => {
    const f = fixture();
    f.writeGlobal({ mcpServers: { subject: { type: "http", url } } });
    withSettings(f).user({
      allowedMcpServers: [{ serverUrl: pattern }],
      deniedMcpServers: [{ serverUrl: pattern }],
    });
    const warnings = codes(f.claude(f.scan(), "home")[0]!);
    expect(warnings.includes("native_policy_denied")).toBe(matches);
    expect(warnings.includes("native_policy_not_allowed")).toBe(!matches);
  });

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
