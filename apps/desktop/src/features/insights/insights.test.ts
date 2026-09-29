import { describe, expect, it } from "vitest";
import { buildHeatmapMonthMarkers, trimHeatmapMonthMarkers } from "./insights";
import type { HeatmapPoint } from "@/core/types";

function point(date: string): HeatmapPoint {
  return {
    date,
    tokens: 0,
    my_commits: 0,
    all_commits: 0,
    attributed_commits: 0,
    sessions: 0,
    quality: "exact",
  };
}

describe("heatmap month markers", () => {
  it("places one marker per month on the first visible week", () => {
    const markers = buildHeatmapMonthMarkers(
      [
        point("2025-12-29"),
        point("2025-12-31"),
        point("2026-01-01"),
        point("2026-01-07"),
        point("2026-02-01"),
      ],
      1,
      "en-US",
    );

    expect(markers.map(({ key, column }) => [key, column])).toEqual([
      ["2025-11", 1],
      ["2026-0", 1],
      ["2026-1", 1],
    ]);
    expect(markers).toHaveLength(3);
  });

  it("returns no markers for an empty range", () => {
    expect(buildHeatmapMonthMarkers([], 0, "zh-CN")).toEqual([]);
    expect(trimHeatmapMonthMarkers([])).toEqual([]);
  });

  it("keeps the current month when 52 weeks span 13 months and drops a cramped first label", () => {
    // 2025-05-17 起的 364 天覆盖 2025-05 到 2026-05，共 13 个月；5 月只剩 2 天。
    const start = Date.parse("2025-05-17T00:00:00Z");
    const points = Array.from({ length: 364 }, (_, index) =>
      point(new Date(start + index * 86_400_000).toISOString().slice(0, 10)),
    );
    const padding = 5; // 2025-05-17 是周六
    const markers = buildHeatmapMonthMarkers(points, padding, "en-US");
    expect(markers).toHaveLength(13);
    const visible = trimHeatmapMonthMarkers(markers);
    expect(visible).toHaveLength(12);
    expect(visible[0].key).toBe("2025-5");
    expect(visible.at(-1)!.key).toBe("2026-4");
  });
});
