import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebClient, type ConversationEvent } from "@agentkib/web-client";
import { dictionaries } from "@/i18n";
import { useSessionController } from "./use-session-controller";
import { SessionDialogs } from "./session-dialogs";

const state = vi.hoisted(() => ({ modal: undefined as unknown }));
vi.mock("./use-session-live", () => ({ useSessionLive: () => {} }));
vi.mock("@/features/preferences/use-appearance", () => ({ useAppearance: () => {} }));
vi.mock("./session-context", () => ({
  useSession: () => ({ modal: state.modal, t: dictionaries["zh-CN"], locale: "zh-CN" }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("production session guidance", () => {
  const t = dictionaries["zh-CN"];
  it.each([
    ["open-in-original-client", t.openOriginalClient],
    ["unverified-installation", t.unverifiedInstallation],
    ["platform-unsupported", t.unsupportedControl],
    ["provider-unsupported", t.unsupportedControl],
    ["private runtime error", t.unavailable],
    ["control-outcome-unconfirmed", t.controlUnconfirmed],
  ])("maps live reason %s in the controller", async (reason, expected) => {
    vi.spyOn(WebClient.prototype, "access").mockResolvedValue({
      status: "approved",
      csrfToken: "test",
      bootId: "boot",
      experimentalEnabled: false,
    });
    vi.spyOn(WebClient.prototype, "catalog").mockResolvedValue({
      indexEnabled: true,
      sessions: [
        {
          id: "test",
          workspace_id: "w",
          agent: "codex",
          availability: "readable",
          archived: false,
          sidechain: false,
        },
      ],
    });
    vi.spyOn(WebClient.prototype, "events").mockResolvedValue({ events: [], warnings: [] });
    vi.spyOn(WebClient.prototype, "live").mockResolvedValue({
      status: "unavailable",
      reason,
      sessionId: "test",
      revision: 1,
      sendEnabled: false,
      approvals: [],
    });
    const { result } = renderHook(() => useSessionController({}));
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));
    await act(() => result.current.choose("test"));
    expect(result.current.liveText).toBe(expected);
  });

  it.each([undefined, "", "   ", "  saved tool content  "])(
    "renders tool summary content %s in the dialog",
    (content) => {
      state.modal = {
        id: "tool",
        kind: "tool-summary",
        content,
        truncated: true,
        attachment_count: 0,
      } satisfies ConversationEvent;
      render(<SessionDialogs />);
      expect(screen.getByRole("dialog")).toHaveTextContent(
        content?.trim() ? content.trim() : t.toolSummaryUnavailable,
      );
      expect(screen.getByText(t.truncated)).toBeVisible();
      expect(screen.queryByText(t.history)).not.toBeInTheDocument();
      if (content?.trim()) expect(document.querySelector("pre")?.textContent).toBe(content);
    },
  );

  it.each(["running", "waiting-approval"])(
    "stops the exact active Antigravity turn while %s",
    async (status) => {
      vi.spyOn(WebClient.prototype, "access").mockResolvedValue({
        status: "approved",
        csrfToken: "test",
        bootId: "boot",
        experimentalEnabled: true,
        device: { id: "device", name: "Browser", send: true, approve: false },
      });
      vi.spyOn(WebClient.prototype, "catalog").mockResolvedValue({
        indexEnabled: true,
        sessions: [
          {
            id: "antigravity-session",
            workspace_id: "workspace",
            agent: "antigravity",
            availability: "readable",
            archived: false,
            sidechain: false,
          },
        ],
      });
      vi.spyOn(WebClient.prototype, "events").mockResolvedValue({ events: [], warnings: [] });
      vi.spyOn(WebClient.prototype, "live").mockResolvedValue({
        sessionId: "antigravity-session",
        status,
        revision: 4,
        turnId: '"prompt-4"',
        sendEnabled: false,
        stopEnabled: true,
        approvals: [],
        executionMode: "acp-managed",
      });
      const request = vi
        .spyOn(WebClient.prototype, "request")
        .mockResolvedValue({ accepted: true });
      const { result } = renderHook(() => useSessionController({}));
      await waitFor(() => expect(result.current.sessions).toHaveLength(1));
      await act(() => result.current.choose("antigravity-session"));
      expect(result.current.canStop).toBe(true);
      await act(() => result.current.control("stop"));
      expect(request).toHaveBeenCalledWith(
        "stop",
        expect.objectContaining({
          sessionId: "antigravity-session",
          bootId: "boot",
          expectedRevision: 4,
          turnId: '"prompt-4"',
        }),
      );
    },
  );
});
