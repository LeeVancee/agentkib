import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { McpServer } from "./config.js";
export type McpProbeDescriptor = {
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;
};
export function createMcpProbe(server: McpServer): McpProbeDescriptor {
  const client = new Client({ name: "agentkib-backend", version: "0.5.0" });
  let transport: McpProbeDescriptor["transport"];
  if (server.transport.transport === "stdio")
    transport = new StdioClientTransport({
      command: server.transport.command,
      args: server.transport.args,
      env: server.transport.env,
      cwd: server.transport.cwd,
    });
  else if (server.transport.transport === "streamable-http") {
    const credentials = (server as McpServer & { oauth_credentials?: { access_token?: string } })
      .oauth_credentials;
    const headers = { ...server.transport.headers };
    if (credentials?.access_token && !headers.authorization)
      headers.authorization = `Bearer ${credentials.access_token}`;
    transport = new StreamableHTTPClientTransport(new URL(server.transport.url), {
      requestInit: { headers },
    });
  } else {
    const headers = { ...server.transport.headers };
    transport = new SSEClientTransport(new URL(server.transport.url), {
      requestInit: { headers },
    });
  }
  return { client, transport };
}
