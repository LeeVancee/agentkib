import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "@iarna/toml";
import { isSafeScanEntry } from "../platform/path.js";
import { loadManifest } from "./manifest.js";
import type {
  AgentKind,
  AssetKind,
  AssetRecord,
  AgentDetection,
  WorkspaceScan,
} from "../domain/types.js";

const MAX_NATIVE_CONFIG_BYTES = 1024 * 1024;
type Candidate = [AgentKind, string, AssetKind, string];
const candidates: Candidate[] = [
  ["codex", "AGENTS.md", "instruction", "Codex project instructions"],
  ["codex", ".agents/skills", "skill", "Shared Agent Skill"],
  ["codex", ".codex/config.toml", "configuration", "Codex project configuration"],
  ["codex", ".codex/settings.json", "configuration", "Codex settings"],
  ["codex", ".codex/skills", "skill", "Codex Skills"],
  ["codex", ".codex/agents", "agent", "Codex custom Agent"],
  ["codex", ".codex/hooks.json", "hook", "Codex Hooks"],
  ["claude-code", "CLAUDE.md", "instruction", "Claude Code project instructions"],
  ["claude-code", ".claude/CLAUDE.md", "instruction", "Claude Code project instructions"],
  ["claude-code", ".claude/rules", "instruction", "Claude Code directory rules"],
  ["claude-code", ".claude/skills", "skill", "Claude Code Skills"],
  ["claude-code", ".claude/agents", "agent", "Claude Code Subagents"],
  ["claude-code", ".claude/settings.json", "configuration", "Claude Code settings"],
  ["claude-code", ".mcp.json", "connection", "Claude Code MCP"],
  ["cursor", "AGENTS.md", "instruction", "Cursor project instructions"],
  ["cursor", ".cursor/rules", "instruction", "Cursor project rules"],
  ["cursor", ".cursor/commands", "instruction", "Cursor commands"],
  ["cursor", ".cursor/skills", "skill", "Cursor Skills"],
  ["cursor", ".agents/skills", "skill", "Shared Agent Skill"],
  ["cursor", ".cursor/hooks.json", "hook", "Cursor Hooks"],
  ["cursor", ".cursor/mcp.json", "connection", "Cursor MCP"],
  ["open-claw", "AGENTS.md", "instruction", "OpenClaw workspace instructions"],
  ["open-claw", "SOUL.md", "instruction", "OpenClaw persona"],
  ["open-claw", "IDENTITY.md", "instruction", "OpenClaw identity"],
  ["open-claw", "USER.md", "memory", "OpenClaw user profile"],
  ["open-claw", "MEMORY.md", "memory", "OpenClaw long-term memory"],
  ["open-claw", "TOOLS.md", "configuration", "OpenClaw tool notes"],
  ["open-claw", "skills", "skill", "OpenClaw Workspace Skills"],
  ["open-claw", ".agents/skills", "skill", "Shared Agent Skill"],
  ["hermes", ".hermes.md", "instruction", "Hermes project instructions"],
  ["hermes", "HERMES.md", "instruction", "Hermes project instructions"],
  ["hermes", "AGENTS.md", "instruction", "Hermes-compatible project instructions"],
  ["hermes", "CLAUDE.md", "instruction", "Hermes-compatible project instructions"],
  ["hermes", ".cursorrules", "instruction", "Hermes Cursor-compatible rules"],
  ["deepseek-harness", "AGENTS.md", "instruction", "DeepSeek Harness project instructions"],
  ["deepseek-harness", "CLAUDE.md", "instruction", "DeepSeek Harness project instructions"],
  [
    "deepseek-harness",
    "AGENTS.local.md",
    "instruction",
    "DeepSeek Harness local project instructions",
  ],
  [
    "deepseek-harness",
    "CLAUDE.local.md",
    "instruction",
    "DeepSeek Harness local project instructions",
  ],
  ["deepseek-harness", ".dsh/skills", "skill", "DeepSeek Harness Skills"],
  ["deepseek-harness", ".agents/skills", "skill", "Shared Agent Skill"],
];
const ignored = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
  ".cache",
  ".next",
  ".turbo",
  ".venv",
  "venv",
  "vendor",
  "coverage",
  "Pods",
  "DerivedData",
  "Library",
]);

export async function scanWorkspace(root: string): Promise<WorkspaceScan> {
  const assets: AssetRecord[] = [],
    warnings: string[] = [];
  let manifest_exists = false;
  try {
    await lstat(path.join(root, ".agentkib", "manifest.yaml"));
    manifest_exists = true;
    await loadManifest(root);
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT" && (error as { code?: string }).code !== "NOT_FOUND")
      warnings.push((error as Error).message);
  }
  const agents: AgentDetection[] = [];
  for (const agent of [
    "codex",
    "claude-code",
    "cursor",
    "open-claw",
    "hermes",
    "deepseek-harness",
  ] as AgentKind[]) {
    const before = assets.length;
    const warningBefore = warnings.length;
    for (const [, name, kind, summary] of candidates.filter(([owner]) => owner === agent)) {
      const target = path.join(root, name);
      let info;
      try {
        info = await lstat(target);
      } catch {
        continue;
      }
      if (info.isSymbolicLink()) {
        warnings.push(`Skipped symbolic link: ${target}`);
        continue;
      }
      if (info.isFile()) assets.push(await asset(agent, kind, target, summary, warnings));
      else if (info.isDirectory()) await walk(agent, target, kind, summary, assets, warnings, 0);
    }
    agents.push({
      agent,
      detected: assets.length > before,
      asset_count: assets.length - before,
      warnings: warnings.slice(warningBefore),
    });
  }
  assets.sort((a, b) => a.path.localeCompare(b.path) || a.agent.localeCompare(b.agent));
  return { root, manifest_exists, agents, assets, warnings };
}
async function walk(
  agent: AgentKind,
  directory: string,
  defaultKind: AssetKind,
  summary: string,
  output: AssetRecord[],
  warnings: string[],
  depth: number,
): Promise<void> {
  if (depth > 4 || !(await isSafeScanEntry(directory))) return;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    warnings.push(`Could not scan ${directory}`);
    return;
  }
  for (const entry of entries) {
    if (ignored.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (!(await isSafeScanEntry(full))) continue;
    if (entry.isDirectory())
      await walk(agent, full, defaultKind, summary, output, warnings, depth + 1);
    else if (entry.isFile())
      output.push(
        await asset(
          agent,
          defaultKind === "skill" ? kindOf(full) : defaultKind,
          full,
          summary,
          warnings,
        ),
      );
  }
}
function kindOf(file: string): AssetKind {
  const lower = file.toLowerCase();
  if (lower.endsWith("skill.md") || lower.includes(`${path.sep}skills${path.sep}`)) return "skill";
  if (lower.includes("memory")) return "memory";
  if (lower.includes("hook")) return "hook";
  if (lower.includes(`${path.sep}agent${path.sep}`)) return "agent";
  if (lower.endsWith(".md")) return "instruction";
  return "configuration";
}
async function asset(
  agent: AgentKind,
  kind: AssetKind,
  file: string,
  summary: string,
  warnings: string[] = [],
): Promise<AssetRecord> {
  const info = await lstat(file);
  const record: AssetRecord = { agent, kind, path: file, exists: true, size: info.size, summary };
  if (/[.]json$/i.test(file) || /[.]toml$/i.test(file)) {
    try {
      if (info.size > MAX_NATIVE_CONFIG_BYTES)
        throw new Error("exceeds the 1 MiB validation limit");
      const text = await readFile(file, "utf8");
      if (file.toLowerCase().endsWith(".json")) JSON.parse(text);
      else parseToml(text);
    } catch (error) {
      warnings.push(
        `Invalid configuration: ${file} (Configuration file is invalid: ${error instanceof Error ? error.message : "parse error"})`,
      );
    }
  }
  return record;
}
