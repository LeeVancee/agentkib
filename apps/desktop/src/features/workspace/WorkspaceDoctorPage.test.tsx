// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { initializeI18n } from "@/core/i18n";
import type { ContextDoctorReport, WorkspaceSummary } from "@/core/types";
import { WorkspaceDoctorPage } from "./WorkspaceDoctorPage";

vi.mock("@/core/api", () => ({ api: { workspaceDoctorReport: vi.fn() } }));

const workspace = { id: "workspace-1", name: "Workspace" } as WorkspaceSummary;
const report: ContextDoctorReport = {
  summary: {
    workspace_id: workspace.id,
    error_count: 0,
    warning_count: 0,
    info_count: 0,
    repairable_count: 0,
    checked_at: "2026-08-27T00:00:00Z",
  },
  matrix: [],
  issues: [],
};

describe("WorkspaceDoctorPage", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => vi.mocked(api.workspaceDoctorReport).mockReset());
  afterEach(cleanup);

  it("records a successful diagnosis", async () => {
    vi.mocked(api.workspaceDoctorReport).mockResolvedValue(report);
    const onDiagnosed = vi.fn().mockResolvedValue(undefined);

    render(
      <WorkspaceDoctorPage workspace={workspace} onRepair={vi.fn()} onDiagnosed={onDiagnosed} />,
    );

    await waitFor(() => expect(onDiagnosed).toHaveBeenCalledWith(report.summary));
    expect(await screen.findByText("No deterministic configuration issues found")).toBeTruthy();
  });

  it("renders OpenCode in the diagnostics matrix", async () => {
    vi.mocked(api.workspaceDoctorReport).mockResolvedValue({
      ...report,
      matrix: [
        {
          agent: "opencode",
          detected: true,
          installed: true,
          enabled: true,
          writable: true,
          instructions: { status: "healthy", expected: 1, actual: 1 },
          skills: { status: "healthy", expected: 1, actual: 1 },
          mcp: { status: "healthy", expected: 1, actual: 1 },
        },
      ],
    });

    render(<WorkspaceDoctorPage workspace={workspace} onRepair={vi.fn()} onDiagnosed={vi.fn()} />);

    expect(await screen.findByText("OpenCode")).toBeTruthy();
  });

  it("shows the one-time repair verification result", async () => {
    vi.mocked(api.workspaceDoctorReport).mockResolvedValue({
      ...report,
      summary: { ...report.summary, error_count: 2, repairable_count: 2 },
    });

    render(
      <WorkspaceDoctorPage
        workspace={workspace}
        onRepair={vi.fn()}
        onDiagnosed={vi.fn()}
        verification="applied"
      />,
    );

    expect(
      await screen.findByText(
        "Repairs were applied and rechecked. Issues remaining: 2 · repairable: 2.",
      ),
    ).toBeTruthy();
  });

  it("does not describe manual issues as healthy", async () => {
    vi.mocked(api.workspaceDoctorReport).mockResolvedValue({
      ...report,
      summary: { ...report.summary, warning_count: 1 },
      issues: [
        {
          id: "manual-issue",
          code: "agent.read-only",
          severity: "warning",
          repairable: false,
          evidence: [],
        },
      ],
    });

    render(
      <WorkspaceDoctorPage
        workspace={workspace}
        onRepair={vi.fn()}
        onDiagnosed={vi.fn()}
        verification="applied"
      />,
    );

    expect(await screen.findByText("Issues requiring manual action: 1.")).toBeTruthy();
    expect(
      screen.getByText("Repairs were applied and rechecked. Issues remaining: 1 · repairable: 0."),
    ).toBeTruthy();
  });

  it("separates repairable and manual issues in the conclusion", async () => {
    vi.mocked(api.workspaceDoctorReport).mockResolvedValue({
      ...report,
      summary: { ...report.summary, error_count: 1, warning_count: 1, repairable_count: 1 },
      issues: [
        {
          id: "repairable-issue",
          code: "managed.missing",
          severity: "error",
          repairable: true,
          evidence: [],
        },
        {
          id: "manual-issue",
          code: "agent.read-only",
          severity: "warning",
          repairable: false,
          evidence: [],
        },
      ],
    });

    render(<WorkspaceDoctorPage workspace={workspace} onRepair={vi.fn()} onDiagnosed={vi.fn()} />);

    expect(await screen.findByText("Repairable: 1 · manual action: 1.")).toBeTruthy();
  });
});
