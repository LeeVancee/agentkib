// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { initializeI18n } from "@/core/i18n";
import { QuotaAutoRefreshPrompt } from "./QuotaAutoRefreshPrompt";

describe("QuotaAutoRefreshPrompt", () => {
  beforeAll(() => initializeI18n("en-US"));
  afterEach(cleanup);

  it("offers clear enable and defer actions", async () => {
    const actions = {
      enable: vi.fn().mockResolvedValue(undefined),
      notNow: vi.fn().mockResolvedValue(undefined),
    };
    const user = userEvent.setup();
    render(
      <QuotaAutoRefreshPrompt onEnableAutoRefresh={actions.enable} onNotNow={actions.notNow} />,
    );

    expect(screen.getByText("Automatically get quota?")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Not now" }));

    expect(actions.notNow).toHaveBeenCalledOnce();
    expect(actions.enable).not.toHaveBeenCalled();
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });
});
