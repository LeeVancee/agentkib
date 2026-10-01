/** @jsxImportSource octane */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { api } from "@/core/api";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "@/core/i18n";
import type { ChangeSet, SessionHandoffLaunchRequest } from "@/core/types";
import { Changes } from "./changes.tsrx";

vi.mock("@/core/api", () => ({
  api: { continueSessionHandoff: vi.fn(), launchSessionHandoff: vi.fn() },
}));

vi.mock("@octanejs/tanstack-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@octanejs/tanstack-router")>();
  return {
    ...actual,
    createFileRoute: () => () => ({}),
    useNavigate: vi.fn(),
    useParams: vi.fn(),
  };
});

const changeSet: ChangeSet = {
  id: "changeset-native-session",
  project_root: "/workspace",
  created_at: "2026-09-01T00:00:00Z",
  requires_home_approval: true,
  changes: [
    {
      target: "/agent-home/sessions/import.jsonl",
      scope: "agent-home",
      before: "",
      after: "{}\n",
      risk: "high",
      validator: "jsonl",
    },
  ],
};

const launchRequest: SessionHandoffLaunchRequest = {
  mode: "native-session",
  workspace_id: "workspace",
  target_agent: "codex",
  target_session_id: "session",
  target_path: "/agent-home/sessions/import.jsonl",
  capabilities: {
    source_agent: "codex",
    target_agent: "codex",
    source_read: { status: "supported" },
    source_parse: { status: "supported" },
    native_resume: { status: "supported" },
    file_handoff: { status: "supported" },
    windowed_context: { status: "supported" },
    mcp_setup: { status: "supported" },
    interactive_launch: { status: "supported" },
  },
};

describe("Changes", () => {
  beforeAll(() => initializeI18n("en-US"));
  afterEach(cleanup);

  it("allows a native handoff after Agent Home approval", () => {
    render(
      <Changes
        changeSet={changeSet}
        origin="handoff"
        launchRequest={launchRequest}
        onPlanHome={vi.fn()}
        onApplied={vi.fn()}
        onLaunchCompleted={vi.fn()}
        onRejected={vi.fn()}
        onApplyingChange={vi.fn()}
      />,
    );

    const applyOnly = screen.getByRole("button", { name: "Apply only" }) as HTMLButtonElement;
    const applyAndContinue = screen.getByRole("button", {
      name: "Apply and continue in Codex",
    }) as HTMLButtonElement;
    expect(applyOnly.disabled).toBe(true);
    expect(applyAndContinue.disabled).toBe(true);

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "I authorize changes to the Agent Home files listed above",
      }),
    );

    expect(applyOnly.disabled).toBe(false);
    expect(applyAndContinue.disabled).toBe(false);
  });
  it("preserves an unknown native import for reconciliation without submitting it again", async () => {
    vi.mocked(api.continueSessionHandoff).mockResolvedValue({
      status: "import-outcome-unknown",
      error: { key: "runtime.unknown" },
    });
    vi.mocked(api.launchSessionHandoff).mockResolvedValue({
      target_agent: "opencode",
      terminal: "Terminal",
    });
    const request: SessionHandoffLaunchRequest = {
      mode: "native-import",
      operation_id: "op",
      plan_hash: "hash",
      target_agent: "opencode",
      workspace_id: "workspace",
      capabilities: launchRequest.capabilities,
    };
    const onApplied = vi.fn();
    const onLaunchCompleted = vi.fn();
    const props = {
      origin: "handoff" as const,
      launchRequest: request,
      onPlanHome: vi.fn(),
      onApplied,
      onLaunchCompleted,
      onRejected: vi.fn(),
      onApplyingChange: vi.fn(),
    };
    const { rerender } = render(
      <Changes {...props} changeSet={{ ...changeSet, requires_home_approval: false }} />,
    );
    expect(screen.queryByRole("button", { name: "Apply only" })).toBeNull();
    expect(screen.getByText(/target Agent CLI to create/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Apply and continue in OpenCode" }));
    await waitFor(() => expect(onApplied).toHaveBeenCalledWith(true));
    rerender(<Changes {...props} />);
    expect(screen.getByText("Import needs verification")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Check import and continue" }));
    await waitFor(() => expect(onLaunchCompleted).toHaveBeenCalledTimes(1));
    expect(api.continueSessionHandoff).toHaveBeenCalledTimes(1);
    expect(api.launchSessionHandoff).toHaveBeenCalledWith(request);
  });
});
