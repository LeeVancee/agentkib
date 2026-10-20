import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@agentkib/web-client";
import {
  pendingScope,
  rememberPending,
  readPending,
} from "@/features/conversation/features/sessions/pending-controls";
import { ManagedTasks } from "@/features/conversation/features/sessions/managed-tasks";
import { publishSessionInvalidation } from "@/features/conversation/features/sessions/session-events";
import type { WebClient } from "@agentkib/web-client";

const navigate = vi.fn();
let session: {
  client: {
    request: ReturnType<typeof vi.fn>;
    receipt: ReturnType<typeof vi.fn>;
    managedInspect: ReturnType<typeof vi.fn>;
  };
  origin: string;
  access: {
    protocolVersion: number;
    status: string;
    bootId: string;
    experimentalEnabled: boolean;
    device: { id: string; manage: boolean; send: boolean };
  };
  current: { id: string; agent: string };
  live: {
    sessionId: string;
    executionMode: string;
    status?: string;
    revision?: number;
    reason?: string;
  };
  capabilities: { sessionId: string; features: { adopt: { available: boolean } } };
  online: boolean;
  controlReady: boolean;
  busy: boolean;
  selected: string;
  refresh: ReturnType<typeof vi.fn>;
  locale: string;
};
vi.mock("@/features/conversation/features/sessions/session-context", () => ({
  useSession: () => session,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("@/features/conversation/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));
const options = { available: true, workspaces: [{ id: "workspace", name: "Project" }], models: [] };
const mutations = () =>
  session.client.request.mock.calls.filter(([path]) => !path.startsWith("managed/options"));
describe("ManagedTasks", () => {
  beforeEach(() => {
    navigate.mockReset();
    sessionStorage.clear();
    session = {
      origin: "",
      client: {
        receipt: vi.fn(async (requestId: string) => ({ found: false, requestId })),
        managedInspect: vi.fn(async (sessionId: string) => ({
          sessionId,
          handoffFingerprint: "verified-history",
        })),
        request: vi.fn(async (path: string) =>
          path.startsWith("managed/options")
            ? options
            : { sessionId: "new-session", reconciled: true },
        ),
      },
      access: {
        status: "approved",
        protocolVersion: 2,
        bootId: "boot",
        experimentalEnabled: true,
        device: { id: "browser", manage: true, send: true },
      },
      current: { id: "original-session", agent: "codex" },
      live: {
        sessionId: "original-session",
        executionMode: "external",
        status: "idle",
        reason: "handoff-required",
      },
      capabilities: { sessionId: "original-session", features: { adopt: { available: true } } },
      online: true,
      controlReady: true,
      busy: false,
      selected: "original-session",
      refresh: vi.fn().mockResolvedValue(undefined),
      locale: "en-US",
    };
  });
  afterEach(cleanup);
  async function show(create = false) {
    const view = render(<ManagedTasks create={create} />);
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    await screen.findByRole("button", { name: "Create" });
    return view;
  }

  it.each([
    ["zh-CN", "新建任务"],
    ["zh-TW", "新增任務"],
    ["en-US", "New task"],
    ["ja-JP", "タスクを作成"],
  ])("keeps the create trigger at touch size in %s", (locale, label) => {
    session.locale = locale;
    render(<ManagedTasks create />);
    expect(screen.getByRole("button", { name: label })).toHaveClass("min-h-11");
    expect(mutations()).toHaveLength(0);
  });

  it.each(["external", "codex-managed", "claude-managed", "claude-follower"])(
    "hides Codex ownership controls and their obsolete options lookup (%s)",
    (executionMode) => {
      session.live.executionMode = executionMode;
      if (executionMode.startsWith("claude")) session.current.agent = "claude-code";
      render(<ManagedTasks initialOpen />);
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
      expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
      expect(session.client.request).not.toHaveBeenCalled();
    },
  );

  it.each(["adopt", "release", "reconcile"] as const)(
    "keeps a saved Codex %s fenced and checks its receipt while the operations panel is hidden",
    async (kind) => {
      const requestId = crypto.randomUUID();
      const scope = pendingScope("", "browser");
      rememberPending(scope, { requestId, sessionId: "original-session", kind });
      session.client.receipt.mockResolvedValue({ found: true, requestId, status: "unknown" });
      const panel = (active: boolean) => (
        <ManagedTasks
          active={active}
          renderContent={(content) => (active ? <div role="group">{content}</div> : null)}
        />
      );
      const view = render(panel(false));
      await waitFor(() => expect(session.client.receipt).toHaveBeenCalledWith(requestId));
      expect(readPending(scope)).toHaveLength(1);
      view.rerender(panel(true));
      expect(screen.getByText(/The previous outcome is unconfirmed/)).toBeInTheDocument();
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
      expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
      expect(mutations()).toEqual([]);

      view.rerender(panel(false));
      session.client.receipt.mockResolvedValue({
        found: true,
        requestId,
        sessionId: "original-session",
        operation: kind,
        status: "accepted",
      });
      act(() =>
        publishSessionInvalidation(session.client as unknown as WebClient, "original-session", [
          "receipts",
        ]),
      );
      await waitFor(() => expect(readPending(scope)).toEqual([]));
      expect(session.refresh).toHaveBeenCalledWith(true);
      expect(session.client.request).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
    },
  );

  it("creates Claude tasks through the shared management entry without Codex model fields", async () => {
    await show(true);
    fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "claude-code" } });
    await waitFor(() =>
      expect(session.client.request).toHaveBeenCalledWith(
        "managed/options?agent=claude-code",
        undefined,
        expect.any(AbortSignal),
      ),
    );
    expect(screen.queryByLabelText("Model")).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Create" }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(mutations()).toEqual([
      [
        "managed/create",
        {
          agent: "claude-code",
          bootId: "boot",
          requestId: expect.any(String),
          workspaceId: "workspace",
        },
      ],
    ]);
  });
  it.each(["permission", "experimental", "agent"])(
    "hides execution management when %s is unavailable",
    (reason) => {
      session.current.agent = "claude-code";
      if (reason === "permission") session.access.device.manage = false;
      if (reason === "experimental") session.access.experimentalEnabled = false;
      if (reason === "agent") session.current.agent = "claude";
      render(<ManagedTasks />);
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
      expect(session.client.request).not.toHaveBeenCalled();
    },
  );
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
  it("rechecks an unknown creation when settlement arrives during its receipt read", async () => {
    const requestId = crypto.randomUUID();
    const scope = pendingScope("", "browser");
    rememberPending(scope, { requestId, kind: "create", workspaceId: "workspace" });
    session.selected = "";
    let finish!: (result: unknown) => void;
    session.client.receipt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    session.client.receipt.mockResolvedValue({
      found: true,
      requestId,
      sessionId: "created-session",
      operation: "create",
      status: "accepted",
    });
    await show(true);
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    await act(async () => {
      publishSessionInvalidation(session.client as unknown as WebClient, "", ["receipts"]);
      finish({ found: true, requestId, operation: "create", status: "unknown" });
    });
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/sessions/$sessionId",
        params: { sessionId: "created-session" },
      }),
    );
    expect(session.client.receipt).toHaveBeenCalledTimes(2);
    expect(readPending(scope)).toEqual([]);
    expect(mutations()).toEqual([]);
  });
  it("starts a new receipt read after runtime restart and ignores the old runtime response", async () => {
    const requestId = crypto.randomUUID();
    const scope = pendingScope("", "browser");
    rememberPending(scope, { requestId, kind: "create", workspaceId: "workspace" });
    session.selected = "";
    let finishOld!: (result: unknown) => void;
    session.client.receipt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    );
    session.client.receipt.mockResolvedValue({
      found: true,
      requestId,
      sessionId: "created-session",
      operation: "create",
      status: "accepted",
    });
    const view = await show(true);
    expect(session.client.receipt).toHaveBeenCalledOnce();
    session.access = { ...session.access, bootId: "new-boot" };
    view.rerender(<ManagedTasks create />);
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/sessions/$sessionId",
        params: { sessionId: "created-session" },
      }),
    );
    expect(session.client.receipt).toHaveBeenCalledTimes(2);
    await act(async () => {
      finishOld({
        found: true,
        requestId,
        sessionId: "obsolete-session",
        operation: "create",
        status: "accepted",
      });
    });
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(readPending(scope)).toEqual([]);
    expect(mutations()).toEqual([]);
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
    session.access = { ...session.access, device: { id: "browser", manage: false, send: false } };
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
      if (kind === "create") await show(true);
      else render(<ManagedTasks />);
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
  it("reconciles creation after a runtime restart while the original transport was still pending", async () => {
    let reject!: (error: Error) => void;
    session.client.request.mockImplementation((path: string) =>
      path.startsWith("managed/options")
        ? Promise.resolve(options)
        : new Promise((_resolve, fail) => {
            reject = fail;
          }),
    );
    const view = await show(true);
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    const requestId = mutations()[0][1].requestId;
    session.access = { ...session.access, bootId: "new-boot" };
    view.rerender(<ManagedTasks create />);
    session.client.receipt.mockResolvedValue({
      found: true,
      requestId,
      sessionId: "created-session",
      operation: "create",
      status: "accepted",
    });
    await act(async () => reject(new ApiError(503, "runtime_timeout", "unknown")));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledExactlyOnceWith({
        to: "/sessions/$sessionId",
        params: { sessionId: "created-session" },
      }),
    );
    expect(mutations()).toHaveLength(1);
    expect(readPending(pendingScope("", "browser"))).toEqual([]);
  });
});
