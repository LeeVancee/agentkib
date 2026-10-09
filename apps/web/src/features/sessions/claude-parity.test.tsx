import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WebClient,
  type Access,
  type Live,
  type SessionQueue,
  type SessionSettings,
} from "@agentkib/web-client";
import { WebApplication } from "@/router";
import { codexCopy } from "@agentkib/conversation-ui/features/sessions/codex-copy";
import { composerLayoutCopy } from "@agentkib/conversation-ui/features/sessions/composer-layout-copy";
import { webLayoutCopy } from "@agentkib/conversation-ui/features/sessions/web-layout-copy";

// Exercise the real provider, controller and WebClient against the public API,
// including revision fencing and the follow-up reads after an accepted mutation.
class ClaudeEventSource {
  static live: () => Live;
  static instances = new Set<ClaudeEventSource>();
  seq = 0;
  listeners: Record<string, (event: MessageEvent) => void> = {};
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  close() {
    this.closed = true;
    ClaudeEventSource.instances.delete(this);
  }
  constructor(path: string) {
    if (!new URL(path, "http://localhost").searchParams.has("sessionId")) return;
    ClaudeEventSource.instances.add(this);
    queueMicrotask(() => {
      if (this.closed) return;
      this.emit(ClaudeEventSource.live());
    });
  }
  emit(live: Live) {
    this.seq++;
    this.listeners["session-event"]?.(
      new MessageEvent("session-event", {
        data: JSON.stringify({
          protocolVersion: 2,
          subscriptionId: "claude-stream",
          sessionId: "session",
          runtimeBootId: "runtime",
          epoch: "claude",
          seq: this.seq,
          cursor: `claude-${this.seq}`,
          type: "snapshot",
          payload: { live },
        }),
      }),
    );
  }
  addEventListener(name: string, listener: (event: MessageEvent) => void) {
    this.listeners[name] = listener;
  }
}

const available = { available: true };
const unavailable = { available: false };
const copy = codexCopy["zh-CN"];
function createHost({ staleSettingsAfterMutation = false } = {}) {
  const settings: SessionSettings = {
    sessionId: "session",
    revision: 1,
    available: true,
    applicationStatus: "confirmed",
    current: { modelId: "host-model", effort: "medium", permissionMode: "default" },
    defaults: { modelId: "host-model", effort: "medium", permissionMode: "default" },
    writable: {
      model: available,
      effort: available,
      permissionMode: available,
      restoreDefaults: available,
      mode: unavailable,
      policy: unavailable,
      serviceTier: unavailable,
    },
    options: {
      models: [
        { id: "host-model", name: "Host Claude", efforts: ["medium", "high"], serviceTierIds: [] },
        { id: "second-model", name: "Second Claude", efforts: ["low", "high"], serviceTierIds: [] },
      ],
      policies: [],
      serviceTiers: [],
      permissionModes: [
        { id: "default", name: "默认权限" },
        { id: "plan", name: "计划权限" },
        { id: "acceptEdits", name: "允许编辑" },
      ],
    },
  };
  const access: Access = {
    status: "approved",
    protocolVersion: 2,
    csrfToken: "csrf",
    bootId: "boot",
    experimentalEnabled: true,
    device: {
      id: "browser",
      name: "Phone",
      accessMode: "full",
      send: true,
      approve: true,
      manage: true,
      advancedControl: true,
      organize: true,
      settings: true,
      files: true,
      attachments: true,
    },
  };
  const state = {
    settings,
    live: {
      sessionId: "session",
      status: "idle",
      revision: 1,
      executionMode: "claude-managed",
      sendEnabled: true,
      approvals: [],
      questions: [],
    } as Live,
    features: Object.fromEntries(
      [
        "settings",
        "settings-state",
        "goal",
        "goal-set",
        "goal-pause",
        "goal-resume",
        "goal-clear",
        "queue-list",
        "queue-add",
        "queue-update",
        "queue-delete",
        "queue-reorder",
        "queue-pause",
        "queue-resume",
        "context",
        "resources",
        "rename",
        "archive",
        "unarchive",
        "fork",
        "send",
        "inspect",
      ].map((key) => [key, available]),
    ),
    queue: {
      sessionId: "session",
      paused: true,
      requiresResume: true,
      data: [
        { id: "queued-1", text: "Queued follow-up", status: "pending" },
        { id: "queued-2", text: "Later work", status: "pending" },
      ],
    } as SessionQueue,
    goal: {
      sessionId: "session",
      revision: 1,
      available: true,
      goal: { objective: "Finish the task", status: "paused", tokensUsed: 10, tokenBudget: 1000 },
      actions: { set: available, pause: unavailable, resume: available, clear: available },
    },
    mutations: [] as Record<string, unknown>[],
  };
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const path = url.pathname.replace("/api/web/v1/", "");
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      state.mutations.push({ path, ...body });
      if (body.operation === "settings" && !staleSettingsAfterMutation) {
        const selected = { ...state.settings.selected };
        if (body.effort === null) delete selected.effort;
        state.settings = {
          ...state.settings,
          revision: state.settings.revision + 1,
          applicationStatus: "pending",
          selected: {
            ...selected,
            ...(typeof body.model === "string" ? { modelId: body.model } : {}),
            ...(typeof body.effort === "string" ? { effort: body.effort } : {}),
            ...(body.permissionMode
              ? { permissionMode: body.permissionMode as "acceptEdits" }
              : {}),
          },
        };
        state.live.revision = state.settings.revision;
      }
      if (body.operation === "queue-resume") {
        state.queue.paused = false;
        state.queue.requiresResume = false;
      }
      if (body.operation === "goal-resume") state.goal.goal.status = "active";
      if (body.operation === "queue-update") state.queue.data[0]!.text = String(body.text);
      return Response.json({ accepted: true, sessionId: "session" });
    }
    if (path === "access") return Response.json(access);
    if (path === "catalog")
      return Response.json({
        indexEnabled: true,
        workspaces: [{ id: "workspace", name: "Project", path: "/project" }],
        sessions: [
          {
            id: "session",
            workspace_id: "workspace",
            agent: "claude-code",
            title: "Claude parity session",
            availability: "readable",
            archived: false,
            sidechain: false,
          },
        ],
      });
    if (path === "events")
      return Response.json({
        events: [
          {
            id: "reply",
            kind: "agent-message",
            content: "Claude history",
            attachment_count: 0,
            truncated: false,
          },
        ],
        warnings: [],
      });
    if (path === "live") return Response.json(state.live);
    if (path === "managed/capabilities")
      return Response.json({ sessionId: "session", features: state.features });
    if (path === "managed/settings") return Response.json(state.settings);
    if (path === "managed/inspect")
      return Response.json({ sessionId: "session", handoffFingerprint: "verified-history" });
    if (path === "managed/queue") return Response.json(state.queue);
    if (path === "managed/goals") return Response.json(state.goal);
    if (path === "managed/options")
      return Response.json({
        available: true,
        workspaces: [{ id: "workspace", name: "Project" }],
        models: settings.options.models,
      });
    if (path === "managed/resources")
      return Response.json({
        sessionId: "session",
        revision: 1,
        resources: [{ id: "scoped-file", kind: "file", name: "notes.md", available: true }],
      });
    if (path.startsWith("requests/"))
      return Response.json({ found: false, requestId: path.split("/").at(-1) });
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("EventSource", ClaudeEventSource);
  ClaudeEventSource.live = () => state.live;
  return { state, fetcher };
}
async function openSession() {
  render(<WebApplication />);
  fireEvent.click(await screen.findByRole("button", { name: /Claude parity session/ }));
  await screen.findByText("Claude history");
  await waitFor(() => expect(screen.getByRole("button", { name: "会话操作" })).toBeEnabled());
}
beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal("scrollTo", vi.fn());
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Claude Remote parity", () => {
  it("does not confirm an effort clear against the pre-request settings revision", async () => {
    const host = createHost({ staleSettingsAfterMutation: true });
    host.state.settings.selected = {};
    await openSession();
    fireEvent.click(await screen.findByRole("button", { name: /Host Claude/ }));
    fireEvent.change(screen.getByLabelText(copy.effort), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: copy.apply }));
    await waitFor(() => expect(host.state.mutations).toHaveLength(1));
    await waitFor(() =>
      expect(
        host.fetcher.mock.calls.filter(([url]) => String(url).includes("/managed/settings?"))
          .length,
      ).toBeGreaterThan(1),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: copy.restoreDefaults })).toBeEnabled(),
    );
    expect(screen.queryByText(copy.settingsSaved)).not.toBeInTheDocument();
    host.state.settings = { ...host.state.settings, revision: 2 };
    host.state.live.revision = 2;
    act(() => {
      for (const source of ClaudeEventSource.instances)
        source.emit({ ...host.state.live, settings: host.state.settings });
    });
    await screen.findByText(copy.settingsSaved);
  });

  it("does not send Claude effort clearing semantics through the Codex API", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new WebClient(fetcher);
    const body = {
      sessionId: "session",
      requestId: "request",
      bootId: "boot",
      expectedRevision: 1,
      effort: null,
    };
    await expect(client.codexAction("settings", body)).rejects.toMatchObject({
      status: 400,
      code: "invalid_effort",
      controlOutcome: "not-dispatched",
    });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(client.sessionAction("settings", body, "codex")).rejects.toMatchObject({
      status: 400,
      code: "invalid_effort",
      controlOutcome: "not-dispatched",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([undefined, "low"])(
    "replaces an incompatible effort with the new model default %s",
    async (defaultEffort) => {
      const host = createHost();
      host.state.settings.selected = { effort: "high", permissionMode: "plan" };
      host.state.settings.current.effort = "high";
      host.state.settings.current.permissionMode = "plan";
      host.state.settings.options.models[1]!.efforts = ["low"];
      host.state.settings.options.models[1]!.defaultEffort = defaultEffort;
      await openSession();
      fireEvent.click(await screen.findByRole("button", { name: /Host Claude/ }));
      fireEvent.change(screen.getByLabelText(copy.model), { target: { value: "second-model" } });
      fireEvent.click(screen.getByRole("button", { name: copy.apply }));
      await waitFor(() => expect(host.state.mutations).toHaveLength(1));
      expect(host.state.mutations[0]).toMatchObject({
        operation: "settings",
        model: "second-model",
        effort: defaultEffort ?? null,
      });
      expect(host.state.mutations[0]).not.toHaveProperty("permissionMode");
    },
  );

  it("clears only the effort override and waits for native confirmation of its default", async () => {
    const host = createHost();
    host.state.settings.selected = { effort: "high", permissionMode: "plan" };
    host.state.settings.current.effort = "high";
    host.state.settings.current.permissionMode = "plan";
    await openSession();
    fireEvent.click(await screen.findByRole("button", { name: /Host Claude/ }));
    fireEvent.change(screen.getByLabelText(copy.effort), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: copy.apply }));
    await waitFor(() => expect(host.state.mutations).toHaveLength(1));
    expect(host.state.mutations[0]).toMatchObject({ operation: "settings", effort: null });
    expect(host.state.mutations[0]).not.toHaveProperty("model");
    expect(host.state.mutations[0]).not.toHaveProperty("permissionMode");
    await screen.findByText(composerLayoutCopy["zh-CN"].settingsPending);
    expect(screen.queryByText(copy.settingsSaved)).not.toBeInTheDocument();
    host.state.settings = {
      ...host.state.settings,
      applicationStatus: "confirmed",
      current: { ...host.state.settings.current, effort: "medium" },
    };
    act(() => {
      for (const source of ClaudeEventSource.instances)
        source.emit({ ...host.state.live, settings: host.state.settings });
    });
    await screen.findByText(copy.settingsSaved);
    expect(host.state.settings.selected?.effort).toBeUndefined();
    expect(host.state.settings.selected?.permissionMode).toBe("plan");
  });

  it("uses a resolved inherited model to show its effort options without selecting a model override", async () => {
    const host = createHost();
    host.state.settings.selected = {};
    host.state.settings.current.modelId = "claude-sonnet-fixture";
    Object.assign(host.state.settings.options.models[0]!, {
      id: "sonnet",
      resolvedModel: "claude-sonnet-fixture",
    });
    await openSession();
    fireEvent.click(await screen.findByRole("button", { name: /Host Claude/ }));
    expect(screen.getByLabelText(copy.model)).toHaveValue("sonnet");
    fireEvent.change(screen.getByLabelText(copy.effort), { target: { value: "high" } });
    fireEvent.click(screen.getByRole("button", { name: copy.apply }));
    await waitFor(() => expect(host.state.mutations).toHaveLength(1));
    expect(host.state.mutations[0]).toMatchObject({ operation: "settings", effort: "high" });
    expect(host.state.mutations[0]).not.toHaveProperty("model");
  });

  it("confirms the selected alias when multiple aliases resolve to the same native model", async () => {
    const host = createHost();
    Object.assign(host.state.settings.options.models[1]!, {
      id: "sonnet",
      resolvedModel: "claude-sonnet-fixture",
      efforts: ["medium", "high"],
    });
    host.state.settings.options.models.unshift({
      id: "default",
      name: "Default Claude",
      resolvedModel: "claude-sonnet-fixture",
      efforts: ["medium", "high"],
      serviceTierIds: [],
    });
    await openSession();
    fireEvent.click(await screen.findByRole("button", { name: /Host Claude/ }));
    fireEvent.change(screen.getByLabelText(copy.model), { target: { value: "sonnet" } });
    fireEvent.click(screen.getByRole("button", { name: copy.apply }));
    await screen.findByText(composerLayoutCopy["zh-CN"].settingsPending);
    host.state.settings = {
      ...host.state.settings,
      applicationStatus: "confirmed",
      current: { ...host.state.settings.current, modelId: "claude-sonnet-fixture" },
    };
    act(() => {
      for (const source of ClaudeEventSource.instances)
        source.emit({ ...host.state.live, settings: host.state.settings });
    });
    await waitFor(() => {
      expect(screen.getByText(copy.settingsSaved)).toBeInTheDocument();
      const model = screen.getByLabelText(copy.model);
      expect(model).toBeEnabled();
      expect(model).toHaveValue("sonnet");
    });
    expect(host.state.mutations[0]).not.toHaveProperty("effort");
    expect(host.state.mutations[0]).not.toHaveProperty("permissionMode");
  });

  it.each([undefined, ""])(
    "does not confirm a selected model when native model identity is %s",
    async (modelId) => {
      const host = createHost();
      host.state.settings.options.models[1]!.efforts = ["medium", "high"];
      await openSession();
      fireEvent.click(await screen.findByRole("button", { name: /Host Claude/ }));
      fireEvent.change(screen.getByLabelText(copy.model), { target: { value: "second-model" } });
      fireEvent.click(screen.getByRole("button", { name: copy.apply }));
      await screen.findByText(composerLayoutCopy["zh-CN"].settingsPending);
      host.state.settings = {
        ...host.state.settings,
        applicationStatus: "confirmed",
        current: { ...host.state.settings.current, modelId },
      };
      act(() => {
        for (const source of ClaudeEventSource.instances)
          source.emit({ ...host.state.live, settings: host.state.settings });
      });
      expect(
        screen.queryByText(composerLayoutCopy["zh-CN"].settingsPending),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(copy.settingsSaved)).not.toBeInTheDocument();
    },
  );

  it.each(["default", "plan", "acceptEdits", undefined] as const)(
    "preserves inherited %s permission when only the model is changed",
    async (permissionMode) => {
      const host = createHost();
      host.state.settings.current.permissionMode = permissionMode;
      host.state.settings.selected = {};
      host.state.settings.defaults = {};
      host.state.settings.options.models[1]!.efforts = ["medium", "high"];
      await openSession();
      fireEvent.click(await screen.findByRole("button", { name: /Host Claude/ }));
      expect(screen.getByLabelText("工具权限")).toHaveValue(permissionMode ?? "");
      fireEvent.change(screen.getByLabelText(copy.model), { target: { value: "second-model" } });
      fireEvent.click(screen.getByRole("button", { name: copy.apply }));
      await waitFor(() => expect(host.state.mutations).toHaveLength(1));
      expect(host.state.mutations[0]).toMatchObject({
        path: "managed/action",
        operation: "settings",
        model: "second-model",
      });
      expect(host.state.mutations[0]).not.toHaveProperty("permissionMode");
      expect(host.state.mutations[0]).not.toHaveProperty("effort");
      expect(screen.getByLabelText("工具权限")).toHaveValue(permissionMode ?? "");
      expect(host.state.settings.current.permissionMode).toBe(permissionMode);
    },
  );

  it("does not resend a previously selected permission mode when editing effort", async () => {
    const host = createHost();
    host.state.settings.selected = { permissionMode: "plan" };
    host.state.settings.current.permissionMode = "plan";
    await openSession();
    fireEvent.click(await screen.findByRole("button", { name: /Host Claude/ }));
    fireEvent.change(screen.getByLabelText(copy.effort), { target: { value: "high" } });
    fireEvent.click(screen.getByRole("button", { name: copy.apply }));
    await waitFor(() => expect(host.state.mutations).toHaveLength(1));
    expect(host.state.mutations[0]).toMatchObject({ operation: "settings", effort: "high" });
    expect(host.state.mutations[0]).not.toHaveProperty("permissionMode");
    expect(host.state.mutations[0]).not.toHaveProperty("model");
  });

  it("clears submitted fields before the next settings edit", async () => {
    const host = createHost();
    await openSession();
    fireEvent.click(await screen.findByRole("button", { name: /Host Claude/ }));
    fireEvent.change(screen.getByLabelText("工具权限"), { target: { value: "plan" } });
    fireEvent.click(screen.getByRole("button", { name: copy.apply }));
    await waitFor(() => expect(host.state.settings.selected?.permissionMode).toBe("plan"));
    fireEvent.change(screen.getByLabelText(copy.effort), { target: { value: "high" } });
    await waitFor(() => expect(screen.getByRole("button", { name: copy.apply })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: copy.apply }));
    await waitFor(() => expect(host.state.mutations).toHaveLength(2));
    expect(host.state.mutations[1]).toMatchObject({ operation: "settings", effort: "high" });
    expect(host.state.mutations[1]).not.toHaveProperty("permissionMode");
    expect(host.state.mutations[1]).not.toHaveProperty("model");
  });

  it("applies discovered settings through the generic action and keeps the previous current settings pending", async () => {
    const host = createHost();
    await openSession();
    fireEvent.click(await screen.findByRole("button", { name: /Host Claude/ }));
    expect(screen.queryByLabelText(copy.executionPolicy)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(copy.serviceTier)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(copy.model), { target: { value: "second-model" } });
    fireEvent.change(screen.getByLabelText(copy.effort), { target: { value: "high" } });
    fireEvent.change(screen.getByLabelText("工具权限"), { target: { value: "acceptEdits" } });
    fireEvent.click(screen.getByRole("button", { name: copy.apply }));
    await waitFor(() => expect(host.state.mutations).toHaveLength(1));
    expect(host.state.mutations[0]).toMatchObject({
      path: "managed/action",
      operation: "settings",
      agent: "claude-code",
      model: "second-model",
      effort: "high",
      permissionMode: "acceptEdits",
      expectedRevision: 1,
    });
    expect(host.state.mutations[0]).not.toHaveProperty("policyId");
    expect(host.state.settings.current.modelId).toBe("host-model");
    await waitFor(() => expect(screen.getByLabelText(copy.model)).toHaveValue("second-model"));
    expect(screen.queryByText(copy.settingsSaved)).not.toBeInTheDocument();
    expect(host.fetcher.mock.calls.some(([url]) => String(url).includes("/codex/"))).toBe(false);
  });

  it("keeps recovered queues paused until an explicit resume and edits the queued item by ID", async () => {
    const host = createHost();
    await openSession();
    fireEvent.click(screen.getByRole("button", { name: "会话操作" }));
    await screen.findByText("Queued follow-up");
    expect(host.state.mutations).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "恢复队列" }));
    await waitFor(() =>
      expect(host.state.mutations[0]).toMatchObject({
        operation: "queue-resume",
        path: "managed/action",
        agent: "claude-code",
      }),
    );
    await screen.findByRole("button", { name: "暂停队列" });
    const edits = screen.getAllByRole("button", { name: copy.queueUpdate });
    await waitFor(() => expect(edits[0]).toBeEnabled());
    fireEvent.click(edits[0]!);
    fireEvent.change(screen.getByLabelText(copy.text), { target: { value: "Revised follow-up" } });
    fireEvent.click(screen.getAllByRole("button", { name: copy.queueUpdate })[0]!);
    await waitFor(() =>
      expect(host.state.mutations[1]).toMatchObject({
        operation: "queue-update",
        queuedSubmissionId: "queued-1",
        text: "Revised follow-up",
      }),
    );
    await screen.findByText("Revised follow-up");
  });

  it.each(["claimed", "dispatched", "unknown"] as const)(
    "keeps %s entries immutable and reorders only pending entries",
    async (status) => {
      const host = createHost();
      host.state.live = {
        ...host.state.live,
        status: "running",
        sendEnabled: false,
        stopEnabled: true,
        turnId: "native-turn",
      };
      host.state.queue = {
        sessionId: "session",
        paused: false,
        requiresResume: false,
        data: [
          { id: "active-work", text: "Active work", status },
          { id: "next-work", text: "Next work", status: "pending" },
          { id: "last-work", text: "Last work", status: "pending" },
        ],
      };
      await openSession();
      fireEvent.click(screen.getByRole("button", { name: "会话操作" }));
      await screen.findByText("Active work");
      const edits = screen.getAllByRole("button", { name: copy.queueUpdate });
      const deletes = screen.getAllByRole("button", { name: copy.queueDelete });
      expect(edits[0]).toBeDisabled();
      expect(deletes[0]).toBeDisabled();
      await waitFor(() => expect(edits[1]).toBeEnabled());
      expect(deletes[1]).toBeEnabled();
      fireEvent.click(edits[0]!);
      fireEvent.click(deletes[0]!);
      expect(host.state.mutations).toHaveLength(0);
      expect(screen.queryByLabelText(copy.text)).not.toBeInTheDocument();
      const reorder = screen.getByRole("button", { name: copy.queueUp });
      await waitFor(() => expect(reorder).toBeEnabled());
      fireEvent.click(reorder);
      await waitFor(() =>
        expect(host.state.mutations[0]).toMatchObject({
          path: "managed/action",
          operation: "queue-reorder",
          queuedSubmissionIds: ["last-work", "next-work"],
        }),
      );
    },
  );

  it.each(["paused", "budget-exhausted"])(
    "resumes a %s persistent goal only on user action",
    async (status) => {
      const host = createHost();
      host.state.goal.goal.status = status;
      await openSession();
      fireEvent.click(await screen.findByRole("button", { name: copy.goals }));
      expect(host.state.mutations).toHaveLength(0);
      fireEvent.click(
        screen.getByRole("button", {
          name: status === "paused" ? copy.goalResume : composerLayoutCopy["zh-CN"].tryResume,
        }),
      );
      await waitFor(() =>
        expect(host.state.mutations[0]).toMatchObject({
          operation: "goal-resume",
          path: "managed/action",
          agent: "claude-code",
          expectedRevision: 1,
        }),
      );
    },
  );

  it("sends selected scoped resources through the regular Claude send contract", async () => {
    const host = createHost();
    await openSession();
    fireEvent.click(await screen.findByRole("button", { name: copy.addContext }));
    const resource = await screen.findByRole("checkbox", { name: /notes.md/ });
    fireEvent.click(resource);
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    fireEvent.change(screen.getByRole("textbox", { name: "发送消息" }), {
      target: { value: "Read this file" },
    });
    const send = screen.getByRole("button", { name: "发送" });
    await waitFor(() => expect(send).toBeEnabled());
    fireEvent.click(send);
    await waitFor(() =>
      expect(host.state.mutations[0]).toMatchObject({
        path: "send",
        text: "Read this file",
        resourceIds: ["scoped-file"],
      }),
    );
  });

  it("renames Claude through the shared operations panel without a Codex request", async () => {
    const host = createHost();
    await openSession();
    fireEvent.click(screen.getByRole("button", { name: "会话操作" }));
    fireEvent.change(await screen.findByLabelText(copy.name), {
      target: { value: "Reviewed title" },
    });
    const rename = screen.getByRole("button", { name: copy.rename });
    await waitFor(() => expect(rename).toBeEnabled());
    fireEvent.click(rename);
    await waitFor(() =>
      expect(host.state.mutations[0]).toMatchObject({
        operation: "rename",
        name: "Reviewed title",
        agent: "claude-code",
        path: "managed/action",
      }),
    );
    expect(host.fetcher.mock.calls.some(([url]) => String(url).includes("/codex/"))).toBe(false);
  });

  it("does not read or mutate unsupported advanced Claude features", async () => {
    const host = createHost();
    host.state.features = {};
    await openSession();
    fireEvent.click(screen.getByRole("button", { name: "会话操作" }));
    await screen.findByRole("button", { name: copy.rename });
    expect(screen.getByRole("button", { name: copy.rename })).toBeDisabled();
    expect(
      host.fetcher.mock.calls.some(([url]) =>
        /managed\/(settings|goals|resources|queue)\?/.test(String(url)),
      ),
    ).toBe(false);
    expect(host.state.mutations).toHaveLength(0);
  });

  it("inspects Claude through the existing read endpoint without creating a command", async () => {
    const host = createHost();
    await openSession();
    fireEvent.click(screen.getByRole("button", { name: "会话操作" }));
    fireEvent.click(await screen.findByText(webLayoutCopy["zh-CN"].diagnostics));
    fireEvent.click(screen.getByRole("button", { name: copy.inspect }));
    await screen.findByText(/verified-history/);
    expect(host.state.mutations).toHaveLength(0);
    expect(
      host.fetcher.mock.calls.some(([url]) =>
        String(url).includes("/managed/inspect?sessionId=session&agent=claude-code"),
      ),
    ).toBe(true);
  });
});
