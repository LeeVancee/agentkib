// @vitest-environment jsdom

import { cleanup, render, screen } from "@octanejs/testing-library";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "@/core/i18n";
import { AgentsPage } from "./AgentsPage";

describe("AgentsPage", () => {
  beforeAll(() => initializeI18n("en-US"));
  afterEach(cleanup);

  it("renders OpenCode without unsupported usage UI", () => {
    render(
      <AgentsPage
        installations={[
          {
            agent: "opencode",
            installed: true,
            configured: true,
            warnings: [],
          },
        ]}
        assets={[]}
        workspaces={[]}
        remoteGateways={[]}
        onOpen={vi.fn().mockResolvedValue(undefined)}
        filter="all"
        selectedAgent="opencode"
        onSelectedAgentChange={vi.fn()}
      />,
    );

    expect(screen.getAllByText("OpenCode").length).toBeGreaterThan(0);
    expect(screen.queryByRole("tab", { name: "Usage" })).toBeNull();
  });
});
