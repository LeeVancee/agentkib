// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "@/core/i18n";
import type { ContextDoctorSummary } from "@/core/types";
import { WorkspaceContextHealthCard } from "./WorkspaceContextHealthCard";

const healthy: ContextDoctorSummary = {
  workspace_id: "workspace-1",
  error_count: 0,
  warning_count: 0,
  info_count: 0,
  repairable_count: 0,
  checked_at: "2026-08-27T00:00:00Z",
};

function renderCard(summary?: ContextDoctorSummary, pendingReview = false) {
  const onOpenDoctor = vi.fn();
  const onOpenChanges = vi.fn();
  render(
    <WorkspaceContextHealthCard
      summary={summary}
      pendingReview={pendingReview}
      onOpenDoctor={onOpenDoctor}
      onOpenChanges={onOpenChanges}
    />,
  );
  return { onOpenDoctor, onOpenChanges };
}

describe("WorkspaceContextHealthCard", () => {
  beforeAll(() => initializeI18n("en-US"));
  afterEach(cleanup);

  it("offers a diagnosis when no summary is available", () => {
    const { onOpenDoctor } = renderCard();

    fireEvent.click(screen.getByRole("button", { name: /Run diagnosis/i }));

    expect(onOpenDoctor).toHaveBeenCalledOnce();
  });

  it("shows healthy and manual-only results", () => {
    const { rerender } = render(
      <WorkspaceContextHealthCard
        summary={healthy}
        pendingReview={false}
        onOpenDoctor={vi.fn()}
        onOpenChanges={vi.fn()}
      />,
    );
    expect(screen.getByText("Context configuration is healthy")).toBeTruthy();

    rerender(
      <WorkspaceContextHealthCard
        summary={{ ...healthy, warning_count: 2 }}
        pendingReview={false}
        onOpenDoctor={vi.fn()}
        onOpenChanges={vi.fn()}
      />,
    );
    expect(screen.getByText("Issues requiring manual action: 2")).toBeTruthy();
  });

  it("opens Doctor for a repairable diagnosis", () => {
    const { onOpenDoctor } = renderCard({
      ...healthy,
      error_count: 3,
      repairable_count: 2,
    });

    expect(screen.getByText("Issues found: 3 · repairable: 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Review repair plan/i }));
    expect(onOpenDoctor).toHaveBeenCalledOnce();
  });

  it("prioritizes pending review over the diagnosis summary", () => {
    const { onOpenChanges } = renderCard({ ...healthy, error_count: 3, repairable_count: 2 }, true);

    expect(screen.getByText("Repair plan awaiting review")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Review pending changes/i }));
    expect(onOpenChanges).toHaveBeenCalledOnce();
  });
});
