import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  scanNativeMcp,
  type NativeMcpCandidate,
} from "../../../packages/backend/src/mcp-native-scan";
import { canonicalize } from "../../../packages/backend/src/paths";
import { BackendStore } from "../../../packages/backend/src/store";

const readFailures = vi.hoisted(() => new Set<string>());
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (typeof args[0] === "string" && readFailures.has(args[0]))
        throw Object.assign(new Error("Synthetic global config read failure"), { code: "EACCES" });
      return actual.readFileSync(...args);
    },
  };
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  readFailures.clear();
});

const http = (name: string) => ({ type: "http", url: `https://example.test/${name}` });
const codes = (candidate: NativeMcpCandidate) =>
  (candidate.warning_messages ?? []).map((message) => message.key.replace(/^.*diagnostic\./, ""));
const SECRET = "GLOBAL-GATE-SECRET-CANARY-83af";
const OTHER_PROJECT = "OTHER-PROJECT-PRIVATE-CANARY-427c";
const loadingUnverified = "native_claude_loading_unverified";
type Gate = "usable" | "legacy-default" | "legacy-custom" | "invalid-variable";

function fixture(gate: Gate = "usable") {
  const root = canonicalize(mkdtempSync(path.join(os.tmpdir(), "mcp-claude-global-gate-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"),
    project = path.join(root, "project"),
    managed = path.join(root, "managed"),
    config = path.join(gate === "legacy-custom" ? root : home, ".claude");
  const write = (file: string, value: unknown) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value));
  };
  for (const directory of [home, project, config]) mkdirSync(directory, { recursive: true });
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
  if (gate.startsWith("legacy")) write(path.join(config, ".config.json"), {});
  const globalFile = path.join(gate === "legacy-custom" ? config : home, ".claude.json");
  const scan = () =>
    scanNativeMcp(
      { project },
      store,
      {
        HOME: home,
        USERPROFILE: home,
        ...(gate === "legacy-custom" ? { CLAUDE_CONFIG_DIR: config } : {}),
        ...(gate === "invalid-variable" ? { CLAUDE_CONFIG_DIR: "relative/claude" } : {}),
      },
      { managedDir: managed },
    ).filter((candidate) => candidate.agent === "claude-code");
  return {
    project,
    config,
    managed,
    globalFile,
    scan,
    global: (value: unknown) => write(globalFile, value),
    globalText: (value: string) => writeFileSync(globalFile, value),
    projectServers: (servers: Record<string, unknown>) =>
      write(path.join(project, ".mcp.json"), { mcpServers: servers }),
    projectSettings: (value: unknown) =>
      write(path.join(project, ".claude", "settings.json"), value),
    userSettings: (value: unknown) => write(path.join(config, "settings.json"), value),
    managedSettings: (value: unknown) => write(path.join(managed, "managed-settings.json"), value),
    installPlugin: (servers: Record<string, unknown>) => {
      const install = path.join(config, "plugins", "cache", "market", "tool", "1");
      write(path.join(install, ".mcp.json"), { mcpServers: servers });
      write(path.join(config, "plugins", "installed_plugins.json"), {
        version: 2,
        plugins: { "tool@market": [{ scope: "user", installPath: install, version: "1" }] },
      });
    },
  };
}

function candidate(items: NativeMcpCandidate[], name: string, scope: string) {
  const found = items.find((item) => item.name === name && item.scope === scope);
  expect(found).toBeDefined();
  return found!;
}

describe("Claude global config gate evidence", () => {
  it.each<Gate>(["legacy-default", "legacy-custom", "invalid-variable"])(
    "keeps %s entries visible without trusting their approval, disabled state or local precedence",
    (gate) => {
      const f = fixture(gate);
      f.projectServers({ subject: http("project"), stopped: http("stopped") });
      f.projectSettings({ enableAllProjectMcpServers: true });
      f.global({
        mcpServers: { subject: http("user") },
        projects: {
          [f.project]: {
            hasTrustDialogAccepted: true,
            disabledMcpServers: ["stopped"],
            mcpServers: { subject: { ...http("local"), headers: { Authorization: SECRET } } },
          },
          [path.join(f.project, OTHER_PROJECT)]: {
            mcpServers: { [OTHER_PROJECT]: http(OTHER_PROJECT) },
          },
        },
      });

      const items = f.scan();
      for (const name of ["subject", "stopped"])
        expect(codes(candidate(items, name, "project"))).toEqual([
          "native_project_approved_if_trusted",
          loadingUnverified,
        ]);
      for (const scope of ["home", "local"]) {
        const item = candidate(items, "subject", scope);
        expect(item.supported).toBe(false);
        expect(codes(item)).toEqual([
          ...(scope === "local" ? ["native_readonly_scope"] : []),
          "native_claude_config_unusable",
        ]);
      }
      expect(candidate(items, "subject", "local").has_secret_values).toBe(true);
      expect(JSON.stringify(items)).not.toContain(SECRET);
      expect(JSON.stringify(items)).not.toContain(OTHER_PROJECT);
    },
  );

  it("does not use uncertain global entries to replace plugin endpoints", () => {
    const f = fixture("legacy-default");
    f.installPlugin({ localCopy: http("local"), userCopy: http("user") });
    f.userSettings({ enabledPlugins: { "tool@market": true } });
    f.global({
      mcpServers: { user: http("user") },
      projects: { [f.project]: { mcpServers: { subject: http("local") } } },
    });

    const items = f.scan();
    for (const name of ["localCopy", "userCopy"]) {
      expect(codes(candidate(items, name, "plugin"))).toContain(loadingUnverified);
      expect(codes(candidate(items, name, "plugin"))).not.toContain("native_plugin_duplicate");
    }
  });

  it("does not infer loading from approval when the displayed local and disabled entries are uncertain", () => {
    const f = fixture("legacy-default");
    f.installPlugin({
      projectCopy: http("project"),
      localCopy: http("local"),
      userCopy: http("user"),
    });
    f.userSettings({ enableAllProjectMcpServers: true, enabledPlugins: { "tool@market": true } });
    f.projectServers({ subject: http("project") });
    f.global({
      mcpServers: { user: http("user") },
      projects: {
        [f.project]: {
          mcpServers: { subject: http("local") },
          disabledMcpServers: ["subject", "plugin:tool:projectCopy"],
        },
      },
    });

    const items = f.scan();
    const project = candidate(items, "subject", "project");
    expect(project.supported).toBe(true);
    expect(codes(project)).toEqual(["native_project_approved", loadingUnverified]);
    expect(project.warnings.join("\n")).not.toContain("Claude Code loads this");
    for (const name of ["projectCopy", "localCopy", "userCopy"]) {
      expect(codes(candidate(items, name, "plugin"))).toContain(loadingUnverified);
      expect(codes(candidate(items, name, "plugin"))).not.toContain("native_disabled_for_project");
      expect(codes(candidate(items, name, "plugin"))).not.toContain("native_plugin_duplicate");
    }
  });

  it.each(["user", "managed"] as const)(
    "does not infer that missing local or disabled entries are absent despite independent %s approval",
    (layer) => {
      const f = fixture("legacy-default");
      f.global({});
      f.projectServers({ subject: http("project") });
      f.installPlugin({ projectCopy: http("project") });
      f.userSettings({
        enabledPlugins: { "tool@market": true },
        ...(layer === "user" ? { enableAllProjectMcpServers: true } : {}),
      });
      if (layer === "managed") f.managedSettings({ enableAllProjectMcpServers: true });

      const items = f.scan();
      const project = candidate(items, "subject", "project");
      expect(project.supported).toBe(true);
      expect(codes(project)).toEqual(["native_project_approved", loadingUnverified]);
      expect(project.warnings.join("\n")).not.toContain("Claude Code loads this");
      expect(codes(candidate(items, "projectCopy", "plugin"))).toContain(loadingUnverified);
      expect(codes(candidate(items, "projectCopy", "plugin"))).not.toContain(
        "native_plugin_duplicate",
      );
    },
  );

  it("retains trusted approval, disabled state, local precedence and plugin dedupe with a usable gate", () => {
    const f = fixture();
    f.installPlugin({
      projectCopy: http("project"),
      localCopy: http("local"),
      userCopy: http("user"),
    });
    f.userSettings({ enabledPlugins: { "tool@market": true } });
    f.projectSettings({ enableAllProjectMcpServers: true });
    f.projectServers({ subject: http("project"), stopped: http("stopped") });
    f.global({
      mcpServers: { user: http("user") },
      projects: {
        [f.project]: {
          hasTrustDialogAccepted: true,
          disabledMcpServers: ["stopped"],
          mcpServers: { subject: http("local") },
        },
      },
    });

    const items = f.scan();
    expect(codes(candidate(items, "subject", "project"))).toEqual([
      "native_project_approved",
      "native_overridden_by_local",
    ]);
    expect(codes(candidate(items, "stopped", "project"))).toEqual([
      "native_project_approved",
      "native_disabled_for_project",
    ]);
    expect(codes(candidate(items, "projectCopy", "plugin"))).not.toContain(
      "native_plugin_duplicate",
    );
    for (const name of ["localCopy", "userCopy"])
      expect(codes(candidate(items, name, "plugin"))).toContain("native_plugin_duplicate");
  });

  it.each(["unreadable", "malformed", "oversized", "blank", "non-object"] as const)(
    "does not infer local or disabled records are absent when the selected global file is %s",
    (failure) => {
      const f = fixture();
      f.projectServers({ subject: http("project"), blocked: http("blocked") });
      f.installPlugin({ projectCopy: http("project"), managedCopy: http("managed") });
      f.userSettings({ enableAllProjectMcpServers: true, enabledPlugins: { "tool@market": true } });
      f.managedSettings({
        managedMcpServers: { provided: http("managed") },
        deniedMcpServers: [{ serverName: "blocked" }],
      });
      if (failure === "unreadable") {
        f.global({});
        readFailures.add(f.globalFile);
      } else
        f.globalText(
          failure === "malformed"
            ? `{${SECRET}`
            : failure === "oversized"
              ? "x".repeat(1024 * 1024 + 1)
              : failure === "blank"
                ? " \n"
                : "[]",
        );

      const items = f.scan();
      expect(codes(candidate(items, "subject", "project"))).toEqual([
        "native_project_approved",
        loadingUnverified,
      ]);
      expect(candidate(items, "subject", "project").supported).toBe(true);
      expect(codes(candidate(items, "blocked", "project"))).toContain("native_policy_denied");
      for (const name of ["projectCopy", "managedCopy"]) {
        expect(codes(candidate(items, name, "plugin"))).toContain(loadingUnverified);
        expect(codes(candidate(items, name, "plugin"))).not.toContain("native_plugin_duplicate");
      }
      expect(codes(candidate(items, "provided", "managed"))).toEqual(["native_readonly_scope"]);
      expect(codes(candidate(items, "Configuration unavailable", "home"))).toEqual([
        "native_config_unavailable",
      ]);
      expect(JSON.stringify(items)).not.toContain(SECRET);
    },
  );

  it("uses normal defaults when the optional global file is confirmed absent", () => {
    const f = fixture();
    f.projectServers({ subject: http("project") });
    f.installPlugin({ projectCopy: http("project") });
    f.userSettings({ enableAllProjectMcpServers: true, enabledPlugins: { "tool@market": true } });

    const items = f.scan();
    expect(codes(candidate(items, "subject", "project"))).toEqual(["native_project_approved"]);
    expect(codes(candidate(items, "projectCopy", "plugin"))).toContain("native_plugin_duplicate");
    expect(items.some((item) => codes(item).includes(loadingUnverified))).toBe(false);
    expect(items.some((item) => item.scope === "home")).toBe(false);
  });

  it("retains managed approval and policy evidence when the global gate is unusable", () => {
    const f = fixture("legacy-default");
    f.projectServers({ provided: http("project"), blocked: http("blocked"), other: http("other") });
    f.global({ projects: { [f.project]: { disabledMcpServers: ["provided"] } } });
    f.installPlugin({ managedCopy: http("managed") });
    f.userSettings({ enabledPlugins: { "tool@market": true } });
    f.managedSettings({
      enableAllProjectMcpServers: true,
      managedMcpServers: { provided: http("managed") },
      deniedMcpServers: [{ serverName: "blocked" }],
      allowedMcpServers: [{ serverName: "provided" }, { serverName: "plugin:tool:managedCopy" }],
    });

    const items = f.scan();
    expect(codes(candidate(items, "provided", "project"))).toEqual([
      "native_project_approved",
      loadingUnverified,
      "native_overridden_by_managed_setting",
    ]);
    expect(codes(candidate(items, "blocked", "project"))).toEqual([
      "native_project_approved",
      loadingUnverified,
      "native_policy_denied",
    ]);
    expect(codes(candidate(items, "other", "project"))).toEqual([
      "native_project_approved",
      loadingUnverified,
      "native_policy_not_allowed",
    ]);
    expect(codes(candidate(items, "provided", "managed"))).toEqual(["native_readonly_scope"]);
    expect(codes(candidate(items, "managedCopy", "plugin"))).toContain(loadingUnverified);
    expect(codes(candidate(items, "managedCopy", "plugin"))).not.toContain(
      "native_plugin_duplicate",
    );
  });

  it("retains parsed managed-mcp exclusivity without treating uncertain project-disabled records as managed policy", () => {
    const f = fixture("legacy-default");
    f.projectServers({ subject: http("project") });
    f.installPlugin({ managedCopy: http("managed") });
    f.userSettings({ enableAllProjectMcpServers: true, enabledPlugins: { "tool@market": true } });
    f.global({ projects: { [f.project]: { disabledMcpServers: ["subject"] } } });
    mkdirSync(f.managed, { recursive: true });
    writeFileSync(
      path.join(f.managed, "managed-mcp.json"),
      JSON.stringify({ mcpServers: { subject: http("managed") } }),
    );

    const items = f.scan();
    expect(codes(candidate(items, "subject", "managed"))).toEqual(["native_readonly_scope"]);
    expect(codes(candidate(items, "subject", "project"))).toEqual([
      "native_project_approved",
      loadingUnverified,
      "native_inactive_exclusive",
    ]);
    const pluginCodes = codes(candidate(items, "managedCopy", "plugin"));
    expect(pluginCodes).toContain(loadingUnverified);
    expect(pluginCodes).toContain("native_inactive_exclusive");
    expect(pluginCodes).not.toContain("native_plugin_duplicate");
  });
});
