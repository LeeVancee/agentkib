import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "@iarna/toml";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import JSON5 from "json5";
import type { AgentKind } from "../domain/types.js";

export interface NativeMcpCandidate {
  id: string;
  agent: AgentKind;
  scope: "project" | "home";
  name: string;
  source_path: string;
  transport: string;
  endpoint: string;
  has_secret_values: boolean;
  supported: boolean;
  warnings: string[];
}

export async function scanNativeCandidates(project?: string): Promise<NativeMcpCandidate[]> {
  const candidates: NativeMcpCandidate[] = [];
  if (project) {
    await scanFile(
      path.join(project, ".codex", "config.toml"),
      "codex",
      "project",
      ["mcp_servers"],
      candidates,
    );
    await scanFile(
      path.join(project, ".mcp.json"),
      "claude-code",
      "project",
      ["mcpServers"],
      candidates,
    );
    await scanFile(
      path.join(project, ".cursor", "mcp.json"),
      "cursor",
      "project",
      ["mcpServers"],
      candidates,
    );
  }
  const home = homedir();
  await scanFile(
    path.join(home, ".codex", "config.toml"),
    "codex",
    "home",
    ["mcp_servers"],
    candidates,
  );
  await scanFile(
    path.join(home, ".claude.json"),
    "claude-code",
    "home",
    ["mcpServers"],
    candidates,
  );
  await scanFile(
    path.join(home, ".cursor", "mcp.json"),
    "cursor",
    "home",
    ["mcpServers"],
    candidates,
  );
  await scanFile(
    path.join(home, ".openclaw", "openclaw.json"),
    "open-claw",
    "home",
    ["mcp", "servers"],
    candidates,
  );
  await scanFile(
    path.join(home, ".hermes", "config.yaml"),
    "hermes",
    "home",
    ["mcp_servers"],
    candidates,
  );
  return candidates
    .filter((candidate) => candidate.name !== "agentkib")
    .sort((a, b) => a.agent.localeCompare(b.agent) || a.name.localeCompare(b.name));
}

export async function removeNativeCandidates(
  source: string,
  selected: NativeMcpCandidate[],
): Promise<string> {
  const content = await readFile(source, "utf8");
  const agent = selected[0]?.agent;
  if (!agent || selected.some((candidate) => candidate.agent !== agent))
    throw new Error("Native MCP candidates must share a source agent");
  const parsed: any = source.endsWith(".toml")
    ? parseToml(content)
    : source.endsWith(".yaml")
      ? parseYaml(content)
      : JSON5.parse(content);
  const pointer =
    agent === "open-claw"
      ? ["mcp", "servers"]
      : agent === "hermes"
        ? ["mcp_servers"]
        : agent === "codex"
          ? ["mcp_servers"]
          : ["mcpServers"];
  let current: any = parsed;
  for (const key of pointer) current = current?.[key];
  if (!current || typeof current !== "object")
    throw new Error("Native MCP servers object is missing");
  for (const candidate of selected) delete current[candidate.name];
  if (source.endsWith(".toml")) return `${stringifyToml(parsed).trimEnd()}\n`;
  if (source.endsWith(".yaml")) return stringifyYaml(parsed);
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

async function scanFile(
  file: string,
  agent: AgentKind,
  scope: NativeMcpCandidate["scope"],
  pointer: string[],
  output: NativeMcpCandidate[],
): Promise<void> {
  const metadata = await lstat(file).catch(() => undefined);
  if (!metadata || metadata.isSymbolicLink() || !metadata.isFile()) return;
  const content = await readFile(file, "utf8").catch(() => undefined);
  if (content === undefined) return;
  let parsed: unknown;
  try {
    parsed = file.endsWith(".toml")
      ? parseToml(content)
      : file.endsWith(".yaml")
        ? parseYaml(content)
        : JSON5.parse(content);
  } catch {
    return;
  }
  let current: unknown = parsed;
  for (const key of pointer)
    current =
      current && typeof current === "object"
        ? (current as Record<string, unknown>)[key]
        : undefined;
  if (!current || typeof current !== "object" || Array.isArray(current)) return;
  for (const [name, raw] of Object.entries(current as Record<string, unknown>)) {
    const server =
      raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const endpoint =
      typeof server.url === "string"
        ? server.url
        : typeof server.command === "string"
          ? server.command
          : "unavailable";
    const transport =
      typeof server.url === "string" ? String(server.transport ?? server.type ?? "http") : "stdio";
    const hasSecrets = Object.keys({
      ...(server.env && typeof server.env === "object" ? server.env : {}),
      ...(server.headers && typeof server.headers === "object" ? server.headers : {}),
    }).some((key) => /token|secret|key|password/i.test(key));
    const supported =
      ["stdio", "http", "streamable-http", "sse"].includes(transport) && endpoint !== "unavailable";
    output.push({
      id: createHash("sha256")
        .update(`${path.resolve(file)}:${name}`)
        .digest("hex")
        .slice(0, 24),
      agent,
      scope,
      name,
      source_path: path.resolve(file),
      transport,
      endpoint,
      has_secret_values: hasSecrets,
      supported,
      warnings: hasSecrets
        ? ["Secret values must be re-entered into mcp.local.json"]
        : supported
          ? []
          : ["Unsupported native MCP fields or transport"],
    });
  }
}
