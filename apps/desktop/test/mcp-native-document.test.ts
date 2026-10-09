import { describe, expect, it } from "vitest";
import type { Agent } from "../../../packages/backend/src/doctor-files";
import { parseNativeMcpDocument } from "../../../packages/backend/src/mcp-native-document";

const remote = { url: "https://fixture.invalid/mcp" };
const examples: Array<{ agent: Agent; file: string; content: string; document: unknown }> = [
  ...(["codex", "grok-build"] as const).map((agent) => ({
    agent,
    file: "config.toml",
    content: 'model = "fixture"\n[mcp_servers.tool]\nurl = "https://fixture.invalid/mcp"\n',
    document: { model: "fixture", mcp_servers: { tool: remote } },
  })),
  ...(["claude-code", "cursor", "antigravity", "deepseek-harness"] as const).map((agent) => ({
    agent,
    file: "config.json",
    content: JSON.stringify({ model: "fixture", mcpServers: { tool: remote } }),
    document: { model: "fixture", mcpServers: { tool: remote } },
  })),
  {
    agent: "opencode",
    file: "opencode.json",
    content: JSON.stringify({ model: "fixture", mcp: { tool: remote } }),
    document: { model: "fixture", mcp: { tool: remote } },
  },
  {
    agent: "opencode",
    file: "opencode.jsonc",
    content:
      '{ // native comments\nmodel: "fixture", mcp: {tool: {url: "https://fixture.invalid/mcp"}},}',
    document: { model: "fixture", mcp: { tool: remote } },
  },
  {
    agent: "open-claw",
    file: "openclaw.json",
    content:
      '{model: "fixture", mcp: {other: true, servers: {tool: {url: "https://fixture.invalid/mcp"}}},}',
    document: { model: "fixture", mcp: { other: true, servers: { tool: remote } } },
  },
  {
    agent: "hermes",
    file: "config.yaml",
    content: 'model: fixture\nmcp_servers:\n  tool:\n    url: "https://fixture.invalid/mcp"\n',
    document: { model: "fixture", mcp_servers: { tool: remote } },
  },
];

describe("shared native MCP document parsing", () => {
  it.each(examples)(
    "locates $agent entries in $file without losing unrelated configuration",
    ({ agent, file, content, document }) => {
      const parsed = parseNativeMcpDocument(content, agent, file);
      expect(parsed.root).toEqual(document);
      expect(parsed.servers).toEqual({ tool: remote });
      // The parser exposes the source container; callers that rewrite the document
      // must isolate their edits when aliases can share this object.
      delete parsed.servers!.tool;
      expect(JSON.stringify(parsed.root)).not.toContain(remote.url);
      expect(parsed.root).toMatchObject({ model: "fixture" });
      if (agent === "open-claw") expect(parsed.root).toMatchObject({ mcp: { other: true } });
    },
  );

  it.each([
    ["opencode", "opencode.json", "{mcp: {}}"],
    ["claude-code", ".mcp.json", '{"mcpServers": {},}'],
    ["codex", "config.toml", '[mcp_servers.tool]\nurl = "broken'],
    ["hermes", "config.yaml", "mcp_servers: {}\nmcp_servers: {}\n"],
    ["open-claw", "openclaw.json", "{mcp: {servers:"],
  ] as const)("rejects malformed %s documents before migration", (agent, file, content) => {
    expect(() => parseNativeMcpDocument(content, agent, file)).toThrow();
  });

  it.each([
    {},
    { mcp: null },
    { mcp: [] },
    { mcp: { servers: "invalid" } },
    { mcp: { servers: [] } },
  ])("does not turn invalid nested containers into an editable server map", (document) => {
    expect(
      parseNativeMcpDocument(JSON.stringify(document), "open-claw", "openclaw.json").servers,
    ).toBeUndefined();
  });
});
