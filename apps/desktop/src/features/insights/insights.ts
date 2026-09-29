import type { AgentKind, HeatmapPoint } from "@/core/types";

export const insightsAgentKinds: AgentKind[] = [
  "codex",
  "claude-code",
  "antigravity",
  "cursor",
  "open-claw",
  "hermes",
  "deepseek-harness",
];

export function agentSupportsInsights(agent: AgentKind) {
  return insightsAgentKinds.includes(agent);
}

export interface HeatmapMonthMarker {
  key: string;
  label: string;
  column: number;
}

export function buildHeatmapMonthMarkers(
  points: HeatmapPoint[],
  padding: number,
  locale: string,
): HeatmapMonthMarker[] {
  const markers = new Map<string, HeatmapMonthMarker>();
  for (const [index, point] of points.entries()) {
    const date = new Date(`${point.date}T00:00:00`);
    if (Number.isNaN(date.getTime())) continue;
    const key = `${date.getFullYear()}-${date.getMonth()}`;
    if (markers.has(key)) continue;
    markers.set(key, {
      key,
      label: new Intl.DateTimeFormat(locale, { month: "short" }).format(date),
      column: Math.floor((padding + index) / 7) + 1,
    });
  }
  return [...markers.values()];
}

/**
 * 52 周几乎总会跨 13 个自然月：保留最近的 12 个（当月最重要），而不是丢掉当月。
 * 开头的残月如果离下一个标签不足 2 列，文字会重叠，也去掉。
 */
export function trimHeatmapMonthMarkers(markers: HeatmapMonthMarker[], limit = 12) {
  const readable =
    markers.length > 1 && markers[1].column - markers[0].column < 2 ? markers.slice(1) : markers;
  return readable.slice(-limit);
}
