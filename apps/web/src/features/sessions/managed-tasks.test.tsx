import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@agentkib/web-client";
import { pendingScope, rememberPending, readPending } from "./pending-controls";
import { ManagedTasks } from "./managed-tasks";

const navigate = vi.fn();
let session: {
  client: { request: ReturnType<typeof vi.fn>; receipt: ReturnType<typeof vi.fn> };
  origin: string;
  access: {
    status: string;
    bootId: string;
    experimentalEnabled: boolean;
    device: { id: string; manage: boolean };
  };
  current: { agent: string };
  live: { executionMode: string; status?: string; revision?: number };
  selected: string;
  refresh: ReturnType<typeof vi.fn>;
  locale: string;
};
vi.mock("./session-context", () => ({ useSession: () => session }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));
const options = { available: true, workspaces: [{ id: "workspace", name: "Project" }], models: [] };
const mutations = () =>
  session.client.request.mock.calls.filter(([path]) => path !== "managed/options");
describe("ManagedTasks", () => {
  beforeEach(() => {
    navigate.mockReset();
    sessionStorage.clear();
    session = {
      origin: "",
      client: {
        receipt: vi.fn(async (requestId: string) => ({ found: false, requestId })),
        request: vi.fn(async (path: string) =>
          path === "managed/options" ? options : { sessionId: "new-session", reconciled: true },
        ),
      },
      access: {
        status: "approved",
        bootId: "boot",
        experimentalEnabled: true,
        device: { id: "browser", manage: true },
      },
      current: { agent: "codex" },
      live: { executionMode: "external" },
      selected: "original-session",
      refresh: vi.fn().mockResolvedValue(undefined),
      locale: "en-US",
    };
  });
  afterEach(cleanup);
  async function show(create = false) {
    const view = render(<ManagedTasks create={create} />);
    fireEvent.click(screen.getByRole("button", { name: create ? "New task" : "Execution" }));
    await screen.findByRole("button", { name: create ? "Create" : /Hand over|Release to/ });
    return view;
  }
  it.each(["permission", "experimental", "agent"])(
    "hides execution management when %s is unavailable",
    (reason) => {
      if (reason === "permission") session.access.device.manage = false;
      if (reason === "experimental") session.access.experimentalEnabled = false;
      if (reason === "agent") session.current.agent = "claude";
      render(<ManagedTasks />);
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
      expect(session.client.request).not.toHaveBeenCalled();
    },
  );
  it("requires an explicit handoff confirmation and keeps the existing session id", async () => {
    await show();
    const handoff = screen.getByRole("button", { name: "Hand over to AgentKib" });
    expect(handoff).toBeDisabled();
    fireEvent.click(handoff);
    expect(mutations()).toHaveLength(0);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(handoff);
    await waitFor(() => expect(session.refresh).toHaveBeenCalledWith(true));
    expect(mutations()).toEqual([
      [
        "managed/adopt",
        expect.objectContaining({
          bootId: "boot",
          sessionId: "original-session",
          handoffConfirmed: true,
          requestId: expect.any(String),
        }),
      ],
    ]);
    expect(navigate).not.toHaveBeenCalled();
  });
  it("does not dispatch creation without an authorized workspace", async () => {
    session.client.request.mockResolvedValue({ ...options, workspaces: [] });
    await show(true);
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    expect(mutations()).toHaveLength(0);
  });
  it("dispatches only once while creation is pending and navigates after confirmed success", async () => {
    let finish!: (value: { sessionId: string }) => void;
    session.client.request.mockImplementation((path: string) =>
      path === "managed/options"
        ? Promise.resolve(options)
        : new Promise((resolve) => {
            finish = resolve;
          }),
    );
    await show(true);
    const create = screen.getByRole("button", { name: "Create" });
    fireEvent.click(create);
    fireEvent.click(create);
    expect(mutations()).toHaveLength(1);
    expect(create).toBeDisabled();
    expect(navigate).not.toHaveBeenCalled();
    await act(async () => {
      finish({ sessionId: "new-session" });
    });
    expect(navigate).toHaveBeenCalledWith({
      to: "/sessions/$sessionId",
      params: { sessionId: "new-session" },
    });
  });
  it("keeps a failed reconciliation open without claiming success or replaying a command", async () => {
    session.live.executionMode = "codex-managed";
    session.client.request.mockImplementation(async (path: string) =>
      path === "managed/options" ? options : { reconciled: false },
    );
    await show();
    fireEvent.click(screen.getByRole("button", { name: "Verify previous outcome" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("still unknown");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(mutations()).toHaveLength(1);
    expect(mutations()[0][0]).toBe("managed/reconcile");
    expect(session.refresh).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
  it("blocks repeated creation after an unknown dispatched outcome", async () => {
    session.client.request.mockImplementation(async (path: string) => {
      if (path === "managed/options") return options;
      throw new ApiError(503, "runtime_timeout", "unknown");
    });
    await show(true);
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(mutations()).toHaveLength(1);
    expect(navigate).not.toHaveBeenCalled();
    expect(session.refresh).not.toHaveBeenCalled();
  });
  it("reconciles a late unknown handoff while its panel is closed and blocks replay after reopening", async () => {
    let fail!: (error: Error) => void;
    let receipt!: (result: unknown) => void;
    session.client.request.mockImplementation((path: string) =>
      path === "managed/options"
        ? Promise.resolve(options)
        : new Promise((_resolve, reject) => {
            fail = reject;
          }),
    );
    session.client.receipt.mockImplementation(
      () =>
        new Promise((resolve) => {
          receipt = resolve;
        }),
    );
    const panel = (active: boolean) => (
      <ManagedTasks
        active={active}
        renderContent={(content) => (active ? <div role="dialog">{content}</div> : null)}
      />
    );
    const view = render(panel(true));
    await screen.findByRole("button", { name: "Hand over to AgentKib" });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Hand over to AgentKib" }));
    const requestId = mutations()[0][1].requestId;
    view.rerender(panel(false));
    await act(async () => {
      fail(new ApiError(503, "runtime_timeout", "unknown"));
    });
    await waitFor(() => expect(session.client.receipt).toHaveBeenCalledWith(requestId));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(readPending(pendingScope("", "browser"))).toHaveLength(1);
    view.rerender(panel(true));
    const handoff = await screen.findByRole("button", { name: "Hand over to AgentKib" });
    fireEvent.click(screen.getByRole("checkbox"));
    expect(handoff).toBeDisabled();
    fireEvent.click(handoff);
    expect(mutations()).toHaveLength(1);
    expect(screen.getByText(/A previous result is unknown/)).toBeInTheDocument();
    view.rerender(panel(false));
    await act(async () => {
      receipt({
        found: true,
        requestId,
        sessionId: "original-session",
        operation: "adopt",
        status: "accepted",
      });
    });
    expect(readPending(pendingScope("", "browser"))).toEqual([]);
    expect(session.refresh).toHaveBeenCalledWith(true);
    expect(mutations()).toHaveLength(1);
    expect(navigate).not.toHaveBeenCalled();
  });
  it("ignores a late successful creation after management permission is revoked", async () => {
    let finish!: (value: { sessionId: string }) => void;
    session.client.request.mockImplementation((path: string) =>
      path === "managed/options"
        ? Promise.resolve(options)
        : new Promise((resolve) => {
            finish = resolve;
          }),
    );
    const view = await show(true);
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    session.access = { ...session.access, device: { id: "browser", manage: false } };
    view.rerender(<ManagedTasks create />);
    await act(async () => {
      finish({ sessionId: "late-session" });
    });
    expect(navigate).not.toHaveBeenCalled();
    expect(session.refresh).not.toHaveBeenCalled();
  });
  it("does not navigate back after leaving the page during task creation", async () => {
    let finish!: (value: { sessionId: string }) => void;
    session.client.request.mockImplementation((path: string) =>
      path === "managed/options"
        ? Promise.resolve(options)
        : new Promise((resolve) => {
            finish = resolve;
          }),
    );
    const view = await show(true);
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    view.unmount();
    await act(async () => {
      finish({ sessionId: "late-session" });
    });
    expect(navigate).not.toHaveBeenCalled();
    expect(session.refresh).not.toHaveBeenCalled();
  });
  it("restores unknown creation after remount without a manual override or another create", async () => {
    const requestId = crypto.randomUUID();
    const scope = pendingScope("", "browser");
    rememberPending(scope, { requestId, workspaceId: "workspace", kind: "create" });
    await show(true);
    await waitFor(() => expect(session.client.receipt).toHaveBeenCalledWith(requestId));
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /allow a new operation/ })).not.toBeInTheDocument();
    expect(mutations()).toHaveLength(0);
    expect(readPending(scope)).toHaveLength(1);
  });
  it.each(["create", "adopt", "release", "reconcile"] as const)(
    "recovers a legacy prepared %s without replaying it or requiring a session id",
    async (kind) => {
      const requestId = crypto.randomUUID();
      const scope = pendingScope("", "browser");
      rememberPending(scope, {
        requestId,
        workspaceId: "workspace",
        ...(kind === "create" ? {} : { sessionId: "original-session" }),
        kind,
      });
      session.client.receipt.mockResolvedValue({
        found: true,
        requestId,
        status: "not-dispatched",
        recovery: "legacy-prepared",
        completionObserved: false,
      });
      await show(kind === "create");
      await waitFor(() => expect(readPending(scope)).toEqual([]));
      expect(mutations()).toHaveLength(0);
      expect(navigate).not.toHaveBeenCalled();
      expect(session.refresh).toHaveBeenCalledWith(true);
    },
  );
  it.each(["unknown", "accepted", "wrong-request", "wrong-marker", "completed"])(
    "retains legacy creation pending when the proof is %s",
    async (invalid) => {
      const requestId = crypto.randomUUID();
      const scope = pendingScope("", "browser");
      rememberPending(scope, { requestId, workspaceId: "workspace", kind: "create" });
      session.client.receipt.mockResolvedValue({
        found: true,
        requestId: invalid === "wrong-request" ? crypto.randomUUID() : requestId,
        status: ["unknown", "accepted"].includes(invalid) ? invalid : "not-dispatched",
        recovery: invalid === "wrong-marker" ? "other" : "legacy-prepared",
        completionObserved: invalid === "completed",
      });
      await show(true);
      await waitFor(() => expect(session.client.receipt).toHaveBeenCalledWith(requestId));
      expect(readPending(scope)).toHaveLength(1);
      expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
      expect(mutations()).toHaveLength(0);
      expect(navigate).not.toHaveBeenCalled();
    },
  );
  it("finds an accepted creation by durable receipt and navigates without creating again", async () => {
    const requestId = crypto.randomUUID();
    const scope = pendingScope("", "browser");
    rememberPending(scope, { requestId, workspaceId: "workspace", kind: "create" });
    session.client.receipt.mockResolvedValue({
      found: true,
      requestId,
      sessionId: "recovered-session",
      operation: "create",
      status: "accepted",
      ack: { sessionId: "recovered-session" },
    });
    render(<ManagedTasks create />);
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/sessions/$sessionId",
        params: { sessionId: "recovered-session" },
      }),
    );
    expect(mutations()).toHaveLength(0);
    expect(readPending(scope)).toEqual([]);
  });
});
