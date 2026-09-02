// @vitest-environment jsdom

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { AppDialogProvider } from "@/components/AppDialogProvider";
import { initializeI18n } from "@/core/i18n";
import type {
  AgentKind,
  AgentToolExecutionResult,
  AgentToolSnapshot,
  AgentToolStatus,
} from "@/core/types";
import { AgentToolsSettings } from "./AgentToolsSettings";
import { refreshAgentTools, useAgentTools } from "./agent-tools-query";
import { api } from "@/core/api";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";

vi.mock("./agent-tools-query", () => ({
  agentToolsKey: ["settings", "agent-tools"],
  useAgentTools: vi.fn(),
  refreshAgentTools: vi.fn(),
}));

vi.mock("@/core/api", () => ({
  api: {
    openExternal: vi.fn(),
    checkAppUpdate: vi.fn(),
    installAppUpdate: vi.fn(),
    executeAgentTool: vi.fn(),
  },
}));

const agents: AgentKind[] = [
  "codex",
  "claude-code",
  "cursor",
  "opencode",
  "open-claw",
  "hermes",
  "grok-build",
];

function tool(agent: AgentKind, overrides: Partial<AgentToolStatus> = {}): AgentToolStatus {
  return {
    agent,
    installed: true,
    current_version: "1.0.0",
    latest_version: "1.0.0",
    recommended_version: "1.0.0",
    upstream_version: "1.0.0",
    state: "current",
    channel: "official-installer",
    installations: [
      {
        id: `${agent}:install`,
        path: `/usr/local/bin/${agent}`,
        resolved_path: `/usr/local/bin/${agent}`,
        version: "1.0.0",
        runnable: true,
        channel: "official-installer",
        environment: "standalone",
        is_path_default: true,
      },
    ],
    warnings: [],
    official_url: `https://example.com/${agent}`,
    actions: [
      {
        id: `${agent}:docs:official-installer:unversioned`,
        kind: "open-documentation",
        mode: "open-documentation",
        channel: "official-installer",
        url: `https://example.com/${agent}`,
      },
    ],
    ...overrides,
  };
}

const snapshot: AgentToolSnapshot = {
  tools: agents.map((agent) =>
    agent === "codex"
      ? tool(agent, {
          current_version: "1.0.0",
          latest_version: "1.1.0",
          recommended_version: "1.1.0",
          state: "update-available",
          actions: [
            {
              id: "codex:update:npm:1.1.0",
              kind: "update",
              mode: "execute",
              channel: "npm",
              shell: "posix",
              command: "/usr/local/bin/npm install -g @openai/codex@1.1.0",
              url: "https://github.com/openai/codex",
              target_version: "1.1.0",
              installation_id: "codex:install",
              manager_path: "/usr/local/bin/npm",
            },
          ],
        })
      : tool(agent),
  ),
  checked_at: "2026-09-02T08:00:00Z",
  latest_checked_at: "2026-09-02T08:00:00Z",
  cache_status: "fresh",
  errors: [],
};

function renderSettings() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AppDialogProvider>
        <AgentToolsSettings currentVersion="0.7.0" updatesEnabled />
      </AppDialogProvider>
    </QueryClientProvider>,
  );
}

describe("AgentToolsSettings", () => {
  beforeAll(() => initializeI18n("en-US"));
  afterEach(cleanup);
  beforeEach(() => {
    useWorkspaceStore.getState().resetWorkspace();
    vi.mocked(useAgentTools).mockReturnValue({
      data: snapshot,
      error: null,
      isPending: false,
    } as ReturnType<typeof useAgentTools>);
    vi.mocked(api.openExternal).mockReset().mockResolvedValue(undefined);
    vi.mocked(api.checkAppUpdate).mockReset();
    vi.mocked(api.installAppUpdate).mockReset();
    vi.mocked(api.executeAgentTool).mockReset().mockResolvedValue({
      agent: "codex",
      action_id: "codex:update:npm:1.1.0",
      status: "succeeded",
      exit_code: 0,
      output: "updated",
      installation_id: "codex:install",
      before_version: "1.0.0",
      after_version: "1.1.0",
      completed_at: "2026-09-02T08:01:00Z",
    });
    vi.mocked(refreshAgentTools).mockReset().mockResolvedValue(snapshot);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("shows all supported Agents and links to the AgentKib project", async () => {
    const user = userEvent.setup();
    renderSettings();

    for (const name of [
      "Codex",
      "Claude Code",
      "Cursor",
      "OpenCode",
      "OpenClaw",
      "Hermes",
      "Grok Build",
    ]) {
      expect(screen.getAllByText(name).length).toBeGreaterThan(0);
    }

    await user.click(screen.getByRole("button", { name: "GitHub" }));
    expect(api.openExternal).toHaveBeenCalledWith("https://github.com/starroyhq/agentkib");

    await user.click(screen.getByRole("button", { name: "Environment guide" }));
    expect(api.openExternal).toHaveBeenCalledWith(
      "https://github.com/starroyhq/agentkib/blob/main/docs/DEVELOPMENT.md",
    );
  });

  it("never exposes DeepSeek Harness in tool management", () => {
    vi.mocked(useAgentTools).mockReturnValue({
      data: {
        ...snapshot,
        tools: [...snapshot.tools, tool("deepseek-harness")],
      },
      error: null,
      isPending: false,
    } as ReturnType<typeof useAgentTools>);

    renderSettings();

    expect(screen.queryByText("DeepSeek Harness")).toBeNull();
  });

  it("shows per-installation diagnostics and the PATH default", async () => {
    const conflicted = tool("codex", {
      state: "conflict",
      channel: "unknown",
      installations: [
        {
          id: "codex:nvm",
          path: "~/.nvm/versions/node/v22/bin/codex",
          resolved_path: "~/.nvm/versions/node/v22/lib/node_modules/@openai/codex/bin/codex.js",
          version: "1.0.0",
          runnable: true,
          channel: "npm",
          environment: "nvm",
          manager_path: "~/.nvm/versions/node/v22/bin/npm",
          is_path_default: true,
        },
        {
          id: "codex:brew",
          path: "/opt/homebrew/bin/codex",
          resolved_path: "/opt/homebrew/Caskroom/codex/1.0.0/codex",
          runnable: false,
          error: "Version probe failed",
          channel: "homebrew",
          environment: "system",
          manager_path: "/opt/homebrew/bin/brew",
          is_path_default: false,
        },
      ],
    });
    vi.mocked(useAgentTools).mockReturnValue({
      data: { ...snapshot, tools: [conflicted, ...snapshot.tools.slice(1)] },
      error: null,
      isPending: false,
    } as ReturnType<typeof useAgentTools>);

    const user = userEvent.setup();
    renderSettings();
    await user.click(screen.getByRole("button", { name: "Diagnose installations (1)" }));

    expect(screen.getByText("PATH default")).toBeTruthy();
    expect(screen.getByText("Not runnable")).toBeTruthy();
    expect(screen.getByText("Version probe failed")).toBeTruthy();
    expect(screen.getByText(/Resolved target: .*node_modules\/@openai\/codex/)).toBeTruthy();
    expect(screen.getByText(/\.nvm\/versions\/node\/v22\/bin\/npm/)).toBeTruthy();
  });

  it("reports matching duplicate installations without marking them as a conflict", async () => {
    const duplicate = tool("codex", {
      state: "current",
      warnings: ["multiple-executables"],
      installations: [
        {
          id: "codex:default",
          path: "/opt/homebrew/bin/codex",
          resolved_path: "/opt/homebrew/Caskroom/codex/1.0.0/bin/codex",
          version: "1.0.0",
          runnable: true,
          channel: "homebrew",
          environment: "system",
          manager_path: "/opt/homebrew/bin/brew",
          is_path_default: true,
        },
        {
          id: "codex:secondary",
          path: "~/.local/bin/codex",
          resolved_path: "~/.local/share/codex/codex",
          version: "1.0.0",
          runnable: true,
          channel: "official-installer",
          environment: "standalone",
          is_path_default: false,
        },
      ],
    });
    vi.mocked(useAgentTools).mockReturnValue({
      data: { ...snapshot, tools: [duplicate, ...snapshot.tools.slice(1)] },
      error: null,
      isPending: false,
    } as ReturnType<typeof useAgentTools>);

    const user = userEvent.setup();
    renderSettings();

    expect(screen.queryByText("Conflict")).toBeNull();
    expect(screen.getByText("2 installations found; updates target the PATH default")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Diagnose installations (1)" }));
    expect(screen.getAllByText("/opt/homebrew/bin/codex").length).toBeGreaterThan(0);
    expect(screen.getByText("~/.local/bin/codex")).toBeTruthy();
  });

  it("confirms before executing an official channel action", async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(screen.getByRole("button", { name: "Update" }));
    expect(screen.getByText(/npm install -g @openai\/codex@1\.1\.0/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => {
      expect(api.executeAgentTool).toHaveBeenCalledWith("codex", "codex:update:npm:1.1.0");
    });
  });

  it("reports a failed refresh after a single update", async () => {
    vi.mocked(refreshAgentTools).mockRejectedValueOnce(new Error("detection unavailable"));
    const user = userEvent.setup();
    renderSettings();

    await user.click(screen.getByRole("button", { name: "Update" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    await user.click(await screen.findByRole("button", { name: "OK" }));
    expect(useWorkspaceStore.getState().message).toContain("detection unavailable");
    expect(api.executeAgentTool).toHaveBeenCalledOnce();
  });

  it("clears a global tool refresh error when detection succeeds", async () => {
    useWorkspaceStore.setState({ message: "global tools refresh failed" });
    const user = userEvent.setup();
    renderSettings();

    await user.click(screen.getByRole("button", { name: "Detect again" }));

    await waitFor(() => expect(refreshAgentTools).toHaveBeenCalledOnce());
    expect(useWorkspaceStore.getState().message).toBe("");
  });

  it("locks update and detection actions while execution is pending", async () => {
    let completeExecution!: (result: AgentToolExecutionResult) => void;
    vi.mocked(api.executeAgentTool).mockReturnValue(
      new Promise((resolve) => {
        completeExecution = resolve;
      }),
    );
    const user = userEvent.setup();
    renderSettings();

    await user.click(screen.getByRole("button", { name: "Update" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(api.executeAgentTool).toHaveBeenCalledTimes(1));

    const updateButton = screen.getByRole<HTMLButtonElement>("button", { name: "Update" });
    expect(updateButton.disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Detect again" }).disabled).toBe(
      true,
    );
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Review and update (1)" }).disabled,
    ).toBe(true);
    await user.click(updateButton);
    expect(api.executeAgentTool).toHaveBeenCalledTimes(1);

    completeExecution({
      agent: "codex",
      action_id: "codex:update:npm:1.1.0",
      status: "succeeded",
      exit_code: 0,
      output: "updated",
      installation_id: "codex:install",
      before_version: "1.0.0",
      after_version: "1.1.0",
      completed_at: "2026-09-02T08:01:00Z",
    });
    await user.click(await screen.findByRole("button", { name: "OK" }));
    await waitFor(() => expect(updateButton.disabled).toBe(false));
  });

  it("previews and confirms safe batch updates", async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(screen.getByRole("button", { name: "Review and update (1)" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByText(/npm install -g @openai\/codex@1\.1\.0/)).toBeTruthy();
    expect(api.executeAgentTool).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Run all updates" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => {
      expect(api.executeAgentTool).toHaveBeenCalledWith("codex", "codex:update:npm:1.1.0");
    });
  });

  it("reports a failed refresh after batch updates", async () => {
    vi.mocked(refreshAgentTools).mockRejectedValueOnce(new Error("batch detection unavailable"));
    const user = userEvent.setup();
    renderSettings();

    await user.click(screen.getByRole("button", { name: "Review and update (1)" }));
    await user.click(screen.getByRole("button", { name: "Run all updates" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    await user.click(await screen.findByRole("button", { name: "OK" }));
    expect(useWorkspaceStore.getState().message).toContain("batch detection unavailable");
    expect(api.executeAgentTool).toHaveBeenCalledOnce();
  });
});
