import { loadManifest, manifestPath } from "../workspace/manifest.js";
import { scanWorkspace } from "../workspace/scanner.js";
import type { AgentKind, Manifest } from "../domain/types.js";
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
export async function diagnoseWorkspace(
  project: string,
  workspaceId: string,
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
    const status = (expected: number, actual: number): DoctorAssetStatus => ({
      status: !detected?.detected && !manifest ? "not-applicable" : actual < expected ? "attention" : "healthy",
      expected,
      actual,
    });
    return {
      agent,
      detected: Boolean(detected?.detected),
      installed: Boolean(detected?.detected),
      enabled: writable.has(agent) && (manifest?.adapters[agent]?.enabled ?? true),
      writable: writable.has(agent),
      instructions: status(expectedInstructions, instructionActual),
      skills: status(expectedSkills, skillActual),
      mcp: status(expectedMcp, mcpActual),
    };
  });
  return {
    summary: {
      workspace_id: workspaceId,
      error_count: issues.filter((issue) => issue.severity === "error").length,
      warning_count: 0,
      info_count: 0,
      repairable_count: 0,
      checked_at: new Date().toISOString(),
    },
    matrix,
    issues,
  };
}
