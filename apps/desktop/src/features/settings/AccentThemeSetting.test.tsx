// @vitest-environment jsdom

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { initializeI18n } from "@/core/i18n";
import { AccentThemeSetting } from "./GlobalSettings";

describe("AccentThemeSetting", () => {
  beforeAll(() => initializeI18n("en-US"));
  afterEach(cleanup);
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-accent-theme");
  });

  it("explains that the saved accent is deferred while dark mode is active", () => {
    render(<AccentThemeSetting effectiveTheme="dark" />);

    expect(
      screen.getByText(
        "The selected theme's dark palette is active across actions, surfaces, and the sidebar.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Accent theme" })).toBeTruthy();
  });

  it("persists a selected accent for light mode", async () => {
    const user = userEvent.setup();
    render(<AccentThemeSetting effectiveTheme="light" />);

    await user.click(screen.getByRole("combobox", { name: "Accent theme" }));
    await user.click(await screen.findByRole("option", { name: "Sakura" }));

    expect(document.documentElement.dataset.accentTheme).toBe("sakura");
    expect(window.localStorage.getItem("agentkib.accent-theme")).toBe("sakura");
    expect(
      screen.getByText(
        "Applies a coordinated palette to actions, focus, selections, surfaces, and the sidebar.",
      ),
    ).toBeTruthy();
  });
});
