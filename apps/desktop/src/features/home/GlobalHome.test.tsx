// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "@/core/i18n";
import type { WorkspaceSummary } from "@/core/types";
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
});
