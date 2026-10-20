// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexSessionSettings } from "@agentkib/web-client";
import { CodexComposerControls } from "./codex-session-controls";
import { useSession } from "./session-context";
import type { SessionController } from "./use-session-controller";

vi.mock("./session-context", () => ({ useSession: vi.fn() }));
let state: SessionController;
const settings: CodexSessionSettings = {
  sessionId: "session",
  revision: 1,
  available: true,
  current: { modelId: "unlisted-model", effort: "low" },
  defaults: { modelId: "listed-model", effort: "low" },
  writable: {
    model: { available: true },
    effort: { available: true },
    mode: { available: false },
    serviceTier: { available: false },
    policy: { available: false },
    restoreDefaults: { available: true },
  },
  options: {
    models: [{ id: "listed-model", name: "Listed model", efforts: ["low"], serviceTierIds: [] }],
    policies: [],
    serviceTiers: [],
  },
};

beforeEach(() => {
  state = {
    selected: "session",
    current: { id: "session", agent: "codex" },
    locale: "en-US",
    online: true,
    busy: false,
    notice: "notDispatched",
    noticeReason: "unsupported-model",
    access: { device: { id: "device", accessMode: "full" } },
    live: { sessionId: "session", status: "idle", revision: 1 },
    capabilities: { sessionId: "session", features: { settings: { available: true } } },
    client: {
      codexSessionSettings: vi.fn(async () => settings),
      codexGoals: vi.fn(async () => ({
        sessionId: "session",
        revision: 1,
        available: false,
        actions: {},
      })),
    },
    codexAction: vi.fn(),
    control: vi.fn(),
  } as unknown as SessionController;
  vi.mocked(useSession).mockImplementation(() => state);
});
afterEach(cleanup);

describe("Codex settings recovery on desktop", () => {
  it.each([
    ["unsupported-model", /current model is not in the host's verified model list/],
    ["unsupported-effort", /current model does not support the selected reasoning effort/],
  ] as const)(
    "opens the existing settings dialog for %s without submitting",
    async (reason, text) => {
      state.noticeReason = reason;
      render(
        <CodexComposerControls
          resources={[]}
          setResources={vi.fn()}
          openPhoneFiles={vi.fn()}
          disabled={false}
        />,
      );
      expect(await screen.findByText(text)).toBeVisible();
      await screen.findByRole("button", { name: /unlisted-model/ });
      vi.mocked(state.client.codexSessionSettings).mockClear();
      fireEvent.click(screen.getByRole("button", { name: "Change next-turn model" }));
      expect(screen.getByRole("dialog", { name: "Session settings" })).toBeVisible();
      await waitFor(() =>
        expect(state.client.codexSessionSettings).toHaveBeenCalledWith("session"),
      );
      expect(state.codexAction).not.toHaveBeenCalled();
      expect(state.control).not.toHaveBeenCalled();
    },
  );

  it("does not offer recovery for an uncertain receipt", () => {
    state.notice = "uncertain";
    render(
      <CodexComposerControls
        resources={[]}
        setResources={vi.fn()}
        openPhoneFiles={vi.fn()}
        disabled={false}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Change next-turn model" }),
    ).not.toBeInTheDocument();
  });
});
