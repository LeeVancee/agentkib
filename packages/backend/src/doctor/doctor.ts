import { loadManifest, manifestPath } from "../workspace/manifest.js";
import { scanWorkspace } from "../workspace/scanner.js";
import type { AgentKind, Manifest } from "../domain/types.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
export interface DoctorIssue {
  id: string;
  code: string;
  severity: "error" | "warning" | "info";
  repairable: boolean;
  evidence: Array<{ detail: string; path?: string }>;
}
export interface DoctorAssetStatus {
  status: "healthy" | "attention" | "unavailable" | "not-applicable";
  expected: number;
  actual: number;
}
export interface DoctorAgentRow {
  agent: AgentKind;
  detected: boolean;
  installed: boolean;
  enabled: boolean;
  writable: boolean;
  instructions: DoctorAssetStatus;
  skills: DoctorAssetStatus;
  mcp: DoctorAssetStatus;
}
export interface DoctorReport {
  summary: {
    workspace_id: string;
    error_count: number;
    warning_count: number;
    info_count: number;
    repairable_count: number;
    checked_at: string;
  };
  matrix: DoctorAgentRow[];
  issues: DoctorIssue[];
}
export interface DoctorOptions {
  installedAgents?: ReadonlySet<AgentKind>;
}
export async function diagnoseWorkspace(
  project: string,
  workspaceId: string,
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const issues: DoctorIssue[] = [];
  const scan = await scanWorkspace(project);
  let manifest: Manifest | undefined;
  try {
    // Rust only diagnoses a manifest when an entry exists. A normal workspace
    // without AgentKib configuration is therefore valid and has no issue.
    if (scan.manifest_exists) manifest = await loadManifest(project);
  } catch (error) {
    issues.push({
      id: "manifest.invalid",
      code: "manifest.invalid",
      severity: "error",
      repairable: false,
      evidence: [
        {
          path: manifestPath(project),
          detail: error instanceof Error ? error.message : "Manifest unavailable",
        },
      ],
    });
  }
  for (const warning of scan.warnings) {
    if (warning.includes("manifest.yaml")) continue;
    issues.push({
      id: `native.invalid.${issues.length}`,
      code: "native.invalid",
      severity: "error",
      repairable: false,
      evidence: [{ path: project, detail: warning }],
    });
  }
  const allAgents: AgentKind[] = [
    "codex",
    "claude-code",
    "cursor",
    "open-claw",
    "hermes",
    "deepseek-harness",
  ];
  const writable = new Set<AgentKind>([
    "codex",
    "claude-code",
    "cursor",
    "open-claw",
    "hermes",
  ]);
  const installedAgents = options.installedAgents ?? new Set<AgentKind>();
  const matrix = allAgents.map((agent) => {
    const detected = scan.agents.find((item) => item.agent === agent);
    const assets = scan.assets.filter((item) => item.agent === agent);
    const instructionActual = assets.filter((item) => item.kind === "instruction").length;
    const skillActual = assets.filter((item) => item.kind === "skill").length;
    const mcpActual = assets.filter((item) => item.kind === "connection").length;
    const expectedInstructions = manifest
      ? (manifest.instructions.shared.trim() ? 1 : 0) +
        (manifest.instructions.platform_overrides[agent]?.trim() ? 1 : 0) +
        manifest.instructions.scoped.length
      : instructionActual;
    const expectedSkills = manifest
      ? manifest.skills.filter((skill) => !skill.targets.length || skill.targets.includes(agent)).length
      : skillActual;
    const expectedMcp = manifest
      ? manifest.connections.filter((connection) => !connection.targets.length || connection.targets.includes(agent)).length
      : mcpActual;
    const applicable = Boolean(detected?.detected) || installedAgents.has(agent);
    const status = (expected: number, actual: number): DoctorAssetStatus => ({
      status: !applicable && !manifest ? "not-applicable" : actual < expected ? "attention" : "healthy",
      expected,
      actual,
    });
    return {
      agent,
      detected: Boolean(detected?.detected),
      installed: installedAgents.has(agent),
      enabled: writable.has(agent) && (manifest?.adapters[agent]?.enabled ?? true),
      writable: writable.has(agent),
      instructions: status(expectedInstructions, instructionActual),
      skills: status(expectedSkills, skillActual),
      mcp: status(expectedMcp, mcpActual),
    };
  });
  if (manifest) {
    const shared = manifest.instructions.shared.trim();
    for (const agent of allAgents) {
      const row = matrix.find((item) => item.agent === agent)!;
      if (!row.enabled || !row.writable || (!row.detected && !row.installed)) continue;
      const expected = expectedInstructionTargets(project, agent, manifest);
      if (!expected.length) continue;
      const missing: string[] = [];
      for (const target of expected) {
        const content = await readFile(target, "utf8").catch(() => undefined);
        if (!content || !instructionContentPresent(content, shared, target, agent)) missing.push(target);
      }
      if (missing.length) {
        issues.push({
          id: `instruction.expected-content-missing.${agent}`,
          code: "instruction.expected-content-missing",
          severity: "warning",
          repairable: true,
          evidence: missing.map((target) => ({
            path: target,
            detail: "Configured instructions are not present in the native Agent file",
          })),
        });
      }
      for (const skill of manifest.skills.filter((value) => !value.targets.length || value.targets.includes(agent))) {
        const source = path.resolve(project, skill.path);
        const target = path.join(
          project,
          agent === "cursor" ? ".cursor/skills" : agent === "claude-code" ? ".claude/skills" : ".agents/skills",
          skill.name,
        );
        const sourceExists = await readFile(path.join(source, "SKILL.md"), "utf8").then(() => true).catch(() => false);
        const targetExists = await readFile(path.join(target, "SKILL.md"), "utf8").then(() => true).catch(() => false);
        if (sourceExists && !targetExists) {
          issues.push({
            id: `skill.target-missing.${agent}.${skill.name}`,
            code: "skill.target-missing",
            severity: "warning",
            repairable: true,
            evidence: [{ path: target, detail: `Skill ${skill.name} is not visible to the target Agent` }],
          });
        }
      }
    }
  }
  const repairBlocked = issues.some((issue) => issue.severity === "error");
  if (repairBlocked) for (const issue of issues) issue.repairable = false;
  return {
    summary: {
      workspace_id: workspaceId,
      error_count: issues.filter((issue) => issue.severity === "error").length,
      warning_count: 0,
      info_count: 0,
      repairable_count: issues.filter((issue) => issue.repairable).length,
      checked_at: new Date().toISOString(),
    },
    matrix,
    issues,
  };
}

function expectedInstructionTargets(project: string, agent: AgentKind, manifest: Manifest): string[] {
  const targets: string[] = [];
  if (manifest.instructions.shared.trim()) {
    targets.push(
      agent === "claude-code"
        ? path.join(project, "CLAUDE.md")
        : agent === "hermes"
          ? path.join(project, "AGENTS.md")
          : path.join(project, "AGENTS.md"),
    );
  }
  const override = manifest.instructions.platform_overrides[agent]?.trim();
  if (override) {
    targets.push(
      agent === "claude-code"
        ? path.join(project, "CLAUDE.md")
        : agent === "cursor"
          ? path.join(project, ".cursor", "rules", "agentkib.mdc")
          : agent === "open-claw"
            ? path.join(project, "TOOLS.md")
            : agent === "hermes"
              ? path.join(project, ".hermes.md")
              : path.join(project, "AGENTS.override.md"),
    );
  }
  for (const scoped of manifest.instructions.scoped) {
    targets.push(path.join(project, scoped.path, agent === "claude-code" ? "CLAUDE.md" : "AGENTS.md"));
  }
  return [...new Set(targets)];
}

function instructionContentPresent(content: string, shared: string, target: string, agent: AgentKind): boolean {
  if (target.endsWith("agentkib.mdc")) return content.includes("agentkib:managed:start");
  if (agent === "claude-code" && content.split(/\r?\n/).some((line) => line.trim() === "@AGENTS.md")) return true;
  return !shared || content.includes(shared);
}
