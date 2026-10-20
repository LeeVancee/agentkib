// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PermissionModeNotice } from "./permission-mode-notice";
import { permissionModeCopy, permissionModeSummaryCopy } from "./permission-mode-copy";

describe("compact Claude permission notice", () => {
  afterEach(cleanup);

  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "keeps the complete risk explanation expandable in %s",
    (locale) => {
      for (const mode of ["auto", "dontAsk", "bypassPermissions", null] as const) {
        const view = render(
          <PermissionModeNotice
            locale={locale}
            permission={{ mode, possiblyAuto: true, ...(mode !== null ? { previous: true } : {}) }}
            compact
          />,
        );
        const key = mode ?? "possiblyAuto";
        const trigger = screen.getByRole("button");
        expect(trigger).toHaveTextContent(permissionModeSummaryCopy[locale][key]);
        expect(trigger).toHaveClass("min-h-11");
        expect(trigger).toHaveAttribute("aria-expanded", "false");
        const explanation = screen.getByText(permissionModeCopy[locale][key], { exact: false });
        expect(explanation).not.toBeVisible();
        fireEvent.click(trigger);
        expect(trigger).toHaveAttribute("aria-expanded", "true");
        expect(explanation).toBeVisible();
        if (mode !== null)
          expect(screen.getByText(permissionModeCopy[locale].previous)).toBeVisible();
        fireEvent.click(trigger);
        expect(explanation).not.toBeVisible();
        view.unmount();
      }
    },
  );
});
