import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mergeToml, type Connection } from "../../../packages/backend/src/config-merge";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const connection: Connection = {
  name: "docs",
  transport: "stdio",
  command: "docs-mcp",
  args: [],
  env: {},
  allow_tools: [],
  targets: [],
};

function configFile(content?: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentkib-config-merge-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "config.toml");
  if (content !== undefined) writeFileSync(file, content);
  return file;
}

describe("mergeToml", () => {
  it("creates the managed block for a missing config", () => {
    const merged = mergeToml(configFile(), [connection], "codex");
    expect(merged).toContain("# agentkib:managed:start");
    expect(merged).toContain("[mcp_servers.docs]");
    expect(merged).toContain('command = "docs-mcp"');
  });

  it("keeps unrelated settings of a valid config", () => {
    const merged = mergeToml(configFile('model = "fixture"\n'), [connection], "codex");
    expect(merged).toContain('model = "fixture"');
    expect(merged).toContain("[mcp_servers.docs]");
  });

  it("rejects an unmanaged server with the same name", () => {
    const file = configFile('[mcp_servers.docs]\ncommand = "other"\n');
    expect(() => mergeToml(file, [connection], "codex")).toThrow(/unmanaged MCP/);
  });

  it("fails early with the file name when the existing config is not valid TOML", () => {
    const file = configFile('[mcp_servers.docs\ncommand = "other"\n');
    expect(() => mergeToml(file, [connection], "codex")).toThrow(`Invalid TOML: ${file}`);
  });
});
