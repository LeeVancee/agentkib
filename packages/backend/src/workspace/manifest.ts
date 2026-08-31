import { readFile, lstat } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { BackendError, backendError } from "../contracts.js";
import type { AgentKind, Manifest } from "../domain/types.js";

const MAX = 1024 * 1024;
export function manifestPath(project: string): string {
  return path.join(project, ".agentkib", "manifest.yaml");
}
export async function loadManifest(project: string): Promise<Manifest> {
  const file = manifestPath(project);
  let metadata;
  try {
    metadata = await lstat(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw backendError("NOT_FOUND", "Manifest does not exist");
    throw backendError(code === "EACCES" ? "PERMISSION" : "IO", "Could not inspect manifest");
  }
  if (!metadata.isFile()) throw backendError("VALIDATION", "manifest.yaml must be a regular file");
  if (metadata.size > MAX)
    throw backendError("VALIDATION", "manifest.yaml exceeds the 1 MiB read limit");
  try {
    const parsed = normalizeManifest(parseYaml(await readFile(file, "utf8")));
    validateManifest(parsed);
    return parsed;
  } catch (error) {
    if (error instanceof BackendError) throw error;
    throw backendError("VALIDATION", "manifest.yaml is invalid");
  }
}
function normalizeManifest(value: unknown): Manifest {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const workspace =
    source.workspace && typeof source.workspace === "object"
      ? (source.workspace as Record<string, unknown>)
      : {};
  const instructions =
    source.instructions && typeof source.instructions === "object"
      ? (source.instructions as Record<string, unknown>)
      : {};
  const memories =
    source.memories && typeof source.memories === "object"
      ? (source.memories as Record<string, unknown>)
      : {};
  return {
    schema_version: Number(source.schema_version),
    workspace: { id: String(workspace.id ?? ""), name: String(workspace.name ?? "") },
    instructions: {
      shared: String(instructions.shared ?? ""),
      scoped: Array.isArray(instructions.scoped)
        ? (instructions.scoped as Manifest["instructions"]["scoped"])
        : [],
      platform_overrides: (instructions.platform_overrides &&
      typeof instructions.platform_overrides === "object"
        ? instructions.platform_overrides
        : {}) as Manifest["instructions"]["platform_overrides"],
    },
    skills: Array.isArray(source.skills) ? (source.skills as Manifest["skills"]) : [],
    mcp: {
      config:
        source.mcp &&
        typeof source.mcp === "object" &&
        typeof (source.mcp as Record<string, unknown>).config === "string"
          ? String((source.mcp as Record<string, unknown>).config)
          : "mcp.json",
    },
    connections: Array.isArray(source.connections)
      ? (source.connections as Manifest["connections"])
      : [],
    memories: {
      require_approval:
        typeof memories.require_approval === "boolean" ? memories.require_approval : true,
    },
    adapters:
      source.adapters && typeof source.adapters === "object"
        ? (source.adapters as Manifest["adapters"])
        : {},
  };
}
export function validateManifest(value: Manifest): void {
  if (!value || ![1, 2].includes(value.schema_version))
    throw backendError("VALIDATION", "Only schema_version 1 or 2 is supported");
  if (!value.workspace?.id?.trim() || !value.workspace?.name?.trim())
    throw backendError("VALIDATION", "workspace.id and workspace.name cannot be empty");
  const names = new Set<string>();
  for (const skill of value.skills ?? []) {
    rejectDeepSeek(skill.targets);
    relative(skill.path, "Skill path");
    segment(skill.name, "Skill name");
    if (names.has(skill.name))
      throw backendError("VALIDATION", `Duplicate Skill name: ${skill.name}`);
    names.add(skill.name);
  }
  for (const scoped of value.instructions?.scoped ?? [])
    relative(scoped.path, "Scoped instruction path");
  if (value.schema_version >= 2) relative(value.mcp?.config, "MCP config");
  if (
    value.instructions?.platform_overrides?.["deepseek-harness"] ||
    value.adapters?.["deepseek-harness"]
  )
    throw backendError("VALIDATION", "DeepSeek Harness Beta is read-only");
  const connections = new Set<string>();
  for (const connection of value.connections ?? []) {
    rejectDeepSeek(connection.targets);
    if (!connection.name?.trim() || connections.has(connection.name))
      throw backendError("VALIDATION", "Duplicate or empty MCP connection name");
    connections.add(connection.name);
    for (const env of Object.values(connection.env ?? {}))
      if (!/^\$\{[^}]+}$/.test(env))
        throw backendError("VALIDATION", "Environment variable must use a ${VAR} reference");
    if (connection.transport === "stdio" && !connection.command?.trim())
      throw backendError("VALIDATION", "stdio command cannot be empty");
    if (connection.transport === "http" && !/^https?:\/\//.test(connection.url ?? ""))
      throw backendError("VALIDATION", "HTTP MCP URL is invalid");
  }
}
function rejectDeepSeek(targets: AgentKind[] = []): void {
  if (targets.includes("deepseek-harness"))
    throw backendError("VALIDATION", "DeepSeek Harness Beta is read-only");
}
function relative(value: string, label: string): void {
  const parts = value?.trim().split(/[\\/]/) ?? [];
  if (
    !value?.trim() ||
    path.isAbsolute(value) ||
    parts.some((part) => part === ".." || part === "." || part === "") ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw backendError(
      "VALIDATION",
      `${label} must be a relative path inside the project: ${value}`,
    );
  }
}
function segment(value: string, label: string): void {
  if (!value?.trim() || /[\\/]/.test(value) || value === "." || value === "..")
    throw backendError("VALIDATION", `${label} must be a single path-safe name: ${value}`);
}
