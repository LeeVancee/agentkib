// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpManagementState, McpManagedEntry } from "@agentkib/runtime-protocol";
import { api } from "@/core/api";
import { initializeI18n, tr } from "@/core/i18n";
import type {
  McpRuntimeStatus,
  McpServerConfig,
  RuntimeInfo,
  WorkspaceSummary,
} from "@/core/types";
import { McpHubPage } from "@/routes/(main)/catalog";

vi.mock("@/core/api", () => ({
  api: {
    mcpConnectionInfo: vi.fn(),
    searchMcpRegistry: vi.fn(),
    installMcp: vi.fn(),
    verifyMcpConnection: vi.fn(),
    mcpServers: vi.fn(),
    mcpManagementState: vi.fn(),
    saveMcpConfiguration: vi.fn(),
    previewMcpImport: vi.fn(),
    applyMcpImport: vi.fn(),
    planMcpConnections: vi.fn(),
    applyMcpConnections: vi.fn(),
    getMcpPolicy: vi.fn(),
    saveMcpPolicy: vi.fn(),
    mcpInstallations: vi.fn(),
    mcpRuntimes: vi.fn(),
    restartMcpRuntime: vi.fn(),
    stopMcpRuntime: vi.fn(),
    runtime: vi.fn(),
    probeMcpRuntime: vi.fn(),
    saveMcpServer: vi.fn(),
    saveMcpLocalValues: vi.fn(),
  },
}));
vi.mock("@/components/AppDialogProvider", () => ({
  useAppDialogs: () => ({
    confirm: vi.fn().mockResolvedValue(true),
    requestSecrets: vi.fn().mockResolvedValue({}),
  }),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => () => ({}),
  useNavigate: () => vi.fn(),
}));

const runtime: RuntimeInfo = {
  app_name: "AgentKib",
  app_version: "0.15.1",
  app_channel: "development",
  updates_enabled: false,
  data_dir: "/data",
  database_path: "/data/config.sqlite",
  mcp_package_root: "/data/mcp",
  mcp_network: { port: 47653, lan_enabled: false, lan_risk_accepted: false },
  mcp_hub: {
    running: true,
    bind_address: "127.0.0.1",
    port: 47653,
    lan_enabled: false,
    accessible_addresses: ["http://127.0.0.1:47653"],
    runtime_count: 0,
    error_count: 0,
  },
  locale_preference: "en-US",
  effective_locale: "en-US",
  theme_preference: "system",
  effective_theme: "light",
  accent_theme_preference: null,
  sidebar_width_preference: null,
  app_icon_preference: "white",
  tray_available: false,
  session_index_enabled: true,
  local_auto_refresh_enabled: false,
  quota_auto_refresh_enabled: false,
  quota_auto_refresh_prompt_seen: false,
  onboarding: {
    version: 1,
    acknowledged_version: 1,
    doctor_completed: false,
    repairable_count: 0,
    repair_applied: false,
  },
};
const workspaces: WorkspaceSummary[] = ["one", "two"].map((id) => ({
  id,
  name: `Workspace ${id}`,
  path: `/workspaces/${id}`,
  status: "healthy",
  asset_count: 0,
  warning_count: 0,
  sources: [],
}));
const server = (name = "Blender"): McpServerConfig => ({
  id: "blender",
  name,
  enabled: true,
  env: {},
  headers: {},
  targets: [],
  allow_tools: [],
  lan_allow_tools: [],
  supports_parallel_tool_calls: false,
  transport: "stdio",
  command: "/bin/uvx",
  args: ["mcp-for-blender"],
});
const props = { runtime, workspaces, onRuntimeChanged: vi.fn(), onMigrationPlanned: vi.fn() };
const renderHub = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <McpHubPage {...props} />
    </QueryClientProvider>,
  );

const entry = (name = "Blender"): McpManagedEntry => ({
  config: server(name),
  scope: "global",
  inherited: false,
  required_env: [],
  required_headers: [],
  configured_env: [],
  configured_headers: [],
  oauth_configured: false,
});
const state = (name = "Blender"): McpManagementState => ({
  revision: "r1",
  servers: [entry(name)],
});
const runtimeInstance = (name: string, project?: string | null): McpRuntimeStatus => ({
  server_id: "blender",
  server_name: name,
  config_hash: `hash-${name}`,
  project,
  state: "running",
});

describe("McpHubPage management", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    await initializeI18n("en-US");
    vi.mocked(api.verifyMcpConnection).mockResolvedValue({
      url: "http://127.0.0.1/mcp",
      checked_at: "2026-10-09T00:00:00Z",
      builtin_tools: 0,
      external_tools: [],
    });
    vi.mocked(api.mcpInstallations).mockResolvedValue([]);
    vi.mocked(api.mcpRuntimes).mockResolvedValue([]);
    vi.mocked(api.runtime).mockResolvedValue(runtime);
    vi.mocked(api.mcpManagementState).mockResolvedValue(state());
    vi.mocked(api.saveMcpConfiguration).mockResolvedValue(state());
  });
  afterEach(cleanup);
  it("shows and restarts only runtime instances owned by the selected scope", async () => {
    const user = userEvent.setup();
    vi.mocked(api.mcpRuntimes).mockResolvedValue([
      runtimeInstance("Global runtime", null),
      runtimeInstance("Workspace one runtime", "/workspaces/one"),
      runtimeInstance("Workspace two runtime", "/workspaces/two"),
      runtimeInstance("Legacy runtime"),
    ]);
    renderHub();
    await screen.findByText("Blender");
    await user.click(screen.getByRole("button", { name: tr("mcp.manage.advanced") }));
    expect(await screen.findByText("Global runtime")).toBeVisible();
    expect(screen.queryByText("Workspace one runtime")).not.toBeInTheDocument();
    expect(screen.queryByText("Workspace two runtime")).not.toBeInTheDocument();
    expect(screen.queryByText("Legacy runtime")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: tr("mcp.restart") }));
    expect(api.restartMcpRuntime).toHaveBeenLastCalledWith("blender", undefined);

    for (const workspace of workspaces) {
      await user.click(screen.getByRole("combobox", { name: tr("mcp.scope") }));
      await user.click(await screen.findByRole("option", { name: workspace.name }));
      expect(await screen.findByText(`${workspace.name} runtime`)).toBeVisible();
      expect(screen.queryByText("Global runtime")).not.toBeInTheDocument();
      expect(screen.queryByText("Legacy runtime")).not.toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: tr("mcp.restart") })).toHaveLength(1);
      await user.click(screen.getByRole("button", { name: tr("mcp.restart") }));
      expect(api.restartMcpRuntime).toHaveBeenLastCalledWith("blender", workspace.path);
    }
    expect(api.restartMcpRuntime).toHaveBeenCalledTimes(3);
    await user.click(screen.getByRole("button", { name: tr("mcp.stopAllScopes") }));
    expect(api.stopMcpRuntime).toHaveBeenCalledExactlyOnceWith("blender");

    await user.click(screen.getByRole("combobox", { name: tr("mcp.scope") }));
    await user.click(await screen.findByRole("option", { name: tr("mcp.globalScope") }));
    expect(await screen.findByText("Global runtime")).toBeVisible();
    expect(screen.queryByText("Workspace two runtime")).not.toBeInTheDocument();
  });
  it("shows the scope empty state instead of exposing other or unknown runtime actions", async () => {
    const user = userEvent.setup();
    vi.mocked(api.mcpRuntimes).mockResolvedValue([
      runtimeInstance("Workspace two runtime", "/workspaces/two"),
      runtimeInstance("Legacy runtime"),
    ]);
    renderHub();
    await screen.findByText("Blender");
    await user.click(screen.getByRole("button", { name: tr("mcp.manage.advanced") }));
    expect(await screen.findByText(tr("mcp.runtimesEmpty"))).toBeVisible();
    expect(screen.queryByRole("button", { name: tr("mcp.restart") })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: tr("mcp.stopAllScopes") })).not.toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: tr("mcp.scope") }));
    await user.click(await screen.findByRole("option", { name: "Workspace one" }));
    expect(await screen.findByText(tr("mcp.runtimesEmpty"))).toBeVisible();
    expect(screen.queryByRole("button", { name: tr("mcp.restart") })).not.toBeInTheDocument();
    expect(screen.queryByText("Legacy runtime")).not.toBeInTheDocument();
    expect(api.restartMcpRuntime).not.toHaveBeenCalled();
  });
  it("discards late global state after choosing a workspace", async () => {
    const user = userEvent.setup();
    let resolve!: (value: McpManagementState) => void;
    const old = new Promise<McpManagementState>((yes) => {
      resolve = yes;
    });
    vi.mocked(api.mcpManagementState).mockImplementation((request) =>
      request.project ? Promise.resolve(state("Workspace service")) : old,
    );
    renderHub();
    await user.click(screen.getByRole("combobox", { name: tr("mcp.scope") }));
    await user.click(await screen.findByRole("option", { name: "Workspace two" }));
    expect(await screen.findByText("Workspace service")).toBeVisible();
    await act(async () => resolve(state("Global service")));
    expect(screen.queryByText("Global service")).toBeNull();
    expect(api.mcpManagementState).toHaveBeenLastCalledWith({ project: "/workspaces/two" });
  });
  it("preserves an editor draft across scope switches and keeps its original revision", async () => {
    const user = userEvent.setup();
    renderHub();
    await screen.findByText("Blender");
    await user.click(screen.getByRole("button", { name: tr("mcp.manage.edit") }));
    await user.click(screen.getByRole("button", { name: "JSON" }));
    const json = screen.getByRole("textbox", { name: "MCP JSON" });
    fireEvent.change(json, {
      target: { value: JSON.stringify({ ...server(), name: "Draft name" }) },
    });
    await user.click(screen.getByRole("combobox", { name: tr("mcp.scope") }));
    await user.click(await screen.findByRole("option", { name: "Workspace two" }));
    await screen.findByText("Blender");
    await user.click(screen.getByRole("combobox", { name: tr("mcp.scope") }));
    await user.click(await screen.findByRole("option", { name: tr("mcp.globalScope") }));
    expect(await screen.findByRole("textbox", { name: tr("mcp.manage.name") })).toHaveValue(
      "Draft name",
    );
    await user.click(screen.getByRole("button", { name: tr("common.save") }));
    await waitFor(() => expect(api.saveMcpConfiguration).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.saveMcpConfiguration).mock.calls[0][0]).toMatchObject({
      revision: "r1",
      originalId: "blender",
      server: { name: "Draft name" },
    });
  });
  it("saves a manual new service disabled without probing", async () => {
    renderHub();
    await screen.findByText("Blender");
    fireEvent.click(screen.getByRole("button", { name: tr("mcp.manage.add") }));
    fireEvent.click(screen.getByRole("button", { name: tr("common.save") }));
    fireEvent.click(screen.getByRole("button", { name: tr("common.save") }));
    await waitFor(() => expect(api.saveMcpConfiguration).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.saveMcpConfiguration).mock.calls[0][0].server.enabled).toBe(false);
    expect(api.probeMcpRuntime).not.toHaveBeenCalled();
    expect(api.saveMcpLocalValues).not.toHaveBeenCalled();
  });
  it("uses import preview for wrappers and never probes during collection", async () => {
    vi.mocked(api.previewMcpImport).mockResolvedValue({
      token: "t",
      revision: "r1",
      items: [
        {
          key: "one",
          config: server(),
          status: "new",
          warnings: [],
          required_env: [],
          required_headers: [],
        },
      ],
    });
    vi.mocked(api.applyMcpImport).mockResolvedValue({
      revision: "r2",
      results: [{ key: "one", status: "saved" }],
    });
    renderHub();
    await screen.findByText("Blender");
    fireEvent.click(screen.getByRole("button", { name: tr("mcp.manage.import") }));
    const text = JSON.stringify({ mcpServers: { blender: { command: "uvx" } } });
    fireEvent.change(screen.getByRole("textbox", { name: tr("mcp.manage.paste") }), {
      target: { value: text },
    });
    fireEvent.click(screen.getByRole("button", { name: tr("mcp.manage.previewPaste") }));
    await screen.findByRole("button", { name: tr("mcp.manage.collect") });
    expect(api.previewMcpImport).toHaveBeenCalledWith({ project: undefined, text });
    fireEvent.click(screen.getByRole("button", { name: tr("mcp.manage.collect") }));
    await waitFor(() => expect(api.applyMcpImport).toHaveBeenCalledTimes(1));
    expect(api.probeMcpRuntime).not.toHaveBeenCalled();
    expect(api.saveMcpServer).not.toHaveBeenCalled();
  });
  it("requires an explicit workspace for global bulk connection and gates home writes", async () => {
    const user = userEvent.setup();
    vi.mocked(api.planMcpConnections).mockResolvedValue({
      token: "t",
      workspace_id: "two",
      targets: [
        {
          agent: "hermes",
          status: "missing",
          selected: true,
          target: "/home/config.yaml",
          scope: "agent-home",
        },
      ],
      changes: [
        { target: "/home/config.yaml", scope: "agent-home", before: "", after: "redacted" },
      ],
      requires_home_approval: true,
    });
    vi.mocked(api.applyMcpConnections).mockResolvedValue({
      targets: [{ agent: "hermes", status: "applied" }],
    });
    renderHub();
    await screen.findByText("Blender");
    fireEvent.click(screen.getByRole("button", { name: tr("mcp.manage.connect") }));
    expect(screen.getByRole("button", { name: tr("mcp.manage.checkPreview") })).toBeDisabled();
    await user.click(screen.getByRole("combobox", { name: tr("mcp.manage.workspace") }));
    await user.click(await screen.findByRole("option", { name: "Workspace two" }));
    fireEvent.click(screen.getByRole("button", { name: tr("mcp.manage.selectAllAgents") }));
    fireEvent.click(screen.getByRole("button", { name: tr("mcp.manage.checkPreview") }));
    const apply = await screen.findByRole("button", { name: tr("mcp.manage.applyConnection") });
    expect(apply).toBeDisabled();
    expect(vi.mocked(api.planMcpConnections).mock.calls[0][0].targetAgents).toHaveLength(8);
    fireEvent.click(screen.getByRole("checkbox", { name: tr("mcp.manage.homeApproval") }));
    fireEvent.click(apply);
    fireEvent.click(apply);
    await waitFor(() => expect(api.applyMcpConnections).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(tr("mcp.manage.reloadHint"))).toBeVisible();
  });
  it("refreshes the management inventory after a registry installation", async () => {
    const registry = {
      name: "Registry fixture",
      description: "",
      version: "1",
      package_kind: "npm" as const,
      identifier: "fixture",
      required_env: [],
      runtime_arguments: [],
      package_arguments: [],
    };
    vi.mocked(api.searchMcpRegistry).mockResolvedValue([registry]);
    vi.mocked(api.installMcp).mockImplementation(async () => {
      vi.mocked(api.mcpManagementState).mockResolvedValue(state("Installed fixture"));
      return {
        server: server("Installed fixture"),
        tools: [],
        installation: {
          id: "fixture",
          name: "Registry fixture",
          package_kind: "npm",
          identifier: "fixture",
          version: "1",
          status: "installed",
          installed_at: "2026-10-09",
          updated_at: "2026-10-09",
        },
      };
    });
    renderHub();
    await screen.findByText("Blender");
    fireEvent.click(screen.getByRole("button", { name: tr("mcp.manage.advanced") }));
    fireEvent.click(screen.getByRole("button", { name: tr("common.search") }));
    fireEvent.click(await screen.findByRole("button", { name: tr("mcp.install") }));
    expect(await screen.findByText("Installed fixture")).toBeVisible();
    expect(screen.queryByText("Blender")).not.toBeInTheDocument();
  });
  it("retries only failed selected services with the original desired state", async () => {
    const initial = {
      revision: "r1",
      servers: [
        entry("Blender"),
        { ...entry("Other"), config: { ...server("Other"), id: "other" } },
      ],
    };
    vi.mocked(api.mcpManagementState).mockResolvedValue(initial);
    vi.mocked(api.saveMcpConfiguration).mockImplementation(async (request) => {
      if (
        request.server.id === "other" &&
        vi.mocked(api.saveMcpConfiguration).mock.calls.filter(([r]) => r.server.id === "other")
          .length === 1
      )
        throw new Error("external edit");
      return initial;
    });
    renderHub();
    await screen.findByText("Blender");
    fireEvent.click(screen.getByRole("checkbox", { name: tr("mcp.manage.selectVisible") }));
    fireEvent.click(screen.getByRole("button", { name: tr("mcp.manage.disableSelected") }));
    fireEvent.click(await screen.findByRole("button", { name: tr("mcp.manage.retryFailed") }));
    await waitFor(() => expect(api.saveMcpConfiguration).toHaveBeenCalledTimes(3));
    expect(
      vi
        .mocked(api.saveMcpConfiguration)
        .mock.calls.map(([request]) => [request.server.id, request.server.enabled]),
    ).toEqual([
      ["blender", false],
      ["other", false],
      ["other", false],
    ]);
  });
});
