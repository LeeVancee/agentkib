/** @jsxImportSource octane */

// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@octanejs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { changeLocale, initializeI18n, tr } from "@/core/i18n";
import { ObsidianSettingsCard } from "./ObsidianIntegration";

vi.mock("@/core/api", () => ({ api: { obsidianIntegration: vi.fn() } }));

describe("ObsidianSettingsCard locale changes", () => {
  beforeEach(async () => {
    await initializeI18n("en-US");
    vi.mocked(api.obsidianIntegration).mockReset();
  });
  afterEach(cleanup);

  it("retranslates loading and an existing structured error without restarting the request", async () => {
    vi.mocked(api.obsidianIntegration).mockRejectedValue({ key: "obsidian.notInstalled" });
    render(<ObsidianSettingsCard />);
    expect((await screen.findByRole("alert")).textContent).toContain(tr("obsidian.notInstalled"));
    const addVault = screen.getByRole("button", { name: tr("obsidian.addVault") });

    await act(() => changeLocale("zh-TW"));

    expect(screen.getByRole("alert").textContent).toContain(tr("obsidian.notInstalled"));
    expect(screen.getByRole("status", { name: tr("common.loading") })).toBeTruthy();
    expect(screen.getByRole("button", { name: tr("obsidian.addVault") })).toBe(addVault);
    expect(api.obsidianIntegration).toHaveBeenCalledOnce();
  });
});
