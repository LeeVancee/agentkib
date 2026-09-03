// @vitest-environment jsdom

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { initializeI18n } from "@/core/i18n";
import type { RuntimeInfo } from "@/core/types";
import { AccentThemeSetting } from "./GlobalSettings";

const { setAccentThemePreference } = vi.hoisted(() => ({
  setAccentThemePreference: vi.fn(),
}));

vi.mock("@/core/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/core/api")>()),
  api: {
    ...(await importOriginal<typeof import("@/core/api")>()).api,
    setAccentThemePreference,
  },
}));

const runtime = {
  effective_theme: "light",
  accent_theme_preference: "vtron",
} as RuntimeInfo;

describe("AccentThemeSetting", () => {
  beforeAll(() => initializeI18n("en-US"));
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-accent-theme");
  });

  it("explains that the saved accent is deferred while dark mode is active", () => {
    render(
      <AccentThemeSetting runtime={{ ...runtime, effective_theme: "dark" }} onChanged={vi.fn()} />,
    );

    expect(
      screen.getByText(
        "The selected theme's dark palette is active across actions, surfaces, and the sidebar.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Accent theme" })).toBeTruthy();
  });

  it("persists a selected accent for light mode", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    const nextRuntime = { ...runtime, accent_theme_preference: "sakura" } as RuntimeInfo;
    setAccentThemePreference.mockResolvedValue(nextRuntime);
    render(<AccentThemeSetting runtime={runtime} onChanged={onChanged} />);

    await user.click(screen.getByRole("combobox", { name: "Accent theme" }));
    await user.click(await screen.findByRole("option", { name: "Sakura" }));

    await waitFor(() => expect(setAccentThemePreference).toHaveBeenCalledWith("sakura"));
    expect(onChanged).toHaveBeenCalledWith(nextRuntime);
    expect(document.documentElement.dataset.accentTheme).toBe("sakura");
    expect(window.localStorage.getItem("agentkib.accent-theme")).toBe("sakura");
    expect(
      screen.getByText(
        "Applies a coordinated palette to actions, focus, selections, surfaces, and the sidebar.",
      ),
    ).toBeTruthy();
  });

  it("keeps the previous accent when saving fails", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    setAccentThemePreference.mockRejectedValue(new Error("preference write failed"));
    document.documentElement.dataset.accentTheme = "vtron";
    window.localStorage.setItem("agentkib.accent-theme", "vtron");
    render(<AccentThemeSetting runtime={runtime} onChanged={onChanged} />);

    await user.click(screen.getByRole("combobox", { name: "Accent theme" }));
    await user.click(await screen.findByRole("option", { name: "Sakura" }));

    expect((await screen.findByRole("alert")).textContent).toContain("preference write failed");
    expect(onChanged).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.accentTheme).toBe("vtron");
    expect(window.localStorage.getItem("agentkib.accent-theme")).toBe("vtron");
  });
});
