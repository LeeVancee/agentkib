import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexComposer } from "./codex-composer";
import { useSession } from "./session-context";
import { dictionaries, type Locale } from "@/i18n";
import { composerLayoutCopy } from "./composer-layout-copy";
import { codexCopy } from "./codex-copy";
import { publishSessionInvalidation } from "./session-events";
import type { CodexGoalState, CodexSessionSettings } from "@agentkib/web-client";
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
  it.each([
    ["unverified-installation", dictionaries["zh-CN"].unverifiedInstallation],
    ["open-in-original-client", dictionaries["zh-CN"].openOriginalClient],
  ])("shows actionable %s advice beside the disabled composer", async (reason, expected) => {
    state = {
      ...state,
      canSend: false,
      message: "Draft",
      live: { ...state.live!, status: "unsupported", sendEnabled: false, reason },
    };
    render(<CodexComposer />);
    await screen.findByRole("button", { name: /Test Model/ });
    expect(screen.getByRole("status")).toHaveTextContent(expected);
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(state.control).not.toHaveBeenCalled();
    expect(state.codexAction).not.toHaveBeenCalled();
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
    await waitFor(() => expect(state.client.codexSessionSettings).toHaveBeenCalledWith("s"));
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

it("reconciles selected native invalidations, clears native goal, and preserves conflicting drafts", async () => {
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
    publishSessionInvalidation(state.client, "s", ["settings", "goal"]);
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
    publishSessionInvalidation(state.client, "s", ["settings"]);
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

describe("idle conversation revision calibration", () => {
  it("discards a batched read when the selected session changes before it starts", async () => {
    const view = render(<CodexComposer />);
    state = { ...state, selected: "next", live: { ...state.live!, sessionId: "next" } };
    view.rerender(<CodexComposer />);
    await screen.findByRole("button", { name: /Test Model next/ });
    expect(state.client.codexSessionSettings).toHaveBeenCalledExactlyOnceWith("next");
  });

  it.each([
    ["codex-follower", true],
    ["codex-follower", false],
    ["codex-managed", true],
    ["codex-managed", false],
  ] as const)(
    "refreshes %s settings after an unrelated idle revision (open: %s)",
    async (executionMode, open) => {
      const native = settings();
      if (executionMode === "codex-follower") {
        native.options.models = [];
        native.writable.model = { available: false };
        native.writable.effort = { available: false };
        native.writable.mode = { available: true };
        native.options.collaborationModes = [
          { id: "default", name: "Default" },
          { id: "plan", name: "Plan" },
        ];
        // Follower goal reads can be unsupported and have no usable revision.
        vi.mocked(state.client.codexGoals).mockResolvedValue({
          available: false,
        } as CodexGoalState);
      }
      state.live = { ...state.live!, executionMode };
      vi.mocked(state.client.codexSessionSettings).mockResolvedValue(native);
      const view = render(<CodexComposer />);
      const model = await screen.findByRole("button", {
        name: executionMode === "codex-follower" ? /^model/ : /Test Model/,
      });
      if (open) fireEvent.click(model);
      expect(state.client.codexSessionSettings).toHaveBeenCalledOnce();
      vi.mocked(state.client.codexSessionSettings).mockResolvedValue({ ...native, revision: 2 });
      // Neither follower nor the raw managed settings projection supplies the
      // complete session-settings read model on an unrelated native state patch.
      state = { ...state, live: { ...state.live!, revision: 2 } };
      view.rerender(<CodexComposer />);
      act(() => publishSessionInvalidation(state.client, "s", ["catalog"]));
      await waitFor(() => expect(state.client.codexSessionSettings).toHaveBeenCalledTimes(2));
      if (!open) fireEvent.click(model);
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "应用到下一轮" })).toBeEnabled(),
      );
      expect(state.client.codexGoals).toHaveBeenCalledTimes(2);
      expect(state.client.codexContextOptions).toHaveBeenCalledOnce();
      expect(state.codexAction).not.toHaveBeenCalled();
    },
  );

  it("calibrates exposed goal actions without discarding an edited goal", async () => {
    state.capabilities!.features["goal-set"] = { available: true };
    state.capabilities!.features["goal-resume"] = { available: true };
    const goal: CodexGoalState = {
      sessionId: "s",
      revision: 1,
      available: true,
      goal: { objective: "Native goal", status: "paused" },
      actions: {
        set: { available: true },
        resume: { available: true },
        pause: { available: false },
        clear: { available: false },
      },
    };
    vi.mocked(state.client.codexGoals).mockResolvedValue(goal);
    const view = render(<CodexComposer />);
    fireEvent.click(await screen.findByRole("button", { name: "持续目标" }));
    fireEvent.change(screen.getByRole("textbox", { name: "目标内容" }), {
      target: { value: "Keep my goal draft" },
    });
    vi.mocked(state.client.codexSessionSettings).mockResolvedValue({ ...settings(), revision: 2 });
    vi.mocked(state.client.codexGoals).mockResolvedValue({ ...goal, revision: 2 });
    state = { ...state, live: { ...state.live!, revision: 2 } };
    view.rerender(<CodexComposer />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "恢复并继续执行" })).toBeEnabled(),
    );
    expect(screen.getByRole("textbox", { name: "目标内容" })).toHaveValue("Keep my goal draft");
    expect(screen.getByText(composerLayoutCopy["zh-CN"].nativeChanged)).toBeVisible();
    expect(screen.getByRole("button", { name: "更新目标" })).toBeDisabled();
    expect(state.codexAction).not.toHaveBeenCalled();
  });

  it("coalesces initial and idle reads, then drains changes received during the flight", async () => {
    let finish!: (value: CodexSessionSettings) => void;
    vi.mocked(state.client.codexSessionSettings)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({ ...settings(), revision: 3 });
    const view = render(<CodexComposer />);
    act(() => publishSessionInvalidation(state.client, "s", ["settings", "goal"]));
    await waitFor(() => expect(state.client.codexSessionSettings).toHaveBeenCalledOnce());
    state = { ...state, live: { ...state.live!, revision: 2 } };
    view.rerender(<CodexComposer />);
    act(() => publishSessionInvalidation(state.client, "s", ["settings"]));
    state = { ...state, live: { ...state.live!, revision: 3 } };
    view.rerender(<CodexComposer />);
    expect(state.client.codexSessionSettings).toHaveBeenCalledOnce();
    await act(async () => finish(settings()));
    fireEvent.click(await screen.findByRole("button", { name: /Test Model/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "应用到下一轮" })).toBeEnabled());
    expect(state.client.codexSessionSettings).toHaveBeenCalledTimes(2);
    expect(state.client.codexGoals).toHaveBeenCalledTimes(2);
  });

  it("does not read settings for running token revisions and calibrates once on idle", async () => {
    const view = render(<CodexComposer />);
    await screen.findByRole("button", { name: /Test Model/ });
    for (let revision = 2; revision <= 20; revision++) {
      state = { ...state, live: { ...state.live!, status: "running", revision } };
      view.rerender(<CodexComposer />);
    }
    await act(async () => {});
    expect(state.client.codexSessionSettings).toHaveBeenCalledOnce();
    expect(state.client.codexGoals).toHaveBeenCalledOnce();
    vi.mocked(state.client.codexSessionSettings).mockResolvedValue({ ...settings(), revision: 21 });
    state = { ...state, live: { ...state.live!, status: "idle", revision: 21 } };
    view.rerender(<CodexComposer />);
    act(() => publishSessionInvalidation(state.client, "s", ["settings", "goal", "usage"]));
    await waitFor(() => expect(state.client.codexSessionSettings).toHaveBeenCalledTimes(2));
    expect(state.client.codexGoals).toHaveBeenCalledTimes(2);
    expect(state.client.codexContextOptions).toHaveBeenCalledOnce();
  });

  it("retains settings after a failed calibration without retrying until another idle event", async () => {
    const view = render(<CodexComposer />);
    fireEvent.click(await screen.findByRole("button", { name: /Test Model/ }));
    vi.useFakeTimers();
    vi.mocked(state.client.codexSessionSettings).mockRejectedValueOnce(new Error("unavailable"));
    state = { ...state, live: { ...state.live!, revision: 2 } };
    view.rerender(<CodexComposer />);
    await act(async () => {});
    expect(screen.getByRole("combobox", { name: "思考强度" })).toHaveValue("high");
    expect(screen.getByRole("button", { name: "应用到下一轮" })).toBeDisabled();
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(state.client.codexSessionSettings).toHaveBeenCalledTimes(2);
    vi.mocked(state.client.codexSessionSettings).mockResolvedValue({ ...settings(), revision: 3 });
    state = { ...state, live: { ...state.live!, revision: 3 } };
    view.rerender(<CodexComposer />);
    await act(async () => {});
    expect(screen.getByRole("button", { name: "应用到下一轮" })).toBeEnabled();
    expect(state.client.codexSessionSettings).toHaveBeenCalledTimes(3);
  });

  it("keeps an applied settings action busy until its shared read finishes", async () => {
    const view = render(<CodexComposer />);
    fireEvent.click(await screen.findByRole("button", { name: /Test Model/ }));
    let finish!: (value: CodexSessionSettings) => void;
    vi.mocked(state.client.codexSessionSettings).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    vi.mocked(state.codexAction).mockResolvedValue({ accepted: true } as never);
    fireEvent.click(screen.getByRole("button", { name: "应用到下一轮" }));
    await waitFor(() => expect(state.client.codexSessionSettings).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "应用到下一轮" })).toBeDisabled();
    await act(async () => finish(settings()));
    expect(screen.getByRole("button", { name: "应用到下一轮" })).toBeEnabled();
  });

  it.each([true, false])(
    "refreshes a running goal only on demand and keeps the latest CAS guard (open: %s)",
    async (open) => {
      state.capabilities!.features["goal-set"] = { available: true };
      state.capabilities!.features["goal-pause"] = { available: true };
      const goal: CodexGoalState = {
        sessionId: "s",
        revision: 1,
        available: true,
        goal: { objective: "Native goal", status: "active" },
        actions: {
          set: { available: true },
          pause: { available: true },
          resume: { available: false },
          clear: { available: false },
        },
      };
      vi.mocked(state.client.codexGoals).mockResolvedValue(goal);
      const view = render(<CodexComposer />);
      const goalButton = await screen.findByRole("button", { name: "持续目标" });
      if (open) {
        fireEvent.click(goalButton);
        fireEvent.change(screen.getByRole("textbox", { name: "目标内容" }), {
          target: { value: "Keep my running goal draft" },
        });
      }
      state = { ...state, live: { ...state.live!, status: "running", revision: 2 } };
      view.rerender(<CodexComposer />);
      await act(async () => {});
      expect(state.client.codexGoals).toHaveBeenCalledOnce();
      let finish!: (value: CodexGoalState) => void;
      vi.mocked(state.client.codexGoals).mockImplementationOnce(
        () => new Promise((resolve) => (finish = resolve)),
      );
      vi.mocked(state.client.codexSessionSettings).mockResolvedValue({
        ...settings(),
        revision: 2,
      });
      fireEvent.click(open ? screen.getByRole("button", { name: "重新载入" }) : goalButton);
      await waitFor(() => expect(state.client.codexGoals).toHaveBeenCalledTimes(2));
      expect(screen.getByRole("button", { name: "暂停" })).toBeDisabled();
      state = { ...state, live: { ...state.live!, revision: 3 } };
      view.rerender(<CodexComposer />);
      await act(async () => finish({ ...goal, revision: 2 }));
      expect(screen.getByRole("button", { name: "暂停" })).toBeDisabled();
      expect(state.client.codexGoals).toHaveBeenCalledTimes(2);
      expect(state.codexAction).not.toHaveBeenCalled();

      vi.mocked(state.client.codexGoals).mockResolvedValue({ ...goal, revision: 3 });
      vi.mocked(state.client.codexSessionSettings).mockResolvedValue({
        ...settings(),
        revision: 3,
      });
      fireEvent.click(screen.getByRole("button", { name: "重新载入" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "暂停" })).toBeEnabled());
      if (open) {
        expect(screen.getByRole("textbox", { name: "目标内容" })).toHaveValue(
          "Keep my running goal draft",
        );
        expect(screen.getByText(composerLayoutCopy["zh-CN"].nativeChanged)).toBeVisible();
        expect(screen.getByRole("button", { name: "更新目标" })).toBeDisabled();
      }
      expect(state.client.codexGoals).toHaveBeenCalledTimes(3);
      expect(state.client.codexContextOptions).toHaveBeenCalledOnce();
      expect(state.codexAction).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "暂停" }));
      expect(state.codexAction).toHaveBeenCalledExactlyOnceWith("goal-pause", {});
    },
  );

  it("retries a failed explicit settings refresh on demand without rescanning resources", async () => {
    const view = render(<CodexComposer />);
    fireEvent.click(await screen.findByRole("button", { name: /Test Model/ }));
    vi.mocked(state.client.codexSessionSettings).mockRejectedValue(new Error("unavailable"));
    state = { ...state, live: { ...state.live!, revision: 2 } };
    view.rerender(<CodexComposer />);
    await waitFor(() => expect(state.client.codexSessionSettings).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "重新载入" }));
    await waitFor(() => expect(state.client.codexSessionSettings).toHaveBeenCalledTimes(3));
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "应用到下一轮" })).not.toBeInTheDocument();
    vi.mocked(state.client.codexSessionSettings).mockResolvedValue({ ...settings(), revision: 2 });
    fireEvent.click(screen.getByRole("button", { name: "重新载入" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "应用到下一轮" })).toBeEnabled());
    expect(state.client.codexContextOptions).toHaveBeenCalledOnce();
    expect(state.codexAction).not.toHaveBeenCalled();
  });
});
