import { test, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createMcpProbe,
  getMcpServer,
  listMcpServers,
  McpConfig,
  maskSecrets,
  removeMcpServer,
  saveMcpConfig,
} from "../src/index.js";
test("validates, persists, lists and removes MCP servers with masked secrets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agentkib-mcp-"));
  const file = path.join(root, "mcp.json");
  const config = McpConfig.parse({
    servers: [
      {
        id: "local",
        name: "Local",
        transport: { transport: "stdio", command: "node", env: { TOKEN: "secret" } },
      },
    ],
  });
  await saveMcpConfig(file, config);
  expect((await listMcpServers(file))[0]?.transport).toMatchObject({
    env: { TOKEN: "[REDACTED]" },
  });
  await expect(getMcpServer(file, "missing")).rejects.toMatchObject({ code: "NOT_FOUND" });
  await removeMcpServer(file, "local");
  expect(await listMcpServers(file)).toEqual([]);
});
test("creates official SDK transport adapters without starting a hub", () => {
  const { client, transport } = createMcpProbe({
    id: "http",
    name: "HTTP",
    enabled: true,
    allow_tools: [],
    targets: [],
    lan_allow_tools: [],
    transport: { transport: "streamable-http", url: "https://example.com/mcp", headers: {} },
  });
  expect(client).toBeTruthy();
  expect(transport).toBeTruthy();
  expect(maskSecrets({ token: "abc", nested: { password: "x" } })).toEqual({
    token: "[REDACTED]",
    nested: { password: "[REDACTED]" },
  });
});
