// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { initializeI18n, tr } from "@/core/i18n";
import type { CatalogAsset } from "@/core/types";
import { AgentAssetsPanel } from "./AgentAssetsPanel";

const navigateGlobal = vi.hoisted(() => vi.fn());
vi.mock("@/features/app/AppNavigationContext", () => ({
  useOptionalAppNavigationContext: () => ({ app: { navigateGlobal } }),
}));
beforeEach(async () => {
  vi.clearAllMocks();
  await initializeI18n("en-US");
});
afterEach(cleanup);

it.each(["skill", "connection"] as const)(
  "describes the %s management shortcut as a section entry without promising asset focus",
  async (kind) => {
    const asset: CatalogAsset = {
      id: "home-asset",
      scope: "agent-home",
      kind,
      name: "Example asset",
      path: "/home/example",
      summary: "",
      size: 1,
    };
    render(
      <AgentAssetsPanel
        homeAssets={[asset]}
        assetKinds={[kind]}
        visibleAssets={[asset]}
        query=""
        kind="all"
        loading={false}
        error={false}
        onQueryChange={vi.fn()}
        onKindChange={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    const label = tr(kind === "skill" ? "agents.openSkillManagement" : "agents.openMcpManagement");
    const action = screen.getByRole("button", { name: label });
    expect(action).not.toHaveAttribute("aria-label");
    await userEvent.setup().click(action);
    expect(navigateGlobal).toHaveBeenCalledExactlyOnceWith("catalog", false, {
      assetSection: kind === "skill" ? "skills" : "mcp",
      ...(kind === "skill" ? { skillSection: "library" } : {}),
      catalogTarget: undefined,
    });
  },
);
