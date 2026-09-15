/** @jsxImportSource octane */

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@octanejs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changeLocale, formatDateTime, initializeI18n, tr } from "@/core/i18n";
import { QuotaAutoRefreshPrompt } from "./QuotaAutoRefreshPrompt";
import { QuotaDiagnostics } from "./QuotaDiagnostics";
import { QuotaWindowRow } from "./QuotaDisplay";

describe("quota locale changes", () => {
  beforeEach(() => initializeI18n("en-US"));
  afterEach(cleanup);

  it("updates an existing prompt and structured error without remounting", async () => {
    render(
      <QuotaAutoRefreshPrompt
        onEnableAutoRefresh={vi.fn().mockRejectedValue({ key: "quota.statusUnavailable" })}
        onNotNow={vi.fn()}
      />,
    );
    const enable = screen.getByRole("button", { name: tr("quota.enableAutoRefresh") });
    fireEvent.click(enable);
    expect(await screen.findByText(tr("quota.statusUnavailable"))).toBeTruthy();

    await act(() => changeLocale("ja-JP"));

    expect(screen.getByRole("button", { name: tr("quota.enableAutoRefresh") })).toBe(enable);
    expect(screen.getByText(tr("quota.statusUnavailable"))).toBeTruthy();
  });

  it("updates reset duration helpers and collector dates in the application locale", async () => {
    const checkedAt = "2026-08-27T13:24:00Z";
    render(
      <>
        <QuotaDiagnostics
          status={{
            backend: "codex-bar-cli",
            platform_supported: true,
            sidecar_available: true,
            config_source: "default",
            running: false,
            last_success_at: checkedAt,
          }}
        />
        <QuotaWindowRow
          item={{
            key: "codex-session",
            providerId: "codex",
            providerName: "Codex",
            selector: { provider_id: "codex", kind: "session", label: "" },
            window: {
              kind: "session",
              label: "",
              used_percent: 20,
              remaining_percent: 80,
              reset_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
            },
          }}
        />
      </>,
    );
    expect(screen.getByText(formatDateTime(checkedAt))).toBeTruthy();
    const progress = screen.getByRole("progressbar");

    await act(() => changeLocale("zh-CN"));

    expect(screen.getByText(formatDateTime(checkedAt))).toBeTruthy();
    expect(
      screen.getByText(tr("quota.resets", { time: tr("quota.duration.hours", { value: 2 }) })),
    ).toBeTruthy();
    expect(screen.getByRole("progressbar")).toBe(progress);
    expect(progress.getAttribute("aria-valuetext")).toBe(tr("quota.remaining", { value: 80 }));
  });
});
