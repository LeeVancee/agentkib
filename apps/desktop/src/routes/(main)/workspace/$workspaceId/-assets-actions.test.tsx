// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { Suspense } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Manifest } from "@/core/types";
import { initializeI18n, tr } from "@/core/i18n";
import { api } from "@/core/api";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import { Route } from "./assets";

const search = vi.hoisted(() => ({ section: "skills" }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: unknown) => ({ options }),
  useNavigate: () => vi.fn(),
  useParams: () => ({ workspaceId: "workspace" }),
  useSearch: () => ({ workspaceAssetSection: search.section }),
}));
vi.mock("@/core/api", () => ({ api: { apply: vi.fn(), plan: vi.fn() } }));

const manifest: Manifest = {
  schema_version: 2,
  workspace: { id: "workspace", name: "Workspace" },
  instructions: { shared: "Keep these instructions", scoped: [], platform_overrides: {} },
  skills: [
    { name: "Selected skill", path: ".agents/skills/selected", targets: ["codex"] },
    { name: "Other skill", path: ".agents/skills/other", targets: [] },
  ],
  connections: [
    {
      name: "Selected connection",
      transport: "stdio",
      command: "node",
      args: [],
      env: {},
      allow_tools: [],
      targets: ["codex"],
    },
    {
      name: "Other connection",
      transport: "http",
      url: "https://example.test/mcp",
      env: {},
      allow_tools: [],
      targets: [],
    },
  ],
  adapters: {},
  mcp: { config: "mcp.json" },
  memories: { require_approval: true },
};
beforeEach(async () => {
  vi.clearAllMocks();
  await initializeI18n("en-US");
  useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true);
  useWorkspaceStore.setState({
    project: "/workspace",
    manifest,
    baselineManifest: JSON.stringify(manifest),
    scan: { root: "/workspace", manifest_exists: true, agents: [], assets: [], warnings: [] },
  });
});
afterEach(cleanup);

describe("asset draft removal", () => {
  it.each(["skills", "mcp"] as const)(
    "uses a named destructive action and only edits the %s draft",
    async (section) => {
      search.section = section;
      const Component = Route.options.component!;
      // Wait for route splitting before checking the rendered UI's readiness.
      await Component.preload?.();
      await act(async () => {
        render(
          <Suspense fallback={null}>
            <Component />
          </Suspense>,
        );
      });
      const name = section === "skills" ? "Selected skill" : "Selected connection";
      const remove = await screen.findByRole("button", {
        name: tr("assets.removeDraftItem", { name }),
      });
      expect(remove).toHaveClass("text-destructive");
      expect(remove).not.toHaveClass("bg-primary");
      fireEvent.click(remove);
      const current = useWorkspaceStore.getState();
      expect(current.baselineManifest).toBe(JSON.stringify(manifest));
      expect(current.manifest?.instructions).toEqual(manifest.instructions);
      expect(current.manifest?.skills).toEqual(
        section === "skills" ? [manifest.skills[1]] : manifest.skills,
      );
      expect(current.manifest?.connections).toEqual(
        section === "mcp" ? [manifest.connections[1]] : manifest.connections,
      );
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(api.plan).not.toHaveBeenCalled();
      expect(api.apply).not.toHaveBeenCalled();
      expect(
        screen.queryByRole("button", { name: tr("assets.removeDraftItem", { name }) }),
      ).toBeNull();
    },
  );
});
