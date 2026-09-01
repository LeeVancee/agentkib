import claudeCodeIcon from "@/assets/agent-icons/claude-code.svg";
import codexIcon from "@/assets/agent-icons/codex.svg";
import cursorIcon from "@/assets/agent-icons/cursor.svg";
import hermesIcon from "@/assets/agent-icons/hermes.svg";
import openClawIcon from "@/assets/agent-icons/open-claw.svg";
import deepSeekHarnessIcon from "@/assets/agent-icons/deepseek-harness.svg";
import type { AgentKind } from "@/core/types";
import { cn } from "@/lib/utils";

const agentIcons: Record<AgentKind, string> = {
  codex: codexIcon,
  "claude-code": claudeCodeIcon,
  cursor: cursorIcon,
  "open-claw": openClawIcon,
  hermes: hermesIcon,
  "deepseek-harness": deepSeekHarnessIcon,
};

export function AgentIcon({ agent }: { agent: AgentKind }) {
  return (
    <div className="grid size-9 place-items-center overflow-hidden" aria-hidden="true">
      <img
        className={cn(
          "block size-8 object-contain",
          agent === "cursor" && "rounded-md bg-[#1d1d1f] p-1",
          agent === "hermes" && "opacity-[0.92] invert",
        )}
        src={agentIcons[agent]}
        alt=""
      />
    </div>
  );
}
