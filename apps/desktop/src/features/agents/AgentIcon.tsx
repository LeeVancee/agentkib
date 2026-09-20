import { AgentMark } from "@agentkib/agent-identity";
import type { AgentKind } from "@/core/types";
import antigravity from "./antigravity.svg";

export function AgentIcon({ agent, compact = false }: { agent: AgentKind; compact?: boolean }) {
  return (
    <div
      className={
        compact
          ? "grid size-5 place-items-center overflow-hidden"
          : "grid size-9 place-items-center overflow-hidden"
      }
      aria-hidden="true"
    >
      {agent === "antigravity" ? (
        <span
          className="ak-agent-mark"
          title="Antigravity"
          aria-hidden="true"
          style={{ width: compact ? 16 : 32, height: compact ? 16 : 32 }}
        >
          <img src={antigravity} alt="" className="ak-agent-image" />
        </span>
      ) : (
        <AgentMark agent={agent} size={compact ? 16 : 32} />
      )}
    </div>
  );
}
