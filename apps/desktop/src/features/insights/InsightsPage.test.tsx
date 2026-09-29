// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n, tr } from "@/core/i18n";
import type { HeatmapPoint } from "@/core/types";
import { InsightsPage } from "./InsightsPage";

const state = vi.hoisted(() => ({
  view: {} as Record<string, unknown>,
  job: { data: undefined } as Record<string, unknown>,
  queries: [] as unknown[],
}));
vi.mock("./insights-query", () => ({
  useInsightsRefreshJob: () => state.job,
  useInsightsView: (query: unknown) => {
    state.queries.push(query);
    return state.view;
  },
}));

function point(date: string): HeatmapPoint {
  return {
    date,
    tokens: 1,
    my_commits: 0,
    all_commits: 0,
    attributed_commits: 0,
    sessions: 1,
    quality: "exact",
  };
}
function days(from: string, count: number) {
  const start = Date.parse(`${from}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) =>
    point(new Date(start + index * 86_400_000).toISOString().slice(0, 10)),
  );
}
const summary = {
  total_tokens: 1,
  my_commits: 0,
  all_commits: 0,
  session_count: 1,
  current_streak: 1,
  longest_streak: 1,
  active_days: 1,
  quality: "exact",
};
function heatmapGrid(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>("div[style]")].find((element) =>
    element.className.includes("grid-rows-[repeat(7,11px)]"),
  )!;
}

describe("InsightsPage", () => {
  beforeEach(() => {
    initializeI18n("en-US");
    state.job = { data: undefined };
    state.queries = [];
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows the load error with a retry instead of an endless skeleton", () => {
    const refetch = vi.fn();
    state.view = { data: undefined, isError: true, error: new Error("boom"), refetch };
    render(<InsightsPage section="overview" workspaces={[]} />);
    expect(screen.getByRole("alert").textContent).toContain(tr("insights.loadFailed"));
    fireEvent.click(screen.getByRole("button", { name: tr("insights.retry") }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("lays out the whole calendar year, even while last year's 52-week data is a placeholder", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 2, 1, 12));
    // 占位数据仍是旧范围（从 2025 年开始），年份必须取自新请求。
    state.view = {
      data: { summary, status: { running: false }, heatmap: days("2025-03-03", 364) },
      isPlaceholderData: true,
    };
    const { container } = render(<InsightsPage section="overview" workspaces={[]} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: tr("insights.range52w") }));
    await user.click(await screen.findByRole("option", { name: tr("insights.rangeYear") }));
    expect(state.queries.at(-1)).toMatchObject({ from: "2026-01-01", to: "2026-03-01" });
    // 2026-01-01 是周四：前面补 3 格，(3 + 365) / 7 → 53 列。
    state.view = {
      data: { summary, status: { running: false }, heatmap: days("2026-01-01", 60) },
    };
    fireEvent.click(screen.getByRole("tab", { name: tr("common.sessions") }));
    expect(heatmapGrid(container).style.gridTemplateColumns).toBe(
      "repeat(53, var(--heatmap-cell-size))",
    );
    expect(heatmapGrid(container).querySelectorAll('[aria-hidden="true"]')).toHaveLength(365 - 60);
  });
});
