import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readNativeMcpImports,
  scanNativeMcp,
  type NativeMcpCandidate,
} from "../../../packages/backend/src/mcp-native-scan";
import { planNativeMcpMigration } from "../../../packages/backend/src/mcp-migration-plan";
import type { McpManager } from "../../../packages/backend/src/mcp";
import { canonicalize } from "../../../packages/backend/src/paths";
import { BackendStore } from "../../../packages/backend/src/store";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const key = (code: string) => `mcp.manage.diagnostic.${code}`;
const http = (name: string) => ({ type: "http", url: `https://example.test/${name}` });
const codes = (candidate: NativeMcpCandidate) =>
  (candidate.warning_messages ?? []).map((message) => message.key.replace(/^.*diagnostic\./, ""));

function fixture(options: { repository?: boolean } = {}) {
  const root = canonicalize(mkdtempSync(path.join(os.tmpdir(), "claude-mcp-scopes-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"),
    managed = path.join(root, "managed"),
    repository = path.join(root, "repo"),
    project = options.repository
      ? path.join(repository, "packages", "app")
      : path.join(root, "app");
  mkdirSync(home);
  mkdirSync(project, { recursive: true });
  if (options.repository) mkdirSync(path.join(repository, ".git"));
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

// The other two projects stand for everything else in ~/.claude.json. None of their paths or
// server names may ever appear in a result.
const OTHERS = {
  "/tmp/other-project-alpha": {
    mcpServers: { "alpha-private-server": http("alpha") },
    disabledMcpServers: ["alpha-off"],
    history: [{ display: "alpha-prompt-text" }],
  },
  "/Users/someone/private-beta/": {
    mcpServers: { "beta-private-server": http("beta") },
    hasTrustDialogAccepted: true,
  },
};
const LEAKS = [
  "other-project-alpha",
  "private-beta",
  "alpha-private-server",
  "beta-private-server",
  "alpha-off",
  "alpha-prompt-text",
  "hasTrustDialogAccepted",
  '"projects"',
];

describe("Claude Code local scope in the native MCP scan", () => {
  it("shows only the current project's local entries and nothing of the other projects", () => {
    const f = fixture();
    f.writeGlobal({
      mcpServers: { "user-one": http("user-one") },
      projects: {
        ...OTHERS,
        [f.project]: {
          mcpServers: { "local-one": http("local-one"), "local-two": { command: "node" } },
        },
      },
    });
    const candidates = f.scan();
    expect(
      f.claude(candidates, "local").map((item) => [item.name, item.supported, item.transport]),
    ).toEqual([
      ["local-one", false, "http"],
      ["local-two", false, "stdio"],
    ]);
    const text = JSON.stringify(candidates);
    for (const leak of LEAKS) expect(text).not.toContain(leak);
    expect(f.claude(candidates, "local")[0]).toMatchObject({
      agent: "claude-code",
      scope: "local",
      source_path: f.globalFile,
      endpoint: "https://example.test/local-one",
      has_secret_values: false,
      warnings: [
        "Read-only: this local-scope server is shown for reference. AgentKib does not collect or migrate it.",
      ],
      warning_messages: [{ key: key("native_readonly_scope"), params: { scope: "local" } }],
    });
    expect(f.claude(candidates, "local")[0]!.fingerprint).toBeUndefined();
  });

  it("shows no local entry when the project has none or the scan names no project", () => {
    const f = fixture();
    f.writeGlobal({ projects: { ...OTHERS, [f.project]: { allowedTools: [] } } });
    expect(f.claude(f.scan(), "local")).toEqual([]);
    f.writeGlobal({ projects: { ...OTHERS } });
    const text = JSON.stringify(f.scan());
    for (const leak of LEAKS) expect(text).not.toContain(leak);
    f.writeGlobal({
      projects: { ...OTHERS, [f.project]: { mcpServers: { mine: http("mine") } } },
    });
    expect(f.claude(f.scan(null), "local")).toEqual([]);
    expect(f.claude(f.scan({}), "local")).toEqual([]);
  });

  it.each([
    ["with a trailing separator", (project: string) => `${project}${path.sep}`],
    ["with repeated trailing separators", (project: string) => `${project}${path.sep}${path.sep}`],
  ])("matches a project key written %s", (_name, written) => {
    const f = fixture();
    f.writeGlobal({ projects: { [written(f.project)]: { mcpServers: { mine: http("mine") } } } });
    expect(f.claude(f.scan(), "local").map((item) => item.name)).toEqual(["mine"]);
  });

  it.skipIf(process.platform === "win32")(
    "matches the real path when the workspace is reached through a symbolic link",
    () => {
      const f = fixture();
      const link = path.join(f.root, "link-app");
      symlinkSync(f.project, link);
      f.writeGlobal({
        projects: { ...OTHERS, [f.project]: { mcpServers: { mine: http("mine") } } },
      });
      expect(f.claude(f.scan({ project: link }), "local").map((item) => item.name)).toEqual([
        "mine",
      ]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not read a key that only differs by case on a case-sensitive comparison",
    () => {
      const f = fixture();
      f.writeGlobal({
        projects: { [f.project.toUpperCase()]: { mcpServers: { wrong: http("wrong") } } },
      });
      if (f.project.toUpperCase() !== f.project) expect(f.claude(f.scan(), "local")).toEqual([]);
    },
  );

  describe("which path names the project", () => {
    it("reads the entry of the repository root when the workspace is below it", () => {
      const f = fixture({ repository: true });
      f.writeGlobal({
        projects: { ...OTHERS, [f.repository]: { mcpServers: { "repo-entry": http("r") } } },
      });
      expect(f.claude(f.scan(), "local").map((item) => item.name)).toEqual(["repo-entry"]);
    });

    it("falls back to the entry of the workspace root", () => {
      const f = fixture({ repository: true });
      f.writeGlobal({
        projects: { [f.project]: { mcpServers: { "workspace-entry": http("w") } } },
      });
      expect(f.claude(f.scan(), "local").map((item) => item.name)).toEqual(["workspace-entry"]);
    });

    it("takes the repository root's entry when both exist and does not merge them", () => {
      const f = fixture({ repository: true });
      f.writeGlobal({
        projects: {
          [f.project]: { mcpServers: { "workspace-entry": http("w") } },
          [f.repository]: { mcpServers: { "repo-entry": http("r") } },
        },
      });
      expect(f.claude(f.scan(), "local").map((item) => item.name)).toEqual(["repo-entry"]);
    });
  });

  it("keeps the local and the user entry of one name apart, and the user id as it was", () => {
    const f = fixture();
    f.writeGlobal({
      mcpServers: { same: http("user") },
      projects: { [f.project]: { mcpServers: { same: http("local") } } },
    });
    const same = f.claude(f.scan()).filter((item) => item.name === "same");
    expect(same.map((item) => item.scope)).toEqual(["local", "home"]);
    expect(new Set(same.map((item) => item.id)).size).toBe(2);
    const legacy = createHash("sha256").update(`${f.globalFile}:same`).digest("hex").slice(0, 24);
    expect(same.find((item) => item.scope === "home")!.id).toBe(legacy);
    expect(same.find((item) => item.scope === "local")!.endpoint).toBe(
      "https://example.test/local",
    );
    expect(same.find((item) => item.scope === "home")!.endpoint).toBe("https://example.test/user");
  });

  it("says nothing new about a project-only or user-only name", () => {
    const f = fixture();
    f.writeGlobal({ mcpServers: { "user-only": http("u") } });
    writeFileSync(
      path.join(f.project, ".mcp.json"),
      JSON.stringify({ mcpServers: { "project-only": http("p") } }),
    );
    const claude = f.claude(f.scan());
    expect(claude.map((item) => [item.scope, item.name, item.supported, codes(item)])).toEqual([
      ["project", "project-only", true, ["native_project_pending"]],
      ["home", "user-only", true, []],
    ]);
  });
});

describe("Claude Code scope precedence", () => {
  function layered() {
    const f = fixture();
    f.writeGlobal({
      mcpServers: { shared: http("user"), "user-vs-project": http("user"), solo: http("solo") },
      projects: { [f.project]: { mcpServers: { shared: http("local") } } },
    });
    writeFileSync(
      path.join(f.project, ".mcp.json"),
      JSON.stringify({
        mcpServers: { shared: http("project"), "user-vs-project": http("project") },
      }),
    );
    return f;
  }
  const by = (items: NativeMcpCandidate[], name: string) =>
    items.filter((item) => item.name === name).map((item) => [item.scope, codes(item)]);

  it("marks the entries a local server of the same name overrides, and lists them strongest first", () => {
    const f = layered();
    const items = f.claude(f.scan());
    expect(by(items, "shared")).toEqual([
      ["local", ["native_readonly_scope"]],
      ["project", ["native_project_pending", "native_overridden_by_local"]],
      ["home", ["native_overridden_by_local"]],
    ]);
    const overriddenText = items.find((item) => item.name === "shared" && item.scope === "home")!;
    expect(overriddenText.warnings).toEqual([
      "Overridden: Claude Code uses the local-scope server with the same name instead.",
    ]);
  });

  it("marks a user entry as overridden if the project's .mcp.json one is approved", () => {
    const f = layered();
    const items = f.claude(f.scan());
    expect(by(items, "user-vs-project")).toEqual([
      ["project", ["native_project_pending"]],
      ["home", ["native_overridden_if_approved"]],
    ]);
    const text = items.find((item) => item.name === "user-vs-project" && item.scope === "home")!;
    expect(text.warnings[0]).toContain("Overridden if the same-named server in .mcp.json");
    expect(by(items, "solo")).toEqual([["home", []]]);
  });

  it("marks every entry of a name that /mcp disabled for this project", () => {
    const f = fixture();
    f.writeGlobal({
      mcpServers: { quiet: http("u"), loud: http("u") },
      projects: {
        ...OTHERS,
        [f.project]: { mcpServers: { quiet: http("l") }, disabledMcpServers: ["quiet", "absent"] },
      },
    });
    const items = f.claude(f.scan());
    expect(by(items, "quiet")).toEqual([
      ["local", ["native_readonly_scope", "native_disabled_for_project"]],
      ["home", ["native_overridden_by_local", "native_disabled_for_project"]],
    ]);
    expect(by(items, "loud")).toEqual([["home", []]]);
    const text = JSON.stringify(items);
    expect(text).not.toContain("absent");
    for (const leak of LEAKS) expect(text).not.toContain(leak);
  });

  it("does not apply another project's disabled list", () => {
    const f = fixture();
    f.writeGlobal({
      mcpServers: { loud: http("u") },
      projects: { ...OTHERS, "/tmp/other-project-alpha": { disabledMcpServers: ["loud"] } },
    });
    expect(by(f.claude(f.scan()), "loud")).toEqual([["home", []]]);
  });
});

describe("Claude Code managed-mcp.json", () => {
  it("shows its servers read-only and leaves every other scope not loaded", () => {
    const f = fixture();
    f.writeGlobal({
      mcpServers: { "user-one": http("u") },
      projects: { [f.project]: { mcpServers: { "local-one": http("l") } } },
    });
    writeFileSync(
      path.join(f.project, ".mcp.json"),
      JSON.stringify({ mcpServers: { "project-one": http("p") } }),
    );
    f.writeManaged(JSON.stringify({ mcpServers: { "managed-one": http("m") } }));
    const items = f.claude(f.scan());
    expect(items.map((item) => [item.scope, item.name, item.supported])).toEqual([
      ["local", "local-one", false],
      ["managed", "managed-one", false],
      ["project", "project-one", true],
      ["home", "user-one", true],
    ]);
    for (const item of items)
      expect(codes(item).includes("native_inactive_exclusive")).toBe(item.scope !== "managed");
    const managed = items.find((item) => item.scope === "managed")!;
    expect(managed).toMatchObject({
      source_path: path.join(f.managed, "managed-mcp.json"),
      warning_messages: [{ key: key("native_readonly_scope"), params: { scope: "managed" } }],
    });
  });

  it("treats an empty server table as the organization turning everything off", () => {
    const f = fixture();
    f.writeGlobal({ mcpServers: { "user-one": http("u") } });
    f.writeManaged('{"mcpServers":{}}');
    const items = f.claude(f.scan());
    expect(items.map((item) => [item.scope, item.name, codes(item)])).toEqual([
      ["home", "user-one", ["native_inactive_exclusive"]],
    ]);
  });

  it("does not reach a verdict from a managed file it cannot parse", () => {
    const f = fixture();
    f.writeGlobal({ mcpServers: { "user-one": http("u") } });
    f.writeManaged("{ not json");
    const items = f.claude(f.scan());
    const managed = items.filter((item) => item.scope === "managed");
    expect(managed).toHaveLength(1);
    expect(managed[0]).toMatchObject({
      name: "Configuration unavailable",
      supported: false,
      source_path: path.join(f.managed, "managed-mcp.json"),
    });
    expect(codes(items.find((item) => item.name === "user-one")!)).toEqual([]);
  });

  it("is absent without a file, and is read without a project too", () => {
    const f = fixture();
    f.writeGlobal({ mcpServers: { "user-one": http("u") } });
    expect(f.claude(f.scan(), "managed")).toEqual([]);
    expect(f.claude(f.scan(null, {}, null), "managed")).toEqual([]);
    f.writeManaged(JSON.stringify({ mcpServers: { "managed-one": http("m") } }));
    expect(f.claude(f.scan(null), "managed").map((item) => item.name)).toEqual(["managed-one"]);
  });
});

describe("read-only guarantees", () => {
  it("rejects collecting and migrating local and managed candidates and never writes", async () => {
    const f = fixture();
    f.writeGlobal({ projects: { [f.project]: { mcpServers: { "local-one": http("l") } } } });
    f.writeManaged(JSON.stringify({ mcpServers: { "managed-one": http("m") } }));
    const before = readFileSync(f.globalFile, "utf8");
    const readonly = [...f.claude(f.scan(), "local"), ...f.claude(f.scan(), "managed")];
    expect(readonly).toHaveLength(2);
    for (const result of readNativeMcpImports(readonly, f.project)) {
      expect("error" in result && String((result.error as Error).message)).toBe(
        "Unsupported native MCP entry",
      );
    }
    // The migration planner scans again with the real managed folder, so only the local one can be named.
    for (const candidate of f.claude(readonly, "local"))
      await expect(
        planNativeMcpMigration(
          { project: f.project, candidateIds: [candidate.id] },
          f.store,
          {} as McpManager,
          f.environment(),
        ),
      ).rejects.toThrow("Unsupported native MCP candidates cannot be migrated automatically");
    expect(readFileSync(f.globalFile, "utf8")).toBe(before);
  });

  it("still lets the user scope be collected exactly as before", () => {
    const f = fixture();
    f.writeGlobal({
      mcpServers: { "user-one": http("u") },
      projects: { [f.project]: { mcpServers: { "user-one": http("l") } } },
    });
    const user = f.claude(f.scan(), "home")[0]!;
    // Being overridden is a note, not a block: the entry stays collectable and migratable.
    expect(user).toMatchObject({ supported: true, name: "user-one" });
    expect(codes(user)).toEqual(["native_overridden_by_local"]);
    const [result] = readNativeMcpImports([user], f.project);
    expect(result && "error" in result).toBe(false);
    expect(user.fingerprint).toBe(
      createHash("sha256").update(readFileSync(f.globalFile, "utf8")).digest("hex"),
    );
  });
});

describe("redaction of the new scopes", () => {
  it("never shows a secret value and still reports that there are some", () => {
    const f = fixture();
    const secret = {
      "with-headers": {
        type: "http",
        url: "https://example.test/h",
        headers: { Authorization: "Bearer HEADER-SECRET-VALUE" },
      },
      "with-env": { command: "node", args: ["server.js"], env: { API_KEY: "ENV-SECRET-VALUE" } },
      "with-oauth": {
        type: "http",
        url: "https://example.test/o",
        oauth: { clientId: "id", clientSecret: "OAUTH-SECRET-VALUE" },
      },
      "with-url-credentials": {
        type: "http",
        url: "https://user:URL-SECRET-VALUE@example.test/c",
      },
      "with-flag": { command: "node", args: ["--token", "ARG-SECRET-VALUE"] },
    };
    f.writeGlobal({ projects: { [f.project]: { mcpServers: secret } } });
    f.writeManaged(JSON.stringify({ mcpServers: secret }));
    const items = [...f.claude(f.scan(), "local"), ...f.claude(f.scan(), "managed")];
    expect(items).toHaveLength(10);
    expect(JSON.stringify(items)).not.toMatch(/SECRET-VALUE/);
    for (const scope of ["local", "managed"]) {
      const flagged = (name: string) =>
        items.find((item) => item.scope === scope && item.name === name)!.has_secret_values;
      expect(flagged("with-headers")).toBe(true);
      expect(flagged("with-env")).toBe(true);
      expect(flagged("with-oauth")).toBe(true);
    }
  });
});

describe("unchanged outside the new scopes", () => {
  it("returns the same candidates as before when there is no local entry and no managed file", () => {
    const f = fixture();
    f.writeGlobal({ mcpServers: { "user-one": http("u"), "user-two": { command: "node" } } });
    writeFileSync(
      path.join(f.project, ".mcp.json"),
      JSON.stringify({ mcpServers: { "project-one": http("p") } }),
    );
    expect(f.claude(f.scan())).toEqual([
      expect.objectContaining({
        id: createHash("sha256")
          .update(`${path.join(f.project, ".mcp.json")}:project-one`)
          .digest("hex")
          .slice(0, 24),
        scope: "project",
        name: "project-one",
        supported: true,
        // Nothing approves the server yet: the one addition, from the settings files.
        warning_messages: [{ key: key("native_project_pending") }],
      }),
      expect.objectContaining({
        scope: "home",
        name: "user-one",
        supported: true,
        warnings: [],
        warning_messages: [],
      }),
      // A stdio server has no known working directory at user scope, as before.
      expect.objectContaining({
        scope: "home",
        name: "user-two",
        supported: false,
        warning_messages: [{ key: key("native_working_directory") }],
      }),
    ]);
  });

  it("leaves other agents' candidates identical whatever the Claude scopes hold", () => {
    const f = fixture();
    mkdirSync(path.join(f.home, ".codex"));
    writeFileSync(
      path.join(f.home, ".codex", "config.toml"),
      '[mcp_servers.docs]\nurl = "https://example.test/docs"\n',
    );
    writeFileSync(
      path.join(f.project, ".mcp.json"),
      JSON.stringify({ mcpServers: { docs: http("p") } }),
    );
    const others = () => f.scan().filter((item) => item.agent !== "claude-code");
    f.writeGlobal({ mcpServers: { docs: http("u") } });
    const before = others();
    expect(before.length).toBeGreaterThan(0);
    f.writeGlobal({
      mcpServers: { docs: http("u") },
      projects: { [f.project]: { mcpServers: { docs: http("l") }, disabledMcpServers: ["docs"] } },
    });
    f.writeManaged(JSON.stringify({ mcpServers: { docs: http("m") } }));
    expect(others()).toEqual(before);
  });

  it("makes the user and the local scope unavailable together when the file is too large", () => {
    const f = fixture();
    writeFileSync(f.globalFile, "x".repeat(1024 * 1024 + 1));
    const items = f.claude(f.scan());
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name: "Configuration unavailable", supported: false });
    expect(JSON.stringify(items)).not.toContain("local");
  });

  it("gives local entries the same caveat as user entries when the file in use is uncertain", () => {
    const f = fixture();
    f.writeGlobal({
      mcpServers: { "user-one": http("u") },
      projects: { [f.project]: { mcpServers: { "local-one": http("l") } } },
    });
    const items = f.claude(f.scan({ project: f.project }, { CLAUDE_CONFIG_DIR: "relative/dir" }));
    expect(items.map((item) => [item.scope, item.supported, codes(item)])).toEqual([
      ["local", false, ["native_readonly_scope", "native_claude_config_unusable"]],
      ["home", false, ["native_claude_config_unusable"]],
    ]);
  });
});
