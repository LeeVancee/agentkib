// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initializeI18n, tr } from "@/core/i18n";
import type { ConversationSessionSummary, RuntimeInfo, WorkspaceSummary } from "@/core/types";
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

const onboarding = {
  version: 1,
  acknowledged_version: 0,
  doctor_completed: false,
  repairable_count: 0,
  repair_applied: false,
};

function homeProps() {
  return {
    workspaces: [] as WorkspaceSummary[],
    doctorSummaries: {},
    installations: [],
    memories: [],
    activity: [],
    uniqueAssetCount: 0,
    assetCounts: new Map<string, number>(),
    onShowActivity: vi.fn(),
    onShowWorkspaces: vi.fn(),
    onShowAgents: vi.fn(),
    onOpen: vi.fn().mockResolvedValue(undefined),
    onOpenDoctor: vi.fn().mockResolvedValue(undefined),
    onOpenAssets: vi.fn(),
    onAddWorkspace: vi.fn().mockResolvedValue(undefined),
    onAddRoot: vi.fn().mockResolvedValue(undefined),
    onRefresh: vi.fn(),
    onRuntimeChanged: vi.fn(),
  };
}

describe("GlobalHome", () => {
  beforeAll(() => initializeI18n("en-US"));
  afterEach(cleanup);

  it("keeps the onboarding steps visible after discovering a workspace and advances to Doctor", () => {
    const props = homeProps();
    const runtime = { onboarding } as RuntimeInfo;
    const view = render(<GlobalHome {...props} runtime={runtime} />);
    expect(screen.getByRole("heading", { name: tr("onboarding.title") })).toBeVisible();
    expect(screen.getAllByRole("button", { name: tr("onboarding.addWorkspace") })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: tr("home.addScanRoot") })).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: tr("home.emptyTitle") })).toBeNull();

    view.rerender(<GlobalHome {...props} runtime={runtime} workspaces={[workspace]} />);
    expect(screen.getByRole("heading", { name: tr("onboarding.title") })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: tr("onboarding.runDoctor") }));
    expect(props.onOpenDoctor).toHaveBeenCalledWith(workspace);

    view.rerender(
      <GlobalHome
        {...props}
        workspaces={[workspace]}
        runtime={
          {
            onboarding: { ...onboarding, doctor_completed: true, repairable_count: 2 },
          } as RuntimeInfo
        }
      />,
    );
    expect(screen.getByRole("button", { name: tr("onboarding.reviewRepair") })).toBeVisible();
  });

  it("uses the acknowledged version to choose onboarding or the empty workspace actions", () => {
    const props = homeProps();
    const view = render(
      <GlobalHome
        {...props}
        runtime={{ onboarding: { ...onboarding, acknowledged_version: 1 } } as RuntimeInfo}
      />,
    );
    expect(screen.queryByRole("heading", { name: tr("onboarding.title") })).toBeNull();
    expect(screen.getByRole("heading", { name: tr("home.emptyTitle") })).toBeVisible();
    expect(screen.getAllByRole("button", { name: tr("home.addWorkspace") })).toHaveLength(1);

    view.rerender(
      <GlobalHome
        {...props}
        workspaces={[workspace]}
        runtime={
          { onboarding: { ...onboarding, version: 2, acknowledged_version: 1 } } as RuntimeInfo
        }
      />,
    );
    expect(screen.getByRole("heading", { name: tr("onboarding.title") })).toBeVisible();
  });

  it.each([false, true])(
    "separates the workspace and scan-folder callbacks (existing workspace: %s)",
    async (existing) => {
      const props = homeProps();
      render(<GlobalHome {...props} workspaces={existing ? [workspace] : []} />);
      fireEvent.click(screen.getByRole("button", { name: tr("home.addWorkspace") }));
      expect(props.onAddWorkspace).toHaveBeenCalledTimes(1);
      expect(props.onAddRoot).not.toHaveBeenCalled();
      await act(async () => {});
      fireEvent.click(screen.getByRole("button", { name: tr("home.addScanRoot") }));
      expect(props.onAddRoot).toHaveBeenCalledTimes(1);
      expect(props.onAddWorkspace).toHaveBeenCalledTimes(1);
      await act(async () => {});
      expect(screen.getByText(tr("home.addWorkspaceHint"))).toBeVisible();
      expect(screen.getByText(tr("home.addScanRootHint"))).toBeVisible();
    },
  );

  it("locks all add actions until the request settles and exposes a recoverable error", async () => {
    const props = homeProps();
    let reject!: (reason: Error) => void;
    props.onAddWorkspace.mockReturnValueOnce(
      new Promise<void>((_resolve, no) => {
        reject = no;
      }),
    );
    render(<GlobalHome {...props} runtime={{ onboarding } as RuntimeInfo} />);
    const add = screen.getByRole("button", { name: tr("onboarding.addWorkspace") });
    fireEvent.click(add);
    fireEvent.click(add);
    fireEvent.click(screen.getByRole("button", { name: tr("home.addScanRoot") }));
    expect(add).toBeDisabled();
    expect(screen.getByRole("button", { name: tr("home.addScanRoot") })).toBeDisabled();
    expect(props.onAddWorkspace).toHaveBeenCalledTimes(1);
    expect(props.onAddRoot).not.toHaveBeenCalled();
    await act(async () => reject(new Error("folder unavailable")));
    expect(await screen.findByRole("alert")).toHaveTextContent("folder unavailable");
    expect(add).toBeEnabled();
    fireEvent.click(add);
    await act(async () => {});
    expect(props.onAddWorkspace).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

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
        onShowActivity={vi.fn()}
        onShowWorkspaces={vi.fn()}
        onShowAgents={vi.fn()}
        onOpen={vi.fn().mockResolvedValue(undefined)}
        onOpenDoctor={onOpenDoctor}
        onOpenAssets={vi.fn()}
        onAddWorkspace={vi.fn().mockResolvedValue(undefined)}
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
        onShowActivity={vi.fn()}
        onShowWorkspaces={vi.fn()}
        onShowAgents={vi.fn()}
        recentContinuations={[continuation]}
        continuationState="ready"
        onContinue={onContinue}
        onOpen={vi.fn().mockResolvedValue(undefined)}
        onOpenDoctor={vi.fn().mockResolvedValue(undefined)}
        onOpenAssets={vi.fn()}
        onAddWorkspace={vi.fn().mockResolvedValue(undefined)}
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
        onShowActivity={vi.fn()}
        onShowWorkspaces={vi.fn()}
        onShowAgents={vi.fn()}
        recentContinuations={[{ workspace, session: cachedSession }]}
        continuationState="disabled"
        onEnableContinuations={onEnableContinuations}
        onOpen={vi.fn().mockResolvedValue(undefined)}
        onOpenDoctor={vi.fn().mockResolvedValue(undefined)}
        onOpenAssets={vi.fn()}
        onAddWorkspace={vi.fn().mockResolvedValue(undefined)}
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
        onShowActivity={vi.fn()}
        onShowWorkspaces={vi.fn()}
        onShowAgents={vi.fn()}
        recentContinuations={[{ workspace, session: cachedSession }]}
        continuationState="loading"
        onOpen={vi.fn().mockResolvedValue(undefined)}
        onOpenDoctor={vi.fn().mockResolvedValue(undefined)}
        onOpenAssets={vi.fn()}
        onAddWorkspace={vi.fn().mockResolvedValue(undefined)}
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
      onShowActivity: vi.fn(),
      onShowWorkspaces: vi.fn(),
      onShowAgents: vi.fn(),
      onOpen: vi.fn().mockResolvedValue(undefined),
      onOpenDoctor: vi.fn().mockResolvedValue(undefined),
      onOpenAssets: vi.fn(),
      onAddWorkspace: vi.fn().mockResolvedValue(undefined),
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
