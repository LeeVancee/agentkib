// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpBatchConnectionPlan } from "@agentkib/runtime-protocol";
import { api } from "@/core/api";
import type { WorkspaceSummary } from "@/core/types";
import { McpBatchConnectionPanel } from "./McpBatchConnectionPanel";

vi.mock("@/core/useI18n", () => ({
  useI18n: () => ({
    tr: (key: string) => key,
    localizeMessage: (reason: unknown) =>
      reason instanceof Error ? reason.message : String(reason),
  }),
}));
vi.mock("@/core/api", () => ({
  api: {
    planMcpConnections: vi.fn(),
    applyMcpConnections: vi.fn(),
    verifyMcpConnection: vi.fn(),
  },
}));

const workspace: WorkspaceSummary = {
  id: "one",
  name: "One",
  path: "/workspace/one",
  status: "healthy",
  asset_count: 0,
  warning_count: 0,
  sources: [],
};
const otherWorkspace = { ...workspace, id: "two", name: "Two", path: "/workspace/two" };
const props = { project: workspace.path, workspaces: [workspace, otherWorkspace] };
const correctPlan: McpBatchConnectionPlan = {
  workspace_id: workspace.id,
  token: "preview",
  targets: [
    {
      agent: "codex",
      status: "correct",
      selected: false,
      target: "/workspace/one/.codex/config.toml",
      scope: "project",
    },
  ],
  changes: [],
  requires_home_approval: false,
};
function toolList(...tools: string[]): Awaited<ReturnType<typeof api.verifyMcpConnection>> {
  return {
    url: "http://127.0.0.1/mcp",
    checked_at: "2026-10-09T00:00:00Z",
    builtin_tools: 1,
    builtin_tool_names: ["workspace_read"],
    external_tools: tools,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function check() {
  fireEvent.click(screen.getByRole("button", { name: "mcp.manage.checkPreview" }));
  await screen.findByRole("button", { name: "mcp.manage.applyConnection" });
}
function verifyButton() {
  return screen.getByRole("button", { name: "mcp.manage.verifyHub" });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.planMcpConnections).mockResolvedValue(correctPlan);
  vi.mocked(api.verifyMcpConnection).mockResolvedValue(toolList("external_read"));
});
afterEach(cleanup);

describe("MCP batch connection verification", () => {
  it("verifies an already correct connection without applying configuration", async () => {
    render(<McpBatchConnectionPanel {...props} servicesRevision="r1" />);
    await check();
    expect(screen.getByRole("button", { name: "mcp.manage.applyConnection" })).toBeDisabled();
    expect(api.verifyMcpConnection).not.toHaveBeenCalled();
    fireEvent.click(verifyButton());
    expect(await screen.findByText("workspace_read, external_read")).toBeVisible();
    expect(api.verifyMcpConnection).toHaveBeenCalledExactlyOnceWith("one", "codex");
    expect(api.applyMcpConnections).not.toHaveBeenCalled();
  });

  it("offers read-only verification only for correct targets in a mixed plan", async () => {
    vi.mocked(api.planMcpConnections).mockResolvedValue({
      ...correctPlan,
      targets: [
        ...correctPlan.targets,
        {
          agent: "claude-code",
          status: "missing",
          selected: true,
          target: "/workspace/one/.mcp.json",
          scope: "project",
        },
      ],
      changes: [{ target: "/workspace/one/.mcp.json", scope: "project", after: "{}" }],
    });
    render(<McpBatchConnectionPanel {...props} servicesRevision="r1" />);
    await check();
    expect(screen.getByRole("button", { name: "mcp.manage.applyConnection" })).toBeEnabled();
    expect(screen.getAllByRole("button", { name: "mcp.manage.verifyHub" })).toHaveLength(1);
    const missing = screen.getByText("mcp.manage.connection_missing", { exact: false });
    expect(within(missing).queryByRole("button", { name: "mcp.manage.verifyHub" })).toBeNull();
    fireEvent.click(verifyButton());
    await screen.findByText("workspace_read, external_read");
    expect(api.verifyMcpConnection).toHaveBeenCalledExactlyOnceWith("one", "codex");
    expect(api.applyMcpConnections).not.toHaveBeenCalled();
  });

  it("shows verification errors and permits a read-only retry", async () => {
    vi.mocked(api.verifyMcpConnection).mockRejectedValueOnce(new Error("Hub unavailable"));
    render(<McpBatchConnectionPanel {...props} servicesRevision="r1" />);
    await check();
    fireEvent.click(verifyButton());
    expect(await screen.findByText("Hub unavailable")).toBeVisible();
    fireEvent.click(verifyButton());
    expect(await screen.findByText("workspace_read, external_read")).toBeVisible();
    expect(screen.queryByText("Hub unavailable")).not.toBeInTheDocument();
    expect(api.applyMcpConnections).not.toHaveBeenCalled();
  });

  it("prevents duplicate verification and workspace changes while a request is pending", async () => {
    const response = deferred<ReturnType<typeof toolList>>();
    vi.mocked(api.verifyMcpConnection).mockReturnValue(response.promise);
    render(<McpBatchConnectionPanel {...props} servicesRevision="r1" />);
    await check();
    const button = verifyButton();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "mcp.manage.workspace" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "mcp.manage.checkPreview" })).toBeDisabled();
    expect(api.verifyMcpConnection).toHaveBeenCalledTimes(1);
    await act(async () => response.resolve(toolList("current_tool")));
    expect(button).toBeEnabled();
  });

  it.each(["success", "error"])(
    "discards late verification %s after a revision change",
    async (outcome) => {
      const response = deferred<ReturnType<typeof toolList>>();
      vi.mocked(api.verifyMcpConnection).mockReturnValueOnce(response.promise);
      const view = render(<McpBatchConnectionPanel {...props} servicesRevision="r1" />);
      await check();
      fireEvent.click(verifyButton());
      view.rerender(<McpBatchConnectionPanel {...props} servicesRevision="r2" />);
      await act(async () => {
        if (outcome === "success") response.resolve(toolList("stale_tool"));
        else response.reject(new Error("stale_error"));
      });
      expect(screen.queryByText(/stale_/)).not.toBeInTheDocument();
      fireEvent.click(verifyButton());
      expect(await screen.findByText("workspace_read, external_read")).toBeVisible();
    },
  );

  it("clears completed verification when selecting another workspace", async () => {
    const user = userEvent.setup();
    render(<McpBatchConnectionPanel {...props} servicesRevision="r1" />);
    await check();
    fireEvent.click(verifyButton());
    await screen.findByText("workspace_read, external_read");
    await user.click(screen.getByRole("combobox", { name: "mcp.manage.workspace" }));
    await user.click(screen.getByRole("option", { name: "Two" }));
    expect(screen.queryByText("workspace_read, external_read")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "mcp.manage.verifyHub" })).not.toBeInTheDocument();
    vi.mocked(api.planMcpConnections).mockResolvedValue({ ...correctPlan, workspace_id: "two" });
    await check();
    fireEvent.click(verifyButton());
    await screen.findByText("workspace_read, external_read");
    expect(api.verifyMcpConnection).toHaveBeenLastCalledWith("two", "codex");
  });

  it("discards an old scope request after the catalog remounts the panel", async () => {
    const response = deferred<ReturnType<typeof toolList>>();
    vi.mocked(api.verifyMcpConnection).mockReturnValueOnce(response.promise);
    const view = render(<McpBatchConnectionPanel key="one" {...props} servicesRevision="r1" />);
    await check();
    fireEvent.click(verifyButton());
    view.rerender(
      <McpBatchConnectionPanel
        key="two"
        {...props}
        project={otherWorkspace.path}
        servicesRevision="r1"
      />,
    );
    vi.mocked(api.planMcpConnections).mockResolvedValue({ ...correctPlan, workspace_id: "two" });
    await check();
    fireEvent.click(verifyButton());
    await screen.findByText("workspace_read, external_read");
    await act(async () => response.resolve(toolList("stale_scope_tool")));
    expect(screen.queryByText(/stale_scope_tool/)).not.toBeInTheDocument();
    expect(screen.getByText("workspace_read, external_read")).toBeVisible();
    expect(api.verifyMcpConnection).toHaveBeenLastCalledWith("two", "codex");
  });

  it("automatically verifies applied and unchanged targets after applying a mixed plan", async () => {
    vi.mocked(api.planMcpConnections).mockResolvedValue({
      ...correctPlan,
      targets: [
        ...correctPlan.targets,
        { agent: "claude-code", status: "missing", selected: true },
      ],
      changes: [{ target: "/workspace/one/.mcp.json", scope: "project", after: "{}" }],
    });
    vi.mocked(api.applyMcpConnections).mockResolvedValue({
      targets: [
        { agent: "codex", status: "unchanged" },
        { agent: "claude-code", status: "applied" },
      ],
    });
    render(<McpBatchConnectionPanel {...props} servicesRevision="r1" />);
    await check();
    expect(api.verifyMcpConnection).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "mcp.manage.applyConnection" }));
    await waitFor(() => expect(api.verifyMcpConnection).toHaveBeenCalledTimes(2));
    expect(api.verifyMcpConnection).toHaveBeenNthCalledWith(1, "one", "codex");
    expect(api.verifyMcpConnection).toHaveBeenNthCalledWith(2, "one", "claude-code");
    expect(screen.getAllByText("workspace_read, external_read")).toHaveLength(2);
    expect(api.applyMcpConnections).toHaveBeenCalledExactlyOnceWith({
      token: "preview",
      approveHome: false,
    });
  });
});
