// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "@/core/i18n";
import { api } from "@/core/api";
import type { WorkspaceSummary } from "@/core/types";
import { CursorBridgePanel } from "./CursorBridgePanel";

vi.mock("@/core/api", () => ({
  api: { cursorBridge: vi.fn(), cursorBridgeBundle: vi.fn(), revealCursorBridgeBundle: vi.fn() },
}));
const workspace = {
  id: "local-workspace",
  path: "/synthetic/workspace",
  name: "synthetic",
} as WorkspaceSummary;
const offline = {
  id: "existing-binding",
  profile: "explicit-profile",
  version: "3.22.12",
  connected: false,
};
const challenge = "synthetic-one-time-code";
describe("Cursor bridge connection UI", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => {
    vi.mocked(api.cursorBridge)
      .mockReset()
      .mockImplementation(async (request) =>
        request.action === "connect"
          ? { challenge, expires_in_seconds: 1 }
          : { supported: true, version: "3.22.12", bindings: [offline] },
      );
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });
  it("reconnects the selected binding and removes an expired one-time code", async () => {
    render(
      <CursorBridgePanel
        workspace={workspace}
        bindingId={offline.id}
        disabled={false}
        onBindingChange={vi.fn()}
        onStatusChange={vi.fn()}
      />,
    );
    const reconnect = await screen.findByRole("button", { name: "Reconnect selected window" });
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(reconnect);
    });
    expect(api.cursorBridge).toHaveBeenCalledWith({
      action: "connect",
      workspaceId: workspace.id,
      bindingId: offline.id,
    });
    expect(screen.getByRole("textbox", { name: "One-time local connection code" })).toHaveValue(
      challenge,
    );
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.queryByRole("textbox", { name: "One-time local connection code" })).toBeNull();
  });
  it("does not contact a local bridge for a remote workspace", async () => {
    render(
      <CursorBridgePanel
        workspace={{ ...workspace, remote: {} as NonNullable<WorkspaceSummary["remote"]> }}
        bindingId=""
        disabled={false}
        onBindingChange={vi.fn()}
        onStatusChange={vi.fn()}
      />,
    );
    expect(
      screen.getByText("Connect Cursor from a local workspace on this computer."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Connect a Cursor window" })).toBeDisabled();
    await act(async () => {});
    expect(api.cursorBridge).not.toHaveBeenCalled();
  });
  it("never chooses a profile automatically when connection status arrives", async () => {
    const onBindingChange = vi.fn();
    const onStatusChange = vi.fn();
    vi.mocked(api.cursorBridge).mockResolvedValue({
      supported: true,
      version: "3.22.12",
      bindings: [{ ...offline, connected: true }],
    });
    render(
      <CursorBridgePanel
        workspace={workspace}
        bindingId=""
        disabled={false}
        onBindingChange={onBindingChange}
        onStatusChange={onStatusChange}
      />,
    );
    await waitFor(() =>
      expect(onStatusChange).toHaveBeenCalledWith(
        expect.objectContaining({ bindings: expect.any(Array) }),
      ),
    );
    expect(onBindingChange).not.toHaveBeenCalled();
    expect(screen.getByText("Choose the intended profile and window")).toBeVisible();
  });
});
