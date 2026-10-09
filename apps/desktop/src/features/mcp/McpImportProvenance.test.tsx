// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { McpImportPanel } from "./McpImportPanel";

vi.mock("@/core/useI18n", () => ({
  useI18n: () => ({
    tr: (key: string) => key,
    localizeMessage: (reason: unknown) =>
      reason instanceof Error ? reason.message : String(reason),
  }),
}));
vi.mock("@/core/api", () => ({
  api: {
    nativeMcpCandidates: vi.fn(),
    previewMcpImport: vi.fn(),
    applyMcpImport: vi.fn(),
  },
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.nativeMcpCandidates).mockResolvedValue([
    {
      id: "source-id",
      agent: "claude-code",
      scope: "project",
      name: "tool",
      source_path: "/workspace/.mcp.json",
      transport: "stdio",
      endpoint: "node",
      has_secret_values: false,
      supported: true,
      warnings: [],
    },
  ]);
  vi.mocked(api.previewMcpImport).mockResolvedValue({
    token: "import-preview",
    revision: "r1",
    items: [
      {
        key: "source-id",
        status: "identical",
        warnings: [],
        required_env: [],
        required_headers: [],
        config: {
          id: "tool",
          name: "tool",
          transport: "stdio",
          command: "node",
          args: [],
          enabled: false,
          env: {},
          headers: {},
          targets: ["claude-code"],
          allow_tools: [],
          lan_allow_tools: [],
          supports_parallel_tool_calls: false,
        },
      },
    ],
  });
  vi.mocked(api.applyMcpImport).mockResolvedValue({
    revision: "r2",
    results: [{ key: "source-id", id: "tool", status: "skipped" }],
  });
});
afterEach(cleanup);

async function previewIdentical() {
  const user = userEvent.setup(),
    onSaved = vi.fn().mockResolvedValue(undefined);
  render(<McpImportPanel project="/workspace" onSaved={onSaved} />);
  await user.click(screen.getByRole("button", { name: "mcp.manage.scanNative" }));
  await user.click(await screen.findByRole("checkbox", { name: /tool/ }));
  await user.click(screen.getByRole("button", { name: "mcp.manage.previewNative" }));
  const choice = await screen.findByRole("combobox", { name: "source-id action" });
  await waitFor(() => expect(choice).toBeEnabled());
  return { user, choice, onSaved };
}

async function previewConflict() {
  vi.mocked(api.previewMcpImport).mockResolvedValue({
    token: "import-preview",
    revision: "r1",
    items: [
      {
        key: "source-id",
        status: "conflict",
        warnings: [],
        required_env: [],
        required_headers: [],
        config: {
          id: "tool",
          name: "tool",
          transport: "stdio",
          command: "imported",
          args: [],
          enabled: false,
          env: {},
          headers: {},
          targets: [],
          allow_tools: [],
          lan_allow_tools: [],
          supports_parallel_tool_calls: false,
        },
      },
    ],
  });
  return previewIdentical();
}

describe("MCP native provenance reconfirmation", () => {
  it("clears the add-as ID before replacing the previewed service", async () => {
    const { user, choice, onSaved } = await previewConflict();
    await user.click(choice);
    await user.click(await screen.findByRole("option", { name: "mcp.manage.addAs" }));
    const id = screen.getByRole("textbox", { name: "source-id ID" });
    await user.clear(id);
    await user.type(id, "other-existing-service");
    await user.click(choice);
    await user.click(await screen.findByRole("option", { name: "mcp.manage.replaceLocal" }));
    expect(screen.queryByRole("textbox", { name: "source-id ID" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "mcp.manage.collect" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(api.applyMcpImport).toHaveBeenCalledWith({
      project: "/workspace",
      token: "import-preview",
      revision: "r1",
      selections: [{ key: "source-id", action: "replace" }],
    });
    expect(vi.mocked(api.applyMcpImport).mock.calls[0]![0].selections[0]).not.toHaveProperty("id");
  });

  it("resets a discarded add-as ID while preserving an explicitly entered new ID", async () => {
    const { user, choice, onSaved } = await previewConflict();
    await user.click(choice);
    await user.click(await screen.findByRole("option", { name: "mcp.manage.addAs" }));
    const id = screen.getByRole("textbox", { name: "source-id ID" });
    await user.clear(id);
    await user.type(id, "discarded-id");
    await user.click(choice);
    await user.click(await screen.findByRole("option", { name: "mcp.manage.skip" }));
    expect(screen.getByRole("button", { name: "mcp.manage.collect" })).toBeDisabled();
    await user.click(choice);
    await user.click(await screen.findByRole("option", { name: "mcp.manage.addAs" }));
    const resetId = screen.getByRole("textbox", { name: "source-id ID" });
    expect(resetId).toHaveValue("tool");
    await user.clear(resetId);
    await user.type(resetId, "confirmed-copy");
    await user.click(screen.getByRole("button", { name: "mcp.manage.collect" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(api.applyMcpImport).toHaveBeenCalledWith(
      expect.objectContaining({
        selections: [{ key: "source-id", action: "add", id: "confirmed-copy" }],
      }),
    );
  });

  it("leaves identical imports skipped until the user explicitly reconfirms the source", async () => {
    const { user, choice, onSaved } = await previewIdentical();
    expect(choice).toHaveTextContent("mcp.manage.skip");
    expect(screen.getByRole("button", { name: "mcp.manage.collect" })).toBeDisabled();
    expect(api.applyMcpImport).not.toHaveBeenCalled();
    await user.click(choice);
    expect(screen.queryByRole("option", { name: "mcp.manage.addAs" })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("option", { name: "mcp.manage.reconfirm" }));
    await user.click(screen.getByRole("button", { name: "mcp.manage.collect" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(api.applyMcpImport).toHaveBeenCalledWith({
      project: "/workspace",
      token: "import-preview",
      revision: "r1",
      selections: [{ key: "source-id", action: "replace" }],
    });
    expect(screen.getByRole("status")).toHaveTextContent("mcp.manage.import_skipped");
  });

  it("shows the owning-scope error without reporting a successful reconfirmation", async () => {
    const message = "Reconfirm this inherited native source in global scope before migration";
    vi.mocked(api.applyMcpImport).mockRejectedValue(new Error(message));
    const { user, choice, onSaved } = await previewIdentical();
    await user.click(choice);
    await user.click(await screen.findByRole("option", { name: "mcp.manage.reconfirm" }));
    await user.click(screen.getByRole("button", { name: "mcp.manage.collect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "mcp.manage.collect" })).toBeEnabled();
  });
});
