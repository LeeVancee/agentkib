// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { initializeI18n } from "@/core/i18n";
import { WebPairingPrompt } from "./WebPairingPrompt";

const request = vi.fn();
vi.mock("@/core/desktop", () => ({ desktopApi: () => ({ web: { request } }) }));

const pending = {
  id: "pending-browser",
  name: "Phone",
  verification: "12345678",
  expiresAt: Date.now() + 300_000,
};
const baseStatus = {
  config: { enabled: true, port: 1421, externalOrigin: "", experimentalEnabled: true },
  running: true,
  localUrl: "http://127.0.0.1:1421",
  experimentalAvailable: true,
  pending: [pending],
  devices: [],
};

beforeAll(() => initializeI18n("en-US"));
beforeEach(() => {
  request.mockReset();
  request.mockImplementation(async (input: { operation: string }) =>
    input.operation === "status" ? baseStatus : { ...baseStatus, pending: [] },
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("prompts on every desktop route and grants only permissions selected in the dialog", async () => {
  render(<WebPairingPrompt />);
  expect(await screen.findByRole("dialog", { name: "Pending browsers" })).toBeTruthy();
  expect(screen.getByText("12345678")).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: "Allow sending" }));
  fireEvent.click(screen.getByRole("button", { name: "Authorize" }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith({
      operation: "approve",
      id: pending.id,
      send: true,
      approve: false,
      manage: false,
      files: false,
      attachments: false,
      advancedControl: false,
      organize: false,
      settings: false,
      extendedApproval: false,
    }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("closing the global prompt leaves the request pending for remote settings", async () => {
  render(<WebPairingPrompt />);
  expect(await screen.findByRole("dialog", { name: "Pending browsers" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Review later in remote settings" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ operation: "approve" }));
  await act(async () => {});
});

it("does not prompt for code pairing while retaining review of older pending requests", async () => {
  request.mockResolvedValue({ ...baseStatus, pairingMode: "code", pending: [] });
  const view = render(<WebPairingPrompt />);
  await act(async () => {});
  expect(screen.queryByRole("dialog")).toBeNull();
  view.unmount();
  request.mockResolvedValue({ ...baseStatus, pairingMode: "code" });
  render(<WebPairingPrompt />);
  expect(await screen.findByRole("dialog", { name: "Pending browsers" })).toBeTruthy();
  expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ operation: "approve" }));
});
