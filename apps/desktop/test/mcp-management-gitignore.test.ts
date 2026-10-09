import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Commands } from "../../../packages/backend/src/commands";
import { McpManager } from "../../../packages/backend/src/mcp";
import { McpManagement } from "../../../packages/backend/src/mcp-management";
import * as nativeFiles from "../../../packages/backend/src/native-files";
import { BackendStore } from "../../../packages/backend/src/store";
import { canonicalize } from "../../../packages/backend/src/paths";

const cleanups: Array<() => void | Promise<void>> = [];
const secret = "synthetic-gitignore-private-value";
const privateRelativePath = ".agentkib/mcp.local.json";
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fixture(ignore?: string) {
  const root = canonicalize(mkdtempSync(path.join(os.tmpdir(), "agentkib-mcp-gitignore-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"),
    project = path.join(root, "project"),
    data = path.join(root, "data");
  mkdirSync(home);
  mkdirSync(project);
  const environment: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home };
  // Do not inherit user excludes, repository overrides, config injection or Git templates.
  const gitEnvironment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    ...environment,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_SYSTEM: os.devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  execFileSync("git", ["init", "--quiet", "--template="], {
    cwd: project,
    env: gitEnvironment,
  });
  const ignoreFile = path.join(project, ".gitignore"),
    publicFile = path.join(project, ".agentkib/mcp.json"),
    privateFile = path.join(project, privateRelativePath);
  if (ignore !== undefined) writeFileSync(ignoreFile, ignore);
  const store = new BackendStore(path.join(data, "db.sqlite"));
  cleanups.push(() => store.close());
  store.sql.run(
    "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
    "registered",
    project,
    "fixture",
    "healthy",
    new Date().toISOString(),
  );
  const commands = new Commands();
  cleanups.push(() => commands.close());
  const manager = new McpManager(store.sql, environment, data, commands);
  cleanups.push(() => manager.closeAsync());
  const management = new McpManagement(store, environment, data, manager);
  const server = {
    id: "demo",
    name: "demo",
    transport: "streamable-http",
    url: "https://example.test/mcp",
    enabled: false,
  };
  const save = (value = secret) => {
    const state = management.state({ project });
    return management.save({
      project,
      revision: state.revision,
      originalId: state.servers.length ? "demo" : undefined,
      server,
      secretOperations: { env: { API_TOKEN: { action: "replace", value } } },
    });
  };
  const expectIgnored = () => {
    const result = spawnSync("git", ["check-ignore", "-q", privateRelativePath], {
      cwd: project,
      env: gitEnvironment,
      encoding: "utf8",
    });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  };
  return {
    home,
    project,
    management,
    server,
    ignoreFile,
    publicFile,
    privateFile,
    save,
    expectIgnored,
  };
}

function expectPrefix(file: string, prefix: string) {
  const before = Buffer.from(prefix);
  expect(readFileSync(file).subarray(0, before.length)).toEqual(before);
}

describe("MCP private configuration Git protection", () => {
  it.each([
    ["negated directory", ".agentkib/\n!.agentkib/\n"],
    ["negated exact file", ".agentkib/mcp.local.json\n!.agentkib/mcp.local.json\n"],
    ["negated wildcard", ".agentkib/mcp.local.json\n!.agentkib/*.json\n"],
    ["negated basename", "mcp.local.json\n!**/mcp.local.json\n"],
    ["CRLF rules", ".agentkib/\r\n!.agentkib/\r\n"],
    ["missing trailing newline", ".agentkib/\n!.agentkib/"],
    ["leading whitespace", " .agentkib/mcp.local.json\n"],
  ])("keeps saved secrets ignored after %s", (_name, before) => {
    const f = fixture(before);
    f.save();
    expect(readFileSync(f.privateFile, "utf8")).toContain(secret);
    expect(readFileSync(f.publicFile, "utf8")).not.toContain(secret);
    expectPrefix(f.ignoreFile, before);
    f.expectIgnored();
    const protectedBytes = readFileSync(f.ignoreFile);
    f.save(`${secret}-updated`);
    expect(readFileSync(f.ignoreFile)).toEqual(protectedBytes);
    f.expectIgnored();
  });

  it("protects secrets collected from pasted configuration after a negated directory", () => {
    const before = ".agentkib/\n!.agentkib/\n",
      f = fixture(before);
    const preview = f.management.previewImport({
      project: f.project,
      text: JSON.stringify({
        mcpServers: { demo: { url: f.server.url, env: { API_TOKEN: secret } } },
      }),
    });
    const result = f.management.applyImport({
      project: f.project,
      token: preview.token,
      revision: preview.revision,
      selections: preview.items.map((item) => ({ key: item.key, action: "add" })),
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.status).toBe("saved");
    expect(readFileSync(f.privateFile, "utf8")).toContain(secret);
    expect(readFileSync(f.publicFile, "utf8")).not.toContain(secret);
    expectPrefix(f.ignoreFile, before);
    f.expectIgnored();
  });

  it.each([
    ".agentkib/mcp.local.json\n",
    "mcp.local.json\r\n# retain this comment\r\n\r\n",
    ".agentkib/mcp.local.json",
  ])("retains an existing final file protection without appending: %j", (before) => {
    const f = fixture(before);
    f.save();
    f.save(`${secret}-updated`);
    expect(readFileSync(f.ignoreFile)).toEqual(Buffer.from(before));
    f.expectIgnored();
  });

  it.each([undefined, ".agentkib/\n"])(
    "keeps initial protection stable across repeated saves: %j",
    (before) => {
      const f = fixture(before);
      f.save();
      expectPrefix(f.ignoreFile, before ?? "");
      f.expectIgnored();
      const protectedBytes = readFileSync(f.ignoreFile);
      f.save(`${secret}-updated`);
      expect(readFileSync(f.ignoreFile)).toEqual(protectedBytes);
      f.expectIgnored();
    },
  );

  it("does not write workspace files or gitignore files for a global save", () => {
    const before = ".agentkib/\n!.agentkib/\n",
      f = fixture(before);
    f.management.save({
      revision: f.management.state({}).revision,
      server: f.server,
      secretOperations: { env: { API_TOKEN: { action: "replace", value: secret } } },
    });
    expect(readFileSync(path.join(f.home, privateRelativePath), "utf8")).toContain(secret);
    expect(readFileSync(f.ignoreFile)).toEqual(Buffer.from(before));
    expect(existsSync(path.join(f.project, ".agentkib"))).toBe(false);
    expect(existsSync(path.join(f.home, ".gitignore"))).toBe(false);
  });

  it("rolls back configuration files when repairing gitignore fails", () => {
    const before = ".agentkib/\n!.agentkib/\n",
      f = fixture(before),
      replaceFile = nativeFiles.replaceFile;
    vi.spyOn(nativeFiles, "replaceFile").mockImplementation((source, target) => {
      if (target === f.ignoreFile) throw new Error("fixture gitignore write failure");
      return replaceFile(source, target);
    });
    expect(() => f.save()).toThrow("fixture gitignore write failure");
    expect(existsSync(f.publicFile)).toBe(false);
    expect(existsSync(f.privateFile)).toBe(false);
    expect(readFileSync(f.ignoreFile)).toEqual(Buffer.from(before));
  });

  it("preserves an external gitignore edit and rolls back the private write", () => {
    const f = fixture(".agentkib/\n!.agentkib/\n"),
      external = "# externally edited while saving\n",
      replaceFile = nativeFiles.replaceFile;
    vi.spyOn(nativeFiles, "replaceFile").mockImplementation((source, target) => {
      const result = replaceFile(source, target);
      if (target === f.privateFile) writeFileSync(f.ignoreFile, external);
      return result;
    });
    expect(() => f.save()).toThrow(/File was modified externally/);
    expect(existsSync(f.publicFile)).toBe(false);
    expect(existsSync(f.privateFile)).toBe(false);
    expect(readFileSync(f.ignoreFile)).toEqual(Buffer.from(external));
  });
});
