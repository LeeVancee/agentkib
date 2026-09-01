import { describe, expect, it } from "vitest";
import { insightsAgentKinds } from "@/features/insights/insights";
import { sessionHandoffTargets } from "@/features/workspace/session-handoff-targets";

describe("Grok Build capability boundaries", () => {
  it("does not expose unsupported Insights or handoff targets", () => {
    expect(insightsAgentKinds).not.toContain("grok-build");
    expect(sessionHandoffTargets.map(([agent]) => agent)).not.toContain("grok-build");
  });
});
