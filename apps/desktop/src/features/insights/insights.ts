import type { AgentKind, HeatmapPoint } from "@/core/types";

export const insightsAgentKinds: AgentKind[] = [
  "codex",
  "claude-code",
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
