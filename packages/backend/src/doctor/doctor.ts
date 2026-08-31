import { stat } from "node:fs/promises";
import { loadManifest, manifestPath } from "../workspace/manifest.js";
export interface DoctorIssue {
  id: string;
  code: string;
  severity: "error" | "warning" | "info";
  repairable: boolean;
  evidence: Array<{ detail: string; path?: string }>;
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
  issues: DoctorIssue[];
}
export async function diagnoseWorkspace(
  project: string,
  workspaceId: string,
): Promise<DoctorReport> {
  const issues: DoctorIssue[] = [];
  try {
    await stat(manifestPath(project));
    await loadManifest(project);
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
  return {
    summary: {
      workspace_id: workspaceId,
      error_count: issues.filter((issue) => issue.severity === "error").length,
      warning_count: 0,
      info_count: 0,
      repairable_count: 0,
      checked_at: new Date().toISOString(),
    },
    issues,
  };
}
