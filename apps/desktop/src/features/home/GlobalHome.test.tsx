// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "@/core/i18n";
import type { ConversationSessionSummary, WorkspaceSummary } from "@/core/types";
import { GlobalHome } from "./GlobalHome";

const workspace = {
  id: "workspace-1",
  name: "Workspace",
  path: "/tmp/workspace",
  status: "healthy",
  sources: [],
  asset_count: 0,
  warning_count: 0,
} as WorkspaceSummary;

describe("GlobalHome", () => {
  beforeAll(() => initializeI18n("en-US"));
  afterEach(cleanup);

  it("keeps Doctor accessible after onboarding is no longer visible", () => {
    const onOpenDoctor = vi.fn().mockResolvedValue(undefined);
    render(
      <GlobalHome
        workspaces={[workspace]}
        doctorSummaries={{}}
        installations={[]}
        memories={[]}
        activity={[]}
        uniqueAssetCount={0}
        assetCounts={new Map()}
        onShowInsights={vi.fn()}
        onShowWorkspaces={vi.fn()}
        onShowAgents={vi.fn()}
        onOpen={vi.fn().mockResolvedValue(undefined)}
        onOpenDoctor={onOpenDoctor}
        onOpenAssets={vi.fn()}
        onAddRoot={vi.fn().mockResolvedValue(undefined)}
        onRefresh={vi.fn()}
        onRuntimeChanged={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /View context health/i }));

    expect(onOpenDoctor).toHaveBeenCalledWith(workspace);
  });

  it("shows a concrete recent session and opens that session", () => {
    const onContinue = vi.fn().mockResolvedValue(undefined);
    const session = {
      id: "session-1",
      workspace_id: workspace.id,
      agent: "codex",
      title: "Continue the migration",
      updated_at: "2026-09-03T00:00:00.000Z",
      archived: false,
      sidechain: false,
      availability: "readable",
    } as ConversationSessionSummary;
    const continuation = { workspace, session };
    render(
      <GlobalHome
        workspaces={[workspace]}
        doctorSummaries={{}}
        installations={[]}
        memories={[]}
        activity={[]}
        uniqueAssetCount={0}
        assetCounts={new Map()}
        onShowInsights={vi.fn()}
        onShowWorkspaces={vi.fn()}
        onShowAgents={vi.fn()}
        recentContinuations={[continuation]}
        continuationState="ready"
        onContinue={onContinue}
        onOpen={vi.fn().mockResolvedValue(undefined)}
        onOpenDoctor={vi.fn().mockResolvedValue(undefined)}
        onOpenAssets={vi.fn()}
        onAddRoot={vi.fn().mockResolvedValue(undefined)}
        onRefresh={vi.fn()}
        onRuntimeChanged={vi.fn()}
      />,
    );

    expect(screen.getByText("Continue the migration")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Continue the migration/i }));
    expect(onContinue).toHaveBeenCalledWith(continuation);
  });

  it("offers to enable session reading when indexing is disabled", () => {
    const onEnableContinuations = vi.fn().mockResolvedValue(undefined);
    const cachedSession = {
      id: "cached-session",
      workspace_id: workspace.id,
      agent: "codex",
      title: "Cached private session",
      archived: false,
      sidechain: false,
      availability: "readable",
    } as ConversationSessionSummary;
    render(
      <GlobalHome
        workspaces={[workspace]}
        doctorSummaries={{}}
        installations={[]}
        memories={[]}
        activity={[]}
        uniqueAssetCount={0}
        assetCounts={new Map()}
        onShowInsights={vi.fn()}
        onShowWorkspaces={vi.fn()}
        onShowAgents={vi.fn()}
        recentContinuations={[{ workspace, session: cachedSession }]}
        continuationState="disabled"
        onEnableContinuations={onEnableContinuations}
        onOpen={vi.fn().mockResolvedValue(undefined)}
        onOpenDoctor={vi.fn().mockResolvedValue(undefined)}
        onOpenAssets={vi.fn()}
        onAddRoot={vi.fn().mockResolvedValue(undefined)}
        onRefresh={vi.fn()}
        onRuntimeChanged={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Enable session reading" }));
    expect(onEnableContinuations).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Cached private session")).toBeNull();
  });

  it("does not reveal cached sessions while session indexing is loading", () => {
    const cachedSession = {
      id: "cached-session",
      workspace_id: workspace.id,
      agent: "codex",
      title: "Cached private session",
      archived: false,
      sidechain: false,
      availability: "readable",
    } as ConversationSessionSummary;
    render(
      <GlobalHome
        workspaces={[workspace]}
        doctorSummaries={{}}
        installations={[]}
        memories={[]}
        activity={[]}
        uniqueAssetCount={0}
        assetCounts={new Map()}
        onShowInsights={vi.fn()}
        onShowWorkspaces={vi.fn()}
        onShowAgents={vi.fn()}
        recentContinuations={[{ workspace, session: cachedSession }]}
        continuationState="loading"
        onOpen={vi.fn().mockResolvedValue(undefined)}
        onOpenDoctor={vi.fn().mockResolvedValue(undefined)}
        onOpenAssets={vi.fn()}
        onAddRoot={vi.fn().mockResolvedValue(undefined)}
        onRefresh={vi.fn()}
        onRuntimeChanged={vi.fn()}
      />,
    );

    expect(screen.queryByText("Cached private session")).toBeNull();
  });

  it("explains loading, metadata-only, empty, and error continuation states", () => {
    const props = {
      workspaces: [workspace],
      doctorSummaries: {},
      installations: [],
      memories: [],
      activity: [],
      uniqueAssetCount: 0,
      assetCounts: new Map<string, number>(),
      onShowInsights: vi.fn(),
      onShowWorkspaces: vi.fn(),
      onShowAgents: vi.fn(),
      onOpen: vi.fn().mockResolvedValue(undefined),
      onOpenDoctor: vi.fn().mockResolvedValue(undefined),
      onOpenAssets: vi.fn(),
      onAddRoot: vi.fn().mockResolvedValue(undefined),
      onRefresh: vi.fn(),
      onRuntimeChanged: vi.fn(),
    };
    const onOpenContinuationWorkspace = vi.fn().mockResolvedValue(undefined);
    const onRetryContinuations = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <GlobalHome
        {...props}
        continuationState="loading"
        continuationSlow
        onOpenContinuationWorkspace={onOpenContinuationWorkspace}
      />,
    );
    expect(
      screen.getByText("There are many local records. AgentKib is still working."),
    ).toBeTruthy();

    view.rerender(
      <GlobalHome
        {...props}
        continuationState="metadata-only"
        onOpenContinuationWorkspace={onOpenContinuationWorkspace}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "View workspace sessions" }));
    expect(onOpenContinuationWorkspace).toHaveBeenCalledTimes(1);

    view.rerender(
      <GlobalHome
        {...props}
        continuationState="empty"
        onOpenContinuationWorkspace={onOpenContinuationWorkspace}
      />,
    );
    expect(screen.getByText("No readable sessions were found in recent workspaces.")).toBeTruthy();

    view.rerender(
      <GlobalHome
        {...props}
        continuationState="error"
        continuationError="Source unavailable"
        onRetryContinuations={onRetryContinuations}
      />,
    );
    expect(screen.getByText("Source unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetryContinuations).toHaveBeenCalledTimes(1);
  });
});
