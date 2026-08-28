// @vitest-environment jsdom

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AppDialogProvider } from "@/components/AppDialogProvider";
import { api } from "@/core/api";
import { initializeI18n } from "@/core/i18n";
import { AppUpdateSetting } from "./GlobalSettings";

vi.mock("@/core/api", () => ({
  api: {
    checkAppUpdate: vi.fn(),
    openExternal: vi.fn(),
    installAppUpdate: vi.fn(),
  },
}));

const availableUpdate = {
  current_version: "0.2.0",
  version: "0.3.0",
  notes: "Safer application updates",
  release_url: "https://github.com/starroyhq/agentkib/releases/tag/v0.3.0",
  install_mode: "in-app" as const,
};

function renderSetting() {
  return render(
    <AppDialogProvider>
      <AppUpdateSetting currentVersion="0.2.0" />
    </AppDialogProvider>,
  );
}

describe("AppUpdateSetting", () => {
  beforeAll(() => initializeI18n("en-US"));
  afterEach(cleanup);
  beforeEach(() => {
    vi.mocked(api.checkAppUpdate).mockReset();
    vi.mocked(api.openExternal).mockReset();
    vi.mocked(api.installAppUpdate).mockReset();
  });

  it("locks repeated checks and reports an up-to-date version", async () => {
    let resolveCheck: (value: undefined) => void = () => undefined;
    vi.mocked(api.checkAppUpdate).mockReturnValue(
      new Promise<undefined>((resolve) => {
        resolveCheck = resolve;
      }),
    );
    const user = userEvent.setup();
    renderSetting();

    const button = screen.getByRole("button", { name: "Check for updates" });
    await user.click(button);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await user.click(button);
    expect(api.checkAppUpdate).toHaveBeenCalledTimes(1);

    resolveCheck(undefined);
    expect(await screen.findByText("You're up to date (0.2.0)")).toBeTruthy();
  });

  it("disables stable update checks for development builds", async () => {
    const user = userEvent.setup();
    render(
      <AppDialogProvider>
        <AppUpdateSetting currentVersion="0.4.0" updatesEnabled={false} />
      </AppDialogProvider>,
    );

    expect(screen.getByText("Development builds do not check for stable updates")).toBeTruthy();
    const button = screen.getByRole("button", { name: "Check for updates" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await user.click(button);
    expect(api.checkAppUpdate).not.toHaveBeenCalled();
  });

  it("opens the Release page for package-manager installations", async () => {
    vi.mocked(api.checkAppUpdate).mockResolvedValue({
      ...availableUpdate,
      install_mode: "manual",
    });
    vi.mocked(api.openExternal).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderSetting();

    await user.click(screen.getByRole("button", { name: "Check for updates" }));
    await user.click(await screen.findByRole("button", { name: "Open Release download" }));

    expect(api.openExternal).toHaveBeenCalledWith(availableUpdate.release_url);
    expect(api.installAppUpdate).not.toHaveBeenCalled();
  });

  it("requires confirmation before installing an in-app update", async () => {
    vi.mocked(api.checkAppUpdate).mockResolvedValue(availableUpdate);
    vi.mocked(api.installAppUpdate).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderSetting();

    await user.click(screen.getByRole("button", { name: "Check for updates" }));
    await user.click(await screen.findByRole("button", { name: "Download and install" }));
    expect(api.installAppUpdate).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "Confirm" }));

    expect(api.installAppUpdate).toHaveBeenCalledOnce();
    expect(api.installAppUpdate).toHaveBeenCalledWith("0.3.0", expect.any(Function));
  });
});
