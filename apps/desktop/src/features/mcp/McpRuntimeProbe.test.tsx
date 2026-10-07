// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { initializeI18n, tr } from "@/core/i18n";
import type { McpToolDescriptor } from "@/core/types";
import { McpRuntimeProbe } from "./McpRuntimeProbe";

vi.mock("@/core/api", () => ({ api: { probeMcpRuntime: vi.fn() } }));
const tools: McpToolDescriptor[] = ["get_scene_info", "execute_blender_code"].map((name) => ({
  server_id: "blender",
  name,
  input_schema: {},
  read_only: false,
}));

describe("McpRuntimeProbe", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    await initializeI18n("en-US");
  });
  afterEach(cleanup);
  it("shows discovered tool count and names for the selected scope", async () => {
    vi.mocked(api.probeMcpRuntime).mockResolvedValue(tools);
    const reload = vi.fn().mockResolvedValue(undefined);
    render(<McpRuntimeProbe serverId="blender" project="/workspace/one" onProbed={reload} />);
    fireEvent.click(screen.getByRole("button", { name: tr("mcp.probe") }));
    expect(await screen.findByText("Upstream probe passed · 2 tools")).toBeVisible();
    expect(screen.getByText("get_scene_info")).toBeVisible();
    expect(api.probeMcpRuntime).toHaveBeenCalledWith("blender", "/workspace/one");
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
  });
  it("drops old scope results and does not reload the previous scope after a key change", async () => {
    let resolve!: (value: McpToolDescriptor[]) => void;
    vi.mocked(api.probeMcpRuntime).mockReturnValue(
      new Promise((yes) => {
        resolve = yes;
      }),
    );
    const reload = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <McpRuntimeProbe
        key="one:blender"
        serverId="blender"
        project="/workspace/one"
        onProbed={reload}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: tr("mcp.probe") }));
    rerender(
      <McpRuntimeProbe
        key="two:blender"
        serverId="blender"
        project="/workspace/two"
        onProbed={reload}
      />,
    );
    await act(async () => resolve(tools));
    expect(screen.queryByText("get_scene_info")).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });
  it("renders zero tools and reports probe failures", async () => {
    vi.mocked(api.probeMcpRuntime)
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce("Process failed");
    render(<McpRuntimeProbe serverId="blender" onProbed={vi.fn().mockResolvedValue(undefined)} />);
    fireEvent.click(screen.getByRole("button", { name: tr("mcp.probe") }));
    expect(await screen.findByText("Upstream probe passed · 0 tools")).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: tr("mcp.probe") })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: tr("mcp.probe") }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Process failed");
    expect(screen.queryByText("Upstream probe passed · 0 tools")).toBeNull();
  });
});
