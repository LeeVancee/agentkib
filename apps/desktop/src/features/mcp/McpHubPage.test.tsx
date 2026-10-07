// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { initializeI18n, tr } from "@/core/i18n";
import type {
  McpConnectionInfo,
  McpServerConfig,
  RuntimeInfo,
  WorkspaceSummary,
} from "@/core/types";
import { McpHubPage } from "@/routes/catalog";

vi.mock("@/core/api", () => ({
  api: {
    mcpConnectionInfo: vi.fn(),
    verifyMcpConnection: vi.fn(),
    mcpServers: vi.fn(),
    mcpInstallations: vi.fn(),
    mcpRuntimes: vi.fn(),
    runtime: vi.fn(),
    probeMcpRuntime: vi.fn(),
    saveMcpServer: vi.fn(),
    saveMcpLocalValues: vi.fn(),
  },
}));
vi.mock("@/components/AppDialogProvider", () => ({
  useAppDialogs: () => ({ confirm: vi.fn(), requestSecrets: vi.fn() }),
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
const connection: McpConnectionInfo = {
  workspace_id: "one",
  target_agent: "codex",
  url: "http://127.0.0.1:47653/mcp/one/codex",
  config: '[mcp_servers.agentkib]\nurl = "http://127.0.0.1:47653/mcp/one/codex"',
  target: "/agent-home/.codex/config.toml",
  format: "toml",
  scope: "agent-home",
  hub_running: true,
};
const props = { runtime, workspaces, onRuntimeChanged: vi.fn(), onMigrationPlanned: vi.fn() };

describe("McpHubPage", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    await initializeI18n("en-US");
    vi.mocked(api.mcpConnectionInfo).mockResolvedValue(connection);
    vi.mocked(api.mcpInstallations).mockResolvedValue([]);
    vi.mocked(api.mcpRuntimes).mockResolvedValue([]);
    vi.mocked(api.runtime).mockResolvedValue(runtime);
    vi.mocked(api.mcpServers).mockResolvedValue([server()]);
  });
  afterEach(cleanup);

  it("does not let an old global load replace the selected workspace list", async () => {
    const user = userEvent.setup();
    let resolve!: (servers: McpServerConfig[]) => void;
    const oldGlobal = new Promise<McpServerConfig[]>((yes) => {
      resolve = yes;
    });
    vi.mocked(api.mcpServers).mockImplementation((project) =>
      project ? Promise.resolve([server("Workspace service")]) : oldGlobal,
    );
    render(<McpHubPage {...props} />);
    await user.click(screen.getByRole("combobox", { name: tr("mcp.scope") }));
    await user.click(await screen.findByRole("option", { name: "Workspace two" }));
    expect(await screen.findByText("Workspace service")).toBeVisible();
    await act(async () => resolve([server("Global service")]));
    expect(screen.getByText("Workspace service")).toBeVisible();
    expect(screen.queryByText("Global service")).toBeNull();
    expect(api.mcpServers).toHaveBeenLastCalledWith("/workspaces/two");
  });

  it("clears a previous Hub verification after a probe even when service configuration is unchanged", async () => {
    vi.mocked(api.verifyMcpConnection).mockResolvedValue({
      url: connection.url,
      checked_at: "2026-10-06T00:00:00Z",
      builtin_tools: 3,
      external_tools: [],
    });
    vi.mocked(api.probeMcpRuntime).mockResolvedValue([
      { server_id: "blender", name: "get_scene_info", input_schema: {}, read_only: true },
    ]);
    render(<McpHubPage {...props} />);
    await screen.findByText("Blender");
    await screen.findByTestId("mcp-connection-url");
    fireEvent.click(screen.getByRole("button", { name: tr("mcp.connection.verify") }));
    expect(await screen.findByText(tr("mcp.connection.verified"))).toBeVisible();
    const infoRequests = vi.mocked(api.mcpConnectionInfo).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: tr("mcp.probe") }));
    expect(await screen.findByText("Upstream probe passed · 1 tools")).toBeVisible();
    await waitFor(() =>
      expect(vi.mocked(api.mcpConnectionInfo).mock.calls.length).toBeGreaterThan(infoRequests),
    );
    expect(screen.queryByText(tr("mcp.connection.verified"))).toBeNull();
    expect(screen.getByText("get_scene_info")).toBeVisible();
  });

  it("explains the service editor format and rejects an mcpServers wrapper before saving", async () => {
    const { container } = render(<McpHubPage {...props} />);
    const ui = within(container);
    await ui.findByText("Blender");
    expect(ui.getByText(tr("mcp.editorDescription"))).toBeVisible();
    expect(ui.getByText(tr("mcp.allAgents"))).toBeVisible();
    fireEvent.change(ui.getByRole("textbox", { name: tr("mcp.publicJson") }), {
      target: {
        value: JSON.stringify({
          mcpServers: { blender: { command: "uvx", args: ["mcp-for-blender"] } },
        }),
      },
    });
    fireEvent.click(ui.getByRole("button", { name: tr("common.save") }));
    expect(await ui.findByText(tr("mcp.wrapperUnsupported"))).toBeVisible();
    expect(api.saveMcpServer).not.toHaveBeenCalled();
    expect(api.saveMcpLocalValues).not.toHaveBeenCalled();
  });
});
