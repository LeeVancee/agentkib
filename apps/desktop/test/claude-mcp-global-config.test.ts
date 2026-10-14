import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

const unusable = "mcp.manage.diagnostic.native_claude_config_unusable";
const unusableWarning =
  "AgentKib cannot tell which Claude configuration file is in use (CLAUDE_CONFIG_DIR is unusable, or a legacy .config.json exists), so what is shown from this file may not match Claude Code, and migration is turned off for it.";

function fixture() {
  const root = canonicalize(mkdtempSync(path.join(os.tmpdir(), "claude-mcp-global-config-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"),
    defaults = path.join(home, ".claude"),
    custom = path.join(root, "custom-claude"),
    project = path.join(root, "project");
  for (const directory of [home, defaults, custom, project]) mkdirSync(directory);
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
  const server = (name: string) =>
    JSON.stringify({ mcpServers: { [name]: { url: `https://example.test/${name}` } } });
  const scan = (variable?: string) =>
    scanNativeMcp({ project }, store, {
      HOME: home,
      USERPROFILE: home,
      ...(variable === undefined ? {} : { CLAUDE_CONFIG_DIR: variable }),
    });
  const claudeHome = (candidates: NativeMcpCandidate[]) =>
    candidates.filter((item) => item.agent === "claude-code" && item.scope === "home");
  return { root, home, defaults, custom, project, server, scan, claudeHome };
}

describe("Claude global config file in the native MCP scan", () => {
  it("reads <home>/.claude.json while the variable is unset, exactly as before", () => {
    const f = fixture();
    writeFileSync(path.join(f.home, ".claude.json"), f.server("alpha"));
    const [candidate, ...rest] = f.claudeHome(f.scan());
    expect(rest).toEqual([]);
    expect(candidate).toMatchObject({
      agent: "claude-code",
      scope: "home",
      name: "alpha",
      source_path: path.join(f.home, ".claude.json"),
      transport: "http",
      endpoint: "https://example.test/alpha",
      supported: true,
      warnings: [],
      warning_messages: [],
    });
  });

  it("reads <dir>/.claude.json, and only that file, once the variable names a directory", () => {
    const f = fixture();
    writeFileSync(path.join(f.home, ".claude.json"), f.server("default-entry"));
    writeFileSync(path.join(f.custom, ".claude.json"), f.server("custom-entry"));
    for (const variable of [f.custom, `${f.custom}${path.sep}`]) {
      const [candidate, ...rest] = f.claudeHome(f.scan(variable));
      expect(rest).toEqual([]);
      expect(candidate).toMatchObject({
        name: "custom-entry",
        source_path: path.join(f.custom, ".claude.json"),
        supported: true,
        warnings: [],
      });
    }
  });

  it("keeps a variable that equals the default directory working, with the file inside it", () => {
    const f = fixture();
    writeFileSync(path.join(f.defaults, ".claude.json"), f.server("inside"));
    writeFileSync(path.join(f.home, ".claude.json"), f.server("outside"));
    const [candidate] = f.claudeHome(f.scan(f.defaults));
    expect(candidate).toMatchObject({
      name: "inside",
      source_path: path.join(f.defaults, ".claude.json"),
    });
  });

  it.each([
    ["relative", "relative/claude-dir"],
    ["home-relative", "~/.claude-work"],
    ["with a parent segment", "/tmp/claude/../other"],
    ["the filesystem root", "/"],
  ])("reads the default file but turns migration off when the variable is %s", (_name, value) => {
    if (process.platform === "win32") return;
    const f = fixture();
    writeFileSync(path.join(f.home, ".claude.json"), f.server("alpha"));
    const [candidate] = f.claudeHome(f.scan(value));
    expect(candidate).toMatchObject({
      name: "alpha",
      source_path: path.join(f.home, ".claude.json"),
      supported: false,
    });
    expect(candidate!.warnings).toContain(unusableWarning);
    expect(candidate!.warning_messages).toEqual([{ key: unusable }]);
  });

  it("turns migration off when a legacy .config.json sits beside the variable's directory", () => {
    const f = fixture();
    writeFileSync(path.join(f.custom, ".claude.json"), f.server("alpha"));
    writeFileSync(path.join(f.custom, ".config.json"), "{}");
    const [candidate] = f.claudeHome(f.scan(f.custom));
    expect(candidate).toMatchObject({ name: "alpha", supported: false });
    expect(candidate!.warning_messages).toEqual([{ key: unusable }]);
  });

  it("applies the same gate to ~/.claude/.config.json when the variable is unset", () => {
    const f = fixture();
    writeFileSync(path.join(f.home, ".claude.json"), f.server("alpha"));
    writeFileSync(path.join(f.defaults, ".config.json"), "{}");
    const [candidate] = f.claudeHome(f.scan());
    expect(candidate).toMatchObject({
      name: "alpha",
      source_path: path.join(f.home, ".claude.json"),
      supported: false,
    });
    expect(candidate!.warning_messages).toEqual([{ key: unusable }]);
  });

  it("leaves candidates from other files and other agents untouched when the gate is closed", () => {
    const f = fixture();
    writeFileSync(path.join(f.home, ".claude.json"), f.server("alpha"));
    writeFileSync(path.join(f.defaults, ".config.json"), "{}");
    writeFileSync(path.join(f.project, ".mcp.json"), f.server("shared"));
    mkdirSync(path.join(f.home, ".cursor"));
    writeFileSync(path.join(f.home, ".cursor", "mcp.json"), f.server("editor"));
    const candidates = f.scan();
    const others = candidates.filter((item) => item.name === "shared" || item.name === "editor");
    expect(others.map((item) => [item.agent, item.scope, item.supported])).toEqual([
      ["claude-code", "project", true],
      ["cursor", "home", true],
    ]);
    for (const item of others) expect(item.warning_messages).toEqual([]);
  });

  it("adds the diagnostic exactly once to the placeholder of an unreadable file", () => {
    const f = fixture();
    writeFileSync(path.join(f.home, ".claude.json"), "x".repeat(1024 * 1024 + 1));
    const [candidate, ...rest] = f.claudeHome(f.scan("relative/claude-dir"));
    expect(rest).toEqual([]);
    expect(candidate).toMatchObject({ name: "Configuration unavailable", supported: false });
    expect(candidate!.warning_messages!.filter((message) => message.key === unusable)).toHaveLength(
      1,
    );
  });

  it.skipIf(process.platform === "win32")(
    "shows a symbolic-link configuration directory as unavailable instead of following it",
    () => {
      const f = fixture();
      const real = path.join(f.root, "real-claude");
      mkdirSync(real);
      writeFileSync(path.join(real, ".claude.json"), f.server("through-link"));
      symlinkSync(real, path.join(f.root, "link-claude"));
      const [candidate, ...rest] = f.claudeHome(f.scan(path.join(f.root, "link-claude")));
      expect(rest).toEqual([]);
      expect(candidate).toMatchObject({
        name: "Configuration unavailable",
        supported: false,
        source_path: path.join(f.root, "link-claude", ".claude.json"),
      });
    },
  );
});
