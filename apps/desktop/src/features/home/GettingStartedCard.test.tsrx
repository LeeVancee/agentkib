/** @jsxImportSource octane */

// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@octanejs/testing-library";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { changeLocale, initializeI18n, localizeMessage } from "@/core/i18n";
import type { OnboardingState, RuntimeInfo, WorkspaceSummary } from "@/core/types";
import { GettingStartedCard } from "./GettingStartedCard.tsrx";

vi.mock("@/core/api", () => ({ api: { updateOnboarding: vi.fn() } }));

const baseOnboarding: OnboardingState = {
  version: 1,
  acknowledged_version: 0,
  doctor_completed: false,
  repairable_count: 0,
  repair_applied: false,
};
const workspace = { id: "workspace-1", name: "Workspace" } as WorkspaceSummary;

function renderCard(onboarding = baseOnboarding, workspaces: WorkspaceSummary[] = []) {
  return render(
    <GettingStartedCard
      onboarding={onboarding}
      workspaces={workspaces}
      doctorSummaries={{}}
      onRuntimeChanged={vi.fn()}
      onAddRoot={vi.fn().mockResolvedValue(undefined)}
      onOpenDoctor={vi.fn().mockResolvedValue(undefined)}
    />,
  );
}

describe("GettingStartedCard", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => {
    vi.mocked(api.updateOnboarding).mockReset();
  });
  afterEach(cleanup);

  it("translates an existing operation error when the locale changes", async () => {
    const failure = { key: "errors.providerUnavailable", detail: "offline" };
    vi.mocked(api.updateOnboarding).mockRejectedValue(failure);
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: "Dismiss getting started guide" }));
    const englishError = localizeMessage(failure);
    const message = await screen.findByText(englishError);

    try {
      await act(() => changeLocale("zh-CN"));
      expect(screen.getByText(localizeMessage(failure))).toBe(message);
      expect(screen.queryByText(englishError)).toBeNull();
      expect(api.updateOnboarding).toHaveBeenCalledTimes(1);
    } finally {
      await act(() => changeLocale("en-US"));
    }
  });

  it("starts with workspace discovery and advances to Doctor", () => {
    const { rerender } = renderCard();
    expect(screen.getByRole("button", { name: "Add scan folder" })).toBeTruthy();

    rerender(
      <GettingStartedCard
        onboarding={baseOnboarding}
        workspaces={[workspace]}
        doctorSummaries={{}}
        onRuntimeChanged={vi.fn()}
        onAddRoot={vi.fn()}
        onOpenDoctor={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Run Context Doctor" })).toBeTruthy();
  });

  it("returns to a workspace while repairable issues remain", async () => {
    const onOpenDoctor = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <GettingStartedCard
        onboarding={{
          ...baseOnboarding,
          workspace_id: workspace.id,
          doctor_completed: true,
          repairable_count: 2,
        }}
        workspaces={[workspace]}
        doctorSummaries={{}}
        onRuntimeChanged={vi.fn()}
        onAddRoot={vi.fn()}
        onOpenDoctor={onOpenDoctor}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Review repair plan" }));
    expect(onOpenDoctor).toHaveBeenCalledWith(workspace);
  });

  it("persists dismissal and hides acknowledged guides", async () => {
    const runtime = { onboarding: { ...baseOnboarding, acknowledged_version: 1 } } as RuntimeInfo;
    vi.mocked(api.updateOnboarding).mockResolvedValue(runtime);
    const onRuntimeChanged = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <GettingStartedCard
        onboarding={baseOnboarding}
        workspaces={[]}
        doctorSummaries={{}}
        onRuntimeChanged={onRuntimeChanged}
        onAddRoot={vi.fn()}
        onOpenDoctor={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Dismiss getting started guide" }));
    expect(api.updateOnboarding).toHaveBeenCalledWith({ event: "dismissed" });
    expect(onRuntimeChanged).toHaveBeenCalledWith(runtime);

    rerender(
      <GettingStartedCard
        onboarding={runtime.onboarding}
        workspaces={[]}
        doctorSummaries={{}}
        onRuntimeChanged={onRuntimeChanged}
        onAddRoot={vi.fn()}
        onOpenDoctor={vi.fn()}
      />,
    );
    expect(screen.queryByText("Get started with AgentKib")).toBeNull();
  });
});
