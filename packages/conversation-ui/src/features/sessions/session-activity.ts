import type { CodexAction } from "@agentkib/web-client";

export function blockedWhileCompacting(action: CodexAction) {
  return (
    action === "steer" ||
    action === "settings" ||
    action === "resume" ||
    action === "queue-start" ||
    action.startsWith("goal-")
  );
}
