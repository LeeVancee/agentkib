import { describe, expect, it } from "vitest";
import { agentSupportsInsights, insightsAgentKinds } from "@/features/insights/insights";
import { sessionHandoffTargets } from "@/features/workspace/session-handoff-targets";

describe("Agent capability boundaries", () => {
  it.each(["grok-build", "opencode"] as const)(
    "does not expose unsupported Insights or handoff targets for %s",
    (agent) => {
      expect(insightsAgentKinds).not.toContain(agent);
      expect(agentSupportsInsights(agent)).toBe(false);
      expect(sessionHandoffTargets.map(([target]) => target)).not.toContain(agent);
    },
  );

  it("keeps supported Insights providers enabled", () => {
    for (const agent of insightsAgentKinds) {
      expect(agentSupportsInsights(agent)).toBe(true);
    }
  });
});
