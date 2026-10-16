// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "@/core/i18n";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import type { DoctorIssueDestination } from "@/features/workspace/doctor-manual-actions";
import { Route } from "./doctor";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: unknown) => ({ options }),
  useNavigate: () => navigate,
  useParams: () => ({ workspaceId: "workspace" }),
  useSearch: () => ({}),
}));
vi.mock("@/features/workspace/WorkspaceDoctorPage", () => ({
  WorkspaceDoctorPage: ({ onOpenIssue }: { onOpenIssue: (to: DoctorIssueDestination) => void }) => (
    <>
      {(["context", "skills", "mcp"] as const).map((to) => (
        <button key={to} onClick={() => onOpenIssue(to)}>
          {to}
        </button>
      ))}
    </>
  ),
}));

async function renderDoctor() {
  const Component = Route.options.component!;
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <Component />
      </Suspense>,
    );
  });
}

describe("doctor issue navigation", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => {
    navigate.mockReset();
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true);
    useWorkspaceStore.setState({
      selectedWorkspace: {
        id: "workspace",
        name: "Workspace",
        path: "/workspace",
        status: "healthy",
        asset_count: 0,
        warning_count: 0,
        sources: [],
      },
    });
  });
  afterEach(cleanup);

  it("opens context issues in the current workspace", async () => {
    await renderDoctor();
    fireEvent.click(await screen.findByRole("button", { name: "context" }));
    expect(navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/workspace/$workspaceId/context",
      params: { workspaceId: "workspace" },
    });
  });

  it.each(["skills", "mcp"] as const)("opens the matching %s asset section", async (section) => {
    await renderDoctor();
    fireEvent.click(await screen.findByRole("button", { name: section }));
    expect(navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/workspace/$workspaceId/assets",
      params: { workspaceId: "workspace" },
      search: { workspaceAssetSection: section },
    });
  });
});
