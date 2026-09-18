/** @jsxImportSource octane */

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@octanejs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changeLocale, formatCompactNumber, initializeI18n, tr } from "@/core/i18n";
import { InsightsPage } from "./InsightsPage.tsrx";

vi.mock("./insights-query", () => ({
  useInsightsRefreshJob: () => ({ data: undefined }),
  useInsightsView: () => ({
    data: {
      summary: {
        total_tokens: 123456,
        my_commits: 14,
        all_commits: 17,
        session_count: 25,
        current_streak: 2,
        active_days: 10,
      },
      status: { running: false },
      heatmap: [
        {
          date: "2026-01-05",
          tokens: 123456,
          my_commits: 14,
          all_commits: 17,
          attributed_commits: 14,
          sessions: 25,
        },
      ],
      models: [{ model: "__unknown_model__", total_tokens: 123456, session_count: 25 }],
    },
  }),
}));

describe("InsightsPage locale changes", () => {
  beforeEach(() => initializeI18n("en-US"));
  afterEach(cleanup);

  it("updates heatmap labels and compact numbers while preserving the selected metric", async () => {
    render(<InsightsPage section="overview" workspaces={[]} />);
    expect(screen.getByText("Mon")).toBeTruthy();
    expect(screen.getAllByText(formatCompactNumber(123456)).length).toBeGreaterThan(0);
    const sessions = screen.getByRole("tab", { name: tr("common.sessions") });
    fireEvent.click(sessions);
    expect(sessions.getAttribute("aria-selected")).toBe("true");

    await act(() => changeLocale("ja-JP"));

    expect(screen.getByText("月")).toBeTruthy();
    expect(screen.getAllByText(formatCompactNumber(123456)).length).toBeGreaterThan(0);
    expect(screen.getByRole("tab", { name: tr("common.sessions") })).toBe(sessions);
    expect(sessions.getAttribute("aria-selected")).toBe("true");
  });

  it("retranslates metadata fallbacks computed by pure helpers", async () => {
    render(<InsightsPage section="tokens" workspaces={[]} />);
    expect(screen.getByText(tr("insights.unknownModel"))).toBeTruthy();

    await act(() => changeLocale("zh-TW"));

    expect(screen.getByText(tr("insights.unknownModel"))).toBeTruthy();
    expect(screen.getAllByText(formatCompactNumber(123456)).length).toBeGreaterThan(0);
  });
});
