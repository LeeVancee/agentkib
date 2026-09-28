import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexCapabilities, UploadedAttachment } from "@agentkib/web-client";
import { CodexTools } from "./codex-tools";
import { CodexComposer } from "./codex-composer";
import { NativeDecisions } from "@/features/interactions/native-decisions";
import { useSession } from "./session-context";
import { dictionaries } from "@/i18n";
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("./session-context", () => ({ useSession: vi.fn() }));
const sessionMock = vi.mocked(useSession);
let state: ReturnType<typeof useSession>;
const uploaded: UploadedAttachment = {
  id: "opaque-id",
  name: "image.png",
  mime: "image/png",
  size: 3,
  version: "v1",
};
beforeEach(() => {
  const request = vi.fn().mockResolvedValue({});
  state = {
    selected: "s",
    access: { status: "approved", device: { attachments: true, advancedControl: true } },
    live: { status: "idle" },
    client: {
      uploadAttachment: vi.fn().mockResolvedValue(uploaded),
      request,
      codexSessionSettings: vi.fn((sessionId: string) =>
        request(`codex/session-settings?sessionId=${sessionId}`),
      ),
      codexGoals: vi.fn((sessionId: string) => request(`codex/goals?sessionId=${sessionId}`)),
      codexContextOptions: vi.fn((sessionId: string) =>
        request(`codex/context-options?sessionId=${sessionId}`),
      ),
    },
    locale: "zh-CN",
    t: dictionaries["zh-CN"],
    message: "",
    setMessage: vi.fn(),
    control: vi.fn().mockResolvedValue(true),
    codexAction: vi.fn().mockResolvedValue({ accepted: true }),
    capabilities: {
      sessionId: "s",
      features: {
        attachments: { available: true },
        steer: { available: true },
        "queue-add": { available: true },
      },
    } as CodexCapabilities,
    canSend: true,
    canStop: false,
    busy: false,
    online: true,
    controlReady: true,
  } as unknown as ReturnType<typeof useSession>;
  sessionMock.mockImplementation(() => state);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
describe("Codex composer", () => {
  it("stages an attachment and sends only opaque IDs, allowing an attachment-only turn", async () => {
    render(<CodexComposer />);
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("添加附件", { selector: "input" }), {
      target: { files: [new File(["abc"], "image.png", { type: "image/png" })] },
    });
    await screen.findByText("100%");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() =>
      expect(state.control).toHaveBeenCalledWith(
        "send",
        undefined,
        undefined,
        undefined,
        undefined,
        { attachmentIds: ["opaque-id"] },
      ),
    );
    expect(JSON.stringify(vi.mocked(state.control).mock.calls)).not.toContain("image.png");
    await waitFor(() => expect(screen.queryByText("image.png")).not.toBeInTheDocument());
  });
  it.each([
    ["queue-add", "加入队列（将自动执行）"],
    ["steer", "追加到当前轮次"],
  ])("sends text-only %s only during a running turn", (action, label) => {
    state.message = "next";
    const view = render(<CodexComposer />);
    expect(screen.queryByRole("button", { name: /加入队列/ })).not.toBeInTheDocument();
    state = {
      ...state,
      live: { ...state.live!, status: "running", turnId: "turn" },
      canSend: false,
      canStop: true,
    };
    view.rerender(<CodexComposer />);
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(state.codexAction).toHaveBeenCalledWith(action, {
      text: "next",
      ...(action === "steer" ? { turnId: "turn" } : {}),
    });
  });
  it("blocks submission while uploading and aborts transfers on unmount", async () => {
    let signal: AbortSignal | undefined;
    vi.mocked(state.client.uploadAttachment).mockImplementation(
      (_id, _file, progress, nextSignal) => {
        signal = nextSignal;
        progress(50);
        return new Promise(() => {});
      },
    );
    const view = render(<CodexComposer />);
    fireEvent.change(screen.getByLabelText("添加附件", { selector: "input" }), {
      target: { files: [new File(["abc"], "image.png")] },
    });
    expect(await screen.findByText("上传中 50%")).toBeVisible();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });
  it("rejects pasted files when the host has not verified attachment support", () => {
    state = { ...state, capabilities: undefined };
    render(<CodexComposer />);
    fireEvent.paste(screen.getByLabelText("发送消息"), {
      clipboardData: { files: [new File(["x"], "file.txt")] },
    });
    expect(state.client.uploadAttachment).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "添加附件" })).toBeDisabled();
  });

  it("shows host-confirmed settings and context usage only to a full-access browser", async () => {
    state = {
      ...state,
      access: {
        ...state.access!,
        device: { ...state.access!.device!, accessMode: "full" },
      },
      live: { ...state.live!, revision: 4 },
      capabilities: {
        ...state.capabilities!,
        features: {
          ...state.capabilities!.features,
          settings: { available: true },
          context: { available: true },
        },
      } as CodexCapabilities,
    };
    vi.mocked(state.client.request).mockImplementation(async (path: string) => {
      if (path.startsWith("codex/session-settings?"))
        return {
          sessionId: "s",
          available: true,
          revision: 4,
          executionMode: "codex-managed",
          status: "idle",
          current: {
            modelId: "gpt-6-sol",
            effort: "high",
            mode: "default",
            policyId: "workspace",
            serviceTierId: "fast",
          },
          defaults: { modelId: "gpt-6-sol", effort: "medium", serviceTierId: "standard" },
          writable: {
            model: { available: true },
            effort: { available: true },
            mode: { available: true },
            policy: { available: true },
            serviceTier: { available: true },
            restoreDefaults: { available: true },
          },
          options: {
            models: [
              {
                id: "gpt-6-sol",
                name: "GPT-6 Sol",
                efforts: ["medium", "high"],
                serviceTierIds: ["standard", "fast"],
              },
            ],
            policies: [{ id: "workspace", name: "工作区写入" }],
            serviceTiers: [
              { id: "standard", name: "标准" },
              { id: "fast", name: "加速", description: "由主机提供" },
            ],
          },
          usage: { available: true, usedTokens: 50, contextWindow: 100 },
        };
      if (path.startsWith("codex/goals?"))
        return { sessionId: "s", revision: 4, available: false, actions: {} };
      if (path.startsWith("codex/context-options?"))
        return { sessionId: "s", revision: 4, resources: [] };
      return {};
    });
    render(<CodexComposer />);
    expect(await screen.findByRole("button", { name: /GPT-6 Sol/ })).toBeVisible();
    expect(screen.getByTitle("上下文用量: 50 / 100")).toHaveTextContent("50%");
    fireEvent.click(screen.getByRole("button", { name: /GPT-6 Sol/ }));
    expect(screen.getByLabelText("思考强度")).toHaveValue("high");
    expect(screen.getByDisplayValue("加速")).toHaveValue("fast");
    fireEvent.click(screen.getByRole("button", { name: "恢复主机默认" }));
    await waitFor(() =>
      expect(state.codexAction).toHaveBeenCalledWith("settings", { restoreDefaults: true }),
    );
  });

  it("sends opaque host resource IDs and never exposes the control to a legacy credential", async () => {
    const fullAccess = {
      ...state.access!,
      device: { ...state.access!.device!, accessMode: "full" as const },
    };
    state = {
      ...state,
      access: fullAccess,
      capabilities: {
        ...state.capabilities!,
        features: {
          ...state.capabilities!.features,
          context: { available: true },
        },
      } as CodexCapabilities,
    };
    vi.mocked(state.client.request).mockImplementation(async (path: string) => {
      if (path.startsWith("codex/session-settings?")) throw new Error("unavailable");
      if (path.startsWith("codex/goals?")) throw new Error("unavailable");
      if (path.startsWith("codex/context-options?"))
        return {
          sessionId: "s",
          available: true,
          revision: 1,
          resources: [
            {
              id: "opaque-resource-id",
              kind: "file",
              name: "notes.md",
              available: true,
            },
          ],
        };
      return {};
    });
    const view = render(<CodexComposer />);
    fireEvent.click(await screen.findByRole("button", { name: "添加上下文" }));
    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(screen.getByText("引用文件或技能后，请输入消息或添加手机附件再发送。")).toBeVisible();
    expect(state.control).not.toHaveBeenCalled();
    state = { ...state, message: "Use these references" };
    view.rerender(<CodexComposer />);
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() =>
      expect(state.control).toHaveBeenCalledWith(
        "send",
        undefined,
        undefined,
        undefined,
        undefined,
        { attachmentIds: [], resourceIds: ["opaque-resource-id"] },
      ),
    );
    expect(JSON.stringify(vi.mocked(state.control).mock.calls)).not.toContain("notes.md");

    state = {
      ...state,
      access: { ...fullAccess, device: { ...fullAccess.device!, accessMode: undefined } },
    };
    view.rerender(<CodexComposer />);
    expect(screen.queryByRole("button", { name: "添加上下文" })).not.toBeInTheDocument();
  });

  it("disables setting changes while a native turn is running", async () => {
    state = {
      ...state,
      access: { ...state.access!, device: { ...state.access!.device!, accessMode: "full" } },
      live: { ...state.live!, status: "running", revision: 2 },
      capabilities: {
        ...state.capabilities!,
        features: { ...state.capabilities!.features, settings: { available: true } },
      } as CodexCapabilities,
    };
    vi.mocked(state.client.request).mockImplementation(async (path: string) => {
      if (path.startsWith("codex/session-settings?"))
        return {
          sessionId: "s",
          available: true,
          revision: 2,
          executionMode: "codex-managed",
          status: "running",
          current: { modelId: "model" },
          defaults: {},
          writable: {
            model: { available: true },
            restoreDefaults: { available: true },
          },
          options: { models: [{ id: "model", name: "Model" }] },
        };
      if (path.startsWith("codex/goals?"))
        return { sessionId: "s", revision: 2, available: false, actions: {} };
      return { sessionId: "s", revision: 2, resources: [] };
    });
    render(<CodexComposer />);
    fireEvent.click(await screen.findByRole("button", { name: /Model/ }));
    expect(screen.getByLabelText("模型")).toBeDisabled();
    expect(screen.getByRole("button", { name: "恢复主机默认" })).toBeDisabled();
    expect(screen.getByText("当前轮次结束后才能修改设置")).toBeVisible();
  });

  it("uses the durable Codex action path for goal changes", async () => {
    state = {
      ...state,
      access: { ...state.access!, device: { ...state.access!.device!, accessMode: "full" } },
      live: { ...state.live!, revision: 8 },
      capabilities: {
        ...state.capabilities!,
        features: {
          ...state.capabilities!.features,
          "goal-set": { available: true },
          "goal-pause": { available: true },
          "goal-clear": { available: true },
        },
      } as CodexCapabilities,
    };
    vi.mocked(state.client.request).mockImplementation(async (path: string) => {
      if (path.startsWith("codex/goals?"))
        return {
          sessionId: "s",
          revision: 8,
          available: true,
          goal: { objective: "finish QA", status: "active", tokensUsed: 12, elapsedMs: 2000 },
          actions: {
            set: { available: true },
            pause: { available: true },
            resume: { available: false },
            clear: { available: true },
          },
        };
      if (path.startsWith("codex/context-options?"))
        return { sessionId: "s", revision: 8, resources: [] };
      throw new Error("settings unavailable");
    });
    render(<CodexComposer />);
    fireEvent.click(await screen.findByRole("button", { name: "持续目标" }));
    expect(screen.getByDisplayValue("finish QA")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    await waitFor(() => expect(state.codexAction).toHaveBeenCalledWith("goal-pause", {}));
  });
});
it("requires explicit confirmation for native session/persistent approval scope and submits the exact candidate", () => {
  const submit = vi.fn();
  const decision = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git", "status"] } };
  render(
    <NativeDecisions
      approval={{
        requestId: 1,
        turnId: "t",
        method: "command",
        supported: true,
        availableDecisions: [],
        decisionOptions: [
          { id: "persist", label: "acceptWithExecpolicyAmendment", decision, scope: "persistent" },
        ],
      }}
      locale="en-US"
      enabled
      busy={false}
      submit={submit}
    />,
  );
  const button = screen.getByRole("button", { name: "Save command rule and allow" });
  expect(button).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(button);
  expect(submit).toHaveBeenCalledExactlyOnceWith(decision);
});

it("keeps native inspection available while write outcome is unconfirmed", async () => {
  state = {
    ...state,
    current: {
      id: "s",
      agent: "codex",
      title: "Codex",
      workspace_id: "w",
      archived: false,
      sidechain: false,
      availability: "readable",
    },
    access: { ...state.access!, experimentalEnabled: true },
    online: false,
    controlReady: false,
    capabilities: {
      sessionId: "s",
      executionMode: "codex-managed",
      status: "unknown",
      features: { inspect: { available: true }, rename: { available: true } },
    },
    client: Object.assign(state.client, {
      codexQueue: vi.fn().mockResolvedValue({ data: [] }),
      request: vi.fn().mockResolvedValue({ available: true, workspaces: [] }),
    }),
    refresh: vi.fn(),
  };
  render(<CodexTools />);
  fireEvent.click(screen.getByRole("button", { name: "会话操作" }));
  const inspect = screen.getByRole("button", { name: "核对原生状态" });
  expect(inspect).toBeEnabled();
  expect(screen.getByRole("button", { name: "重命名" })).toBeDisabled();
  fireEvent.click(inspect);
  await waitFor(() => expect(state.codexAction).toHaveBeenCalledExactlyOnceWith("inspect", {}));
});

it("does not delete a staged attachment while its send outcome is unknown", async () => {
  vi.mocked(state.control).mockResolvedValue(undefined);
  const view = render(<CodexComposer />);
  fireEvent.change(screen.getByLabelText("添加附件", { selector: "input" }), {
    target: { files: [new File(["abc"], "image.png")] },
  });
  await screen.findByText("100%");
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(state.control).toHaveBeenCalled());
  state = { ...state, notice: "uncertain" };
  view.rerender(<CodexComposer />);
  expect(screen.getByRole("button", { name: "移除附件: image.png" })).toBeDisabled();
  expect(state.client.request).not.toHaveBeenCalled();
  state = { ...state, notice: "accepted" };
  view.rerender(<CodexComposer />);
  await waitFor(() => expect(screen.queryByText("image.png")).not.toBeInTheDocument());
  expect(state.client.request).not.toHaveBeenCalled();
});

it("keeps queued attachment messages read-only while allowing deletion", async () => {
  state = {
    ...state,
    current: {
      id: "s",
      agent: "codex",
      title: "Codex",
      workspace_id: "w",
      archived: false,
      sidechain: false,
      availability: "readable",
    },
    access: { ...state.access!, experimentalEnabled: true },
    capabilities: {
      sessionId: "s",
      executionMode: "codex-managed",
      status: "running",
      features: { "queue-update": { available: true }, "queue-delete": { available: true } },
    },
    client: Object.assign(state.client, {
      codexQueue: vi.fn().mockResolvedValue({
        data: [{ id: "queued", text: "Image description", hasAttachments: true }],
      }),
      request: vi.fn().mockResolvedValue({ available: true, workspaces: [] }),
    }),
    refresh: vi.fn(),
  };
  render(<CodexTools />);
  fireEvent.click(screen.getByRole("button", { name: "会话操作" }));
  await screen.findByText("Image description");
  expect(screen.getByRole("button", { name: "修改" })).toBeDisabled();
  expect(screen.getByText("含附件的待发消息暂不支持编辑正文，可删除后重新添加。")).toBeVisible();
  expect(screen.getByRole("button", { name: "移除" })).toBeEnabled();
});
