import type { AgentInstallation, AgentKind, AgentSupport } from "@/core/types";

/**
 * Support is reported by the runtime for a concrete installation. Do not infer
 * capabilities from the agent kind: old runtimes may be able to discover an
 * agent while still not reporting which surfaces are safe to use.
 */
export function agentSupport(installation?: AgentInstallation): AgentSupport | undefined {
  return installation?.support;
}

/**
 * These providers expose useful historical records but do not yet provide a
 * verified local continuation/export path. This only gates them as a source;
 * the same agents may still remain valid continuation targets elsewhere.
 */
const readOnlyHistoryAgents = new Set<AgentKind>(["open-claw", "hermes", "grok-build"]);

export function canContinueFromHistory(agent: AgentKind): boolean {
  return !readOnlyHistoryAgents.has(agent);
}
