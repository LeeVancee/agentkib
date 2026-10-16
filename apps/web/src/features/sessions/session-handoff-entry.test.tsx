// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionReader } from "@/features/conversation/features/sessions/session-reader";
import { SessionPanelsContext } from "@/features/conversation/features/sessions/session-panels";
import { codexCopy } from "@/features/conversation/features/sessions/codex-copy";
import type { SessionController } from "@/features/conversation/features/sessions/use-session-controller";
import { dictionaries } from "@/features/conversation/i18n";
const words = dictionaries["en-US"];

let session: SessionController;
vi.mock("@/features/conversation/features/sessions/session-context", () => ({
  useSession: () => session,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/features/conversation/features/sessions/session-composer", () => ({
  SessionComposer: () => <p>Existing composer</p>,
}));
vi.mock("@/features/conversation/features/sessions/artifact-browser", () => ({
  ArtifactBrowser: () => null,
}));
vi.mock("@/features/conversation/components/dialog", () => ({
  Dialog: ({ title, children }: { title: string; children: ReactNode }) => (
    <section role="dialog" aria-label={title}>
      {children}
    </section>
  ),
}));
function View() {
  const [actionsOpen, setActionsOpen] = useState(false);
  return (
    <SessionPanelsContext
      value={{ filesOpen: false, setFilesOpen: vi.fn(), actionsOpen, setActionsOpen }}
    >
      <SessionReader />
    </SessionPanelsContext>
  );
}
const request = vi.fn(async (path: string) =>
  path.startsWith("managed/options")
    ? { available: true, workspaces: [], models: [] }
    : { sessionId: "session", reconciled: true },
);
beforeEach(() => {
  sessionStorage.clear();
  request.mockClear();
  session = {
    locale: "en-US",
    t: words,
    selected: "session",
    current: {
      id: "session",
      agent: "codex",
      title: "Native source",
      availability: "readable",
      archived: false,
      origin: "interactive",
    },
    access: {
      status: "approved",
      protocolVersion: 2,
      bootId: "boot",
      experimentalEnabled: true,
      device: { id: "device", name: "Device", send: true, manage: true },
    },
    live: {
      sessionId: "session",
      executionMode: "codex-follower",
      status: "idle",
      reason: "handoff-required",
      revision: 1,
      approvals: [],
      questions: [],
      sendEnabled: false,
    },
    capabilities: {
      sessionId: "session",
      status: "idle",
      executionMode: "codex-follower",
      features: {
        resume: { available: true },
        adopt: { available: false },
        send: { available: false, reason: "handoff-required" },
      },
    },
    canSend: false,
    busy: false,
    online: true,
    controlReady: true,
    page: { events: [], warnings: [] },
    liveContentVersion: 0,
    scroll: { current: null },
    client: { request, codexQueue: vi.fn(async () => ({ sessionId: "session", data: [] })) },
    refresh: vi.fn(async () => {}),
    codexAction: vi.fn(async () => ({ accepted: true })),
    setModal: vi.fn(),
  } as unknown as SessionController;
});
afterEach(cleanup);
describe("reader handoff entries", () => {
  it("opens the actual native resume review expanded, requiring its original confirmation before dispatch", async () => {
    render(<View />);
    expect(screen.getByText("Resume required")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: codexCopy["en-US"].resume }));
    const dialog = await screen.findByRole("dialog", { name: "Session actions" });
    const confirmation = within(dialog).getByLabelText(codexCopy["en-US"].handoff);
    expect(confirmation.closest("details")).toHaveAttribute("open");
    const resume = within(dialog).getByRole("button", { name: codexCopy["en-US"].resume });
    expect(resume).toBeDisabled();
    fireEvent.click(resume);
    expect(session.codexAction).not.toHaveBeenCalled();
    fireEvent.click(confirmation);
    expect(resume).toBeEnabled();
    fireEvent.click(resume);
    await waitFor(() =>
      expect(session.codexAction).toHaveBeenCalledExactlyOnceWith("resume", {
        handoffConfirmed: true,
      }),
    );
    expect(request.mock.calls.some(([path]) => path === "managed/adopt")).toBe(false);
    expect(session.canSend).toBe(false);
  });
  it("opens the real managed Codex handoff review without treating entry as confirmation or dispatch", async () => {
    session.capabilities!.features.resume = { available: false };
    session.capabilities!.features.adopt = { available: true };
    render(<View />);
    expect(screen.getByText("Handoff required")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Hand over to AgentKib" }));
    const dialog = await screen.findByRole("dialog", { name: "Session actions" });
    const handoff = await within(dialog).findByRole("button", { name: "Hand over to AgentKib" });
    expect(handoff).toBeDisabled();
    expect(request.mock.calls.some(([path]) => path === "managed/adopt")).toBe(false);
    const confirmation = within(dialog).getByLabelText(/I have stopped the turn/);
    fireEvent.click(confirmation);
    await waitFor(() => expect(handoff).toBeEnabled());
    fireEvent.click(handoff);
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "managed/adopt",
        expect.objectContaining({ sessionId: "session", handoffConfirmed: true }),
      ),
    );
    expect(session.codexAction).not.toHaveBeenCalled();
    expect(session.canSend).toBe(false);
  });
  it.each([
    "metadata",
    "remote",
    "unsupported",
    "permission",
    "verification",
    "uncertain",
    "compacting",
  ] as const)("does not add a misleading native resume shortcut for %s", (blocked) => {
    if (blocked === "metadata") session.current!.availability = "metadata-only";
    if (blocked === "remote") Object.assign(session.current!, { remote: { host_id: "remote" } });
    if (blocked === "unsupported") session.live!.status = "unsupported";
    if (blocked === "permission") session.access!.device!.send = false;
    if (blocked === "verification") session.capabilities!.sessionId = "previous";
    if (blocked === "uncertain") session.notice = "uncertain";
    if (blocked === "compacting") session.live!.activity = "compacting";
    render(<View />);
    expect(
      screen.queryByRole("button", { name: codexCopy["en-US"].resume }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Hand over to AgentKib" })).not.toBeInTheDocument();
    expect(session.codexAction).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
  it("leaves Claude's existing strictly gated composer entry in place without adding a duplicate reader shortcut", () => {
    session.current!.agent = "claude-code";
    session.capabilities!.features.adopt = { available: true };
    session.capabilities!.features.resume = { available: false };
    render(<View />);
    expect(screen.getByText("Existing composer")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Hand over to AgentKib" })).not.toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
  });
});
