import { describe, expect, it } from "vitest";
import type { AgentInstallation } from "@/core/types";
import { agentSupport, canContinueFromHistory } from "./agent-capabilities";
import { agentSupportsInsights, insightsAgentKinds } from "@/features/insights/insights";
import { sessionHandoffTargets } from "@/features/workspace/session-handoff-targets";

describe("Agent capability boundaries", () => {
  it.each(["grok-build", "opencode"] as const)(
    "does not expose unsupported Insights for %s",
    (agent) => {
      expect(insightsAgentKinds).not.toContain(agent);
      expect(agentSupportsInsights(agent)).toBe(false);
    },
  );

  it("exposes every supported continuation target", () => {
    for (const agent of ["opencode", "grok-build"] as const) {
      expect(sessionHandoffTargets.map(([target]) => target)).toContain(agent);
    }
  });

  it.each(["codex", "claude-code", "opencode"] as const)(
    "allows continuation from %s history",
    (agent) => {
      expect(canContinueFromHistory(agent)).toBe(true);
    },
  );

  it.each(["open-claw", "hermes", "grok-build"] as const)(
    "keeps %s history read-only while preserving it as a possible target",
    (agent) => {
      expect(canContinueFromHistory(agent)).toBe(false);
      expect(sessionHandoffTargets.map(([target]) => target)).toContain(agent);
    },
  );

  it("keeps supported Insights providers enabled", () => {
    for (const agent of insightsAgentKinds) {
      expect(agentSupportsInsights(agent)).toBe(true);
    }
  });

  it("does not infer capabilities for installations from an old runtime", () => {
    const installation: AgentInstallation = {
      agent: "open-claw",
      installed: true,
      configured: true,
      warnings: [],
    };

    expect(agentSupport(installation)).toBeUndefined();
  });

  it("exposes the runtime-reported surfaces without rewriting them", () => {
    const installation: AgentInstallation = {
      agent: "open-claw",
      installed: true,
      configured: true,
      warnings: [],
      support: {
        workspace_discovery: true,
        session_list: true,
        history_read: true,
        continuation: false,
        control: "none",
      },
    };

    expect(agentSupport(installation)).toEqual(installation.support);
  });
});
