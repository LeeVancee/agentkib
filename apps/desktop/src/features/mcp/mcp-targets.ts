import type { McpAgent } from "@agentkib/runtime-protocol";
import { AGENT_KINDS } from "@/core/agents";

export const MCP_MANAGED_AGENTS: readonly Exclude<McpAgent, "deepseek-harness">[] =
  AGENT_KINDS.filter((agent) => agent !== "deepseek-harness");

/** Empty targets retain the legacy all-Agents meaning; deselecting the last target
 * must not produce that value. The service switch is the way to disable access. */
export function changeMcpTargets(
  targets: readonly McpAgent[],
  agent: (typeof MCP_MANAGED_AGENTS)[number],
  checked: boolean,
): McpAgent[] | null {
  const previous = targets.length ? targets : MCP_MANAGED_AGENTS;
  const next = checked
    ? [...new Set([...previous, agent])]
    : previous.filter((value) => value !== agent);
  return next.length ? next : null;
}
