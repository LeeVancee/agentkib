import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readClaudeAssets } from "../../../packages/backend/src/claude-assets";
import { readClaudeSettings } from "../../../packages/backend/src/claude-settings";
import { scanNativeMcp } from "../../../packages/backend/src/mcp-native-scan";
import { canonicalize } from "../../../packages/backend/src/paths";
import { BackendStore } from "../../../packages/backend/src/store";
import { contextFixture, type ContextFixture } from "./fixtures/claude-context";

// Plugins, commands, agents, output styles, workflows and hooks, listed read-only
// (https://code.claude.com/docs/en/plugins/loading and /plugins/components). Settings decide which
// plugins are on; `installed_plugins.json` says where they live.

const fixtures: ContextFixture[] = [];
const cleanups: Array<() => void> = [];
function fixture() {
  const created = contextFixture();
  fixtures.push(created);
  return created;
}
afterEach(() => {
  for (const created of fixtures.splice(0)) created.dispose();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const json = (value: unknown) => JSON.stringify(value, null, 2);
const block = (
  preview: { sections: { source: string; scope: string; content: string }[] },
  title: string,
) => preview.sections.find((section) => section.scope === "assets" && section.source === title);
const everything = (value: unknown) => JSON.stringify(value);
const md = (front: Record<string, string>, body = "Body\n") =>
  `---\n${Object.entries(front)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n")}\n---\n${body}`;

/** A plugin on disk, recorded as installed and (by default) enabled in the user's settings. */
function plugin(
  f: ContextFixture,
  id: string,
  files: Record<string, string>,
  options: {
    enabled?: boolean | null;
    manifest?: unknown;
    extraEnabled?: Record<string, boolean>;
  } = {},
) {
  const [name, origin] = id.split("@");
  const dir = path.join(f.home, ".claude", "plugins", "cache", origin!, name!, "1.0.0");
  mkdirSync(dir, { recursive: true });
  for (const [relative, content] of Object.entries(files))
    f.write(path.join(dir, relative), content);
  if (options.manifest !== undefined)
    f.write(path.join(dir, ".claude-plugin", "plugin.json"), json(options.manifest));
  const record = path.join(f.home, ".claude", "plugins", "installed_plugins.json");
  let installed: { version: number; plugins: Record<string, unknown[]> } = {
    version: 2,
    plugins: {},
  };
  try {
    installed = JSON.parse(require("node:fs").readFileSync(record, "utf8"));
  } catch {
    // The first plugin creates the record.
  }
  installed.plugins[id] = [{ scope: "user", installPath: dir, version: "1.0.0" }];
  f.write(record, json(installed));
  if (options.enabled !== null) {
    const settingsFile = path.join(f.home, ".claude", "settings.json");
    let settings: { enabledPlugins?: Record<string, boolean> } = {};
    try {
      settings = JSON.parse(require("node:fs").readFileSync(settingsFile, "utf8"));
    } catch {
      // The first plugin creates the file.
    }
    settings.enabledPlugins = {
      ...settings.enabledPlugins,
      [id]: options.enabled ?? true,
      ...options.extraEnabled,
    };
    f.write(settingsFile, json(settings));
  }
  return dir;
}

describe("plugins", () => {
  it("lists the enabled plugins with the components each one provides", async () => {
    const f = fixture();
    plugin(
      f,
      "tool@market",
      {
        "commands/hello.md": md({ description: "Say hello" }),
        "commands/db/migrate.md": md({ description: "Run migrations" }),
        "agents/reviewer.md": md({
          name: "reviewer",
          description: "Reviews code",
          tools: "Read, Grep",
          model: "sonnet",
        }),
        "skills/lint/SKILL.md": "skill\n",
        "output-styles/terse.md": md({ name: "terse", description: "Short answers" }),
        "hooks/hooks.json": json({
          hooks: {
            PostToolUse: [
              { matcher: "Write|Edit", hooks: [{ type: "command", command: "./fmt.sh" }] },
            ],
          },
        }),
        ".mcp.json": json({ mcpServers: { db: { type: "http", url: "https://db.example" } } }),
      },
      { manifest: { name: "tool", version: "1.0.0" } },
    );
    plugin(f, "other@market", { "commands/x.md": md({ description: "x" }) }, { enabled: false });
    plugin(f, "idle@market", {}, { enabled: null });
    const preview = await f.request();
    const text = block(preview, "Claude Code plugins")!.content;
    expect(text).toContain(
      "- tool@market 1.0.0: enabled (user settings); 2 commands, 1 agent, 1 skill, 1 output style, 1 hook, 1 MCP server",
    );
    expect(text).toContain("commands: db:migrate, hello");
    expect(text).toContain("agents: reviewer");
    expect(text).toContain("skills: lint");
    expect(text).toContain("output styles: terse");
    expect(text).toContain("MCP servers: db");
    // A plugin that settings turn off, or never turn on, is not enabled.
    expect(text).not.toContain("- other@market");
    expect(text).toContain("Installed, not enabled: ");
    expect(text).toContain("other@market");
    expect(text).toContain("idle@market");
    const hooks = block(preview, "Claude Code hooks")!.content;
    expect(hooks).toContain("PostToolUse [Write|Edit]: command ./fmt.sh (plugin:tool@market)");
  });

  it("reports an enabled plugin that is not installed, and one whose folder is gone", async () => {
    const f = fixture();
    const dir = plugin(f, "gone@market", {});
    rmSync(dir, { recursive: true });
    f.user(
      "settings.json",
      json({ enabledPlugins: { "gone@market": true, "never@market": true } }),
    );
    const text = block(await f.request(), "Claude Code plugins")!.content;
    expect(text).toContain("- gone@market 1.0.0: enabled (user settings), not found on disk");
    expect(text).toContain("- never@market: enabled (user settings), not installed");
  });

  it("lets a manifest path replace the default commands folder", async () => {
    const f = fixture();
    plugin(
      f,
      "tool@market",
      {
        "commands/default.md": md({ description: "d" }),
        "extras/custom.md": md({ description: "c" }),
      },
      { manifest: { name: "tool", commands: ["./extras/"] } },
    );
    const text = block(await f.request(), "Claude Code plugins")!.content;
    expect(text).toContain("commands: custom");
    expect(text).not.toContain("default");
  });

  it("does not follow a link out of the plugin, and refuses an install path with ..", async () => {
    if (process.platform === "win32") return;
    const f = fixture();
    const dir = plugin(f, "tool@market", { "agents/ok.md": md({ description: "ok" }) });
    const outside = f.write(
      f.outside("elsewhere", "stolen.md"),
      md({ description: "LINK-CANARY" }),
    );
    symlinkSync(outside, path.join(dir, "agents", "stolen.md"));
    plugin(f, "bad@market", {});
    f.write(
      path.join(f.home, ".claude", "plugins", "installed_plugins.json"),
      json({
        version: 2,
        plugins: {
          "tool@market": [{ scope: "user", installPath: dir, version: "1" }],
          "bad@market": [{ scope: "user", installPath: `${dir}/../../escape`, version: "1" }],
        },
      }),
    );
    const preview = await f.request();
    const text = block(preview, "Claude Code plugins")!.content;
    expect(text).toMatch(/^ {4}agents: ok$/m);
    expect(text).not.toContain("stolen");
    expect(everything(preview)).not.toContain("LINK-CANARY");
    expect(text).toContain(
      "- bad@market 1: enabled (user settings), the install path is not usable",
    );
  });

  it("changes nothing when there are no plugins or assets", async () => {
    const f = fixture();
    f.write("CLAUDE.md", "project\n");
    const preview = await f.request();
    expect(preview.sections.map((section) => section.scope)).toEqual([""]);
    expect(preview.warnings).toEqual([]);
  });
});

describe("commands, agents, output styles and workflows", () => {
  it("lists the project's and the user's, with name, description, tools and model", async () => {
    const f = fixture();
    f.write(".claude/commands/review.md", md({ description: "Review the diff" }));
    f.write(".claude/commands/ops/deploy.md", md({ description: "Deploy" }));
    f.write(
      ".claude/agents/planner.md",
      md({ name: "planner", description: "Plans work", tools: "Read, Write", model: "opus" }),
    );
    f.write(".claude/output-styles/brief.md", md({ name: "Brief", description: "Be brief" }));
    f.write(".claude/workflows/fanout.js", "export default 1;\n");
    f.user("commands/mine.md", md({ description: "Mine" }));
    f.user("agents/helper.md", md({ description: "Helps" }));
    f.user("output-styles/calm.md", md({ description: "Calm" }));
    f.user("workflows/nightly.js", "export default 2;\n");
    const preview = await f.request();
    const commands = block(preview, "Claude Code commands")!.content;
    expect(commands).toContain("- review [project] - Review the diff");
    expect(commands).toContain("- ops:deploy [project] - Deploy");
    expect(commands).toContain("- mine [user] - Mine");
    expect(block(preview, "Claude Code agents")!.content).toContain(
      "- planner [project] - Plans work (tools: Read, Write; model: opus)",
    );
    expect(block(preview, "Claude Code agents")!.content).toContain("- helper [user] - Helps");
    expect(block(preview, "Claude Code output styles")!.content).toContain(
      "- Brief [project] - Be brief",
    );
    const workflows = block(preview, "Claude Code workflows")!.content;
    expect(workflows).toContain("- fanout [project]");
    expect(workflows).toContain("- nightly [user]");
  });

  it("redacts a description that carries a credential", async () => {
    const f = fixture();
    f.write(
      ".claude/commands/leak.md",
      md({ description: '"call with Authorization: Bearer ASSET-CANARY-1a2b3c4d5e6f7g8h"' }),
    );
    const preview = await f.request();
    expect(everything(preview)).not.toContain("ASSET-CANARY");
    expect(block(preview, "Claude Code commands")!.content).toContain("[REDACTED]");
  });

  it("stops at its bounds and says so", async () => {
    const f = fixture();
    for (let index = 0; index < 140; index++)
      f.write(`.claude/commands/c${String(index).padStart(3, "0")}.md`, md({ description: "d" }));
    const preview = await f.request();
    const lines = block(preview, "Claude Code commands")!.content.split("\n");
    expect(lines.length).toBeLessThanOrEqual(129);
    expect(preview.warnings.join("\n")).toContain("more files than AgentKib lists");
  });

  it("keeps a link that leads out of the workspace out of the project's list for MCP", async () => {
    if (process.platform === "win32") return;
    const f = fixture();
    f.link(
      f.write(f.outside("shared", "ext.md"), md({ description: "EXT" })),
      ".claude/commands/ext.md",
    );
    f.write(".claude/commands/inside.md", md({ description: "INSIDE" }));
    const preview = await f.mcp();
    const commands = block(preview, "Claude Code commands")!.content;
    expect(commands).toContain("- inside [project] - INSIDE");
    expect(commands).not.toContain("EXT");
    expect(preview.warnings.join("\n")).toContain("1 command outside the workspace");
  });
});

describe("hooks", () => {
  it("lists the hooks of every settings layer with redacted commands", async () => {
    const f = fixture();
    f.user(
      "settings.json",
      json({
        hooks: {
          Stop: [
            {
              hooks: [{ type: "command", command: "notify --token HOOK-CANARY-9z8y7x6w5v4u3t2s" }],
            },
          ],
        },
      }),
    );
    f.write(
      ".claude/settings.json",
      json({
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./check.sh" }] }],
        },
      }),
    );
    const preview = await f.request();
    const text = block(preview, "Claude Code hooks")!.content;
    expect(text).toContain("- PreToolUse [Bash]: command ./check.sh (project)");
    expect(text).toContain("- Stop: command notify --token [REDACTED] (user)");
    expect(everything(preview)).not.toContain("HOOK-CANARY");
  });
});

describe("over MCP", () => {
  it("gives the project's own items, and only counts for the user's items and the plugins", async () => {
    const f = fixture();
    plugin(f, "secretname@market", {
      "commands/plug.md": md({ description: "PLUGIN-DETAIL" }),
      "hooks/hooks.json": json({
        hooks: { Stop: [{ hooks: [{ type: "command", command: "./PLUGIN-HOOK.sh" }] }] },
      }),
    });
    f.user("commands/personal.md", md({ description: "PERSONAL-DETAIL" }));
    f.user("agents/personal-agent.md", md({ description: "PERSONAL-AGENT" }));
    f.write(".claude/commands/shared.md", md({ description: "SHARED-DETAIL" }));
    // The listing is Claude Code's; another Agent's context never carries these sources.
    expect(everything(await f.mcp(f.project, "codex"))).not.toContain("secretname");
    {
      const preview = await f.mcp(f.project, "claude-code");
      const output = everything(preview);
      expect(block(preview, "Claude Code commands")!.content).toBe(
        "- shared [project] - SHARED-DETAIL",
      );
      for (const hidden of [
        "PLUGIN-DETAIL",
        "PERSONAL-DETAIL",
        "PERSONAL-AGENT",
        "secretname",
        "PLUGIN-HOOK",
        f.home,
      ])
        expect(output).not.toContain(hidden);
      const notes = preview.warnings.join("\n");
      expect(notes).toContain("Claude Code commands: 1 command outside the workspace");
      expect(notes).toContain("Claude Code agents: 1 agent outside the workspace");
      expect(notes).toContain(
        "Claude Code plugins: 1 plugin enabled, 1 installed, providing 1 command, 0 agents, 0 output styles, 1 hook and 0 MCP servers",
      );
      expect(notes).toContain("Claude Code hooks: 1 hook from plugins");
    }
  });
});

describe("for the Doctor", () => {
  it("reads nothing", async () => {
    const f = fixture();
    plugin(f, "tool@market", { "commands/a.md": md({ description: "a" }) });
    f.write(".claude/commands/b.md", md({ description: "b" }));
    f.write("CLAUDE.md", "project\n");
    const preview = await f.resolve(f.project, { includeOutsideSources: false });
    expect(preview.sections.map((section) => section.scope)).toEqual([""]);
    expect(preview.warnings).toEqual([]);
    const assets = readClaudeAssets({
      root: f.project,
      dirs: [f.project],
      environment: f.environment,
      mode: "none",
      settings: readClaudeSettings({
        root: f.project,
        cwd: f.project,
        environment: f.environment,
        mode: "none",
      }),
    });
    expect(assets.plugins).toEqual([]);
    expect(assets.commands).toEqual([]);
  });
});

describe("plugin MCP servers in the MCP view", () => {
  function setup() {
    const f = fixture();
    const root = canonicalize(mkdtempSync(path.join(os.tmpdir(), "claude-plugin-mcp-")));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const store = new BackendStore(path.join(root, "db.sqlite"));
    cleanups.push(() => store.close());
    store.sql.run(
      "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
      "registered",
      f.project,
      "fixture",
      "healthy",
      new Date().toISOString(),
    );
    const scan = () =>
      scanNativeMcp({ project: f.project }, store, f.environment, {
        managedDir: f.managedDir,
      }).filter((item) => item.agent === "claude-code");
    return { f, scan };
  }
  const SECRET = "PLUGIN-MCP-CANARY-0a1b2c";

  it("shows them read-only with the plugin that provides them, without any credential", () => {
    const { f, scan } = setup();
    plugin(f, "tool@market", {
      ".mcp.json": json({
        mcpServers: {
          db: {
            type: "http",
            url: "https://db.example",
            headers: { Authorization: `Bearer ${SECRET}` },
          },
          local: { command: "node", args: ["server.js"], env: { TOKEN: SECRET } },
        },
      }),
    });
    plugin(
      f,
      "off@market",
      {
        ".mcp.json": json({
          mcpServers: { hidden: { type: "http", url: "https://hidden.example" } },
        }),
      },
      { enabled: false },
    );
    const items = scan().filter((item) => item.scope === "plugin");
    expect(items.map((item) => [item.name, item.supported, item.transport])).toEqual([
      ["db", false, "http"],
      ["local", false, "stdio"],
    ]);
    expect(JSON.stringify(items)).not.toContain(SECRET);
    expect(JSON.stringify(items)).not.toContain("hidden.example");
    const diagnostics = items[0]!.warning_messages!.map((message) => [message.key, message.params]);
    expect(diagnostics).toContainEqual([
      "mcp.manage.diagnostic.native_plugin_provided",
      { plugin: "tool@market" },
    ]);
    expect(items[0]!.has_secret_values).toBe(true);
  });

  it("marks a plugin server that duplicates one configured directly", () => {
    const { f, scan } = setup();
    plugin(f, "tool@market", {
      ".mcp.json": json({
        mcpServers: {
          twin: { type: "http", url: "https://same.example/mcp" },
          solo: { type: "http", url: "https://solo.example" },
        },
      }),
    });
    f.write(
      ".mcp.json",
      json({ mcpServers: { direct: { type: "http", url: "https://same.example/mcp" } } }),
    );
    const items = scan().filter((item) => item.scope === "plugin");
    const codes = (name: string) =>
      items
        .find((item) => item.name === name)!
        .warning_messages!.map((message) => message.key.replace(/^.*diagnostic\./, ""));
    expect(codes("twin")).toContain("native_plugin_duplicate");
    expect(codes("solo")).not.toContain("native_plugin_duplicate");
  });

  it("applies the deny list of managed settings to plugin servers", () => {
    const { f, scan } = setup();
    plugin(f, "tool@market", {
      ".mcp.json": json({ mcpServers: { banned: { type: "http", url: "https://b.example" } } }),
    });
    f.write(
      path.join(f.managedDir, "managed-settings.json"),
      json({ deniedMcpServers: [{ serverName: "banned" }] }),
    );
    const [item] = scan().filter((entry) => entry.scope === "plugin");
    expect(item!.warning_messages!.map((message) => message.key)).toContain(
      "mcp.manage.diagnostic.native_policy_denied",
    );
  });
});
