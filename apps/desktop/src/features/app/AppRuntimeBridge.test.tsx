// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppDialogProvider } from "@/components/AppDialogProvider";
import { initializeI18n } from "@/core/i18n";
import { useAppStore } from "@/stores/app-store";
import type { DesktopRuntimeStatus } from "../../../electron/api";
import { AppRuntimeBridge } from "./AppRuntimeBridge";

const { runtimeInfo, addWorkspace, setAccentThemePreference } = vi.hoisted(() => ({
  runtimeInfo: vi.fn(),
  addWorkspace: vi.fn(),
  setAccentThemePreference: vi.fn(),
}));

vi.mock("@/core/api", () => ({
  api: {
    runtime: runtimeInfo,
    addWorkspace,
    setAccentThemePreference,
    quitApp: vi.fn(),
  },
}));

describe("AppRuntimeBridge", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-accent-theme");
    useAppStore.getState().reset();
    await initializeI18n("zh-CN");
  });

  it("synchronizes Runtime information when legacy workspace migration fails", async () => {
    window.localStorage.setItem("agentkib.project", "/missing/legacy-workspace");
    addWorkspace.mockRejectedValue(new Error("legacy workspace missing"));
    runtimeInfo.mockResolvedValue({
      effective_theme: "light",
      effective_locale: "zh-CN",
      accent_theme_preference: "vtron",
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <AppDialogProvider>
          <AppRuntimeBridge />
        </AppDialogProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(addWorkspace).toHaveBeenCalledWith("/missing/legacy-workspace"));
    await waitFor(() => expect(runtimeInfo).toHaveBeenCalledOnce());
    expect(useAppStore.getState().runtime).toMatchObject({ effective_locale: "zh-CN" });
    expect(window.localStorage.getItem("agentkib.project")).toBe("/missing/legacy-workspace");
  });

  it("shows an in-window retry action after a terminal Runtime failure", async () => {
    let statusListener: ((status: DesktopRuntimeStatus) => void) | undefined;
    const retry = vi.fn().mockResolvedValue(undefined);
    const desktop = window.agentkibDesktop!;
    desktop.events.onRuntimeStatus = vi.fn((listener) => {
      statusListener = listener;
      return () => undefined;
    });
    desktop.runtime.status = vi.fn().mockResolvedValue({
      state: "failed",
      restartCount: 3,
      error: "fixture startup failure",
    });
    desktop.runtime.retry = retry;
    runtimeInfo.mockRejectedValue(new Error("fixture startup failure"));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <AppDialogProvider>
          <AppRuntimeBridge />
        </AppDialogProvider>
      </QueryClientProvider>,
    );

    expect((await screen.findByRole("alert")).textContent).toContain("本地 Runtime 启动失败");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(retry).toHaveBeenCalledOnce());

    runtimeInfo.mockResolvedValue({
      effective_theme: "light",
      effective_locale: "zh-CN",
      accent_theme_preference: "vtron",
    });
    statusListener?.({ state: "ready", restartCount: 0 });
    await waitFor(() => expect(runtimeInfo).toHaveBeenCalledTimes(2));
    expect(useAppStore.getState().runtime).toMatchObject({ effective_locale: "zh-CN" });
  });

  it("migrates a legacy cached accent when Runtime has no preference", async () => {
    window.localStorage.setItem("agentkib.accent-theme", "black");
    runtimeInfo.mockResolvedValue({
      effective_theme: "light",
      effective_locale: "zh-CN",
      accent_theme_preference: null,
    });
    setAccentThemePreference.mockResolvedValue({
      effective_theme: "light",
      effective_locale: "zh-CN",
      accent_theme_preference: "minimal-neutral",
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <AppDialogProvider>
          <AppRuntimeBridge />
        </AppDialogProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(setAccentThemePreference).toHaveBeenCalledWith("minimal-neutral"));
    expect(useAppStore.getState().runtime).toMatchObject({
      accent_theme_preference: "minimal-neutral",
    });
    expect(document.documentElement.dataset.accentTheme).toBe("minimal-neutral");
    expect(window.localStorage.getItem("agentkib.accent-theme")).toBe("minimal-neutral");
  });

  it("uses the Runtime accent as authoritative over the startup cache", async () => {
    window.localStorage.setItem("agentkib.accent-theme", "sakura");
    runtimeInfo.mockResolvedValue({
      effective_theme: "light",
      effective_locale: "zh-CN",
      accent_theme_preference: "ocean-breeze",
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <AppDialogProvider>
          <AppRuntimeBridge />
        </AppDialogProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(document.documentElement.dataset.accentTheme).toBe("ocean-breeze"));
    expect(setAccentThemePreference).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("agentkib.accent-theme")).toBe("ocean-breeze");
  });
});
