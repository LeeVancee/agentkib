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
      screen.getByText("Dark mode is active. This will be used when you switch to light mode."),
    ).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Light mode accent" })).toBeTruthy();
  });

  it("persists a selected accent for light mode", async () => {
    const user = userEvent.setup();
    render(<AccentThemeSetting effectiveTheme="light" />);

    await user.click(screen.getByRole("combobox", { name: "Light mode accent" }));
    await user.click(await screen.findByRole("option", { name: "Sakura" }));

    expect(document.documentElement.dataset.accentTheme).toBe("sakura");
    expect(window.localStorage.getItem("agentkib.accent-theme")).toBe("sakura");
    expect(
      screen.getByText(
        "Used for primary actions, focus, and compact selection states in light mode.",
      ),
    ).toBeTruthy();
  });
});
