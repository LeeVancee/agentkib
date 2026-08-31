import { lstat, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { AgentKind, ConnectionDefinition, Manifest } from "../domain/types.js";
import { validateManifest } from "../workspace/manifest.js";
import {
  hashContent,
  planChangeSet,
  type ChangeRisk,
  type ChangeSet,
  type FileChange,
} from "../changes/changeset.js";

const START = "<!-- agentkib:managed:start -->";
const END = "<!-- agentkib:managed:end -->";
const TOML_START = "# agentkib:managed:start";
const TOML_END = "# agentkib:managed:end";

export async function planWorkspaceChanges(
  projectInput: string,
  manifest: Manifest,
  includeHome: boolean,
): Promise<ChangeSet> {
  validateManifest(manifest);
  const project = path.resolve(projectInput);
  const changes: FileChange[] = [];
  const persistedManifest: Manifest = {
    ...manifest,
    schema_version: 2,
    connections: [],
  };
  await push(
    changes,
    path.join(project, ".agentkib", "manifest.yaml"),
    stringifyYaml(persistedManifest),
    "project",
    "low",
    "yaml",
  );
  const legacy = manifest.connections.filter((connection) => connection.name !== "agentkib");
  const gateway = manifest.connections.filter((connection) => connection.name === "agentkib");
  const enabled = (agent: AgentKind) => manifest.adapters?.[agent]?.enabled !== false;
  const common = ["codex", "cursor", "open-claw", "hermes"].some((agent) =>
    enabled(agent as AgentKind),
  );

  if (legacy.length) {
    const target = path.join(project, ".agentkib", manifest.mcp.config);
    const existing = parseJson(await readText(target));
    const servers = Array.isArray(existing.servers) ? existing.servers : [];
    for (const connection of legacy) {
      const server = connectionServer(connection);
      const index = servers.findIndex(
        (item) => item && typeof item === "object" && item.id === server.id,
      );
      if (index >= 0) servers[index] = { ...servers[index], ...server };
      else servers.push(server);
    }
    servers.sort((left, right) =>
      String(left?.name ?? "").localeCompare(String(right?.name ?? "")),
    );
    await push(
      changes,
      target,
      JSON.stringify({ ...existing, schema_version: 1, servers }, null, 2) + "\n",
      "project",
      "medium",
      "json",
    );
  }

  if (common)
    await push(
      changes,
      path.join(project, "AGENTS.md"),
      managed(await readText(path.join(project, "AGENTS.md")), manifest.instructions.shared),
      "project",
      "medium",
      "markdown",
    );
  if (enabled("claude-code")) {
    const override = manifest.instructions.platform_overrides["claude-code"]?.trim();
    const content = override
      ? `@AGENTS.md\n\n${override}`
      : "@AGENTS.md\n\nClaude Code uses AGENTS.md as the shared project instructions.";
    await push(
      changes,
      path.join(project, "CLAUDE.md"),
      managed(await readText(path.join(project, "CLAUDE.md")), content),
      "project",
      "medium",
      "markdown",
    );
    await mergeJson(changes, path.join(project, ".mcp.json"), gateway, "claude-code");
  }
  if (enabled("codex")) {
    const override = manifest.instructions.platform_overrides.codex?.trim();
    const target = path.join(project, "AGENTS.override.md");
    if (override || (await readText(target)).includes(START))
      await push(
        changes,
        target,
        managed(
          await readText(target),
          override
            ? `${manifest.instructions.shared.trim()}\n\n${override}`
            : manifest.instructions.shared,
        ),
        "project",
        "medium",
        "markdown",
      );
    await mergeToml(changes, path.join(project, ".codex", "config.toml"), gateway, "codex");
  }
  if (enabled("cursor"))
    await mergeJson(changes, path.join(project, ".cursor", "mcp.json"), gateway, "cursor");
  if (enabled("open-claw")) {
    const target = path.join(project, "TOOLS.md");
    const override = manifest.instructions.platform_overrides["open-claw"]?.trim();
    if (override || (await readText(target)).includes(START))
      await push(
        changes,
        target,
        managed(await readText(target), override || manifest.instructions.shared),
        "project",
        "medium",
        "markdown",
      );
  }
  if (enabled("hermes")) {
    const target = path.join(project, ".hermes.md");
    const override = manifest.instructions.platform_overrides.hermes?.trim();
    if (override || (await readText(target)).includes(START))
      await push(
        changes,
        target,
        managed(
          await readText(target),
          override
            ? `${manifest.instructions.shared.trim()}\n\n${override}`
            : manifest.instructions.shared,
        ),
        "project",
        "medium",
        "markdown",
      );
  }

  for (const scoped of manifest.instructions.scoped) {
    const directory = path.join(project, scoped.path);
    if (common)
      await push(
        changes,
        path.join(directory, "AGENTS.md"),
        managed(await readText(path.join(directory, "AGENTS.md")), scoped.content),
        "project",
        "medium",
        "markdown",
      );
    if (enabled("claude-code"))
      await push(
        changes,
        path.join(directory, "CLAUDE.md"),
        managed(await readText(path.join(directory, "CLAUDE.md")), "@AGENTS.md"),
        "project",
        "medium",
        "markdown",
      );
  }

  for (const skill of manifest.skills) {
    const files = await collectSkillFiles(project, skill.path);
    const shared = ["codex", "open-claw", "hermes"].some(
      (agent) =>
        enabled(agent as AgentKind) &&
        (!skill.targets?.length || skill.targets.includes(agent as AgentKind)),
    );
    const cursor =
      enabled("cursor") && (!skill.targets?.length || skill.targets.includes("cursor")) && !shared;
    const claude =
      enabled("claude-code") && (!skill.targets?.length || skill.targets.includes("claude-code"));
    for (const file of files) {
      if (shared)
        await push(
          changes,
          path.join(project, ".agents", "skills", skill.name, file.relative),
          file.content,
          "project",
          "low",
          validator(file.relative),
        );
      if (cursor)
        await push(
          changes,
          path.join(project, ".cursor", "skills", skill.name, file.relative),
          file.content,
          "project",
          "low",
          validator(file.relative),
        );
      if (claude)
        await push(
          changes,
          path.join(project, ".claude", "skills", skill.name, file.relative),
          file.content,
          "project",
          "low",
          validator(file.relative),
        );
    }
  }

  if (includeHome) {
    const openClawHome = path.join(homedir(), ".openclaw", "openclaw.json");
    const hermesHome = path.join(homedir(), ".hermes", "config.yaml");
    if (enabled("open-claw") && (await isFile(openClawHome)))
      await mergeOpenClawHome(changes, path.join(homedir(), ".openclaw", "openclaw.json"), gateway);
    if (enabled("hermes") && (await isFile(hermesHome)))
      await mergeYamlHome(changes, hermesHome, project, gateway);
  }
  return planChangeSet(
    project,
    changes.filter((change) => change.before !== change.after),
  );
}

async function mergeJson(
  changes: FileChange[],
  target: string,
  connections: ConnectionDefinition[],
  agent: AgentKind,
  scope: FileChange["scope"] = "project",
): Promise<void> {
  const existing = parseJson(await readText(target));
  const servers =
    existing.mcpServers && typeof existing.mcpServers === "object"
      ? { ...existing.mcpServers }
      : {};
  for (const connection of connections.filter((item) => targeted(item, agent)))
    servers[connection.name] = {
      ...((servers[connection.name] as object) ?? {}),
      ...connectionJson(connection, agent),
    };
  await push(
    changes,
    target,
    JSON.stringify({ ...existing, mcpServers: servers }, null, 2) + "\n",
    scope,
    scope === "agent-home" ? "high" : "medium",
    "json",
  );
}

async function mergeOpenClawHome(
  changes: FileChange[],
  target: string,
  connections: ConnectionDefinition[],
): Promise<void> {
  const existing = parseJson(await readText(target));
  const mcp = existing.mcp && typeof existing.mcp === "object" ? { ...existing.mcp } : {};
  const servers = mcp.servers && typeof mcp.servers === "object" ? { ...mcp.servers } : {};
  for (const connection of connections.filter((item) => targeted(item, "open-claw")))
    servers[connection.name] = {
      ...((servers[connection.name] as object) ?? {}),
      ...connectionJson(connection, "open-claw"),
    };
  await push(
    changes,
    target,
    JSON.stringify({ ...existing, mcp: { ...mcp, servers } }, null, 2) + "\n",
    "agent-home",
    "high",
    "json",
  );
}

async function mergeYamlHome(
  changes: FileChange[],
  target: string,
  project: string,
  connections: ConnectionDefinition[],
): Promise<void> {
  const existing = parseYamlSafe(await readText(target));
  const servers =
    existing.mcp_servers && typeof existing.mcp_servers === "object"
      ? { ...existing.mcp_servers }
      : {};
  for (const connection of connections.filter((item) => targeted(item, "hermes")))
    servers[connection.name] = connectionJson(connection, "hermes");
  const skills = Array.isArray(existing.external_skill_dirs)
    ? [...existing.external_skill_dirs]
    : [];
  const skillPath = path.join(project, ".agents", "skills");
  if (!skills.includes(skillPath)) skills.push(skillPath);
  await push(
    changes,
    target,
    stringifyYaml({ ...existing, mcp_servers: servers, external_skill_dirs: skills }),
    "agent-home",
    "high",
    "yaml",
  );
}

async function mergeToml(
  changes: FileChange[],
  target: string,
  connections: ConnectionDefinition[],
  agent: AgentKind,
  scope: FileChange["scope"] = "project",
): Promise<void> {
  const existing = await readText(target);
  const selected = connections.filter((item) => targeted(item, agent));
  if (!selected.length && !existing.includes(TOML_START)) return;
  const lines = [TOML_START];
  for (const connection of selected) {
    lines.push(`[mcp_servers.${safeKey(connection.name)}]`);
    if (connection.transport === "stdio") {
      lines.push(
        `command = ${tomlString(connection.command ?? "")}`,
        `args = ${JSON.stringify(connection.args ?? [])}`,
      );
    } else lines.push(`url = ${tomlString(connection.url ?? "")}`);
    if ((connection.allow_tools ?? []).length)
      lines.push(`enabled_tools = ${JSON.stringify(connection.allow_tools ?? [])}`);
    lines.push("");
  }
  lines.push(TOML_END);
  await push(
    changes,
    target,
    replaceManaged(existing, TOML_START, TOML_END, lines.join("\n")),
    scope,
    scope === "agent-home" ? "high" : "medium",
    "toml",
  );
}

function connectionServer(connection: ConnectionDefinition): Record<string, unknown> {
  return {
    id: safeKey(connection.name),
    name: connection.name,
    enabled: true,
    transport:
      connection.transport === "stdio"
        ? { transport: "stdio", command: connection.command, args: connection.args ?? [] }
        : { transport: "streamable-http", url: connection.url },
    targets: connection.targets ?? [],
    allow_tools: connection.allow_tools ?? [],
  };
}
function connectionJson(
  connection: ConnectionDefinition,
  agent: AgentKind,
): Record<string, unknown> {
  const value: Record<string, unknown> =
    connection.transport === "stdio"
      ? { command: connection.command, args: connection.args ?? [] }
      : { url: (connection.url ?? "").replace("{agent}", agent) };
  if (connection.transport === "http" && agent === "claude-code") value.type = "http";
  if (connection.transport === "http" && agent === "open-claw") value.transport = "streamable-http";
  if (Object.keys(connection.env ?? {}).length) value.env = connection.env;
  if ((connection.allow_tools ?? []).length)
    value.tools = { include: connection.allow_tools ?? [] };
  return value;
}
function targeted(connection: ConnectionDefinition, agent: AgentKind): boolean {
  return !connection.targets?.length || connection.targets.includes(agent);
}
function safeKey(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}
function tomlString(value: string): string {
  return JSON.stringify(value);
}
function managed(existing: string, content: string): string {
  return replaceManaged(existing, START, END, `${START}\n${content.trim()}\n${END}`);
}
function replaceManaged(existing: string, start: string, end: string, block: string): string {
  const a = existing.indexOf(start),
    b = existing.indexOf(end);
  if (a >= 0 && b >= a) return `${existing.slice(0, a)}${block}${existing.slice(b + end.length)}`;
  return existing.trim() ? `${existing.trimEnd()}\n\n${block}\n` : `${block}\n`;
}
function parseJson(value: string): Record<string, any> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function parseYamlSafe(value: string): Record<string, any> {
  try {
    const parsed = parseYaml(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
async function readText(target: string): Promise<string> {
  return readFile(target, "utf8").catch(() => "");
}
async function isFile(target: string): Promise<boolean> {
  return (await lstat(target).catch(() => undefined))?.isFile() ?? false;
}
async function collectSkillFiles(
  project: string,
  relative: string,
): Promise<Array<{ relative: string; content: string }>> {
  const source = path.resolve(project, relative);
  const metadata = await lstat(source).catch(() => undefined);
  if (!metadata) return [];
  if (metadata.isFile())
    return [{ relative: path.basename(source), content: await readFile(source, "utf8") }];
  if (!metadata.isDirectory()) return [];
  const output: Array<{ relative: string; content: string }> = [];
  const visit = async (directory: string, prefix: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      const next = path.join(prefix, entry.name);
      if (entry.isDirectory()) await visit(full, next);
      else if (entry.isFile())
        output.push({ relative: next, content: await readFile(full, "utf8") });
    }
  };
  await visit(source, "");
  return output;
}
function validator(file: string): FileChange["validator"] {
  const extension = path.extname(file).toLowerCase();
  return extension === ".json"
    ? "json"
    : extension === ".toml"
      ? "toml"
      : [".yaml", ".yml"].includes(extension)
        ? "yaml"
        : extension === ".md"
          ? "markdown"
          : "text";
}
async function push(
  changes: FileChange[],
  target: string,
  after: string,
  scope: FileChange["scope"],
  risk: ChangeRisk,
  validator: FileChange["validator"],
): Promise<void> {
  const before = await readText(target);
  changes.push({
    target,
    scope,
    before,
    after,
    ...(before ? { original_hash: hashContent(before) } : {}),
    risk,
    validator,
  });
}
