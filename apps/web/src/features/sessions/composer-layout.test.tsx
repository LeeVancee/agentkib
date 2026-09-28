import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexComposer } from "./codex-composer";
import { useSession } from "./session-context";
import { dictionaries, type Locale } from "@/i18n";
import { composerLayoutCopy } from "./composer-layout-copy";
import { codexCopy } from "./codex-copy";
import type { CodexSessionSettings } from "@agentkib/web-client";
vi.mock("./session-context", () => ({ useSession: vi.fn() }));
let state: ReturnType<typeof useSession>;
function settings(id = "s"): CodexSessionSettings {
  return {
    sessionId: id,
    revision: 1,
    available: true,
    current: { modelId: "model", effort: "high", mode: "default" },
    defaults: { modelId: "model", effort: "medium" },
    writable: {
      model: { available: true },
      effort: { available: true },
      mode: { available: false, reason: "owner_channel_unavailable" },
      serviceTier: { available: false },
      policy: { available: false },
      restoreDefaults: { available: true },
    },
    options: {
      models: [
        { id: "model", name: `Test Model ${id}`, efforts: ["medium", "high"], serviceTierIds: [] },
      ],
      policies: [],
      serviceTiers: [],
    },
  };
}
beforeEach(() => {
  state = {
    selected: "s",
    locale: "zh-CN",
    t: dictionaries["zh-CN"],
    access: {
      experimentalEnabled: true,
      device: { accessMode: "full", send: true, attachments: true },
    },
    live: { sessionId: "s", status: "idle", revision: 1 },
    online: true,
    controlReady: true,
    busy: false,
    canSend: true,
    canStop: false,
    message: "",
    setMessage: vi.fn(),
    control: vi.fn(),
    codexAction: vi.fn(),
    capabilities: {
      sessionId: "s",
      features: {
        settings: { available: true },
        context: { available: true },
        attachments: { available: true },
      },
    },
    client: {
      codexSessionSettings: vi.fn(async (id: string) => settings(id)),
      codexGoals: vi.fn(async () => ({
        sessionId: "s",
        revision: 1,
        available: false,
        actions: {},
      })),
      codexContextOptions: vi.fn(async () => ({
        sessionId: "s",
        revision: 1,
        resources: [{ id: "resource", kind: "file", name: "readme.md", available: true }],
      })),
    },
  } as unknown as ReturnType<typeof useSession>;
  vi.mocked(useSession).mockImplementation(() => state);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
describe("responsive composer behavior", () => {
  it("opens unknown context usage with a keyboard-focusable button", async () => {
    render(<CodexComposer />);
    await screen.findByRole("button", { name: /Test Model/ });
    const usage = screen.getByRole("button", { name: "上下文用量" });
    usage.focus();
    expect(usage).toHaveFocus();
    fireEvent.click(usage);
    expect(screen.getByRole("dialog", { name: "上下文用量" })).toHaveTextContent(
      codexCopy["zh-CN"].contextUnknown,
    );
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(usage).toHaveFocus());
  });
  it("keeps selected resources in the draft after Done and puts goals in Add", async () => {
    render(<CodexComposer />);
    await screen.findByRole("button", { name: /Test Model/ });
    expect(screen.queryByRole("button", { name: "持续目标" })).not.toBeInTheDocument();
    const add = screen.getByRole("button", { name: "添加上下文" });
    add.focus();
    fireEvent.click(add);
    expect(screen.getByRole("button", { name: "持续目标" })).toBeVisible();
    fireEvent.click(await screen.findByRole("checkbox", { name: /readme/ }));
    expect(screen.getByText("已选: 1")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    await waitFor(() => expect(add).toHaveFocus());
    expect(screen.getByRole("button", { name: "移除附件: readme.md" })).toBeVisible();
    expect(state.control).not.toHaveBeenCalled();
    expect(state.codexAction).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(screen.getByLabelText("发送消息")).toBeEnabled();
  });
  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as Locale[])(
    "localizes effort and exposes disabled reasons in %s",
    async (locale) => {
      state = { ...state, locale, t: dictionaries[locale] };
      render(<CodexComposer />);
      fireEvent.click(await screen.findByRole("button", { name: /Test Model/ }));
      const dialog = screen.getByRole("dialog");
      const high = within(dialog).getByRole("option", {
        name: { "zh-CN": "高", "zh-TW": "高", "en-US": "High", "ja-JP": "高" }[locale],
      });
      expect(high).toHaveValue("high");
      expect(within(dialog).getByText("owner_channel_unavailable")).toBeInTheDocument();
      const apply = within(dialog).getByRole("button", { name: codexCopy[locale].apply });
      expect(apply.closest(".dialog-body")).toBeNull();
      expect(
        within(dialog).getByRole("combobox", { name: new RegExp(codexCopy[locale].mode) }),
      ).toBeDisabled();
    },
  );
  it("does not confuse an empty message with missing authorization", async () => {
    const view = render(<CodexComposer />);
    await screen.findByRole("button", { name: /Test Model/ });
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(screen.queryByText(composerLayoutCopy["zh-CN"].permission)).not.toBeInTheDocument();
    state = { ...state, online: false, canSend: false };
    view.rerender(<CodexComposer />);
    expect(screen.getByRole("status")).not.toBeEmptyDOMElement();
    expect(state.control).not.toHaveBeenCalled();
  });
  it("ignores late settings responses for a previously selected conversation", async () => {
    let finish!: (value: CodexSessionSettings) => void;
    vi.mocked(state.client.codexSessionSettings).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(<CodexComposer />);
    state = { ...state, selected: "next", live: { ...state.live!, sessionId: "next" } };
    view.rerender(<CodexComposer />);
    await screen.findByRole("button", { name: /Test Model next/ });
    finish(settings("old"));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Test Model old/ })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /Test Model next/ })).toBeVisible();
  });
});

describe("native Plan and Goal projection", () => {
  it("shows selected next-turn mode without claiming native confirmation, and confirms only on native state", async () => {
    const native = settings();
    native.writable.mode = { available: true };
    native.options.collaborationModes = [
      { id: "default", name: "Default" },
      { id: "plan", name: "Plan" },
    ];
    native.selected = { ...native.current, mode: "plan" };
    native.applicationStatus = "pending";
    vi.mocked(state.client.codexSessionSettings).mockResolvedValue(native);
    const view = render(<CodexComposer />);
    fireEvent.click(await screen.findByRole("button", { name: /Test Model.*下一轮/ }));
    expect(screen.getByRole("combobox", { name: "协作模式" })).toHaveValue("plan");
    expect(screen.getByRole("option", { name: "原生模式待确认" })).toBeDisabled();
    expect(screen.getByRole("option", { name: "执行" })).toHaveValue("default");
    expect(screen.getByText(composerLayoutCopy["zh-CN"].settingsPending)).toBeVisible();
    expect(screen.queryByText(codexCopy["zh-CN"].settingsSaved)).not.toBeInTheDocument();
    state = {
      ...state,
      live: {
        ...state.live!,
        settings: { ...native, current: native.selected, applicationStatus: "confirmed" },
      },
    };
    view.rerender(<CodexComposer />);
    await waitFor(() =>
      expect(
        screen.queryByText(composerLayoutCopy["zh-CN"].settingsPending),
      ).not.toBeInTheDocument(),
    );
    expect(state.codexAction).not.toHaveBeenCalled();
  });
  it("does not manufacture modes when native mode directory is absent", async () => {
    const native = settings();
    native.writable.mode = { available: true };
    vi.mocked(state.client.codexSessionSettings).mockResolvedValue(native);
    render(<CodexComposer />);
    fireEvent.click(await screen.findByRole("button", { name: /Test Model/ }));
    expect(screen.getByRole("combobox", { name: /协作模式/ })).toBeDisabled();
    expect(screen.queryByRole("option", { name: "计划" })).not.toBeInTheDocument();
  });
  it.each(["paused", "blocked", "active", "budgetLimited", "usageLimited", "complete"])(
    "maps native %s to valid goal controls and updates without activation",
    async (status) => {
      state.capabilities = {
        ...state.capabilities!,
        features: {
          ...state.capabilities!.features,
          "goal-set": { available: true },
          "goal-pause": { available: true },
          "goal-resume": { available: true },
          "goal-clear": { available: true },
        },
      };
      vi.mocked(state.client.codexGoals).mockResolvedValue({
        sessionId: "s",
        revision: 1,
        available: true,
        goal: { objective: "Safe native goal", status, tokenBudget: 5000 },
        actions: {
          set: { available: true },
          pause: { available: true },
          resume: { available: true },
          clear: { available: true },
        },
      });
      render(<CodexComposer />);
      fireEvent.click(await screen.findByRole("button", { name: "持续目标" }));
      expect(!!screen.queryByRole("button", { name: "暂停" })).toBe(status === "active");
      expect(!!screen.queryByRole("button", { name: "恢复并继续执行" })).toBe(
        ["paused", "blocked"].includes(status),
      );
      expect(!!screen.queryByRole("button", { name: "尝试恢复" })).toBe(
        ["budgetLimited", "usageLimited"].includes(status),
      );
      fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "" } });
      fireEvent.click(screen.getByRole("button", { name: "更新目标" }));
      await waitFor(() =>
        expect(state.codexAction).toHaveBeenCalledWith("goal-set", {
          objective: "Safe native goal",
          intent: "update",
          tokenBudget: null,
        }),
      );
      expect(state.control).not.toHaveBeenCalled();
    },
  );
});

it("reconciles only selected SSE revisions, clears native goal, and preserves conflicting drafts", async () => {
  const native = settings();
  native.selected = { ...native.current, mode: "plan" };
  native.applicationStatus = "pending";
  native.options.collaborationModes = [
    { id: "default", name: "Default" },
    { id: "plan", name: "Plan" },
  ];
  native.writable.mode = { available: true };
  vi.mocked(state.client.codexSessionSettings).mockResolvedValue(native);
  vi.mocked(state.client.codexGoals).mockResolvedValue({
    sessionId: "s",
    revision: 1,
    available: true,
    goal: { objective: "Native goal", status: "paused" },
    actions: {
      set: { available: true },
      pause: { available: false },
      resume: { available: true },
      clear: { available: true },
    },
  });
  const view = render(<CodexComposer />);
  fireEvent.click(await screen.findByRole("button", { name: /Test Model/ }));
  fireEvent.change(screen.getByRole("combobox", { name: "思考强度" }), {
    target: { value: "medium" },
  });
  vi.useFakeTimers();
  const initialReads = vi.mocked(state.client.codexSessionSettings).mock.calls.length;
  const initialResources = vi.mocked(state.client.codexContextOptions).mock.calls.length;
  state = {
    ...state,
    live: { ...state.live!, unrelatedData: "unchanged selected revision" } as typeof state.live,
  };
  view.rerender(<CodexComposer />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2100);
  });
  expect(state.client.codexSessionSettings).toHaveBeenCalledTimes(initialReads);
  vi.mocked(state.client.codexSessionSettings).mockResolvedValue({
    ...native,
    revision: 2,
    current: native.selected!,
    applicationStatus: "confirmed",
  });
  vi.mocked(state.client.codexGoals).mockResolvedValue({
    sessionId: "s",
    revision: 2,
    available: true,
    actions: {
      set: { available: true },
      pause: { available: false },
      resume: { available: false },
      clear: { available: false },
    },
  });
  state = { ...state, live: { ...state.live!, revision: 2 } };
  view.rerender(<CodexComposer />);
  expect(screen.getByRole("button", { name: "应用到下一轮" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "应用到下一轮" }));
  expect(state.codexAction).not.toHaveBeenCalled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2100);
  });
  expect(state.client.codexSessionSettings).toHaveBeenCalledTimes(initialReads + 1);
  expect(state.client.codexContextOptions).toHaveBeenCalledTimes(initialResources);
  expect(screen.queryByText(composerLayoutCopy["zh-CN"].settingsPending)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "持续目标" })).not.toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "思考强度" })).toHaveValue("medium");
  expect(screen.getByRole("button", { name: "应用到下一轮" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "重新载入" }));
  expect(screen.getByRole("combobox", { name: "思考强度" })).toHaveValue("high");
  expect(screen.getByRole("button", { name: "应用到下一轮" })).toBeEnabled();
  expect(state.codexAction).not.toHaveBeenCalled();
  vi.useRealTimers();
});

it("ignores late selected-session native reads after switching conversations", async () => {
  const view = render(<CodexComposer />);
  await screen.findByRole("button", { name: /Test Model s/ });
  let resolveOld!: (value: CodexSessionSettings) => void;
  vi.mocked(state.client.codexSessionSettings).mockImplementation((id) =>
    id === "s"
      ? new Promise((resolve) => {
          resolveOld = resolve;
        })
      : Promise.resolve(settings(id)),
  );
  vi.useFakeTimers();
  state = { ...state, live: { ...state.live!, revision: 2 } };
  view.rerender(<CodexComposer />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2100);
  });
  state = { ...state, selected: "new", live: { ...state.live!, sessionId: "new", revision: 1 } };
  view.rerender(<CodexComposer />);
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () =>
    resolveOld({ ...settings("s"), selected: { modelId: "stale" }, applicationStatus: "pending" }),
  );
  expect(screen.getByRole("button", { name: /Test Model new/ })).toBeVisible();
  expect(screen.queryByText("stale")).not.toBeInTheDocument();
  expect(state.codexAction).not.toHaveBeenCalled();
  vi.useRealTimers();
});
