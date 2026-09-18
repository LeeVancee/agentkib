/** @jsxImportSource octane */

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@octanejs/testing-library";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { changeLocale, initializeI18n, tr } from "@/core/i18n";
import { AppDialogProvider, useAppDialogs } from "./AppDialogProvider.tsrx";
import { SidebarSearchButton } from "./SidebarSearchButton.tsrx";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "./ui/dialog.tsrx";
import { SettingsSkeleton } from "@/features/settings/SettingsSkeleton.tsrx";

function DialogTrigger() {
  const dialogs = useAppDialogs();
  return (
    <button onClick={() => void dialogs.confirm("Pending confirmation")}>Open confirmation</button>
  );
}

describe("shared component locale subscriptions", () => {
  beforeAll(() => initializeI18n("en-US"));
  afterEach(cleanup);

  it("updates the loading announcement without replacing the loading state", async () => {
    render(<SettingsSkeleton />);
    const status = screen.getByRole("status", { name: "Loading settings" });
    try {
      for (const locale of ["zh-CN", "zh-TW", "ja-JP"] as const) {
        await act(() => changeLocale(locale));
        expect(screen.getByRole("status", { name: tr("loading.settings") })).toBe(status);
      }
    } finally {
      await act(() => changeLocale("en-US"));
    }
  });

  it("translates both shared dialog close controls while the dialog stays open", async () => {
    render(
      <Dialog open>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Details</DialogTitle>
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>,
    );
    expect(await screen.findAllByRole("button", { name: "Close" })).toHaveLength(2);
    try {
      await act(() => changeLocale("zh-CN"));
      expect(screen.getAllByRole("button", { name: tr("common.close") })).toHaveLength(2);
      expect(screen.getByRole("dialog")).toBeTruthy();
    } finally {
      await act(() => changeLocale("en-US"));
    }
  });

  it("refreshes an open dialog and search control without remounting", async () => {
    render(
      <AppDialogProvider>
        <DialogTrigger />
        <SidebarSearchButton onOpenSearch={() => undefined} />
      </AppDialogProvider>,
    );
    const searchButton = screen.getByRole("button", { name: tr("search.open") });
    fireEvent.click(screen.getByRole("button", { name: "Open confirmation" }));
    const dialog = await screen.findByRole("alertdialog");

    try {
      await act(() => changeLocale("zh-CN"));
      expect(screen.getByRole("alertdialog")).toBe(dialog);
      expect(screen.getByRole("button", { name: tr("common.confirm") })).toBeTruthy();
      expect(screen.getByRole("button", { name: tr("common.cancel") })).toBeTruthy();
      expect(screen.getByText(tr("dialog.confirmTitle"))).toBeTruthy();
      expect(searchButton.getAttribute("aria-label")).toBe(tr("search.open"));
      expect(searchButton.getAttribute("title")).toContain(tr("search.open"));
      expect(screen.getByText("Pending confirmation")).toBeTruthy();
    } finally {
      await act(() => changeLocale("en-US"));
    }
  });
});
