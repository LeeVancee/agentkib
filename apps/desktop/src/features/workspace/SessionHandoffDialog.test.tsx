// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { initializeI18n } from "@/core/i18n";
import type {
  ConversationSessionSummary,
  SessionHandoffDraft,
  WorkspaceSummary,
} from "@/core/types";
import { SessionHandoffDialog } from "./SessionHandoffDialog";

vi.mock("@/core/api", () => ({
  api: {
    prepareSessionHandoff: vi.fn(),
    planSessionHandoff: vi.fn(),
    sanitizeSessionHandoff: vi.fn(),
  },
}));

const workspace = { id: "workspace", name: "Workspace" } as WorkspaceSummary;
const session = {
  id: "session",
  workspace_id: workspace.id,
  agent: "codex",
  title: "Long session",
  archived: false,
  sidechain: false,
  availability: "readable",
} as ConversationSessionSummary;

const draft: SessionHandoffDraft = {
  filename: "continuation.md",
  format: "markdown",
  content: "windowed preview",
  redaction_count: 0,
  source_fingerprint: "fingerprint",
  mode: "native-session",
  native_capability: { supported: true, beta: true },
  stats: {
    turn_count: 100,
    message_count: 60,
    tool_call_count: 20,
    tool_result_count: 20,
    attachment_count: 0,
  },
  history_budget_tokens: 120_000,
  window_strategy: "windowed",
  window_stats: {
    estimated_total_tokens: 1_000_000,
    estimated_active_tokens: 120_000,
    estimated_deferred_tokens: 880_000,
    active: {
      turn_count: 12,
      message_count: 8,
      tool_call_count: 2,
      tool_result_count: 2,
      attachment_count: 0,
    },
    deferred_turn_count: 88,
    deferred_block_count: 90,
    estimate_quality: "conservative",
  },
  archive_id: "00000000-0000-4000-8000-000000000000",
  mcp_available: false,
  losses: [],
};

describe("SessionHandoffDialog", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => vi.mocked(api.prepareSessionHandoff).mockReset());
  afterEach(cleanup);

  it("uses the safe default budget and blocks a windowed import without MCP", async () => {
    vi.mocked(api.prepareSessionHandoff).mockResolvedValue({ status: "ready", draft });
    render(
      <SessionHandoffDialog
        workspace={workspace}
        session={session}
        targetAgents={["claude-code"]}
        onClose={vi.fn()}
        onPlanned={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Inspect transferable content" }));
    await waitFor(() =>
      expect(api.prepareSessionHandoff).toHaveBeenCalledWith(
        expect.objectContaining({ history_budget_tokens: 120_000 }),
      ),
    );
    expect(await screen.findByText("≈1000k Token")).toBeTruthy();
    expect(screen.getByText(/not connected to AgentKib MCP/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Review import changes" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
